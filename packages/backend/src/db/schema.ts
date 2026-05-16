// Drizzle schema for agent-workflow.
// Mirrors design/design.md §3. Any change here requires:
//   1. `bun run drizzle-kit generate` to produce a new migration in db/migrations/
//   2. Updating the corresponding zod schemas in packages/shared/src/schemas/
//
// All `text` columns holding JSON are documented in comments; runtime parses with zod.

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// -----------------------------------------------------------------------------
// agents — DB is source of truth. Frontmatter fields are split into columns.
// -----------------------------------------------------------------------------
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull().unique(), // URL identifier (/agents/{name})
  description: text('description').notNull().default(''),
  outputs: text('outputs').notNull().default('[]'), // JSON string[] of port names
  readonly: integer('readonly', { mode: 'boolean' }).notNull().default(false),
  // RFC-014: agent-level switch. When true (default), an iterate review decision
  // on a node whose upstream agent declares ≥ 2 markdown[_file] outputs will
  // re-generate every markdown[_file] sibling port and cascade their sibling
  // reviews back into awaiting_review. Author opt-out by setting false.
  syncOutputsOnIterate: integer('sync_outputs_on_iterate', { mode: 'boolean' })
    .notNull()
    .default(true),
  model: text('model'), // nullable; falls back to settings.defaultModel
  variant: text('variant'),
  temperature: real('temperature'),
  permission: text('permission').notNull().default('{}'), // JSON: opencode permission schema
  steps: integer('steps'),
  maxSteps: integer('max_steps'),
  skills: text('skills').notNull().default('[]'), // JSON string[]
  // RFC-022: agent name list (JSON string[]) of agents this one transitively
  // requires. Closure (BFS) gets injected into the same opencode subprocess
  // via OPENCODE_CONFIG_CONTENT; every closure member's skills are unioned
  // and staged under OPENCODE_CONFIG_DIR/skills/. Default [] keeps legacy
  // agents at single-agent injection behavior.
  dependsOn: text('depends_on').notNull().default('[]'),
  frontmatterExtra: text('frontmatter_extra').notNull().default('{}'), // JSON for advanced fields
  bodyMd: text('body_md').notNull().default(''), // system prompt; may be empty
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// skill_sources — RFC-017. Parent directory whose direct child subdirectories
// (each containing a SKILL.md) get auto-imported into `skills` with
// sourceKind='external' + sourceId = this row's id. Reconciled lazily on
// daemon boot + each GET /api/skills.
// -----------------------------------------------------------------------------
export const skillSources = sqliteTable('skill_sources', {
  id: text('id').primaryKey(), // ULID
  path: text('path').notNull().unique(), // canonicalized absolute path (realpath)
  label: text('label').notNull(), // defaults to basename(path) at create time
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastScannedAt: integer('last_scanned_at'), // unix ms; null = never scanned
  lastScanError: text('last_scan_error'), // short error code OR summary of skipped reports
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// skills — fs is source of truth (~/.agent-workflow/skills/{name}/files/).
// DB stores only the index.
// -----------------------------------------------------------------------------
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    description: text('description').notNull().default(''),
    sourceKind: text('source_kind', { enum: ['managed', 'external'] }).notNull(),
    managedPath: text('managed_path'), // e.g. 'skills/{name}/files/' relative to app dir
    externalPath: text('external_path'), // absolute path
    // RFC-017: source-folder-derived rows tag the originating skill_sources row.
    // ON DELETE SET NULL is defensive; service layer deletes child skills first.
    sourceId: text('source_id').references(() => skillSources.id, { onDelete: 'set null' }),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sourceIdx: index('skills_source_id_idx').on(t.sourceId),
  }),
)

// -----------------------------------------------------------------------------
// workflows — DB is source of truth; YAML import/export is a transport, not source.
// -----------------------------------------------------------------------------
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(), // not unique; YAML import collisions resolved via dialog
  description: text('description').notNull().default(''),
  definition: text('definition').notNull(), // JSON: { $schema_version, nodes, edges, inputs, outputs }
  version: integer('version').notNull().default(1), // bumps on each PUT
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// recent_repos — cache of recently used repo paths for the launcher dropdown.
// -----------------------------------------------------------------------------
export const recentRepos = sqliteTable('recent_repos', {
  path: text('path').primaryKey(), // absolute repo path
  lastUsedAt: integer('last_used_at').notNull(),
  defaultBranch: text('default_branch'), // detected on last use
})

