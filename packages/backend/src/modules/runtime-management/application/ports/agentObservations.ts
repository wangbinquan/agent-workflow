import type { RuntimeInventoryPayload, StartupObservation } from '@agent-workflow/shared'

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

// RFC-462 (RFC-294 W9-D): the normalized event the drivers emit and its parts, moved verbatim from
// `services/runtime/types.ts` to sit with the event kinds they build on.

/** Per-event token contribution a driver extracts from one stdout event. */
export interface NormalizedTokenDelta {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

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
  /** A selected execution adapter may transport the runtime's own typed
   * observation, including absence or corruption, in the event stream. */
  startupObservation?: StartupObservation
}

export interface SystemEventObservation {
  runtimeEventType: string | null
  terminalResult: Exclude<TerminalResultObservation, 'not-observed'> | null
}
