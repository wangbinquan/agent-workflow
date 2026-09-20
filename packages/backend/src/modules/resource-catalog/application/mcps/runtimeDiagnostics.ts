import { ulid } from 'ulid'
import {
  McpRuntimeTestSessionDtoSchema,
  SessionViewResponseSchema,
  parseSessionTree,
  type Mcp,
  type McpRuntimeTestCancelRequest,
  type McpRuntimeTestCreateReceipt,
  type McpRuntimeTestCreateRequest,
  type McpRuntimeTestEndReason,
  type McpRuntimeTestMessageReceipt,
  type McpRuntimeTestMessageRequest,
  type McpRuntimeTestMutationReceipt,
  type McpRuntimeTestSessionDto,
  type ParseSessionInputEvent,
  type SessionViewResponse,
  type StartupVerificationResult,
} from '@agent-workflow/shared'
import type { McpDiagnosticRunResult } from './runtimeDiagnosticsEffects'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type { StaleRunKillOutcome } from '@/util/process'
import type { McpRuntimeTestLeaseOperations } from '../../public/participants'
import type { McpRuntimeTestLeaseToken } from '../../public/types'
import type {
  McpRuntimeTestPersistence,
  McpRuntimeTestSessionRecord as SessionRow,
  McpRuntimeTestTurnRecord as TurnRow,
} from './runtimeTestPersistence'
import type {
  McpDiagnosticsEffects,
  ResolvedTestRuntime,
  DiagnosticTimer,
} from './runtimeDiagnosticsEffects'
import { McpRuntimeTestEventSink } from './runtimeTestEventSink'
import {
  AGENT_NAME,
  DEFAULT_CAPACITY,
  STDERR_TAIL_BYTES,
  MCP_RUNTIME_TEST_IDLE_MS,
  MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
  MCP_RUNTIME_TEST_RECEIPT_MS,
  MCP_RUNTIME_TEST_MAX_TURNS,
  sha256,
  stableJson,
  requestDigest,
  ensureMessage,
  canResumeNativeSession,
  assertSessionActor,
  resultTurnStatus,
  applyPlaygroundVerification,
  resultFailureCode,
} from '../../domain/mcps/runtimeDiagnostics'
/** Only the existing session ownership and audit facts are needed here. */
export interface McpDiagnosticsCaller {
  readonly user: { readonly id: string }
  readonly permissions: { has(permission: 'mcp-runtime-tests:audit'): boolean }
}
export interface McpDiagnosticsDependencies {
  readonly persistence: McpRuntimeTestPersistence
  readonly leaseOperations: McpRuntimeTestLeaseOperations
  readonly loadMcp: (mcpId: string) => Promise<Mcp | null>
  readonly effects: McpDiagnosticsEffects
  readonly capacity?: number
}
interface QueueItem {
  sessionId: string
  turnId: string
}
export class McpDiagnosticsApplication {
  private readonly now
  private readonly capacity
  private readonly killStaleRunProcessTree
  private readonly log = createLogger('mcp-runtime-test')
  private readonly queue: QueueItem[] = []
  private readonly queued = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly turnPromises = new Map<string, Promise<void>>()
  private readonly activeReceiptAttempts = new Set<string>()
  private activeWorkers = 0
  private idleTimer: DiagnosticTimer | null = null
  private reconcileTimer: DiagnosticTimer | null = null
  private startPromise: Promise<void> | null = null
  private hasStarted = false
  private disposed = false
  private disposePromise: Promise<void> | null = null
  private accepting = true
  private paused = false
  private shuttingDown = false

