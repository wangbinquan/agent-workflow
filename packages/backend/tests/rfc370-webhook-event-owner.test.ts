// RFC-370 implementation gate: the actual webhook HTTP fast path may publish
// durably in standby, but only its selected Event Center owner consumes work.
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { eventDeliveries, webhookDeliveries, webhookEndpoints, webhookTriggers } from '@/db/schema'
import { composeEventCenter } from '@/modules/event-center/composition'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
} from '@/modules/integration/composition'
import {
  composeWebhookIngressPersistenceFor,
  composeWebhookIngressTransport,
} from '@/modules/integration/composition/webhookIngress'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import type {
  WebhookDispatcher,
  EventCenterCodeHostDeliveryDispatcher,
} from '@/services/webhook/dispatcherTypes'
import { bindEventCenterHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { deferred } from './helpers/taskHostExecution'

async function ingress(h: ProviderHarness, host: boolean, consume: () => Promise<void>) {
  const box = createSecretBoxFromKey(Buffer.alloc(32, 7))
  await h.db.insert(webhookEndpoints).values({
    id: 'event-owner-endpoint',
    name: 'gitlab',
    provider: 'gitlab',
    urlToken: 'aw_whk_event_owner',
    secretEnc: box.seal('original-token'),
    enabled: true,
  })
  await h.db.insert(webhookTriggers).values({
    id: 'event-owner-trigger',
    name: 'Original rule',
    endpointId: 'event-owner-endpoint',
    ownerUserId: 'fixture-owner',
    repoScope: JSON.stringify({ kind: 'all' }),
    eventTypes: JSON.stringify(['push']),
    ignoreUsernames: '[]',
    launchKind: 'workflow',
    launchRefId: 'fixture-workflow',
    launchPayload: JSON.stringify({ inputs: {}, scratch: true }),
    templateSyntaxVersion: 2,
  })
  const dispatcher: WebhookDispatcher & EventCenterCodeHostDeliveryDispatcher = {
    dispatch: async () => {
      throw new Error('legacy dispatcher must not run')
    },
    dispatchSubscription: consume,
  }
  const events = await composeEventCenter({
    db: h.db,
    ...(host ? { executionMode: 'host' as const } : {}),
    typePackageDescriptorJsons: [codeHostEventCatalogJson],
    automation: { kind: 'observation-only' },
    routingSubscriptions: createCodeHostWebhookRoutingDirectory(h.db),
    deliveryConsumers: [createCodeHostWebhookDeliveryConsumer(h.db, dispatcher)],
  })
  const app = new Hono()
  mountWebhookIngressRoutes(
    app,
    composeWebhookIngressTransport({
      webhookIngressPersistence: composeWebhookIngressPersistenceFor(h.db),
      secretBox: box,
      digitalEmployeeEventCenter: events,
      webhookDispatcher: dispatcher,
    }),
  )
  const post = (id: string) =>
    app.request('/webhooks/gitlab/aw_whk_event_owner', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gitlab-token': 'original-token',
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-event-uuid': id,
      },
      body: JSON.stringify({
        object_kind: 'push',
        ref: 'refs/heads/main',
        after: id,
        user_username: 'original-author',
        project: {
          path_with_namespace: 'group/repository',
          git_http_url: 'https://gitlab.example/group/repository.git',
          git_ssh_url: 'git@gitlab.example:group/repository.git',
        },
      }),
    })
  const owner = bindEventCenterHostOwner({
    worker: events.worker,
    onCycle() {},
    onError(error) {
      throw error
    },
  })
  return { events, post, owner }
}

describeEachProvider('RFC-370 actual webhook Event Center owner', (h) => {
  test('resource-only and standby only accept; active work drains after loss and retired wakes cannot consume', async () => {
    let calls = 0,
      active = true
    const entered = deferred(),
      release = deferred(),
      activation = deferred<boolean>()
    const f = await ingress(h, true, async () => {
      calls += 1
      entered.resolve()
      await release.promise
    })
    expect((await f.post('resource-only')).status).toBe(200)
    expect(calls).toBe(0)
    expect(await h.db.select().from(webhookDeliveries)).toHaveLength(1)
    expect(
      (await h.db.select().from(eventDeliveries)).every(
        (row) => row.state === 'pending' && row.attemptCount === 0,
      ),
    ).toBe(true)
    const context = {
      generation: 'actual-webhook-owner',
      reference: Object.freeze({}),
      current: () => active,
      whenActive: activation.promise,
    }
    const handle = await f.owner.start({
      scope: {
        provider: h.applicationBinding.provider,
        generationId: context.generation,
        operationId: 'actual-webhook-owner',
      },
      context,
    })
    try {
      expect((await f.post('standby')).status).toBe(200)
      expect(calls).toBe(0)
      expect(await h.db.select().from(eventDeliveries)).toHaveLength(2)
      activation.resolve(true)
      await entered.promise
      active = false
      await f.owner.quiesceAuthorityLoss({ context, handle })
      let drained = false
      const draining = Promise.resolve(f.owner.drainAuthorityLoss({ context, handle })).then(() => {
        drained = true
      })
      expect((await f.post('lost-owner')).status).toBe(200)
      expect(drained).toBe(false)
      expect(calls).toBe(1)
      release.resolve()
      await draining
      const rows = await h.db.select().from(eventDeliveries)
      expect(rows.filter((row) => row.state === 'accepted')).toHaveLength(1)
      expect(rows.filter((row) => row.state === 'pending' && row.attemptCount === 0)).toHaveLength(
        2,
      )
      expect((await f.post('retired-owner')).status).toBe(200)
      expect(calls).toBe(1)
      expect(
        (await h.db.select().from(eventDeliveries)).filter(
          (row) => row.state === 'pending' && row.attemptCount === 0,
        ),
      ).toHaveLength(3)
    } finally {
      activation.resolve(false)
      release.resolve()
      await handle.stop()
      await handle.drain()
    }
  })

  test('an active idle owner wakes for the actual HTTP notification and waits for its receipt', async () => {
    const entered = deferred(),
      release = deferred(),
      idle = deferred()
    let calls = 0
    const f = await ingress(h, true, async () => {
      calls += 1
      entered.resolve()
      await release.promise
    })
    const owner = bindEventCenterHostOwner({
      worker: f.events.worker,
      onCycle() {
        idle.resolve()
      },
      onError(error) {
        throw error
      },
    })
    const context = {
      generation: 'actual-webhook-wake',
      reference: Object.freeze({}),
      current: () => true,
    }
    const handle = await owner.start({
      scope: {
        provider: h.applicationBinding.provider,
        generationId: context.generation,
        operationId: 'actual-webhook-wake',
      },
      context,
    })
    try {
      await idle.promise
      expect((await f.post('wake-idle-owner')).status).toBe(200)
      await entered.promise
      expect(calls).toBe(1)
      await handle.stop()
      let drained = false
      const draining = Promise.resolve(handle.drain()).then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      release.resolve()
      await draining
      expect((await h.db.select().from(eventDeliveries))[0]?.state).toBe('accepted')
    } finally {
      release.resolve()
      await handle.stop()
      await handle.drain()
    }
  })

  test('native HTTP ingress preserves immediate notification consumption', async () => {
    const consumed = deferred()
    const f = await ingress(h, false, async () => {
      consumed.resolve()
    })
    expect((await f.post('native-notification')).status).toBe(200)
    await consumed.promise
  })
})
