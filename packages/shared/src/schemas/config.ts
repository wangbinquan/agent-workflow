// Global config schema (~/.agent-workflow/config.json).
// Mirrors design.md §11. Each field has a default; missing fields are
// backfilled by the backend on load.

import { z } from 'zod'
import { SETTINGS_NUMERIC_BOUNDS, type SettingsNumericPath } from '../settingsNumericBounds'

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const point = char.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

function boundedSettingsInteger(path: SettingsNumericPath) {
  const bound = SETTINGS_NUMERIC_BOUNDS[path]
  const schema = z.number().int().min(bound.min).max(bound.max)
  if (!('positiveMin' in bound)) return schema
  return schema.refine((value) => value === 0 || value >= bound.positiveMin, {
    message: `must be 0 or at least ${bound.positiveMin}`,
  })
}

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
  /** RFC-311（proposal C3）：字节维度水位。行数阈值在 payload 变大时会失控
   *  （生产 2.2GB ≈ 88 万行,还没碰到 100 万行的旧水位）；归档器按最近 1000
   *  行的平均行宽把字节预算折算成有效行数阈值,与行数阈值取 min。0 = 关。 */
  perNodeRunBytes: z
    .number()
    .int()
    .nonnegative()
    .default(8 * 1024 * 1024),
  globalBytes: z
    .number()
    .int()
    .nonnegative()
    .default(256 * 1024 * 1024),
})

/**
 * RFC-210 G7: periodic background refresh of cached repos and their submodules.
 *
 * Shaped like `WorktreeGcSchema` on purpose — `enabled` required, the rest
 * optional with defaults resolved at the call site. That combination is what
 * makes the deep-merge in `config/index.ts` apply, which in turn is what keeps
 * adding a field here from breaking older `config.json` files.
 */
export const SubmoduleAutoRefreshSchema = z.object({
  enabled: z.boolean(),
  /** Default 6h. Clamped to [1min, 7d]. */
  intervalMs: boundedSettingsInteger('submoduleAutoRefresh.intervalMs').optional(),
  /** Only refresh repos referenced by a task within this many days. Default 30. */
  onlyRecentDays: boundedSettingsInteger('submoduleAutoRefresh.onlyRecentDays').optional(),
})

/** RFC-020: caps applied to multipart launcher uploads. */
export const UploadLimitsSchema = z.object({
  perFile: z.number().int().positive(),
  perRequest: z.number().int().positive(),
  perCount: z.number().int().positive(),
})

const TaskCommitExcludePatternSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 1024, {
    message: 'task commit exclude pattern must be at most 1024 UTF-8 bytes',
  })
  .superRefine((value, ctx) => {
    if (/\0|\r|\n/.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pattern must be one line without NUL' })
    }
    const body = value.startsWith('!') ? value.slice(1) : value
    if (/^[A-Za-z]:[\\/]/.test(body) || body.startsWith('\\\\')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'host absolute paths are not allowed' })
    }
    if (/(^|\/)\.\.(\/|$)/.test(body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pattern must stay inside the repository',
      })
    }
  })

