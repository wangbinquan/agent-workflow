// RFC-349 AC-12 — one executable behavior transcript crosses both provider
// implementations. PostgreSQL uses the real adapters over a scripted SQL
// runtime; the script verifies the adapter's actual transaction/fence path and
// never substitutes a SQLite client or a second business implementation.

import { afterEach, describe, expect, test } from 'bun:test'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { committedEventDeliveries, committedEvents, resourceBundleApplies } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  createResourcePackageApplyMaintenanceCommand,
  type ResourcePackageApplyArtifactRecoveryPort,
  type ResourcePackageApplyJournalSnapshot,
} from '@/modules/resource-catalog/application/resourcePackageMaintenance'
import { createPostgresqlResourcePackageApplyJournalPort } from '@/modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance'
import { createSqliteResourcePackageApplyJournalPort } from '@/modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance'
import type { MaintenanceRunStore } from '@/platform/background/maintenanceRunStorePort'
import { createPostgresqlCommittedEventDeliveryPersistence } from '@/platform/events/committed/postgresqlPersistence'
import type { CommittedEventDeliveryPersistencePort } from '@/platform/events/committed/persistence'
import { createSqliteCommittedEventDeliveryPersistence } from '@/platform/events/committed/sqlitePersistence'
import type {
  CommittedEventEnvelopeV1,
  StoredCommittedEvent,
} from '@/platform/events/committed/types'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlMaintenanceRunStore } from '@/platform/persistence/postgresqlMaintenanceRunStore'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { createSqliteMaintenanceRunStore } from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { sha256Hex } from '@/util/hash'
import { canonicalJson } from '@agent-workflow/shared'
import { MIGRATIONS } from './migration-freeze'

type SqlStep = Readonly<{
  label: string
  sql: RegExp
  values?: readonly (readonly unknown[])[]
  objects?: readonly Record<string, unknown>[]
  count?: number
}>

interface ScriptedPostgresqlFixture {
  readonly db: ReturnType<typeof createPostgresqlDatabaseClient>
  readonly assertExhausted: () => void
}

function sqlRows(step: SqlStep): SqlRows {
  const objects = [...(step.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = step.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return step.values ?? []
    },
  })
}

function createScriptedPostgresqlFixture(
  label: string,
  steps: readonly SqlStep[],
): ScriptedPostgresqlFixture {
  const remaining = [...steps]
  const execute = (query: string): SqlRows => {
    const step = remaining.shift()
    if (step === undefined) {
      throw new Error(`${label}: unexpected PostgreSQL statement: ${query}`)
    }
    if (!step.sql.test(query)) {
      throw new Error(`${label}: expected ${step.label}; received: ${query}`)
    }
    return sqlRows(step)
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {},
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_rfc349_dual_provider_oracle',
    async health() {
      throw new Error('not used by the behavior oracle')
    },
    async readiness() {
      throw new Error('not used by the behavior oracle')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used by the behavior oracle')
    },
    providerPool: () => pool,
    async close() {},
  }
  return {
    db: createPostgresqlDatabaseClient(runtime),
    assertExhausted() {
      expect(remaining.map((step) => step.label)).toEqual([])
    },
  }
}

const BEGIN: SqlStep = { label: 'BEGIN', sql: /^BEGIN$/i }
const COMMIT: SqlStep = { label: 'COMMIT', sql: /^COMMIT$/i }
const GENERATION_FENCE: SqlStep = {
  label: 'active generation fence',
  sql: /UPDATE "agent_workflow_meta"\."database_generations"/i,
  objects: [{ generation_id: 'dbg_rfc349_dual_provider_oracle' }],
}

type MaintenanceRow = Awaited<ReturnType<MaintenanceRunStore['read']>> & object

