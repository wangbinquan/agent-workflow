import type { Config, Mcp } from '@agent-workflow/shared'
import type {
  McpDiagnosticEventSink,
  McpDiagnosticRunResult,
  McpDiagnosticRuntime,
} from '../mcps/runtimeDiagnosticsEffects'
import type { McpRuntimeTestSessionRecord } from '../mcps/runtimeTestPersistence'
import type { McpDiagnosticObservation } from './mcpDiagnosticExecution'

/**
 * RFC-488: the runtime-specific work of a local MCP diagnostic — whether a protocol's driver carries a diagnostic session
 * into the next turn, the native session id a protocol mints itself, the executable a runtime runs, and one turn's run
 * with its startup verification. Resource Catalog keeps its own work (leases, pid receipts and reaping, the workspace
 * layout and cleanup, UI events); Task Execution implements this port next to its hosted twin (`McpDiagnosticExecution`)
 * and bootstrap binds it (RFC-294 design §3.1: TE implements LocalMcpDiagnosticExecution).
 */
export interface LocalMcpDiagnosticExecution {
  /** Whether the protocol's driver can carry one diagnostic session across turns. */
  supportsSession(protocol: LocalMcpDiagnosticProtocol): boolean
  /** A fresh native session id for a protocol that mints its own, otherwise null. */
  createNativeSessionId(protocol: LocalMcpDiagnosticProtocol): string | null
  /** The registered executable, else the protocol's configured default; undefined when neither exists. */
  executable(
    protocol: LocalMcpDiagnosticProtocol,
    registered: string | null,
    configuration: LocalMcpDiagnosticBinaryConfiguration,
  ): string | undefined
  /** Run one diagnostic turn; the result carries its own startup verification. */
  run(request: LocalMcpDiagnosticTurnRequest): Promise<McpDiagnosticRunResult>
}

export type LocalMcpDiagnosticProtocol = McpRuntimeTestSessionRecord['runtimeProtocol']

export type LocalMcpDiagnosticBinaryConfiguration = Pick<Config, 'opencodePath' | 'claudeCodePath'>

/** The receipt a local turn reports once its process exists (before any prompt bytes are delivered). */
export interface LocalMcpDiagnosticSpawnReceipt {
  readonly pid: number | null
  readonly spawnedAt: number
  readonly spawnBinaryPath: string
}

export interface LocalMcpDiagnosticTurnRequest {
  readonly feature: string
  readonly protocol: LocalMcpDiagnosticProtocol
  /** The diagnostic agent's persona (Resource Catalog's domain constants). */
  readonly agentName: string
  readonly systemPrompt: string
  readonly prompt: string
  /**
   * The session's scratch: the run is placed at `<parent>/<name>`; the startup inventory is read back from the
   * session's persisted `root` (`<root>/run/turns/<turn id>`).
   */
  readonly scratch: { readonly parent: string; readonly name: string; readonly root: string }
  readonly turn: { readonly id: string; readonly seq: number }
  readonly mcp: Mcp
  readonly binary: string
  /** The resolved runtime; its `protocol` selects the driver for the spawn context. */
  readonly runtime: Pick<
    McpDiagnosticRuntime,
    | 'protocol'
    | 'model'
    | 'variant'
    | 'temperature'
    | 'steps'
    | 'maxSteps'
    | 'isSandbox'
    | 'configDirEnv'
    | 'configDirName'
  >
  /** The session's native id so far (null before the first capture). */
  readonly nativeSessionId: string | null
  readonly observe?: McpDiagnosticObservation
  readonly resumeSessionId?: string
  readonly timeoutMs: number
  readonly maxEventTextBytes: number
  readonly maxRawFrameBytes: number
  readonly signal: AbortSignal
  readonly sink: McpDiagnosticEventSink
  /** Admission gate checked right before the process starts. */
  readonly beforeSpawn: () => Promise<void>
  /** Durable spawn receipt; a rejection stops the turn before the prompt is delivered. */
  readonly onSpawned: (receipt: LocalMcpDiagnosticSpawnReceipt) => Promise<void>
}