/** RFC-308: Gitignore-compatible rules applied only to platform-owned commits. */
export const TaskCommitExcludePatternsSchema = z
  .array(TaskCommitExcludePatternSchema)
  .max(256)
  .superRefine((patterns, ctx) => {
    const bytes = utf8ByteLength(patterns.join('\n'))
    if (bytes > 64 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'task commit exclude patterns must be at most 64 KiB in total',
      })
    }
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
  // （flag-audit §8 决策，用户 2026-07-07：RFC-111 D17 的 `claudeCodeEnabled`
  // 配置门已删除——三重矛盾的假门：注释称默认关、前端按默认开消费、后端从不
  // enforce。claude 可用性以 runtimes 注册表内建行的 per-runtime `enabled`
  // 为单一事实源；存量 config.json 里的旧 key 被 zod 静默剥离。）
  /**
   * Daemon-wide pool capacity for AGENT-class process nodes (agent nodes,
   * workgroup host nodes, fan-out shards and aggregators). design.md §11
   * default = 4. RFC-266 narrowed this from "every process node" — script
   * nodes have their own independent pool below, so the daemon's peak child
   * count is this value PLUS maxConcurrentScriptNodes.
   */
  maxConcurrentNodes: z.number().int().positive(),
  /**
   * RFC-266: daemon-wide pool capacity for RFC-253 script nodes, fully
   * independent of `maxConcurrentNodes` so a queue of multi-minute agents
   * cannot block a second-scale script step (and vice versa).
   */
  maxConcurrentScriptNodes: z.number().int().positive(),
  /**
   * RFC-269: daemon-wide pool capacity for code-host call nodes — a third
   * independent pool, for the same reason RFC-266 split scripts out: one
   * outbound API call is a second-scale step and must not queue behind
   * multi-minute agent runs. Default 8 (higher than the other two: these hold
   * no subprocess, only an in-flight HTTP request).
   */
  // RFC-287 T10：上界与 SETTINGS_NUMERIC_BOUNDS 同源——UI 能填的与服务端能存的
  // 必须一致，否则设置页放行的值被 PUT 打回，用户只看到一个没有出处的报错。
  /**
   * RFC-287 G6：基线同步（克隆/抓取）的**总容忍窗口**，毫秒。
   *
   * 用总窗口而不是固定次数：用户关心的是「最多等多久」，而不是「重试几次」。
   * 窗口内退避重试；耗尽仍失败则任务失败并写明原因。**只有网络类失败占窗口**，
   * 鉴权 / 仓库不存在 / 无权限立刻失败（见 shared/gitFailureClass.ts）。
   * 0 = 关闭重试（保持 G6 之前的硬失败语义）。
   */
  gitBaselineSyncWindowMs: z.number().int().min(0).max(600_000).default(60_000),
  maxConcurrentCodeHostCalls: z.number().int().positive().max(256).default(8),
  /** RFC-269: wall clock for ONE outbound code-host request. Node may override. */
  codeHostRequestTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 1000),
  /**
   * RFC-269: cap on the `response` port value. Beyond this the body is
   * truncated with an explicit marker — never silently, because a downstream
   * agent would otherwise draw conclusions from half a JSON document.
   */
  codeHostResponseMaxBytes: z
    .number()
    .int()
    .positive()
    .default(256 * 1024),
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

  // --- RFC-253 script nodes ---
  /**
   * Absolute interpreter paths overriding PATH resolution. Administrators use
   * this when the daemon's PATH is not the one they want scripts to run under
   * (a pyenv shim, a homebrew node, a container-provided bash).
   */
  scriptInterpreters: z
    .object({
      python: z.string().optional(),
      bash: z.string().optional(),
      node: z.string().optional(),
    })
    .default({}),
  /** Wall clock for one dependency-environment build. */
  scriptDepsInstallTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  /** Prepared dependency environments unused for this long are collected. */
  scriptEnvTtlDays: z.number().int().positive().default(30),

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
  /** RFC-159: master switch for the scheduled-task background loop. false → the daemon never fires schedules. */
  scheduledTasksEnabled: z.boolean().default(true),
  /** RFC-159: consecutive fire failures before a schedule auto-disables. */
  scheduledTasksMaxFailures: z.number().int().positive().default(10),
  /** RFC-243 §3.2: daemon-wide cap on concurrently active ({pending,running})
   *  node-invoked child tasks. Grants are scan-based with ancestor exemption
   *  (deadlock-free); awaiting/interrupted children do not hold quota. */
  maxActiveChildTasks: z.number().int().positive().max(64).default(8),
  /** RFC-243 §3.2: invocation-chain depth ceiling (root task = 0). A defensive
   *  gate behind the launch-time closure cycle detection. */
  maxInvocationDepth: z.number().int().positive().max(16).default(3),

  // --- RFC-213 disaster recovery ---
  /** Auto-backup cadence (ms). 0 = disabled (default — existing installs don't
   *  silently start growing a backups/ dir). >0 fires createBackup on that tick. */
  backupIntervalMs: z.number().int().nonnegative().default(0),
  /** Retention: KEEP a scheduled/auto backup iff it is within the newest N OR
   *  newer than backupRetentionDays; DELETE only when it fails BOTH. Manual and
   *  pre-restore/pre-migration backups are NEVER auto-pruned. Never deletes to 0. */
  backupRetentionCount: z.number().int().positive().default(7),
  /** See backupRetentionCount. */
  backupRetentionDays: z.number().int().positive().default(30),
  /** RFC-213 impl-gate P2-6 (AC-6 total-size cap): hard byte ceiling for the
   *  ROTATABLE (scheduled/auto) backup set — beyond count/days retention, the
   *  oldest rotatable backups are pruned until the set fits (never to 0).
   *  0 = no cap (default). Protected kinds (manual / pre-restore /
   *  pre-migration) are never auto-pruned — recorded limitation. */
  backupMaxTotalBytes: z.number().int().nonnegative().default(0),
  /** RFC-311 (proposal C4): per-family cap for PROTECTED backups — manual and
   *  each pre-* family keep their newest N tarballs. 0 = never auto-prune
   *  (the historical behavior); default 10. Retention now also runs at boot +
   *  hourly even when the scheduled-backup ticker is disabled. */
  backupProtectedKeepCount: z.number().int().nonnegative().default(10),

  // --- RFC-261 webhook 投递保留（D9'）---
  /** 投递 body_json 置空天数（观测/重放窗口）。10 万投递/天的部署下 30 天 body
   *  ≈ 数十 GB SQLite 存储，管理员可按盘量收缩。保存门（routes/config.ts）校验
   *  body ≤ row；GC ticker 每次 sweep 读取生效值，改动免重启热生效。 */
  webhookDeliveryBodyRetentionDays: z.number().int().min(1).max(3650).default(30),
  /** 投递整行删除天数（审计窗口）。见 webhookDeliveryBodyRetentionDays。 */
  webhookDeliveryRowRetentionDays: z.number().int().min(1).max(3650).default(90),

  // --- RFC-311 无界流水表保留（proposal C6，各键 0 = 不清理）---
  /** memory_distill_events / intent_turn_events / mcp_runtime_test_events 三张
   *  事件流水按行时间戳过期。 */
  eventStreamRetentionDays: z.number().int().min(0).max(3650).default(30),
  /** webhook_trigger_fires 保留天数。 */
  webhookTriggerFiresRetentionDays: z.number().int().min(0).max(3650).default(90),

  /** Take a raw (byte-copy) pre-migration backup before applying pending
   *  migrations on boot, so a botched upgrade can be rolled back. */
  backupOnMigration: z.boolean().default(true),
  /** PRAGMA synchronous mode. FULL trades throughput for stronger power-loss
   *  durability; NORMAL (default) is byte-equivalent to the historical setting. */
  sqliteSynchronous: z.enum(['NORMAL', 'FULL']).default('NORMAL'),
  /** Periodic `wal_checkpoint(TRUNCATE)` cadence (ms) to bound -wal growth.
   *  0 = off. RFC-311: default ON at 10min — archive/GC delete bursts otherwise
   *  pile into -wal until a passive checkpoint happens to win. */
  walCheckpointIntervalMs: z.number().int().nonnegative().default(600_000),
  /** RFC-311: SQLite page-cache budget (MiB) for the daemon's single
   *  connection. The engine default (~2MB) makes every wide scan of a
   *  multi-GB file a cold disk read. */
  sqlitePageCacheMib: z.number().int().min(2).max(4096).default(128),
  /** RFC-311: SQLite mmap window (MiB); 0 disables. Unsupported filesystems
   *  silently fall back to the page cache. */
  sqliteMmapMib: z.number().int().min(0).max(16384).default(512),
  /** RFC-311: warn-log any single SQL statement slower than this (ms); 0 = off.
   *  The daemon's connection is synchronous — one slow statement freezes every
   *  HTTP/WS request, so regressions must surface themselves. */
  sqliteSlowQueryMs: z.number().int().min(0).max(60_000).default(50),

  // --- GC ---
  /** RFC-300: claim a direct Webhook root task's owned remote/scratch
   * workspace when it enters done/canceled. Default OFF: enabling is an
   * explicit capability trade-off because the old workspace can no longer be
   * inspected, retried, or synced after the delete completes. */
  webhookTaskWorkspaceAutoCleanup: z.boolean().default(false),
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
  /** RFC-239 — runtime profile for the change-narrative system agent (AI 导读).
   *  Unset → global defaultRuntime → opencode (RFC-117 chain). */
  changeNarrativeRuntime: z.string().min(1).optional(),
  /**
   * RFC-050: language the distiller emits candidate `title` (after the
   * `[category:xxx]` prefix) + `bodyMd` in. Independent from the frontend
   * UI `language` field — admin may keep the UI in English yet sink the
   * memory library in Chinese (or vice versa). `undefined` ≡ `'en-US'`
   * at runtime to preserve RFC-041 byte-level baseline; the prompt itself
   * stays English and only a short trailing directive switches.
   */
  memoryDistillLang: LanguageSchema.optional(),

  // --- RFC-234 intent builder (design §5) ---
  /**
   * RFC-234 — runtime profile NAME the intent-builder system agent runs on.
   * RFC-276: Intent Builder uses the selected runtime's natural system-agent
   * spawn shape. There is no platform permission profile or capability gate.
   * Unset → inherit `defaultRuntime`.
   */
  intentBuilderRuntime: z.string().min(1).optional(),
  /** RFC-234 — output language of generated artifacts (prompts/descriptions).
   *  Unset → mirror the user's intent input language. */
  intentBuilderLang: LanguageSchema.optional(),
  /** RFC-234 — per-turn generation timeout (ms). Default 600_000. */
  intentBuilderTurnTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
  /** RFC-234 — per-turn stdout cap (bytes). Default 8 MiB (= envelope parse
   *  ceiling; schema-level changeset bounds sit far below — design §3.2). */
  intentBuilderStdoutCapBytes: z
    .number()
    .int()
    .min(256 * 1024)
    .max(16 * 1024 * 1024)
    .optional(),
  /** RFC-234 — max generation turns per session. Default 50. */
  intentBuilderMaxGenerateRounds: z.number().int().min(1).max(500).optional(),
  /** RFC-234 — max question (clarify) turns per session. Default 5. */
  intentBuilderMaxQuestionRounds: z.number().int().min(0).max(50).optional(),
  /** RFC-234 — retention hours for failed-turn scratch dirs before GC. Default 24. */
  intentBuilderScratchRetentionHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .optional(),
  /** RFC-234 — admin instructions appended to the frozen system prompt
   *  (naming conventions, style constraints). ≤8 KiB. */
  intentBuilderExtraInstructions: z.string().max(8192).optional(),
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

  /**
   * RFC-210 G8: pull each submodule to its upstream branch tip when a task
   * worktree is created, instead of the commit the superproject records.
   *
   * Applied ONCE, at worktree creation — never during the run. A task's nodes
   * must all see the same submodule state; letting it move mid-task would make
   * two nodes of one workflow disagree about what the code is.
   *
   * Default off: it trades reproducibility for freshness.
   */
  gitSubmoduleRemote: z.boolean().optional(),

  /**
   * RFC-308: administrator-owned Gitignore syntax for platform auto commits.
   * The canonical `.agent-workflow/` hard rule is always added separately and
   * cannot be negated by this list.
   */
  taskCommitExcludePatterns: TaskCommitExcludePatternsSchema.default([]),

  // --- RFC-210 recursive submodule isolation ---
  /**
   * Periodic background refresh of cached repos + their submodules. Without it
   * a mirror only advances when a task launches (warm fetch) or the user hits
   * Refresh by hand.
   *
   * OPTIONAL on purpose: every config.json already on disk predates this field,
   * and `ConfigSchema` must keep parsing those verbatim or the daemon refuses to
   * boot after an upgrade (locked by compat-config-versions.test.ts — making an
   * optional field required is the exact regression it exists to catch).
   * It still carries a value in DEFAULT_CONFIG, which is what puts it in the
   * deep-merge set and gives fresh installs the enabled default.
   */
  submoduleAutoRefresh: SubmoduleAutoRefreshSchema.optional(),

  // --- RFC-075 auto commit & push ---
  /**
   * @deprecated RFC-117 — superseded by `commitPushRuntime` (select a full runtime
   * profile; model comes from it). Transition fallback: when `commitPushRuntime`
   * is unset but this is set, the commit agent keeps its prior behavior (opencode +
   * this model). Physical removal is a follow-up cleanup (RFC-113→115 two-phase).
   */
  commitPushModel: z.string().min(1).optional(),
  /**
   * RFC-117 — runtime profile NAME the built-in commit agent runs on (like an
   * agent's `runtime`): protocol + binary + model from the selected profile. Unset
   * → fall back to deprecated `commitPushModel`, then inherit `defaultRuntime`.
   */
  commitPushRuntime: z.string().min(1).optional(),
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
  /**
   * RFC-157: language the built-in commit agent writes the commit-message
   * summary + body in (initial message AND push-repair message). Mirrors
   * `memoryDistillLang`: `undefined` is treated as 'en-US' at runtime, i.e.
   * unset and explicit 'en-US' are equivalent (English). The Conventional-Commits
   * `<type>(<scope>):` prefix ALWAYS stays lowercase ASCII (only the human
   * summary/body flips). Independent from the frontend UI `language`. Resolved
   * per scheduler kick (start/resume/retry) from live config like the other
   * commit-push knobs — NOT a distiller-style per-job freeze.
   */
  commitPushLang: LanguageSchema.optional(),

  // --- RFC-130 built-in merge-conflict resolver agent ---
  /**
   * @deprecated RFC-130 — superseded by `mergeAgentRuntime` (select a full runtime
   * profile; model comes from it). Transition fallback: when `mergeAgentRuntime`
   * is unset but this is set, the merge agent runs on opencode + this model.
   */
  mergeAgentModel: z.string().min(1).optional(),
  /**
   * RFC-130 §6.1 — runtime profile NAME the built-in merge-conflict resolver agent
   * runs on when a per-node isolated merge-back hits a real 3-way conflict (mirrors
   * `commitPushRuntime`: protocol + binary + model from the selected profile). Unset
   * → fall back to deprecated `mergeAgentModel`, then inherit `defaultRuntime`.
   */
  mergeAgentRuntime: z.string().min(1).optional(),

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

  // --- RFC-247 API / MCP surface ---
  /**
   * Master switch for the whole external programmatic surface: `POST /api/mcp`
   * AND the ability to issue new API tokens.
   *
   * Defaults to ENABLED. The alternative — ship dark and make every operator
   * flip a switch — trades a real usability cost for a theoretical one, since
   * the surface is inert until somebody deliberately creates a token, and
   * creating one is itself an explicit act.
   *
   * Turning it off is the incident lever: it stops new tokens being minted and
   * closes the MCP endpoint in one move. Existing tokens keep working on the
   * REST channel by design, so flipping this does not break running automation
   * that was never the problem.
   */
  mcpSurfaceEnabled: z.boolean().optional(),
  /**
   * RFC-247 D16 — how long token call-audit rows (and the delete snapshots
   * hanging off them) are kept. Default 90 days.
   */
  tokenAuditRetentionDays: z.number().int().positive().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