function maintenanceRow(input: {
  state: 'pending' | 'running' | 'succeeded'
  leaseToken?: string | null
  leaseExpiresAt?: number | null
  heartbeatAt?: number | null
  attempt?: number
  countersJson?: string
  updatedAt?: number
  startedAt?: number | null
  finishedAt?: number | null
}): MaintenanceRow {
  return {
    id: 'maintenance-run-1',
    jobKey: 'tokenAuditGc',
    jobClass: 'cleanup',
    slotKey: '2026-09-01T01',
    cycleKey: null,
    state: input.state,
    payloadJson: '{"retentionDays":90}',
    cursorVersion: 1,
    cursorJson: null,
    leaseToken: input.leaseToken ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    heartbeatAt: input.heartbeatAt ?? null,
    attempt: input.attempt ?? 0,
    sliceNo: input.state === 'succeeded' ? 1 : 0,
    countersJson: input.countersJson ?? '{}',
    errorCode: null,
    errorMessage: null,
    scheduledAt: 100,
    createdAt: 100,
    updatedAt: input.updatedAt ?? 100,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
  }
}

function maintenanceValues(row: MaintenanceRow): readonly unknown[] {
  return [
    row.id,
    row.jobKey,
    row.jobClass,
    row.slotKey,
    row.cycleKey,
    row.state,
    row.payloadJson,
    row.cursorVersion,
    row.cursorJson,
    row.leaseToken,
    row.leaseExpiresAt,
    row.heartbeatAt,
    row.attempt,
    row.sliceNo,
    row.countersJson,
    row.errorCode,
    row.errorMessage,
    row.scheduledAt,
    row.createdAt,
    row.updatedAt,
    row.startedAt,
    row.finishedAt,
  ]
}

function postgresqlMaintenanceStore(): Readonly<{
  store: MaintenanceRunStore
  assertExhausted: () => void
}> {
  const pending = maintenanceRow({ state: 'pending' })
  const running = maintenanceRow({
    state: 'running',
    leaseToken: 'lease-live',
    leaseExpiresAt: 250,
    heartbeatAt: 200,
    attempt: 1,
    updatedAt: 200,
    startedAt: 200,
  })
  const fixture = createScriptedPostgresqlFixture('maintenance', [
    BEGIN,
    {
      label: 'no queued run before enqueue',
      sql: /select .* from "agent_workflow"\."maintenance_runs"/is,
      values: [],
    },
    GENERATION_FENCE,
    {
      label: 'insert maintenance run',
      sql: /insert into "agent_workflow"\."maintenance_runs"/i,
      count: 1,
    },
    {
      label: 'read exact enqueued slot',
      sql: /select .* from "agent_workflow"\."maintenance_runs"/is,
      values: [maintenanceValues(pending)],
    },
    COMMIT,
    BEGIN,
    {
      label: 'dedupe queued maintenance run',
      sql: /select .* from "agent_workflow"\."maintenance_runs"/is,
      values: [maintenanceValues(pending)],
    },
    COMMIT,
    BEGIN,
    {
      label: 'claim candidate',
      sql: /select .* from "agent_workflow"\."maintenance_runs"/is,
      values: [maintenanceValues(pending)],
    },
    GENERATION_FENCE,
    {
      label: 'claim with lease',
      sql: /update "agent_workflow"\."maintenance_runs"/i,
      values: [maintenanceValues(running)],
    },
    COMMIT,
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'reject wrong heartbeat lease',
      sql: /update "agent_workflow"\."maintenance_runs"/i,
      values: [],
    },
    COMMIT,
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'accept live heartbeat lease',
      sql: /update "agent_workflow"\."maintenance_runs"/i,
      values: [['maintenance-run-1']],
    },
    COMMIT,
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'accept live settlement lease',
      sql: /update "agent_workflow"\."maintenance_runs"/i,
      values: [['maintenance-run-1']],
    },
    COMMIT,
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'reject stale settlement lease',
      sql: /update "agent_workflow"\."maintenance_runs"/i,
      values: [],
    },
    COMMIT,
  ])
  return {
    store: createPostgresqlMaintenanceRunStore(fixture.db),
    assertExhausted: fixture.assertExhausted,
  }
}

