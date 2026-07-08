// Drizzle schema for agent-workflow.
// Mirrors design/design.md §3. Any change here requires:
//   1. `bun run drizzle-kit generate` to produce a new migration in db/migrations/
//   2. Updating the corresponding zod schemas in packages/shared/src/schemas/
//
// All `text` columns holding JSON are documented in comments; runtime parses with zod.

import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// -----------------------------------------------------------------------------
// agents — DB is source of truth. Frontmatter fields are split into columns.
// -----------------------------------------------------------------------------
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull().unique(), // URL identifier (/agents/{name})
  description: text('description').notNull().default(''),
  outputs: text('outputs').notNull().default('[]'), // JSON string[] of port names
  // RFC-014: agent-level switch. When true (default), an iterate review decision
  // on a node whose upstream agent declares ≥ 2 markdown[_file] outputs will
  // re-generate every markdown[_file] sibling port and cascade their sibling
  // reviews back into awaiting_review. Author opt-out by setting false.
  syncOutputsOnIterate: integer('sync_outputs_on_iterate', { mode: 'boolean' })
    .notNull()
    .default(true),
  // RFC-111: per-agent runtime ('opencode' | 'claude-code'); NULL = inherit
  // config.defaultRuntime (→ 'opencode'). Model namespace follows the runtime.
  // RFC-115: the agent's own model/variant/temperature/steps/maxSteps columns
  // were dropped (DROP via migration 0057) — generation params now live solely
  // on the runtime profile (RFC-113); the agent only SELECTS a runtime by name.
  runtime: text('runtime'),
  permission: text('permission').notNull().default('{}'), // JSON: opencode permission schema
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
  // RFC-099: resource-level ACL. owner_user_id = single owner (users.id or the
  // '__system__' sentinel — app-layer FK so daemon-only DBs stay valid).
  // visibility 'public' = every active user can view/use; 'private' = owner +
  // resource_grants rows only. Admins bypass both. Same pair on skills / mcps /
  // plugins / workflows below.
  ownerUserId: text('owner_user_id'),
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('public'),
  // RFC-104: framework-seeded built-in marker. Set ONLY by seedFusionResources
  // (the RFC-101 rows); never writable via any HTTP path (absent from
  // Create*/Update* schemas). isBuiltinRow reads it for the read-only lock
  // (assertNotBuiltin) + list-hide (excludeBuiltin*). Immutable identity anchor:
  // survives owner/visibility drift, unlike the old owner+name heuristic.
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// runtimes — RFC-112. Named runtime INSTANCES: each row is a registered binary
// that speaks one of the two RuntimeDriver protocols (opencode | claude-code).
// opencode / claude-code are framework-seeded on FIRST startup only (empty table;
// RFC-153) with binary_path=NULL → the protocol's default binary
// (config.opencodePath / claudeCodePath / PATH). They are ORDINARY editable +
// deletable rows — RFC-153 removed the built-in vs non-built-in distinction;
// deleted rows are never re-seeded. Custom forks (renamed binaries)
// register additional rows. agents.runtime / config.defaultRuntime reference a
// row by `name`; node_runs freeze (protocol, binary) so the registry stays
// mutable without re-routing live sessions. Admin-managed (no per-user ACL —
// machine-level config including a local binary path).
// -----------------------------------------------------------------------------
export const runtimes = sqliteTable('runtimes', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull().unique(), // referenced by agents.runtime / config.defaultRuntime
  protocol: text('protocol', { enum: ['opencode', 'claude-code'] }).notNull(), // = RuntimeDriver kind
  binaryPath: text('binary_path'), // NULL → protocol default binary (RFC-111 behavior)
  // RFC-118: admin can disable a runtime (incl. the preseeded opencode / claude-code)
  // — it drops out of the
  // agent / default-runtime pickers but STAYS in the list (reversible, not deleted).
  // The effective-default runtime can't be disabled (service guard, D3); resolve
  // IGNORES this flag so in-flight agents pinning a disabled runtime keep dispatching.
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // RFC-113: a runtime IS a full execution profile. These are the model + gen
  // params the runner spawns with (agents only SELECT a runtime; they no longer
  // carry their own). variant/temperature/steps are opencode-only (claude has
  // none → NULL for claude rows). NULL model = "omit model, let the binary pick
  // its own default" (a distinct profile from an explicit model).
  model: text('model'),
  variant: text('variant'),
  temperature: real('temperature'),
  steps: integer('steps'),
  maxSteps: integer('max_steps'),
  // RFC-112: cached deep-smoke SmokeResult (JSON) from the last probe; NULL =
  // never probed. Display-only — conformance is advisory (an admin may save an
  // auth-unverified custom runtime).
  lastProbeJson: text('last_probe_json'),
  createdBy: text('created_by'), // admin users.id who registered it (audit; NULL for built-ins)
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
  // RFC-099: who registered this source. Skills imported from it inherit this
  // user as their owner (D11).
  createdBy: text('created_by'),
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
  // RFC-099 ACL (see agents table comment).
  ownerUserId: text('owner_user_id'),
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('public'),
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
  // RFC-099 ACL (see agents table comment).
  ownerUserId: text('owner_user_id'),
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('public'),
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
    // RFC-099 ACL (see agents table comment). External skills inherit their
    // source's created_by as owner at import time.
    ownerUserId: text('owner_user_id'),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('public'),
    schemaVersion: integer('schema_version').notNull().default(1),
    // RFC-101: monotonic CONTENT version (distinct from schema_version, the
    // DB-migration version). Bumps on every write through commitSkillVersion;
    // always equals the latest skill_versions.version_index for this skill.
    contentVersion: integer('content_version').notNull().default(1),
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
// skill_versions — RFC-101 skill content history.
//
// One immutable snapshot per (skill, version_index). Every write to a managed
// skill's files/ (editor save, fusion apply, restore) archives the new tree
// under ~/.agent-workflow/skills/{name}/versions/v{n}/files and inserts a row.
// Mirrors doc_versions (RFC-005): the DB stays small, the files stay grep-able.
// -----------------------------------------------------------------------------
export const skillVersions = sqliteTable(
  'skill_versions',
  {
    id: text('id').primaryKey(), // ULID
    skillName: text('skill_name')
      .notNull()
      .references(() => skills.name, { onDelete: 'cascade' }),
    versionIndex: integer('version_index').notNull(), // 1-based; == skills.content_version at archive
    filesPath: text('files_path').notNull(), // relative to app home: skills/{name}/versions/v{n}/files
    source: text('source', {
      enum: ['initial', 'editor', 'fusion', 'restore'],
    }).notNull(),
    summary: text('summary'), // change note (fusion changelog / restore auto-text); nullable
    fusionId: text('fusion_id'), // RFC-101 PR-B: set when source='fusion'; weak ref (no cascade)
    restoredFromVersion: integer('restored_from_version'), // set when source='restore'
    authorUserId: text('author_user_id'), // users.id or '__system__'
    contentHash: text('content_hash'), // sha256 of normalized files/ tree; used for empty-write skip
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    skillVersionIdx: uniqueIndex('uq_skill_versions_skill_v').on(t.skillName, t.versionIndex),
    createdIdx: index('idx_skill_versions_created').on(t.createdAt),
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
  // RFC-099 ACL (see agents table comment).
  ownerUserId: text('owner_user_id'),
  visibility: text('visibility', { enum: ['private', 'public'] })
    .notNull()
    .default('public'),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false), // RFC-104 (see agents)
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

// -----------------------------------------------------------------------------
// RFC-099 resource_grants — one generic per-user grant table for all five
// ACL'd resource types (agent / skill / mcp / plugin / workflow) instead of
// five twin tables. A row = "this user can view + use this resource". Owner
// and admins are NOT materialised here — canViewResource short-circuits them.
// added_by/added_at are audit-only.
// -----------------------------------------------------------------------------
export const resourceGrants = sqliteTable(
  'resource_grants',
  {
    resourceType: text('resource_type', {
      enum: ['agent', 'skill', 'mcp', 'plugin', 'workflow'],
    }).notNull(),
    resourceId: text('resource_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.resourceType, t.resourceId, t.userId] }),
    userIdx: index('idx_resource_grants_user').on(t.userId),
  }),
)

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
    // RFC-109: which workflows.version the frozen snapshot was taken from. NULL
    // for legacy rows (pre-0050; historical version unrecoverable). startTask
    // writes workflows.version; syncTaskWorkflow overwrites it on each re-sync.
    workflowVersion: integer('workflow_version'),
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
    // RFC-108 T11 (AR-09): circuit-breaker / quarantine accounting.
    autoRecoveryAttempts: integer('auto_recovery_attempts').notNull().default(0),
    // flag-audit W0：三根裸 0/1 列统一 mode:'boolean'（存储格式不变、零迁移），
    // 消费点告别手写 === 1 / ? 1 : 0 样板。
    autoRecoverySuspended: integer('auto_recovery_suspended', { mode: 'boolean' })
      .notNull()
      .default(false),
    autoRecoveryWindowStartedAt: integer('auto_recovery_window_started_at'),
    // optional expiry (soft delete after expires_at)
    expiresAt: integer('expires_at'),
    deletedAt: integer('deleted_at'),
    schemaVersion: integer('schema_version').notNull().default(1),
    // RFC-036: launcher actor for visibility filtering. NULL = legacy task
    // launched before RFC-036 or by daemon-token (system) actor; admins still
    // see those via scope=all, regular users do not.
    ownerUserId: text('owner_user_id'),
    // RFC-067: optional per-task Git commit identity. Both NULL → daemon
    // default (legacy behavior). Both set → runner injects GIT_AUTHOR_* /
    // GIT_COMMITTER_* env at spawn time AND startTask writes [user] into the
    // worktree's .git/config. XOR rejected at StartTaskSchema superRefine
    // and never persisted.
    gitUserName: text('git_user_name'),
    gitUserEmail: text('git_user_email'),
    // RFC-075: user-specified working branch. NULL → framework default
    // isolation branch `agent-workflow/{taskId}` (byte-identical to
    // pre-RFC-075). When set, `branch` equals this value.
    workingBranch: text('working_branch'),
    // RFC-075: auto commit&push toggle. false → no commit/push ever (legacy).
    // true → framework commits + pushes each writer agent's final output.
    autoCommitPush: integer('auto_commit_push', { mode: 'boolean' }).notNull().default(false),
    /**
     * RFC-066: count of `task_repos` rows for this task. Always ≥ 1.
     * Single-repo tasks have value 1 (and the legacy `repo_path` /
     * `worktree_path` / `base_branch` / `branch` / `base_commit` / `repo_url`
     * columns are byte-identical to pre-RFC-066). Multi-repo tasks have
     * value > 1 and the legacy columns mirror `task_repos[0]` for legacy
     * API back-compat. Migrated rows default to 1 (1-row backfill in
     * migration 0034).
     */
    repoCount: integer('repo_count').notNull().default(1),
    // （RFC-120 的 deferred_question_dispatch 列已由 RFC-132 T8 + migration 0073 物理删除——
    // universal deferred model 下所有任务同路径，无 per-task 开关。）
  },
  (t) => ({
    statusIdx: index('idx_tasks_status').on(t.status, t.startedAt),
    workflowIdx: index('idx_tasks_workflow').on(t.workflowId, t.startedAt),
    ownerIdx: index('idx_tasks_owner').on(t.ownerUserId),
  }),
)