/** Default config — every field present, satisfies ConfigSchema. */
export const DEFAULT_CONFIG: Config = {
  $schema_version: CONFIG_SCHEMA_VERSION,
  maxConcurrentNodes: 4,
  maxConcurrentScriptNodes: 4,
  gitBaselineSyncWindowMs: 60_000, // RFC-287 G6 — 基线同步的总容忍窗口
  maxConcurrentCodeHostCalls: 8, // RFC-269 — no subprocess, only an in-flight request
  codeHostRequestTimeoutMs: 30 * 1000,
  codeHostResponseMaxBytes: 256 * 1024,
  multiProcessSubprocessConcurrency: 4,
  defaultPerTaskMaxDurationMs: 60 * 60 * 1000, // 1 hour
  defaultPerTaskMaxTotalTokens: 0, // 0 = unlimited
  // RFC-108 T4/AR-01: actually wired into the launch path (resolveLaunchRuntimeConfig)
  // so every node has a hard-timeout floor; was defined-but-never-threaded before.
  defaultPerNodeTimeoutMs: 30 * 60 * 1000, // 30 min
  defaultNodeRetries: 3, // RFC-115 — was RFC-042's hard-coded `?? 3` in scheduler
  scriptInterpreters: {}, // RFC-253 — empty ⇒ resolve every language from PATH
  scriptDepsInstallTimeoutMs: 10 * 60 * 1000,
  scriptEnvTtlDays: 30,
  // RFC-108 auto-recovery knobs — auto-execution OFF by default (decision D1).
  autoResumeOnBoot: false,
  autoRepair: {},
  autoKillStalledChild: false,
  heartbeatStallMs: 30 * 60 * 1000,
  maxAutoRecoveriesPerWindow: 3,
  autoRecoveryWindowMs: 60 * 60 * 1000,
  periodicOrphanReconcileMs: 10 * 60 * 1000,
  scheduledTasksEnabled: true,
  scheduledTasksMaxFailures: 10,
  maxActiveChildTasks: 8,
  maxInvocationDepth: 3,
  // RFC-213 disaster recovery
  backupIntervalMs: 0,
  backupRetentionCount: 7,
  backupRetentionDays: 30,
  backupMaxTotalBytes: 0,
  backupProtectedKeepCount: 10,
  // RFC-261 webhook 投递保留
  webhookDeliveryBodyRetentionDays: 30,
  webhookDeliveryRowRetentionDays: 90,
  eventStreamRetentionDays: 30,
  webhookTriggerFiresRetentionDays: 90,
  backupOnMigration: true,
  sqliteSynchronous: 'NORMAL',
  walCheckpointIntervalMs: 600_000,
  sqlitePageCacheMib: 128,
  sqliteMmapMib: 512,
  sqliteSlowQueryMs: 50,
  webhookTaskWorkspaceAutoCleanup: false,
  worktreeAutoGc: { enabled: false },
  eventsArchiveThresholds: {
    perNodeRunRows: 50_000,
    globalRows: 1_000_000,
    perNodeRunBytes: 8 * 1024 * 1024,
    globalBytes: 256 * 1024 * 1024,
  },
  submoduleAutoRefresh: { enabled: true },
  largeOutputThresholdBytes: 1_048_576, // 1 MB
  bindHost: '127.0.0.1',
  language: 'zh-CN',
  theme: 'system',
  logLevel: 'info',
  taskCommitExcludePatterns: [],
}

