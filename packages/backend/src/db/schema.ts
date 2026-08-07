// Drizzle schema for agent-workflow.
// Mirrors design/design.md §3. Any change here requires:
//   1. `bun run drizzle-kit generate` to produce a new migration in db/migrations/
//   2. Updating the corresponding zod schemas in packages/shared/src/schemas/
//
// All `text` columns holding JSON are documented in comments; runtime parses with zod.

import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
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
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(), // display label; canonical URL identity is id
    description: text('description').notNull().default(''),
    outputs: text('outputs').notNull().default('[]'), // JSON string[] of port names
    // RFC-166: declarative input ports (JSON AgentInputPort[]; default []).
    // Optional/additive — existing agents keep implicit {{token}} input binding;
    // consumed only by the capability card, not the spawn path.
    inputs: text('inputs').notNull().default('[]'),
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
    // RFC-252 G4: 'deny' | 'allow' | NULL. NULL = 未表态 = deny（存量行全是 NULL，
    // 行为必须字节不变）。只有精确 'allow' 才是授权：mapper 对 NULL **省略**而不是
    // 透出 null，杜绝下游用 `?? ` / 真值判断把「没表态」读成「放行」。
    network: text('network'),
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
    // plugins / workflows below. The physical public default is retained only
    // for legacy/raw-SQL compatibility; supported create services explicitly
    // stamp RFC-231 private (or deliberate framework-builtin public).
    ownerUserId: text('owner_user_id'),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('public'), // legacy storage fallback; not the product create default
    aclRevision: integer('acl_revision').notNull().default(0), // RFC-170 §8 aclRevision CAS
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
  },
  (t) => ({
    ownerNameUq: uniqueIndex('agents_owner_name_unique').on(
      sql`COALESCE(${t.ownerUserId}, '')`,
      t.name,
    ),
  }),
)

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
  // RFC-154: config-dir injection overrides for custom forks that renamed the
  // env var / leaf dir they discover their config dir through. NULL = protocol
  // default (shared DEFAULT_CONFIG_DIR_PROFILE: OPENCODE_CONFIG_DIR/.opencode,
  // CLAUDE_CONFIG_DIR/.claude). Business-node spawns only (system agents /
  // smoke / probe stay on protocol defaults — RFC-154 §2.3). Frozen per node_run
  // inside runtime_params_json.__configDir so resume/retry never re-reads these
  // mutable columns.
  configDirEnv: text('config_dir_env'),
  configDirName: text('config_dir_name'),
  /**
   * 2026-08-04 (CodeAgent/GLM fork deployment): extra argv tokens appended to
   * every spawn of this runtime (JSON string array; NULL = none). claude-code
   * protocol only — forks carry private flags (`--skip-safe-check`) official
   * binaries reject, while opencode's verified serve argv is sealed and takes
   * no user tokens. Platform-owned flags are rejected at write time
   * (validateExtraArgs); frozen into runtime_params_json like the profile.
   */
  extraArgsJson: text('extra_args_json'),
  // RFC-112/RFC-224: target-bound deep-smoke receipt (JSON); NULL = never
  // probed/invalidated. Display-only — conformance is advisory (an admin may
  // save an auth-unverified custom runtime).
  lastProbeJson: text('last_probe_json'),
  // RFC-224: persisted generation for the exact execution target described by
  // last_probe_json. Profile edits and inherited daemon-config binary changes
  // bump it, so an in-flight probe can CAS only against the target it actually
  // exercised (including mutations that live outside SQLite).
  probeFence: integer('probe_fence').notNull().default(0),
  createdBy: text('created_by'), // admin users.id who registered it (audit; NULL for built-ins)
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
// the spawned opencode process. See docs/OPENCODE_CONFIG.md §1 and §3.3 for the
// field-name translation (env→environment, timeoutMs→timeout) and §3.3 for
// why `config.command[0]` is the executable (no `cwd` field — opencode uses
// the process directory = worktree).
// -----------------------------------------------------------------------------
export const mcps = sqliteTable(
  'mcps',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(),
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
      .default('public'), // legacy storage fallback; not the product create default
    aclRevision: integer('acl_revision').notNull().default(0), // RFC-170 §8 aclRevision CAS
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerNameUq: uniqueIndex('mcps_owner_name_unique').on(
      sql`COALESCE(${t.ownerUserId}, '')`,
      t.name,
    ),
  }),
)

// -----------------------------------------------------------------------------
// plugins — RFC-031. DB is source of truth for opencode plugin records. The
// installer materialises every record to ~/.agent-workflow/plugins/{id}/ at
// save time (npm install --prefix, or realpath for file: spec), and the
// runner injects `file://<cached_path>` (plus options when non-empty) into
// `OPENCODE_CONFIG_CONTENT.plugin` — opencode then loads via
// resolvePathPluginTarget without hitting the network. Agents reference these
// by name via agents.plugins (JSON string[]).
// -----------------------------------------------------------------------------
export const plugins = sqliteTable(
  'plugins',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(), // display label; /api/plugins/:id is canonical
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
      .default('public'), // legacy storage fallback; not the product create default
    aclRevision: integer('acl_revision').notNull().default(0), // RFC-170 §8 aclRevision CAS
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerNameUq: uniqueIndex('plugins_owner_name_unique').on(
      sql`COALESCE(${t.ownerUserId}, '')`,
      t.name,
    ),
  }),
)

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
// skills — fs is source of truth (~/.agent-workflow/skills/{id}/files/).
// DB stores only the index.
// -----------------------------------------------------------------------------
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    // RFC-178: skills are managed-only (external / parent-directory sources
    // removed in migration 0092). external_path / source_id + the skill_sources
    // table were dropped there.
    sourceKind: text('source_kind', { enum: ['managed'] }).notNull(),
    managedPath: text('managed_path'), // e.g. 'skills/{id}/files/' relative to app dir
    // RFC-099 ACL (see agents table comment).
    ownerUserId: text('owner_user_id'),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('public'), // legacy storage fallback; not the product create default
    schemaVersion: integer('schema_version').notNull().default(1),
    // RFC-101: monotonic CONTENT version (distinct from schema_version, the
    // DB-migration version). Bumps on every write through commitSkillVersion;
    // always equals the latest skill_versions.version_index for this skill.
    contentVersion: integer('content_version').notNull().default(1),
    // RFC-170 — skills storage/ACL hardening (migration 0090). All additive;
    // dormant until batch-B code wires them. See design.md §1/§3/§4/§7a/§8/§10.
    aclRevision: integer('acl_revision').notNull().default(0), // §8 aclRevision CAS
    metaRevision: integer('meta_revision').notNull().default(0), // §1 metaRevision monotonic
    migrationMarker: text('migration_marker'), // §4: NULL|'migrated'|'pending-decision'
    reservationState: text('reservation_state', { enum: ['reserving', 'ready'] })
      .notNull()
      .default('ready'), // §9 creation reservation; non-ready is invisible
    versionState: text('version_state', {
      enum: ['legacy-unbackfilled', 'snapshot-unverified', 'snapshot-authoritative', 'quarantined'],
    })
      .notNull()
      .default('legacy-unbackfilled'), // §3 snapshot authority lifecycle
    // RFC-178: authority_kind / source_state / origin_source_id /
    // authority_owner_user_id were dropped in migration 0092 (external/source-only).
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerNameUq: uniqueIndex('skills_owner_name_unique').on(
      sql`COALESCE(${t.ownerUserId}, '')`,
      t.name,
    ),
  }),
)

// -----------------------------------------------------------------------------
// skill_versions — RFC-101 skill content history.
//
// One immutable snapshot per (skill, version_index). Every write to a managed
// skill's files/ (editor save, fusion apply, restore) archives the new tree
// under ~/.agent-workflow/skills/{id}/versions/v{n}/files and inserts a row.
// Mirrors doc_versions (RFC-005): the DB stays small, the files stay grep-able.
// -----------------------------------------------------------------------------
export const skillVersions = sqliteTable(
  'skill_versions',
  {
    id: text('id').primaryKey(), // ULID
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    versionIndex: integer('version_index').notNull(), // 1-based; == skills.content_version at archive
    filesPath: text('files_path').notNull(), // relative to app home: skills/{id}/versions/v{n}/files
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
    skillVersionIdx: uniqueIndex('uq_skill_versions_skill_v').on(t.skillId, t.versionIndex),
    createdIdx: index('idx_skill_versions_created').on(t.createdAt),
  }),
)

// -----------------------------------------------------------------------------
// skill_operations — RFC-170 §6a two-phase-commit crash-recovery state machine.
// One active row per in-flight structural op (reserve / migrate / delete /
// version-write). `phase` records the last COMMITted step; recovery is a pure
// function of (phase, op-scoped FS probe). No `skills` FK cascade — recovery is
// by op_id ownership, not row lifetime.
// RFC-178: the TS `kind` enum dropped `replace` (source-conflict) + `adopt-managed`
// (external adoption); the DB CHECK from migration 0090 keeps the wider superset
// (no table rebuild — no row ever carries the removed kinds). `next_skill_id` +
// `precondition_json` are retained but dormant (they served those removed ops).
// -----------------------------------------------------------------------------
export const skillOperations = sqliteTable(
  'skill_operations',
  {
    opId: text('op_id').primaryKey(),
    skillId: text('skill_id').notNull(),
    kind: text('kind', {
      enum: ['reserve', 'migrate', 'delete', 'version-write'],
    }).notNull(),
    phase: text('phase').notNull(), // 'intent'|'fs-staged'|'fs-captured'|'fs-versioned'|'db-committed'|'done'
    active: integer('active').notNull().default(1), // 0|1 (CHECK in DDL)
    stagingPath: text('staging_path'),
    backupPath: text('backup_path'),
    candidatePath: text('candidate_path'),
    nextSkillId: text('next_skill_id'), // RFC-178: dormant (was replace's 2nd skillId)
    candidateFingerprint: text('candidate_fingerprint'),
    backupFingerprint: text('backup_fingerprint'),
    targetVersion: integer('target_version'),
    generation: integer('generation'),
    ownerUserId: text('owner_user_id'),
    preconditionJson: text('precondition_json'), // RFC-178: dormant (was adopt-managed precond)
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    // At most one active op per skill_id — per-skill recovery index + secondary
    // guard. The universal cross-op exclusion is skill_operation_locks.
    activeUq: uniqueIndex('uq_skill_operations_active')
      .on(t.skillId)
      .where(sql`${t.active} = 1`),
  }),
)

