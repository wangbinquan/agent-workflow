import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable as physicalTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)
/** Each selected execution owner supplies its own actual cohort relation. */
export function createNativeUsageTables(
  taskTable: { readonly id: AnySQLiteColumn },
  prefix = 'task_execution_native_usage',
  indexPrefix = 'native_usage',
) {
  /** Original lease claim/rotation identity; these relations contain no numeric totals. */
  const nativeUsageRootHeads = table(prefix + '_root_heads', {
    invocationId: text('invocation_id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => taskTable.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id').notNull(),
    claimFence: text('claim_fence'),
    protocol: text('protocol').notNull(),
    nextOrdinal: text('next_ordinal').notNull(),
    firstRootSessionId: text('first_root_session_id').notNull(),
    lastRootSessionId: text('last_root_session_id').notNull(),
    digest: text('digest').notNull(),
  })
  const nativeUsageRootTransitions = table(
    prefix + '_root_transitions',
    {
      invocationId: text('invocation_id')
        .notNull()
        .references(() => nativeUsageRootHeads.invocationId, { onDelete: 'cascade' }),
      ordinalKey: text('ordinal_key').notNull(),
      rootSessionId: text('root_session_id').notNull(),
      document: text('document').notNull(),
      digest: text('digest').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.invocationId, t.ordinalKey] }),
      index(indexPrefix + '_root_identity_idx').on(t.invocationId, t.rootSessionId),
    ],
  )
  /** Original Task owner receipts and native evidence. Numeric authority remains the usage ledger. */
  const nativeUsagePreparations = table(
    prefix + '_preparations',
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
      index(indexPrefix + '_preparation_task_idx').on(t.taskId, t.invocationId),
      check(indexPrefix + '_preparation_state_ck', sql`${t.state} IN ('open','sealed')`),
    ],
  )
  /** Original owner source identity only, including a store first created after spawn. */
  const nativeUsageStoreBindings = table(prefix + '_store_bindings', {
    invocationId: text('invocation_id')
      .primaryKey()
      .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
    beforeOwnerReceiptId: text('before_owner_receipt_id').notNull(),
    sourceGeneration: text('source_generation').notNull(),
  })
  /** The original root source watermark is frozen only after the actual process finishes. */
  const nativeUsageRootSets = table(prefix + '_root_sets', {
    invocationId: text('invocation_id')
      .primaryKey()
      .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
    nextOrdinal: text('next_ordinal').notNull(),
    rootDigest: text('root_digest').notNull(),
    processWatermark: text('process_watermark').notNull(),
    observedAt: integer('observed_at').notNull(),
  })
  /** Original per-root qualification references; numbers remain exclusively in the usage ledger. */
  const nativeUsageRootResults = table(
    prefix + '_root_results',
    {
      invocationId: text('invocation_id')
        .notNull()
        .references(() => nativeUsagePreparations.invocationId, { onDelete: 'cascade' }),
      resultId: text('result_id').notNull(),
      rootSessionId: text('root_session_id').notNull(),
      document: text('document').notNull(),
    },
    (t) => [primaryKey({ columns: [t.invocationId, t.resultId, t.rootSessionId] })],
  )
  const nativeUsagePasses = table(
    prefix + '_passes',
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
      index(indexPrefix + '_pass_invocation_idx').on(t.invocationId, t.passId),
      check(
        indexPrefix + '_pass_state_ck',
        sql`${t.state} IN ('open','eof','interrupted','superseded')`,
      ),
    ],
  )
  const nativeUsagePassHeads = table(prefix + '_pass_heads', {
    key: text('key').primaryKey(),
    passId: text('pass_id')
      .notNull()
      .references(() => nativeUsagePasses.passId, { onDelete: 'cascade' }),
  })
  const nativeUsagePassPages = table(
    prefix + '_pass_pages',
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
    prefix + '_session_parents',
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
    prefix + '_step_members',
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
    prefix + '_emissions',
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
      index(indexPrefix + '_emission_source_idx').on(t.sourceRowId),
    ],
  )
  /** Allocation metadata only; observed and pending original revisions remain inputs to each CAS. */
  const nativeUsageRevisionHeads = table(
    prefix + '_revision_heads',
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
    nativeUsageRootHeads,
    nativeUsageRootTransitions,
    nativeUsageRootSets,
    nativeUsageRootResults,
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
