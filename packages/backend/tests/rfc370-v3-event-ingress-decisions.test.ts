// RFC-370 v3 V8 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9):
// hosted event ingress gained an application layer. Regression intent: routing,
// channel decisions, admission and delivery finalization all lived in the
// CrewStation inbox adapter, and its finalization duplicated the direct
// webhook ingress. These lock the two pure decisions the application now owns
// — what a frozen target becomes, and a delivery's audit outcome — and that the
// direct ingress finalizes through the same outcome.
import { describe, expect, test } from 'bun:test'
import type { CodeHostEvent } from '@agent-workflow/shared'
import { decideCrewStationTarget } from '@/modules/integration/application/crewStationEventIngress'
import type { CrewStationPendingTarget } from '@/modules/integration/application/ports/crewStationEventInbox'
import { createVerifiedWebhookIngress } from '@/modules/integration/application/verifiedWebhookIngress'
import { webhookDeliveryOutcome } from '@/modules/integration/application/webhookDeliveryOutcome'

const event: CodeHostEvent = {
  provider: 'gitlab',
  eventType: 'mr_opened',
  eventUuid: 'cs:stable',
  repoPath: 'group/repo',
  repoHttpUrl: 'https://git.example/group/repo.git',
  repoSshUrl: 'git@git.example:group/repo.git',
  apiBaseUrl: 'https://git.example/api/v4',
  branch: 'branch',
  targetBranch: 'main',
  mrIid: '7',
  mrTitle: 'Change',
  projectId: '1',
  author: { username: 'alice' },
  raw: {},
}

function target(overrides: Partial<CrewStationPendingTarget> = {}): CrewStationPendingTarget {
  return {
    endpointId: 'endpoint-a',
    channel: 'crewstation',
    endpoint: { enabled: true, provider: 'gitlab' },
    provider: 'gitlab',
    normalized: { ok: true, event },
    delivery: {
      rawBodyText: '{}',
      rawBodyBytes: Buffer.from('{}'),
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      transportReceiptRef: 'cs-event-target:t1',
    },
    occurredAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('RFC-370 v3 what a frozen CrewStation target becomes', () => {
  test('a deleted, disabled or re-provided endpoint closes the target', () => {
    expect(decideCrewStationTarget(target({ endpoint: null }))).toMatchObject({
      kind: 'close',
      stage: 'source-deleted',
    })
    expect(
      decideCrewStationTarget(target({ endpoint: { enabled: false, provider: 'gitlab' } })),
    ).toMatchObject({ kind: 'close', stage: 'rejected' })
    expect(
      decideCrewStationTarget(target({ endpoint: { enabled: true, provider: 'github' } })),
    ).toMatchObject({ kind: 'close', stage: 'rejected' })
  })

  test('an envelope the provider normalization cannot use is ignored or rejected', () => {
    expect(
      decideCrewStationTarget(
        target({ normalized: { ok: false, reason: 'unsupported-event', detail: 'approved' } }),
      ),
    ).toEqual({ kind: 'close', stage: 'ignored', reason: 'approved' })
    expect(
      decideCrewStationTarget(
        target({ normalized: { ok: false, reason: 'parse-failed', detail: 'clone url' } }),
      ),
    ).toEqual({ kind: 'close', stage: 'rejected', reason: 'clone url' })
  })

  test('the shadow channel records what would have been admitted and admits nothing', () => {
    expect(decideCrewStationTarget(target({ channel: 'shadow' }))).toEqual({
      kind: 'close',
      stage: 'shadow',
      reason: 'normalized:mr_opened; no business admission',
    })
  })

  test('the crewstation channel admits the verified delivery and both observations', () => {
    const decision = decideCrewStationTarget(target())
    if (decision.kind !== 'admit') throw new Error('expected an admission')
    expect(decision.delivery).toMatchObject({
      endpointId: 'endpoint-a',
      event,
      rawBodyText: '{}',
      eventHeader: 'Merge Request Hook',
      objectKind: 'merge_request',
      transportReceiptRef: 'cs-event-target:t1',
    })
    const observations = decision.observations('delivery-1')
    expect(observations).toHaveLength(2)
    expect(observations.every((observation) => observation.occurredAt === 1_700_000_000_000)).toBe(
      true,
    )
    expect(observations.every((observation) => observation.dedupeKey.includes('endpoint-a'))).toBe(
      true,
    )
  })
})

describe('RFC-370 v3 one delivery outcome for every transport', () => {
  test('matched when a subscriber was reached, or when terminal control was accepted; otherwise ignored', () => {
    expect(webhookDeliveryOutcome({ deliveryCount: 2, effectId: null })).toEqual({
      status: 'matched',
    })
    expect(webhookDeliveryOutcome({ deliveryCount: 1, effectId: 'effect' })).toEqual({
      status: 'matched',
    })
    expect(webhookDeliveryOutcome({ deliveryCount: 0, effectId: 'effect' })).toEqual({
      status: 'matched',
      reason: 'terminal-control-accepted',
    })
    expect(webhookDeliveryOutcome({ deliveryCount: 0, effectId: null })).toEqual({
      status: 'ignored',
      reason: 'no-trigger-matched',
    })
  })

  test('the direct ingress finalizes through the same outcome', async () => {
    for (const [deliveryCount, effectId, expected] of [
      [1, null, { status: 'matched' }],
      [0, 'effect', { status: 'matched', reason: 'terminal-control-accepted' }],
      [0, null, { status: 'ignored', reason: 'no-trigger-matched' }],
    ] as const) {
      const marks: unknown[] = []
      const ingress = createVerifiedWebhookIngress({
        persistence: {
          accept: async () => ({
            kind: 'inserted',
            deliveryId: 'delivery-1',
            effectId,
            controlAccepted: effectId !== null,
            streamRevision: null,
          }),
        },
        audit: {
          mark: async (input) => {
            marks.push(input)
          },
          touchEndpointLastDelivery: async () => {},
        },
        events: {
          observe: async () => ({
            deliveryCount,
            deliveryIds: deliveryCount > 0 ? ['notification'] : [],
          }),
          notify: async () => {},
          nudge: () => {},
        },
        wakeTerminalControl: () => {},
        now: () => 1,
      })
      await ingress.receive({
        endpointId: 'endpoint-a',
        event,
        rawBodyBytes: Buffer.from('{}'),
        rawBodyText: '{}',
        eventHeader: 'Merge Request Hook',
        objectKind: 'merge_request',
      })
      // Two observations per delivery: a single non-zero count already matches.
      expect(marks).toEqual([{ deliveryId: 'delivery-1', ...expected }])
    }
  })
})