// -----------------------------------------------------------------------------
// skill_operation_locks — RFC-170 §6a/G6-2 universal mutual-exclusion primitive.
// Every op INSERTs a row per affected skillId in its intent tx; PK conflict on
// any target = 409 busy. Held until phase='done' (released same tx). This is
// what locks the SECOND id (replace's next_skill_id) that the ops-table
// partial-unique cannot. Boot recovers active ops (locks held) then GCs orphans.
// -----------------------------------------------------------------------------
export const skillOperationLocks = sqliteTable('skill_operation_locks', {
  lockedSkillId: text('locked_skill_id').primaryKey(),
  opId: text('op_id').notNull(),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})

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
    .default('public'), // legacy storage fallback; not the product create default
  aclRevision: integer('acl_revision').notNull().default(0), // RFC-170 §8 aclRevision CAS
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
// RFC-099/RFC-164 resource_grants — one generic per-user grant table for all
// six ACL'd resource types (agent / skill / mcp / plugin / workflow /
// workgroup) instead of six twin tables. A row = "this user can view + use
// this resource". Owner
// and admins are NOT materialised here — canViewResource short-circuits them.
// added_by/added_at are audit-only.
// -----------------------------------------------------------------------------
export const resourceGrants = sqliteTable(
  'resource_grants',
  {
    resourceType: text('resource_type', {
      enum: ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'],
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
// workgroups — RFC-164. Sixth ACL resource: agents (and humans) grouped into a
// runtime-collaborating team, launched as a task. `mode` picks the
// orchestration form (leader dispatches / leaderless free collaboration);
// the three switch columns control what each agent member gets injected per
// turn (design §6.2) — free_collab reads them as all-on regardless of storage
// (resolveWorkgroupSwitches). Launch snapshots the whole config onto the task
// (tasks.workgroup_config_json, PR-3), so later edits here only affect NEW
// tasks.
// -----------------------------------------------------------------------------
export const workgroups = sqliteTable(
  'workgroups',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Group charter — injected for EVERY member each turn (RFC-164 决策 #18). */
    instructions: text('instructions').notNull().default(''),
    mode: text('mode', { enum: ['leader_worker', 'free_collab', 'dynamic_workflow'] })
      .notNull()
      .default('leader_worker'),
    /** FK workgroup_members.id (soft — full-replace regenerates member rows).
     *  Required (app-enforced) when mode='leader_worker'; must be an agent member. */
    leaderMemberId: text('leader_member_id'),
    shareOutputs: integer('share_outputs', { mode: 'boolean' }).notNull().default(true),
    directMessages: integer('direct_messages', { mode: 'boolean' }).notNull().default(false),
    blackboard: integer('blackboard', { mode: 'boolean' }).notNull().default(false),
    /** Hard round cap (leader turns in lw / total member runs in fc, design §4.4). */
    maxRounds: integer('max_rounds').notNull().default(20),
    /** Completion gate: leader-done parks the task awaiting human confirmation. */
    completionGate: integer('completion_gate', { mode: 'boolean' }).notNull().default(false),
    /** RFC-180「全自动」: no clarify invite + gate treated off + leader-idle auto-nudge. */
    // RFC-207 — per-asker ask-back cap; see resolveClarifyBudget (shared).
    clarifyBudget: integer('clarify_budget').notNull().default(3),
    /** RFC-185 D4: opt-in leader fan-out (same-member concurrent instances).
     *  OFF (default) keeps the original one-entity-per-agent protocol untouched. */
    fanOut: integer('fan_out', { mode: 'boolean' }).notNull().default(false),
    /** RFC-225 optimistic content revision; ACL revisions remain independent. */
    version: integer('version').notNull().default(1),
    // RFC-099 ACL (see agents table comment).
    ownerUserId: text('owner_user_id'),
    visibility: text('visibility', { enum: ['private', 'public'] })
      .notNull()
      .default('public'), // legacy storage fallback; not the product create default
    aclRevision: integer('acl_revision').notNull().default(0), // RFC-170 §8 aclRevision CAS
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    ownerNameUq: uniqueIndex('workgroups_owner_name_unique').on(
      sql`COALESCE(${t.ownerUserId}, '')`,
      t.name,
    ),
  }),
)

// RFC-167 pivot (2026-07-11): the `dynamic_workflow_spaces` table (0088) was
// dropped (0089) — dynamic workflow became a workgroup mode, not a separate
// resource. See design/RFC-167-dynamic-workflow-space/design.md revision header.

// -----------------------------------------------------------------------------
// workgroup_members — RFC-164. Member roster of a workgroup. `display_name` is
// the group-unique addressing token (roster / @-mention / dispatch); for human
// members it is a REQUIRED alias so agent prompts never carry user ids
// (RFC-099 prompt-isolation invariant, design §11). Same agent appears at most
// once per group (multi-instance = multiple concurrent assignments, not rows).
// -----------------------------------------------------------------------------
export const workgroupMembers = sqliteTable(
  'workgroup_members',
  {
    id: text('id').primaryKey(), // ULID
    workgroupId: text('workgroup_id')
      .notNull()
      .references(() => workgroups.id, { onDelete: 'cascade' }),
    memberType: text('member_type', { enum: ['agent', 'human'] }).notNull(),
    /** memberType='agent': launch-time agents.name display snapshot.
     *  Never an identity selector; `agent_id` is the canonical reference. */
    agentName: text('agent_name'),
    /**
     * RFC-223 (PR-2): memberType='agent' canonical agents.id (ULID). Current
     * writes require the id and refresh `agent_name` only for display; launch
     * readiness validates the roster by id (rename-safe, ABA-safe). Nullable
     * only for quarantined/pre-0112 rows, which fail launch readiness.
     */
    agentId: text('agent_id'),
    /** memberType='human': users.id — audit/UI only, never injected into prompts. */
    userId: text('user_id'),
    displayName: text('display_name').notNull(),
    /** Group-internal role description shown in the roster (选人依据). */
    roleDesc: text('role_desc').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    displayNameUq: uniqueIndex('uq_workgroup_members_display').on(t.workgroupId, t.displayName),
    groupIdx: index('idx_workgroup_members_group').on(t.workgroupId),
  }),
)

// -----------------------------------------------------------------------------
// workgroup_assignments — RFC-164 PR-2 (design §1.4). Dispatch cards AND the
// free_collab shared task list in one table. `id` doubles as the member run's
// shard_key on the __wg_member__ host node (PR-3). Status machine lives in
// services/workgroup/lifecycle.ts — writes go through casAssignmentStatus, not
// raw UPDATEs. `created_by_user_id` is audit-only and never reaches prompts
// (design §11).
// -----------------------------------------------------------------------------
export const workgroupAssignments = sqliteTable(
  'workgroup_assignments',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    round: integer('round').notNull().default(0),
    source: text('source', { enum: ['leader', 'human', 'self_claim', 'system'] }).notNull(),
    createdByRunId: text('created_by_run_id'),
    createdByUserId: text('created_by_user_id'),
    /** NULL = free_collab open (unclaimed) task. */
    assigneeMemberId: text('assignee_member_id'),
    title: text('title').notNull(),
    briefMd: text('brief_md').notNull().default(''),
    status: text('status', {
      enum: [
        'open',
        'dispatched',
        'running',
        'awaiting_human',
        'delivered',
        'done',
        'failed',
        'canceled',
      ],
    }).notNull(),
    nodeRunId: text('node_run_id'),
    resultMessageId: text('result_message_id'),
    /** free_collab title-dedup key (normalizeWgTaskTitle), design §7.3. */
    dedupKey: text('dedup_key'),
    /**
     * RFC-215 §5 — 该卡被编入批次（open→dispatched CAS 成功）的累计次数；失败回
     * open 的预算判据（attempt_count < DEFAULT_PROTOCOL_RETRY_BUDGET）。批量
     * shardKey 下按 shard 数 node_runs 行的旧口径失效，改由本列单一记账。
     */
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    taskIdx: index('idx_wg_assign_task').on(t.taskId, t.status),
  }),
)

// -----------------------------------------------------------------------------
// workgroup_messages — RFC-164 PR-2 (design §1.5). The room = the blackboard:
// dispatch anchors, result summaries, human chat, system markers. Humans (task
// members) always see everything; what AGENTS see is sliced per the three
// switches (services/workgroup/context.ts). `author_user_id` is audit/UI only.
// Ordering key is the ULID id (lexical == chronological).
// -----------------------------------------------------------------------------
export const workgroupMessages = sqliteTable(
  'workgroup_messages',
  {
    id: text('id').primaryKey(), // ULID — room ordering key
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    round: integer('round').notNull().default(0),
    authorKind: text('author_kind', { enum: ['member', 'human', 'system'] }).notNull(),
    authorMemberId: text('author_member_id'),
    authorUserId: text('author_user_id'),
    kind: text('kind', {
      enum: ['chat', 'dispatch', 'result', 'delivery', 'decision', 'system', 'nudge'],
    }).notNull(),
    bodyMd: text('body_md').notNull(),
    /** JSON string[] of mentioned member ids. */
    mentionsJson: text('mentions_json').notNull().default('[]'),
    assignmentId: text('assignment_id'),
    // RFC-229 — direct message parent for message-turn outputs. Nullable for
    // every non-message-triggered row and pre-migration history.
    triggerMessageId: text('trigger_message_id').references(
      (): AnySQLiteColumn => workgroupMessages.id,
      { onDelete: 'set null' },
    ),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    taskIdx: index('idx_wg_msg_task').on(t.taskId, t.id),
  }),
)

// -----------------------------------------------------------------------------
// workgroup_task_state — RFC-217 T2 (design §2). Per-task workgroup RUNTIME
// state, extracted from the untyped `$.gate` / `$.dw` / `$.wgPause` slots that
// used to hide inside tasks.workgroup_config_json (three write styles, two
// writers, self-admitted concurrent-clobber risk). One row per workgroup task,
// created in the same transaction as the task INSERT; migration 0106 backfills
// stock rows and strips the retired JSON slots.
//
// gate_status is a REAL state machine (transition table + CAS live in
// services/workgroup/state.ts — the single codec; G3 grep-locks every other
// reader/writer out). 'declared' captures the historically two-write window
// between the leader's declare and the gate holder opening (design-gate P1).
// dw_state_json carries the COMPLETE DwState checkpoint (zod-validated,
// single writer) — phase-only columns would strand awaiting_confirm tasks
// (design-gate P1: generatedDef / rejectRounds / rejectionComment are load-
// bearing for confirm / reject / save-as).
// -----------------------------------------------------------------------------
export const workgroupTaskState = sqliteTable('workgroup_task_state', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  gateStatus: text('gate_status', {
    enum: ['idle', 'declared', 'awaiting_confirmation', 'approved', 'rejected'],
  })
    .notNull()
    .default('idle'),
  gateSummary: text('gate_summary'),
  gateRejectedComment: text('gate_rejected_comment'),
  pauseReason: text('pause_reason'),
  dwStateJson: text('dw_state_json'),
  /**
   * RFC-243 §6.4 (migration 0127): the explicit RESULT ANCHOR — the room
   * message id whose body IS the workgroup task's final result (lw: the
   * leader's done decision; fc: the engine's convergence summary). The
   * executor outcome projection reads THIS instead of guessing by
   * kind/author (the fc summary and the zero-delta warning share both).
   */
  resultMessageId: text('result_message_id'),
  updatedAt: integer('updated_at').notNull(),
})

