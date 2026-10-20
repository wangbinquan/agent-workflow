// RFC-370 H8: durable ACK, frozen multi-target routes, permanent receipts and
// separate observation obligations. Execute on both providers at final validation.
//
// RFC-370 v3 V8 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9)
// regression intent:
// - Pausing one endpoint used to answer the whole delivery 503 before anything
//   was stored, so every other endpoint routed from the same event lost it
//   (CrewStation dead-letters after its retries). The event-source cutover
//   (pause / resume / direct) is gone: a binding's channel comes from
//   AW_EVENT_SOURCES (`crewstation` or `shadow`), and one failing target never
//   holds back another.
// - The envelope was parsed `.strict()` while CrewStation's EventDeliverySchema
//   is not, so any new platform field would have dead-lettered every event.
// - A hosted deployment offered a direct webhook transport a DigitalWorker
//   cannot receive; a hosted deployment has no direct webhook ingress.
// - Completing a target re-implemented the direct ingress' delivery outcome;
//   both now share `webhookDeliveryOutcome`.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  csEventInbox,
  csEventRoutes,
  csEventTargets,
  csWebhookVerifications,
  eventRecords,
  webhookDeliveries,
  webhookEndpoints,
  webhookMrStreamStates,
} from '@/db/schema'
import { composeEventCenter } from './helpers/eventCenter'
import type {
  EventObservationInput,
  EventObservationReceipt,
} from '@/modules/event-center/public/types'
import { createCrewStationEventIngress } from '@/modules/integration/application/crewStationEventIngress'
import { composeCrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import {
  composeWebhookIngressPersistenceFor,
  composeWebhookIngressTransport,
} from '@/modules/integration/composition/webhookIngress'
import { createCrewStationEventInbox } from '@/modules/integration/infrastructure/crewstation/eventInbox'
import {
  CREWSTATION_CODE_HOST_EVENTS,
  CrewStationEventError,
  crewStationRepository,
  inboundCrewStationDelivery,
  normalizeCrewStationEvent,
  routeCrewStationEvent,
  validateCrewStationEventSources,
  validateCrewStationEventSubscriptions,
  type CrewStationEventDelivery,
  type CrewStationEventSource,
} from '@/modules/integration/infrastructure/crewstation/eventContract'
import { createWebhookDeliveryPersistence } from '@/modules/integration/infrastructure/webhookDeliveryPersistence'
import { createWebhookDeliveryQueries } from '@/modules/integration/infrastructure/webhookDeliveryQueries'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { errorHandler } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

function fixture(type = 'gitlab.merge-request.open') {
  const producer = type.startsWith('gitlab.') ? 'gitlab' : 'github'
  const source: CrewStationEventSource = {
    producerId: Bun.randomUUIDv7(),
    producer,
    project: 'code-host',
    revision: 1,
    instanceUrl: 'https://git.example',
    apiBaseUrl: 'https://git.example/api/' + (producer === 'gitlab' ? 'v4' : 'v3'),
    repositories: ['group/repo'],
    eventTypes: Object.keys(CREWSTATION_CODE_HOST_EVENTS)
      .filter((name) => name.startsWith(producer + '.'))
      .map((name) => ({ id: Bun.randomUUIDv7(), name })),
    bindings: ['endpoint-a', 'endpoint-b'].map((endpointId) => ({
      endpointId,
      revision: 1,
      repositories: ['group/repo'],
      mode: 'crewstation',
    })),
  }
  const project = {
    id: 1,
    path_with_namespace: 'group/repo',
    web_url: 'https://git.example/group/repo',
    git_http_url: 'https://git.example/group/repo.git',
    git_ssh_url: 'git@git.example:group/repo.git',
  }
  const repository = {
    id: 1,
    full_name: 'group/repo',
    html_url: project.web_url,
    clone_url: project.git_http_url,
    ssh_url: project.git_ssh_url,
  }
  const mr = {
    id: 42,
    iid: 7,
    title: 'Change',
    source_branch: 'branch',
    target_branch: 'main',
    last_commit: { id: 'abc' },
  }
  let payload: Record<string, unknown> = { project, user: { username: 'alice' } }
  if (producer === 'gitlab') {
    const family = type.split('.')[1],
      action = type.split('.')[2]
    if (family === 'push' || family === 'tag-push')
      payload = {
        ...payload,
        object_kind: family === 'push' ? 'push' : 'tag_push',
        ref: `refs/${family === 'push' ? 'heads' : 'tags'}/main`,
        after: 'abc',
      }
    else if (action === 'comment')
      payload = {
        ...payload,
        object_kind: 'note',
        object_attributes: {
          id: 3,
          noteable_type: family === 'issue' ? 'Issue' : 'MergeRequest',
          note: 'hello',
        },
        merge_request: mr,
        issue: { id: 4, iid: 7 },
      }
    else if (family === 'merge-request')
      payload = {
        ...payload,
        object_kind: 'merge_request',
        object_attributes: { ...mr, action: action ?? 'unknown' },
      }
    else if (family === 'pipeline')
      payload = {
        ...payload,
        object_kind: 'pipeline',
        object_attributes: { id: 6, status: action ?? 'unknown', ref: 'main', sha: 'abc' },
      }
    else
      payload = {
        ...payload,
        object_kind: 'issue',
        object_attributes: { id: 7, iid: 7, action: action ?? 'unknown' },
        changes: { labels: { previous: [], current: [{ title: 'bug' }] } },
      }
  } else {
    const family = type.split('.')[1],
      action = type.split('.')[2]
    const pr = {
      id: 42,
      number: 7,
      merged: action === 'merge',
      head: { ref: 'branch', sha: 'abc' },
      base: { ref: 'main' },
    }
    payload = { repository, sender: { login: 'alice' } }
    if (family === 'push' || family === 'tag-push')
      payload = {
        ...payload,
        ref: `refs/${family === 'push' ? 'heads' : 'tags'}/main`,
        after: 'abc',
      }
    else if (action === 'comment')
      payload = {
        ...payload,
        action: 'created',
        issue: {
          id: 1,
          number: 7,
          ...(family === 'pull-request'
            ? { pull_request: { url: 'https://git.example/api/v3/repos/group/repo/pulls/7' } }
            : {}),
        },
        comment: { id: 2, body: 'hello' },
      }
    else if (action === 'review-comment')
      payload = {
        ...payload,
        action: 'created',
        pull_request: pr,
        comment: { id: 2, body: 'hello', commit_id: 'abc' },
      }
    else if (family === 'pull-request')
      payload = {
        ...payload,
        action: {
          open: 'opened',
          reopen: 'reopened',
          update: 'synchronize',
          close: 'closed',
          merge: 'closed',
        }[action!],
        number: 7,
        pull_request: pr,
      }
    else if (family === 'workflow-run')
      payload = {
        ...payload,
        action: 'completed',
        workflow_run: {
          id: 3,
          head_branch: 'main',
          head_sha: 'abc',
          conclusion: action!.replace('timed-out', 'timed_out'),
        },
      }
    else
      payload = {
        ...payload,
        action: 'labeled',
        issue: { id: 4, number: 7, labels: [{ name: 'bug' }] },
        label: { id: 2, name: 'bug' },
      }
  }
  const delivery: CrewStationEventDelivery = {
    deliveryId: Bun.randomUUIDv7(),
    eventId: Bun.randomUUIDv7(),
    eventTypeId: source.eventTypes.find((entry) => entry.name === type)!.id,
    eventType: type,
    source: { producerId: source.producerId, producer, project: source.project },
    occurredAt: '2026-10-15T00:00:00Z',
    receivedAt: '2026-10-15T00:00:01Z',
    traceId: '0'.repeat(32),
    attempt: 1,
    payload,
  }
  return { source, delivery }
}

const headersOf = (
  delivery: Pick<CrewStationEventDelivery, 'deliveryId' | 'eventType' | 'attempt'>,
) => ({
  deliveryId: delivery.deliveryId,
  eventType: delivery.eventType,
  attempt: String(delivery.attempt),
})

function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

test('manifest subscriptions and the mutable event source configuration must agree before startup', () => {
  const { source } = fixture()
  const ids = source.eventTypes.map((type) => type.id)
  expect(() => validateCrewStationEventSubscriptions([source], ids)).not.toThrow()
  expect(() => validateCrewStationEventSubscriptions([], [])).not.toThrow()
  expect(() => validateCrewStationEventSubscriptions([source], [])).toThrow('manifest')
  expect(() =>
    validateCrewStationEventSubscriptions([source], [...ids, Bun.randomUUIDv7()]),
  ).toThrow('manifest')
  expect(() => validateCrewStationEventSubscriptions([source], [...ids.slice(1), ids[1]!])).toThrow(
    'manifest',
  )
})

test('a binding channel is crewstation or shadow; a paused channel or two channels for one endpoint fail at startup', () => {
  const { source } = fixture()
  expect(
    validateCrewStationEventSources([
      {
        ...source,
        bindings: source.bindings.map((b, i) => ({ ...b, mode: i ? 'shadow' : 'crewstation' })),
      },
    ]),
  ).toHaveLength(1)
  expect(() =>
    validateCrewStationEventSources([
      { ...source, bindings: [{ ...source.bindings[0]!, mode: 'paused' }] },
    ]),
  ).toThrow()
  const other = fixture('github.push').source
  expect(() =>
    validateCrewStationEventSources([
      { ...source, bindings: [{ ...source.bindings[0]!, mode: 'crewstation' }] },
      {
        ...other,
        bindings: [
          { ...other.bindings[0]!, endpointId: source.bindings[0]!.endpointId, mode: 'shadow' },
        ],
      },
    ]),
  ).toThrow('conflicting CS endpoint channels')
})

test('exact 40-type producer catalog preserves every existing mapped or ignored outcome', () => {
  expect(Object.keys(CREWSTATION_CODE_HOST_EVENTS)).toHaveLength(40)
  const seen = new Set<string>()
  for (const [name, mapping] of Object.entries(CREWSTATION_CODE_HOST_EVENTS)) {
    const { source, delivery } = fixture(name)
    expect(validateCrewStationEventSources([source])).toHaveLength(1)
    expect(crewStationRepository(delivery, source)).toBe('group/repo')
    const result = normalizeCrewStationEvent(delivery, source, 'stable-event')
    if (result.ok) {
      expect(mapping.outcomes).toContain(result.event.eventType)
      expect(result.event.eventUuid).toBe('stable-event')
      expect(result.event.apiBaseUrl).toBe(source.apiBaseUrl)
      seen.add(result.event.eventType)
    } else {
      expect(result.reason).toBe('unsupported-event')
      expect(
        mapping.outcomes.length === 0 ||
          name === 'gitlab.merge-request' ||
          name === 'gitlab.pipeline',
      ).toBe(true)
    }
  }
  expect([...seen].sort()).toEqual(
    [
      'push',
      'tag_push',
      'mr_opened',
      'mr_updated',
      'mr_closed',
      'mr_merged',
      'note',
      'issue_comment',
      'issue_labeled',
      'pipeline_failed',
      'pipeline_succeeded',
    ].sort(),
  )
})

test('family, instance, repository and clone identities never come from type text alone', () => {
  const { source, delivery } = fixture()
  expect(() => crewStationRepository({ ...delivery, eventType: 'gitlab.push' }, source)).toThrow(
    'family-conflict',
  )
  const project = delivery.payload.project as Record<string, unknown>
  expect(() =>
    crewStationRepository(
      {
        ...delivery,
        payload: {
          ...delivery.payload,
          project: { ...project, web_url: 'https://evil.invalid/group/repo' },
        },
      },
      source,
    ),
  ).toThrow('instance-conflict')
  expect(
    normalizeCrewStationEvent(
      {
        ...delivery,
        payload: {
          ...delivery.payload,
          project: { ...project, git_http_url: 'https://evil.invalid/repo.git' },
        },
      },
      source,
      'id',
    ),
  ).toMatchObject({ ok: false, reason: 'parse-failed' })
  expect(() =>
    validateCrewStationEventSources([
      { ...source, bindings: [{ ...source.bindings[0]!, repositories: ['not/approved'] }] },
    ]),
  ).toThrow('repository binding')
  const withSshPort = {
    ...delivery,
    payload: {
      ...delivery.payload,
      project: { ...project, git_ssh_url: 'ssh://custom@git.example:2222/group/repo.git' },
    },
  }
  expect(normalizeCrewStationEvent(withSshPort, source, 'id')).toMatchObject({ ok: false })
  expect(
    normalizeCrewStationEvent(
      withSshPort,
      { ...source, sshOrigins: ['ssh://custom@git.example:2222'] },
      'id',
    ),
  ).toMatchObject({ ok: true })
})

test('the envelope tolerates new CrewStation fields and still validates every field AW uses', () => {
  const { source, delivery } = fixture()
  const plain = inboundCrewStationDelivery(delivery, headersOf(delivery), [source])
  const grown = inboundCrewStationDelivery(
    {
      ...delivery,
      tenantRegion: 'eu-1',
      source: { ...delivery.source, producerRevision: 4 },
    },
    headersOf(delivery),
    [source],
  )
  // Same event: a platform upgrade never turns a redelivery into a conflict.
  expect(grown.factDigest).toBe(plain.factDigest)
  expect(grown.envelopeJson).toBe(plain.envelopeJson)
  expect(JSON.parse(grown.envelopeJson)).not.toHaveProperty('tenantRegion')
  const refusal = (value: unknown, headers = headersOf(delivery)) =>
    caught(() => inboundCrewStationDelivery(value, headers, [source]))
  const { traceId: _traceId, ...withoutTrace } = delivery
  expect(refusal(withoutTrace)).toMatchObject({ status: 400, code: 'invalid-event-delivery' })
  expect(refusal({ ...delivery, payload: [1, 2] })).toMatchObject({
    code: 'invalid-event-delivery',
  })
  expect(refusal({ ...delivery, deliveryId: 'not-a-uuid' })).toMatchObject({
    code: 'invalid-event-delivery',
  })
  expect(refusal(delivery, { ...headersOf(delivery), attempt: '2' })).toMatchObject({
    status: 400,
    code: 'event-header-envelope-conflict',
  })
  expect(refusal(delivery)).toBeUndefined()
  expect(refusal(withoutTrace)).toBeInstanceOf(CrewStationEventError)
})

test('routing freezes sorted targets with their channels, or names why it cannot route', () => {
  const { source, delivery } = fixture()
  const shadowed = {
    ...source,
    bindings: [
      { ...source.bindings[1]!, mode: 'shadow' as const },
      { ...source.bindings[0]!, mode: 'crewstation' as const },
    ],
  }
  expect(routeCrewStationEvent(delivery, [shadowed])).toMatchObject({
    kind: 'routed',
    sourceRevision: 1,
    targets: [
      { endpointId: 'endpoint-a', bindingRevision: 1, channel: 'crewstation' },
      { endpointId: 'endpoint-b', bindingRevision: 1, channel: 'shadow' },
    ],
  })
  expect(
    routeCrewStationEvent(delivery, [{ ...source, repositories: ['group/other'], bindings: [] }]),
  ).toMatchObject({
    kind: 'routed',
    targets: [],
  })
  expect(routeCrewStationEvent(delivery, [])).toEqual({
    kind: 'unroutable',
    status: 422,
    code: 'unknown-producer-or-event-binding',
  })
  expect(routeCrewStationEvent({ ...delivery, eventType: 'gitlab.push' }, [source])).toMatchObject({
    kind: 'unroutable',
  })
  expect(
    routeCrewStationEvent(
      {
        ...delivery,
        eventTypeId: source.eventTypes.find((t) => t.name === 'gitlab.push')!.id,
        eventType: 'gitlab.push',
      },
      [source],
    ),
  ).toEqual({ kind: 'unroutable', status: 400, code: 'event-payload-family-conflict' })
})

describeEachProvider('RFC-370 permanent CS inbox', (harness) => {
  async function setup(type = 'gitlab.merge-request.open') {
    const { source, delivery } = fixture(type)
    for (const binding of source.bindings)
      await harness.db.insert(webhookEndpoints).values({
        id: binding.endpointId,
        name: binding.endpointId,
        provider: 'gitlab',
        urlToken: binding.endpointId,
        secretEnc: 'unused',
      })
    let timestamp = 1000,
      held = true
    const fence = {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: async () => {
        if (!held) throw new Error('fence lost')
      },
    }
    const ingress = () =>
      createCrewStationEventIngress({
        inbox: createCrewStationEventInbox({
          db: harness.db,
          installationId: 'aw/aw',
          fence,
          now: () => timestamp,
        }),
      })
    const receive = (
      value: CrewStationEventDelivery,
      sources: readonly CrewStationEventSource[] = [source],
    ) => ingress().receive(inboundCrewStationDelivery(value, headersOf(value), sources))
    const rows = new Map<string, EventObservationReceipt>(),
      calls: string[] = []
    let fail: ((observation: EventObservationInput) => boolean) | null = null
    let deliveryCount = 1
    const publisher = {
      async observe(observation: EventObservationInput) {
        const key = `${observation.eventTypeRef.id}:${observation.dedupeKey}`
        calls.push(key)
        const existing = rows.get(key)
        const receipt = existing
          ? { ...existing, duplicate: true }
          : {
              eventId: Bun.randomUUIDv7(),
              duplicate: false,
              deliveryCount,
              deliveryIds: deliveryCount > 0 ? ['notification'] : [],
            }
        rows.set(key, receipt)
        if (fail?.(observation)) throw new Error('observation committed; ACK lost')
        return receipt
      },
      wakeTerminalControl: () => {},
    }
    return {
      source,
      delivery,
      fence,
      ingress,
      receive,
      publisher,
      rows,
      calls,
      failWith: (fn: typeof fail) => {
        fail = fn
      },
      matchNothing: () => {
        deliveryCount = 0
      },
      advance: () => {
        timestamp += 6000
      },
      loseFence: () => {
        held = false
      },
    }
  }
  const targetOf = async (endpointId: string) =>
    (
      await harness.db
        .select()
        .from(csEventTargets)
        .where(eq(csEventTargets.endpointId, endpointId))
    )[0]!

  test('ACK precedes normalization; a redelivery after configuration changes keeps the frozen targets', async () => {
    const f = await setup()
    await f.receive(f.delivery)
    expect(await harness.db.select().from(webhookDeliveries)).toHaveLength(0)
    expect(await harness.db.select().from(csEventTargets)).toHaveLength(2)
    const changed = [
      {
        ...f.source,
        revision: 2,
        bindings: [{ ...f.source.bindings[0]!, endpointId: 'new-endpoint', revision: 2 }],
      },
    ]
    await f.receive({ ...f.delivery, deliveryId: Bun.randomUUIDv7(), attempt: 3 }, changed)
    await f.receive({ ...f.delivery, attempt: 4 }, [])
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(2)
    expect(await harness.db.select().from(csEventRoutes)).toHaveLength(1)
    expect(
      (await harness.db.select().from(csEventTargets)).map((row) => row.endpointId).sort(),
    ).toEqual(['endpoint-a', 'endpoint-b'])
    expect(await f.ingress().runPending(f.publisher)).toBe(2)
    expect(
      (await harness.db.select().from(csEventTargets)).every((row) => row.stage === 'completed'),
    ).toBe(true)
    const facts = await harness.db.select().from(webhookDeliveries)
    expect(facts).toHaveLength(2)
    // Both finalized with the shared outcome: an observation reached a subscriber.
    expect(facts.every((row) => row.status === 'matched' && row.statusReason === null)).toBe(true)
    const verification = await harness.db.select().from(csWebhookVerifications)
    expect(verification).toHaveLength(2)
    expect(
      verification.every((row) => row.transportReceiptRef.startsWith('cs-event-target:')),
    ).toBe(true)
    expect(await harness.db.select().from(webhookMrStreamStates)).toHaveLength(2)
    expect(f.rows.size).toBe(4)
    expect(
      (await harness.db.select().from(webhookEndpoints)).every(
        (row) => row.lastDeliveryAt !== null,
      ),
    ).toBe(true)
  })

  test('one failing target never holds back another: the other completes, the failing one retries alone', async () => {
    const f = await setup()
    await f.receive(f.delivery)
    f.failWith(
      (observation) =>
        observation.dedupeKey.includes('endpoint-b') &&
        observation.eventTypeRef.id === 'code-host.merge-request.opened',
    )
    await f.ingress().runPending(f.publisher)
    expect((await targetOf('endpoint-a')).stage).toBe('completed')
    const partial = await targetOf('endpoint-b')
    expect(partial).toMatchObject({
      stage: 'admitted',
      attempts: 1,
      lastError: 'observation committed; ACK lost',
    })
    expect(partial.nextAttemptAt).toBe(1000 + 5000)
    expect(Object.keys(JSON.parse(partial.publishedJson))).toHaveLength(1)
    // Not due yet: a retry before the backoff does nothing.
    expect(await f.ingress().runPending(f.publisher)).toBe(0)
    await harness.db
      .update(webhookDeliveries)
      .set({ status: 'failed' })
      .where(eq(webhookDeliveries.id, partial.deliveryId!))
    // Legacy retention must not remove payloads while a transport publication is pending.
    await harness.db
      .update(webhookDeliveries)
      .set({ receivedAt: 1 })
      .where(eq(webhookDeliveries.id, partial.deliveryId!))
    const persistence = createWebhookDeliveryPersistence(harness.db)
    let cursor: Parameters<typeof persistence.gcSlice>[0]['cursor'] = null
    for (let i = 0; i < 3; i++) {
      const result = await persistence.gcSlice({
        now: 1_000_000,
        retention: { bodyRetentionMs: 1, rowRetentionMs: 1 },
        cursor,
        batchSize: 100,
      })
      if (result.done) break
      cursor = result.cursor
    }
    const retained = (
      await harness.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, partial.deliveryId!))
    )[0]
    expect(retained?.bodyJson).not.toBeNull()
    f.failWith(null)
    f.advance()
    expect(await f.ingress().runPending(f.publisher)).toBe(1)
    expect(await harness.db.select().from(webhookDeliveries)).toHaveLength(2)
    expect(
      (await harness.db.select().from(webhookMrStreamStates)).every((row) => row.revision === 1),
    ).toBe(true)
    expect(f.rows.size).toBe(4)
    expect(f.calls.filter((key) => key.includes('endpoint-a'))).toHaveLength(2)
    expect(
      (await harness.db.select().from(csEventTargets)).every((row) => row.stage === 'completed'),
    ).toBe(true)
  })

  test('identity conflicts are durable audit facts and never add targets or business effects', async () => {
    const f = await setup()
    await f.receive(f.delivery)
    const changed = { ...f.delivery, payload: { ...f.delivery.payload, changed: true } }
    await expect(f.receive(changed)).rejects.toMatchObject({
      status: 409,
      code: 'event-identity-content-conflict',
    })
    await expect(f.receive({ ...changed, deliveryId: Bun.randomUUIDv7() })).rejects.toMatchObject({
      status: 409,
    })
    expect((await harness.db.select().from(csEventInbox))[0]?.conflicts).toBe(1)
    expect((await harness.db.select().from(csEventRoutes))[0]?.conflicts).toBe(1)
    expect(await harness.db.select().from(csEventTargets)).toHaveLength(2)
    expect(await harness.db.select().from(webhookDeliveries)).toHaveLength(0)
  })

  test('an unroutable first sighting stores nothing; a frozen event stays accepted after its source leaves the configuration', async () => {
    const f = await setup()
    await expect(f.receive(f.delivery, [])).rejects.toMatchObject({
      status: 422,
      code: 'unknown-producer-or-event-binding',
    })
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(0)
    expect(await harness.db.select().from(csEventRoutes)).toHaveLength(0)
    await f.receive(f.delivery)
    await f.receive({ ...f.delivery, deliveryId: Bun.randomUUIDv7(), attempt: 2 }, [])
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(2)
    expect(await harness.db.select().from(csEventTargets)).toHaveLength(2)
  })

  test('empty routing, deleted and disabled endpoints and the shadow channel have explicit terminal stages', async () => {
    const f = await setup()
    await f.receive(f.delivery, [{ ...f.source, bindings: [] }])
    expect((await harness.db.select().from(csEventRoutes))[0]?.result).toBe('ignored')
    expect(await harness.db.select().from(csEventTargets)).toHaveLength(0)
    const second = { ...f.delivery, deliveryId: Bun.randomUUIDv7(), eventId: Bun.randomUUIDv7() }
    await f.receive(second, [
      {
        ...f.source,
        bindings: [
          { ...f.source.bindings[0]!, mode: 'shadow' },
          { ...f.source.bindings[1]!, mode: 'crewstation' },
        ],
      },
    ])
    await harness.db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, 'endpoint-b'))
    await f.ingress().runPending(f.publisher)
    expect((await targetOf('endpoint-a')).stage).toBe('shadow')
    expect((await targetOf('endpoint-a')).lastError).toContain('normalized:mr_opened')
    expect((await targetOf('endpoint-b')).stage).toBe('source-deleted')
    const third = { ...f.delivery, deliveryId: Bun.randomUUIDv7(), eventId: Bun.randomUUIDv7() }
    await harness.db
      .update(webhookEndpoints)
      .set({ enabled: false })
      .where(eq(webhookEndpoints.id, 'endpoint-a'))
    await f.receive(third, [{ ...f.source, bindings: [f.source.bindings[0]!] }])
    await f.ingress().runPending(f.publisher)
    const rejected = (await harness.db.select().from(csEventTargets)).filter(
      (row) => row.stage === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(await harness.db.select().from(webhookDeliveries)).toHaveLength(0)
    expect(f.rows.size).toBe(0)
  })

  test('a delivery nothing subscribes to is finalized as ignored by the shared outcome', async () => {
    const f = await setup()
    f.matchNothing()
    await f.receive(f.delivery, [{ ...f.source, bindings: [f.source.bindings[0]!] }])
    await f.ingress().runPending(f.publisher)
    const facts = await harness.db.select().from(webhookDeliveries)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ status: 'ignored', statusReason: 'no-trigger-matched' })
  })

  test('lost execution fence leaves all durable targets pending', async () => {
    const f = await setup()
    await f.receive(f.delivery)
    f.loseFence()
    await expect(f.ingress().runPending(f.publisher)).rejects.toThrow('fence lost')
    expect(
      (await harness.db.select().from(csEventTargets)).every((row) => row.stage === 'pending'),
    ).toBe(true)
    expect(f.rows.size).toBe(0)
  })

  test('real Event Center publication checks the lease inside its transaction and recovers two obligations', async () => {
    const f = await setup()
    let blocked = false,
      guards = 0
    const center = await composeEventCenter({
      db: harness.db,
      typePackageDescriptorJsons: [codeHostEventCatalogJson],
      automation: { kind: 'observation-only' },
      beforeObservationWrite: async () => {
        guards++
        if (blocked) throw new Error('observation fence lost')
      },
    })
    await f.receive(f.delivery)
    let interrupt = true
    const publisher = {
      observe: async (observation: EventObservationInput) => {
        blocked = interrupt && observation.eventTypeRef.id === 'code-host.merge-request.opened'
        return await center.commands.observe(observation)
      },
      wakeTerminalControl: () => {},
    }
    await f.ingress().runPending(publisher)
    expect(await harness.db.select().from(eventRecords)).toHaveLength(2)
    expect(
      (await harness.db.select().from(csEventTargets)).every((row) => row.stage === 'admitted'),
    ).toBe(true)
    interrupt = false
    blocked = false
    f.advance()
    await f.ingress().runPending(publisher)
    expect(await harness.db.select().from(eventRecords)).toHaveLength(4)
    expect(
      (await harness.db.select().from(csEventTargets)).every((row) => row.stage === 'completed'),
    ).toBe(true)
    expect(guards).toBeGreaterThanOrEqual(6)
  })

  test('a delegated delivery names its platform event and every platform delivery of it', async () => {
    const f = await setup()
    await f.receive(f.delivery, [{ ...f.source, bindings: [f.source.bindings[0]!] }])
    const redelivery = { ...f.delivery, deliveryId: Bun.randomUUIDv7(), attempt: 2 }
    await f.receive(redelivery)
    await f.ingress().runPending(f.publisher)
    const fact = (await harness.db.select().from(webhookDeliveries))[0]!
    const detail = await createWebhookDeliveryQueries(harness.db).get(fact.id)
    expect(detail).toMatchObject({
      verificationMethod: 'cs-delegated',
      bodyRepresentation: 'reserialized-json',
      platformEvent: { eventId: f.delivery.eventId, eventType: 'gitlab.merge-request.open' },
    })
    expect(detail?.platformEvent?.deliveries.map((entry) => entry.deliveryId).sort()).toEqual(
      [f.delivery.deliveryId, redelivery.deliveryId].sort(),
    )
    expect(
      detail?.platformEvent?.deliveries.find((entry) => entry.deliveryId === redelivery.deliveryId)
        ?.attempt,
    ).toBe(2)
    expect(detail).not.toHaveProperty('transportReceiptRef')
    // A delivery without a platform receipt has no platform provenance.
    await harness.db.delete(csWebhookVerifications)
    expect(await createWebhookDeliveryQueries(harness.db).get(fact.id)).toMatchObject({
      verificationMethod: 'direct-signature',
      platformEvent: null,
    })
  })

  test('HTTP refusals reach the shared error handler; 204 only after the delivery is durable', async () => {
    const f = await setup()
    const app = new Hono()
    composeCrewStationEventIngress({
      db: harness.db,
      installationId: 'aw/aw',
      fence: f.fence,
      sources: [f.source],
      verifySource: async (token) => token === 'platform-events',
    }).mount(app)
    app.onError(errorHandler)
    const headers = {
      'x-cs-source-token': 'platform-events',
      'x-cs-delivery-id': f.delivery.deliveryId,
      'x-cs-event-type': f.delivery.eventType,
      'x-cs-delivery-attempt': '1',
    }
    const request = (
      extra: Record<string, string> = {},
      body: string = JSON.stringify(f.delivery),
    ) =>
      app.request('/integrations/crewstation/events', {
        method: 'POST',
        headers: { ...headers, ...extra },
        body,
      })
    const refused = async (response: Response, status: number, code: string) => {
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ ok: false, code })
    }
    await refused(await request({ 'x-cs-source-token': 'user' }), 401, 'invalid-event-source-token')
    await refused(
      await request({ 'x-cs-delivery-attempt': '2' }),
      400,
      'event-header-envelope-conflict',
    )
    await refused(await request({}, '{not json'), 400, 'invalid-event-json')
    await refused(await request({}, 'x'.repeat(1024 * 1024 + 1)), 413, 'event-body-too-large')
    const unknown = fixture()
    await refused(
      await request(
        {
          'x-cs-delivery-id': unknown.delivery.deliveryId,
          'x-cs-event-type': unknown.delivery.eventType,
        },
        JSON.stringify(unknown.delivery),
      ),
      422,
      'unknown-producer-or-event-binding',
    )
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(0)
    // A field CrewStation adds later is accepted, not dead-lettered.
    expect(
      (await request({}, JSON.stringify({ ...f.delivery, newPlatformField: true }))).status,
    ).toBe(204)
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(1)
    expect(await harness.db.select().from(csEventTargets)).toHaveLength(2)
    expect((await request()).status).toBe(204)
    expect(await harness.db.select().from(csEventInbox)).toHaveLength(1)
  })

  test('a hosted deployment has no direct webhook ingress; a standalone one keeps it', async () => {
    const f = await setup()
    const eventCenter = await composeEventCenter({
      db: harness.db,
      typePackageDescriptorJsons: [codeHostEventCatalogJson],
      automation: { kind: 'observation-only' },
    })
    const common = {
      webhookIngressPersistence: composeWebhookIngressPersistenceFor(harness.db),
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 3)),
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher: { dispatch: async () => {}, dispatchSubscription: async () => {} },
    }
    const hosted = composeWebhookIngressTransport({
      ...common,
      crewStationEvents: composeCrewStationEventIngress({
        db: harness.db,
        installationId: 'aw/aw',
        fence: f.fence,
        sources: [f.source],
        verifySource: async () => true,
      }),
    })
    expect(hosted.verifiedIngress).toBeUndefined()
    expect(hosted.crewStationEvents).toBeDefined()
    expect(composeWebhookIngressTransport(common).verifiedIngress).toBeDefined()
  })
})
