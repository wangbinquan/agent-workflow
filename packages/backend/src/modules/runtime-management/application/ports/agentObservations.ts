// RFC-370: the complete original protocol observation declarations belong
// to Runtime Management; native compatibility keeps their original names.

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