// -----------------------------------------------------------------------------
// workgroup_member_cursors — RFC-164 PR-2 (design §1.6, 设计门 Finding-3).
// Per-(task, member) consumption watermark: the max message id already
// injected into that member (leader included). Advanced in the SAME
// transaction that mints the member's run — wake decisions (deriveWakeSet)
// are therefore idempotent across daemon restarts and message storms.
// -----------------------------------------------------------------------------
export const workgroupMemberCursors = sqliteTable(
  'workgroup_member_cursors',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Member id from tasks.workgroup_config_json (config snapshot ids). */
    memberId: text('member_id').notNull(),
    lastConsumedMessageId: text('last_consumed_message_id').notNull().default(''),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.memberId] }),
  }),
)

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
    // RFC-204: legacy plaintext column. The sealing gate blanks it to '' once
    // url_enc/url_redacted are populated; nothing reads it after that. Dropping
    // the column is deferred to 0099 (SQLite drop = table rebuild).
    url: text('url').notNull(),
    /** RFC-204: `secretBox.seal(原始URL)` — the ONLY place the credential lives. */
    urlEnc: text('url_enc'),
    /** RFC-204: `redactGitUrl(原始URL)` — the only form allowed out on the wire. */
    urlRedacted: text('url_redacted'),
    localPath: text('local_path').notNull(), // absolute path under ~/.agent-workflow/repos/
    defaultBranch: text('default_branch'), // nullable; null when HEAD was detached / unborn
    lastFetchedAt: integer('last_fetched_at').notNull(),
    createdAt: integer('created_at').notNull(),
    // RFC-034: submodule recursion telemetry. All three are nullable so legacy
    // pre-RFC-034 rows serialize cleanly until the next clone / refresh fills them.
    hasSubmodules: integer('has_submodules', { mode: 'boolean' }),
    lastSubmoduleSyncOk: integer('last_submodule_sync_ok', { mode: 'boolean' }),
    lastSubmoduleSyncError: text('last_submodule_sync_error'),
    /**
     * RFC-210 G7: last time the background refresh loop touched this mirror.
     * NULL = never, which makes pre-existing rows immediately due. Kept separate
     * from `lastFetchedAt` (which means "last successful fetch", including the
     * warm fetch a task launch performs) so the loop's cadence can be reasoned
     * about independently of task traffic.
     */
    lastAutoRefreshAt: integer('last_auto_refresh_at'),
  },
  (t) => ({
    lastFetchedIdx: index('idx_cached_repos_last_fetched').on(t.lastFetchedAt),
  }),
)

// -----------------------------------------------------------------------------
// repo_groups / repo_group_nodes — RFC-249. 仓库组是一棵显式目录树；repo/group
// 是目录节点上的可选 attachment，root path=''，纯目录也会持久化。
// -----------------------------------------------------------------------------
export const repoGroups = sqliteTable('repo_groups', {
  id: text('id').primaryKey(), // ULID
  name: text('name').notNull(), // migration 0131 建了 lower(name) 唯一索引
  description: text('description').notNull().default(''),
  /** PUT 时自增（与 workflows 同款）。启动时快照进 task_repos，不做漂移提示（D8）。 */
  version: integer('version').notNull().default(1),
  /**
   * 审计展示用，**不是** ACL owner——仓库组与 cached_repos 同类，不进 RFC-099
   * 的 owner + visibility + grants 体系，能力只由 `repos:*` 权限点治理（D5）。
   */
  createdByUserId: text('created_by_user_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
})

export const repoGroupNodes = sqliteTable(
  'repo_group_nodes',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => repoGroups.id, { onDelete: 'cascade' }),
    /** 相对组根的规范目录路径；'' = 显式 root。 */
    path: text('path').notNull(),
    /** NULL = 纯目录；一个节点至多挂 repo/group 之一。 */
    attachmentKind: text('attachment_kind', { enum: ['repo', 'group'] }),
    /**
     * kind='repo'。**刻意不加** onDelete cascade：删仓走 gitRepoCache 的显式
     * 守卫（409 列出引用它的组 + `force=1` 摘除，D13）。静默级联会让组悄悄
     * 变形，用户下次启动才发现少了一个仓。
     */
    cachedRepoId: text('cached_repo_id').references(() => cachedRepos.id),
    /** repo attachment：'' = 默认分支。 */
    ref: text('ref').notNull().default(''),
    /** repo attachment：'' = 整仓；否则 sparse checkout。 */
    subdir: text('subdir').notNull().default(''),
    /** group attachment。同样不 cascade——删组走显式 detach。 */
    childGroupId: text('child_group_id'),
    /** repo/group attachment 的只读标记；纯目录恒 false。 */
    readonly: integer('readonly', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.path] }),
    cachedRepoIdx: index('idx_rgn_cached_repo').on(t.cachedRepoId),
    childGroupIdx: index('idx_rgn_child_group').on(t.childGroupId),
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
    // tasks. RFC-204 verified this is ALREADY stored redacted (RFC-054 W3-4 writes
    // redactGitUrl(...) at insert), so it carries no credential — it just can't be
    // fed back into a launch. Relaunch/reuse goes through cached_repo_id below.
    repoUrl: text('repo_url'),
    /** RFC-204: cached mirror this task was materialized from (deterministic ref key). */
    cachedRepoId: text('cached_repo_id'),
    /**
     * RFC-248: 本任务是用哪个仓库组启动的。NULL = 单仓 / scratch 启动。
     * 只用于溯源、记忆注入（组 scope）与详情页 chip；**布局本身**已经快照进
     * `task_repos`，改组不影响在跑任务（D8）。
     */
    repoGroupId: text('repo_group_id'),
    /**
     * RFC-248（设计门 G5）: 组名的**快照**。组被删除后详情页的 chip 仍要能渲染
     * 名字，而不是退化成一个悬空 id。
     */
    repoGroupName: text('repo_group_name'),
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
    // RFC-207 §3.8 — ACCUMULATED time actually spent running. `startedAt` is wall
    // clock since creation and is never reset, so a task parked for days on a
    // question would be charged for the wait the instant a human answered. These
    // two are the real clock: `runningSince` is the current running stretch's
    // start (NULL when not running), `runningMs` the sum of the closed ones.
    runningMs: integer('running_ms').notNull().default(0),
    runningSince: integer('running_since'),
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
    // RFC-159: the scheduled_tasks row that auto-launched this task via the
    // background scheduler. NULL = manually launched. Durable link — a schedule's
    // run history + count derive from this column (stamped atomically inside the
    // task INSERT), so a failed post-launch bookkeeping write can't orphan the task.
    scheduledTaskId: text('scheduled_task_id'),
    // RFC-257 (设计门 F-8): the webhook trigger/fire that auto-launched this task.
    // NULL = not webhook-launched. Same durable-link discipline as scheduledTaskId
    // (stamped inside the task INSERT); soft links, no FK — mirrors RFC-159.
    webhookTriggerId: text('webhook_trigger_id'),
    webhookFireId: text('webhook_fire_id'),
    /** RFC-164: owning workgroup id (durable soft link; NULL = not a workgroup task). */
    workgroupId: text('workgroup_id'),
    /** RFC-164: launch snapshot + mid-run-editable copy of the group config
     *  (WorkgroupRuntimeConfig JSON). The engine reads THIS, never the resource row. */
    workgroupConfigJson: text('workgroup_config_json'),
    /**
     * RFC-165: execution-space kind. 'local' = legacy path-mode rows only
     * (backfilled by migration 0085, never written for new launches);
     * 'remote' = URL mode; 'scratch' = temporary space (workspace IS a fresh
     * git repo); 'internal' = framework-internal launches (fusion, via
     * `internalSource` — unreachable from the public wire); 'inherited' =
     * RFC-243 child execution running inside its parent's call-node iso (the
     * task does NOT own its disk space — delete/GC skip worktree removal).
     */
    spaceKind: text('space_kind', {
      enum: ['local', 'remote', 'scratch', 'internal', 'inherited'],
    })
      .notNull()
      .default('remote'),
    /** RFC-165/RFC-223: launch-time agent name for display only; NULL otherwise. */
    sourceAgentName: text('source_agent_name'),
    /**
     * RFC-175 (§2e): the launching agent's STABLE `agents.id` at launch time
     * (alongside the name soft-link). Lets "relaunch" faithfully verify the
     * subject on a post-migration task (an `expectedAgentId` OCC guard rejects
     * a delete+recreate-same-name replacement). NULL for non-agent tasks and
     * quarantined pre-migration rows; those rows fail closed rather than
     * resolving the display name against today's registry.
     */
    sourceAgentId: text('source_agent_id'),
    /**
     * RFC-165: two-phase workspace-GC tombstone. `workspace_pruning_at` is the
     * atomic CLAIM stamp (conditional UPDATE wins the right to delete; a stale
     * claim past the lease window may be re-claimed by GC). `workspace_pruned_at`
     * is written only AFTER the directory delete succeeded. Every revive path
     * (resume / retry / sync-workflow / lifecycle repair) CAS-es with
     * `pruning IS NULL AND pruned IS NULL` — pruned ⇒ 410, pruning ⇒ 409.
     */
    workspacePruningAt: integer('workspace_pruning_at'),
    workspacePrunedAt: integer('workspace_pruned_at'),
    /**
     * RFC-243 (migration 0126): parent linkage for node-invoked child
     * executions. `parent_task_id` = the invoking task (FK, subtree rows are
     * cascade-deleted with the parent; deleteTask gates active descendants
     * first); `parent_node_run_id` = the call node_run that launched this
     * child (soft link — node_runs rows are minted/superseded per retry, so
     * no FK). NULL/0 on every non-child task. Orthogonal to
     * `taskExecutionKind` — a child task's kind still derives from its own
     * workgroupId/sourceAgentName columns.
     */
    parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'cascade',
    }),
    parentNodeRunId: text('parent_node_run_id'),
    /** RFC-243: invocation-chain depth (root = 0); the launch-time depth guard input. */
    invocationDepth: integer('invocation_depth').notNull().default(0),
    /**
     * RFC-243 §3.1: the reference closure frozen at launch (workflow
     * definitions + workgroup config templates keyed by name). NULL when the
     * definition has no call nodes. NEVER serialized to any wire (TaskSchema
     * whitelist + regression lock) — child tasks re-expose only their own
     * workflowSnapshot through the existing member-gated surface.
     */
    refClosureJson: text('ref_closure_json'),
    /**
     * RFC-269: webhook 触发时快照的**事件变量投影**（RFC-263 的 29 项，剔除
     * `event_json`），供 `code-host-call` 节点的 `{{trigger.*}}` 取值。
     *
     * NULL = 该任务不是 webhook 触发的。这与「有上下文但某个变量恰好为空」是
     * 两回事：前者要给出「这个任务不是 webhook 起的」这句话，后者只是空串。
     *
     * 不存 `event_json` 原文：那是 32 KiB 截断的完整 payload，进一次外部 API
     * 调用没有用例，却会把外部原始数据的保留期从投递表的 90 天 GC 拉长到与任务
     * 同寿（design D15）。
     */
    triggerContextJson: text('trigger_context_json'),
    // （RFC-120 的 deferred_question_dispatch 列已由 RFC-132 T8 + migration 0073 物理删除——
    // universal deferred model 下所有任务同路径，无 per-task 开关。）
  },
  (t) => ({
    listStartedIdx: index('idx_tasks_list_started_id').on(t.startedAt, t.id),
    listStatusStartedIdx: index('idx_tasks_list_status_started_id').on(t.status, t.startedAt, t.id),
    listParentStartedIdx: index('idx_tasks_list_parent_started_id').on(
      t.parentTaskId,
      t.startedAt,
      t.id,
    ),
    listOwnerStartedIdx: index('idx_tasks_list_owner_started_id').on(
      t.ownerUserId,
      t.startedAt,
      t.id,
    ),
    workflowIdx: index('idx_tasks_workflow').on(t.workflowId, t.startedAt),
    schedTaskIdx: index('idx_tasks_scheduled_task').on(t.scheduledTaskId), // RFC-159
    webhookTriggerIdx: index('idx_tasks_webhook_trigger').on(t.webhookTriggerId), // RFC-257
  }),
)

