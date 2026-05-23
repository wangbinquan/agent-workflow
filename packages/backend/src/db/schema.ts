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
  // RFC-028: agent name list (JSON string[]) of MCP server names this agent
  // needs at runtime. Runner unions every dependsOn closure member's mcp[] and
  // injects each as an entry under `mcp` in OPENCODE_CONFIG_CONTENT. Default
  // [] keeps legacy agents on the inherited-only baseline (repo
  // .opencode/opencode.json + ~/.config/opencode/ still loads naturally).
  mcp: text('mcp').notNull().default('[]'),
  // RFC-031: opencode plugin name list (JSON string[]) referenced by this
  // agent. Runner unions every dependsOn closure member's plugins[] and
  // injects each as `file://<cachedPath>` (or `[file://..., options]` tuple)
  // under `plugin` in OPENCODE_CONFIG_CONTENT. Default [] keeps legacy agents
  // on the inherited-only baseline (repo .opencode/opencode.json plugins
  // continue to load naturally).
  plugins: text('plugins').notNull().default('[]'),
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
// mcps — RFC-028. DB is source of truth. Agents reference these by name via
// agents.mcp (JSON string[]); runner unions the dependsOn closure's mcp names,
// loads the rows here, and injects them into `OPENCODE_CONFIG_CONTENT.mcp` for
// the spawned opencode process. See OPENCODE_CONFIG.md §1 and §3.3 for the
// field-name translation (env→environment, timeoutMs→timeout) and §3.3 for
// why `config.command[0]` is the executable (no `cwd` field — opencode uses
// the process directory = worktree).
// -----------------------------------------------------------------------------
export const mcps = sqliteTable('mcps', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  /** 'local' (stdio) | 'remote' (http/sse). Matches opencode McpLocalConfig/McpRemoteConfig. */
  type: text('type', { enum: ['local', 'remote'] }).notNull(),
  /**
   * Type-specific config serialised as JSON.
   *   local : { command: string[], env?, timeoutMs? }
   *   remote: { url: string, headers?, oauth?, timeoutMs? }
   */
  config: text('config').notNull().default('{}'),
  /** Per-server toggle (matches opencode `mcp.<name>.enabled`). */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// plugins — RFC-031. DB is source of truth for opencode plugin records. The
// installer materialises every record to ~/.agent-workflow/plugins/{id}/ at
// save time (npm install --prefix, or realpath for file: spec), and the
// runner injects `file://<cached_path>` (plus options when non-empty) into
// `OPENCODE_CONFIG_CONTENT.plugin` — opencode then loads via
// resolvePathPluginTarget without hitting the network. Agents reference these
// by name via agents.plugins (JSON string[]).
// -----------------------------------------------------------------------------
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull().unique(), // /api/plugins/:id identifier; also frontmatter ref
  /** User-supplied spec (npm specifier / file URL / path / git URL / github shorthand). */
  spec: text('spec').notNull(),
  /** opencode plugin options bag, JSON record; emitted as the tuple second element when non-empty. */
  optionsJson: text('options_json').notNull().default('{}'),
  description: text('description').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Derived from spec by the installer: 'npm' | 'file' | 'git'. */
  sourceKind: text('source_kind', { enum: ['npm', 'file', 'git'] }).notNull(),
  /** Absolute filesystem path to the resolved plugin entry. Injected as file://<this> at run time. */
  cachedPath: text('cached_path').notNull(),
  /** npm: package.json.version; git: commit short sha; file: mtime hash. Nullable on partial install. */
  resolvedVersion: text('resolved_version'),
  installedAt: integer('installed_at').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// mcp_probes — RFC-030. One row per MCP, holding the most-recent probe result.
// UNIQUE(mcp_id) + ON DELETE CASCADE means deleting the parent mcp drops the
// probe automatically; UPSERT-on-probe keeps a single row per MCP. We do *not*
// keep history here (out of scope, see RFC-030 §3). All large fields are JSON
// strings (tools / resources / etc.); parsed via the zod schemas in
// `@agent-workflow/shared` mcpProbe.ts when materialised for the API.
// -----------------------------------------------------------------------------
export const mcpProbes = sqliteTable('mcp_probes', {
  id: text('id').primaryKey(), // ULID
  mcpId: text('mcp_id')
    .notNull()
    .unique()
    .references(() => mcps.id, { onDelete: 'cascade' }),
  /** 'ok' | 'error'. 'partial' lists go under errorCode while keeping status='ok'. */
  status: text('status', { enum: ['ok', 'error'] }).notNull(),
  /** Wall-clock probe latency (connect → all-lists-done or fail). */
  latencyMs: integer('latency_ms').notNull(),
  /** Connect + `initialize` latency only. Null when transport never came up. */
  handshakeMs: integer('handshake_ms'),
  /** Raw {name, version?} from initialize response. */
  serverInfoJson: text('server_info_json'),
  protocolVersion: text('protocol_version'),
  /** Raw capabilities map (opencode-style). */
  capabilitiesJson: text('capabilities_json'),
  /** Array<{name,title?,description?,inputSchema?}> JSON. Null on list failure. */
  toolsJson: text('tools_json'),
  /** Array<{uri,name?,description?,mimeType?}>. */
  resourcesJson: text('resources_json'),
  /** Array<{uriTemplate,name?,description?,mimeType?}>. */
  resourceTemplatesJson: text('resource_templates_json'),
  /** Array<{name,description?,arguments?[]}>. */
  promptsJson: text('prompts_json'),
  /** One of the codes from McpProbeErrorCode (see shared/mcpProbe.ts). */
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  /** {stderr?, httpStatus?, partialFailures?: [{method,message}]} — redacted. */
  errorDetailJson: text('error_detail_json'),
  schemaVersion: integer('schema_version').notNull().default(1),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at').notNull(),
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
// RFC-024: cached_repos — persistent mirror of remote Git URLs the user has
// launched tasks against. Lives at `~/.agent-workflow/repos/{slug}` on disk;
// this table tracks provenance + lookup index. Distinct from `recent_repos`,
// which records local absolute paths only.
// -----------------------------------------------------------------------------
export const cachedRepos = sqliteTable(
  'cached_repos',
  {
    id: text('id').primaryKey(), // ULID
    urlHash: text('url_hash').notNull().unique(), // 8-hex sha1 of canonical URL
    url: text('url').notNull(), // original URL as supplied (may contain creds — redact in UI)
    localPath: text('local_path').notNull(), // absolute path under ~/.agent-workflow/repos/
    defaultBranch: text('default_branch'), // nullable; null when HEAD was detached / unborn
    lastFetchedAt: integer('last_fetched_at').notNull(),
    createdAt: integer('created_at').notNull(),
    // RFC-034: submodule recursion telemetry. All three are nullable so legacy
    // pre-RFC-034 rows serialize cleanly until the next clone / refresh fills them.
    hasSubmodules: integer('has_submodules', { mode: 'boolean' }),
    lastSubmoduleSyncOk: integer('last_submodule_sync_ok', { mode: 'boolean' }),
    lastSubmoduleSyncError: text('last_submodule_sync_error'),
  },
  (t) => ({
    lastFetchedIdx: index('idx_cached_repos_last_fetched').on(t.lastFetchedAt),
  }),
)

// -----------------------------------------------------------------------------
// tasks — one row per `POST /api/tasks`. Holds workflow snapshot for replay safety.
// -----------------------------------------------------------------------------
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(), // ULID
    // RFC-037: user-supplied display name captured at launch time. Required
    // (StartTaskSchema enforces 1..255 trim before INSERT). Migration 0021
    // backfilled historical rows from workflows.name or "task-{shortId}".
    name: text('name').notNull(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    workflowSnapshot: text('workflow_snapshot').notNull(), // JSON: workflow definition at start time
    repoPath: text('repo_path').notNull(),
    // RFC-024: original Git URL when launched from a remote URL. NULL for path-mode
    // tasks. May contain credentials; render via redactGitUrl before display.
    repoUrl: text('repo_url'),
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
    // RFC-036: launcher actor for visibility filtering. NULL = legacy task
    // launched before RFC-036 or by daemon-token (system) actor; admins still
    // see those via scope=all, regular users do not.
    ownerUserId: text('owner_user_id'),
  },
  (t) => ({
    statusIdx: index('idx_tasks_status').on(t.status, t.startedAt),
    workflowIdx: index('idx_tasks_workflow').on(t.workflowId, t.startedAt),
    ownerIdx: index('idx_tasks_owner').on(t.ownerUserId),
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
    /**
     * RFC-056: counts cross-clarify-driven regenerations on the DESIGNER
     * side (downstream questioner agent emitted a `<workflow-clarify>` via
     * a clarify-cross-agent node + human submitted answers → designer is
     * rerun once per multi-source batch). Orthogonal to retryIndex,
     * reviewIteration, AND clarifyIteration — a designer that ALSO has its
     * own RFC-023 self-clarify channel sees two independent counters.
     *
     * For the questioner side, clarifyIteration continues to be the active
     * counter (the questioner IS asking back). For nodes that never act as
     * designer in a cross-clarify cycle the column stays at its default 0.
     */
    crossClarifyIteration: integer('cross_clarify_iteration').notNull().default(0),
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
    /**
     * RFC-026: opencode session id captured from the JSON event stream of
     * this run. NULL when the run was canceled / failed before opencode
     * emitted any session event, or for non-agent runs (clarify / review /
     * input / output / wrapper) that never spawn opencode. Read by the
     * scheduler ONLY on the clarify-driven rerun path when the upstream
     * clarify node has `sessionMode: 'inline'` — that path passes the id
     * to runner.ts which appends `--session <id>` to the opencode CLI so
     * the prior session's full transcript is resumed.
     */
    opencodeSessionId: text('opencode_session_id'),
    /**
     * RFC-029: serialized `InventorySnapshot` (shared/inventory.ts) — what the
     * opencode child process actually loaded (agents / skills / mcps /
     * plugins) at boot. Populated by runner.ts after `child.exited` by reading
     * the file written by the framework-injected `aw-inventory-dump` plugin.
     * NULL for legacy rows and for non-agent-kind runs (input / output /
     * wrapper / review / clarify); a captured:false stub with a `reason` code
     * is stored when the file was missing / unreadable / malformed so the UI
     * can show a precise "why no inventory" instead of a blank.
     */
    inventorySnapshotJson: text('inventory_snapshot_json'),
    /**
     * RFC-040: serialized `WrapperProgress` (services/wrapperProgress.ts)
     * used by wrapper-loop / wrapper-git to resume from the iteration /
     * baseline where they parked when an inner node entered awaiting_human
     * / awaiting_review. NULL for non-wrapper runs and for wrapper runs
     * that never parked (single-shot init → done in one call). Read by
     * `runLoopWrapperNode` / `runGitWrapperNode` on resume, never read by
     * the frontend.
     */
    wrapperProgressJson: text('wrapper_progress_json'),
    /**
     * RFC-046: post-budget-clip snapshot of approved memories injected into
     * this agent run's inline prompt (rendered into the `## Learned context`
     * block by `formatMemoryBlock` — see services/memoryInject.ts).
     * Serialized as `InjectedMemorySnapshot[]` (shared/schemas/memory.ts).
     * NULL when the run pre-dates RFC-046, when the run kind is non-agent
     * (input/output/wrapper/review/clarify never call inject), or when
     * inject resolved to zero memories (block was null — prompt stayed
     * byte-for-byte identical to the pre-RFC-041 path). For envelope-followup
     * retries (RFC-042) the runner copies the value from the retry_index=0
     * sibling row at write time.
     */
    injectedMemoriesJson: text('injected_memories_json'),
    /**
     * RFC-049: JSON array of structured port-validation failures for this
     * attempt. Each entry is `{ port, kind, subReason, detail? }` — runner
     * writes the payload when envelope.ts throws PortValidationError so the
     * scheduler can route same-session follow-up to the owning kind's
     * handler (and the per-port repair text knows which port to name)
     * without re-parsing errorMessage. NULL for successful runs, runs that
     * failed for any non-port-validation reason, and pre-RFC-049 rows.
     */
    portValidationFailuresJson: text('port_validation_failures_json'),
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
        // RFC-027: synthetic marker written by sessionCapture when the
        // post-run opencode SQLite read fails. Frontend treats it as a
        // captureComplete=false signal for the affected child session.
        'subagent_capture_failed',
      ],
    }).notNull(),
    payload: text('payload').notNull(), // raw JSON line / stderr line
    // RFC-027: nullable so pre-migration rows + stdout lines that never
    // saw an opencode sessionID stay valid. sessionCapture / runner fill
    // these to enable the SessionTree parser to bucket events by session.
    sessionId: text('session_id'),
    parentSessionId: text('parent_session_id'),
  },
  (t) => ({
    nodeIdx: index('idx_events_node').on(t.nodeRunId, t.id),
    sessionIdx: index('idx_events_session').on(t.nodeRunId, t.sessionId, t.id),
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
// -----------------------------------------------------------------------------
// RFC-023 clarify_sessions — RETAINED through RFC-058 staged refactor.
// Migration 0031 builds `clarify_rounds` and copies rows over; this table
// stays live until services migrate (then migration 0032 drops it).
// -----------------------------------------------------------------------------
export const clarifySessions = sqliteTable(
  'clarify_sessions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sourceAgentNodeId: text('source_agent_node_id').notNull(),
    sourceAgentNodeRunId: text('source_agent_node_run_id').notNull(),
    sourceShardKey: text('source_shard_key'),
    clarifyNodeId: text('clarify_node_id').notNull(),
    clarifyNodeRunId: text('clarify_node_run_id').notNull(),
    iterationIndex: integer('iteration_index').notNull(),
    questionsJson: text('questions_json').notNull(),
    answersJson: text('answers_json'),
    status: text('status', {
      enum: ['awaiting_human', 'answered', 'canceled'],
    })
      .notNull()
      .default('awaiting_human'),
    truncationWarningsJson: text('truncation_warnings_json'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    answeredAt: integer('answered_at'),
    answeredBy: text('answered_by'),
    directive: text('directive', { enum: ['continue', 'stop'] }),
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

// -----------------------------------------------------------------------------
// RFC-056 cross_clarify_sessions — RETAINED through RFC-058 staged refactor
// (see clarifySessions comment above).
// -----------------------------------------------------------------------------
export const crossClarifySessions = sqliteTable(
  'cross_clarify_sessions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    crossClarifyNodeId: text('cross_clarify_node_id').notNull(),
    crossClarifyNodeRunId: text('cross_clarify_node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    sourceQuestionerNodeId: text('source_questioner_node_id').notNull(),
    sourceQuestionerNodeRunId: text('source_questioner_node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    targetDesignerNodeId: text('target_designer_node_id'),
    loopIter: integer('loop_iter').notNull().default(0),
    iteration: integer('iteration').notNull().default(0),
    questionsJson: text('questions_json').notNull(),
    answersJson: text('answers_json'),
    directive: text('directive', { enum: ['continue', 'stop'] }),
    status: text('status', {
      enum: ['awaiting_human', 'answered', 'abandoned'],
    })
      .notNull()
      .default('awaiting_human'),
    designerRunTriggeredAt: integer('designer_run_triggered_at'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    answeredAt: integer('answered_at'),
    abandonedAt: integer('abandoned_at'),
    // RFC-059: JSON object `Record<questionId, 'designer'|'questioner'>`.
    // NULL when (a) row predates RFC-059 / (b) client did not send
    // questionScopes on submit. Runtime treats NULL as "every question is
    // 'designer'" via `resolveQuestionScope` (preserves RFC-056/058 behavior).
    // Dual-write target: mirrors `clarifyRounds.questionScopesJson`.
    questionScopesJson: text('question_scopes_json'),
  },
  (t) => ({
    taskIdx: index('idx_cross_clarify_sessions_task').on(t.taskId),
    nodeIdx: index('idx_cross_clarify_sessions_node').on(
      t.crossClarifyNodeId,
      t.loopIter,
      t.iteration,
    ),
    designerIdx: index('idx_cross_clarify_sessions_designer').on(t.targetDesignerNodeId, t.status),
    statusIdx: index('idx_cross_clarify_sessions_status').on(t.status),
  }),
)

// -----------------------------------------------------------------------------
// RFC-058 clarify_rounds — unified replacement for clarify_sessions (RFC-023)
// and cross_clarify_sessions (RFC-056). The `kind` discriminator decides
// which lifecycle the row participates in:
//   - kind='self'  → RFC-023 self-clarify. asking agent IS the consumer.
//                     target_consumer_node_id is NULL; loop_iter is 0.
//                     status enum reaches {'awaiting_human','answered',
//                     'canceled'}; CR-1 abandoned is unreachable.
//   - kind='cross' → RFC-056 cross-clarify. asking = questioner;
//                     target_consumer_node_id = designer node. loop_iter
//                     captures wrapper-loop placement. status reaches
//                     {'awaiting_human','answered','abandoned'}; canceled
//                     is unreachable.
// DB CHECK constraint enforces the cross-domain (kind × status) rule so
// application code does not need to re-validate that pairing on every write.
// -----------------------------------------------------------------------------
export const clarifyRounds = sqliteTable(
  'clarify_rounds',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['self', 'cross'] }).notNull(),
    // For kind='self' agent-multi this is the shard child node_run id;
    // for kind='cross' this is the questioner's node_run id.
    askingNodeId: text('asking_node_id').notNull(),
    askingNodeRunId: text('asking_node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    // NULL for agent-single + always NULL for kind='cross' (RFC-056 v1).
    askingShardKey: text('asking_shard_key'),
    // The clarify / clarify-cross-agent node id (human-gated form node).
    intermediaryNodeId: text('intermediary_node_id').notNull(),
    intermediaryNodeRunId: text('intermediary_node_run_id')
      .notNull()
      .references(() => nodeRuns.id, { onDelete: 'cascade' }),
    // Designer node id receiving External Feedback. NULL when kind='self'
    // (the asking agent itself is the consumer) or when manual edge missing
    // at cross-clarify spawn time.
    targetConsumerNodeId: text('target_consumer_node_id'),
    // wrapper-loop iter (RFC-056 partial persistence). 0 for kind='self' or
    // cross outside a loop.
    loopIter: integer('loop_iter').notNull().default(0),
    // Monotonic round counter scoped to (intermediary_node_id, loop_iter).
    // RFC-023's iteration_index and RFC-056's iteration map to this column
    // in migration 0031.
    iteration: integer('iteration').notNull().default(0),
    questionsJson: text('questions_json').notNull(), // ClarifyQuestion[]
    answersJson: text('answers_json'), // ClarifyAnswer[]; NULL until submitted
    directive: text('directive', { enum: ['continue', 'stop'] }),
    status: text('status', {
      enum: ['awaiting_human', 'answered', 'canceled', 'abandoned'],
    })
      .notNull()
      .default('awaiting_human'),
    truncationWarningsJson: text('truncation_warnings_json'), // JSON: { code, detail }[]
    // Stamped at designer rerun spawn time (kind='cross' only). NULL while
    // awaiting_human, on reject-only rows, on abandoned rows, and on every
    // kind='self' row.
    designerRunTriggeredAt: integer('designer_run_triggered_at'),
    // Stamped by RFC-053 CR-1 invariant when escalating cross-clarify rows on
    // parent task fail. NULL for kind='self'.
    abandonedAt: integer('abandoned_at'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    answeredAt: integer('answered_at'),
    answeredBy: text('answered_by'),
    // RFC-059: same payload as crossClarifySessions.questionScopesJson; written
    // by the submit handler dual-write. Always NULL for kind='self' rows;
    // may be NULL for kind='cross' rows when client did not send the map.
    questionScopesJson: text('question_scopes_json'),
  },
  (t) => ({
    taskIdx: index('idx_clarify_rounds_task').on(t.taskId),
    kindStatusIdx: index('idx_clarify_rounds_kind_status').on(t.kind, t.status),
    askingIdx: index('idx_clarify_rounds_asking').on(t.askingNodeId, t.loopIter, t.iteration),
    intermediaryIdx: index('idx_clarify_rounds_intermediary').on(
      t.intermediaryNodeId,
      t.loopIter,
      t.iteration,
    ),
    targetConsumerIdx: index('idx_clarify_rounds_target_consumer').on(
      t.targetConsumerNodeId,
      t.status,
    ),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 users — first-class user identity. `__system__` row is seeded by
// migration 0018 and represents the daemon-token actor (read-only, immutable
// from the API; reused as the launcher of any task whose actor was the daemon
// token rather than a real user session/PAT).
// -----------------------------------------------------------------------------
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(), // ULID; the literal '__system__' is reserved
    username: text('username').notNull().unique(),
    email: text('email').unique(), // nullable; SQLite UNIQUE allows multiple NULL
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'), // NULL = OIDC-only or invited user
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    status: text('status', { enum: ['active', 'disabled', 'invited'] })
      .notNull()
      .default('active'),
    forcePasswordChange: integer('force_password_change').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastLoginAt: integer('last_login_at'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    statusIdx: index('idx_users_status').on(t.status),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 user_sessions — opaque session tokens minted by `POST /api/auth/login`.
// `token_hash` is sha256(raw); raw value (prefix `aws_s_`) is shown only in the
// login response and never persisted.
// -----------------------------------------------------------------------------
export const userSessions = sqliteTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => ({
    userIdx: index('idx_user_sessions_user').on(t.userId, t.expiresAt),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 user_pats — personal access tokens. Same hash-only storage as
// sessions. Scopes are a JSON string[] subset of PERMISSIONS (catalog lives in
// packages/shared/src/schemas/permission.ts).
// -----------------------------------------------------------------------------
export const userPats = sqliteTable(
  'user_pats',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopesJson: text('scopes_json').notNull().default('[]'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => ({
    userIdx: index('idx_user_pats_user').on(t.userId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 oidc_providers — admin-managed list of OIDC identity providers. The
// client secret is AES-256-GCM-sealed with the per-host secret.key (see
// auth/secretBox.ts) before being written to client_secret_enc.
// -----------------------------------------------------------------------------
export const oidcProviders = sqliteTable(
  'oidc_providers',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    displayName: text('display_name').notNull(),
    issuerUrl: text('issuer_url').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretEnc: text('client_secret_enc').notNull(),
    scopes: text('scopes').notNull().default('openid profile email'),
    provisioning: text('provisioning', { enum: ['auto', 'allowlist', 'invite'] })
      .notNull()
      .default('invite'),
    allowedEmailDomainsJson: text('allowed_email_domains_json').notNull().default('[]'),
    iconUrl: text('icon_url'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    enabledIdx: index('idx_oidc_providers_enabled').on(t.enabled),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 user_identities — 1:N from users to (provider, subject). Linking is
// manual (never automatic by email) except invite-only flow that pre-creates a
// users row with status='invited' and binds on first OIDC login.
// -----------------------------------------------------------------------------
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => oidcProviders.id, { onDelete: 'restrict' }),
    subject: text('subject').notNull(),
    email: text('email'),
    emailVerified: integer('email_verified').notNull().default(0),
    linkedAt: integer('linked_at').notNull(),
  },
  (t) => ({
    userIdx: index('idx_user_identities_user').on(t.userId),
    providerIdx: index('idx_user_identities_provider').on(t.providerId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 task_collaborators — owner + collaborators + role-tagged members
// (reviewer/clarify_target). Composite PK lets the same user hold multiple
// roles on a task without losing audit context.
// -----------------------------------------------------------------------------
export const taskCollaborators = sqliteTable(
  'task_collaborators',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role', {
      enum: ['owner', 'reviewer', 'clarify_target', 'collaborator'],
    }).notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.userId, t.role] }),
    userIdx: index('idx_task_collab_user').on(t.userId),
    taskIdx: index('idx_task_collab_task').on(t.taskId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-036 node_assignments — per-node reviewer / clarify_target assignments
// recorded at launch time. PATCH `/api/tasks/:id/assignments/:nodeId` mutates
// in place (owner or admin only).
// -----------------------------------------------------------------------------
export const nodeAssignments = sqliteTable(
  'node_assignments',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    kind: text('kind', { enum: ['reviewer', 'clarify_target'] }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedBy: text('assigned_by').notNull(),
    assignedAt: integer('assigned_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.nodeId, t.kind] }),
    userIdx: index('idx_node_assign_user').on(t.userId),
    taskIdx: index('idx_node_assign_task').on(t.taskId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-041 memories — single source of truth for the platform's long-term
// memory layer. One row = one atomic learned rule / decision / preference
// scoped to exactly one of agent / workflow / repo / global. CHECK
// constraints in migration 0023 enforce status / scope_type / source_kind /
// distill_action enums and the "global ↔ NULL scope_id" invariant; we keep
// the columns as plain text here so drizzle does not over-narrow inference.
// -----------------------------------------------------------------------------
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type', { enum: ['agent', 'workflow', 'repo', 'global'] }).notNull(),
    scopeId: text('scope_id'),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    tags: text('tags').notNull().default('[]'), // JSON string[]
    status: text('status', {
      enum: ['candidate', 'approved', 'archived', 'superseded', 'rejected'],
    }).notNull(),
    sourceKind: text('source_kind', {
      enum: ['clarify', 'review', 'feedback', 'manual'],
    }).notNull(),
    sourceEventId: text('source_event_id'),
    sourceTaskId: text('source_task_id'),
    distillJobId: text('distill_job_id'),
    distillAction: text('distill_action', {
      enum: ['new', 'update_of', 'duplicate_of', 'conflict_with'],
    }),
    supersedesId: text('supersedes_id'),
    supersededById: text('superseded_by_id'),
    approvedByUserId: text('approved_by_user_id'),
    approvedAt: integer('approved_at'),
    createdAt: integer('created_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => ({
    scopeStatusIdx: index('idx_memories_scope_status').on(t.scopeType, t.scopeId, t.status),
    statusCreatedIdx: index('idx_memories_status_created').on(t.status, t.createdAt),
    supersedesIdx: index('idx_memories_supersedes').on(t.supersedesId),
    sourceIdx: index('idx_memories_source').on(t.sourceKind, t.sourceEventId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-041 memory_distill_jobs — queue consumed by the daemon 1Hz worker.
// One row per source event; siblings sharing a debounce_key get merged into
// one distill subprocess. `scope_resolved_json` is computed at enqueue time
// so the worker never re-queries the task graph.
// -----------------------------------------------------------------------------
export const memoryDistillJobs = sqliteTable(
  'memory_distill_jobs',
  {
    id: text('id').primaryKey(),
    debounceKey: text('debounce_key').notNull(),
    sourceKind: text('source_kind', { enum: ['clarify', 'review', 'feedback'] }).notNull(),
    sourceEventId: text('source_event_id').notNull(),
    taskId: text('task_id'),
    scopeResolvedJson: text('scope_resolved_json').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'done', 'failed', 'canceled'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextRunAt: integer('next_run_at').notNull(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    // RFC-043: artefacts persisted for the admin-only distill job detail
    // page. All nullable so pre-migration rows render with empty Section
    // placeholders. `opencode_session_id` is overwritten on each retry
    // attempt; per-attempt history is recoverable through
    // memory_distill_events.attempt_index.
    opencodeSessionId: text('opencode_session_id'),
    userPromptMd: text('user_prompt_md'),
    exitCode: integer('exit_code'),
    stderrExcerpt: text('stderr_excerpt'),
    dedupSnapshotIdsJson: text('dedup_snapshot_ids_json'),
    // RFC-050: per-job output language for the distiller. NULL = pre-RFC-050
    // row OR explicit "use default"; distiller layer treats NULL as 'en-US'.
    // Captured at enqueue so retries / merged siblings stay consistent even
    // if admin flips config.memoryDistillLang mid-batch.
    outputLang: text('output_lang'),
  },
  (t) => ({
    statusNextIdx: index('idx_distill_jobs_status_next').on(t.status, t.nextRunAt),
    debounceIdx: index('idx_distill_jobs_debounce').on(t.debounceKey, t.status),
    taskIdx: index('idx_distill_jobs_task').on(t.taskId, t.sourceKind),
  }),
)

// -----------------------------------------------------------------------------
// RFC-043 memory_distill_events — mirrors node_run_events for the distiller
// subprocess so the admin detail page can replay the conversation using
// the same RFC-027 ConversationFlow component used for worker nodes.
// One row per opencode event captured from the distiller's (and any
// recursively-spawned subagent) session. attempt_index groups events by
// distill retry round so the detail page can offer an attempt picker.
// -----------------------------------------------------------------------------
export const memoryDistillEvents = sqliteTable(
  'memory_distill_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    distillJobId: text('distill_job_id')
      .notNull()
      .references(() => memoryDistillJobs.id, { onDelete: 'cascade' }),
    attemptIndex: integer('attempt_index').notNull(),
    sessionId: text('session_id').notNull(),
    parentSessionId: text('parent_session_id'),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(), // mirrors nodeRunEvents.kind enum + RFC-043 markers
    payload: text('payload').notNull(),
  },
  (t) => ({
    jobAttemptIdx: index('idx_distill_events_job_attempt').on(t.distillJobId, t.attemptIndex, t.ts),
    sessionIdx: index('idx_distill_events_session').on(t.distillJobId, t.sessionId, t.ts),
  }),
)

// -----------------------------------------------------------------------------
// RFC-041 task_feedback — per-task free-text user notes ("dear future me").
// Each row independently enqueues a distill job. Not cascaded on task
// delete so historical notes survive worktree GC.
// -----------------------------------------------------------------------------
export const taskFeedback = sqliteTable(
  'task_feedback',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    authorUserId: text('author_user_id'),
    bodyMd: text('body_md').notNull(),
    createdAt: integer('created_at').notNull(),
    distilled: integer('distilled').notNull().default(0),
    distillJobId: text('distill_job_id'),
  },
  (t) => ({
    taskIdx: index('idx_task_feedback_task').on(t.taskId, t.createdAt),
  }),
)

// -----------------------------------------------------------------------------
// RFC-053 P-3 lifecycle_alerts — open / resolved lifecycle-invariant findings
// found by the periodic scan (services/lifecycleInvariants.ts).
// One row per (task_id, rule) is "open" at a time (resolved_at IS NULL).
// Resolved history is kept for diagnose UI / debug.
// rule values: 'R1' / 'R2' / 'C1' / 'T1' / 'T2' / 'T3' / 'U1'
//   (PR-E may add 'S1'/'S2'/'S3'/'S4' for stuck-task detection).
// severity: 'warning' for the first 24h after detected_at; promoted to
// 'error' on the next scan past that boundary.
// detail: JSON payload naming the affected rows (varies per rule).
// -----------------------------------------------------------------------------
export const lifecycleAlerts = sqliteTable(
  'lifecycle_alerts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    rule: text('rule').notNull(),
    severity: text('severity').notNull(),
    detail: text('detail').notNull(),
    detectedAt: integer('detected_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => ({
    taskIdx: index('idx_lifecycle_alerts_task').on(t.taskId, t.detectedAt),
    openIdx: index('idx_lifecycle_alerts_open').on(t.resolvedAt, t.severity),
  }),
)

// -----------------------------------------------------------------------------
// RFC-057 lifecycle_repair_audit — append-only audit of Diagnose-Panel repair
// actions. No FK to tasks / lifecycle_alerts on purpose: the audit row outlives
// both the alert row (which gets stamped resolved_at on repair) and the task
// (which may be GC'd). before/after snapshots are scoped to the rows the
// repair option actually touched, so the audit is self-describing without
// joining live tables.
// -----------------------------------------------------------------------------
export const lifecycleRepairAudit = sqliteTable(
  'lifecycle_repair_audit',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    alertId: text('alert_id'),
    alertRule: text('alert_rule').notNull(),
    alertDetailJson: text('alert_detail_json').notNull(),
    optionId: text('option_id').notNull(),
    actorUserId: text('actor_user_id'),
    beforeSnapshotJson: text('before_snapshot_json').notNull(),
    afterSnapshotJson: text('after_snapshot_json').notNull(),
    outcome: text('outcome').notNull(),
    outcomeMessage: text('outcome_message'),
    appliedAt: integer('applied_at').notNull(),
  },
  (t) => ({
    taskIdx: index('idx_lifecycle_repair_audit_task').on(t.taskId, t.appliedAt),
    ruleIdx: index('idx_lifecycle_repair_audit_rule').on(t.alertRule, t.appliedAt),
  }),
)