async function maintenanceTranscript(store: MaintenanceRunStore) {
  const input = {
    id: 'maintenance-run-1',
    jobKey: 'tokenAuditGc' as const,
    jobClass: 'cleanup' as const,
    slotKey: '2026-09-01T01',
    payload: { retentionDays: 90 },
    scheduledAt: 100,
    now: 100,
  }
  const inserted = await store.enqueue(input)
  const duplicate = await store.enqueue({ ...input, id: 'maintenance-run-duplicate', now: 101 })
  const claimed = await store.claimNext({ leaseToken: 'lease-live', now: 200, leaseMs: 50 })
  const wrongHeartbeat = await store.heartbeat({
    runId: input.id,
    leaseToken: 'lease-stale',
    now: 210,
    leaseMs: 50,
  })
  const liveHeartbeat = await store.heartbeat({
    runId: input.id,
    leaseToken: 'lease-live',
    now: 220,
    leaseMs: 50,
  })
  const liveSettlement = await store.settle({
    runId: input.id,
    leaseToken: 'lease-live',
    now: 230,
    outcome: 'succeeded',
    counters: { swept: 3 },
  })
  const staleSettlement = await store.settle({
    runId: input.id,
    leaseToken: 'lease-live',
    now: 231,
    outcome: 'failed',
  })
  return {
    idempotency: {
      inserted: { id: inserted.row.id, inserted: inserted.inserted, coalesced: inserted.coalesced },
      duplicate: {
        id: duplicate.row.id,
        inserted: duplicate.inserted,
        coalesced: duplicate.coalesced,
      },
    },
    leaseFence: {
      claim:
        claimed === null
          ? null
          : {
              id: claimed.row.id,
              state: claimed.row.state,
              attempt: claimed.row.attempt,
              leaseToken: claimed.leaseToken,
            },
      wrongHeartbeat,
      liveHeartbeat,
      liveSettlement,
      staleSettlement,
    },
  }
}

interface EventFixtureRow {
  readonly id: string
  readonly eventGroupId: string
  readonly eventGroupOrdinal: number
  readonly producer: 'collaboration'
  readonly family: 'review'
  readonly eventType: string
  readonly schemaVersion: number
  readonly aggregateKind: 'review-round'
  readonly aggregateId: string
  readonly aggregateSeq: number
  readonly operationRef: string
  readonly correlationRef: string | null
  readonly causationRef: string | null
  readonly occurredAt: number
  readonly payloadJson: string
  readonly payloadDigest: string
  readonly deliveryMode: 'dispatchable'
  readonly producerEpoch: number
  readonly createdAt: number
}

function eventFixture(ordinal: number): EventFixtureRow {
  const id = `committed-event-${ordinal}`
  const envelope: CommittedEventEnvelopeV1 = {
    eventId: id,
    eventGroupId: 'group:rfc349-oracle',
    eventGroupOrdinal: ordinal,
    type: 'fixture.changed.v1',
    schemaVersion: 1,
    producer: 'collaboration',
    family: 'review',
    aggregate: { kind: 'review-round', id: 'review-oracle', seq: ordinal + 1 },
    operationRef: `operation-${ordinal}`,
    correlationRef: null,
    causationRef: null,
    occurredAt: new Date(100 + ordinal).toISOString(),
    payload: { ordinal },
  }
  const payloadJson = canonicalJson(envelope)
  return {
    id,
    eventGroupId: envelope.eventGroupId,
    eventGroupOrdinal: ordinal,
    producer: 'collaboration',
    family: 'review',
    eventType: envelope.type,
    schemaVersion: 1,
    aggregateKind: 'review-round',
    aggregateId: 'review-oracle',
    aggregateSeq: ordinal + 1,
    operationRef: envelope.operationRef,
    correlationRef: null,
    causationRef: null,
    occurredAt: 100 + ordinal,
    payloadJson,
    payloadDigest: sha256Hex(payloadJson),
    deliveryMode: 'dispatchable',
    producerEpoch: 3,
    createdAt: 100 + ordinal,
  }
}

function eventValues(row: EventFixtureRow): readonly unknown[] {
  return [
    row.id,
    row.eventGroupId,
    row.eventGroupOrdinal,
    row.producer,
    row.family,
    row.eventType,
    row.schemaVersion,
    row.aggregateKind,
    row.aggregateId,
    row.aggregateSeq,
    row.operationRef,
    row.correlationRef,
    row.causationRef,
    row.occurredAt,
    row.payloadJson,
    row.payloadDigest,
    row.deliveryMode,
    row.producerEpoch,
    row.createdAt,
  ]
}