// -----------------------------------------------------------------------------
// scheduled_tasks — RFC-159. A saved task-launcher the daemon re-fires on a
// schedule (interval or friendly preset). Stores the FULL StartTask launch body
// (JSON) so fires replay identical parameters. Member-based-private like tasks
// (owner_user_id + tasks:read:all admin bypass), NOT the RFC-099 five-type ACL.
// -----------------------------------------------------------------------------
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(), // management display name (≠ launch body.name)
    ownerUserId: text('owner_user_id').notNull(), // creator; fires launch as this user
    // RFC-165 §9b (0087): which subject face this schedule fires. Existing
    // rows are workflow schedules — the column default is the backfill.
    launchKind: text('launch_kind', { enum: ['workflow', 'agent', 'workgroup'] })
      .notNull()
      .default('workflow'),
    launchPayload: text('launch_payload').notNull(), // JSON: kind-enveloped launch body
    scheduleSpec: text('schedule_spec').notNull(), // JSON: ScheduleSpec (kind + creator tz)
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: integer('next_run_at'), // epoch ms of next fire; NULL when disabled (skips poll)
    lastRunAt: integer('last_run_at'), // slot time of the last recorded outcome (firedAt guard)
    lastStatus: text('last_status', { enum: ['launched', 'failed'] }),
    lastError: text('last_error'), // reason a fire produced NO task (ACL/owner/etc.)
    lastTaskId: text('last_task_id'), // best-effort pointer to the most recent launched task
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    dueIdx: index('idx_scheduled_tasks_due').on(t.enabled, t.nextRunAt), // poll scan surface
    ownerIdx: index('idx_scheduled_tasks_owner').on(t.ownerUserId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-257 — 代码平台 webhook 触发器（入站事件驱动任务）。
// webhook_endpoints: 全局接收端点（预期 1 行）；url_token 是寻址 + 弱凭据，
//   secret_enc（secretBox 密封）才是验签锚。删除 restrict（有 triggers 引用拒删，
//   服务层查询 + FK 兜底）。
// webhook_triggers: owner 制（沿 scheduled_tasks——设计门 F-9：fire 以 owner 身份
//   执行，ACL grants 写权 = 改绑目标后借 owner 身份的提权通道，故与 RFC-099 五类
//   ACL 明确划开）。规则列 repo_scope/event_types/ignore_usernames 是 JSON。
// webhook_deliveries: HTTP 投递一行（received/processing 中间态，D23 三段式）。
//   去重部分唯一索引在迁移 0138 手写（drizzle 索引声明不表达 partial WHERE）：
//   UNIQUE(endpoint_id,event_uuid) WHERE event_uuid IS NOT NULL
//     AND status NOT IN ('rejected','failed')
// webhook_trigger_fires: delivery × trigger 命中一行（outcome/supersede/task 链）。
// webhook_trigger_streams: (trigger, stream) 熔断计数（D22 三重置源）。
// fires/streams 对 trigger 是 ON DELETE CASCADE（运行时 foreign_keys=ON，
//   client.ts:121）；deliveries 无 FK——endpoint 删除后审计行保留待 GC。
// -----------------------------------------------------------------------------
export const webhookEndpoints = sqliteTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(),
    // RFC-259：值域扩 github。TS 层 enum；DB 列无 CHECK（迁移 0138），扩值零迁移。
    provider: text('provider', { enum: ['gitlab', 'github'] }).notNull(),
    urlToken: text('url_token').notNull(),
    secretEnc: text('secret_enc').notNull(), // secretBox.seal(secret)
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    preferredCloneProtocol: text('preferred_clone_protocol', { enum: ['http', 'ssh'] })
      .notNull()
      .default('http'),
    lastDeliveryAt: integer('last_delivery_at'),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    urlTokenUq: uniqueIndex('idx_webhook_endpoints_url_token').on(t.urlToken),
  }),
)

export const webhookTriggers = sqliteTable(
  'webhook_triggers',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    ownerUserId: text('owner_user_id').notNull(), // fire launches as this user
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    repoScope: text('repo_scope').notNull(), // JSON WebhookRepoScope
    eventTypes: text('event_types').notNull(), // JSON CodeHostEventType[]
    branchFilter: text('branch_filter'), // glob; NULL = no filter
    commandPrefix: text('command_prefix'), // note-event command; NULL = none
    ignoreUsernames: text('ignore_usernames').notNull().default('[]'), // JSON string[]
    launchKind: text('launch_kind', { enum: ['workflow', 'agent', 'workgroup'] }).notNull(),
    launchRefId: text('launch_ref_id').notNull(), // workflowId/agentId/workgroupId（单一事实源）
    launchPayload: text('launch_payload').notNull(), // JSON 模板封套（webhookPayloadTemplateSchemaFor）
    maxConsecutiveFires: integer('max_consecutive_fires').notNull().default(3),
    autoRegisterRepos: integer('auto_register_repos', { mode: 'boolean' }).notNull().default(true),
    lastFiredAt: integer('last_fired_at'),
    lastStatus: text('last_status', { enum: ['launched', 'failed'] }),
    lastError: text('last_error'),
    lastTaskId: text('last_task_id'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0), // 启动失败计数 ≠ 熔断 fire 计数
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    endpointEnabledIdx: index('idx_webhook_triggers_endpoint_enabled').on(t.endpointId, t.enabled),
    ownerIdx: index('idx_webhook_triggers_owner').on(t.ownerUserId),
  }),
)

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(), // ULID
    endpointId: text('endpoint_id').notNull(), // soft link（endpoint 删除后审计行保留）
    eventUuid: text('event_uuid'), // X-Gitlab-Event-UUID；NULL = 无去重（降级）/重放行
    attemptCount: integer('attempt_count').notNull().default(1), // 同 UUID 重投 bump（F-11）
    gitlabEventHeader: text('gitlab_event_header'),
    objectKind: text('object_kind'),
    eventType: text('event_type'), // 归一化摘要列（列表页免解析 body）
    repoPath: text('repo_path'),
    streamHint: text('stream_hint'),
    status: text('status', {
      enum: ['received', 'processing', 'rejected', 'ignored', 'matched', 'failed'],
    }).notNull(),
    statusReason: text('status_reason'),
    replayedFromDeliveryId: text('replayed_from_delivery_id'),
    receivedAt: integer('received_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // RFC-261（迁移 0139 表重建）：body_json 必须是末列——大 body 走 overflow 链，
    // 排它后面的列会让不取 body 的列表投影也走完整条链。
    bodyJson: text('body_json'), // ≤256KiB 截断入库；保留期后置空（F-12 GC）
  },
  (t) => ({
    // 去重 partial unique index（0138）与 body-retention partial index（0139，
    // WHERE body_json IS NOT NULL）在迁移手写；这里只声明普通查询索引。
    // RFC-261 索引策略（10 万投递/天基准）：每个过滤维度 × received_at 组合，
    // 过滤前缀 + 时间序游走 + LIMIT 早停；单列 status 索引已被组合索引取代。
    endpointTimeIdx: index('idx_webhook_deliveries_endpoint_time').on(t.endpointId, t.receivedAt),
    receivedAtIdx: index('idx_webhook_deliveries_received_at').on(t.receivedAt),
    statusTimeIdx: index('idx_webhook_deliveries_status_time').on(t.status, t.receivedAt),
    eventTimeIdx: index('idx_webhook_deliveries_event_time').on(t.eventType, t.receivedAt),
    repoTimeIdx: index('idx_webhook_deliveries_repo_time').on(t.repoPath, t.receivedAt),
  }),
)

export const webhookTriggerFires = sqliteTable(
  'webhook_trigger_fires',
  {
    id: text('id').primaryKey(), // ULID
    deliveryId: text('delivery_id').notNull(), // soft link（delivery 90 天 GC 不级联）
    triggerId: text('trigger_id')
      .notNull()
      .references(() => webhookTriggers.id, { onDelete: 'cascade' }),
    streamKey: text('stream_key').notNull(), // `${repoPath}|mr:${iid}` / `${repoPath}|branch:${branch}`（F-2：必含 repo 维度）
    outcome: text('outcome', {
      enum: [
        'launched',
        'launch-failed',
        'skipped-circuit-open',
        'skipped-repo-unregistered',
        'skipped-owner-invalid',
        'skipped-trigger-disabled',
      ],
    }).notNull(),
    supersededTaskId: text('superseded_task_id'), // 本次 fire 取消的旧任务
    taskId: text('task_id'),
    error: text('error'),
    firedAt: integer('fired_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    triggerTimeIdx: index('idx_webhook_fires_trigger_time').on(t.triggerId, t.firedAt),
    deliveryIdx: index('idx_webhook_fires_delivery').on(t.deliveryId),
    streamIdx: index('idx_webhook_fires_stream').on(t.triggerId, t.streamKey, t.firedAt), // supersede 查询面
  }),
)

export const webhookTriggerStreams = sqliteTable(
  'webhook_trigger_streams',
  {
    triggerId: text('trigger_id')
      .notNull()
      .references(() => webhookTriggers.id, { onDelete: 'cascade' }),
    streamKey: text('stream_key').notNull(),
    consecutiveFires: integer('consecutive_fires').notNull().default(0),
    lastFireAt: integer('last_fire_at'),
    resetAt: integer('reset_at'),
    resetBy: text('reset_by'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.triggerId, t.streamKey] }),
  }),
)