// -----------------------------------------------------------------------------
// task_repos — RFC-066. One row per repo in a task. Single-repo tasks have
// one entry (mirrors `tasks.*` legacy columns); multi-repo tasks have N
// entries sorted by `repo_index` ascending. Migration 0034 backfills a
// single row per existing task. The `tasks.repo_*` / `tasks.worktree_*` /
// `tasks.base_*` / `tasks.branch` columns are kept as mirrors of
// `task_repos[0]` for legacy API compatibility.
// -----------------------------------------------------------------------------
export const taskRepos = sqliteTable(
  'task_repos',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** 0..N-1; 0 = primary (mirrors `tasks.*` legacy columns). */
    repoIndex: integer('repo_index').notNull(),
    /** Absolute path. URL-mode entries store the cached_repos.localPath. */
    repoPath: text('repo_path').notNull(),
    /** RFC-024 redacted URL; NULL for path-mode entries. */
    repoUrl: text('repo_url'),
    baseBranch: text('base_branch').notNull().default(''),
    /** 'agent-workflow/{taskId}' — each per-source-repo worktree gets the
     * same branch name (the branches live in different source repos, so
     * names cannot collide). */
    branch: text('branch').notNull(),
    // RFC-075: per-repo mirror of `tasks.working_branch` (the single working
    // branch name is applied to every repo). NULL → isolation branch.
    workingBranch: text('working_branch'),
    baseCommit: text('base_commit'),
    worktreePath: text('worktree_path').notNull(),
    /**
     * Sub-directory basename inside `tasks.worktree_path` for multi-repo
     * tasks (`utils` / `utils-2` / `utils-3` after auto-suffix collision
     * resolution). Empty string for single-repo tasks where
     * `tasks.worktree_path` is the repo worktree itself.
     */
    worktreeDirName: text('worktree_dir_name').notNull().default(''),
    /** RFC-034: per-repo submodule init telemetry. NULL for legacy rows. */
    hasSubmodules: integer('has_submodules', { mode: 'boolean' }),
    submoduleInitOk: integer('submodule_init_ok', { mode: 'boolean' }),
    submoduleInitError: text('submodule_init_error'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.repoIndex] }),
    repoPathIdx: index('idx_task_repos_repo_path').on(t.repoPath),
    repoUrlIdx: index('idx_task_repos_repo_url').on(t.repoUrl),
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
    // RFC-074 PR-C: the clarify_iteration counter is retired. Freshness is pure
    // ULID id-order (isFresherNodeRun) and the clarify generation is derived
    // from prior-done id-order at dispatch time; the column was dropped by
    // migration 0041.
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
    /**
     * RFC-108 T9 (AR-14): absolute path of the opencode binary spawned for this
     * run (cmd[0]), persisted alongside `pid`. The stale-process reaper matches
     * a live pid's `ps` command against THIS specific path instead of a fuzzy
     * `/opencode|bun/` regex, so it can reliably tell "our child is still alive"
     * (must NOT git-reset under it) from "the pid was recycled onto an unrelated
     * process" (safe to flip). NULL for non-agent runs / rows predating RFC-108.
     */
    spawnBinaryPath: text('spawn_binary_path'),
    exitCode: integer('exit_code'),
    /** Human-readable failure breadcrumbs ONLY (RFC-145): machine consumers
     *  read `failure_code` / `superseded_by_review` / `rolled_back` instead —
     *  a source guard forbids startsWith/includes/=== reads of this column in
     *  production code. */
    errorMessage: text('error_message'),
    /**
     * RFC-145 (migration 0077): machine-readable failure taxonomy — one of
     * shared FAILURE_CODES (7 values) or NULL (= no machine-readable failure
     * shape; the common case). Declared by the runner at each stamp point;
     * `decideEnvelopeFollowup` looks it up via FOLLOWUP_POLICY instead of
     * parsing errorMessage prefixes. Plain TEXT — enum enforced at the TS
     * boundary (rerun_cause precedent). Backend-internal (not in the DTO).
     */
    failureCode: text('failure_code'),
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
     * RFC-111 D15: the runtime ('opencode' | 'claude-code') frozen onto this
     * node_run at dispatch time (resolved once from agent.runtime ??
     * config.defaultRuntime). resume/retry read this instead of re-resolving so
     * a mutated agent/default can't re-route a captured session to the wrong
     * runtime. NULL on legacy rows → read as 'opencode'.
     */
    runtime: text('runtime'),
    /**
     * RFC-112 (Codex P1): the BINARY HEAD snapshot frozen alongside `runtime`
     * (the protocol) at dispatch — the resolved custom binary path, or NULL when
     * the dispatch used the protocol's default binary (config.opencodePath /
     * claudeCodePath / PATH). resume reads (runtime, runtime_binary) and re-spawns
     * the EXACT same (driver, binary) without consulting the mutable runtimes
     * registry, so deleting / renaming / re-pointing a runtime can't re-route a
     * captured session to the wrong binary. NULL on legacy rows + built-in default.
     */
    runtimeBinary: text('runtime_binary'),
    /**
     * RFC-113 (Codex design-gate P1-2): the runtime's execution PARAMS
     * (model/variant/temperature/steps/maxSteps) JSON-frozen alongside
     * `runtime`/`runtime_binary` at dispatch. resume/retry read this instead of
     * re-resolving from the mutable runtime row, so a runtime whose params change
     * mid-task can't make a resumed session continue under a different model. NULL
     * on legacy rows / runs predating RFC-113 → fall back to live resolution.
     */
    runtimeParamsJson: text('runtime_params_json'),
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
    /**
     * RFC-075: JSON `CommitPushMeta` recorded on a framework-synthesized
     * commit&push node_run (commit SHA / push target / outcome / repair
     * count). Non-NULL presence marks the row as a commit node — the synthetic
     * `node_id` is `__commit_push__:{agentNodeId}` (+ `:{repoSlug}` in
     * multi-repo) and `parent_node_run_id` points at the triggering agent run.
     * NULL on every regular node_run and all pre-RFC-075 rows.
     */
    commitPushJson: text('commit_push_json'),
    /**
     * RFC-066: per-repo stash sha map for multi-repo tasks, serialized as
     * `{ "<worktree_dir_name>": "<git-stash-sha>", ... }`. Replaces the
     * single-string `pre_snapshot` column for multi-repo tasks; single-repo
     * tasks continue to write `pre_snapshot` and leave this NULL.
     * `rollbackForResume` reads this column preferentially when
     * `task.repoCount > 1`; single-repo tasks read `pre_snapshot` as before
     * (byte-for-byte unchanged from pre-RFC-066). Defense in depth: when
     * `task.repoCount === 1` this column is always NULL.
     */
    preSnapshotReposJson: text('pre_snapshot_repos_json'),
    /**
     * RFC-130: per-node isolated-worktree bookkeeping (design.md §3.2). All NULL
     * on legacy / non-isolated rows (golden-lock: the scheduler's frontier gates
     * only look at these when `merge_state` is non-NULL).
     *
     * - iso_worktree_path: absolute path of THIS run's isolated worktree (OUTSIDE
     *   the canonical repo, D14). Cleared after a successful merge-back + discard.
     * - iso_base_snapshot / iso_base_snapshot_repos_json: the dispatch-time full
     *   snapshot sha (single / multi-repo) the iso worktree branched from — the
     *   3-way merge base + the pin that survives until merged.
     * - iso_node_tree / iso_node_tree_repos_json: the run-success full snapshot sha
     *   (single / multi-repo) of the iso final state — pinned so a crash between
     *   agent-success and merge-back can REPLAY the merge without re-running the
     *   agent (D15). Distinct pin ref from base (D26).
     * - merge_state: the RFC-130 iso lifecycle, state-machined by RFC-144
     *   (value universe = shared/lifecycle.ts MERGE_STATES; the ONLY sanctioned
     *   writers are transitionMergeState / abandonSupersededMergeStates in
     *   services/lifecycle.ts — the rfc144 blind-write inventory guard enforces
     *   this). NULL (never isolated: passthrough/legacy; every mint is born
     *   NULL) | 'isolating' (iso created, agent not finished) | 'pending-merge'
     *   (agent ok, outputs+node_tree pinned, NOT yet merged, D15) | 'merged'
     *   (delta reached canonical) | 'conflict-human' (merge agent could not
     *   resolve; parked for a human, resolve-iso kept) | 'merge-failed'
     *   (merge-back threw; hard failure) | 'abandoned' (RFC-144: superseded by
     *   a fresher generation — its delta will never merge; abandoned ⇔
     *   superseded). Downstream readiness + resume replay gate on this.
     *   (The pre-RFC-144 doc listed a 'conflict-resolving' value that was never
     *   written and omitted 'isolating'/'merge-failed' — classic blind-write
     *   drift; the transition table is now the single source.)
     */
    isoWorktreePath: text('iso_worktree_path'),
    isoBaseSnapshot: text('iso_base_snapshot'),
    isoBaseSnapshotReposJson: text('iso_base_snapshot_repos_json'),
    isoNodeTree: text('iso_node_tree'),
    isoNodeTreeReposJson: text('iso_node_tree_repos_json'),
    mergeState: text('merge_state'),
    /**
     * RFC-074: provenance map `{ upstreamNodeId: nodeRunId }` — exactly which
     * upstream node_run this row consumed at its content read-point. NULL on
     * pre-RFC-074 rows and input/no-upstream nodes (treated as fresh). Drives
     * read-time `isNodeRunFresh`, replacing the cci-watermark cascade.
     */
    consumedUpstreamRunsJson: text('consumed_upstream_runs_json'),
    /**
     * RFC-098 B3 (audit S-19/S-20): sha256 hex of the fanout shard's VALUE
     * (the list item this shard row was minted for), written by
     * dispatchFanoutShard at mint time. The cross-generation reuse anchor is
     * `(taskId, nodeId, iteration, shardKey, parentNodeRunId IS NOT NULL)`;
     * a done row is only replayed when this hash matches the current shard
     * value (pickReusableShardRun, freshness.ts). NULL on pre-0043 rows
     * (NULL = MATCH, legacy compatibility — hard requirement, see migration
     * 0043), on shared/broadcast (NULL-shardKey) rows, on the aggregator row,
     * and on every non-fanout run.
     */
    shardValueHash: text('shard_value_hash'),
    /**
     * RFC-098 WP-10 (audit S-25): WHY this row was minted — RerunCause enum
     * (shared/schemas/task.ts), written by the single mint factory
     * (services/nodeRunMint.ts) on every insert. The scheduler's gate-2
     * (isClarifyRerun) switches on it (cause ∈ {'clarify-answer',
     * 'cross-clarify-questioner-rerun'}) instead of the old proxy
     * `clarifyGeneration > 0 && retryIndex === 0`. NULL on pre-0044 rows —
     * they gate FALSE (documented daemon-upgrade boundary degradation, see
     * isClarifyRerunCause). Plain TEXT on purpose: the enum is enforced at
     * the TypeScript boundary so new causes never need a migration.
     */
    rerunCause: text('rerun_cause'),
    /**
     * RFC-145 (migration 0077): review-supersede lineage, structured. When a
     * review reject/iterate retires this row (review.ts supersede path), the
     * user decision lands here ('iterated' | 'rejected' — shared
     * SUPERSEDE_DECISIONS; 'approved' never supersedes). NULL = not a review
     * supersede. `isReviewSupersededRow` (LOAD-BEARING dispatch contract,
     * RFC-095) now reads THIS column — the old errorMessage prefix marker
     * remains as human breadcrumbs only. Serialized to the frontend (the
     * noderun-status decode consumes it).
     */
    supersededByReview: text('superseded_by_review'),
    /**
     * RFC-145: whether the supersede actually rolled the worktree(s) back
     * (review.ts `rolledBack` — attempted with zero failures). Orthogonal to
     * the decision value; drives the frontend canceled-row classification
     * (rollback vs superseded vs manual). NULL ⇔ false.
     */
    rolledBack: integer('rolled_back', { mode: 'boolean' }),
    /**
     * RFC-127 借壳: borrowed agent name for reassignment. When a clarify rerun
     * (self/questioner/designer) is reassigned to another workflow node's agent
     * X, this row keeps node_id = original node P but runs with X's agent
     * definition (X's body/model/runtime/skill + P's output port
     * contract). NULL = the node's own agentName (normal path). The scheduler
     * resolves this BEFORE agent/runtime/injection resolution (design §3.2);
     * audit + cross-tick re-dispatch visibility only — NEVER enters a prompt.
     */
    agentOverrideName: text('agent_override_name'),
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
    // RFC-072: resolved AgentOutputKind string (agent.outputKinds[port]) at run
    // time. NULL when the agent declared no kind for this port or for rows
    // written before RFC-072. Lets the Outputs tab distinguish file-path ports
    // (path<ext> / markdown_file) from text ports.
    kind: text('kind'),
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
      // RFC-074: 'superseded' — set by the system when an awaiting review's
      // upstream produced a fresher run; the old doc_version is retired and a
      // v(n+1) is minted (design §7). No DB CHECK exists on this column, so
      // adding the value is a pure type-layer change.
      enum: ['pending', 'approved', 'rejected', 'iterated', 'superseded'],
    })
      .notNull()
      .default('pending'),
    decisionReason: text('decision_reason'),
    promptSnapshot: text('prompt_snapshot'), // user prompt sent when generating this version
    // RFC-115: agent_snapshot column dropped (migration 0058). It was reserved
    // for per-agent {model,variant,temperature} but never populated; RFC-113/115
    // moved generation params onto the runtime, so it was always NULL.
    // Worktree-relative path captured at dispatch time when the upstream port
    // resolved as a markdown_file (or the forgiveness branch silently read a
    // .md file). Carried through into renderCommentsForPrompt so the iterate
    // re-run prompt cites which file the comments target. NULL when the
    // source was inline markdown / a non-file string.
    sourceFilePath: text('source_file_path'),
    // RFC-079: 0-based item index within a MULTI-document review round (one
    // doc_version per list<path<md>> member). NULL on every single-document
    // row — that NULL is the system-wide "single-doc mode" discriminator, so
    // all existing queries / dispatch / decision paths stay byte-for-byte
    // unchanged. The accepted-subset output (approve) sorts members by this.
    itemIndex: integer('item_index'),
    // RFC-079: per-document curation choice in multi-doc mode. Orthogonal to
    // `decision` (which stays the round-level approve/reject/iterate state):
    // at round approve, 'accepted' members flow downstream as the subset and
    // 'not_accepted' members are dropped, while `decision` flips to 'approved'
    // on every member row. NULL on single-document rows.
    selection: text('selection', { enum: ['unselected', 'accepted', 'not_accepted'] }),
    // RFC-079: worktree-relative path of a list<path<md>> member (stable id =
    // the line read from the upstream list port). Carried verbatim into the
    // accepted-subset output so downstream nodes read the live file. NULL on
    // single-document / inline rows.
    itemPath: text('item_path'),
    // RFC-129: cross-round selection inheritance staleness. `true` when this
    // multi-document member's `selection` was INHERITED from the immediately-
    // previous round AND its body differs from the body the human last judged
    // (propagated across rounds until a human re-marks; cleared to `false` on an
    // explicit setDocumentSelection). NULL on single-document / legacy /
    // unselected / freshly human-judged rows. Drives the "已变更" badge only —
    // never gates approve, never enters an agent prompt.
    selectionStale: integer('selection_stale', { mode: 'boolean' }),
    // RFC-129: per-mint STRICTLY-MONOTONIC generation counter (dispatchReviewNode
    // stamps every member of one round with prev-max + 1 — immune to clock ties/
    // rewinds). The round key inheritance uses — loadPriorRound takes the members
    // with the MAX round_generation as one coherent generation, so a refresh/US-2
    // leaving two generations at the same review_iteration can never mix rows
    // across generations. NULL on single-document / legacy rows. Migration 0070.
    roundGeneration: integer('round_generation'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    decidedAt: integer('decided_at'),
    decidedBy: text('decided_by'), // v1 always 'local'; reserved
    // RFC-099: task-relationship role snapshot of the decider (D7/D17).
    // NULL = historic / system rows. Not read by buildReviewPromptContext.
    decidedByRole: text('decided_by_role'),
  },
  (t) => ({
    reviewIdx: index('idx_doc_versions_review_run').on(t.reviewNodeRunId, t.versionIndex),
    taskIdx: index('idx_doc_versions_task').on(t.taskId),
    // RFC-079: lookup all members of a multi-doc round in item order.
    reviewItemIdx: index('idx_doc_versions_review_item').on(t.reviewNodeRunId, t.itemIndex),
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
    // RFC-099: task-relationship role snapshot at comment time
    // ('owner'|'user'|'admin', member identity first — D17). NULL = historic
    // row, rendered as "local user (history)". NEVER read by
    // renderCommentsForPrompt (prompt isolation, D7).
    authorRole: text('author_role'),
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
    // (RFC-132 PR-F: the RFC-070 consumption-stamp column was dropped —
    // derived aging via isTargetNodeConsumed replaced it; migration 0073.)
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
    // (RFC-132 PR-F: the RFC-070 consumption-stamp columns were dropped — derived aging
    // via isTargetNodeConsumed replaced them; migration 0073.)
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
    // RFC-099 (D7/D8/D14): collaborative-answer attribution. All three are
    // UI/audit-only — buildPromptContext / buildClarifyPromptBlock must never
    // read them (locked by rfc099 prompt-isolation tests).
    //   submitted_by_role — task-relationship role snapshot of answeredBy.
    //   answer_attributions_json — Record<questionId, {userId, role, updatedAt}>;
    //     live-updated on every draft save, frozen at submit.
    //   draft_answers_json — Record<questionId, string> server-side draft;
    //     per-question last-write-wins; cleared at submit.
    submittedByRole: text('submitted_by_role'),
    answerAttributionsJson: text('answer_attributions_json'),
    draftAnswersJson: text('draft_answers_json'),
    // RFC-059: same payload as crossClarifySessions.questionScopesJson; written
    // by the submit handler dual-write. Always NULL for kind='self' rows;
    // may be NULL for kind='cross' rows when client did not send the map.
    questionScopesJson: text('question_scopes_json'),
    // (RFC-132 PR-F: the RFC-070 consumption-stamp columns were dropped — derived aging
    // via isTargetNodeConsumed replaced them; migration 0073.)
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
// RFC-122 — per-(task, asking-node) clarify directive override. A task member
// flips the on-canvas "继续反问 / 停止反问" toggle for an asking-agent node; the
// scheduler reads `directive='stop'` AT DISPATCH (parallel to RFC-056
// resolveCrossNodeStopped) and forces the asking agent out of mandatory ask-back for
// that dispatch — so a not-yet-run node and an error-retry's fresh run both pick
// up the LATEST toggle for free. Absent row ⇒ 'continue' (legacy behavior,
// byte-for-byte). `set_by` is audit-only (the task-member user id) and, like
// every other attribution column, MUST NOT enter any agent prompt.
// -----------------------------------------------------------------------------
export const taskNodeClarifyDirectives = sqliteTable(
  'task_node_clarify_directives',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // Workflow node id of the asking-agent node (validated at the API as
    // isClarifyAskingNode against the task's workflow snapshot).
    nodeId: text('node_id').notNull(),
    directive: text('directive', { enum: ['continue', 'stop'] }).notNull(),
    // Task-member user id who last set it (UI/audit only).
    setBy: text('set_by'),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.nodeId] }),
    taskIdx: index('idx_task_node_clarify_directives_task').on(t.taskId),
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
    forcePasswordChange: integer('force_password_change', { mode: 'boolean' })
      .notNull()
      .default(false),
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
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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
// RFC-036 task_collaborators — owner + collaborators ("任务用户"). RFC-099
// (D6) collapsed the reviewer/clarify_target role tags (migration 0046) and
// dropped the node_assignments table that backed the never-shipped node-level
// assignment UI: task membership IS the answer-rights boundary now.
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
      enum: ['owner', 'collaborator'],
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
    // RFC-101: 'fused' is a terminal status — the memory's knowledge has been
    // merged into a skill (provenance below). Excluded from runtime injection
    // (memoryInject filters status='approved').
    status: text('status', {
      enum: ['candidate', 'approved', 'archived', 'superseded', 'rejected', 'fused'],
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
    // RFC-101 fusion provenance — set iff status='fused' (DB CHECK enforces).
    fusedIntoSkill: text('fused_into_skill'),
    fusedIntoSkillVersion: integer('fused_into_skill_version'),
    fusedAt: integer('fused_at'),
    fusedByUserId: text('fused_by_user_id'),
    fusedFusionId: text('fused_fusion_id'),
  },
  (t) => ({
    scopeStatusIdx: index('idx_memories_scope_status').on(t.scopeType, t.scopeId, t.status),
    statusCreatedIdx: index('idx_memories_status_created').on(t.status, t.createdAt),
    supersedesIdx: index('idx_memories_supersedes').on(t.supersedesId),
    sourceIdx: index('idx_memories_source').on(t.sourceKind, t.sourceEventId),
  }),
)

