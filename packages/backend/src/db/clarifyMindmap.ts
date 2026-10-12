// RFC-372 — collaboration-owned companion records. The existing round is still
// the human gate; these tables hold its content, history and immutable output.
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(sqliteTable)

export function createClarifyMindmapTables(
  tasks: { id: AnySQLiteColumn },
  rounds: { id: AnySQLiteColumn },
) {
  const clarifyMindmapSessions = table(
    'clarify_mindmap_sessions',
    {
      id: text('id').primaryKey(),
      taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      roundId: text('round_id')
        .notNull()
        .references(() => rounds.id, { onDelete: 'cascade' }),
      entryRef: text('entry_ref').notNull(),
      revision: integer('revision').notNull(),
      // Includes the frozen independent template requirements, their stable
      // bindings, scope and assessments. Node content has its own indexed rows.
      metadataJson: text('metadata_json').notNull(),
      sourceJson: text('source_json').notNull(),
      createdAt: integer('created_at').notNull(),
      updatedAt: integer('updated_at').notNull(),
    },
    (t) => [
      uniqueIndex('idx_mindmap_sessions_round').on(t.roundId),
      uniqueIndex('idx_mindmap_sessions_entry').on(t.taskId, t.entryRef),
    ],
  )
  const clarifyMindmapNodes = table(
    'clarify_mindmap_nodes',
    {
      id: text('id').primaryKey(),
      sessionId: text('session_id')
        .notNull()
        .references(() => clarifyMindmapSessions.id, { onDelete: 'cascade' }),
      parentId: text('parent_id'),
      order: integer('sort_order').notNull(),
      bodyJson: text('body_json').notNull(),
    },
    (t) => [index('idx_mindmap_nodes_parent').on(t.sessionId, t.parentId, t.order)],
  )
  const clarifyMindmapNodeRevisions = table(
    'clarify_mindmap_node_revisions',
    {
      nodeId: text('node_id')
        .notNull()
        .references(() => clarifyMindmapNodes.id, { onDelete: 'cascade' }),
      sessionRevision: integer('session_revision').notNull(),
      // Original human input, adopted content and confirmation are distinct
      // fields in this immutable record, never reconstructed from the live row.
      bodyJson: text('body_json').notNull(),
      actorId: text('actor_id'),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [primaryKey({ columns: [t.nodeId, t.sessionRevision] })],
  )
  const clarifyMindmapCommandReceipts = table(
    'clarify_mindmap_command_receipts',
    {
      sessionId: text('session_id')
        .notNull()
        .references(() => clarifyMindmapSessions.id, { onDelete: 'cascade' }),
      requestId: text('request_id').notNull(),
      requestDigest: text('request_digest').notNull(),
      commandJson: text('command_json').notNull(),
      resultJson: text('result_json').notNull(),
      // Metadata revisions retain scope and assessment history as well.
      metadataJson: text('metadata_json').notNull(),
      sessionRevision: integer('session_revision').notNull(),
      actorId: text('actor_id').notNull(),
      createdAt: integer('created_at').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.sessionId, t.requestId] }),
      index('idx_mindmap_receipts_history').on(t.sessionId, t.sessionRevision),
    ],
  )
  const clarifyMindmapSnapshots = table(
    'clarify_mindmap_snapshots',
    {
      id: text('id').primaryKey(),
      sessionId: text('session_id')
        .notNull()
        .references(() => clarifyMindmapSessions.id, { onDelete: 'cascade' }),
      revision: integer('revision').notNull(),
      digest: text('digest').notNull(),
      contentJson: text('content_json').notNull(),
      markdown: text('markdown').notNull(),
      planJson: text('plan_json').notNull(),
      createdAt: integer('created_at').notNull(),
      finalizedAt: integer('finalized_at'),
      finalizedBy: text('finalized_by'),
    },
    (t) => [index('idx_mindmap_snapshots_session').on(t.sessionId, t.revision)],
  )
  return {
    clarifyMindmapSessions,
    clarifyMindmapNodes,
    clarifyMindmapNodeRevisions,
    clarifyMindmapCommandReceipts,
    clarifyMindmapSnapshots,
  }
}