// -----------------------------------------------------------------------------
// code_host_connections — RFC-269. The administrator-configured outbound
// credential, at most ONE ROW PER PROVIDER (user decision Q2/Q12: one global
// set, per code host).
//
// Why DB + secretBox rather than `~/.agent-workflow/config.json`: that file is
// plaintext on disk AND `GET /api/config` returns the whole document to the
// frontend, so a token there would need its own masking layer to stay secret.
// Every credential the platform already holds (webhook_endpoints.secret_enc,
// oidc_providers.client_secret_enc, cached_repos.url_enc) is sealed in the DB;
// this follows that path instead of inventing a second posture.
//
// Losing `~/.agent-workflow/secret.key` makes these unreadable — identical to
// the webhook ingress secret, so disaster recovery gains one line ("re-enter
// the code-host tokens"), not a new mechanism.
// -----------------------------------------------------------------------------
export const codeHostConnections = sqliteTable('code_host_connections', {
  provider: text('provider', { enum: ['gitlab', 'github'] }).primaryKey(),
  /** Normalized API root, no trailing slash (`https://host/api/v4`). */
  baseUrl: text('base_url').notNull(),
  tokenEnc: text('token_enc').notNull(), // secretBox.seal(token)
  /** Last 4 chars — the ONLY part any read path ever returns. */
  tokenHint: text('token_hint').notNull(),
  /** Last "test connection" result (JSON). Display only; never an admission input. */
  lastTestJson: text('last_test_json'),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedBy: text('updated_by'), // users.id (audit)
})

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
    /**
     * RFC-204: cached mirror backing this repo entry. Replaces the old
     * `cached_repos.url == task_repos.repo_url` plaintext join (impossible once
     * the URL is sealed under a random IV) for refTaskCount, the cache-delete
     * guard and repo-scoped memory resolution.
     */
    cachedRepoId: text('cached_repo_id'),
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
    /**
     * RFC-248: 相对任务根（cwd）的挂载路径；'' = 挂在根。**取代**
     * `worktree_dir_name` 成为规范的仓 key（文本 diff 分段头 / 结构化 diff id
     * 前缀 / 扇出 shard_key 三处同源）。migration 0131 从 `worktree_dir_name`
     * backfill——存量多仓是平铺布局，basename 就**是**它的挂载路径，所以历史
     * 审阅锚点不变。`worktree_dir_name` 在 T26（调用点全部迁完）后删除。
     */
    mountPath: text('mount_path').notNull().default(''),
    /** RFC-248: '' = 整仓；否则该成员是 sparse 检出（只有这个仓内子目录落盘）。 */
    subdir: text('subdir').notNull().default(''),
    /**
     * RFC-248 D11: 只读成员——不写 pre_snapshot、resume 不回滚、不进 git_diff /
     * 任务 diff / 结构化 diff、不参与自动提交推送；任务收尾时若检出 dirty 就发
     * 一条告警（不改任务状态）。
     */
    readonly: integer('readonly', { mode: 'boolean' }).notNull().default(false),
    /**
     * RFC-248 AC-19: 只读成员被丢弃的改动处数。NULL = 从未检查（存量行 / 可写
     * 成员）；0 = 检查过且干净；N>0 = 有 N 处改动**没有**被提交推送。
     *
     * 框架不在文件系统层面阻止写入只读成员，所以「agent 改了但什么都没推」是
     * 真实可能发生的事。只落 log.warn 等于静默——这一列让任务详情看得见。
     */
    readonlyDirtyCount: integer('readonly_dirty_count'),
    /**
     * RFC-248 D1: 平台预置 commit 的 sha——把嵌套挂载点写进本仓 `.gitignore`
     * 并提交的那一笔，`base_commit` 指向它。单独存一列，让「这一笔到底是不是
     * 平台造的」在排错与 UI 上一眼可判，也让「它的父提交才是真 base tip」可推导。
     * NULL = 本仓没有嵌套子成员，未产生预置 commit。
     */
    gitignoreCommit: text('gitignore_commit'),
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
    // RFC-204: refTaskCount / the cache-delete guard evaluate this once per
    // listed cache row — unindexed it degenerates into repeated full scans.
    cachedRepoIdIdx: index('idx_task_repos_cached_repo_id').on(t.cachedRepoId),
  }),
)

