// RFC-111 PR-A — runtime abstraction types.
//
// The platform drives one agent CLI per node_run. Today that CLI is opencode,
// hardcoded throughout runner.ts. This module introduces a thin `RuntimeDriver`
// seam (multica's Backend-factory pattern) so a second runtime (Claude Code,
// PR-B) can plug in. PR-A extracts the opencode logic behind this seam WITHOUT
// behavior change — the generic spawn lifecycle / kill escalation / DB
// persistence / envelope parsing in runner.ts stay runtime-agnostic.
//
// The interface grows across PR-A slices: A1 adds `parseEvent`; a later slice
// adds `buildSpawn`; PR-B adds `probe` / `listModels` / `captureSession`.
//
// RFC-143 (capability consolidation) fills in the PR-B promise: probe /
// listModels / captureSessions / defaultBinary become first-class driver
// methods (this PR-1), `buildBusinessSpawn` + optional readInventory? /
// startLiveCapture? land in later PRs. Type-only imports below keep this a
// compile-time module (no runtime edge into db/log/shared).

import type { DbClient } from '@/db/client'
import type { Logger } from '@/util/log'
import type {
  Agent,
  FaceSupport,
  InventoryDeclaration,
  InventorySnapshot,
  Mcp,
  RuntimeConfigDirProfile,
  RuntimeInventoryPayload,
} from '@agent-workflow/shared'
import type { LivePollOptions, LivePollerHandle } from './opencode/subagentLiveCapture'
// Type-only (erased at runtime): runtimeRegistry value-imports runtime/index,
// so a VALUE import here would close a module-init cycle. RuntimeProfile is the
// RFC-113 resolved param set threaded through BusinessNodeSpawnContext.
import type { RuntimeProfile } from '@/services/runtimeRegistry'
// RFC-280 T1 — unified injection layer shapes (type-only; agentInjection is a
// leaf module, see its header).
import type { DeclaredManifestV1, RuntimePlugin } from '@/services/execution/agentInjection'

export type RuntimeKind = 'opencode' | 'claude-code'

/**
 * RFC-280 T1/T2 — input to the unified injection render hook. T1 carries the
 * MCP face; T2 adds the declaration faces (agent/dependents/skills/plugins/
 * profile) so the manifest covers every injected surface. Omitted faces
 * declare as empty.
 */
export interface AgentInjectionSpecV1 {
  mcps: readonly Mcp[]
  /** Primary agent (name for subagent dedupe; permission for the claude gate). */
  agent?: Agent
  /** dependsOn closure, BFS order, root excluded. */
  dependents?: readonly Agent[]
  /** Root agent's resolved runtime profile (claude droppedParams derivation). */
  profile?: RuntimeProfile
  /**
   * Framework skills selected for this run.
   * RFC-282 §7-8 (widened in B1a, ahead of B2 — 设计门 P1-2): the old
   * `{name; sourceKind}[]` was declaration-only; actual staging consumes
   * `ResolvedSkill` (sourcePath / skillId / contentVersion — the RFC-178/223
   * content-fence payload). Backward-compatible widening: every field beyond
   * the original two is optional, and declaration consumers read name/sourceKind.
   */
  skills?: readonly ResolvedSkill[]
  /** Selected plugins (opencode face; claude declares them unsupported). */
  plugins?: readonly RuntimePlugin[]
}

/** RFC-280 T1 — output of the unified injection render hook. */
export interface RenderedInjectionV1 {
  /**
   * Per-runtime MCP wire entries keyed by runtime name — opencode:
   * `OPENCODE_CONFIG_CONTENT.mcp`; claude: `--mcp-config.mcpServers`.
   * `null` when nothing enabled remains (claude callers omit the flag).
   */
  mcpEntries: Record<string, Record<string, unknown>> | null
  /** Declared-injection manifest — input to startup verification (T3). */
  declared: DeclaredManifestV1
}

/** Where an injected skill comes from (RFC-004; moved here from runner.ts so
 *  drivers can type their skill inputs without a runner import — RFC-143 PR-4;
 *  runner re-exports both for existing import sites). RFC-178: skills are
 *  managed-only; `project` = a repo-local skill the CLI self-discovers. */
export type SkillSource = 'managed' | 'project'

export interface ResolvedSkill {
  name: string
  sourceKind: SkillSource
  /** Absolute path for managed. Unused for project (self-discovered). */
  sourcePath?: string
  /** Managed resource identity and revision used for dispatch fencing. */
  skillId?: string
  contentVersion?: number
  /** Re-read the owning row at both sides of the filesystem snapshot. */
  readContentVersion?: () => Promise<number>
}

/** The config subset `defaultBinary` reads — the per-runtime binary path keys.
 *  Narrow (not the full Config) so runtimeRegistry / routes can pass their own
 *  slim config shapes without a Config dependency in this type module. */
export interface RuntimeBinaryConfig {
  opencodePath?: string | null
  claudeCodePath?: string | null
}