// -----------------------------------------------------------------------------
// tasks — one row per `POST /api/tasks`. Holds workflow snapshot for replay safety.
// -----------------------------------------------------------------------------
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(), // ULID
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    workflowSnapshot: text('workflow_snapshot').notNull(), // JSON: workflow definition at start time
    repoPath: text('repo_path').notNull(),
    worktreePath: text('worktree_path').notNull(),
    baseBranch: text('base_branch').notNull(),
    branch: text('branch').notNull(), // 'agent-workflow/{task-id}'
    baseCommit: text('base_commit'), // resolved commit SHA of base_branch at task start; basis for diff view
    status: text('status', {
      enum: [
        'pending',
        'running',
        'done',
        'failed',
        'canceled',
        'interrupted',
        'awaiting_review', // RFC-005
        'awaiting_human', // RFC-023
      ],
    }).notNull(),
    inputs: text('inputs').notNull(), // JSON: launcher form values
    // resource limits (copied from settings / workflow / launcher overrides at start time)
    maxDurationMs: integer('max_duration_ms'),
    maxTotalTokens: integer('max_total_tokens'),
    // timing
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    // failure diagnostics
    errorSummary: text('error_summary'),
    errorMessage: text('error_message'),
    failedNodeId: text('failed_node_id'),
    // optional expiry (soft delete after expires_at)
    expiresAt: integer('expires_at'),
    deletedAt: integer('deleted_at'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    statusIdx: index('idx_tasks_status').on(t.status, t.startedAt),
    workflowIdx: index('idx_tasks_workflow').on(t.workflowId, t.startedAt),
  }),
)

// -----------------------------------------------------------------------------
// node_runs — one row per execution of a node. Multi-process fan-out and loop
// iterations and retries each produce additional rows.
// -----------------------------------------------------------------------------
export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(), // node id within workflow definition
    parentNodeRunId: text('parent_node_run_id'), // multi-process fan-out parent / loop iteration parent
    iteration: integer('iteration').notNull().default(0), // loop iteration index
    shardKey: text('shard_key'), // multi-process shard identifier (e.g. file path)
    retryIndex: integer('retry_index').notNull().default(0), // 0 = first attempt
    /**
     * RFC-005: counts review-decision-triggered regenerations (reject/iterate);
     * orthogonal to retryIndex (technical retries from process crash / timeout).
     */
    reviewIteration: integer('review_iteration').notNull().default(0),
    /**
     * RFC-023: counts clarify-driven regenerations (agent asked + user
     * answered + agent re-spawned). Orthogonal to both retryIndex and
     * reviewIteration. For an agent-multi shard child node_run, the value
     * tracks that shard alone.
     */
    clarifyIteration: integer('clarify_iteration').notNull().default(0),
    status: text('status', {
      enum: [
        'pending',
        'running',
        'done',
        'failed',
        'canceled',
        'interrupted',
        'skipped',
        'exhausted',
        'awaiting_review', // RFC-005
        'awaiting_human', // RFC-023
      ],
    }).notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    pid: integer('pid'),
    exitCode: integer('exit_code'),
    errorMessage: text('error_message'),
    promptText: text('prompt_text'), // actual user prompt sent to opencode
    // token usage
    tokInput: integer('tok_input'),
    tokOutput: integer('tok_output'),
    tokCacheCreate: integer('tok_cache_create'),
    tokCacheRead: integer('tok_cache_read'),
    tokTotal: integer('tok_total'),
    // worktree snapshot (write nodes only) for retry rollback
    preSnapshot: text('pre_snapshot'),
  },
  (t) => ({
    taskIdx: index('idx_node_runs_task').on(t.taskId, t.nodeId, t.iteration, t.retryIndex),
    parentIdx: index('idx_node_runs_parent').on(t.parentNodeRunId),
  }),
)

// -----------------------------------------------------------------------------
// node_run_outputs — parsed <port name="..."> values from <workflow-output>.
// -----------------------------------------------------------------------------
export const nodeRunOutputs = sqliteTable(
  'node_run_outputs',
  {
    nodeRunId: text('node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    portName: text('port_name').notNull(),
    content: text('content').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nodeRunId, t.portName] }),
  }),
)

// -----------------------------------------------------------------------------
// node_run_events — opencode --format json event stream + stderr lines.
// id is auto-increment and serves as the WS reconnect since-id cursor.
// Hourly background task archives old rows to logs/{taskId}/{nodeRunId}.jsonl.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// doc_versions — RFC-005 review history.
//
// One row per (review node run, version_index). Each reject / iterate decision
// archives the current version and starts a new one. `body_path` points at a
// file under ~/.agent-workflow/runs/{taskId}/review/{nodeId}/{port}/v{n}.md;
// the DB stays small and the markdown stays grep-able / OS-backupable.
// -----------------------------------------------------------------------------
export const docVersions = sqliteTable(
  'doc_versions',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    reviewNodeId: text('review_node_id').notNull(), // workflow node id
    reviewNodeRunId: text('review_node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id').notNull(),
    sourcePortName: text('source_port_name').notNull(),
    versionIndex: integer('version_index').notNull(), // 1-based
    reviewIteration: integer('review_iteration').notNull(), // matches node_runs.review_iteration at archive
    bodyPath: text('body_path').notNull(), // relative to app home
    commentsJson: text('comments_json').notNull().default('[]'), // ReviewComment[] frozen at decision time
    decision: text('decision', {
      enum: ['pending', 'approved', 'rejected', 'iterated'],
    })
      .notNull()
      .default('pending'),
    decisionReason: text('decision_reason'),
    promptSnapshot: text('prompt_snapshot'), // user prompt sent when generating this version
    agentSnapshot: text('agent_snapshot'), // JSON: {model, variant, temperature}
    // Worktree-relative path captured at dispatch time when the upstream port
    // resolved as a markdown_file (or the forgiveness branch silently read a
    // .md file). Carried through into renderCommentsForPrompt so the iterate
    // re-run prompt cites which file the comments target. NULL when the
    // source was inline markdown / a non-file string.
    sourceFilePath: text('source_file_path'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'), // v1 always 'local'; reserved
  },
  (t) => ({
    reviewIdx: index('idx_doc_versions_review_run').on(t.reviewNodeRunId, t.versionIndex),
    taskIdx: index('idx_doc_versions_task').on(t.taskId),
  }),
)