// RFC-249 — frozen explicit directory tree. Old tasks have zero rows and are
// replayed from task_repos.mount_path + ancestor closure.
export const taskSpaceNodes = sqliteTable(
  'task_space_nodes',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    nodePath: text('node_path').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({ pk: primaryKey({ columns: [t.taskId, t.nodePath] }) }),
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
     * RFC-189 — the leader_worker workgroup ROUND this host run belongs to
     * (1-based; migration 0095 backfills). Splits the round ordinal OUT of
     * retryIndex, which workgroup mints historically overloaded as
     * "prior-row count + attempt"（前端误标事故 d1248df4）. NULL on every
     * non-workgroup row, on `__wg_clarify__` rows, and on free_collab rows —
     * fc 的轮预算本质是「行计数」而非序数，保持计数制（design §1 修订）.
     */
    wgRound: integer('wg_round'),
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
    // RFC-200 (T1): per-run envelope nonce. Generated (crypto random) + persisted
    // at dispatch; the protocol block emits `<workflow-output nonce="…">` and the
    // parser (T3) only accepts THIS run's nonce, so an echoed/forged bare envelope
    // is not采信 (closes the "echo-forge + last-wins" vector). Reused on resume /
    // followup so an inline session's earlier nonce stays valid. NULL = a run
    // dispatched before RFC-200 (parser falls back to bare-tag matching).
    envelopeNonce: text('envelope_nonce'),
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
    /**
     * RFC-210: submodule topology captured when this node's iso worktree was
     * created — base commit per submodule path, the shared object pool dir, and
     * (later, at merge-back) any sub-paths whose conflict is still unresolved.
     * Shape: `IsoSubmodulesSchema` in @agent-workflow/shared.
     *
     * Single/multi split for the same reason as the pair above: a multi-repo
     * task has one topology PER REPO, and a flat map would let two repos that
     * both contain e.g. `vendor` clobber each other. Crash replay reads these
     * back (a node whose repo has `.gitmodules` but no row here is refused
     * rather than replayed as a parent-only merge, which would silently
     * overwrite a sibling node's submodule commits).
     */
    isoSubmodulesJson: text('iso_submodules_json'),
    isoSubmodulesReposJson: text('iso_submodules_repos_json'),
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
    /**
     * RFC-223 (PR-3a) — the CANONICAL id of the borrowed / workgroup-member
     * agent this row runs under (sibling of `agent_override_name`, which stays
     * for display). Every producer that stamps `agent_override_name` also
     * stamps this (workgroup member turns, RFC-127 借壳). Consumers that map a
     * run back to its agent resolve only by this id; id-less legacy rows fail
     * closed instead of binding a current same-name resource. NEVER enters a
     * prompt.
     */
    agentOverrideId: text('agent_override_id'),
    /**
     * RFC-243: the child task a call node_run launched (call-workflow /
     * call-workgroup rows only, NULL everywhere else). Soft link on purpose —
     * a deleted child resolves to the `child-deleted` failure mapping instead
     * of breaking FK integrity for the historical run row. Doubles as the
     * liveness-delegation anchor (runLiveness: child task non-terminal ⇒ the
     * call row is alive) and the resume re-attach anchor (design §4.2).
     */
    childTaskId: text('child_task_id'),
  },
  (t) => ({
    taskIdx: index('idx_node_runs_task').on(t.taskId, t.nodeId, t.iteration, t.retryIndex),
    parentIdx: index('idx_node_runs_parent').on(t.parentNodeRunId),
    childTaskIdx: index('idx_node_runs_child_task').on(t.childTaskId), // RFC-243
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
    // RFC-193: archive-at-emit reference for path-shaped ports. JSON
    // `{ v:1, items:[{ path, file, size, truncated }] }` — `path` is the
    // container-relative source path, `file` the appHome-relative archived
    // copy (null when an oversized binary was metadata-only archived). NULL
    // for pre-RFC-193 rows (readers fall back to the worktree) and for
    // non-path kinds (content is the body itself).
    archiveJson: text('archive_json'),
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
// RFC-058 clarify_rounds — unified replacement for the RFC-023 self-clarify
// and RFC-056 cross-clarify legacy tables (both dropped by migration 0107,
// RFC-217 T8). The `kind` discriminator decides
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
    // RFC-059 per-question scope column. RFC-162 DELETED scope — DORMANT (never read/written).
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
    // RFC-207 — which ASKER inside that node the directive applies to. A workgroup
    // runs every member assignment on one shared host node id, so a node-level row
    // would silence every worker at once instead of the one that asked. '' means
    // node-level (the canvas toggle, and every non-sharded asker); a real key
    // targets one asker. NOT NULL with an '' sentinel rather than nullable,
    // because SQLite does not imply NOT NULL on PRIMARY KEY columns in an ordinary
    // rowid table — NULLs there would let duplicate rows through.
    shardKey: text('shard_key').notNull().default(''),
    directive: text('directive', { enum: ['continue', 'stop'] }).notNull(),
    // Task-member user id who last set it (UI/audit only).
    setBy: text('set_by'),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.nodeId, t.shardKey] }),
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
    // RFC-222 — 'manager' (资源管理员) added. Type-only widening: the SQLite
    // column has no CHECK constraint (0018_rfc036_users.sql), so no migration.
    role: text('role', { enum: ['admin', 'user', 'manager'] })
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
    /**
     * RFC-247 — which channel this token may use.
     *   'general'  : /api/* and /api/mcp
     *   'mcp_only' : /api/mcp only; any business route 403s `token-mcp-only`
     * The DB default exists for schema sanity only — migration 0129 revokes
     * every pre-RFC-247 row, so no live token silently inherits it.
     */
    purpose: text('purpose').notNull().default('general'),
  },
  (t) => ({
    userIdx: index('idx_user_pats_user').on(t.userId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-247 token_audit — one row per call made with a token.
//
// Deliberately does NOT store the request body. `resource_write` bodies carry
// MCP `env` values and repo credentials; an audit table holding secrets is a
// new breach surface, not a control. Metadata answers "who did what to which
// resource, and did it succeed", which is what an operator actually needs.
// -----------------------------------------------------------------------------
export const tokenAudit = sqliteTable(
  'token_audit',
  {
    id: text('id').primaryKey(),
    /** No FK cascade on purpose: revoking a token must not erase its history. */
    patId: text('pat_id').notNull(),
    userId: text('user_id').notNull(),
    /** 'mcp' | 'rest' */
    channel: text('channel').notNull(),
    toolName: text('tool_name'),
    method: text('method'),
    path: text('path'),
    resourceKind: text('resource_kind'),
    resourceId: text('resource_id'),
    statusCode: integer('status_code').notNull(),
    /**
     * RFC-247 F14 — the delete snapshot was attempted and could not be stored.
     * Without it a row with missing evidence is indistinguishable from a row
     * that never needed any.
     */
    snapshotFailed: integer('snapshot_failed', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    userIdx: index('idx_token_audit_user_created').on(t.userId, t.createdAt),
    patIdx: index('idx_token_audit_pat_created').on(t.patId, t.createdAt),
    createdIdx: index('idx_token_audit_created').on(t.createdAt),
  }),
)

// -----------------------------------------------------------------------------
// RFC-247 token_delete_snapshot — what a token-issued DELETE removed.
//
// Metadata alone answers "who deleted what" but not "what was it", and the
// second question is the one that matters once the row is gone. Snapshots are
// redacted by services/tokenRedaction.ts before insert and expire on the same
// retention clock as the audit rows.
// -----------------------------------------------------------------------------
export const tokenDeleteSnapshot = sqliteTable(
  'token_delete_snapshot',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    auditIdx: index('idx_token_delete_snapshot_audit').on(t.auditId),
    createdIdx: index('idx_token_delete_snapshot_created').on(t.createdAt),
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
    // RFC-220 — manual endpoint fallbacks + pure-OAuth2 identity knobs.
    authorizationEndpoint: text('authorization_endpoint'),
    tokenEndpoint: text('token_endpoint'),
    userinfoEndpoint: text('userinfo_endpoint'),
    // RFC-220 D8 — how userinfo is invoked: standard GET+Bearer, or the
    // non-standard POST { client_id, access_token, scope } JSON body.
    userinfoRequestStyle: text('userinfo_request_style', {
      enum: ['get_bearer', 'post_json'],
    })
      .notNull()
      .default('get_bearer'),
    jwksUri: text('jwks_uri'),
    trustEmailVerified: integer('trust_email_verified', { mode: 'boolean' })
      .notNull()
      .default(false),
    usernameClaim: text('username_claim'),
    subjectClaim: text('subject_claim'),
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
    // RFC-220 D7 — last-seen IdP presented-name (composePreferred) snapshot.
    // '' = observed-but-absent sentinel; NULL only on pre-RFC-220 rows (legacy
    // rows must NOT have their displayName overwritten on first sight).
    preferredSnapshot: text('preferred_snapshot'),
    linkedAt: integer('linked_at').notNull(),
  },
  (t) => ({
    userIdx: index('idx_user_identities_user').on(t.userId),
    providerIdx: index('idx_user_identities_provider').on(t.providerId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-221 auth_login_policy — singleton login-method policy. NULL
// bootstrapCompletedAt means the daemon token is a restricted first-admin
// credential; non-NULL permanently retires that external credential.
// -----------------------------------------------------------------------------
export const authLoginPolicy = sqliteTable('auth_login_policy', {
  id: text('id').primaryKey(),
  passwordLoginEnabled: integer('password_login_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  bootstrapCompletedAt: integer('bootstrap_completed_at'),
  updatedAt: integer('updated_at').notNull(),
})

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
    // RFC-248: 第 5 种 scope `repo_group`（migration 0132 同步扩了 CHECK）。
    scopeType: text('scope_type', {
      enum: ['agent', 'workflow', 'repo', 'repo_group', 'global'],
    }).notNull(),
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
    // RFC-223 PR-4: immutable provenance identity. Historical rows that cannot
    // be proven from a committed fusion/version relation carry the quarantine
    // sentinel instead of being rebound from the mutable display name.
    fusedIntoSkillId: text('fused_into_skill_id'),
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
    fusedSkillIdx: index('idx_memories_fused_skill_id').on(
      t.fusedIntoSkillId,
      t.fusedIntoSkillVersion,
    ),
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
    // RFC-223 PR-4: canonical target identity. `skill_name` remains display-only.
    // The migration quarantines unprovable historical rows with a non-resolving
    // sentinel; every new launch persists the authorized immutable skills.id.
    skillId: text('skill_id').notNull(),
    skillName: text('skill_name').notNull(),
    baseSkillVersion: integer('base_skill_version').notNull(), // OCC baseline
    // RFC-170 §2 (migration 0090): full composite precondition token captured at
    // initiate; approve does an in-tx CAS on it. NULL on legacy awaiting-approval
    // rows → approve fails closed and prompts a re-initiate. Dormant until T6.
    preconditionToken: text('precondition_token'),
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
    skillIdx: index('idx_fusions_skill').on(t.skillId),
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
    // RFC-162: 'echo' 已删（归一后提问节点恒在处理组、恒有自己那份 Q&A，无需回执补投）。
    // drizzle enum 纯类型层、无 CHECK 约束 → 收窄零 DDL（迁移 0081 只删存量 echo 行）。
    roleKind: text('role_kind', { enum: ['self', 'questioner', 'designer'] }).notNull(),
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

// -----------------------------------------------------------------------------
// RFC-224 — immutable OpenCode session provenance + single-writer lease.
//
// Multiple node_runs may link to one session during inline resume; this table
// is the sole owner. Only task_id is a physical FK: created/lease run ids are
// logical pointers so pruning run history cannot cascade-delete session state.
// -----------------------------------------------------------------------------
export const opencodeSessionOwners = sqliteTable(
  'opencode_session_owners',
  {
    sessionId: text('session_id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    createdNodeRunId: text('created_node_run_id').notNull(),
    identityDigest: text('identity_digest').notNull(),
    runtimeBinaryDigest: text('runtime_binary_digest').notNull(),
    sessionContractDigest: text('session_contract_digest').notNull(),
    sessionStoreKey: text('session_store_key').notNull(),
    projectId: text('project_id').notNull(),
    protocolCodec: text('protocol_codec').notNull(),
    reportedVersion: text('reported_version'),
    leaseNodeRunId: text('lease_node_run_id'),
    leaseNonceDigest: text('lease_nonce_digest'),
    leasedAt: integer('leased_at'),
  },
  (t) => ({
    sessionStoreKeyUnique: uniqueIndex('uniq_opencode_session_owners_store_key').on(
      t.sessionStoreKey,
    ),
    taskIdx: index('idx_opencode_session_owners_task').on(t.taskId),
    createdRunIdx: index('idx_opencode_session_owners_created_run').on(t.createdNodeRunId),
    leaseRunIdx: index('idx_opencode_session_owners_lease_run').on(t.leaseNodeRunId),
    leaseAllOrNone: check(
      'opencode_session_owners_lease_all_or_none',
      sql`(
        (
          ${t.leaseNodeRunId} IS NULL
          AND ${t.leaseNonceDigest} IS NULL
          AND ${t.leasedAt} IS NULL
        )
        OR
        (
          ${t.leaseNodeRunId} IS NOT NULL
          AND ${t.leaseNonceDigest} IS NOT NULL
          AND ${t.leasedAt} IS NOT NULL
        )
      )`,
    ),
  }),
)

// -----------------------------------------------------------------------------
// RFC-238 — private, multi-turn MCP runtime playground state.
//
// A logical test session owns one runtime-native conversation and accepts at
// most one turn at a time. Closing the UI never mutates these rows; only an
// accepted message clears the idle deadline, and turn settlement reinstates the
// 10-minute deadline. MCP/user FKs are RESTRICT so destructive resource
// mutations must first cross the process-reap + store-cleanup barrier.
// -----------------------------------------------------------------------------
export const mcpRuntimeTestSessions = sqliteTable(
  'mcp_runtime_test_sessions',
  {
    id: text('id').primaryKey(),
    mcpId: text('mcp_id')
      .notNull()
      .references(() => mcps.id, { onDelete: 'restrict' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    clientCreateId: text('client_create_id').notNull(),
    clientCreateDigest: text('client_create_digest').notNull(),
    status: text('status', { enum: ['active', 'ending', 'ended'] }).notNull(),
    endReason: text('end_reason', {
      enum: [
        'user',
        'idle-timeout',
        'mcp-deleted',
        'mcp-disabled',
        'mcp-config-changed',
        'access-revoked',
        'runtime-disabled',
        'runtime-deleted',
        'runtime-profile-changed',
        'runtime-identity-changed',
        'capture-truncated',
        'capture-incomplete',
        'session-unusable',
      ],
    }),
    mcpConfigHash: text('mcp_config_hash').notNull(),
    runtimeRowId: text('runtime_row_id').notNull(),
    runtimeName: text('runtime_name').notNull(),
    runtimeProtocol: text('runtime_protocol', {
      enum: ['opencode', 'claude-code'],
    }).notNull(),
    /** Secret-free frozen runtime profile used for resume drift checks. */
    runtimeSnapshotJson: text('runtime_snapshot_json').notNull(),
    runtimeFingerprint: text('runtime_fingerprint').notNull(),
    /** Internal-only exact executable path; never projected to the API. */
    runtimeBinaryPath: text('runtime_binary_path').notNull(),
    runtimeBinaryDigest: text('runtime_binary_digest'),
    mcpExecutionDigest: text('mcp_execution_digest'),
    sessionContractDigest: text('session_contract_digest'),
    runtimeSessionId: text('runtime_session_id'),
    nativeSessionState: text('native_session_state', {
      enum: ['pending', 'ready', 'unusable'],
    })
      .notNull()
      .default('pending'),
    inFlightTurnId: text('in_flight_turn_id'),
    turnSeq: integer('turn_seq').notNull().default(0),
    sessionVersion: integer('session_version').notNull().default(0),
    idleDeadlineAt: integer('idle_deadline_at'),
    continuationBlockedReason: text('continuation_blocked_reason', {
      enum: [
        'mcp-config-changed',
        'runtime-profile-changed',
        'runtime-identity-changed',
        'mcp-execution-changed',
        'capture-truncated',
        'capture-incomplete',
        'session-root-mismatch',
        'session-store-missing',
      ],
    }),
    scratchRoot: text('scratch_root').notNull(),
    sessionStoreRoot: text('session_store_root').notNull(),
    sessionStoreDbPath: text('session_store_db_path'),
    cleanupState: text('cleanup_state', {
      enum: ['not-started', 'pending', 'complete', 'quarantined'],
    })
      .notNull()
      .default('not-started'),
    cleanupErrorCode: text('cleanup_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => ({
    ownerMcpLiveUnique: uniqueIndex('uniq_mcp_runtime_test_sessions_owner_mcp_live')
      .on(t.mcpId, t.ownerUserId)
      .where(sql`${t.status} IN ('active', 'ending')`),
    createUnique: uniqueIndex('uniq_mcp_runtime_test_sessions_create').on(
      t.mcpId,
      t.ownerUserId,
      t.clientCreateId,
    ),
    ownerMcpUpdatedIdx: index('idx_mcp_runtime_test_sessions_owner_mcp_updated').on(
      t.ownerUserId,
      t.mcpId,
      t.updatedAt,
    ),
    idleIdx: index('idx_mcp_runtime_test_sessions_idle').on(t.status, t.idleDeadlineAt),
    statusShape: check(
      'mcp_runtime_test_sessions_status_shape',
      sql`(
        (
          ${t.status} = 'active'
          AND ${t.endReason} IS NULL
          AND ${t.endedAt} IS NULL
          AND (
            (${t.inFlightTurnId} IS NOT NULL AND ${t.idleDeadlineAt} IS NULL)
            OR
            (
              ${t.inFlightTurnId} IS NULL
              AND ${t.idleDeadlineAt} IS NOT NULL
              AND ${t.nativeSessionState} = 'ready'
              AND ${t.continuationBlockedReason} IS NULL
            )
          )
        )
        OR
        (
          ${t.status} = 'ending'
          AND ${t.endReason} IS NOT NULL
          AND ${t.endedAt} IS NULL
          AND ${t.idleDeadlineAt} IS NULL
        )
        OR
        (
          ${t.status} = 'ended'
          AND ${t.endReason} IS NOT NULL
          AND ${t.endedAt} IS NOT NULL
          AND ${t.inFlightTurnId} IS NULL
          AND ${t.idleDeadlineAt} IS NULL
        )
      )`,
    ),
    hashShape: check(
      'mcp_runtime_test_sessions_hash_shape',
      sql`length(${t.clientCreateDigest}) = 64
        AND ${t.clientCreateDigest} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.mcpConfigHash}) = 64
        AND ${t.mcpConfigHash} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.runtimeFingerprint}) = 64
        AND ${t.runtimeFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    enumShape: check(
      'mcp_runtime_test_sessions_enum_shape',
      sql`${t.status} IN ('active', 'ending', 'ended')
        AND ${t.runtimeProtocol} IN ('opencode', 'claude-code')
        AND ${t.nativeSessionState} IN ('pending', 'ready', 'unusable')
        AND ${t.cleanupState} IN ('not-started', 'pending', 'complete', 'quarantined')
        AND (
          ${t.endReason} IS NULL
          OR ${t.endReason} IN (
            'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled',
            'mcp-config-changed', 'access-revoked', 'runtime-disabled',
            'runtime-deleted', 'runtime-profile-changed',
            'runtime-identity-changed', 'capture-truncated',
            'capture-incomplete', 'session-unusable'
          )
        )
        AND (
          ${t.continuationBlockedReason} IS NULL
          OR ${t.continuationBlockedReason} IN (
            'mcp-config-changed', 'runtime-profile-changed',
            'runtime-identity-changed', 'mcp-execution-changed',
            'capture-truncated', 'capture-incomplete',
            'session-root-mismatch', 'session-store-missing'
          )
        )
        AND ${t.turnSeq} >= 0
        AND ${t.sessionVersion} >= 0`,
    ),
    digestShape: check(
      'mcp_runtime_test_sessions_digest_shape',
      sql`(
        (
          ${t.runtimeBinaryDigest} IS NULL
          AND ${t.mcpExecutionDigest} IS NULL
          AND ${t.sessionContractDigest} IS NULL
        )
        OR
        (
          ${t.runtimeBinaryDigest} IS NOT NULL
          AND ${t.mcpExecutionDigest} IS NOT NULL
          AND ${t.sessionContractDigest} IS NOT NULL
          AND length(${t.runtimeBinaryDigest}) = 64
          AND ${t.runtimeBinaryDigest} NOT GLOB '*[^0-9a-f]*'
          AND length(${t.mcpExecutionDigest}) = 64
          AND ${t.mcpExecutionDigest} NOT GLOB '*[^0-9a-f]*'
          AND length(${t.sessionContractDigest}) = 64
          AND ${t.sessionContractDigest} NOT GLOB '*[^0-9a-f]*'
        )
      )`,
    ),
  }),
)

export const mcpRuntimeTestTurns = sqliteTable(
  'mcp_runtime_test_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => mcpRuntimeTestSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    clientMessageId: text('client_message_id').notNull(),
    promptText: text('prompt_text').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted'],
    }).notNull(),
    hardDeadlineAt: integer('hard_deadline_at').notNull(),
    captureState: text('capture_state', {
      enum: ['live', 'complete', 'truncated', 'incomplete'],
    })
      .notNull()
      .default('live'),
    captureIncompleteReason: text('capture_incomplete_reason'),
    captureFirstEventSeq: integer('capture_first_event_seq'),
    captureLastEventSeq: integer('capture_last_event_seq').notNull().default(0),
    captureEventBytes: integer('capture_event_bytes').notNull().default(0),
    cancelRequestedAt: integer('cancel_requested_at'),
    pid: integer('pid'),
    spawnedAt: integer('spawned_at'),
    spawnBinaryPath: text('spawn_binary_path'),
    rawCommandDigest: text('raw_command_digest'),
    spawnCommandDigest: text('spawn_command_digest'),
    exitCode: integer('exit_code'),
    failureCode: text('failure_code'),
    stderrTail: text('stderr_tail'),
    durationMs: integer('duration_ms'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex('uniq_mcp_runtime_test_turns_session_seq').on(t.sessionId, t.seq),
    messageUnique: uniqueIndex('uniq_mcp_runtime_test_turns_message').on(
      t.sessionId,
      t.clientMessageId,
    ),
    sessionIdx: index('idx_mcp_runtime_test_turns_session').on(t.sessionId, t.seq),
    statusIdx: index('idx_mcp_runtime_test_turns_status').on(t.status, t.hardDeadlineAt),
    enumShape: check(
      'mcp_runtime_test_turns_enum_shape',
      sql`${t.status} IN (
          'queued', 'running', 'succeeded', 'failed',
          'canceled', 'timed_out', 'interrupted'
        )
        AND ${t.captureState} IN ('live', 'complete', 'truncated', 'incomplete')
        AND (
          ${t.captureIncompleteReason} IS NULL
          OR ${t.captureIncompleteReason} IN (
            'stream-persist-failed', 'stream-frame-limit-exceeded',
            'child-capture-failed', 'post-exit-flush-timeout'
          )
        )`,
    ),
    counterShape: check(
      'mcp_runtime_test_turns_counter_shape',
      sql`${t.seq} > 0
        AND ${t.hardDeadlineAt} >= ${t.createdAt}
        AND ${t.captureLastEventSeq} >= 0
        AND ${t.captureEventBytes} >= 0
        AND (${t.captureFirstEventSeq} IS NULL OR ${t.captureFirstEventSeq} > 0)
        AND (${t.durationMs} IS NULL OR ${t.durationMs} >= 0)`,
    ),
    lifecycleShape: check(
      'mcp_runtime_test_turns_lifecycle_shape',
      sql`(
          ${t.status} = 'queued'
          AND ${t.startedAt} IS NULL
          AND ${t.finishedAt} IS NULL
        )
        OR (
          ${t.status} = 'running'
          AND ${t.startedAt} IS NOT NULL
          AND ${t.finishedAt} IS NULL
        )
        OR (
          ${t.status} IN (
            'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted'
          )
          AND ${t.finishedAt} IS NOT NULL
        )`,
    ),
    digestShape: check(
      'mcp_runtime_test_turns_digest_shape',
      sql`(
          ${t.rawCommandDigest} IS NULL
          OR (
            length(${t.rawCommandDigest}) = 64
            AND ${t.rawCommandDigest} NOT GLOB '*[^0-9a-f]*'
          )
        )
        AND (
          (
            ${t.spawnedAt} IS NULL
            AND ${t.spawnBinaryPath} IS NULL
            AND ${t.spawnCommandDigest} IS NULL
          )
          OR
          (
            ${t.spawnedAt} IS NOT NULL
            AND ${t.spawnBinaryPath} IS NOT NULL
            AND ${t.spawnCommandDigest} IS NOT NULL
            AND length(${t.spawnCommandDigest}) = 64
            AND ${t.spawnCommandDigest} NOT GLOB '*[^0-9a-f]*'
          )
        )`,
    ),
  }),
)

export const mcpRuntimeTestEvents = sqliteTable(
  'mcp_runtime_test_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testSessionId: text('test_session_id')
      .notNull()
      .references(() => mcpRuntimeTestSessions.id, { onDelete: 'cascade' }),
    firstSeenTurnId: text('first_seen_turn_id').notNull(),
    eventSeq: integer('event_seq').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    sessionId: text('session_id'),
    parentSessionId: text('parent_session_id'),
    source: text('source', {
      enum: ['stream', 'live-child', 'post-run-child'],
    }).notNull(),
    externalEventKey: text('external_event_key'),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex('uniq_mcp_runtime_test_events_session_seq').on(
      t.testSessionId,
      t.eventSeq,
    ),
    externalUnique: uniqueIndex('uniq_mcp_runtime_test_events_external')
      .on(t.testSessionId, t.externalEventKey)
      .where(sql`${t.externalEventKey} IS NOT NULL`),
    sessionIdx: index('idx_mcp_runtime_test_events_session').on(t.testSessionId, t.eventSeq),
    shape: check(
      'mcp_runtime_test_events_shape',
      sql`${t.eventSeq} > 0
        AND ${t.ts} >= 0
        AND ${t.source} IN ('stream', 'live-child', 'post-run-child')
        AND (
          ${t.externalEventKey} IS NULL
          OR (
            length(${t.externalEventKey}) = 64
            AND ${t.externalEventKey} NOT GLOB '*[^0-9a-f]*'
          )
        )`,
    ),
  }),
)

export const mcpRuntimeTestCreateReceipts = sqliteTable(
  'mcp_runtime_test_create_receipts',
  {
    mcpId: text('mcp_id')
      .notNull()
      .references(() => mcps.id, { onDelete: 'restrict' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    clientCreateId: text('client_create_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    sessionId: text('session_id').notNull(),
    acceptedTurnId: text('accepted_turn_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mcpId, t.ownerUserId, t.clientCreateId] }),
    expiryIdx: index('idx_mcp_runtime_test_create_receipts_expiry').on(t.expiresAt),
    shape: check(
      'mcp_runtime_test_create_receipts_shape',
      sql`length(${t.requestDigest}) = 64
        AND ${t.requestDigest} NOT GLOB '*[^0-9a-f]*'
        AND ${t.createdAt} >= 0
        AND ${t.expiresAt} > ${t.createdAt}`,
    ),
  }),
)

// OpenCode playground ownership deliberately does not reuse the task/business
// owner table: a test session is not a Task or NodeRun.
export const opencodeMcpTestSessionOwners = sqliteTable(
  'opencode_mcp_test_session_owners',
  {
    runtimeSessionId: text('runtime_session_id').primaryKey(),
    testSessionId: text('test_session_id')
      .notNull()
      .references(() => mcpRuntimeTestSessions.id, { onDelete: 'restrict' }),
    createdTurnId: text('created_turn_id')
      .notNull()
      .references(() => mcpRuntimeTestTurns.id, { onDelete: 'restrict' }),
    currentTurnId: text('current_turn_id')
      .notNull()
      .references(() => mcpRuntimeTestTurns.id, { onDelete: 'restrict' }),
    identityDigest: text('identity_digest').notNull(),
    runtimeBinaryDigest: text('runtime_binary_digest').notNull(),
    sessionContractDigest: text('session_contract_digest').notNull(),
    sessionStoreKey: text('session_store_key').notNull(),
    projectId: text('project_id').notNull(),
    protocolCodec: text('protocol_codec').notNull(),
    reportedVersion: text('reported_version'),
    leaseTurnId: text('lease_turn_id').references(() => mcpRuntimeTestTurns.id, {
      onDelete: 'restrict',
    }),
    leaseAcquiredAt: integer('lease_acquired_at'),
    leaseNonceDigest: text('lease_nonce_digest'),
  },
  (t) => ({
    testSessionUnique: uniqueIndex('uniq_opencode_mcp_test_owners_session').on(t.testSessionId),
    storeUnique: uniqueIndex('uniq_opencode_mcp_test_owners_store_key').on(t.sessionStoreKey),
    leaseAllOrNone: check(
      'opencode_mcp_test_owners_lease_all_or_none',
      sql`(
        (
          ${t.leaseTurnId} IS NULL
          AND ${t.leaseAcquiredAt} IS NULL
          AND ${t.leaseNonceDigest} IS NULL
        )
        OR
        (
          ${t.leaseTurnId} IS NOT NULL
          AND ${t.leaseAcquiredAt} IS NOT NULL
          AND ${t.leaseNonceDigest} IS NOT NULL
        )
      )`,
    ),
    digestShape: check(
      'opencode_mcp_test_owners_digest_shape',
      sql`length(${t.identityDigest}) = 64
        AND ${t.identityDigest} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.runtimeBinaryDigest}) = 64
        AND ${t.runtimeBinaryDigest} NOT GLOB '*[^0-9a-f]*'
        AND length(${t.sessionContractDigest}) = 64
        AND ${t.sessionContractDigest} NOT GLOB '*[^0-9a-f]*'
        AND (
          ${t.leaseNonceDigest} IS NULL
          OR (
            length(${t.leaseNonceDigest}) = 64
            AND ${t.leaseNonceDigest} NOT GLOB '*[^0-9a-f]*'
          )
        )`,
    ),
  }),
)

// -----------------------------------------------------------------------------
// RFC-234 intent_sessions — intent-builder persistent sessions (design §2).
// Visibility = creator + SYSTEM admin only (isAdminActor; manager has no bypass
// — design-gate P1-8). `context_revision` is the monotonic context epoch: it
// advances on mount change / rebase / approved disclosure / successful commit,
// and every turn result is CAS'd against it (late results archive as error,
// never install as the current draft — design-gate P0-3).
// `context_manifest_json` lists EVERY resource actually dumped into the epoch
// (mounted roots + dependency-closure members): [{handle, resourceType,
// resourceId, fence, dumpHash}] (design-gate P1-2). Never enters any prompt.
// -----------------------------------------------------------------------------
export const intentSessions = sqliteTable(
  'intent_sessions',
  {
    id: text('id').primaryKey(), // ULID
    ownerUserId: text('owner_user_id').notNull(),
    title: text('title').notNull().default(''),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    contextRevision: integer('context_revision').notNull().default(0),
    contextManifestJson: text('context_manifest_json').notNull().default('[]'),
    /** Current draft pointer (intent_drafts.id); NULL until first changeset. */
    currentDraftId: text('current_draft_id'),
    /** Single-flight gate: the in-flight agent turn id, NULL when idle. */
    inFlightTurnId: text('in_flight_turn_id'),
    turnSeq: integer('turn_seq').notNull().default(0),
    commitSeq: integer('commit_seq').notNull().default(0),
    /** {generateRounds, questionRounds} consumed counters (budget vs config). */
    budgetJson: text('budget_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    ownerIdx: index('idx_intent_sessions_owner').on(t.ownerUserId),
    ownerStatusIdx: index('idx_intent_sessions_owner_status').on(t.ownerUserId, t.status),
  }),
)

// -----------------------------------------------------------------------------
// RFC-234 intent_turns — one row per conversation turn. Agent turns persist
// `envelope_nonce` BEFORE spawn in the same tx that creates the row (the
// emit/parse/audit single source — design-gate P2-1; a retry mints a NEW turn
// with a NEW nonce). `context_revision` records the epoch the turn was
// launched under. `scratch_retained` marks a kept failure scratch dir for the
// hourly GC owner (design §1.2).
// -----------------------------------------------------------------------------
export const intentTurns = sqliteTable(
  'intent_turns',
  {
    id: text('id').primaryKey(), // ULID
    sessionId: text('session_id')
      .notNull()
      .references(() => intentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    kind: text('kind', {
      // 'running' = agent turn minted (nonce persisted) but not yet settled;
      // TS-level enum only (the SQLite column carries no CHECK), so this needs
      // no migration change.
      enum: ['message', 'answers', 'mount-approval', 'running', 'questions', 'changeset', 'error'],
    }).notNull(),
    contentJson: text('content_json').notNull().default('{}'),
    contextRevision: integer('context_revision').notNull().default(0),
    envelopeNonce: text('envelope_nonce'),
    /** Agent turns: {runtime, model, durationMs, exitCode, failureCode?, stderrTail?}. */
    runMetaJson: text('run_meta_json'),
    /**
     * RFC-235: independently-settled execution capture. NULL for user turns
     * and legacy agent turns; new agent turns start at `live`. Capture
     * failures never change the turn's business kind/result.
     */
    captureState: text('capture_state', {
      enum: ['live', 'complete', 'truncated', 'incomplete'],
    }),
    captureLastEventSeq: integer('capture_last_event_seq').notNull().default(0),
    captureEventBytes: integer('capture_event_bytes').notNull().default(0),
    captureRootSessionId: text('capture_root_session_id'),
    captureIncompleteReason: text('capture_incomplete_reason', {
      enum: [
        'stream-persist-failed',
        'stream-frame-limit-exceeded',
        'child-capture-failed',
        'post-exit-flush-timeout',
      ],
    }),
    scratchRetained: integer('scratch_retained', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    sessionSeqUnique: uniqueIndex('uniq_intent_turns_session_seq').on(t.sessionId, t.seq),
    sessionIdx: index('idx_intent_turns_session').on(t.sessionId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-235 intent_turn_events — normalized runtime events for one Intent agent
// turn. Kept separate from node_run_events: Intent turns are not task node
// runs, and manufacturing a node_run FK would contaminate task lifecycle and
// metrics. `event_seq` is allocated under the owning turn's short transaction;
// runtime part ids provide exact live/post-run dedupe when available.
// -----------------------------------------------------------------------------
export const intentTurnEvents = sqliteTable(
  'intent_turn_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    turnId: text('turn_id')
      .notNull()
      .references(() => intentTurns.id, { onDelete: 'cascade' }),
    eventSeq: integer('event_seq').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    sessionId: text('session_id'),
    parentSessionId: text('parent_session_id'),
    source: text('source', {
      enum: ['stream', 'live-child', 'post-run-child'],
    }).notNull(),
    externalEventId: text('external_event_id'),
  },
  (t) => ({
    turnSeqUnique: uniqueIndex('uniq_intent_turn_events_turn_seq').on(t.turnId, t.eventSeq),
    externalEventUnique: uniqueIndex('uniq_intent_turn_events_external').on(
      t.turnId,
      t.source,
      t.externalEventId,
    ),
    turnIdx: index('idx_intent_turn_events_turn').on(t.turnId, t.eventSeq),
  }),
)

// -----------------------------------------------------------------------------
// RFC-234 intent_drafts — IMMUTABLE changeset revisions (design-gate P0-3 /
// P1-5). The session's current draft is a pointer; "restore an older version"
// mints a new revision copying the old body — history never mutates.
// `draft_hash` = sha-256 of the canonical JSON (shared canonicalIntentJson);
// commit must present the exact (revision, hash) pair the user confirmed.
// -----------------------------------------------------------------------------
export const intentDrafts = sqliteTable(
  'intent_drafts',
  {
    id: text('id').primaryKey(), // ULID
    sessionId: text('session_id')
      .notNull()
      .references(() => intentSessions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    changesetJson: text('changeset_json').notNull(),
    validationJson: text('validation_json').notNull().default('[]'),
    draftHash: text('draft_hash').notNull(),
    producedByTurnId: text('produced_by_turn_id'),
    contextRevision: integer('context_revision').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    sessionRevisionUnique: uniqueIndex('uniq_intent_drafts_session_revision').on(
      t.sessionId,
      t.revision,
    ),
    sessionIdx: index('idx_intent_drafts_session').on(t.sessionId),
  }),
)

// -----------------------------------------------------------------------------
// RFC-234 intent_apply_journal — the bundle apply protocol (design-gate P0-5 /
// P0-6). One row per commit ATTEMPT; UNIQUE(session_id, client_mutation_id)
// makes replays idempotent (a duplicate request returns the stored receipt or
// error, zero side effects). `prepared_artifacts_json` enumerates compensable
// side effects (plugin generations/caches, skill staging ops) recorded BEFORE
// they are created; boot/hourly recovery converges by `state`:
//   prepared/applying → compensate artifacts, mark failed;
//   committed         → replay idempotent roll-forward publishes.
// Secret slot values are NEVER stored here — snapshots keep the sentinel.
// -----------------------------------------------------------------------------
export const intentApplyJournal = sqliteTable(
  'intent_apply_journal',
  {
    id: text('id').primaryKey(), // ULID
    sessionId: text('session_id')
      .notNull()
      .references(() => intentSessions.id, { onDelete: 'cascade' }),
    clientMutationId: text('client_mutation_id').notNull(),
    draftId: text('draft_id').notNull(),
    draftHash: text('draft_hash').notNull(),
    state: text('state', { enum: ['prepared', 'applying', 'committed', 'failed'] })
      .notNull()
      .default('prepared'),
    preparedArtifactsJson: text('prepared_artifacts_json').notNull().default('[]'),
    /** Success receipt: {commitSeq, applied:[{opId, resourceType, resourceId, ...}]}. */
    receiptJson: text('receipt_json'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    mutationUnique: uniqueIndex('uniq_intent_apply_journal_mutation').on(
      t.sessionId,
      t.clientMutationId,
    ),
    sessionIdx: index('idx_intent_apply_journal_session').on(t.sessionId),
    stateIdx: index('idx_intent_apply_journal_state').on(t.state),
  }),
)

// -----------------------------------------------------------------------------
// RFC-234 intent_provenance — resource-side "came from intent commit X" audit
// (design §2). Read by detail pages ONLY when the viewer can see the session
// (owner / system admin). Like RFC-099 attribution: NEVER enters any agent
// prompt (grep-locked). `commit_id` references intent_apply_journal.id of the
// committed attempt.
// -----------------------------------------------------------------------------
export const intentProvenance = sqliteTable(
  'intent_provenance',
  {
    resourceType: text('resource_type', {
      enum: ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'],
    }).notNull(),
    resourceId: text('resource_id').notNull(),
    commitId: text('commit_id').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.resourceType, t.resourceId, t.commitId] }),
    resourceIdx: index('idx_intent_provenance_resource').on(t.resourceType, t.resourceId),
    sessionIdx: index('idx_intent_provenance_session').on(t.sessionId),
  }),
)