  constructor(private readonly deps: McpDiagnosticsDependencies) {
    this.now = deps.effects.now
    this.capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY)
    this.killStaleRunProcessTree = deps.effects.reap
  }

  start(): Promise<void> {
    if (this.disposed)
      return Promise.reject(
        new ConflictError('mcp-test-service-disposed', 'the MCP runtime test service is disposed'),
      )
    if (this.startPromise !== null) return this.startPromise
    this.hasStarted = true
    let resolveAttempt!: () => void
    let rejectAttempt!: (error: unknown) => void
    const attempt = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve
      rejectAttempt = reject
    })
    this.startPromise = attempt.catch((error: unknown) => {
      this.startPromise = null
      throw error
    })
    // Publish the promise before a synchronous persistence callback can dispose
    // this instance. The original boot sequence still starts immediately.
    void (async () => {
      await this.bootRecover()
      await this.reconcileCore()
      this.installReconcileTimer()
    })().then(resolveAttempt, rejectAttempt)
    return this.startPromise
  }

  /** Permanently close an application-owned instance without starting a cold one. */
  async dispose(budgetMs = 30_000): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise
    const starting = this.startPromise
    this.disposed = true
    this.shuttingDown = true
    this.paused = true
    this.accepting = false
    this.clearBackgroundTimers()
    this.queue.splice(0)
    this.queued.clear()
    this.disposePromise = (async () => {
      if (!this.hasStarted) return
      const errors: unknown[] = []
      try {
        await starting
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.drainRunningTurns(budgetMs)
      } catch (error) {
        errors.push(error)
      } finally {
        this.clearBackgroundTimers()
        this.queue.splice(0)
        this.queued.clear()
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'MCP runtime test disposal failed')
    })()
    return this.disposePromise
  }

  async shutdown(budgetMs = 30_000): Promise<void> {
    await this.start()
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.paused = true
    this.accepting = false
    this.clearBackgroundTimers()
    await this.drainRunningTurns(budgetMs)
  }

  /** Reversible provider-session admission fence. Existing turns are drained,
   * while a failed provider switch may resume this same service instance. */
  async pause(budgetMs = 30_000): Promise<void> {
    await this.start()
    if (this.shuttingDown || this.paused) return
    this.paused = true
    this.accepting = false
    this.clearBackgroundTimers()
    await this.drainRunningTurns(budgetMs)
  }

  async resume(): Promise<void> {
    await this.start()
    if (this.shuttingDown || !this.paused) return
    await this.reconcileCore()
    this.paused = false
    this.accepting = true
    this.installReconcileTimer()
    this.scheduleIdleTimer()
  }

  async stop(budgetMs = 30_000): Promise<void> {
    await this.shutdown(budgetMs)
  }

  private installReconcileTimer(): void {
    if (this.shuttingDown || this.paused || this.reconcileTimer !== null) return
    this.reconcileTimer = this.deps.effects.setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.log.warn('mcp-test-periodic-reconcile-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, 60_000)
    this.reconcileTimer.unref?.()
  }

  private clearBackgroundTimers(): void {
    if (this.idleTimer !== null) this.idleTimer.cancel()
    if (this.reconcileTimer !== null) this.reconcileTimer.cancel()
    this.idleTimer = null
    this.reconcileTimer = null
  }

  private async drainRunningTurns(budgetMs: number): Promise<void> {
    const now = this.now()
    const affected = await this.deps.persistence.shutdown(now, now + MCP_RUNTIME_TEST_IDLE_MS)

    this.queue.splice(0)
    this.queued.clear()
    for (const row of affected) {
      await this.broadcastSession(row.sessionId)
      if (row.turnId !== null) this.controllers.get(row.turnId)?.abort()
    }

    const pending = affected
      .map((row) => (row.turnId === null ? undefined : this.turnPromises.get(row.turnId)))
      .filter((promise): promise is Promise<void> => promise !== undefined)
    if (pending.length > 0) {
      let timer: DiagnosticTimer | undefined
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolvePromise) => {
          // RFC-254: deadline an await depends on — must stay ref'd (unref'd
          // timers never fire on Windows Bun once the loop is otherwise idle;
          // see rfc254-no-unref-deadline-guard.test.ts). Cleared just below.
          timer = this.deps.effects.setTimeout(() => resolvePromise(), Math.max(0, budgetMs))
        }),
      ])
      if (timer !== undefined) timer.cancel()
    }

    const cleanup = await this.deps.persistence.listEndingWithoutInFlight()
    for (const sessionId of cleanup) await this.finishEndingSession(sessionId)
  }

  private assertAccepting(): void {
    if (!this.accepting) {
      throw new ConflictError(
        'mcp-test-service-stopping',
        'the daemon is stopping and cannot accept a new MCP runtime turn',
      )
    }
  }

  async create(
    actor: McpDiagnosticsCaller,
    mcp: Mcp,
    input: McpRuntimeTestCreateRequest,
  ): Promise<McpRuntimeTestCreateReceipt> {
    await this.start()
    this.assertAccepting()
    const attemptKey = `${mcp.id}\0${actor.user.id}\0${input.clientCreateId}`
    this.activeReceiptAttempts.add(attemptKey)
    try {
      return await this.createReady(actor, mcp, input)
    } finally {
      this.activeReceiptAttempts.delete(attemptKey)
    }
  }

  private async createReady(
    actor: McpDiagnosticsCaller,
    mcp: Mcp,
    input: McpRuntimeTestCreateRequest,
  ): Promise<McpRuntimeTestCreateReceipt> {
    ensureMessage(input.message)
    const digest = requestDigest(input)
    const replay = await this.deps.persistence.findCreateReceipt({
      mcpId: mcp.id,
      ownerUserId: actor.user.id,
      clientCreateId: input.clientCreateId,
    })
    if (replay !== null) {
      if (replay.requestDigest !== digest) {
        throw new ConflictError(
          'mcp-test-idempotency-mismatch',
          'clientCreateId was already used with different inputs',
        )
      }
      return { sessionId: replay.sessionId, acceptedTurnId: replay.acceptedTurnId }
    }
    if (!mcp.enabled) {
      throw new ValidationError(
        'mcp-disabled',
        `mcp '${mcp.name}' is disabled; enable it before testing`,
      )
    }
    const currentHash = await this.currentMcpHash(mcp)
    if (currentHash !== input.expectedMcpConfigHash) {
      throw staleConflictError('mcp', 'the MCP changed; reload before testing', {
        expectedConfigHash: input.expectedMcpConfigHash,
        currentConfigHash: currentHash,
      })
    }
    const runtime = await this.resolveRuntime(input.runtimeName)
    const now = this.now()

    const sessionId = ulid()
    const turnId = ulid()
    const scratchRoot = this.deps.effects.workspaceReference(sessionId)
    const runtimeSessionId = this.deps.effects.createNativeSessionId(runtime)

    const receipt = await this.deps.persistence.create({
      mcpId: mcp.id,
      ownerUserId: actor.user.id,
      clientCreateId: input.clientCreateId,
      requestDigest: digest,
      sessionId,
      turnId,
      mcpConfigHash: currentHash,
      runtimeRowId: runtime.row.id,
      runtimeName: runtime.row.name,
      runtimeProtocol: runtime.row.protocol,
      runtimeSnapshotJson: runtime.snapshotJson,
      runtimeBinaryPath: runtime.binary,
      runtimeSessionId,
      scratchRoot,
      message: input.message,
      clientMessageId: input.clientMessageId,
      now,
      hardDeadlineAt: now + MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
      receiptExpiresAt: now + MCP_RUNTIME_TEST_RECEIPT_MS,
    })
    await this.broadcastSession(receipt.sessionId)
    if (receipt.shouldQueue) this.enqueue({ sessionId, turnId })
    return { sessionId: receipt.sessionId, acceptedTurnId: receipt.acceptedTurnId }
  }

  async message(
    actor: McpDiagnosticsCaller,
    mcp: Mcp,
    sessionId: string,
    input: McpRuntimeTestMessageRequest,
  ): Promise<McpRuntimeTestMessageReceipt> {
    await this.start()
    this.assertAccepting()
    ensureMessage(input.message)
    const session = await this.requireSession(sessionId, mcp.id)
    assertSessionActor(session, {
      userId: actor.user.id,
      canAudit: actor.permissions.has('mcp-runtime-tests:audit'),
    })
    const replay = await this.deps.persistence.findTurnByClientMessage(
      sessionId,
      input.clientMessageId,
    )
    if (replay !== null) {
      if (replay.promptText !== input.message) {
        throw new ConflictError(
          'mcp-test-idempotency-mismatch',
          'clientMessageId was already used with a different message',
        )
      }
      return {
        sessionId,
        acceptedTurnId: replay.id,
        sessionVersion: session.sessionVersion,
      }
    }

    if (!mcp.enabled) {
      await this.invalidateSession(session.id, 'mcp-disabled')
      throw new ConflictError('mcp-test-session-stale', 'the MCP is now disabled')
    }
    const currentHash = await this.currentMcpHash(mcp)
    if (currentHash !== session.mcpConfigHash) {
      await this.invalidateSession(session.id, 'mcp-config-changed')
      throw new ConflictError('mcp-test-session-stale', 'the MCP changed; start a new test')
    }
    const runtime = await this.resolveRuntime(session.runtimeName)
    if (
      runtime.row.id !== session.runtimeRowId ||
      runtime.snapshotJson !== session.runtimeSnapshotJson
    ) {
      await this.invalidateSession(session.id, 'runtime-profile-changed')
      throw new ConflictError('mcp-test-session-stale', 'the runtime changed; start a new test')
    }

    const now = this.now()
    const turnId = ulid()
    const accepted = await this.deps.persistence.acceptMessage({
      mcpId: mcp.id,
      sessionId,
      turnId,
      clientMessageId: input.clientMessageId,
      message: input.message,
      expectedSessionVersion: input.expectedSessionVersion,
      now,
      hardDeadlineAt: now + MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
      idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
      maxTurns: MCP_RUNTIME_TEST_MAX_TURNS,
    })
    if (accepted.turnId === null) {
      await this.finishEndingSession(sessionId)
      throw new ConflictError('mcp-test-session-expired', 'the MCP test session expired')
    }
    await this.broadcastSession(sessionId)
    if (accepted.shouldQueue) this.enqueue({ sessionId, turnId: accepted.turnId })
    return {
      sessionId,
      acceptedTurnId: accepted.turnId,
      sessionVersion: accepted.version,
    }
  }

  async cancel(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
    input: McpRuntimeTestCancelRequest,
  ): Promise<McpRuntimeTestMutationReceipt> {
    await this.start()
    const initial = await this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, {
      userId: actor.user.id,
      canAudit: actor.permissions.has('mcp-runtime-tests:audit'),
    })
    const now = this.now()
    const result = await this.deps.persistence.cancel({
      sessionId,
      turnId: input.turnId,
      now,
      idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
    })
    if (result.abort) this.controllers.get(input.turnId)?.abort()
    if (result.cleanup) await this.finishEndingSession(sessionId)
    this.scheduleIdleTimer()
    await this.broadcastSession(sessionId)
    return { session: await this.get(actor, mcpId, sessionId) }
  }

  async end(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
  ): Promise<McpRuntimeTestMutationReceipt> {
    await this.start()
    const initial = await this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, {
      userId: actor.user.id,
      canAudit: actor.permissions.has('mcp-runtime-tests:audit'),
    })
    const now = this.now()
    const transitioned = await this.deps.persistence.end({ sessionId, now })
    if (transitioned.turnId !== null) {
      this.controllers.get(transitioned.turnId)?.abort()
      await this.turnPromises.get(transitioned.turnId)
    }
    if (transitioned.cleanup || transitioned.turnId !== null) {
      await this.finishEndingSession(sessionId)
    }
    await this.broadcastSession(sessionId)
    return { session: await this.get(actor, mcpId, sessionId) }
  }

  async latest(
    actor: McpDiagnosticsCaller,
    mcpId: string,
  ): Promise<McpRuntimeTestSessionDto | null> {
    await this.start()
    await this.reconcile()
    const row = await this.deps.persistence.findLatestSession(mcpId, actor.user.id)
    return row === null ? null : this.project(row)
  }

  async get(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
  ): Promise<McpRuntimeTestSessionDto> {
    await this.start()
    await this.reconcile()
    const row = await this.requireSession(sessionId, mcpId)
    assertSessionActor(
      row,
      { userId: actor.user.id, canAudit: actor.permissions.has('mcp-runtime-tests:audit') },
      true,
    )
    return this.project(row)
  }

  async sessionView(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
  ): Promise<SessionViewResponse> {
    await this.start()
    const session = await this.requireSession(sessionId, mcpId)
    assertSessionActor(
      session,
      { userId: actor.user.id, canAudit: actor.permissions.has('mcp-runtime-tests:audit') },
      true,
    )
    const turns = await this.deps.persistence.listTurns(sessionId)
    const events = await this.deps.persistence.listEvents(sessionId)
    const inputEvents: ParseSessionInputEvent[] = events.map((event) => ({
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      payload: event.payload,
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
    }))
    const first = turns[0]
    const parsed = parseSessionTree({
      rootSessionId: session.runtimeSessionId,
      promptText: first?.promptText ?? null,
      startedAt: first?.createdAt ?? session.createdAt,
      primaryAgentName: AGENT_NAME,
      events: inputEvents,
      extraUserPrompts: turns.slice(1).map((turn) => ({
        text: turn.promptText,
        ts: turn.createdAt,
      })),
    })
    const captureComplete = turns.every((turn) => turn.captureState === 'complete')
    return SessionViewResponseSchema.parse({
      tree: captureComplete ? parsed : { ...parsed, captureComplete: false },
    })
  }

  async invalidateMcp(mcpId: string, reason: McpRuntimeTestEndReason): Promise<void> {
    await this.start()
    const now = this.now()
    const running = await this.deps.persistence.invalidateMcp({ mcpId, reason, now })
    for (const row of running) await this.broadcastSession(row.sessionId)
    await Promise.all(
      running.map(async ({ sessionId, turnId }) => {
        if (turnId !== null) {
          this.controllers.get(turnId)?.abort()
          await this.turnPromises.get(turnId)
        }
        await this.finishEndingSession(sessionId)
      }),
    )
  }

  async invalidateOwner(
    ownerUserId: string,
    reason: McpRuntimeTestEndReason = 'access-revoked',
  ): Promise<void> {
    await this.start()
    const now = this.now()
    const running = await this.deps.persistence.invalidateOwner({ ownerUserId, reason, now })
    for (const row of running) await this.broadcastSession(row.sessionId)
    await Promise.all(
      running.map(async ({ sessionId, turnId }) => {
        if (turnId !== null) {
          this.controllers.get(turnId)?.abort()
          await this.turnPromises.get(turnId)
        }
        await this.finishEndingSession(sessionId)
      }),
    )
  }

  /**
   * Ordinary config/rename changes do not hot-kill a turn whose frozen plan is
   * already running. They do, however, make continuation impossible: idle
   * sessions end now; running sessions end as soon as that turn is reaped.
   */
  async markMcpConfigChanged(mcpId: string): Promise<void> {
    await this.start()
    const now = this.now()
    const changed = await this.deps.persistence.markMcpConfigChanged({ mcpId, now })
    for (const sessionId of changed.changedSessionIds) await this.broadcastSession(sessionId)
    for (const sessionId of changed.idleSessionIds) await this.finishEndingSession(sessionId)
  }

  async markRuntimeProfileChanged(runtimeName: string): Promise<void> {
    await this.start()
    const now = this.now()
    const changed = await this.deps.persistence.markRuntimeProfileChanged({ runtimeName, now })
    for (const sessionId of changed.changedSessionIds) await this.broadcastSession(sessionId)
    for (const sessionId of changed.idleSessionIds) await this.finishEndingSession(sessionId)
  }

  async invalidateRuntime(
    runtimeName: string,
    reason: 'runtime-disabled' | 'runtime-deleted',
  ): Promise<void> {
    await this.start()
    const now = this.now()
    const rows = await this.deps.persistence.invalidateRuntime({ runtimeName, reason, now })
    for (const row of rows) await this.broadcastSession(row.sessionId)
    for (const row of rows) {
      if (row.turnId !== null) {
        this.controllers.get(row.turnId)?.abort()
        await this.turnPromises.get(row.turnId)
      }
      await this.finishEndingSession(row.sessionId)
    }
  }

  /**
   * MCP deletion barrier: end/reap every live test and prove cleanup. The
   * dependent DB rows remain until the canonical MCP delete transaction, so a
   * late reverse-reference conflict cannot erase transcripts on a failed delete.
   */
  async prepareMcpDelete(mcpId: string): Promise<void> {
    await this.start()
    await this.invalidateMcp(mcpId, 'mcp-deleted')
    await this.deps.persistence.assertMcpDeleteReady(mcpId)
  }

  async reconcile(): Promise<void> {
    await this.start()
    await this.reconcileCore()
  }

  /**
   * Complete lifecycle work whose durable intent was committed atomically by
   * an MCP/ACL/runtime/user mutation. This post-commit phase may abort and reap
   * a child, clean its scratch directory, and publish the owner-scoped locator frame.
   */
  async reconcileDurableIntents(): Promise<void> {
    await this.start()
    await this.reconcileDurableIntentsCore(true)
  }

  private async reconcileCore(): Promise<void> {
    await this.reconcileDurableIntentsCore()
    await this.reconcileExpiredTurns()
    const now = this.now()
    const expired = await this.deps.persistence.expireIdle(now)
    for (const sessionId of expired) {
      await this.broadcastSession(sessionId)
      await this.finishEndingSession(sessionId)
    }
    await this.reconcileQuarantinedSessions()
    const cleanupCandidates = await this.deps.persistence.listCleanupCandidates()
    for (const sessionId of cleanupCandidates) await this.finishEndingSession(sessionId)

    const expiredReceipts = await this.deps.persistence.listExpiredReceipts(now)
    for (const receipt of expiredReceipts) {
      const key = `${receipt.mcpId}\0${receipt.ownerUserId}\0${receipt.clientCreateId}`
      if (this.activeReceiptAttempts.has(key)) continue
      await this.deps.persistence.deleteExpiredReceipt(receipt, now)
    }
    this.scheduleIdleTimer()
  }

  private async reconcileQuarantinedSessions(): Promise<void> {
    const candidates = await this.deps.persistence.listQuarantinedCandidates()
    for (const { session, turn } of candidates) {
      if (turn === null || turn.pid === null) continue
      const outcome = await this.killStaleRunProcessTree(
        {
          pid: turn.pid,
          startedAt: turn.startedAt,
          spawnBinaryPath: turn.spawnBinaryPath,
        },
        { now: this.now() },
      )
      if (!['not-alive', 'killed'].includes(outcome)) continue
      const recovered = await this.deps.persistence.recoverQuarantined({
        sessionId: session.id,
        turnId: turn.id,
        expectedPid: turn.pid,
        now: this.now(),
      })
      if (!recovered) continue
      await this.deps.leaseOperations.repairAfterReap(session.id, turn.id, true)
      await this.broadcastSession(session.id)
      await this.finishEndingSession(session.id)
    }
  }

  private async reconcileExpiredTurns(): Promise<void> {
    const now = this.now()
    const expired = await this.deps.persistence.expireTurns(now, now + MCP_RUNTIME_TEST_IDLE_MS)

    for (const row of expired.settled) {
      this.queued.delete(row.turnId)
      const index = this.queue.findIndex((item) => item.turnId === row.turnId)
      if (index >= 0) this.queue.splice(index, 1)
      await this.broadcastSession(row.sessionId)
      if (row.end) await this.finishEndingSession(row.sessionId)
    }
    for (const row of expired.abort) {
      await this.broadcastSession(row.sessionId)
      this.controllers.get(row.turnId)?.abort()
    }
  }

  private async reconcileDurableIntentsCore(awaitRunning = false): Promise<void> {
    const candidates = await this.deps.persistence.listDurableIntentCandidates()

    for (const snapshot of candidates) {
      await this.broadcastSession(snapshot.id)
      if (snapshot.status !== 'ending') continue
      if (snapshot.inFlightTurnId === null) {
        await this.finishEndingSession(snapshot.id)
        continue
      }

      const turn = await this.deps.persistence.loadTurn(snapshot.inFlightTurnId)
      if (turn === null) {
        this.log.error('mcp-test-durable-intent-missing-turn', {
          sessionId: snapshot.id,
          turnId: snapshot.inFlightTurnId,
        })
        continue
      }

      if (turn.status === 'queued') {
        this.queued.delete(turn.id)
        const queuedIndex = this.queue.findIndex((item) => item.turnId === turn.id)
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
        const now = this.now()
        await this.deps.persistence.settleQueuedDurableIntent({
          sessionId: snapshot.id,
          turnId: turn.id,
          now,
        })
        await this.broadcastSession(snapshot.id)
        await this.finishEndingSession(snapshot.id)
        continue
      }

      if (turn.status === 'running') {
        const now = this.now()
        await this.deps.persistence.requestRunningTurnCancel(turn.id, now)
        const promise = this.turnPromises.get(turn.id)
        this.controllers.get(turn.id)?.abort()
        if (promise !== undefined && awaitRunning) {
          await promise
          await this.finishEndingSession(snapshot.id)
        } else if (promise === undefined) {
          this.log.warn('mcp-test-durable-intent-awaits-boot-recovery', {
            sessionId: snapshot.id,
            turnId: turn.id,
          })
        }
        continue
      }

      const now = this.now()
      await this.deps.persistence.clearTerminalDurableIntent({
        sessionId: snapshot.id,
        turnId: turn.id,
        now,
      })
      await this.broadcastSession(snapshot.id)
      await this.finishEndingSession(snapshot.id)
    }
  }

  private async bootRecover(): Promise<void> {
    const sessions = await this.deps.persistence.listBootSessions()
    for (const session of sessions) {
      const supportsSession = this.deps.effects.supportsSession(session.runtimeProtocol)
      if (session.inFlightTurnId === null) {
        if (session.status === 'ending') await this.finishEndingSession(session.id)
        continue
      }
      const turn = await this.deps.persistence.loadTurn(session.inFlightTurnId)
      let reapOutcome: StaleRunKillOutcome | 'missing-turn' = 'no-pid'
      if (turn === null) {
        reapOutcome = 'missing-turn'
      } else if (turn.status === 'running' || turn.pid !== null) {
        reapOutcome = await this.killStaleRunProcessTree(
          {
            pid: turn.pid,
            startedAt: turn.startedAt,
            spawnBinaryPath: turn.spawnBinaryPath,
          },
          { now: this.now() },
        )
      }
      const childReapProven = ['not-alive', 'killed'].includes(reapOutcome)
      const queuedWithoutChild = turn?.status === 'queued' && turn.pid === null
      const quarantine =
        reapOutcome === 'missing-turn' ||
        (reapOutcome === 'no-pid' && !queuedWithoutChild) ||
        reapOutcome === 'command-mismatch' ||
        reapOutcome === 'window-expired' ||
        reapOutcome === 'kill-failed' ||
        (!queuedWithoutChild && !childReapProven)
      const captureComplete =
        queuedWithoutChild || (turn !== null && turn.captureState === 'complete')
      const resumable =
        supportsSession &&
        !quarantine &&
        session.status === 'active' &&
        canResumeNativeSession(session) &&
        captureComplete &&
        this.deps.effects.workspaceExists(session.scratchRoot)
      const now = this.now()
      await this.deps.persistence.recoverBootSession({
        sessionId: session.id,
        expectedTurnId: session.inFlightTurnId,
        resumable,
        quarantine,
        reapOutcome,
        now,
        idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
      })
      if (turn !== null && childReapProven) {
        await this.deps.leaseOperations.repairAfterReap(session.id, turn.id, true)
      }
      await this.broadcastSession(session.id)
      if (quarantine) {
        this.log.error('mcp-test-boot-reap-unproven', {
          sessionId: session.id,
          turnId: session.inFlightTurnId,
          outcome: reapOutcome,
        })
      }
      if (!resumable) await this.finishEndingSession(session.id)
    }
  }

  private async currentMcpHash(mcp: Mcp): Promise<string> {
    return this.deps.effects.currentMcpHash(mcp)
  }

  private async resolveRuntime(name: string | null): Promise<ResolvedTestRuntime> {
    return this.deps.effects.resolveRuntime(name)
  }

  private async requireSession(sessionId: string, mcpId: string): Promise<SessionRow> {
    const row = await this.deps.persistence.loadSession(sessionId, mcpId)
    if (row === null) {
      throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
    }
    return row
  }

  private async project(row: SessionRow): Promise<McpRuntimeTestSessionDto> {
    const turns = await this.deps.persistence.listTurns(row.id)
    const cursor = await this.deps.persistence.latestEventSequence(row.id)
    return McpRuntimeTestSessionDtoSchema.parse({
      id: row.id,
      mcpId: row.mcpId,
      status: row.status,
      endReason: row.endReason,
      runtime: { name: row.runtimeName, protocol: row.runtimeProtocol },
      mcpConfigHash: row.mcpConfigHash,
      nativeSessionReady: row.nativeSessionState === 'ready',
      continuationBlockedReason: row.continuationBlockedReason,
      inFlightTurnId: row.inFlightTurnId,
      sessionVersion: row.sessionVersion,
      idleDeadlineAt: row.idleDeadlineAt,
      cleanupState: row.cleanupState,
      turns: turns.map((turn) => ({
        id: turn.id,
        seq: turn.seq,
        prompt: turn.promptText,
        status: turn.status,
        captureState: turn.captureState,
        hardDeadlineAt: turn.hardDeadlineAt,
        failureCode: turn.failureCode,
        stderrTail: turn.stderrTail,
        durationMs: turn.durationMs,
        createdAt: turn.createdAt,
        startedAt: turn.startedAt,
        finishedAt: turn.finishedAt,
      })),
      eventCursor: cursor,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
    })
  }

  private async broadcastSession(sessionId: string): Promise<void> {
    const session = await this.deps.persistence.loadBroadcastSnapshot(sessionId)
    if (session === null) return
    this.deps.effects.broadcast(sessionId, session)
  }

  private enqueue(item: QueueItem): void {
    if (this.disposed) return
    if (this.queued.has(item.turnId) || this.turnPromises.has(item.turnId)) return
    this.queued.add(item.turnId)
    this.queue.push(item)
    this.drain()
    this.scheduleIdleTimer()
  }

  private drain(): void {
    while (this.activeWorkers < this.capacity && this.queue.length > 0) {
      const item = this.queue.shift()
      if (item === undefined) break
      this.queued.delete(item.turnId)
      this.activeWorkers += 1
      const promise = this.executeTurn(item)
        .catch((error: unknown) => {
          this.log.error('mcp-test-turn-worker-failed', {
            sessionId: item.sessionId,
            turnId: item.turnId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          this.controllers.delete(item.turnId)
          this.turnPromises.delete(item.turnId)
          this.activeWorkers -= 1
          this.drain()
        })
      this.turnPromises.set(item.turnId, promise)
    }
  }

  private async executeTurn(item: QueueItem): Promise<void> {
    const now = this.now()
    const admitted = await this.deps.persistence.admitTurn({
      sessionId: item.sessionId,
      turnId: item.turnId,
      now,
      idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
    })
    if (admitted === null) {
      const current = await this.deps.persistence.loadSession(item.sessionId)
      if (current?.status === 'ending') await this.finishEndingSession(item.sessionId)
      else if (current?.status === 'active' && current.inFlightTurnId === null) {
        await this.broadcastSession(item.sessionId)
        this.scheduleIdleTimer()
      }
      return
    }
    await this.broadcastSession(item.sessionId)

    const controller = new AbortController()
    this.controllers.set(item.turnId, controller)
    const { session, turn } = admitted
    const mcp = await this.loadMcpForRun(session.mcpId)
    if (
      mcp === null ||
      !mcp.enabled ||
      (await this.currentMcpHash(mcp)) !== session.mcpConfigHash
    ) {
      await this.failBeforeRun(item, 'mcp-test-mcp-changed', 'mcp-config-changed')
      return
    }
    let runtime: ResolvedTestRuntime
    try {
      runtime = await this.resolveRuntime(session.runtimeName)
    } catch {
      await this.failBeforeRun(item, 'mcp-test-runtime-unavailable', 'runtime-disabled')
      return
    }
    if (
      runtime.row.id !== session.runtimeRowId ||
      runtime.snapshotJson !== session.runtimeSnapshotJson
    ) {
      await this.failBeforeRun(item, 'mcp-test-runtime-profile-changed', 'runtime-profile-changed')
      return
    }

    const leaseNonceDigest = sha256(
      stableJson({ sessionId: session.id, turnId: turn.id, nonce: ulid() }),
    )
    let nativeLease: McpRuntimeTestLeaseToken | undefined
    const claimNativeSession = async (
      runtimeSessionId: string,
      previousRuntimeSessionId?: string,
    ): Promise<void> => {
      if (previousRuntimeSessionId !== undefined) {
        if (
          nativeLease === undefined ||
          nativeLease.runtimeSessionId !== previousRuntimeSessionId
        ) {
          throw new Error('runtime conversation reset did not match the held native session')
        }
        nativeLease = await this.deps.leaseOperations.rotate(nativeLease, runtimeSessionId)
        return
      }
      if (nativeLease !== undefined) {
        if (nativeLease.runtimeSessionId !== runtimeSessionId) {
          throw new Error('runtime changed native session id during one turn')
        }
        return
      }
      nativeLease = await this.deps.leaseOperations.claimNew({
        protocol: session.runtimeProtocol,
        runtimeSessionId,
        testSessionId: session.id,
        turnId: turn.id,
        leaseNonceDigest,
      })
    }
    try {
      if (session.runtimeSessionId !== null) {
        nativeLease =
          turn.seq === 1
            ? await this.deps.leaseOperations.claimNew({
                protocol: session.runtimeProtocol,
                runtimeSessionId: session.runtimeSessionId,
                testSessionId: session.id,
                turnId: turn.id,
                leaseNonceDigest,
              })
            : await this.deps.leaseOperations.preclaim({
                protocol: session.runtimeProtocol,
                runtimeSessionId: session.runtimeSessionId,
                testSessionId: session.id,
                turnId: turn.id,
                leaseNonceDigest,
              })
      }
    } catch {
      await this.failBeforeRun(item, 'mcp-test-session-conflict', 'session-unusable')
      return
    }

    const sink = new McpRuntimeTestEventSink(
      this.deps.persistence,
      item,
      () => void this.broadcastSession(item.sessionId),
      claimNativeSession,
    )
    const timeoutMs = Math.max(1, turn.hardDeadlineAt - this.now())
    let result: McpDiagnosticRunResult
    try {
      const assertSpawnAllowed = async (): Promise<void> => {
        const allowed = await this.deps.persistence.isSpawnAllowed({
          sessionId: session.id,
          turnId: turn.id,
          now: this.now(),
        })
        if (!allowed) throw new Error('mcp-test-spawn-no-longer-admitted')
      }
      result = await this.deps.effects.runTurn({
        session,
        turn,
        mcp,
        runtime,
        signal: controller.signal,
        sink,
        timeoutMs,
        assertSpawnAllowed,
        onSpawned: async (receipt) => {
          const spawnedFenceAt = this.now()
          const admittedForPrompt = await this.deps.persistence.recordSpawn({
            sessionId: session.id,
            turnId: turn.id,
            pid: receipt.pid,
            spawnedAt: receipt.spawnedAt,
            spawnBinaryPath: receipt.spawnBinaryPath,
            fenceAt: spawnedFenceAt,
          })
          if (!admittedForPrompt) throw new Error('mcp-test-spawn-canceled-before-prompt')
        },
      })
    } catch {
      result = this.deps.effects.failedResult(session, controller.signal.aborted, this.now() - now)
    }
    await sink.markTerminal('complete')
    // RFC-280 T6 — strict playground semantics (design-gate P1-4): only a run
    // whose PROCESS finished ok is judged by the verification layer; durable
    // failures (timeout / shutdown / cancel) keep their codes.
    // RFC-282 B1b (§2.1b-2) — the declared manifest rides the run result from
    // the SAME assembly that spawned the turn; the old re-render here was the
    // last "two computations" seam the unification exists to close.
    const verification = await result.verifyAfterCapture()
    if (nativeLease !== undefined && result.status !== 'unreaped') {
      const released = await this.deps.leaseOperations.release(nativeLease)
      if (!released) {
        this.log.warn('mcp runtime test session lease release missed', {
          sessionId: session.id,
          turnId: turn.id,
        })
      }
    }
    await this.settleTurn(session, turn, result, verification)
  }

  private async loadMcpForRun(mcpId: string): Promise<Mcp | null> {
    return this.deps.loadMcp(mcpId)
  }

  private async failBeforeRun(
    item: QueueItem,
    failureCode: string,
    endReason: McpRuntimeTestEndReason,
  ): Promise<void> {
    const now = this.now()
    await this.deps.persistence.failBeforeRun({
      sessionId: item.sessionId,
      turnId: item.turnId,
      failureCode,
      endReason,
      now,
    })
    await this.finishEndingSession(item.sessionId)
  }

  private async settleTurn(
    originalSession: SessionRow,
    originalTurn: TurnRow,
    result: McpDiagnosticRunResult,
    verification?: StartupVerificationResult,
  ): Promise<void> {
    const now = this.now()
    const currentSession = await this.deps.persistence.loadSession(originalSession.id)
    const currentTurn = await this.deps.persistence.loadTurn(originalTurn.id)
    const durableFailureCode = currentTurn?.failureCode ?? null
    const verdict = applyPlaygroundVerification(
      resultTurnStatus(
        result,
        currentTurn?.cancelRequestedAt != null,
        currentSession?.status === 'ending',
        durableFailureCode,
      ),
      resultFailureCode(result, durableFailureCode),
      verification,
    )
    const shouldCleanup = await this.deps.persistence.settleTurn({
      sessionId: originalSession.id,
      turnId: originalTurn.id,
      originalTurnSeq: originalTurn.seq,
      status: verdict.turnStatus,
      failureCode: verdict.failureCode,
      exitCode: result.exitCode,
      stderrTail:
        result.stderrTail === ''
          ? null
          : result.stderrTail.slice(Math.max(0, result.stderrTail.length - STDERR_TAIL_BYTES)),
      durationMs: result.durationMs,
      capturedSessionId: result.capturedSessionId ?? null,
      nativeSessionIntegrityFailed: result.nativeSessionIntegrityFailed === true,
      childUnreaped: result.status === 'unreaped',
      now,
      idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
    })
    await this.broadcastSession(originalSession.id)
    if (shouldCleanup) await this.finishEndingSession(originalSession.id)
    else this.scheduleIdleTimer()
  }

  private async invalidateSession(
    sessionId: string,
    reason: McpRuntimeTestEndReason,
  ): Promise<void> {
    const now = this.now()
    const turnId = await this.deps.persistence.invalidateSession({ sessionId, reason, now })
    if (turnId !== null) this.controllers.get(turnId)?.abort()
    else await this.finishEndingSession(sessionId)
  }

  private async finishEndingSession(sessionId: string): Promise<void> {
    const row = await this.deps.persistence.prepareCleanup(sessionId, this.now())
    if (row === null) return
    const { cleanupState, cleanupErrorCode } = this.deps.effects.cleanupWorkspace(row)
    const endedAt = this.now()
    await this.deps.persistence.finishCleanup({
      sessionId,
      cleanupState,
      cleanupErrorCode,
      now: endedAt,
    })
    await this.broadcastSession(sessionId)
    this.scheduleIdleTimer()
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer !== null) this.idleTimer.cancel()
    this.idleTimer = null
    if (this.shuttingDown || this.paused) return
    // RFC-359：`nextDeadline()` 在 PostgreSQL 上是**真异步**的一次查询，SQLite 上是同步读。
    // 这条 fire-and-forget 此前既不 catch 也无人接住：PG 上库在服务停掉 / 测试拆台之后关闭，
    // 这个还在飞的 promise 就以 `Connection closed` 变成一条**无人处理的 rejection**
    // （CI 上表现为「Unhandled error between tests」，全部用例 0 fail 但进程退 1）。
    // 排期失败不是致命的——下一次事件会重新排期——但必须落一条日志，不能静默也不能裸飞。
    void this.deps.persistence
      .nextDeadline()
      .then((earliest) => {
        if (earliest === null || this.shuttingDown || this.paused) return
        const delay = Math.max(0, Math.min(earliest - this.now(), 2_147_483_647))
        this.idleTimer = this.deps.effects.setTimeout(() => {
          this.idleTimer = null
          void this.reconcile().catch((error: unknown) => {
            this.log.warn('mcp-test-idle-reconcile-failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }, delay)
        this.idleTimer.unref?.()
      })
      .catch((error: unknown) => {
        this.log.warn('mcp-test-idle-timer-schedule-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }
}
