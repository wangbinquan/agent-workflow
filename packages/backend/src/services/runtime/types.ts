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

export type RuntimeKind = 'opencode' | 'claude-code'

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
  /** Frozen managed identity used by RFC-224's whole-tree seal. */
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
  cleanup?: () => void | Promise<void>
  /** RFC-224 immutable runtime artifacts overlaid read-only by RFC-205. */
  readOnlySubtrees?: readonly string[]
  /** Explicit capture locator; consumers must not reopen the user's global DB. */
  sessionStore?: {
    root: string
    dbPath: string
    persistent: boolean
  }
  /** Strict launcher↔runner ownership barrier. */
  control?:
    | { kind: 'none' }
    | {
        kind: 'opencode-session'
        mode: 'new' | 'resume'
        nonce: string
        leaseNonceDigest: string
        ackPath: string
        expectedSessionId?: string
        identityDigest: string
        officialBuildDigest: string
        sessionContractDigest: string
        sessionStoreKey: string
        createdNodeRunId: string
      }
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
   * Stable identity used for cache lookup when `binary` is an ephemeral
   * verified snapshot. Execution still always uses `binary`.
   */
  cacheKey?: string
  /** RFC-224 diagnostic subprocess environment (OpenCode only). */
  env?: Record<string, string>
  /** RFC-224 private, source-guarded diagnostic working directory. */
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
  /** RFC-154: frozen config-dir LEAF name (claude transcript lives under it).
   *  Omitted → the protocol default leaf. opencode ignores (SQLite capture). */
  configDirName?: string
  /** opencode: partId-level dedupe from the live poller (skip already-written rows). */
  alreadyInsertedPartIds?: Map<string, Set<string>>
  /** opencode: override SQLite path (tests). */
  opencodeDbPath?: string
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
  /** Subprocess cwd (distiller: a throwaway temp dir). */
  worktreePath: string
  /** Config dir (opencode: OPENCODE_CONFIG_DIR; claude: attempt dir holding .claude/). */
  runDir: string
  /**
   * RFC-224 instance-owned root. Verified OpenCode system stores live under
   * this root so daemon boot can recover crash remnants without scanning
   * shared /tmp; other runtime drivers ignore it.
   */
  appHome?: string
  /** Override the default binary head (`[runtimeBinary]` vs `['opencode']`/`['claude']`) — RFC-112 custom fork. */
  runtimeBinary?: string
  /** RFC-026 clarify-rerun: resume a prior session. */
  resumeSessionId?: string
  /** RFC-111 D16: bridge subscription credential into the relocated claude config dir (real claude runs only; opencode ignores). */
  bridgeCredentials?: boolean
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** Caller's logger for driver-internal warnings (claude config-dir prep);
   *  omitted → the driver's own default logger. RFC-143 PR-4 (smoke parity). */
  log?: Logger
  /** Explicit dependency-injection seam; production callers never set it. */
  testOnlyUnverifiedRuntime?: boolean
}

/**
 * RFC-143 PR-4 — spawn inputs for a BUSINESS node run (the runner.ts path with
 * skills / mcp / plugins / inventory / memory weave — everything
 * `SystemAgentSpawnContext` deliberately excludes). A union ctx: each driver
 * takes what it needs and ignores the rest. The runner renders the prompt,
 * resolves the per-agent runtime profiles (async DB) and the memory block, then
 * hands these raw materials over; the driver owns its runtime's ENTIRE assembly
 * (opencode: inline-config build + inventory plugin + memory append + serialize;
 * claude: system-prompt-file + mcp/agents flags + credential-bridge decision).
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
   * RFC-113: resolved runtime profile per agent name (root INCLUDED — frozen
   * params for the root, live-resolved for each dependent). Resolved in the
   * runner (async DB reads stay out of drivers — RFC-143 §4.6C).
   */
  resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>
  /** Skills for this agent — each driver stages them into ITS config dir
   *  (`<runRoot>/<configDir.name>/skills/`) inside buildBusinessSpawn (RFC-154;
   *  was a runtime-blind runner preamble that staged `.opencode` even for claude). */
  skills: readonly ResolvedSkill[]
  /** RFC-026 clarify-inline rerun: resume the prior session. */
  resumeSessionId?: string
  /** Subprocess cwd = task worktree. */
  worktreePath: string
  /**
   * Per-run root (`<appHome>/runs/<taskId>/<nodeRunId>`). The config dir is
   * `<runRoot>/<configDir.name>`; inventory out + claude's `system.md` stay
   * directly under runRoot (NOT inside the config dir — leaf renames must not
   * move them, RFC-154 §8).
   */
  runRoot: string
  /**
   * RFC-154: the frozen config-dir injection profile — the env var NAME the
   * binary reads its config dir from + the leaf dir name under runRoot. The
   * runner always supplies it (frozen value or protocol default).
   */
  configDir: RuntimeConfigDirProfile
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** RFC-112: frozen custom-fork binary — overrides every default head. */
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
  /** Runner-owned fields required by the verified OpenCode path. */
  appHome?: string
  taskId?: string
  nodeId?: string
  opencodeControlNonce?: string
  opencodeLeaseNonceDigest?: string
  opencodeResumeOwner?: {
    sessionId: string
    taskId: string
    nodeId: string
    createdNodeRunId: string
    identityDigest: string
    officialBuildDigest: string
    sessionContractDigest: string
    sessionStoreKey: string
    projectId: string
    opencodeVersion: string
  }
  /** Explicit dependency-injection seam; production callers never set it. */
  testOnlyUnverifiedRuntime?: boolean
}

/**
 * A pluggable agent runtime. RFC-143: a complete capability object — new runtime
 * = register a driver in DRIVERS + implement this interface, zero call-site edits.
 * `buildBusinessSpawn` + optional `readInventory?`/`startLiveCapture?` land in
 * later RFC-143 PRs; this interface reflects PR-1's surface.
 */
export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /** Minimum compatible binary version (probe gate). */
  readonly minVersion: string
  /**
   * Parse one stdout line into a normalized event, or `null` when the line is
   * not a structured event (unparseable / falsy JSON) and should fall through
   * to the pump's raw-text path.
   */
  parseEvent(line: string): NormalizedEvent | null
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
}

/** Inputs for `readInventory` — the per-run config dir + the node kind (the
 *  snapshot reader gates its shape on agent-vs-non-agent). pureMode is read from
 *  env inside the opencode driver. */
export interface InventoryReadContext {
  runRoot: string
  nodeKind: string
  /** RFC-224: the verified launcher writes inventory without a plugin even
   * though its child intentionally runs with OPENCODE_PURE=1. */
  verifiedIdentity?: boolean
}