function seedSqliteCommittedEvents(db: DbClient, events: readonly EventFixtureRow[]): void {
  db.insert(committedEvents)
    .values([...events])
    .run()
  db.insert(committedEventDeliveries)
    .values({
      eventId: events[1]!.id,
      consumerId: 'consumer-oracle',
      deliveryClass: 'critical',
      state: 'dead-letter',
      attemptCount: 2,
      nextAttemptAt: 400,
      claimedBy: null,
      leaseEpoch: 4,
      claimExpiresAt: null,
      lastErrorCode: 'fixture-poison',
      lastErrorSummary: 'fixture poison',
      replayGeneration: 2,
      createdAt: 200,
      updatedAt: 400,
      acceptedAt: null,
      deadLetterAt: 400,
    })
    .run()
}

function postgresqlCommittedEventPersistence(events: readonly EventFixtureRow[]): Readonly<{
  persistence: CommittedEventDeliveryPersistencePort
  assertExhausted: () => void
}> {
  const fixture = createScriptedPostgresqlFixture('committed-events', [
    {
      label: 'ordered committed-event load',
      sql: /select .* from "agent_workflow"\."committed_events".*order by/is,
      values: events.map(eventValues),
    },
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'manual retry wins CAS',
      sql: /update "agent_workflow"\."committed_event_deliveries"/i,
      values: [[3, 500]],
    },
    COMMIT,
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'duplicate manual retry loses CAS',
      sql: /update "agent_workflow"\."committed_event_deliveries"/i,
      values: [],
    },
    COMMIT,
  ])
  return {
    persistence: createPostgresqlCommittedEventDeliveryPersistence(fixture.db),
    assertExhausted: fixture.assertExhausted,
  }
}

async function capturedError(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
    return 'no-error'
  } catch (error) {
    return error instanceof Error ? `${error.name}:${error.message}` : String(error)
  }
}

async function committedEventTranscript(
  persistence: CommittedEventDeliveryPersistencePort,
  events: readonly EventFixtureRow[],
) {
  const stored = await persistence.getStored([events[1]!.id, events[0]!.id])
  const retry = await persistence.retry({
    eventId: events[1]!.id,
    consumerId: 'consumer-oracle',
    observedLeaseEpoch: 4,
    observedUpdatedAt: 400,
    now: 500,
  })
  const staleRetry = await capturedError(
    async () =>
      await persistence.retry({
        eventId: events[1]!.id,
        consumerId: 'consumer-oracle',
        observedLeaseEpoch: 4,
        observedUpdatedAt: 400,
        now: 501,
      }),
  )
  return {
    committedEventOrdering: stored.map((entry: StoredCommittedEvent) => ({
      eventId: entry.envelope.eventId,
      eventGroupOrdinal: entry.envelope.eventGroupOrdinal,
      aggregateSeq: entry.envelope.aggregate.seq,
      payload: entry.envelope.payload,
    })),
    outboxCas: { retry, staleRetry },
  }
}

