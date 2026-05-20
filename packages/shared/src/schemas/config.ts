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
  /** Default model for agents without an explicit model. */
  defaultModel: z.string().min(1).optional(),
  defaultVariant: z.string().min(1).optional(),
  defaultTemperature: z.number().min(0).max(2).optional(),
  /**
   * Default agent steps / max-steps surfaced on the Add Agent form. Pure UX:
   * the value is snapshotted into the new agent row at creation time, after
   * which the agent row is authoritative (changing these later does not
   * propagate). See design/RFC-002-agent-defaults-from-runtime/.
   */
  defaultSteps: z.number().int().positive().optional(),
  defaultMaxSteps: z.number().int().positive().optional(),
  /** Global semaphore capacity. design.md §11 default = 4. */
  maxConcurrentNodes: z.number().int().positive(),
  /** Independent sub-process pool capacity inside a multi-process node. */
  multiProcessSubprocessConcurrency: z.number().int().positive(),

  // --- Resource limits (defaults; workflow & launcher can override per task) ---
  defaultPerTaskMaxDurationMs: z.number().int().nonnegative(),
  defaultPerTaskMaxTotalTokens: z.number().int().nonnegative(),
  defaultPerNodeTimeoutMs: z.number().int().positive(),

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
   * Model the distiller agent uses. Falls back to opencode's installed
   * default when unset. Settings → Memory section will surface this.
   */
  memoryDistillModel: z.string().min(1).optional(),
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
  defaultPerNodeTimeoutMs: 30 * 60 * 1000, // 30 min
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