/** Running per-run token totals (mirrors RunResult['tokenUsage']). */
export interface RuntimeTokenUsage {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

/** Per-event token contribution a driver extracts from one stdout event. */
export interface NormalizedTokenDelta {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

/**
 * The node_run_events `kind` values a driver may emit from stdout. Mirrors the
 * opencode `inferEventKind` output set exactly (the generic pump persists this
 * verbatim). `stderr` is NOT here — it is written by the stderr pump, not by
 * `parseEvent`.
 */
export type NormalizedEventKind =
  | 'tool_use'
  | 'text'
  | 'reasoning'
  | 'permission_asked'
  | 'error'
  | 'step_start'
  | 'step_finish'
  /**
   * RFC-297 T5/T8 —— 一份运行时启动清单，由 `drainFinalEvents()` 在子进程退出后
   * 以**合成事件**补发（opencode 在那里读它的 dump 文件）。它没有对应的 stdout
   * 原文行，故自成一个 kind 且 `persist: false`。
   *
   * claude **不用**这个 kind：它的 `system/init` 本身已是结构化事件（kind
   * `step_start`，且是根会话身份的观测点），清单只是挂在其 `data` 上——改判 kind
   * 会同时动落库与 session 认领两处既有行为。
   */
  | 'startup_inventory'

/**
 * RFC-297 T5 —— 允许落 `node_run_events` 的 kind 子集。镜像该列的 enum
 * （`db/schema.ts`），其中**刻意不含** `startup_inventory`：合成事件没有原文行，
 * 其载荷的正式归宿是 `node_runs` 的清单列。
 *
 * 写成类型而不只是运行时的 `persist` 标志，是为了让「忘了过滤」在**编译期**报错，
 * 而不是半夜被 DB 的约束拒绝。
 */
export type PersistedEventKind = Exclude<NormalizedEventKind, 'startup_inventory'>

/**
 * One stdout line normalized into the runtime-agnostic shape the generic pump
 * consumes. A driver's `parseEvent` returns this for every line it recognizes
 * as a structured event, or `null` to route the line through the pump's
 * non-JSON fallback (kind=text, raw payload, pushed to the agent-text buffer).
 */
export interface NormalizedEvent {
  /** node_run_events.kind for the persisted row. */
  kind: NormalizedEventKind
  /**
   * Visible agent text this event contributes to the `<workflow-output>`
   * envelope buffer. `null`/`undefined` = no text (event still persists).
   */
  text?: string | null
  /**
   * Runtime-native session identity observed on this root-conversation event.
   * The pump captures the first value for resume and rejects an unannounced
   * change. Drivers must omit sidechain/subagent-local ids.
   */
  sessionId?: string
  /**
   * A runtime-declared conversation boundary. `outgoingSessionId` is the
   * native id being replaced; `newConversationId` is correlation metadata and
   * is NOT necessarily the next resumable native id. The pump learns that id
   * from the first subsequent root event carrying `sessionId`.
   */
  conversationReset?: {
    outgoingSessionId: string
    newConversationId: string
  }
  /** Event timestamp (ms epoch) if the runtime provided one. */
  timestamp?: number
  /** Token usage this event contributes, if any. */
  tokens?: NormalizedTokenDelta
  /** The original stdout line, persisted verbatim into node_run_events.payload. */
  rawLine: string
  /**
   * RFC-297 T5 — kind-specific structured payload. Every field above is a
   * cross-cutting concern the generic pump reads; this is where a driver hands
   * a *particular* observation to whichever stage cares, without every other
   * stage having to know it exists.
   */
  data?: NormalizedEventData
  /**
   * RFC-297 T5 — whether this event lands in `node_run_events`. Defaults to
   * true (every event historically persisted). Synthetic events whose payload
   * has a proper home elsewhere set false: the inventory snapshot can run to
   * tens of KB and already persists to its own column.
   *
   * PR-2 只立契约，消费点在 PR-3 接入 pump 时落地——那批同时会给合成事件引入
   * 独立的 kind 并收紧落库侧的类型（本列 enum 不含它）。
   */
  persist?: boolean
}

/**
 * RFC-297 T5 — the kind-specific payloads an event may carry. Optional by
 * construction: a stage reads only its own key and ignores the rest.
 */
export interface NormalizedEventData {
  /** The runtime's own startup inventory, already normalized by the driver. */
  inventory?: RuntimeInventoryPayload
}

export type TerminalResultObservation = 'success' | 'error' | 'not-observed'

export interface SystemAgentOutputEvidence {
  assistantTextSeen: boolean
  observedAssistantTextBytes: number
  retainedAssistantTextBytes: number
  eventTextCapHit: boolean
  unparsedStdoutSeen: boolean
  lastNormalizedEventKind: NormalizedEventKind | null
  lastRuntimeEventType: string | null
  terminalResult: TerminalResultObservation
}

export interface SystemEventObservation {
  runtimeEventType: string | null
  terminalResult: Exclude<TerminalResultObservation, 'not-observed'> | null
}

/**
 * A driver's argv + env + stdin plan for one node_run spawn. `stdin: pipe`
 * delivers the prompt over stdin (claude, D12); omitted / `ignore` = no stdin
 * (opencode passes the prompt positionally). `cleanup` removes any per-run temp
 * the driver created.
 */
export interface SpawnPlan {
  cmd: string[]
  env: Record<string, string>
  stdin?: { mode: 'ignore' } | { mode: 'pipe'; data: string }
  /** Last-moment product lifecycle fence, run immediately before process creation. */
  beforeSpawn?: () => void | Promise<void>
  cleanup?: () => void | Promise<void>
  /** MCP names supplied by the platform, used only for non-blocking diagnostics. */
  declaredMcpServers?: readonly string[]
  /**
   * RFC-143 §4.4 — spawn-assembly facts the runner's `spawning agent runtime`
   * diagnostic log flat-spreads (inlineModel / mcpKeys / pluginNames …). The
   * inline-config build lives inside `buildBusinessSpawn` now, so the driver
   * reports what actually landed; the runner never re-derives it.
   */
  diagnostics?: Record<string, unknown>
}

/** Version probe result for a runtime binary. RFC-143: the union superset of
 *  OpencodeProbe (adds `ran`) and ClaudeProbe (adds `ran` + `apiKeySource`), so
 *  both drivers' probe results assign to it. */
export interface RuntimeProbe {
  binary: string
  version: string | null
  compatible: boolean
  incompatibleReason?: string
  /** RFC-135: true iff `--version` exited 0 (availability sans version gating). */
  ran?: boolean
  /** claude only: auth source as Claude Code reports it (`none` ≠ unauthed). */
  apiKeySource?: string
}

/** Options for a version probe (mirrors util/opencode ProbeOpts). */
export interface ProbeOpts {
  /** Kill the probe after this many ms (SIGKILL; result reads as failed). */
  timeoutMs?: number
  /** Suppress per-probe warn logs (the status endpoint owns its own surfacing). */
  quiet?: boolean
}

/** One selectable model surfaced to the agent/settings model pickers. */
export interface RuntimeModel {
  id: string
  provider?: string
  modelID?: string
  name?: string
}

/** `listModels` result — unified across CLI-backed (opencode, cached) and
 *  static-table (claude, always `cached:true`) runtimes. */
export interface RuntimeModelList {
  binary: string
  models: RuntimeModel[]
  cached: boolean
}

/** Options for `listModels`. `refresh` bypasses the per-binary cache (opencode
 *  CLI path); claude's static table ignores both. */
export interface ListModelsOpts {
  refresh?: boolean
  timeoutMs?: number
  /**
   * RFC-255 test seam: supply the daemon config that names custom providers.
   * Production reads the real config file.
   * 2026-08-06 restore: this and `injectedProviderSection` were accidentally
   * swept out inside an unrelated commit while their committed consumers
   * (cli/start.ts, opencode/models.ts) still reference them — main went
   * typecheck-red. Restored verbatim; the RFC-255→256 teardown commit removes
   * them TOGETHER with those consumers.
   */
  loadCustomProviderConfig?: () => { customProviders?: unknown }
  /**
   * RFC-255 catalog probe: enumerate with THIS provider section instead of the
   * configured gateways, and skip the cache. Used to detect an id that would
   * merge into a built-in catalog provider.
   */
  injectedProviderSection?: Record<string, unknown>
  /** Optional subprocess environment (OpenCode only). */
  env?: Record<string, string>
  /** Optional diagnostic working directory. */
  cwd?: string
  /** Final async fence that must pass before a fresh result enters the cache. */
  beforeCacheWrite?: () => void | Promise<void>
}

/** run-after subagent session capture inputs (union; each driver takes what it
 *  needs — opencode: SQLite BFS + partId dedupe; claude: JSONL under claude's
 *  user-level config root). */
export interface SessionCaptureContext {
  /** Native store/directory lookup key for this captured epoch. */
  rootSessionId: string
  /** Optional final logical root bucket when lookup and resume epochs differ. */
  logicalRootSessionId?: string
  nodeRunId: string
  taskId: string
  db: DbClient
  log: Logger
  /** Subprocess cwd (worktree) — claude's `/`→`-` slug is the projects subdir. */
  worktreePath: string
  /** RFC-154: selected config-dir profile (env var NAME + leaf dir name) of the
   *  runtime row. claude resolves its transcript roots from BOTH halves (see
   *  claudeUserConfigRoots — the platform writes neither since RFC-276, so the
   *  operator's daemon env / home decides). Omitted → protocol defaults.
   *  opencode ignores both (SQLite capture). */
  configDirEnv?: string
  configDirName?: string
  /** opencode: partId-level dedupe from the live poller (skip already-written rows). */
  alreadyInsertedPartIds?: Map<string, Set<string>>
  /** opencode: override SQLite path (tests). */
  opencodeDbPath?: string
}

/** Optional post-run transcript capture for memory-distiller jobs. */
export interface DistillSessionCaptureContext {
  rootSessionId: string
  distillJobId: string
  attemptIndex: number
  db: DbClient
  log?: Logger
}

/**
 * RFC-117 — spawn inputs for a framework "system agent" (distiller / commit /
 * fusion-merger): one agent with a persona + model, NO skills / mcp / plugins /
 * inventory / inline-config mutation. Each driver's `buildSpawn` translates this
 * into its own argv+env (opencode inline config vs claude system-prompt-file).
 * Distinct from the business-node spawn path in runner.ts, which keeps its
 * skills/mcp/inventory assembly + golden byte-lock and does NOT route here.
 *
 * @deprecated RFC-284 T19 —— legacy ctx：唯一装配入口已是 `buildSpawn(AgentSpawnContext)`
 * （RFC-282 B1b），本型只存活于 spawnCtx 翻译层；真删随 RFC-282 plan §实施记录
 * 的 B4「true merge」登记项。不要新增消费方。
 */
export interface SystemAgentSpawnContext {
  /** The (virtual) agent name — opencode inline config key. */
  agentName: string
  /** Persona — opencode inline config `prompt` / claude `--append-system-prompt-file`. */
  systemPrompt: string
  /** Model from the resolved runtime profile; null/'' → the runtime's own default. */
  model?: string | null
  /** User prompt — opencode positional argv / claude stdin. */
  prompt: string
  /**
   * 2026-08-04 — per-runtime extra argv tokens (registry-validated, claude
   * fork flags). Consumed by the claude driver only; passed by the SMOKE so a
   * probe reproduces the runtime's real shape. System features may omit it when
   * they intentionally use the runtime's default CLI surface.
   */
  extraArgs?: readonly string[]
  /** RFC-276: opt-in Claude CLI compatibility marker; not a sandbox boundary. */
  isSandbox?: boolean
  /** Subprocess cwd (distiller: a throwaway temp dir). */
  worktreePath: string
  /** Per-run dir (opencode: its OPENCODE_CONFIG_DIR; claude: the attempt dir
   *  holding system.md / settings.json / mcp-config.json — since RFC-276 claude
   *  gets NO platform config dir, it uses the operator's own). */
  runDir: string
  /** Optional OpenCode command head; tests may provide a multi-token executable. */
  opencodeCmd?: readonly string[]

