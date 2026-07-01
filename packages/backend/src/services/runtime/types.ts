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

export type RuntimeKind = 'opencode' | 'claude-code'

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
  cleanup?: () => void
}

/** Version probe result for a runtime binary (PR-B fills this in per runtime). */
export interface RuntimeProbe {
  binary: string
  version: string | null
  compatible: boolean
  incompatibleReason?: string
}

/** One selectable model surfaced to the agent/settings model pickers. */
export interface RuntimeModel {
  id: string
  provider?: string
  modelID?: string
  name?: string
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
  /** Override the default binary head (`[runtimeBinary]` vs `['opencode']`/`['claude']`) — RFC-112 custom fork. */
  runtimeBinary?: string
  /** RFC-026 clarify-rerun: resume a prior session. */
  resumeSessionId?: string
  /** RFC-111 D16: bridge subscription credential into the relocated claude config dir (real claude runs only; opencode ignores). */
  bridgeCredentials?: boolean
  /** RFC-067 per-task git identity (both non-empty to inject). */
  gitUserName?: string | null
  gitUserEmail?: string | null
}

/**
 * A pluggable agent runtime. `kind` + `parseEvent` + `buildSpawn` are populated;
 * `probe`/`listModels`/`captureSession` may be added later.
 */
export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /**
   * Parse one stdout line into a normalized event, or `null` when the line is
   * not a structured event (unparseable / falsy JSON) and should fall through
   * to the pump's raw-text path.
   */
  parseEvent(line: string): NormalizedEvent | null
  /**
   * RFC-117 — assemble the spawn plan for a framework system agent (distiller /
   * commit / fusion). The business-node spawn path (runner.ts) does NOT route
   * through this — it keeps its own skills/mcp/inventory assembly + golden lock.
   */
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan
}
