import type { McpRuntimeTestEndReason, ParseSessionInputEvent } from '@agent-workflow/shared'
export type McpRuntimeTestCaptureIncompleteReason =
  | 'stream-persist-failed'
  | 'stream-frame-limit-exceeded'
  | 'child-capture-failed'
  | 'post-exit-flush-timeout'

export type McpRuntimeTestReapOutcome =
  | 'no-pid'
  | 'not-alive'
  | 'window-expired'
  | 'command-mismatch'
  | 'killed'
  | 'kill-failed'

export type McpRuntimeTestSessionStatus = 'active' | 'ending' | 'ended'
export type McpRuntimeTestProtocol = 'opencode' | 'claude-code'
export type McpRuntimeTestNativeSessionState = 'pending' | 'ready' | 'unusable'
export type McpRuntimeTestContinuationBlock =
  | 'mcp-config-changed'
  | 'runtime-profile-changed'
  | 'capture-truncated'
  | 'capture-incomplete'
export type McpRuntimeTestCleanupState = 'not-started' | 'pending' | 'complete' | 'quarantined'
export type McpRuntimeTestTurnStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'interrupted'
export type McpRuntimeTestCaptureState = 'live' | 'complete' | 'truncated' | 'incomplete'

/** Closed application-owned projection of one durable playground session. */
export interface McpRuntimeTestSessionRecord {
  readonly id: string
  readonly mcpId: string
  readonly ownerUserId: string
  readonly clientCreateId: string
  readonly clientCreateDigest: string
  readonly status: McpRuntimeTestSessionStatus
  readonly endReason: McpRuntimeTestEndReason | null
  readonly mcpConfigHash: string
  readonly runtimeRowId: string
  readonly runtimeName: string
  readonly runtimeProtocol: McpRuntimeTestProtocol
  readonly runtimeSnapshotJson: string
  readonly runtimeBinaryPath: string
  readonly runtimeSessionId: string | null
  readonly nativeSessionState: McpRuntimeTestNativeSessionState
  readonly inFlightTurnId: string | null
  readonly turnSeq: number
  readonly sessionVersion: number
  readonly idleDeadlineAt: number | null
  readonly continuationBlockedReason: McpRuntimeTestContinuationBlock | null
  readonly scratchRoot: string
  readonly cleanupState: McpRuntimeTestCleanupState
  readonly cleanupErrorCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly endedAt: number | null
}

/** Closed application-owned projection of one durable playground turn. */
export interface McpRuntimeTestTurnRecord {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly clientMessageId: string
  readonly promptText: string
  readonly status: McpRuntimeTestTurnStatus
  readonly hardDeadlineAt: number
  readonly captureState: McpRuntimeTestCaptureState
  readonly captureIncompleteReason: string | null
  readonly captureFirstEventSeq: number | null
  readonly captureLastEventSeq: number
  readonly captureEventBytes: number
  readonly cancelRequestedAt: number | null
  readonly pid: number | null
  readonly spawnedAt: number | null
  readonly spawnBinaryPath: string | null
  readonly exitCode: number | null
  readonly failureCode: string | null
  readonly stderrTail: string | null
  readonly durationMs: number | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly createdAt: number
}

export interface McpRuntimeTestEventRecord extends ParseSessionInputEvent {
  readonly source: 'stream' | 'live-child' | 'post-run-child'
}

export interface McpRuntimeTestCreateReceiptRecord {
  readonly mcpId: string
  readonly ownerUserId: string
  readonly clientCreateId: string
  readonly requestDigest: string
  readonly sessionId: string
  readonly acceptedTurnId: string
  readonly createdAt: number
  readonly expiresAt: number
}

export interface McpRuntimeTestEventAppendInput {
  readonly sessionId: string
  readonly turnId: string
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly runtimeSessionId: string | null
  readonly parentSessionId: string | null
  readonly source: 'stream' | 'live-child' | 'post-run-child'
  readonly externalEventKey: string | null
  readonly payloadBytes: number
  readonly maxSingleEventBytes: number
  readonly maxSessionRows: number
  readonly maxSessionBytes: number
}

export type McpRuntimeTestEventAppendResult = 'appended' | 'duplicate' | 'stopped' | 'truncated'

export interface McpRuntimeTestCreatePersistenceInput {
  readonly mcpId: string
  readonly ownerUserId: string
  readonly clientCreateId: string
  readonly requestDigest: string
  readonly sessionId: string
  readonly turnId: string
  readonly mcpConfigHash: string
  readonly runtimeRowId: string
  readonly runtimeName: string
  readonly runtimeProtocol: McpRuntimeTestProtocol
  readonly runtimeSnapshotJson: string
  readonly runtimeBinaryPath: string
  readonly runtimeSessionId: string | null
  readonly scratchRoot: string
  readonly message: string
  readonly clientMessageId: string
  readonly now: number
  readonly hardDeadlineAt: number
  readonly receiptExpiresAt: number
}

