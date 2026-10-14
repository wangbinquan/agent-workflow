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

const table = providerAwareSqliteTable(physicalTable)

// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md §3) —
// owned by run-observability. One row per runtime child process, updated in
// place; statistics aggregate these rows on demand. Deliberately no FK to
// tasks: usage is an accounting fact that outlives a deleted task.
export const observationCalls = table(
  'observation_calls',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose', { enum: ['task', 'system'] }).notNull(),
    taskId: text('task_id'),
    nodeRunId: text('node_run_id'),
    systemKind: text('system_kind'),
    systemLabel: text('system_label'),
    ownerUserId: text('owner_user_id'),
    agentId: text('agent_id'),
    agentName: text('agent_name').notNull(),
    runtimeId: text('runtime_id'),
    runtimeName: text('runtime_name'),
    protocol: text('protocol').notNull(),
    status: text('status', {
      enum: ['running', 'done', 'failed', 'canceled', 'interrupted'],
    }).notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    usageState: text('usage_state', {
      enum: ['pending', 'partial', 'complete', 'none'],
    }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costNano: integer('cost_nano').notNull().default(0),
    costState: text('cost_state', { enum: ['none', 'priced', 'partial', 'unpriced'] }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('observation_calls_started_idx').on(t.startedAt),
    index('observation_calls_task_idx').on(t.taskId, t.startedAt),
    index('observation_calls_status_idx').on(t.status),
    check('observation_calls_purpose_ck', sql`${t.purpose} IN ('task','system')`),
    check(
      'observation_calls_status_ck',
      sql`${t.status} IN ('running','done','failed','canceled','interrupted')`,
    ),
    check(
      'observation_calls_usage_state_ck',
      sql`${t.usageState} IN ('pending','partial','complete','none')`,
    ),
    check(
      'observation_calls_cost_state_ck',
      sql`${t.costState} IN ('none','priced','partial','unpriced')`,
    ),
  ],
)

/** Usage of one call split by the model the runtime actually reported ('' = unattributed). */
export const observationCallModels = table(
  'observation_call_models',
  {
    callId: text('call_id')
      .notNull()
      .references(() => observationCalls.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    priceId: text('price_id'),
    /** null: unpriced. */
    costNano: integer('cost_nano'),
    costState: text('cost_state', { enum: ['none', 'priced', 'partial', 'unpriced'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.model] }),
    check(
      'observation_call_models_cost_state_ck',
      sql`${t.costState} IN ('none','priced','partial','unpriced')`,
    ),
  ],
)

/** Append-only CNY price versions per (runtime registration, actual model).
 * Rates are integer CNY micro-yuan per million tokens; NULL is unknown, never free. */
export const observationPrices = table(
  'observation_prices',
  {
    id: text('id').primaryKey(),
    runtimeId: text('runtime_id').notNull(),
    model: text('model').notNull(),
    inputMicro: integer('input_micro'),
    cacheReadMicro: integer('cache_read_micro'),
    cacheWriteMicro: integer('cache_write_micro'),
    outputMicro: integer('output_micro'),
    effectiveFrom: integer('effective_from').notNull(),
    createdAt: integer('created_at').notNull(),
    createdBy: text('created_by').notNull(),
    note: text('note').notNull().default(''),
  },
  (t) => [index('observation_prices_line_idx').on(t.runtimeId, t.model, t.createdAt)],
)
