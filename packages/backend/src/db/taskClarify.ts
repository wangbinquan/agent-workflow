// RFC-372: Task owns host identities and entering obligations; collaboration owns editable rounds.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(sqliteTable)
export function createTaskClarifyTables(
  tasks: { id: AnySQLiteColumn },
  runs: { id: AnySQLiteColumn },
) {
  const taskClarifyHostRuns = table(
    'task_clarify_host_runs',
    {
      nodeRunId: text('node_run_id')
        .primaryKey()
        .references(() => runs.id, { onDelete: 'cascade' }),
      taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      occurrenceRef: text('occurrence_ref').notNull(),
      slotKey: text('slot_key').notNull(),
      inheritedFromRunId: text('inherited_from_run_id'),
      shardInstanceRef: text('shard_instance_ref'),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [
      index('idx_task_clarify_host_occurrence').on(t.taskId, t.occurrenceRef),
      index('idx_task_clarify_host_slot').on(t.taskId, t.slotKey),
    ],
  )
  const taskClarifyChannels = table(
    'task_clarify_channels',
    {
      id: text('id').primaryKey(),
      taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      logicalKey: text('logical_key').notNull(),
      askingNodeId: text('asking_node_id').notNull(),
      clarifyNodeId: text('clarify_node_id').notNull(),
      bindingDigest: text('binding_digest').notNull(),
      hostJson: text('host_json').notNull(),
      headEntryRef: text('head_entry_ref'),
      entryRevision: integer('entry_revision').notNull().default(0),
      createdAt: integer('created_at').notNull(),
      updatedAt: integer('updated_at').notNull(),
    },
    (t) => [uniqueIndex('idx_task_clarify_channel_key').on(t.taskId, t.logicalKey)],
  )
  const taskClarifyEntries = table(
    'task_clarify_entries',
    {
      id: text('id').primaryKey(),
      channelId: text('channel_id')
        .notNull()
        .references(() => taskClarifyChannels.id, { onDelete: 'cascade' }),
      entryRevision: integer('entry_revision').notNull(),
      hostEntryKey: text('host_entry_key').notNull(),
      hostJson: text('host_json').notNull(),
      sourceAskingRunId: text('source_asking_run_id').notNull(),
      sourceContextDigest: text('source_context_digest').notNull(),
      sourceContextJson: text('source_context_json').notNull(),
      configSnapshotRef: text('config_snapshot_ref').notNull(),
      triggerJson: text('trigger_json').notNull(),
      requestId: text('request_id'),
      requestJson: text('request_json'),
      previousSnapshotId: text('previous_snapshot_id'),
      disposition: text('disposition', {
        enum: ['opening', 'open', 'completed', 'not_requested', 'superseded'],
      }).notNull(),
      roundId: text('round_id'),
      gateNodeRunId: text('gate_node_run_id'),
      snapshotId: text('snapshot_id'),
      completionOperationId: text('completion_operation_id'),
      deliveryJson: text('delivery_json'),
      createdAt: integer('created_at').notNull(),
      updatedAt: integer('updated_at').notNull(),
    },
    (t) => [
      uniqueIndex('idx_task_clarify_entry_request').on(t.channelId, t.requestId),
      uniqueIndex('idx_task_clarify_entry_round').on(t.roundId),
      index('idx_task_clarify_entry_source').on(t.sourceAskingRunId),
    ],
  )
  // Immutable consumer material versions are separate from editable design
  // content. Acceptance records the exact version; business success records
  // consumption later, never at design Finish or at runtime admission alone.
  const taskClarifyMaterials = table(
    'task_clarify_materials',
    {
      id: text('id').primaryKey(),
      taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      entryScopeRef: text('entry_scope_ref')
        .notNull()
        .references(() => taskClarifyEntries.id, { onDelete: 'cascade' }),
      consumerNodeId: text('consumer_node_id').notNull(),
      materialRevision: integer('material_revision').notNull(),
      planId: text('plan_id').notNull(),
      sourceContextDigest: text('source_context_digest').notNull(),
      snapshotSetDigest: text('snapshot_set_digest').notNull(),
      materialJson: text('material_json').notNull(),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [
      uniqueIndex('idx_task_clarify_material_version').on(
        t.entryScopeRef,
        t.consumerNodeId,
        t.materialRevision,
      ),
      index('idx_task_clarify_material_consumer').on(t.taskId, t.consumerNodeId),
    ],
  )
  const taskClarifyConsumptions = table(
    'task_clarify_consumptions',
    {
      nodeRunId: text('node_run_id')
        .primaryKey()
        .references(() => runs.id, { onDelete: 'cascade' }),
      taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      materialId: text('material_id')
        .notNull()
        .references(() => taskClarifyMaterials.id),
      acceptanceRef: text('acceptance_ref').notNull(),
      sourceContextDigest: text('source_context_digest').notNull(),
      snapshotSetDigest: text('snapshot_set_digest').notNull(),
      finalizedPromptDigest: text('finalized_prompt_digest').notNull(),
      acceptedAt: integer('accepted_at').notNull(),
      consumedAt: integer('consumed_at'),
    },
    (t) => [
      uniqueIndex('idx_task_clarify_consumption_acceptance').on(t.acceptanceRef),
      index('idx_task_clarify_consumption_material').on(t.materialId),
    ],
  )
  return {
    taskClarifyHostRuns,
    taskClarifyChannels,
    taskClarifyEntries,
    taskClarifyMaterials,
    taskClarifyConsumptions,
  }
}
