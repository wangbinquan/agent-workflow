import type { Mcp, StartupVerificationResult } from '@agent-workflow/shared'
import type { RuntimeProfileInspection } from '@/modules/runtime-management/public/types'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import type { SystemAgentEventSinkV1 } from '@/services/sessionEventSink'
import type { StaleRunKillOutcome } from '@/util/process'
import type {
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
  McpRuntimeTestCleanupCandidate,
  McpRuntimeTestBroadcastSnapshot,
} from './runtimeTestPersistence'
export interface ResolvedTestRuntime {
  readonly row: RuntimeProfileInspection
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
    readonly sink: SystemAgentEventSinkV1
    readonly timeoutMs: number
    readonly assertSpawnAllowed: () => Promise<void>
    readonly onSpawned: NonNullable<SystemAgentRunOptions['onSpawned']>
  }): Promise<SystemAgentRunResult>
  verifyTurn(
    session: McpRuntimeTestSessionRecord,
    turn: McpRuntimeTestTurnRecord,
    result: SystemAgentRunResult,
  ): Promise<StartupVerificationResult | undefined>
  failedResult(
    session: McpRuntimeTestSessionRecord,
    aborted: boolean,
    durationMs: number,
  ): SystemAgentRunResult
}
