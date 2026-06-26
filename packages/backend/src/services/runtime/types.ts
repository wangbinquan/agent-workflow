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
 * A pluggable agent runtime. PR-A populates only `kind` + `parseEvent`;
 * `buildSpawn` (later PR-A slice) and `probe`/`listModels`/`captureSession`
 * (PR-B) are added as they are implemented so each commit stays green.
 */
export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /**
   * Parse one stdout line into a normalized event, or `null` when the line is
   * not a structured event (unparseable / falsy JSON) and should fall through
   * to the pump's raw-text path.
   */
  parseEvent(line: string): NormalizedEvent | null
}