export interface McpRuntimeTestCreatePersistenceResult {
  readonly sessionId: string
  readonly acceptedTurnId: string
  readonly shouldQueue: boolean
}

export interface McpRuntimeTestAcceptMessageInput {
  readonly mcpId: string
  readonly sessionId: string
  readonly turnId: string
  readonly clientMessageId: string
  readonly message: string
  readonly expectedSessionVersion: number
  readonly now: number
  readonly hardDeadlineAt: number
  readonly idleDeadlineAt: number
  readonly maxTurns: number
}

export interface McpRuntimeTestAcceptMessageResult {
  readonly turnId: string | null
  readonly version: number
  readonly shouldQueue: boolean
}

export interface McpRuntimeTestCancelPersistenceResult {
  readonly abort: boolean
  readonly cleanup: boolean
}

export interface McpRuntimeTestEndPersistenceResult {
  readonly turnId: string | null
  readonly cleanup: boolean
}

export interface McpRuntimeTestRunningRef {
  readonly sessionId: string
  readonly turnId: string | null
}

export interface McpRuntimeTestExpiredTurnResult {
  readonly settled: readonly {
    readonly sessionId: string
    readonly turnId: string
    readonly end: boolean
  }[]
  readonly abort: readonly { readonly sessionId: string; readonly turnId: string }[]
}

export interface McpRuntimeTestQuarantinedCandidate {
  readonly session: McpRuntimeTestSessionRecord
  readonly turn: McpRuntimeTestTurnRecord | null
}

export interface McpRuntimeTestBootRecoveryInput {
  readonly sessionId: string
  readonly expectedTurnId: string
  readonly resumable: boolean
  readonly quarantine: boolean
  readonly reapOutcome: McpRuntimeTestReapOutcome | 'missing-turn'
  readonly now: number
  readonly idleDeadlineAt: number
}

export interface McpRuntimeTestAdmittedTurn {
  readonly session: McpRuntimeTestSessionRecord
  readonly turn: McpRuntimeTestTurnRecord
}

export interface McpRuntimeTestSpawnReceiptInput {
  readonly sessionId: string
  readonly turnId: string
  readonly pid: number | null
  readonly spawnedAt: number
  readonly spawnBinaryPath: string | null
  readonly fenceAt: number
}

export interface McpRuntimeTestSettlementInput {
  readonly sessionId: string
  readonly turnId: string
  readonly originalTurnSeq: number
  readonly status: McpRuntimeTestTurnStatus
  readonly failureCode: string | null
  readonly exitCode: number | null
  readonly stderrTail: string | null
  readonly durationMs: number
  readonly capturedSessionId: string | null
  readonly nativeSessionIntegrityFailed: boolean
  readonly childUnreaped: boolean
  readonly now: number
  readonly idleDeadlineAt: number
}

export interface McpRuntimeTestCleanupCandidate {
  readonly scratchRoot: string
  readonly cleanupState: McpRuntimeTestCleanupState
  readonly cleanupErrorCode: string | null
}

export interface McpRuntimeTestBroadcastSnapshot {
  readonly ownerUserId: string
  readonly sessionVersion: number
  readonly inFlightTurnId: string | null
  readonly turnStatus: McpRuntimeTestTurnStatus | null
  readonly eventCursor: number
  readonly captureState: McpRuntimeTestCaptureState | null
}

/**
 * Aggregate-specific async persistence boundary. Every mutating method owns
 * its complete provider transaction; application code never receives a DB or
 * transaction handle and SQLite never has to await inside dbTxSync.
 */
export interface McpRuntimeTestPersistence {
  readonly identity: object