  runtimeBinary?: string
  /**
   * RFC-254: the claude driver's analogue of `opencodeCmd` — a full command head
   * consumed by `buildSpawn` via `pickRuntimeHead(runtimeBinary, runtimeCmd)`.
   * Production never sets it (it sets `runtimeBinary`), so behavior is unchanged;
   * it exists so the Windows smoke can spawn `[bun, run, mock]` instead of a
   * `.sh` wrapper (unspawnable on Windows). Mirrors `BusinessNodeSpawnContext`
   * (mutable `string[]` — the shape `pickRuntimeHead`'s fallback param takes).
   */
  runtimeCmd?: string[]
  /**
   * RFC-237 (design-gate P1-2) — RFC-154 config-dir profile of the SELECTED
   * runtime row (env-var name + leaf), threaded so a custom claude fork that
   * changed its discovery surface still uses its expected project config path.
   * Omitted → protocol defaults (every pre-RFC-237 caller unchanged; opencode
   * ignores both).
   */
  configDirEnv?: string
  configDirName?: string
  /** RFC-026 clarify-rerun: resume a prior session. */
  resumeSessionId?: string
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /**
   * RFC-280 T6 — the unified injection render for a system agent that carries
   * MCP servers (the MCP playground). The driver mounts `mcpEntries` on its
   * own wire (opencode: inline-config `mcp` record; claude: an mcp-config.json
   * written 0600 under `runDir` + `--mcp-config`). Ordinary system agents omit
   * this — zero MCP, byte-identical spawn.
   */
  mcpInjection?: RenderedInjectionV1
  /**
   * RFC-297 T13 —— 这一轮是不是「fresh 的 agent 运行」：agent 类节点 + 没有复用
   * 既有原生会话。这是一条**业务事实**，不是「谁想要清单」。
   *
   * 原名 `wantsInventory` 把运行时需求写进了调用方：调用方得先知道「opencode 要
   * 物化 dump 插件、claude 不用」才能填对，于是 MCP 测试台里长出了
   * `capabilities.startupObservation === 'inventory-file'` 这种判据。现在调用方
   * 只陈述事实，「据此要不要物化插件」是各 driver 自己的知识。
   */
  freshAgentRun?: boolean
  /** claude — pre-allocated native session id (`--session-id`, playground turn 1). */
  nativeSessionId?: string
  /**
   * RFC-280 §7.2 — the remaining resolved-profile params. The system-agent
   * inline entry now renders through the same `renderOpencodeAgentEntry` the
   * business path uses, so variant/temperature/steps/maxSteps land instead of
   * being silently dropped (the playground previously hand-rolled them).
   * claude consumes `model` only (落差④ droppedParams covers the rest).
   */
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  maxSteps?: number | null
  /** Caller's logger for driver-internal warnings (claude config-dir prep);
   *  omitted → the driver's own default logger. RFC-143 PR-4 (smoke parity). */
  log?: Logger
}

/** RFC-281 T3 test seam shape (named in RFC-282 B1a so the unified ctx can
 *  reference it without an inline duplicate). */
export interface BoundaryHostProbe {
  platform: NodeJS.Platform
  hasExecutable: (bin: string) => boolean
}

/**
 * RFC-282 B1a (§2.1) — THE spawn-assembly input. One shape for business and
 * system spawns: persona-only = `injection` is an empty set, not a separate
 * branch (决策 5). During the B1 transition both legacy contexts remain; B1b
 * migrates the five call chains here and deletes them.
 */
export interface AgentSpawnContext {
  /** Runtime-neutral injection intent. System faces pass an empty spec. */
  readonly injection: AgentInjectionSpecV1
  // ── prompt & persona (设计门 P1-1: без any of the three, no face can speak) ──
  /** User prompt. opencode: positional argv; claude: stdin. */
  readonly prompt: string
  /** Agent name — inline-entry map key / `--agents` identity. */
  readonly agentName: string
  /** Persona body: system face persona text; business face = agent body. */
  readonly systemPrompt: string
  /** RFC-041 memory block (null/omitted = no weave). */
  readonly injectedMemoryBlock?: string | null
  /**
   * Per-agent resolved runtime profile (root INCLUDED — 设计门 P1-1: a
   * singular `profile` silently drops every dependent's model). */
  readonly resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>
  /** Child-process cwd (business: task worktree; system: scratch dir). */
  readonly cwd: string
  /** Per-run root (`<appHome>/runs/<taskId>/<nodeRunId>` or the scratch run dir). */
  readonly runRoot: string
  /**
   * RFC-154 config-dir profile. REQUIRED on business spawns (the runner
   * always threads the frozen/default profile). OPTIONAL on persona-only
   * spawns — omitted keeps the legacy system default (opencode: config dir =
   * runRoot itself, no leaf; distiller/smoke shape), which an explicit
   * DEFAULT_CONFIG_DIR_PROFILE would silently change (§0 字节等价).
   */
  readonly configDir?: RuntimeConfigDirProfile
  /**
   * RFC-281 mounts making up THIS task's legal workspace. 设计门 P1-10(b):
   * this is the ONLY boundary field — `BoundaryCtx` construction stays inside
   * each driver (its contents are runtime knowledge). Omitted = no boundary
   * (system faces, v1).
   */
  readonly taskMounts?: readonly string[]
  /** RFC-281 T3 sandbox-availability probe seam (degrade-loudly branch tests). */
  readonly boundaryHostProbe?: BoundaryHostProbe
  /** RFC-297 T13 —— fresh 的 agent 运行（业务事实；driver 自行决定据此做什么）。 */
  readonly freshAgentRun: boolean
  // ── sessions: the two fields stay SEPARATE (设计门 P1-1) ──
  /** Pre-minted native session id (playground turn 1 / first dispatch). */
  readonly nativeSessionId?: string | null
  /** Resume a captured session (RFC-026/148). Mutually exclusive with
   *  `nativeSessionId` — drivers keep their conflict throw. */
  readonly resumeSessionId?: string | null
  /**
   * RFC-111 D15 + RFC-112 — binary FROZEN on the node_run, passed in by the
   * caller. 设计门 P1-3: drivers must NOT re-resolve from the registry
   * (resume/retry read the frozen snapshot, never the mutable registry).
   */
  readonly runtimeBinary?: string | null
  /**
   * TEST-ONLY command-head override (决策 17 narrowed scope): the runtime-
   * neutral successor of `opencodeCmd`/`runtimeCmd`. Its PRESENCE also gates
   * the claude credential bridge OFF (existing runtimeCmd semantics).
   * Production always undefined.
   */
  readonly binaryOverride?: readonly string[]
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
  /** Per-runtime extra argv tokens (registry-validated fork flags). */
  readonly extraArgs?: readonly string[]
  readonly nodeRunId: string
  readonly log: Logger
}

/**
 * RFC-282 B1a — SpawnPlan with the declared manifest as a REQUIRED return
 * field: the declaration is a by-product of the same assembly call, so
 * "declared says injected, actual spawn didn't" is structurally impossible
 * (决策 2/9). Interim shape — B1b folds `declared` into SpawnPlan itself once
 * the legacy assembly methods are gone.
 */
export interface AgentSpawnPlan extends SpawnPlan {
  readonly declared: DeclaredManifestV1
}

/**
 * RFC-143 PR-4 — spawn inputs for a BUSINESS node run (the runner.ts path with
 * skills / mcp / plugins / inventory / memory weave — everything
 * `SystemAgentSpawnContext` deliberately excludes). A union ctx: each driver
 * takes what it needs and ignores the rest. The runner renders the prompt,
 * resolves the per-agent runtime profiles (async DB) and the memory block, then
 * hands these raw materials over; the driver owns its runtime's ENTIRE assembly
 * (opencode: inline-config build + inventory plugin + memory append + serialize;
 * claude: system-prompt-file + mcp/agents flags + worktree resource projection).
 *
 * @deprecated RFC-284 T19 —— legacy ctx：唯一装配入口已是 `buildSpawn(AgentSpawnContext)`
 * （RFC-282 B1b），本型只存活于 spawnCtx 翻译层；真删随 RFC-282 plan §实施记录
 * 的 B4「true merge」登记项。不要新增消费方。
 */
export interface BusinessNodeSpawnContext {
  /** The (node-selected) primary agent. */
  agent: Agent
  /** The fully rendered user prompt (runner-side; drivers only deliver it). */
  prompt: string
  /**
   * RFC-041 injected memory block (null = no inject / followup). Drivers weave
   * it into their persona surface: opencode appends to the inline agent prompt,
   * claude appends to the system-prompt-file text.
   */
  injectedMemoryBlock: string | null
  /** RFC-022: dependsOn closure (BFS order, root excluded). */
  dependents: readonly Agent[]
  /** RFC-028 MCP rows (drivers apply their own enabled-filter + translation). */
  mcps: readonly Mcp[]
  /** RFC-031 opencode plugin rows (claude ignores). */
  plugins: readonly RuntimePlugin[]
  /**
   * RFC-113: resolved runtime profile per agent name (root INCLUDED). Resolved in the
   * runner (async DB reads stay out of drivers — RFC-143 §4.6C).
   */
  resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>
  /** Skills for this agent — OpenCode stages into its run config dir; Claude
   *  creates a runRoot attachment plus ephemeral project projections for
   *  skills and one-file-per-dependent agents under `<worktree>/<configDir.name>`. */
  skills: readonly ResolvedSkill[]
  /** RFC-026 clarify-inline rerun: resume the prior session. */
  resumeSessionId?: string
  /** Subprocess cwd = task worktree. */
  worktreePath: string
  /**
   * RFC-281 T3 test seam: how the driver decides whether Claude's sandbox
   * mechanism exists on THIS host (macOS = always; Linux = bwrap+socat on PATH).
   * Production omits both — the driver falls back to `process.platform` and
   * `Bun.which`. Tests inject them to exercise the degrade-loudly branch, which
   * is otherwise unreachable on a developer machine.
   */
  boundaryHostProbe?: BoundaryHostProbe
  /**
   * RFC-281 T1: absolute mount paths that make up THIS task's legal workspace,
   * for the opencode `external_directory` boundary re-allow set. Source = the
   * scheduler's per-repo iso worktrees, forwarded by the runner as
   * `templateMeta.repos[].worktreePath`; single-repo tasks pass `[worktreePath]`.
   * The driver adds runDir / staged skills / tmp itself. Always non-empty.
   */
  taskMounts: readonly string[]
  /**
   * Per-run root (`<appHome>/runs/<taskId>/<nodeRunId>`). OpenCode's config dir
   * is `<runRoot>/<configDir.name>`; Claude keeps system/attachment artifacts
   * here while native skill/agent projections live in the disposable worktree.
   */
  runRoot: string
  /**
   * RFC-154 selected config-dir profile. OpenCode uses both env + runRoot leaf.
   * Natural Claude does not rewrite the env (preserving operator auth/config)
   * and uses `name` as its worktree project-config leaf.
   */
  configDir: RuntimeConfigDirProfile
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** RFC-112: selected custom-fork binary — overrides every default head. */
  runtimeBinary?: string | null
  /**
   * opencode-ONLY head fallback. LEGACY internal shape: production head
   * resolution moved into the mint freeze chain (RFC-282 C1) and the public
   * contract is `binaryOverride`; this field survives only inside the
   * spawnCtx translation layer until the B4-style "true merge" removes the
   * legacy ctx types (registered in RFC-282 plan §实施记录). Other drivers
   * MUST ignore it (Codex P1-1: a custom opencodePath must never become
   * another runtime's argv head).
   */
  opencodeCmd?: string[]
  /**
   * Generic TEST-ONLY head override (mock-claude / future mocks). Production
   * never sets it; its PRESENCE is the signal that gates claude's subscription
   * credential bridge OFF so CI never touches the keychain.
   */
  runtimeCmd?: string[]
  /**
   * RFC-029/042 的业务门，由调用方算好：`isAgentRunKind(nodeKind) &&
   * !envelopeFollowup`。RFC-297 T13 起字段名只陈述这条事实——运行时**能不能**
   * 产出清单是各 driver 自己的能力（claude 直接忽略本字段）。
   */
  freshAgentRun: boolean
  /** For driver-internal log lines (inventory materialize failure etc.). */
  nodeRunId: string
  log: Logger
}

/**
 * A pluggable agent runtime. RFC-143: a complete capability object — new runtime
 * = register a driver in DRIVERS + implement this interface, zero call-site edits.
 * `buildBusinessSpawn` + optional `readInventory?`/`startLiveCapture?` land in
 * later RFC-143 PRs; this interface reflects PR-1's surface.
 */
/**
 * RFC-282 A3 — the faces of `DeclaredManifestV1` a driver must take a stance
 * on. Derived with `keyof`, so ADDING a manifest face is a compile error in
 * every driver's `declarationFaces` record until it states support (§4.4-2).
 */
export type DeclarationFace = keyof DeclaredManifestV1

/**
 * RFC-297 T1 — the authoritative definition moved to shared so the frontend can
 * pick columns off a driver's declaration; re-exported here so every existing
 * `from '@/services/runtime/types'` import site keeps resolving. Semantics are
 * unchanged: supported = the runtime has this face and it can be observed;
 * unsupported = the runtime has no such concept (e.g. claude × plugin);
 * unobservable = injected, but no observation channel (e.g. opencode × plugin).
 */
export type { FaceSupport }

/**
 * RFC-282 A3 — a driver's STATIC self-declaration, consumed by the boot
 * self-check (every registered driver must cover every face) and later (C2)
 * by the runner's observation switch.
 *
 * 命名注意（设计门 P2-4）：**不叫 `RuntimeCapabilities`** —— 本文件已有
 * `DeclaredRuntimeCapabilities`，语义是「运行时启动清单里**观测到**的能力」，
 * 与这里「driver **静态声明**的能力」完全不同却只差一个词。
 *
 * A3 deliberately carries ONLY the three new dimensions. The existing
 * per-driver scalars (`minVersion` / `acceptsExtraArgs` /
 * `acceptsSandboxCompatibilityMarker`) stay where they are — folding them in
 * here while their consumers still read the driver fields would be a second
 * copy of each value, which is exactly what this RFC exists to kill.
 */
export interface RuntimeDriverCapabilities {
  /**
   * Where this runtime's startup inventory comes from. The runner switches on
   * this (C2) instead of the `readInventory !== undefined` proxy; a third
   * runtime must state its source explicitly instead of falling into an
   * if-opencode-else-claude branch.
   */
  readonly startupObservation: 'inventory-file' | 'init-event' | 'none'
  /**
   * 设计门 P1-7 — whether the observation exists only when THIS run produced
   * a fresh inventory. opencode's dump plugin writes the file per fresh run;
   * a followup (reused session, plugin not re-run) has nothing to read, and
   * verifying anyway would hang an "unverifiable" banner on every followup
   * (RFC-280 实现门 P2-E). claude's init event fires every run.
   */
  readonly observationRequiresFreshRun: boolean
  /** Per-face stance; the boot self-check refuses to start on a missing face. */
  readonly declarationFaces: Readonly<Record<DeclarationFace, FaceSupport>>
  /**
   * RFC-297 T5 — what this runtime can report on each inventory face, and on
   * each rich field within a face. Drives the unified inventory read end and
   * the frontend's column selection, so "this runtime has no such concept"
   * (`unsupported`, e.g. claude × plugin) stays distinguishable from "it has
   * the concept and loaded zero of them".
   *
   * Same ratchet as `declarationFaces` above: the type is derived with mapped
   * types over the closed face/field unions, so adding a face — or adding a
   * rich field to an existing face — is a compile error in every driver until
   * it states a stance.
   */
  readonly inventory: InventoryDeclaration
}

export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /** RFC-282 A3 — static self-declaration (see RuntimeDriverCapabilities). */
  readonly capabilities: RuntimeDriverCapabilities
  /**
   * 2026-08-04 — whether this driver's spawn consumes per-runtime `extraArgs`
   * (fork-private CLI tokens appended to the argv). The registry's
   * validateExtraArgs consults THIS declaration instead of discriminating on
   * protocol literals (RFC-143 bypass-zero); an undeclared driver rejects them.
   */
  readonly acceptsExtraArgs?: true
  /**
   * Whether this driver's CLI understands the optional `IS_SANDBOX=1`
   * compatibility marker. This is a runtime capability only: enabling it does
   * not claim that the platform has created an operating-system sandbox.
   */
  readonly acceptsSandboxCompatibilityMarker?: true
  /**
   * Optional protocol-specific advisory version for documentation/diagnostics.
   * It is not an admission gate: compatible forks may use opaque version
   * schemes, while the deep smoke test establishes protocol conformance.
   */
  readonly minVersion: string | null
  /**
   * Parse one stdout line into a normalized event, or `null` when the line is
   * not a structured event (unparseable / falsy JSON) and should fall through
   * to the pump's raw-text path.
   */
  parseEvent(line: string): NormalizedEvent | null
  /**
   * RFC-297 T5 — synthetic events to append to the stream once the child has
   * exited. This is how an observation that does NOT arrive on stdout still
   * reaches the same pipeline: opencode reads the dump plugin's inventory file
   * here and emits it as an ordinary event, so no downstream stage can tell
   * whether an observation came from a stream line or from a file.
   *
   * Drivers with nothing to append omit the method (claude: its inventory
   * rides the `system/init` line it already emits).
   */
  drainFinalEvents?(ctx: FinalEventContext): Promise<readonly NormalizedEvent[]>
  /** Safe metadata-only observation for system-agent failure forensics. */
  observeSystemEvent?(line: string): SystemEventObservation
  /**
   * RFC-282 (§2.1, 决策 9) — THE single assembly method: argv/env/stdin AND
   * the declared manifest from ONE call, so declaration and injection are the
   * same computation. The legacy trio (system buildSpawn / buildBusinessSpawn
   * / renderInjection) is gone from the contract; their bodies live on as
   * driver-internal assembly functions until B4-style unification.
   */
  buildSpawn(ctx: AgentSpawnContext): Promise<AgentSpawnPlan>
  /**
   * RFC-280 T6（落差⑥）— MCP playground 的 native-session 策略，原
   * `RuntimeMcpTestCapabilityV1` 平行 spawn 契约的仅存 runtime 特有面。
   * 方法存在 = 该 runtime 支持测试台。spawn 本身走 `buildSpawn` 的
   * `mcpInjection`/`freshAgentRun`/`nativeSessionId` 面。
   */
  createMcpTestNativeSessionId?(): string | null
  mcpTestSessionReference?(input: { turnSeq: number; nativeSessionId: string | null }): {
    nativeSessionId?: string
    resumeSessionId?: string
  }
  /**
   * RFC-143 — the argv head this runtime spawns by default: its per-runtime
   * config path (config.opencodePath / claudeCodePath) else the built-in name.
   * Custom-fork override (RFC-112 binaryPath) is applied by the caller, not here.
   */
  defaultBinary(config: RuntimeBinaryConfig): string[]
  /** RFC-143 — version probe (was probeOpencode / probeClaudeCode free fns). */
  /** RFC-282 C1（Windows P2）— a readonly[] head lets tests probe a
   *  `[bun, run, mock]` command on hosts where a single-file wrapper cannot
   *  stream the protocol (same seam smoke already has). */
  probe(binary: string | readonly string[], opts?: ProbeOpts): Promise<RuntimeProbe>
  /** RFC-143 — model list (was listOpencodeModels / listClaudeModels free fns). */
  listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList>
  /**
   * RFC-284 T19 — drop any process-local caches keyed by this binary path
   * (called on runtime delete / binary change). Registry 对全部 driver 盲调，
   * 保持 kind-blind；没有缓存的 driver 缺省即可。
   */
  evictBinaryCaches?(binaryPath: string): void
  /**
   * RFC-284 T15（D10）—— 本 runtime 的「resume 目标会话不存在」stderr 判据。
   * 措辞属各 CLI 私有且随版本漂移，判据随 driver 走；缺省 = 无法判定（调用方
   * 按 false 处理——告警可能缺失但绝不误报，安全方向）。
   */
  detectSessionNotFound?(stderrTail: string): boolean
  /** RFC-143 — run-after subagent session capture (was captureChildSessions /
   *  captureClaudeSessions free fns). */
  captureSessions(ctx: SessionCaptureContext): Promise<void>