// -----------------------------------------------------------------------------
// review_comments — RFC-005 evidence pinned to a doc_version.
//
// Composite anchor (section path + paragraph idx + char offsets + selectedText
// + before/after context + occurrence_index) makes the comment unambiguous
// even when the same text appears multiple times. occurrence_index is
// recomputed server-side from the doc body to defeat client-side forgery
// (RFC-005-T10).
// -----------------------------------------------------------------------------
export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    docVersionId: text('doc_version_id')
      .notNull()
      .references(() => docVersions.id, { onDelete: 'cascade' }),
    anchorSectionPath: text('anchor_section_path').notNull(),
    anchorParagraphIdx: integer('anchor_paragraph_idx').notNull(),
    anchorOffsetStart: integer('anchor_offset_start').notNull(),
    anchorOffsetEnd: integer('anchor_offset_end').notNull(),
    selectedText: text('selected_text').notNull(),
    contextBefore: text('context_before').notNull(),
    contextAfter: text('context_after').notNull(),
    occurrenceIndex: integer('occurrence_index').notNull(),
    commentText: text('comment_text').notNull(),
    author: text('author').notNull().default('local'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    versionIdx: index('idx_review_comments_version').on(t.docVersionId, t.anchorSectionPath),
  }),
)

export const nodeRunEvents = sqliteTable(
  'node_run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nodeRunId: text('node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    kind: text('kind', {
      enum: [
        'tool_use',
        'text',
        'reasoning',
        'permission_asked',
        'error',
        'step_start',
        'step_finish',
        'stderr',
      ],
    }).notNull(),
    payload: text('payload').notNull(), // raw JSON line / stderr line
  },
  (t) => ({
    nodeIdx: index('idx_events_node').on(t.nodeRunId, t.id),
  }),
)

// -----------------------------------------------------------------------------
// clarify_sessions — RFC-023. One row per agent reply that contained a
// <workflow-clarify> envelope. The clarify node's node_run sits in
// 'awaiting_human' until the user submits answers via the REST API; the
// runtime then mints a fresh source-agent node_run (clarify_iteration + 1)
// and the asking agent runs again with the answers injected.
//
// For agent-multi: each reaching shard mints its OWN clarify node_run row
// + its own clarify_session, keyed by (clarify_node_id, source_shard_key).
// -----------------------------------------------------------------------------
export const clarifySessions = sqliteTable(
  'clarify_sessions',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sourceAgentNodeId: text('source_agent_node_id').notNull(),
    // For agent-multi this is the shard child node_run id (one per shard);
    // for agent-single it is the single asking node_run id.
    sourceAgentNodeRunId: text('source_agent_node_run_id').notNull(),
    sourceShardKey: text('source_shard_key'), // NULL for agent-single
    clarifyNodeId: text('clarify_node_id').notNull(),
    clarifyNodeRunId: text('clarify_node_run_id').notNull(),
    // matches the source agent node_run's clarify_iteration AT TIME OF ASKING
    iterationIndex: integer('iteration_index').notNull(),
    questionsJson: text('questions_json').notNull(), // ClarifyQuestion[]
    answersJson: text('answers_json'), // ClarifyAnswer[]; NULL until submitted
    status: text('status', {
      enum: ['awaiting_human', 'answered', 'canceled'],
    })
      .notNull()
      .default('awaiting_human'),
    truncationWarningsJson: text('truncation_warnings_json'), // JSON: { code, detail }[]
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    answeredAt: integer('answered_at'),
    answeredBy: text('answered_by'),
  },
  (t) => ({
    taskIdx: index('idx_clarify_sessions_task').on(t.taskId),
    clarifyRunIdx: index('idx_clarify_sessions_clarify_run').on(
      t.clarifyNodeRunId,
      t.iterationIndex,
    ),
    sourceRunIdx: index('idx_clarify_sessions_source_run').on(t.sourceAgentNodeRunId),
    nodeShardIdx: index('idx_clarify_sessions_node_shard').on(t.clarifyNodeId, t.sourceShardKey),
  }),
)
