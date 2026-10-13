import {
  index,
  integer,
  primaryKey,
  uniqueIndex,
  sqliteTable as physicalTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'
const table = providerAwareSqliteTable(physicalTable)
/** Durable diagnostic history is separate from every numerical contribution and accepted tariff. */
export const observationAnomalyStates = table('observation_anomaly_states', {
  key: text('key').primaryKey(),
  taskId: text('task_id'),
  document: text('document').notNull(),
  sourceRevision: text('source_revision').notNull(),
})
export const observationAnomalyHistory = table(
  'observation_anomaly_history',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    taskId: text('task_id'),
    observedAt: integer('observed_at').notNull(),
    document: text('document').notNull(),
  },
  (t) => [index('observation_anomaly_task_time').on(t.taskId, t.observedAt, t.id)],
)
export const observationMaintenanceOperations = table(
  'observation_maintenance_operations',
  {
    id: text('id').primaryKey(),
    requestKey: text('request_key').notNull(),
    actorId: text('actor_id').notNull(),
    actorScope: text('actor_scope').notNull(),
    actorDocument: text('actor_document').notNull(),
    state: text('state').notNull(),
    sourceRevision: text('source_revision').notNull(),
    createdAt: integer('created_at').notNull(),
    document: text('document').notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: integer('lease_until').notNull().default(0),
  },
  (t) => [uniqueIndex('observation_maintenance_actor_request').on(t.actorId, t.requestKey)],
)
export const observationMaintenanceMembers = table(
  'observation_maintenance_members',
  {
    operationId: text('operation_id').notNull(),
    key: text('key').notNull(),
    document: text('document').notNull(),
    state: text('state').notNull().default('pending'),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.key] })],
)
export const observationInvocationPricePolicies = table('observation_invocation_price_policies', {
  invocationId: text('invocation_id').primaryKey(),
  operationId: text('operation_id').notNull(),
  confirmedAt: integer('confirmed_at').notNull(),
  document: text('document').notNull(),
})
export const observationInvocationPriceAudit = table(
  'observation_invocation_price_audit',
  {
    operationId: text('operation_id').notNull(),
    invocationId: text('invocation_id').notNull(),
    document: text('document').notNull(),
    fingerprint: text('fingerprint').notNull(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.invocationId] })],
)

export const observationInvocationPriceRecords = table(
  'observation_invocation_price_records',
  {
    invocationId: text('invocation_id').notNull(),
    sourceId: text('source_id').notNull(),
    recordId: text('record_id').notNull(),
    operationId: text('operation_id').notNull(),
    document: text('document').notNull(),
  },
  (t) => [primaryKey({ columns: [t.invocationId, t.sourceId, t.recordId] })],
)