  // —— optional capabilities (null-object: a runtime that lacks the capability
  //    omits the method, and runner skips the whole step — RFC-143 PR-3) ——

  /** opencode only — read the inventory snapshot the dump plugin wrote into
   *  `runRoot` (was `runtime === 'opencode'` gate on readSnapshotFromRunDir).
   *  claude omits this → runner leaves the inventory column null. */
  readInventory?(ctx: InventoryReadContext): Promise<InventorySnapshot | null>

  /** opencode only — spin up the live subagent SQLite poller alongside the run
   *  (was an UNCONDITIONAL start, spinning uselessly on claude runs — the
   *  RFC-143 空转 bug). claude omits this → runner uses NOOP_HANDLE. */
  startLiveCapture?(ctx: LivePollOptions): LivePollerHandle

  /** Runtime-specific post-run capture for a memory-distiller conversation. */
  captureDistillSession?(ctx: DistillSessionCaptureContext): Promise<void>

  /**
   * RFC-238 — explicit MCP playground support. Registry rows whose protocol
   * driver omits this capability do not appear in the playground picker.
   */

  /** RFC-237 — post-exit child-session sweep into a SYSTEM-AGENT event sink
   *  (was the `driver.kind === 'opencode'` branch in systemAgentRun.ts).
   *  opencode: native SQLite transcript sweep. claude omits this — a system-agent
   *  spawn has no subagents (`--agents` never passed) and the full main
   *  session already streams through `parseEvent` into the sink. */
  captureSessionsToSink?(
    ctx: SystemAgentSessionSweepContext,
  ): Promise<SystemAgentSessionSweepOutcome>

