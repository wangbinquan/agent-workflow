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
  InventorySnapshot,
  Mcp,
  Plugin,
  RuntimeConfigDirProfile,
} from '@agent-workflow/shared'
import type { LivePollOptions, LivePollerHandle } from '@/services/subagentLiveCapture'
// Type-only (erased at runtime): runtimeRegistry value-imports runtime/index,
// so a VALUE import here would close a module-init cycle. RuntimeProfile is the
// RFC-113 resolved param set threaded through BusinessNodeSpawnContext.
import type { RuntimeProfile } from '@/services/runtimeRegistry'
// RFC-280 T1 — unified injection layer shapes (type-only; agentInjection is a
// leaf module, see its header).
import type { DeclaredManifestV1 } from '@/services/execution/agentInjection'

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
  /** Framework skills selected for this run (managed ones are the declaration). */
  skills?: readonly { name: string; sourceKind: string }[]
  /** Selected plugins (opencode face; claude declares them unsupported). */
  plugins?: readonly Plugin[]
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
   * Per-event session id. The pump captures the first non-empty one as the
   * run's session id (later threaded into `--session`/`--resume`).
   */
  sessionId?: string
  /** Event timestamp (ms epoch) if the runtime provided one. */
  timestamp?: number
  /** Token usage this event contributes, if any. */
  tokens?: NormalizedTokenDelta
  /** The original stdout line, persisted verbatim into node_run_events.payload. */
  rawLine: string
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
 *  needs — opencode: SQLite BFS + partId dedupe; claude: JSONL under runRoot). */