/**
 * Patch schema: any subset of the full config (except $schema_version),
 * sent by PUT /api/config and merged onto the current config.
 */
export const ConfigPatchSchema = ConfigSchema.partial()
  .omit({ $schema_version: true })
  // RFC-117: the runtime-selector "Inherit" option clears these by sending null
  // (mergePatch deletes the key → back to inheriting the global default). The
  // base ConfigSchema keeps them string|undefined; only the PATCH accepts null.
  //
  // RFC-156: the "System agents" tab widens this to ALL three internal-agent
  // runtimes (adds mergeAgentRuntime — previously UI-less so its "inherit" was
  // never sendable → 400) AND to the three deprecated per-agent model fields. D6:
  // every runtime-selector interaction also clears its paired legacy `*Model`, so
  // "inherit" is honest even on a migrated config that still carries a stale model
  // (resolveInternalAgentRuntime falls runtimeName → deprecatedModel → defaultRuntime;
  // deleting only the runtime would otherwise fall THROUGH to the legacy model).
  // The base ConfigSchema is unchanged (still min(1)); null is patch-only = delete.
  //
  // RFC-157: the two internal-agent output-language fields also accept null in
  // the PATCH so the "System agents" tab's language <Select> can CLEAR a saved
  // value back to Default (mergePatch deletes the key → runtime falls back to
  // 'en-US'). JSON.stringify drops undefined, so the UI must send null to
  // actually remove a stored language — undefined would be treated as "no change"
  // and the pick could never revert zh-CN to Default. The base ConfigSchema keeps
  // them `LanguageSchema.optional()` (no null); null is patch-only = delete.
  .extend({
    defaultPerTaskMaxDurationMs: boundedSettingsInteger('defaultPerTaskMaxDurationMs').optional(),
    defaultPerTaskMaxTotalTokens: boundedSettingsInteger('defaultPerTaskMaxTotalTokens').optional(),
    defaultPerNodeTimeoutMs: boundedSettingsInteger('defaultPerNodeTimeoutMs').optional(),
    defaultNodeRetries: boundedSettingsInteger('defaultNodeRetries').optional(),
    largeOutputThresholdBytes: boundedSettingsInteger('largeOutputThresholdBytes').optional(),
    maxConcurrentNodes: boundedSettingsInteger('maxConcurrentNodes').optional(),
    maxConcurrentScriptNodes: boundedSettingsInteger('maxConcurrentScriptNodes').optional(),
    multiProcessSubprocessConcurrency: boundedSettingsInteger(
      'multiProcessSubprocessConcurrency',
    ).optional(),
    heartbeatStallMs: boundedSettingsInteger('heartbeatStallMs').optional(),
    maxAutoRecoveriesPerWindow: boundedSettingsInteger('maxAutoRecoveriesPerWindow').optional(),
    autoRecoveryWindowMs: boundedSettingsInteger('autoRecoveryWindowMs').optional(),
    periodicOrphanReconcileMs: boundedSettingsInteger('periodicOrphanReconcileMs').optional(),
    gitSubmoduleJobs: boundedSettingsInteger('gitSubmoduleJobs').optional(),
    submoduleAutoRefresh: z
      .object({
        enabled: z.boolean(),
        intervalMs: boundedSettingsInteger('submoduleAutoRefresh.intervalMs').optional(),
        onlyRecentDays: boundedSettingsInteger('submoduleAutoRefresh.onlyRecentDays').optional(),
      })
      .optional(),
    worktreeAutoGc: z
      .object({
        enabled: z.boolean(),
        olderThanDays: boundedSettingsInteger('worktreeAutoGc.olderThanDays').optional(),
        onlyMerged: z.boolean().optional(),
      })
      .optional(),
    eventsArchiveThresholds: z
      .object({
        perNodeRunRows: boundedSettingsInteger('eventsArchiveThresholds.perNodeRunRows'),
        globalRows: boundedSettingsInteger('eventsArchiveThresholds.globalRows'),
        perNodeRunBytes: boundedSettingsInteger(
          'eventsArchiveThresholds.perNodeRunBytes',
        ).optional(),
        globalBytes: boundedSettingsInteger('eventsArchiveThresholds.globalBytes').optional(),
      })
      .optional(),
    backupProtectedKeepCount: boundedSettingsInteger('backupProtectedKeepCount').optional(),
    eventStreamRetentionDays: boundedSettingsInteger('eventStreamRetentionDays').optional(),
    webhookTriggerFiresRetentionDays: boundedSettingsInteger(
      'webhookTriggerFiresRetentionDays',
    ).optional(),
    webhookDeliveryBodyRetentionDays: boundedSettingsInteger(
      'webhookDeliveryBodyRetentionDays',
    ).optional(),
    webhookDeliveryRowRetentionDays: boundedSettingsInteger(
      'webhookDeliveryRowRetentionDays',
    ).optional(),
    bindPort: boundedSettingsInteger('bindPort').optional(),
    commitPushMaxRepairRetries: boundedSettingsInteger('commitPushMaxRepairRetries').optional(),
    commitPushDiffMaxBytes: boundedSettingsInteger('commitPushDiffMaxBytes').optional(),
    taskCommitExcludePatterns: TaskCommitExcludePatternsSchema.nullable().optional(),
    memoryDistillRuntime: z.string().min(1).nullable().optional(),
    changeNarrativeRuntime: z.string().min(1).nullable().optional(),
    commitPushRuntime: z.string().min(1).nullable().optional(),
    mergeAgentRuntime: z.string().min(1).nullable().optional(),
    memoryDistillModel: z.string().min(1).nullable().optional(),
    commitPushModel: z.string().min(1).nullable().optional(),
    mergeAgentModel: z.string().min(1).nullable().optional(),
    memoryDistillLang: LanguageSchema.nullable().optional(),
    commitPushLang: LanguageSchema.nullable().optional(),
    // RFC-234: the intent-builder settings card follows the same
    // "null-in-patch = delete = inherit/default" contract for its selector
    // and optional knobs (base ConfigSchema stays non-null).
    intentBuilderRuntime: z.string().min(1).nullable().optional(),
    intentBuilderLang: LanguageSchema.nullable().optional(),
    intentBuilderTurnTimeoutMs: boundedSettingsInteger('intentBuilderTurnTimeoutMs')
      .nullable()
      .optional(),
    intentBuilderStdoutCapBytes: z
      .number()
      .int()
      .min(256 * 1024)
      .max(16 * 1024 * 1024)
      .nullable()
      .optional(),
    intentBuilderMaxGenerateRounds: boundedSettingsInteger('intentBuilderMaxGenerateRounds')
      .nullable()
      .optional(),
    intentBuilderMaxQuestionRounds: z.number().int().min(0).max(50).nullable().optional(),
    intentBuilderScratchRetentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .nullable()
      .optional(),
    intentBuilderExtraInstructions: z.string().max(8192).nullable().optional(),
  })
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
