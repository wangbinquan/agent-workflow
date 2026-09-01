// RFC-349 — Event Center notification delivery and committed-event retry keep
// one lease/CAS behavior across the synchronous SQLite mechanism and the
// Promise-shaped PostgreSQL adapters.

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlEventStore } from '@/modules/event-center/infrastructure/postgresqlEventStore'
import { createSqliteEventStore } from '@/modules/event-center/infrastructure/sqliteEventStore'
import {
  eventContentDigest,
  eventTypeContentDigest,
  type EventObservation,
  type EventSourceDescriptor,
  type EventTypeDescriptor,
} from '@/modules/event-center/domain/model'
import {
  appendPostgresqlCommittedEventTx,
  createPostgresqlCommittedEventDeliveryPersistence,
} from '@/platform/events/committed/postgresqlPersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const SOURCE: EventSourceDescriptor = {
  schemaVersion: 1,
  sourceRef: { id: 'fixture.source', revision: 1 },
  ownerTypeId: 'fixture.owner',
  displayName: { 'zh-CN': '测试源', 'en-US': 'Fixture source' },
  description: { 'zh-CN': '用于测试', 'en-US': 'Used by the provider oracle' },
  observationMode: 'passive',
  observerProgramRef: null,
  pollIntervalMs: 1_000,
  batchSize: 10,
}

const EVENT_TYPE: EventTypeDescriptor = {
  schemaVersion: 1,
  eventTypeRef: { id: 'fixture.event.changed', revision: 1 },
  sourceRef: SOURCE.sourceRef,
  ownerTypeId: 'fixture.owner',
  subjectTypeId: 'fixture.subject',
  payloadSchemaId: 'fixture.payload',
  displayName: { 'zh-CN': '发生变更', 'en-US': 'Changed' },
  description: { 'zh-CN': '用于测试', 'en-US': 'Used by the provider oracle' },
  deliveryClass: 'fixture.delivery',
  triggerParameters: null,
}

const OBSERVATION: EventObservation = {
  sourceRef: SOURCE.sourceRef,
  eventTypeRef: EVENT_TYPE.eventTypeRef,
  subject: { typeId: 'fixture.subject', subjectRef: 'subject-1' },
  occurredAt: 100,
  dedupeKey: 'fixture-dedupe-1',
  summary: 'fixture changed',
  payloadArtifactRef: null,
  routingFacts: null,
  triggerParameters: null,
}

interface Response {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}

function rows(response: Response): SqlRows {
  const objects = [...(response.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = response.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return response.values ?? []
    },
  })
}