  /** RFC-237 (design-gate P2-4) — detect a TERMINAL application error carried
   *  by a clean-exit stdout line (claude: `result` event with
   *  `is_error:true`). Returns the raw error text (caller masks) or null.
   *  Runtimes without such a dialect omit the method. */
  parseTerminalResultError?(line: string): string | null
  /**
   * RFC-297 T15 —— 一条本运行时真实的启动事件样本，供**启动自检**核对
   * `startupObservation: 'init-event'` 这个声明不是空头支票：自检把它喂给
   * `parseEvent`，产不出清单载荷就拒绝启动。
   *
   * 只有声明 'init-event' 的 driver 需要提供。样本必须来自实测（claude 的取自
   * 2.1.226 实跑），别手搓一个「刚好能过」的假对象——那样自检就退化成同义反复。
   */
  initEventSample?(): string

  /**
   * RFC-297 T11 —— `parseUnusableMcpServers?` 与 `parseStartupInventory?` 已删除。
   * 二者与 `parseEvent` 对同一行各解析一遍同一个 `system/init`；现在 driver 在
   * 那一次解析里就把清单挂进 `NormalizedEvent.data.inventory`，消费方（runner /
   * systemAgentRun / MCP 测试台）统一读载荷。「哪些 MCP 本轮不可用」由消费方从
   * 同一份观测里算，不再需要一个只为它存在的驱动方法。
   */
}

/** What the platform injected into one spawn and expects to see loaded. */
export interface DeclaredRuntimeCapabilities {
  /** Built-in tools the spawn requires (omitted when the spawn is unconstrained). */
  tools?: readonly string[]
  /** dependsOn closure members injected as subagents. */
  agents?: readonly string[]
  /** Managed skills staged into the current run config dir. */
  skills?: readonly string[]
}

/** The runtime's own answer to the same three questions, read off its startup line. */
export type StartupInventory = DeclaredRuntimeCapabilities & {
  /** RFC-280 T3 — claude init 的 `mcp_servers` 原样状态（P1-5：保留 status，
   *  不压 boolean）；不枚举该面的 runtime 缺省。 */
  mcpServers?: readonly { name: string; status: string }[]
}

/** RFC-237 — inputs for `captureSessionsToSink?`. The sink slice is structural
 *  (sessionEventSink.ts imports from this module, so the nominal
 *  `SystemAgentEventSinkV1` cannot be named here without an import cycle);
 *  its `append` parameter shape is copied verbatim and checked structurally. */
export interface SystemAgentSessionSweepContext {
  rootSessionId: string
  sink: {
    append(event: {
      ts: number
      kind: NormalizedEventKind | 'text' | 'stderr' | 'subagent_capture_failed'
      payload: string
      sessionId: string | null
      parentSessionId: string | null
      source: 'stream' | 'live-child' | 'post-run-child'
      externalEventId?: string
    }): Promise<void>
    markRootSessionResetPending?(sessionId: string): Promise<void>
    setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void>
    markTerminal(
      state: 'complete' | 'truncated' | 'incomplete',
      reason?: 'stream-persist-failed' | 'child-capture-failed' | 'post-exit-flush-timeout',
    ): Promise<void>
  }
  log: Logger
}

export interface SystemAgentSessionSweepOutcome {
  failed: boolean
  failureReason?: unknown
}

/** Inputs for `readInventory` — the per-run config dir + the node kind (the
 *  snapshot reader gates its shape on agent-vs-non-agent). pureMode is read from
 *  env inside the opencode driver. */
export interface InventoryReadContext {
  runRoot: string
  nodeKind: string
}

/**
 * RFC-297 T5 — inputs for `drainFinalEvents`. Carries what a driver needs to
 * materialize a post-exit observation, plus the two business gates that used to
 * live at the CALL site as a `wantsInventory` boolean threaded through the whole
 * spawn context (RFC-297 T13 起该字段改名 `freshAgentRun`，只陈述业务事实).
 * spawn context. Moving them here is the point: whether a fresh observation is
 * even possible is the driver's own business (opencode's dump plugin only ran
 * on a fresh, agent-kind run; claude's init fires every time).
 */
export interface FinalEventContext {
  runRoot: string
  nodeKind: string
  /**
   * False when this run reused an existing native session (RFC-042 same-session
   * envelope followup), i.e. the runtime never re-ran whatever produces its
   * observation. Drivers whose observation requires a fresh run return [].
   */
  freshRun: boolean
}