interface ApplyFixtureRow {
  readonly id: string
  readonly scope: string
  readonly key: string
  readonly actorUserId: string
  readonly state: 'applying' | 'committed'
  readonly preparedArtifactsJson: string
  readonly receiptJson: string | null
  readonly error: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function applyValues(row: ApplyFixtureRow): readonly unknown[] {
  return [
    row.id,
    row.scope,
    row.key,
    row.actorUserId,
    row.state,
    row.preparedArtifactsJson,
    row.receiptJson,
    row.error,
    row.createdAt,
    row.updatedAt,
  ]
}

const APPLY_ROWS: readonly ApplyFixtureRow[] = [
  {
    id: 'apply-committed',
    scope: 'package',
    key: 'committed',
    actorUserId: 'owner-oracle',
    state: 'committed',
    preparedArtifactsJson: '[]',
    receiptJson: '{"journalId":"apply-committed","applied":[]}',
    error: null,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'apply-stale',
    scope: 'package',
    key: 'stale',
    actorUserId: 'owner-oracle',
    state: 'applying',
    preparedArtifactsJson: '[]',
    receiptJson: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'apply-active',
    scope: 'package',
    key: 'active',
    actorUserId: 'owner-oracle',
    state: 'applying',
    preparedArtifactsJson: '[]',
    receiptJson: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
  },
]

function postgresqlApplyJournal(): Readonly<{
  journal: ReturnType<typeof createPostgresqlResourcePackageApplyJournalPort>
  assertExhausted: () => void
}> {
  const fixture = createScriptedPostgresqlFixture('apply-recovery', [
    {
      label: 'load apply journals',
      sql: /select .* from "agent_workflow"\."resource_bundle_applies"/is,
      values: APPLY_ROWS.map(applyValues),
    },
    BEGIN,
    GENERATION_FENCE,
    {
      label: 'settle stale apply by expected-state CAS',
      sql: /update "agent_workflow"\."resource_bundle_applies"/i,
      values: [['apply-stale']],
    },
    COMMIT,
  ])
  return {
    journal: createPostgresqlResourcePackageApplyJournalPort(fixture.db),
    assertExhausted: fixture.assertExhausted,
  }
}

function recoveryRecorder(log: string[]): ResourcePackageApplyArtifactRecoveryPort {
  return {
    async rollForward(row: ResourcePackageApplyJournalSnapshot) {
      log.push(`roll-forward:${row.id}`)
    },
    async compensate(row: ResourcePackageApplyJournalSnapshot) {
      log.push(`compensate:${row.id}`)
    },
  }
}

async function applyRecoveryTranscript(
  journal:
    | ReturnType<typeof createSqliteResourcePackageApplyJournalPort>
    | ReturnType<typeof createPostgresqlResourcePackageApplyJournalPort>,
) {
  const effects: string[] = []
  const command = createResourcePackageApplyMaintenanceCommand({
    journal,
    artifacts: recoveryRecorder(effects),
    now: () => 2_000_000,
  })
  const receipt = await command.converge({ activeApplyIds: ['apply-active'] })
  return { receipt, effects }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 AC-12 dual-provider behavior oracle', () => {
  test('SQLite and PostgreSQL deep-equal CAS, lease/fence, idempotency, outbox, ordering and apply recovery', async () => {
    const events = [eventFixture(0), eventFixture(1)] as const

    const sqliteMaintenanceDb = createInMemoryDb(MIGRATIONS)
    const sqliteEventsDb = createInMemoryDb(MIGRATIONS)
    const sqliteApplyDb = createInMemoryDb(MIGRATIONS)
    try {
      seedSqliteCommittedEvents(sqliteEventsDb, events)
      sqliteApplyDb
        .insert(resourceBundleApplies)
        .values([...APPLY_ROWS])
        .run()
      const sqlite = {
        maintenance: await maintenanceTranscript(
          createSqliteMaintenanceRunStore(sqliteMaintenanceDb),
        ),
        committedEvents: await committedEventTranscript(
          createSqliteCommittedEventDeliveryPersistence(sqliteEventsDb),
          events,
        ),
        applyRecovery: await applyRecoveryTranscript(
          createSqliteResourcePackageApplyJournalPort(sqliteApplyDb),
        ),
      }

      const postgresqlMaintenance = postgresqlMaintenanceStore()
      const postgresqlEvents = postgresqlCommittedEventPersistence(events)
      const postgresqlApply = postgresqlApplyJournal()
      const postgresql = {
        maintenance: await maintenanceTranscript(postgresqlMaintenance.store),
        committedEvents: await committedEventTranscript(postgresqlEvents.persistence, events),
        applyRecovery: await applyRecoveryTranscript(postgresqlApply.journal),
      }

      expect(postgresql).toEqual(sqlite)
      expect(
        postgresql.committedEvents.committedEventOrdering.map((event) => event.eventId),
      ).toEqual(['committed-event-0', 'committed-event-1'])
      expect(postgresql.maintenance.leaseFence).toEqual({
        claim: {
          id: 'maintenance-run-1',
          state: 'running',
          attempt: 1,
          leaseToken: 'lease-live',
        },
        wrongHeartbeat: false,
        liveHeartbeat: true,
        liveSettlement: true,
        staleSettlement: false,
      })
      expect(postgresql.applyRecovery).toEqual({
        receipt: { failed: 1, rolledForward: 1 },
        effects: ['roll-forward:apply-committed', 'compensate:apply-stale'],
      })
      postgresqlMaintenance.assertExhausted()
      postgresqlEvents.assertExhausted()
      postgresqlApply.assertExhausted()
    } finally {
      sqliteMaintenanceDb.$client.close()
      sqliteEventsDb.$client.close()
      sqliteApplyDb.$client.close()
    }
  })
})
