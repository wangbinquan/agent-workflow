import type { McpRuntimeTestCaptureIncompleteReason } from './runtimeTestPersistence'
import type { Mcp, StartupVerificationResult } from '@agent-workflow/shared'
import type {
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
  McpRuntimeTestCleanupCandidate,
  McpRuntimeTestBroadcastSnapshot,
} from './runtimeTestPersistence'
/** Execution identity supplied by the selected complete diagnostic family. */
export interface McpDiagnosticRuntimeTarget {
  readonly kind: 'mcp-diagnostic-runtime-target'
  readonly reference: object
}
export interface McpDiagnosticTurnStart {
  readonly kind: 'mcp-diagnostic-turn-start'
  readonly reference: object
}
export type McpDiagnosticReapOutcome =
  | 'no-pid'
  | 'not-alive'
  | 'window-expired'
  | 'command-mismatch'
  | 'killed'
  | 'kill-failed'
export interface ResolvedTestRuntime {
  readonly row: McpDiagnosticRuntime
  readonly target: McpDiagnosticRuntimeTarget
  readonly label: string
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
  hasExecution(turn: McpRuntimeTestTurnRecord): boolean
  /** Read the clock only after the selected execution's original receipt fields. */
  reapTurn(turn: McpRuntimeTestTurnRecord, readNow: () => number): Promise<McpDiagnosticReapOutcome>
  recoverReapedTurn(input: {
    readonly session: McpRuntimeTestSessionRecord
    readonly turn: McpRuntimeTestTurnRecord
    readonly readNow: () => number
  }): Promise<boolean>
  /** Pure capture; admission occurs at the original execution-start callback. */
  captureTurnStart(input: {
    readonly session: McpRuntimeTestSessionRecord
    readonly turn: McpRuntimeTestTurnRecord
    readonly readNow: () => number
  }): McpDiagnosticTurnStart
  runTurn(input: {
    readonly session: McpRuntimeTestSessionRecord
    readonly turn: McpRuntimeTestTurnRecord
    readonly mcp: Mcp
    readonly runtime: ResolvedTestRuntime
    readonly signal: AbortSignal
    readonly sink: McpDiagnosticEventSink
    readonly timeoutMs: number
    readonly assertSpawnAllowed: () => Promise<void>
    readonly turnStart: McpDiagnosticTurnStart
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
