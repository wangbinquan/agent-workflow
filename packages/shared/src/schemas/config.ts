// Global config schema (~/.agent-workflow/config.json).
// Mirrors design.md §11. Each field has a default; missing fields are
// backfilled by the backend on load.

import { z } from 'zod'

export const CONFIG_SCHEMA_VERSION = 1

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export const LanguageSchema = z.enum(['zh-CN', 'en-US'])
export type Language = z.infer<typeof LanguageSchema>
export const ThemeSchema = z.enum(['system', 'light', 'dark'])

export const WorktreeGcSchema = z.object({
  enabled: z.boolean(),
  olderThanDays: z.number().int().positive().optional(),
  onlyMerged: z.boolean().optional(),
})

export const EventsArchiveThresholdsSchema = z.object({
  perNodeRunRows: z.number().int().positive(),
  globalRows: z.number().int().positive(),
})

/** RFC-020: caps applied to multipart launcher uploads. */
export const UploadLimitsSchema = z.object({
  perFile: z.number().int().positive(),
  perRequest: z.number().int().positive(),
  perCount: z.number().int().positive(),
})

export const ConfigSchema = z.object({
  $schema_version: z.literal(CONFIG_SCHEMA_VERSION),

  // --- Runtime ---
  /** Override opencode binary path. Falls back to `which opencode` (PATH). */
  opencodePath: z.string().min(1).optional(),
  /**
   * RFC-111 / RFC-112: global default runtime for agents that don't set their
   * own. Omitted → 'opencode' (zero behavior change). RFC-112 widens this from
   * the two-value enum to any registered runtime NAME (the built-ins are still
   * named 'opencode' / 'claude-code', so existing values stay valid); the name
   * is resolved to a (protocol, binary) via the runtimes registry at dispatch.
   * opencode stays a hard daemon requirement; claude-code + custom forks are
   * additional, optional runtimes (D14).
   */
  defaultRuntime: z.string().min(1).optional(),
  /** RFC-111: override the `claude` binary path. Falls back to PATH. */
  claudeCodePath: z.string().min(1).optional(),
  /**
   * RFC-111 D17: gate user-visible claude-code selection (Agent form / settings)
   * until injection parity (PR-C) + capture (PR-D) land. Default off.
   */
  claudeCodeEnabled: z.boolean().optional(),
  /** Global semaphore capacity. design.md §11 default = 4. */
  maxConcurrentNodes: z.number().int().positive(),
  /** Independent sub-process pool capacity inside a multi-process node. */
  multiProcessSubprocessConcurrency: z.number().int().positive(),

  // --- Resource limits (defaults; workflow & launcher can override per task) ---
  defaultPerTaskMaxDurationMs: z.number().int().nonnegative(),
  defaultPerTaskMaxTotalTokens: z.number().int().nonnegative(),
  defaultPerNodeTimeoutMs: z.number().int().positive(),
  // RFC-115: global per-node retry budget (replaces the per-node `retries`
  // override). nonnegative (not positive) — retries:0 is a valid explicit
  // "no retries"; default 3 matches RFC-042's former hard-coded fallback.
  defaultNodeRetries: z.number().int().nonnegative(),

  // --- RFC-108 task auto-check & recovery (all default-safe; auto-execution OFF) ---
  /** T18: auto-resume daemon-restart-interrupted tasks at boot. Default OFF. */
  autoResumeOnBoot: z.boolean().default(false),
  /** T19: per-rule auto-repair enablement (e.g. {"S4": true}). Default empty = all OFF. */
  autoRepair: z.record(z.string(), z.boolean()).default({}),
  /** T20: auto-kill a node whose opencode child went silent past heartbeatStallMs. Default OFF. */
  autoKillStalledChild: z.boolean().default(false),
  /** T20: event-silence window before a running node's child is considered wedged. */
  heartbeatStallMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  /** T11 circuit-breaker: auto-recovery attempts per window before quarantine. */
  maxAutoRecoveriesPerWindow: z.number().int().positive().default(3),
  /** T11 circuit-breaker: rolling window for the attempt count. */
  autoRecoveryWindowMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  /** T17: periodic in-daemon orphan reconciler cadence (ms). 0 = off; reap-to-interrupted is safe-on. */
  periodicOrphanReconcileMs: z
    .number()
    .int()
    .nonnegative()
    .default(10 * 60 * 1000),

  // --- GC ---
  worktreeAutoGc: WorktreeGcSchema,
  eventsArchiveThresholds: EventsArchiveThresholdsSchema,

  // --- RFC-020 upload caps (multipart launcher uploads) ---
  uploadLimits: UploadLimitsSchema.optional(),

  // --- RFC-024 git URL cache ---
  /**
   * Max time `resolveCachedRepo` spends waiting for the per-URL mutex plus
   * the underlying `git clone` / `git fetch`. Queued tasks behind a long
   * cold-clone get the same budget. Default 30 min (1_800_000 ms).
   */
  gitCloneTimeoutMs: z.number().int().positive().optional(),
  /**
   * When a cached repo is reused (cache hit), also run `git fetch --all
   * --prune --tags` before handing the path back. Default true — keeps the
   * mirror fresh; disable to skip network on every launch.
   */
  gitFetchOnReuse: z.boolean().optional(),

  // --- RFC-033 batch import (`/repos` page) ---
  /**
   * How many `git clone` workers the batch-import driver may run in parallel.
   * Cap is shared across all in-flight batches so two simultaneous batches
   * don't multiply the actual concurrency. Default 3; clamped to [1, 8].
   */
  repoBatchImportConcurrency: z.number().int().min(1).max(8).optional(),
  /**
   * In-memory retention for completed batches before they're GC'd. Default
   * 60 min — long enough for a user to refresh / share the link with a
   * teammate, short enough to keep daemon RSS bounded.
   */
  repoBatchImportRetentionMs: z.number().int().positive().optional(),

  // --- RFC-041 platform long-term memory ---
  /**
   * Master switch for the distiller daemon. When `false`, enqueueDistillJob
   * still writes audit rows but the worker tick never picks them up; flip
   * back to `true` and the queue drains. Default `true`.
   */
  memoryDistillerEnabled: z.boolean().optional(),
  /**
   * @deprecated RFC-117 — superseded by `memoryDistillRuntime` (select a full
   * runtime profile; model comes from it). Kept as a transition fallback: when
   * `memoryDistillRuntime` is unset but this is set, the distiller keeps its
   * prior behavior (opencode + this model). Physical removal is a follow-up
   * cleanup (RFC-113→115 two-phase precedent). New UI writes `memoryDistillRuntime`.
   */
  memoryDistillModel: z.string().min(1).optional(),
  /**
   * RFC-117 — runtime profile NAME the distiller runs on (like an agent's
   * `runtime`): protocol + binary + model all come from the selected profile.
   * Unset → fall back to the deprecated `memoryDistillModel`, then inherit
   * `defaultRuntime` (then opencode). Resolved via `resolveInternalAgentRuntime`.
   */
  memoryDistillRuntime: z.string().min(1).optional(),
  /**
   * RFC-050: language the distiller emits candidate `title` (after the
   * `[category:xxx]` prefix) + `bodyMd` in. Independent from the frontend
   * UI `language` field — admin may keep the UI in English yet sink the
   * memory library in Chinese (or vice versa). `undefined` ≡ `'en-US'`
   * at runtime to preserve RFC-041 byte-level baseline; the prompt itself
   * stays English and only a short trailing directive switches.
   */
  memoryDistillLang: LanguageSchema.optional(),
  /**
   * Per-scope token budget for runtime memory inject (PR3). When the
   * sum of "- [scope] title — body" lines for a scope exceeds its
   * budget, the runner drops the oldest (lowest createdAt) entries
   * until it fits. Setting any field to 0 disables that scope's
   * contribution. Defaults below are the design.md §3.3 values.
   */
  memoryInjectionBudget: z
    .object({
      agent: z.number().int().min(0).max(8000),
      workflow: z.number().int().min(0).max(8000),
      repo: z.number().int().min(0).max(8000),
      global: z.number().int().min(0).max(8000),
    })
    .optional(),

  // --- RFC-044 distiller source context ---
  /**
   * Per-source byte cap for the transcript / body blocks injected into the
   * distiller user prompt. clarifyTranscriptMaxBytes governs the source
   * agent transcript pulled from `node_run_events` keyed by
   * `clarify_sessions.source_agent_node_run_id`; reviewBodyMaxBytes governs
   * the markdown file pointed at by `doc_versions.body_path`. When original
   * content exceeds the cap the loader keeps first 50% + last 50% with a
   * `[truncated <N> bytes]` marker in between. Setting a field to 0
   * disables that block — the builder falls back to RFC-041 behaviour for
   * that source. Defaults: 16384 / 16384 (~4K tokens each).
   */
  memoryDistillSourceContext: z
    .object({
      clarifyTranscriptMaxBytes: z.number().int().min(0).max(65536),
      reviewBodyMaxBytes: z.number().int().min(0).max(65536),
    })
    .optional(),

  // --- RFC-048 subagent live capture ---
  /**
   * Cadence + failure tolerance for the runner-side live poller that mirrors
   * opencode's child-session SQLite into `node_run_events` while the parent
   * opencode process is still alive (RFC-048). `pollMs = 0` disables live
   * polling entirely — behavior degrades to RFC-027's post-run BFS.
   * `consecutiveFailureLimit` ticks of back-to-back SQLite errors auto-disable
   * the poller for that nodeRun; post-run capture then runs once as before.
   */
  subagentLiveCapture: z
    .object({
      pollMs: z.number().int().min(0).max(60_000),
      consecutiveFailureLimit: z.number().int().min(1).max(100),
    })
    .optional(),

  // --- RFC-034 git submodule recursion ---
  /**
   * Behavior when cold-cloning, warm-fetching, or worktree-launching a repo
   * that may contain `.gitmodules`.
   * - `'auto'` (default): detect `.gitmodules` and recurse only when present
   * - `'always'`: always run `submodule update --init --recursive` (idempotent
   *   no-op for repos without `.gitmodules`)
   * - `'never'`: fully disabled; equivalent to pre-RFC-034 behavior
   */
  gitRecurseSubmodules: z.enum(['auto', 'always', 'never']).optional(),
  /**
   * `--jobs <N>` for recursive clone / submodule update. Default 4. Clamped
   * to 1 by callers when the local git is older than 2.13 (no --jobs support).
   * Max 32.
   */
  gitSubmoduleJobs: z.number().int().min(1).max(32).optional(),

  // --- RFC-075 auto commit & push ---
  /**
   * Model the built-in "commit" agent uses to summarize a diff into a commit
   * message and to repair a rejected push. Falls back to opencode's installed
   * default when unset (mirrors `memoryDistillModel`). Settings → Git section
   * surfaces this; a cheap/fast model is recommended.
   */
  commitPushModel: z.string().min(1).optional(),
  /**
   * Max repair-and-repush cycles a commit&push node attempts on a non-auth
   * push rejection before giving up (commit stays local, node failed, task
   * continues). Auth/permission failures never retry. Default 3.
   */
  commitPushMaxRepairRetries: z.number().int().min(0).max(10).optional(),
  /**
   * Byte cap on the diff body fed to the commit-message session (first 50% +
   * last 50% + `[truncated N bytes]` when over; `git diff --stat` is always
   * included separately). 0 disables the body block. Default 16384 (~4K tok).
   */
  commitPushDiffMaxBytes: z.number().int().min(0).max(262144).optional(),

  // --- RFC-083 structural deep-mode (optional external SCIP indexers) ---
  // Absolute-path overrides per indexer binary; unset = looked up on PATH.
  structuralDeepIndexers: z
    .object({
      scipTypescript: z.string().min(1).optional(),
      scipPython: z.string().min(1).optional(),
      scipGo: z.string().min(1).optional(),
      scipClang: z.string().min(1).optional(),
      scipJava: z.string().min(1).optional(),
      rustAnalyzer: z.string().min(1).optional(),
    })
    .optional(),
  /** Per-indexer run timeout for deep mode (ms). Default 120000. */
  structuralDeepTimeoutMs: z.number().int().positive().optional(),

  // --- Large outputs ---
  largeOutputThresholdBytes: z.number().int().positive(),

  // --- Network (requires restart to take effect) ---
  bindHost: z.string().min(1),
  bindPort: z.number().int().min(0).max(65535).optional(),

  // --- i18n / theme (frontend reads these) ---
  language: LanguageSchema,
  theme: ThemeSchema,

  // --- Logging ---
  logLevel: LogLevelSchema,

  // --- Rendering (RFC-005) ---
  /**
   * External PlantUML rendering endpoint (kroki-compatible).
   *
   * Empty / unset → ```plantuml fenced blocks fall back to a `<pre>` source
   * dump with a muted hint to configure this. Otherwise the frontend tries
   * `GET {endpoint}/plantuml/svg/{deflate-base64}` first, then falls back to
   * `POST {endpoint}/plantuml/svg` with `text/plain` raw source.
   *
   * Examples: `https://kroki.io`, `http://localhost:8081`, `https://plantuml.your.lan/`.
   * Trailing slash is normalized client-side.
   */
  plantumlEndpoint: z.string().optional(),
  /**
   * Optional Authorization header value, e.g. `Bearer xxx` or `Basic …`.
   * Sent to the plantuml endpoint when present. Stored verbatim; users with
   * self-hosted kroki behind auth fill this in.
   */
  plantumlAuthHeader: z.string().optional(),
  /**
   * RFC-036 — explicit public base URL the OIDC callback should redirect
   * back to. When set, overrides the X-Forwarded-Host / Host header
   * derivation in routes/oidc-auth.ts. Required when the SPA sits behind a
   * proxy that doesn't forward X-Forwarded-* headers (e.g. vite dev:
   *   "publicBaseUrl": "http://localhost:5174"
   * makes the IdP redirect back to the proxy that serves the SPA).
   */
  publicBaseUrl: z.string().url().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

/** Default config — every field present, satisfies ConfigSchema. */
export const DEFAULT_CONFIG: Config = {
  $schema_version: CONFIG_SCHEMA_VERSION,
  maxConcurrentNodes: 4,
  multiProcessSubprocessConcurrency: 4,
  defaultPerTaskMaxDurationMs: 60 * 60 * 1000, // 1 hour
  defaultPerTaskMaxTotalTokens: 0, // 0 = unlimited
  // RFC-108 T4/AR-01: actually wired into the launch path (resolveLaunchRuntimeConfig)
  // so every node has a hard-timeout floor; was defined-but-never-threaded before.
  defaultPerNodeTimeoutMs: 30 * 60 * 1000, // 30 min
  defaultNodeRetries: 3, // RFC-115 — was RFC-042's hard-coded `?? 3` in scheduler
  // RFC-108 auto-recovery knobs — auto-execution OFF by default (decision D1).
  autoResumeOnBoot: false,
  autoRepair: {},
  autoKillStalledChild: false,
  heartbeatStallMs: 30 * 60 * 1000,
  maxAutoRecoveriesPerWindow: 3,
  autoRecoveryWindowMs: 60 * 60 * 1000,
  periodicOrphanReconcileMs: 10 * 60 * 1000,
  worktreeAutoGc: { enabled: false },
  eventsArchiveThresholds: {
    perNodeRunRows: 50_000,
    globalRows: 1_000_000,
  },
  largeOutputThresholdBytes: 1_048_576, // 1 MB
  bindHost: '127.0.0.1',
  language: 'zh-CN',
  theme: 'system',
  logLevel: 'info',
}

/**
 * Patch schema: any subset of the full config (except $schema_version),
 * sent by PUT /api/config and merged onto the current config.
 */
export const ConfigPatchSchema = ConfigSchema.partial().omit({ $schema_version: true })
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>

/**
 * RFC-044: defaults for the distiller source-context budget. Exported so
 * the backend loader can use a single source of truth instead of duplicating
 * the literals in service code.
 */
export interface SourceContextBudget {
  clarifyTranscriptMaxBytes: number
  reviewBodyMaxBytes: number
}
export const DEFAULT_SOURCE_CONTEXT_BUDGET: SourceContextBudget = {
  clarifyTranscriptMaxBytes: 16384,
  reviewBodyMaxBytes: 16384,
}

/**
 * RFC-048: defaults for the runner's subagent live poller. The runner falls
 * back to these constants when `config.subagentLiveCapture` is omitted, so
 * existing deployments inherit the new behavior without a config edit.
 */
export interface SubagentLiveCapture {
  pollMs: number
  consecutiveFailureLimit: number
}
export const DEFAULT_SUBAGENT_LIVE_CAPTURE: SubagentLiveCapture = {
  pollMs: 1500,
  consecutiveFailureLimit: 5,
}

/**
 * RFC-075: defaults the backend loader applies when `commitPushMaxRepairRetries`
 * / `commitPushDiffMaxBytes` are omitted. `commitPushModel` has no constant —
 * unset means "fall back to opencode's installed default" at spawn time.
 */
export const DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES = 3
export const DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES = 16384
