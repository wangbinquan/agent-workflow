import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable as physicalTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'
import type { tasks } from './schema'

const table = providerAwareSqliteTable(physicalTable)
/** The original schema root supplies its actual Task table; this leaf has no runtime back edge. */
export function createNativeUsageTables(taskTable: typeof tasks) {
  /** Original Task owner receipts and native evidence. Numeric authority remains the usage ledger. */
  const nativeUsagePreparations = table(
    'task_execution_native_usage_preparations',
    {
      invocationId: text('invocation_id').primaryKey(),
      taskId: text('task_id')
        .notNull()
        .references(() => taskTable.id, { onDelete: 'cascade' }),
      nodeRunId: text('node_run_id').notNull(),
      ownerReceiptId: text('owner_receipt_id').notNull(),
      fence: text('fence').notNull(),
      document: text('document').notNull(),
      state: text('state', { enum: ['open', 'sealed'] }).notNull(),
    },
    (t) => [
      index('native_usage_preparation_task_idx').on(t.taskId, t.invocationId),
      check('native_usage_preparation_state_ck', sql`${t.state} IN ('open','sealed')`),
    ],
  )
  /** Original owner source identity only, including a store first created after spawn. */
  const nativeUsageStoreBindings = table('task_execution_native_usage_store_bindings', {
    invocationId: text('invocation_id')
      .primaryKey()
      .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
    beforeOwnerReceiptId: text('before_owner_receipt_id').notNull(),
    sourceGeneration: text('source_generation').notNull(),
  })
  const nativeUsagePasses = table(
    'task_execution_native_usage_passes',
    {
      passId: text('pass_id').primaryKey(),
      invocationId: text('invocation_id')
        .notNull()
        .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
      headKey: text('head_key').notNull(),
      ownerReceiptId: text('owner_receipt_id').notNull(),
      identity: text('identity').notNull(),
      initialCursor: text('initial_cursor').notNull(),
      admission: text('admission').notNull(),
      rootCreatedAt: integer('root_created_at'),
      state: text('state', { enum: ['open', 'eof', 'interrupted', 'superseded'] }).notNull(),
      nextOrdinal: text('next_ordinal').notNull(),
      nextCursor: text('next_cursor'),
      digest: text('digest').notNull(),
      position: text('position').notNull(),
      counts: text('counts').notNull(),
      lastAck: text('last_ack'),
      interruption: text('interruption'),
    },
    (t) => [
      index('native_usage_pass_invocation_idx').on(t.invocationId, t.passId),
      check(
        'native_usage_pass_state_ck',
        sql`${t.state} IN ('open','eof','interrupted','superseded')`,
      ),
    ],
  )
  const nativeUsagePassHeads = table('task_execution_native_usage_pass_heads', {
    key: text('key').primaryKey(),
    passId: text('pass_id')
      .notNull()
      .references(() => nativeUsagePasses.passId, { onDelete: 'cascade' }),
  })
  const nativeUsagePassPages = table(
    'task_execution_native_usage_pass_pages',
    {
      passId: text('pass_id')
        .notNull()
        .references(() => nativeUsagePasses.passId, { onDelete: 'cascade' }),
      ordinal: text('ordinal').notNull(),
      payloadDigest: text('payload_digest').notNull(),
      cumulativeDigest: text('cumulative_digest').notNull(),
      document: text('document').notNull(),
      ack: text('ack').notNull(),
    },
    (t) => [primaryKey({ columns: [t.passId, t.ordinal] })],
  )
  const nativeUsageSessionParents = table(
    'task_execution_native_usage_session_parents',
    {
      passId: text('pass_id')
        .notNull()
        .references(() => nativeUsagePasses.passId, { onDelete: 'cascade' }),
      sessionId: text('session_id').notNull(),
      parentSessionId: text('parent_session_id'),
      ordinal: text('ordinal').notNull(),
      pathDigest: text('path_digest').notNull(),
      depth: text('depth').notNull(),
    },
    (t) => [primaryKey({ columns: [t.passId, t.sessionId] })],
  )
  const nativeUsageStepMembers = table(
    'task_execution_native_usage_step_members',
    {
      passId: text('pass_id')
        .notNull()
        .references(() => nativeUsagePasses.passId, { onDelete: 'cascade' }),
      stepId: text('step_id').notNull(),
      sessionId: text('session_id').notNull(),
      ordinal: text('ordinal').notNull(),
      document: text('document').notNull(),
    },
    (t) => [primaryKey({ columns: [t.passId, t.stepId] })],
  )
  /** Frozen mappings to the original source rows; these never contribute separate Token totals. */
  const nativeUsageEmissions = table(
    'task_execution_native_usage_emissions',
    {
      invocationId: text('invocation_id')
        .notNull()
        .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
      eventId: text('event_id').notNull(),
      fingerprint: text('fingerprint').notNull(),
      sourceRowId: integer('source_row_id').notNull(),
      document: text('document').notNull(),
      ack: text('ack').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.invocationId, t.eventId] }),
      index('native_usage_emission_source_idx').on(t.sourceRowId),
    ],
  )
  /** Allocation metadata only; observed and pending original revisions remain inputs to each CAS. */
  const nativeUsageRevisionHeads = table(
    'task_execution_native_usage_revision_heads',
    {
      invocationId: text('invocation_id')
        .notNull()
        .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
      recordId: text('record_id').notNull(),
      revision: integer('revision').notNull(),
    },
    (t) => [primaryKey({ columns: [t.invocationId, t.recordId] })],
  )
  return {
    nativeUsagePreparations,
    nativeUsageStoreBindings,
    nativeUsagePasses,
    nativeUsagePassHeads,
    nativeUsagePassPages,
    nativeUsageSessionParents,
    nativeUsageStepMembers,
    nativeUsageEmissions,
    nativeUsageRevisionHeads,
  }
}