export interface SessionCaptureContext {
  rootSessionId: string
  nodeRunId: string
  taskId: string
  db: DbClient
  log: Logger
  /** Subprocess cwd (worktree) — claude's `/`→`-` slug is the projects subdir. */
  worktreePath: string
  /** Per-run config dir root (claude's CLAUDE_CONFIG_DIR = `<runRoot>/<configDirName>`). */
  runRoot: string
  /** RFC-154: selected config-dir LEAF name (claude transcript lives under it).
   *  Omitted → the protocol default leaf. opencode ignores (SQLite capture). */
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
  /** Config dir (opencode: OPENCODE_CONFIG_DIR; claude: attempt dir holding .claude/). */
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
   * RFC-280 T6 (design-gate P1-4) — opencode: materialize the RFC-029
   * inventory dump plugin so the startup-verification layer has an observation
   * source; the playground REQUIRES it (a strict consumer must fail closed on
   * "cannot observe", never silently pass). claude ignores it (observation
   * rides the init event).
   */
  wantsInventory?: boolean
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

/**
 * RFC-143 PR-4 — spawn inputs for a BUSINESS node run (the runner.ts path with
 * skills / mcp / plugins / inventory / memory weave — everything
 * `SystemAgentSpawnContext` deliberately excludes). A union ctx: each driver
 * takes what it needs and ignores the rest. The runner renders the prompt,
 * resolves the per-agent runtime profiles (async DB) and the memory block, then
 * hands these raw materials over; the driver owns its runtime's ENTIRE assembly
 * (opencode: inline-config build + inventory plugin + memory append + serialize;
 * claude: system-prompt-file + mcp/agents flags + worktree resource projection).
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
  plugins: readonly Plugin[]
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
   * opencode-ONLY head fallback: production `config.opencodePath`
   * (resolveOpencodeCmd) or a test mock. Other drivers MUST ignore it (Codex
   * P1-1: a custom opencodePath must never become another runtime's argv head).
   */
  opencodeCmd?: string[]
  /**
   * Generic TEST-ONLY head override (mock-claude / future mocks). Production
   * never sets it; its PRESENCE is the signal that gates claude's subscription
   * credential bridge OFF so CI never touches the keychain.
   */
  runtimeCmd?: string[]
  /**
   * RFC-029/042 business gate the runner already computed:
   * `isAgentRunKind(nodeKind) && !envelopeFollowup`. Whether the runtime CAN
   * produce an inventory is the driver's own capability (claude ignores).
   */
  wantsInventory: boolean
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
export interface RuntimeDriver {
  readonly kind: RuntimeKind
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
   * Optional protocol-specific minimum used only by runtimes that define a
   * semver gate. RFC-227 makes OpenCode behavior-qualified, so its value is
   * null; Claude Code retains its existing minimum.
   */
  readonly minVersion: string | null
  /**
   * Parse one stdout line into a normalized event, or `null` when the line is
   * not a structured event (unparseable / falsy JSON) and should fall through
   * to the pump's raw-text path.
   */
  parseEvent(line: string): NormalizedEvent | null
  /** Safe metadata-only observation for system-agent failure forensics. */
  observeSystemEvent?(line: string): SystemEventObservation
  /**
   * RFC-117 — assemble the spawn plan for a framework system agent (distiller /
   * commit / fusion / the runtimeSmoke conformance probe). Minimal surface: one
   * persona + model, no skills/mcp/plugins/inventory.
   */
  buildSpawn(ctx: SystemAgentSpawnContext): Promise<SpawnPlan>
  /**
   * RFC-143 PR-4 — assemble the spawn plan for a BUSINESS node run (was the
   * `runtime === 'claude-code'` if/else in runner.ts). async because opencode's
   * inventory-plugin materialization reads embedded bytes (§4.6B). The driver
   * owns the entire runtime-specific assembly; the runner stays kind-blind.
   */
  buildBusinessSpawn(ctx: BusinessNodeSpawnContext): Promise<SpawnPlan>
  /**
   * RFC-280 T1 — the unified injection-layer render hook. T1 covers the MCP
   * face (partition + per-runtime wire entries + declared manifest); later
   * RFC-280 tasks extend the spec to skills/plugins/subagents and route every
   * spawn path through it. `buildBusinessSpawn` already consumes the same
   * underlying functions — this hook exposes them per-driver so the unified
   * executor (T4/T7) can render without knowing the runtime kind.
   */
  renderInjection(spec: AgentInjectionSpecV1): RenderedInjectionV1
  /**
   * RFC-280 T6（落差⑥）— MCP playground 的 native-session 策略，原
   * `RuntimeMcpTestCapabilityV1` 平行 spawn 契约的仅存 runtime 特有面。
   * 方法存在 = 该 runtime 支持测试台。spawn 本身走 `buildSpawn` 的
   * `mcpInjection`/`wantsInventory`/`nativeSessionId` 面。
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
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe>
  /** RFC-143 — model list (was listOpencodeModels / listClaudeModels free fns). */
  listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList>
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
   * RFC-242 T5 — names of MCP servers this startup line reports as UNUSABLE for
   * the turn (anything but a live connection). Returns null for lines that
   * carry no MCP inventory. The runner intersects the result with
   * `SpawnPlan.declaredMcpServers`, so unrelated inherited MCPs remain telemetry.
   */
  parseUnusableMcpServers?(line: string): readonly string[] | null
  /**
   * 2026-08-09 — skill names this startup line reports as LOADED for the turn
   * (the runtime's own bundled skills included). Returns null for lines that
   * carry no such inventory. Consumers compare only capabilities explicitly
   * added for the current run.
   */
  /**
   * 2026-08-09 — the capabilities this startup line reports as LOADED for the
   * turn (the runtime's own built-ins included). Returns null for lines that
   * carry no such inventory, and a field is undefined when this runtime does
   * not enumerate that kind. Consumers compare only what the platform added
   * for the current run.
   *
   * A runtime that never reports an inventory simply never triggers the check:
   * being unable to prove a capability arrived is not proof that it did not.
   */
  parseStartupInventory?(line: string): StartupInventory | null
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
    setRootSessionId(sessionId: string): Promise<void>
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
