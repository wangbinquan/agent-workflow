import { index, integer, sqliteTable as physicalTable, text } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'
import { createNativeUsageTables } from './observationNative'

const table = providerAwareSqliteTable(physicalTable)

/** Original System jobs/turns are independent execution facts, with no synthetic Task rows. */
export const systemAgentObservationGroups = table('system_agent_observation_groups', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  originalId: text('original_id').notNull(),
  name: text('name').notNull(),
  parentTaskId: text('parent_task_id'),
  ownerUserId: text('owner_user_id'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  status: text('status').notNull(),
})

/** One actual spawned process/attempt, frozen before effect submission. No numeric authority. */
export const systemAgentObservationOwners = table(
  'system_agent_observation_owners',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => systemAgentObservationGroups.id, { onDelete: 'cascade' }),
    originalAttempt: text('original_attempt').notNull(),
    agentId: text('agent_id'),
    agentName: text('agent_name').notNull(),
    agentRevision: integer('agent_revision'),
    purpose: text('purpose').notNull(),
    runtime: text('runtime').notNull(),
    ownerNonce: text('owner_nonce').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    outcome: text('outcome'),
  },
  (t) => [index('system_observation_group_attempt_idx').on(t.groupId, t.id)],
)

/** Committed original numeric evidence; the existing unique usage ledger owns totals. */
export const systemAgentObservationSources = table(
  'system_agent_observation_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => systemAgentObservationGroups.id, { onDelete: 'cascade' }),
    nodeRunId: text('node_run_id')
      .notNull()
      .references(() => systemAgentObservationOwners.id, { onDelete: 'cascade' }),
    evidenceJson: text('evidence_json').notNull(),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    index('system_observation_pending_idx').on(t.pending, t.nodeRunId, t.id),
    index('system_observation_node_idx').on(t.nodeRunId, t.id),
  ],
)

export const systemAgentNativeUsage = createNativeUsageTables(
  systemAgentObservationGroups,
  'system_agent_native_usage',
  'system_native_usage',
)
