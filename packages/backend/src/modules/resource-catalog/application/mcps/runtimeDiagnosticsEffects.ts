import type { McpRuntimeTestCaptureIncompleteReason } from './runtimeTestPersistence'
import type { Mcp, StartupVerificationResult } from '@agent-workflow/shared'
import type { StaleRunKillOutcome } from '@/util/process'
import type {
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
  McpRuntimeTestCleanupCandidate,
  McpRuntimeTestBroadcastSnapshot,
} from './runtimeTestPersistence'
export interface ResolvedTestRuntime {
  readonly row: McpDiagnosticRuntime
  readonly binary: string
  readonly snapshotJson: string
}
export interface DiagnosticTimer {
  cancel(): void
  unref(): void
}
export interface McpDiagnosticsEffects {
  readonly now: () => number
  setTimeout(callback: () => void, delay: number): DiagnosticTimer
  setInterval(callback: () => void, delay: number): DiagnosticTimer
  resolveRuntime(name: string | null): Promise<ResolvedTestRuntime>
  supportsSession(protocol: McpRuntimeTestSessionRecord['runtimeProtocol']): boolean
  createNativeSessionId(runtime: ResolvedTestRuntime): string | null
  workspaceReference(sessionId: string): string
  workspaceExists(reference: string): boolean
  cleanupWorkspace(
    candidate: McpRuntimeTestCleanupCandidate,
  ): Pick<McpRuntimeTestCleanupCandidate, 'cleanupState' | 'cleanupErrorCode'>
  currentMcpHash(mcp: Mcp): Promise<string>
  broadcast(sessionId: string, snapshot: McpRuntimeTestBroadcastSnapshot): void
  reap(
    run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
    opts?: { now?: number; termWaitMs?: number },
  ): Promise<StaleRunKillOutcome>
  runTurn(input: {
    readonly session: McpRuntimeTestSessionRecord
    readonly turn: McpRuntimeTestTurnRecord
    readonly mcp: Mcp
    readonly runtime: ResolvedTestRuntime
    readonly signal: AbortSignal
    readonly sink: McpDiagnosticEventSink
    readonly timeoutMs: number
    readonly assertSpawnAllowed: () => Promise<void>
    readonly onSpawned: (receipt: {
      pid: number | null
      spawnedAt: number
      spawnBinaryPath: string
    }) => void | Promise<void>
  }): Promise<McpDiagnosticRunResult>
  failedResult(
    session: McpRuntimeTestSessionRecord,
    aborted: boolean,
    durationMs: number,
  ): McpDiagnosticRunResult
}

/** A turn-scoped effect receipt; verification runs only after the capture barrier. */
export interface McpDiagnosticRunResult {
  readonly status:
    | 'ok'
    | 'spawn-failed'
    | 'timeout'
    | 'aborted'
    | 'exit-nonzero'
    | 'result-error'
    | 'unreaped'
  readonly exitCode: number | null
  readonly stderrTail: string
  readonly durationMs: number
  readonly capturedSessionId?: string
  readonly nativeSessionIntegrityFailed?: boolean
  readonly verifyAfterCapture: () => Promise<StartupVerificationResult | undefined>
}
export type SessionCaptureTerminalState = 'complete' | 'truncated' | 'incomplete'
export type SessionCaptureIncompleteReason = McpRuntimeTestCaptureIncompleteReason
export interface McpDiagnosticEventSink {
  append(event: {
    ts: number
    kind: string
    payload: string
    sessionId: string | null
    parentSessionId: string | null
    source: 'stream' | 'live-child' | 'post-run-child'
    externalEventId?: string
  }): Promise<void>
  markRootSessionResetPending(sessionId: string): Promise<void>
  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void>
  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void>
}

/** Purpose-specific facts supplied by the root's Runtime Management inspection binding. */
export interface McpDiagnosticRuntime {
  readonly id: string
  readonly name: string
  readonly protocol: 'opencode' | 'claude-code'
  readonly binaryPath: string | null
  readonly enabled: boolean
  readonly configDirEnv: string | null
  readonly configDirName: string | null
  readonly probeFence: number
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
  readonly isSandbox: boolean
}
