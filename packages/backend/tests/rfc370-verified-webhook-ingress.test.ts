import { describe, expect, test } from 'bun:test'
import { createVerifiedWebhookIngress } from '@/modules/integration/application/verifiedWebhookIngress'
import type { VerifiedWebhookIngressDependencies } from '@/modules/integration/application/ports/verifiedWebhookIngress'
import type {
  AcceptedVerifiedDelivery,
  VerifiedWebhookDeliveryInput,
} from '@/modules/integration/application/acceptVerifiedWebhookDelivery'
import type { EventObservationInput } from '@/modules/event-center/public/types'

const input: VerifiedWebhookDeliveryInput = {
  endpointId: 'endpoint',
  event: {
    provider: 'gitlab',
    eventUuid: 'provider-delivery',
    eventType: 'mr_updated',
    repoPath: 'group/repository',
    repoHttpUrl: 'https://git.example/group/repository.git',
    repoSshUrl: 'git@git.example:group/repository.git',
    mrIid: '42',
    author: {},
    raw: {},
  },
  rawBodyBytes: new TextEncoder().encode('{"original":"body"}'),
  rawBodyText: '{"original":"body"}',
  eventHeader: 'Merge Request Hook',
  objectKind: 'merge_request',
}

function setup(
  receipt: AcceptedVerifiedDelivery = {
    kind: 'inserted',
    deliveryId: 'delivery',
    effectId: null,
    controlAccepted: false,
    streamRevision: null,
  },
) {
  const steps: string[] = []
  const observations: EventObservationInput[] = []
  const marks: Parameters<VerifiedWebhookIngressDependencies['audit']['mark']>[0][] = []
  const deps: VerifiedWebhookIngressDependencies = {
    persistence: {
      async accept(command) {
        expect(command).toBe(input)
        steps.push('accept')
        return receipt
      },
    },
    audit: {
      async mark(mark) {
        marks.push(mark)
        steps.push('mark')
      },
      async touchEndpointLastDelivery(endpointId, now) {
        expect(endpointId).toBe('endpoint')
        expect(now).toBe(123)
        steps.push('touch')
      },
    },
    events: {
      async observe(observation) {
        observations.push(observation)
        steps.push('observe')
        return { deliveryCount: 1, deliveryIds: [`notification-${observations.length}`] }
      },
      async notify(id) {
        steps.push(id)
      },
      nudge() {
        steps.push('nudge')
      },
    },
    wakeTerminalControl(effectId) {
      steps.push(`wake:${effectId ?? 'none'}`)
    },
    now: () => 123,
  }
  return { deps, steps, observations, marks, application: createVerifiedWebhookIngress(deps) }
}

describe('RFC-370 transport-neutral verified webhook ingress', () => {
  test('waits for durable acceptance before publishing the original normalized fact', async () => {
    const h = setup()
    let release!: (receipt: AcceptedVerifiedDelivery) => void
    const persisted = new Promise<AcceptedVerifiedDelivery>((resolve) => {
      release = resolve
    })
    h.deps.persistence.accept = async (command) => {
      expect(command).toBe(input)
      return persisted
    }
    const receiving = h.application.receive(input)
    expect(h.steps).toEqual([])
    release({
      kind: 'inserted',
      deliveryId: 'delivery',
      effectId: 'terminal',
      controlAccepted: true,
      streamRevision: 7,
    })
    expect(await receiving).toEqual({ deliveryId: 'delivery', status: 'received' })
    expect(h.steps[0]).toBe('wake:terminal')
    expect(h.observations.length).toBeGreaterThan(0)
    expect(h.observations.every((event) => event.occurredAt === 123)).toBe(true)
    expect(h.marks).toEqual([{ deliveryId: 'delivery', status: 'matched' }])
    expect(h.steps.slice(-2)).toEqual(['nudge', 'touch'])
  })

  test('duplicate transport delivery republishes stable observations and does not repeat new-delivery hooks', async () => {
    const first = setup()
    await first.application.receive(input)
    const retry = setup({
      kind: 'duplicate',
      deliveryId: 'delivery',
      attemptCount: 2,
      effectId: null,
    })
    expect(await retry.application.receive(input)).toEqual({
      deliveryId: 'delivery',
      status: 'duplicate',
      attemptCount: 2,
    })
    expect(retry.observations).toEqual(first.observations)
    expect(retry.steps).not.toContain('nudge')
    expect(retry.steps).not.toContain('touch')
    expect(retry.steps.some((step) => step.startsWith('notification-'))).toBe(true)
  })

  test('publication failure marks only newly accepted rows failed and propagates the original error', async () => {
    const failure = new Error('event publication unavailable')
    for (const receipt of [
      {
        kind: 'inserted',
        deliveryId: 'delivery',
        effectId: null,
        controlAccepted: false,
        streamRevision: null,
      },
      { kind: 'duplicate', deliveryId: 'delivery', effectId: null, attemptCount: 2 },
    ] satisfies AcceptedVerifiedDelivery[]) {
      const h = setup(receipt)
      h.deps.events.observe = async () => {
        throw failure
      }
      await expect(h.application.receive(input)).rejects.toBe(failure)
      expect(h.marks).toEqual(
        receipt.kind === 'inserted'
          ? [{ deliveryId: 'delivery', status: 'failed', reason: 'internal-error' }]
          : [],
      )
      expect(h.steps).not.toContain('touch')
    }
  })

  test('no routing match preserves terminal-control and ignored audit outcomes', async () => {
    for (const effectId of ['terminal', null]) {
      const h = setup({
        kind: 'inserted',
        deliveryId: 'delivery',
        effectId,
        controlAccepted: effectId !== null,
        streamRevision: null,
      })
      h.deps.events.observe = async () => ({ deliveryCount: 0, deliveryIds: [] })
      await h.application.receive(input)
      expect(h.marks).toEqual([
        {
          deliveryId: 'delivery',
          status: effectId === null ? 'ignored' : 'matched',
          reason: effectId === null ? 'no-trigger-matched' : 'terminal-control-accepted',
        },
      ])
    }
  })
})