// -----------------------------------------------------------------------------
// fusions — RFC-101 memory→skill fusion record (product-level orchestration).
// One row per fusion, spanning N engine-task iterations. The proposed skill
// change lives in the current engine task's ephemeral worktree until the
// merger approves (apply → bump skill version + fuse memories) or rejects.
// -----------------------------------------------------------------------------
export const fusions = sqliteTable(
  'fusions',
  {
    id: text('id').primaryKey(), // ULID
    skillName: text('skill_name').notNull(),
    baseSkillVersion: integer('base_skill_version').notNull(), // OCC baseline
    memoryIdsJson: text('memory_ids_json').notNull(), // string[] selected memory ids
    intent: text('intent').notNull().default(''),
    status: text('status', {
      enum: ['running', 'awaiting_approval', 'applying', 'done', 'rejected', 'canceled', 'failed'],
    })
      .notNull()
      .default('running'),
    iteration: integer('iteration').notNull().default(1),
    currentTaskId: text('current_task_id'), // engine task for the current iteration
    proposedWorktreePath: text('proposed_worktree_path'),
    proposedDiff: text('proposed_diff'), // current vs proposed, for the approval gate
    incorporatedMemoryIdsJson: text('incorporated_memory_ids_json'),
    skippedJson: text('skipped_json'), // [{memoryId, reason}]
    changelog: text('changelog'),
    appliedSkillVersion: integer('applied_skill_version'),
    ownerUserId: text('owner_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    decidedByUserId: text('decided_by_user_id'),
    decidedAt: integer('decided_at'),
    decisionReason: text('decision_reason'),
    error: text('error'),
  },
  (t) => ({
    skillIdx: index('idx_fusions_skill').on(t.skillName),
    statusIdx: index('idx_fusions_status').on(t.status),
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

// RFC-108 T3 (AR-11) — recovery_events: append-only audit of every SYSTEM-initiated
// recovery action (boot-reap / shutdown-flip / limit-cancel / snapshot-lost /
// live-child-survived / auto-resume / auto-repair / heartbeat-kill / quarantine).
// lifecycle_repair_audit is the MANUAL counterpart (human repair clicks).
export const recoveryEvents = sqliteTable(
  'recovery_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id'),
    nodeRunId: text('node_run_id'),
    actor: text('actor').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    taskIdx: index('idx_recovery_events_task').on(t.taskId, t.createdAt),
    kindIdx: index('idx_recovery_events_kind').on(t.kind, t.createdAt),
  }),
)

// -----------------------------------------------------------------------------
// RFC-120 task_questions — per-(clarify question × handler role) tracked entry
// for the task's "question list / 任务中心". Auto-collected from every clarify
// round (self + cross). Execution phases (待处理/处理中/已处理待确认) are DERIVED
// at read time from the handler node_run (see services/taskQuestions.ts +
// shared/task-questions.ts) — NOT stored; only the manual overlay (confirmation
// + override target + audit) and the round/role identity persist. role_kind
// 'designer' is the only re-targetable (修订型) role; 'self'/'questioner' are
// 阻塞-产出型 (re-target would deadlock). Attribution columns (confirmed_by /
// last_reassigned_by) are UI/audit-only and must NEVER enter an agent prompt
// (RFC-099 prompt-isolation; locked by rfc120 tests).
// -----------------------------------------------------------------------------
export const taskQuestions = sqliteTable(
  'task_questions',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    // The source clarify round's intermediary node_run id (locates clarify_rounds).
    // Plain text (logical pointer; tolerated-if-stale, cleaned up via task cascade).
    // RFC-120 §15/§16 H4: a source_kind='manual' row has NO clarify round, so it
    // stores its OWN fresh ULID here — a non-null synthetic identity (H4's sanctioned
    // alternative to nullable+partial-index). This keeps the column NOT NULL (no SQLite
    // table rebuild) and keeps uniq_task_questions_identity below collision-free + byte-
    // for-byte for clarify rows (synthetic origins are unique). It points to no real
    // node_run; the read-side/injection branch on source_kind, not on this resolving.
    originNodeRunId: text('origin_node_run_id').notNull(),
    questionId: text('question_id').notNull(), // round-local question id (manual: fresh ULID)
    questionTitle: text('question_title').notNull(), // snapshot (title is stable across reopen)
    sourceKind: text('source_kind', { enum: ['self', 'cross', 'manual'] }).notNull(),
    // RFC-134: + 'echo' — 改派回执（只读知会，目标=提问节点，生来已下发、排队等自然重跑）。
    // drizzle enum 纯类型层、无 CHECK 约束 → 扩宽零 migration（0060 DDL 佐证）。
    roleKind: text('role_kind', { enum: ['self', 'questioner', 'designer', 'echo'] }).notNull(),
    // Round iteration / loop_iter snapshot — used by resolveHandlerRun to frame
    // the exact handler lineage (Codex F1).
    iteration: integer('iteration').notNull().default(0),
    loopIter: integer('loop_iter').notNull().default(0),
    // Graph-resolved default handler node (NULL if the graph could not resolve).
    defaultTargetNodeId: text('default_target_node_id'),
    // Human re-target (designer only); NULL = use default. effective target =
    // override ?? default.
    overrideTargetNodeId: text('override_target_node_id'),
    // RFC-120 §18 — committed-for-execution marker (set at batch-dispatch by
    // dispatchTaskQuestions; migration 0063). dispatched_at != null = the human
    // clicked "下发"; it is the park-gate key (undispatched = dispatched_at IS NULL)
    // and DISTINCT from trigger_run_id below. dispatched_by is the audit-only actor —
    // NEVER enters an agent prompt (RFC-099 prompt-isolation).
    dispatchedAt: integer('dispatched_at'),
    dispatchedBy: text('dispatched_by'),
    // RFC-120 §18 — the handler run that currently RENDERS this entry. Stamped at the
    // node's RERUN (buildExternalFeedbackContext binds the per-node queue to its run),
    // NOT at batch-dispatch. NULL = dispatched-but-not-yet-bound (queued) OR
    // never-dispatched. Plain text; phase derivation tolerates stale.
    triggerRunId: text('trigger_run_id'),
    // RFC-120 v2: 「待下发」暂存 (migration 0061). staged_at != null = approved into
    // the 待下发 column, awaiting batch dispatch (trigger_run_id still NULL). After
    // dispatch staged_at is kept for audit. Drives the staged(待下发) vs pending(待指派)
    // split in deriveQuestionPhase; task gate parks while any entry is pending/staged.
    stagedAt: integer('staged_at'),
    stagedBy: text('staged_by'),
    // RFC-140 W2 (migration 0074) — auto-serial redispatch marker. Set (in the dispatch stamp
    // tx) on entries the RFC-128 auto-split DEFERRED out of a user-clicked batch dispatch: the
    // user HAS expressed dispatch intent; only cause serialization queued it. The scheduler tick
    // auto-dispatches rows with (marker set + dispatched_at NULL + staged_at NOT NULL). Cleared
    // by BOTH stage directions (stage/unstage — any staging change kills the intent; a re-stage
    // must re-click batch dispatch). Kept after dispatch as audit (dispatched_at makes it inert).
    autoDispatchDeferredAt: integer('auto_dispatch_deferred_at'),
    // RFC-128 §7 (落库方案 C; migration 0068) — per-question seal marker. The clarify
    // round's `answers_json` stays the answer-content SoT (per-question merge-write);
    // THIS column records that one (question × role) entry's answer is sealed/locked
    // (the human committed it), enabling per-question seal/dispatch while the round
    // stays awaiting_human (partial). NULL = not yet sealed via the per-question path;
    // a whole-round answered round derives "all sealed" from clarify_rounds.status
    // (no backfill — migration 0068 only adds the column). Drives: reconcile's
    // per-question designer gate, the DTO `sealed` field, the stage gate (P2), and the
    // "flip round answered only when ALL questions sealed" rule (P1 T4). sealed_by is
    // the audit-only setter id (RFC-099 prompt-isolation) — NEVER enters a prompt,
    // same layer as confirmed_by / dispatched_by / staged_by.
    sealedAt: integer('sealed_at'),
    sealedBy: text('sealed_by'),
    confirmation: text('confirmation', { enum: ['open', 'confirmed'] })
      .notNull()
      .default('open'),
    confirmedBy: text('confirmed_by'),
    confirmedByRole: text('confirmed_by_role'),
    confirmedAt: integer('confirmed_at'),
    lastReassignedBy: text('last_reassigned_by'),
    lastReassignedAt: integer('last_reassigned_at'),
    reopenCount: integer('reopen_count').notNull().default(0),
    // Pre-edit answer snapshot captured at reopen (audit of the "解冻前" value).
    priorAnswerSnapshotJson: text('prior_answer_snapshot_json'),
    // RFC-120 §15 — manual question (自主新增/复制; migration 0065). For a
    // source_kind='manual' row a human authored the question/instruction directly:
    // manual_title is the title (DTO questionTitle), manual_body is the instruction
    // injected as External Feedback when the assigned node reruns (DTO answerSummary).
    // manual_created_by is the audit-only author id — NEVER enters an agent prompt
    // (RFC-099 prompt-isolation). All NULL for clarify rows (golden-lock).
    manualTitle: text('manual_title'),
    manualBody: text('manual_body'),
    manualCreatedBy: text('manual_created_by'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    taskIdx: index('idx_task_questions_task').on(t.taskId),
    originIdx: index('idx_task_questions_origin').on(t.originNodeRunId),
    // Natural identity: one entry per (round, question, role).
    identityIdx: uniqueIndex('uniq_task_questions_identity').on(
      t.originNodeRunId,
      t.questionId,
      t.roleKind,
    ),
  }),
)