  appendEvent(input: McpRuntimeTestEventAppendInput): Promise<McpRuntimeTestEventAppendResult>
  loadRuntimeSessionId(sessionId: string): Promise<string | null | undefined>
  setRootSession(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly runtimeSessionId: string
    readonly previousRuntimeSessionId?: string
  }): Promise<{ readonly captureLive: boolean }>
  markRootSessionResetPending(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly runtimeSessionId: string
  }): Promise<{ readonly captureLive: boolean }>
  markCaptureTerminal(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly state: Exclude<McpRuntimeTestCaptureState, 'live'>
    readonly reason: McpRuntimeTestCaptureIncompleteReason | null
  }): Promise<void>

  shutdown(now: number, idleDeadlineAt: number): Promise<readonly McpRuntimeTestRunningRef[]>
  listEndingWithoutInFlight(): Promise<readonly string[]>
  findCreateReceipt(input: {
    readonly mcpId: string
    readonly ownerUserId: string
    readonly clientCreateId: string
  }): Promise<McpRuntimeTestCreateReceiptRecord | null>
  create(
    input: McpRuntimeTestCreatePersistenceInput,
  ): Promise<McpRuntimeTestCreatePersistenceResult>
  findTurnByClientMessage(
    sessionId: string,
    clientMessageId: string,
  ): Promise<McpRuntimeTestTurnRecord | null>
  acceptMessage(input: McpRuntimeTestAcceptMessageInput): Promise<McpRuntimeTestAcceptMessageResult>
  cancel(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly now: number
    readonly idleDeadlineAt: number
  }): Promise<McpRuntimeTestCancelPersistenceResult>
  end(input: {
    readonly sessionId: string
    readonly now: number
  }): Promise<McpRuntimeTestEndPersistenceResult>

  loadSession(sessionId: string, mcpId?: string): Promise<McpRuntimeTestSessionRecord | null>
  loadTurn(turnId: string): Promise<McpRuntimeTestTurnRecord | null>
  findLatestSession(mcpId: string, ownerUserId: string): Promise<McpRuntimeTestSessionRecord | null>
  listTurns(sessionId: string): Promise<readonly McpRuntimeTestTurnRecord[]>
  listEvents(sessionId: string): Promise<readonly McpRuntimeTestEventRecord[]>
  latestEventSequence(sessionId: string): Promise<number>
  loadBroadcastSnapshot(sessionId: string): Promise<McpRuntimeTestBroadcastSnapshot | null>

  invalidateMcp(input: {
    readonly mcpId: string
    readonly reason: McpRuntimeTestEndReason
    readonly now: number
  }): Promise<readonly McpRuntimeTestRunningRef[]>
  invalidateOwner(input: {
    readonly ownerUserId: string
    readonly reason: McpRuntimeTestEndReason
    readonly now: number
  }): Promise<readonly McpRuntimeTestRunningRef[]>
  markMcpConfigChanged(input: { readonly mcpId: string; readonly now: number }): Promise<{
    readonly idleSessionIds: readonly string[]
    readonly changedSessionIds: readonly string[]
  }>
  markRuntimeProfileChanged(input: {
    readonly runtimeName: string
    readonly now: number
  }): Promise<{
    readonly idleSessionIds: readonly string[]
    readonly changedSessionIds: readonly string[]
  }>
  invalidateRuntime(input: {
    readonly runtimeName: string
    readonly reason: 'runtime-disabled' | 'runtime-deleted'
    readonly now: number
  }): Promise<readonly McpRuntimeTestRunningRef[]>
  assertMcpDeleteReady(mcpId: string): Promise<void>

  expireIdle(now: number): Promise<readonly string[]>
  listCleanupCandidates(): Promise<readonly string[]>
  listExpiredReceipts(now: number): Promise<readonly McpRuntimeTestCreateReceiptRecord[]>
  deleteExpiredReceipt(receipt: McpRuntimeTestCreateReceiptRecord, now: number): Promise<void>
  listQuarantinedCandidates(): Promise<readonly McpRuntimeTestQuarantinedCandidate[]>
  recoverQuarantined(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly expectedPid: number
    readonly now: number
  }): Promise<boolean>
  expireTurns(now: number, idleDeadlineAt: number): Promise<McpRuntimeTestExpiredTurnResult>
  listDurableIntentCandidates(): Promise<readonly McpRuntimeTestSessionRecord[]>
  settleQueuedDurableIntent(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly now: number
  }): Promise<boolean>
  requestRunningTurnCancel(turnId: string, now: number): Promise<void>
  clearTerminalDurableIntent(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly now: number
  }): Promise<boolean>

  listBootSessions(): Promise<readonly McpRuntimeTestSessionRecord[]>
  recoverBootSession(input: McpRuntimeTestBootRecoveryInput): Promise<boolean>
  admitTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly now: number
    readonly idleDeadlineAt: number
  }): Promise<McpRuntimeTestAdmittedTurn | null>
  isSpawnAllowed(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly now: number
  }): Promise<boolean>
  recordSpawn(input: McpRuntimeTestSpawnReceiptInput): Promise<boolean>
  failBeforeRun(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly failureCode: string
    readonly endReason: McpRuntimeTestEndReason
    readonly now: number
  }): Promise<void>
  settleTurn(input: McpRuntimeTestSettlementInput): Promise<boolean>
  invalidateSession(input: {
    readonly sessionId: string
    readonly reason: McpRuntimeTestEndReason
    readonly now: number
  }): Promise<string | null>
  prepareCleanup(sessionId: string, now: number): Promise<McpRuntimeTestCleanupCandidate | null>
  finishCleanup(input: {
    readonly sessionId: string
    readonly cleanupState: McpRuntimeTestCleanupState
    readonly cleanupErrorCode: string | null
    readonly now: number
  }): Promise<boolean>
  nextDeadline(): Promise<number | null>
}