function postgresqlFixture(responses: Response[]) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    return rows(responses.shift() ?? {})
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: run,
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_event_delivery_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 Event Center provider behavior', () => {
  test('SQLite notification settlement rejects a stale attempt and accepts the live lease', async () => {
    const store = createSqliteEventStore(createInMemoryDb(MIGRATIONS))
    await store.registerSource(SOURCE, eventContentDigest(SOURCE), 1)
    await store.registerEventType(EVENT_TYPE, eventTypeContentDigest(EVENT_TYPE), 1)
    await store.subscribe({
      id: 'subscription-1',
      eventType: EVENT_TYPE,
      source: SOURCE,
      subject: OBSERVATION.subject,
      subscriber: { kind: 'automation', subscriberRef: 'automation-1' },
      identityKey: 'fixture-subscription-1',
      replayLatest: false,
      now: 2,
    })
    await store.recordObservation({
      eventId: 'event-1',
      observation: OBSERVATION,
      eventType: EVENT_TYPE,
      observedAt: 100,
      nextId: () => 'delivery-1',
      routingSubscriptions: [],
      triggerContext: null,
    })

    const claim = await store.claimNotificationDelivery({
      subscriberKinds: ['automation'],
      now: 101,
      leaseOwner: 'worker-1',
      leaseMs: 1_000,
    })
    expect(claim).toMatchObject({ deliveryId: 'delivery-1', attemptCount: 1 })
    expect(
      await store.settleNotificationDelivery({
        deliveryId: 'delivery-1',
        leaseOwner: 'worker-1',
        attemptCount: 0,
        now: 102,
        state: 'accepted',
        nextAttemptAt: 102,
        error: null,
      }),
    ).toBe(false)
    expect(
      await store.settleNotificationDelivery({
        deliveryId: 'delivery-1',
        leaseOwner: 'worker-1',
        attemptCount: 1,
        now: 102,
        state: 'accepted',
        nextAttemptAt: 102,
        error: null,
      }),
    ).toBe(true)
    await expect(store.listDeliveryStatusPage({ limit: 10, offset: 0 })).resolves.toMatchObject({
      items: [{ state: 'accepted', attemptCount: 1 }],
    })
  })

  test('PostgreSQL notification settlement fences both lease owner and attempt count', async () => {
    const fake = postgresqlFixture([
      {},
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { values: [['delivery-1']] },
      {},
      {},
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { values: [] },
      {},
    ])
    const store = createPostgresqlEventStore(fake.db)

    await expect(
      store.settleNotificationDelivery({
        deliveryId: 'delivery-1',
        leaseOwner: 'worker-1',
        attemptCount: 2,
        now: 200,
        state: 'accepted',
        nextAttemptAt: 200,
        error: null,
      }),
    ).resolves.toBe(true)
    await expect(
      store.settleNotificationDelivery({
        deliveryId: 'delivery-1',
        leaseOwner: 'worker-1',
        attemptCount: 1,
        now: 201,
        state: 'accepted',
        nextAttemptAt: 201,
        error: null,
      }),
    ).resolves.toBe(false)

    const updates = fake.executions.filter((execution) =>
      execution.sql.toLowerCase().includes('update "agent_workflow"."event_deliveries"'),
    )
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(update.sql).toContain('"claimed_by"')
      expect(update.sql).toContain('"attempt_count"')
      expect(update.sql.toLowerCase()).toContain('returning')
    }
  })

  test('PostgreSQL committed-event manual retry preserves lease and version CAS', async () => {
    const fake = postgresqlFixture([
      {},
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { values: [[3, 500]] },
      {},
    ])
    const persistence = createPostgresqlCommittedEventDeliveryPersistence(fake.db)

    await expect(
      persistence.retry({
        eventId: 'committed-event-1',
        consumerId: 'consumer-1',
        observedLeaseEpoch: 4,
        observedUpdatedAt: 400,
        now: 500,
      }),
    ).resolves.toEqual({
      eventId: 'committed-event-1',
      consumerId: 'consumer-1',
      replayGeneration: 3,
      state: 'pending',
      updatedAt: 500,
    })

    const update = fake.executions.find((execution) =>
      execution.sql.toLowerCase().includes('update "agent_workflow"."committed_event_deliveries"'),
    )
    expect(update?.sql).toContain('"lease_epoch"')
    expect(update?.sql).toContain('"updated_at"')
    expect(update?.sql.toLowerCase()).toContain('returning')
  })

  test('PostgreSQL producer atom allocates aggregate sequence and deliveries in its caller transaction', async () => {
    const fake = postgresqlFixture([
      {},
      { values: [['task-execution', 'task-lifecycle', 'dispatchable', 2, 90, 'cutover-2']] },
      { values: [] },
      {},
      { values: [] },
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { count: 1 },
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { count: 1 },
      { objects: [{ generation_id: 'dbg_event_delivery_pg' }] },
      { count: 1 },
      {
        values: [
          [
            'committed-event-1',
            'group-1',
            0,
            'task-execution',
            'task-lifecycle',
            'task.lifecycle.changed',
            1,
            'task',
            'task-1',
            1,
            'operation-1',
            null,
            null,
            100,
            '{}',
            'fixture-digest',
            'dispatchable',
            2,
            100,
          ],
        ],
      },
      {},
    ])

    await expect(
      fake.db.transaction(
        async (tx) =>
          await appendPostgresqlCommittedEventTx(tx, {
            eventId: 'committed-event-1',
            eventGroupId: 'group-1',
            eventGroupOrdinal: 0,
            producer: 'task-execution',
            family: 'task-lifecycle',
            type: 'task.lifecycle.changed',
            aggregate: { kind: 'task', id: 'task-1' },
            operationRef: 'operation-1',
            occurredAt: 100,
            payload: { status: 'done' },
            consumers: [{ id: 'consumer-1', deliveryClass: 'critical' }],
          }),
      ),
    ).resolves.toMatchObject({
      cutover: { mode: 'dispatchable', epoch: 2 },
      eventRef: {
        eventId: 'committed-event-1',
        aggregate: { kind: 'task', id: 'task-1', seq: 1 },
        deliveryMode: 'dispatchable',
        producerEpoch: 2,
      },
    })

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    const lockIndex = statements.findIndex((statement) =>
      statement.includes('pg_advisory_xact_lock'),
    )
    const headInsertIndex = statements.findIndex((statement) =>
      statement.includes('insert into "agent_workflow"."committed_event_aggregate_heads"'),
    )
    const eventInsertIndex = statements.findIndex((statement) =>
      statement.includes('insert into "agent_workflow"."committed_events"'),
    )
    const deliveryInsertIndex = statements.findIndex((statement) =>
      statement.includes('insert into "agent_workflow"."committed_event_deliveries"'),
    )
    expect(statements[0]?.trim()).toBe('begin')
    expect(statements.at(-1)?.trim()).toBe('commit')
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(headInsertIndex).toBeGreaterThan(lockIndex)
    expect(eventInsertIndex).toBeGreaterThan(headInsertIndex)
    expect(deliveryInsertIndex).toBeGreaterThan(eventInsertIndex)
  })
})
