// RFC-238 — persistent multi-turn MCP runtime playground.
//
// HTTP requests only perform short state-machine transactions. Accepted turns
// are executed by the daemon-scoped coordinator below; Dialog visibility has no
// bearing on process or session lifetime.

import { Buffer } from 'node:buffer'
import { existsSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { loadConfig } from '@/config'
import type {
  McpRuntimeTestPersistence,
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
} from '@/modules/resource-catalog/application/mcps/runtimeTestPersistence'
import { getRuntimeDriver, tryGetRuntimeDriver } from '@/services/runtime'
import type { AgentSpawnContext, AgentSpawnPlan } from '@/services/runtime/types'
import type { RuntimeDriver } from '@/services/runtime/types'
import type { SpawnPlan } from '@/services/runtime/types'
import type { RuntimeRow } from '@/services/runtimeRegistry'
import {
  emptySystemAgentOutputEvidence,
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  killStaleRunProcessTree as productionKillStaleRunProcessTree,
  type StaleRunKillOutcome,
} from '@/util/process'
import type { StartupVerificationResult } from '@agent-workflow/shared'
import {
  observationForVerification,
  type StartupObservation,
  verifyStartup,
} from '@/services/execution/startupVerification'
import {
  claimNewMcpRuntimeTestSessionLease,
  preclaimMcpRuntimeTestSessionLease,
  releaseMcpRuntimeTestSessionLease,
  repairMcpRuntimeTestSessionLeaseAfterReap,
  rotateMcpRuntimeTestSessionLease,
  type McpRuntimeTestLeaseOperations,
  type McpRuntimeTestLeaseToken,
} from '@/services/mcpRuntimeTestLease'
import { MCP_RUNTIME_TESTS_CHANNEL, mcpRuntimeTestsBroadcaster } from '@/ws/broadcaster'
import { sha256Hex } from '@/util/hash'
import { defaultConfigDirProfile } from '@/services/runtimeRegistry'

export const MCP_RUNTIME_TEST_IDLE_MS = 10 * 60_000
export const MCP_RUNTIME_TEST_TURN_TIMEOUT_MS = 10 * 60_000
export const MCP_RUNTIME_TEST_RECEIPT_MS = 24 * 60 * 60_000
export const MCP_RUNTIME_TEST_MAX_TURNS = 32
export const MCP_RUNTIME_TEST_MESSAGE_BYTES = 64 * 1024
export const MCP_RUNTIME_TEST_EVENT_ROWS = 20_000
export const MCP_RUNTIME_TEST_EVENT_BYTES = 16 * 1024 * 1024
export const MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES = 1024 * 1024

const AGENT_NAME = 'aw-mcp-runtime-test'
const SYSTEM_PROMPT =
  'You are testing exactly one Model Context Protocol server. Use only the MCP tools made available to you. Explain observed capabilities and errors clearly. Before an obviously state-changing tool call that the user did not explicitly request, explain the risk and ask for confirmation. Never ask for filesystem, shell, web, subagent, skill, or other MCP access.'
const STDERR_TAIL_BYTES = 256 * 1024
const DEFAULT_CAPACITY = 2

type SessionRow = McpRuntimeTestSessionRecord
type TurnRow = McpRuntimeTestTurnRecord

export interface McpRuntimeTestDependencies {
  persistence: McpRuntimeTestPersistence
  leaseOperations: McpRuntimeTestLeaseOperations
  /**
   * Reload the selected MCP immediately before a queued turn starts. The
   * bootstrap owns identity admission and catalog composition; this daemon
   * worker receives only the closed async query and never forges a synchronous
   * system authority.
   */
  loadMcp: (mcpId: string) => Promise<Mcp | null>
  loadRuntime: (name: string) => Promise<RuntimeRow | null>
  configPath: string
  appHome: string
  runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  now?: () => number
  capacity?: number
  killStaleRunProcessTree?: (
    run: { pid: number | null; startedAt: number | null; spawnBinaryPath?: string | null },
    opts?: { now?: number; termWaitMs?: number },
  ) => Promise<StaleRunKillOutcome>
}

const SERVICE_INSTANCES = new WeakMap<object, McpRuntimeTestService>()

export function getMcpRuntimeTestService(deps: McpRuntimeTestDependencies): McpRuntimeTestService {
  const key = deps.persistence.identity
  const existing = SERVICE_INSTANCES.get(key)
  if (existing !== undefined) return existing
  const created = new McpRuntimeTestService(deps)
  SERVICE_INSTANCES.set(key, created)
  return created
}

interface ResolvedTestRuntime {
  row: RuntimeRow
  driver: RuntimeDriver
  binary: string
  snapshotJson: string
}

export function isRuntimeMcpTestEligible(row: Pick<RuntimeRow, 'protocol' | 'model'>): boolean {
  // RFC-280 T6: playground support = the driver implements the session
  // strategy (the spawn itself is the ordinary system-agent surface now).
  // RFC-282 实现门 P2-1 — this rides the /api/runtimes LIST (display path):
  // a dirty protocol on one row must read as "not eligible", not 500 the page.
  return tryGetRuntimeDriver(row.protocol)?.mcpTestSessionReference !== undefined
}

interface QueueItem {
  sessionId: string
  turnId: string
}

interface EventSinkOwner {
  sessionId: string
  turnId: string
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

function sha256(value: string | Uint8Array): string {
  return sha256Hex(value)
}

function requestDigest(input: {
  expectedMcpConfigHash: string
  runtimeName: string | null
  message: string
  clientMessageId: string
}): string {
  return sha256(
    stableJson({
      expectedMcpConfigHash: input.expectedMcpConfigHash,
      runtimeName: input.runtimeName,
      messageDigest: sha256(input.message),
      clientMessageId: input.clientMessageId,
    }),
  )
}

function ensureMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new ValidationError('mcp-test-message-empty', 'message must not be empty')
  }
  if (Buffer.byteLength(message, 'utf8') > MCP_RUNTIME_TEST_MESSAGE_BYTES) {
    throw new ValidationError(
      'mcp-test-message-too-large',
      `message must not exceed ${MCP_RUNTIME_TEST_MESSAGE_BYTES} UTF-8 bytes`,
    )
  }
}

function canResumeNativeSession(
  session: Pick<
    SessionRow,
    'nativeSessionState' | 'runtimeSessionId' | 'continuationBlockedReason'
  >,
): boolean {
  return (
    session.nativeSessionState === 'ready' &&
    session.runtimeSessionId !== null &&
    session.continuationBlockedReason === null
  )
}

function assertSessionActor(row: SessionRow, actor: Actor, auditOnly = false): void {
  if (row.ownerUserId === actor.user.id) return
  if (auditOnly && actor.permissions.has('mcp-runtime-tests:audit')) return
  throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
}

function resultTurnStatus(
  result: SystemAgentRunResult,
  cancelRequested: boolean,
  sessionEnding: boolean,
  durableFailureCode: string | null,
): TurnRow['status'] {
  if (durableFailureCode === 'mcp-test-turn-timeout' || result.status === 'timeout') {
    return 'timed_out'
  }
  if (durableFailureCode === 'mcp-test-daemon-shutdown') return 'interrupted'
  if (cancelRequested) return sessionEnding ? 'interrupted' : 'canceled'
  if (result.status === 'ok') return 'succeeded'
  if (result.status === 'aborted') return 'interrupted'
  return 'failed'
}

/**
 * RFC-280 T6 — the playground's strict verdict (design-gate P1-4). Applied
 * ONLY to an otherwise-succeeded turn: durable failures (timeout / daemon
 * shutdown / cancel / spawn) keep their codes and are never overwritten.
 * "Could not observe" fails closed — the playground's whole purpose is
 * verifying the MCP, so running blind must never read as success.
 */
export function applyPlaygroundVerification(
  turnStatus: TurnRow['status'],
  failureCode: string | null,
  verification: StartupVerificationResult | undefined,
): { turnStatus: TurnRow['status']; failureCode: string | null } {
  if (turnStatus !== 'succeeded' || verification === undefined) {
    return { turnStatus, failureCode }
  }
  if (verification.observation !== 'verified') {
    return { turnStatus: 'failed', failureCode: 'mcp-test-verification-unavailable' }
  }
  if (verification.mcpUnusable.length > 0) {
    return { turnStatus: 'failed', failureCode: 'mcp-test-mcp-unusable' }
  }
  return { turnStatus, failureCode }
}

function resultFailureCode(
  result: SystemAgentRunResult,
  durableFailureCode: string | null,
): string | null {
  if (
    durableFailureCode === 'mcp-test-turn-timeout' ||
    durableFailureCode === 'mcp-test-daemon-shutdown'
  ) {
    return durableFailureCode
  }
  if (result.nativeSessionIntegrityFailed === true) return 'mcp-test-session-conflict'
  if (result.status === 'ok') return null
  return `mcp-test-${result.status}`
}

export class McpRuntimeTestEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private resetPendingFrom: string | undefined
  private terminalIntent:
    | { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason }
    | undefined

  constructor(
    private readonly persistence: McpRuntimeTestPersistence,
    private readonly owner: EventSinkOwner,
    private readonly notify?: () => void,
    private readonly claimNativeSession?: (
      sessionId: string,
      previousSessionId?: string,
    ) => Promise<void>,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(async () => {
      if (this.stopped) return
      const result = await this.persistence.appendEvent({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        ts: event.ts,
        kind: event.kind,
        payload: event.payload,
        runtimeSessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        source: event.source,
        externalEventKey:
          event.externalEventId === undefined
            ? null
            : sha256(
                stableJson({
                  runtimeSessionId: event.sessionId,
                  externalEventId: event.externalEventId,
                }),
              ),
        payloadBytes: Buffer.byteLength(event.payload, 'utf8'),
        maxSingleEventBytes: MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
        maxSessionRows: MCP_RUNTIME_TEST_EVENT_ROWS,
        maxSessionBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
      })
      if (result === 'stopped' || result === 'truncated') this.stopped = true
      this.notify?.()
    })
  }

  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const before = await this.persistence.loadRuntimeSessionId(this.owner.sessionId)
      if (before === undefined) {
        throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
      }
      if (previousSessionId !== undefined) {
        if (before !== previousSessionId) {
          throw new ConflictError(
            'mcp-test-runtime-session-changed',
            'runtime conversation reset did not match the persisted native session',
          )
        }
        await this.claimNativeSession?.(sessionId, previousSessionId)
      } else if (before === null) {
        await this.claimNativeSession?.(sessionId)
      }
      // The production lease participant rotates the lease key, durable
      // session pointer and root-event identities atomically. Once it returns,
      // persistence must observe the new id rather than attempting the old-id
      // CAS a second time. A standalone sink without a lease participant keeps
      // the legacy persistence-owned rotation path for focused fixtures.
      const persistencePreviousSessionId =
        previousSessionId !== undefined && this.claimNativeSession === undefined
          ? previousSessionId
          : undefined
      const result = await this.persistence.setRootSession({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        runtimeSessionId: sessionId,
        ...(persistencePreviousSessionId === undefined
          ? {}
          : { previousRuntimeSessionId: persistencePreviousSessionId }),
      })
      if (previousSessionId !== undefined) {
        if (this.resetPendingFrom === previousSessionId) this.resetPendingFrom = undefined
        this.stopped = !result.captureLive
      }
      this.notify?.()
    })
  }

  markRootSessionResetPending(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const result = await this.persistence.markRootSessionResetPending({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        runtimeSessionId: sessionId,
      })
      if (result.captureLive) this.resetPendingFrom = sessionId
      this.notify?.()
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    const terminal = this.rememberTerminal(
      this.resetPendingFrom === undefined ? state : 'incomplete',
      this.resetPendingFrom === undefined ? reason : 'stream-persist-failed',
    )
    return this.enqueue(async () => {
      const finalState =
        terminal.state === 'truncated'
          ? 'truncated'
          : terminal.state === 'incomplete'
            ? 'incomplete'
            : 'complete'
      await this.persistence.markCaptureTerminal({
        sessionId: this.owner.sessionId,
        turnId: this.owner.turnId,
        state: finalState,
        reason: finalState === 'incomplete' ? (terminal.reason ?? null) : null,
      })
      this.stopped = true
      this.notify?.()
    })
  }

  private rememberTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason } {
    const rank = (value: SessionCaptureTerminalState): number =>
      value === 'incomplete' ? 2 : value === 'truncated' ? 1 : 0
    if (this.terminalIntent === undefined || rank(state) > rank(this.terminalIntent.state)) {
      this.terminalIntent = {
        state,
        ...(state === 'incomplete' && reason !== undefined ? { reason } : {}),
      }
    }
    return this.terminalIntent
  }

  private enqueue(work: () => void | Promise<void>): Promise<void> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => {})
    return next
  }
}

export class McpRuntimeTestService {
  private readonly runFn
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
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private startPromise: Promise<void> | null = null
  private accepting = true
  private paused = false
  private shuttingDown = false

  constructor(private readonly deps: McpRuntimeTestDependencies) {
    this.runFn = deps.runFn ?? runSystemAgent
    this.now = deps.now ?? Date.now
    this.capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY)
    this.killStaleRunProcessTree = deps.killStaleRunProcessTree ?? productionKillStaleRunProcessTree
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    const attempt = (async () => {
      await this.bootRecover()
      await this.reconcileCore()
      this.installReconcileTimer()
    })()
    this.startPromise = attempt.catch((error: unknown) => {
      this.startPromise = null
      throw error
    })
    return this.startPromise
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
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.log.warn('mcp-test-periodic-reconcile-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, 60_000)
    this.reconcileTimer.unref?.()
  }

  private clearBackgroundTimers(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
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
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolvePromise) => {
          // RFC-254: deadline an await depends on — must stay ref'd (unref'd
          // timers never fire on Windows Bun once the loop is otherwise idle;
          // see rfc254-no-unref-deadline-guard.test.ts). Cleared just below.
          timer = setTimeout(resolvePromise, Math.max(0, budgetMs))
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
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
    actor: Actor,
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
    actor: Actor,
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
    const scratchRoot = join(this.deps.appHome, 'mcp-runtime-tests', sessionId)
    const runtimeSessionId = runtime.driver.createMcpTestNativeSessionId?.() ?? null

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
    actor: Actor,
    mcp: Mcp,
    sessionId: string,
    input: McpRuntimeTestMessageRequest,
  ): Promise<McpRuntimeTestMessageReceipt> {
    await this.start()
    this.assertAccepting()
    ensureMessage(input.message)
    const session = await this.requireSession(sessionId, mcp.id)
    assertSessionActor(session, actor)
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
    actor: Actor,
    mcpId: string,
    sessionId: string,
    input: McpRuntimeTestCancelRequest,
  ): Promise<McpRuntimeTestMutationReceipt> {
    await this.start()
    const initial = await this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, actor)
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
    actor: Actor,
    mcpId: string,
    sessionId: string,
  ): Promise<McpRuntimeTestMutationReceipt> {
    await this.start()
    const initial = await this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, actor)
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

  async latest(actor: Actor, mcpId: string): Promise<McpRuntimeTestSessionDto | null> {
    await this.start()
    await this.reconcile()
    const row = await this.deps.persistence.findLatestSession(mcpId, actor.user.id)
    return row === null ? null : this.project(row)
  }

  async get(actor: Actor, mcpId: string, sessionId: string): Promise<McpRuntimeTestSessionDto> {
    await this.start()
    await this.reconcile()
    const row = await this.requireSession(sessionId, mcpId)
    assertSessionActor(row, actor, true)
    return this.project(row)
  }

  async sessionView(actor: Actor, mcpId: string, sessionId: string): Promise<SessionViewResponse> {
    await this.start()
    const session = await this.requireSession(sessionId, mcpId)
    assertSessionActor(session, actor, true)
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
      await repairMcpRuntimeTestSessionLeaseAfterReap(
        this.deps.leaseOperations,
        session.id,
        turn.id,
        true,
      )
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
      const capability = getRuntimeDriver(session.runtimeProtocol).mcpTestSessionReference
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
        capability !== undefined &&
        !quarantine &&
        session.status === 'active' &&
        canResumeNativeSession(session) &&
        captureComplete &&
        existsSync(session.scratchRoot)
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
        await repairMcpRuntimeTestSessionLeaseAfterReap(
          this.deps.leaseOperations,
          session.id,
          turn.id,
          true,
        )
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
    const { mcpOperationConfigHashOf } = await import('@/services/mcpOperationRevision')
    return mcpOperationConfigHashOf(mcp)
  }

  private async resolveRuntime(name: string | null): Promise<ResolvedTestRuntime> {
    const config = loadConfig(this.deps.configPath)
    const selected = name ?? config.defaultRuntime ?? 'opencode'
    const row = await this.deps.loadRuntime(selected)
    if (row === null) {
      throw new ValidationError(
        'mcp-test-runtime-not-found',
        `runtime '${selected}' is not registered`,
      )
    }
    if (!row.enabled) {
      throw new ValidationError('mcp-test-runtime-disabled', `runtime '${selected}' is disabled`)
    }
    const driver = getRuntimeDriver(row.protocol)
    if (driver.mcpTestSessionReference === undefined || !isRuntimeMcpTestEligible(row)) {
      throw new ValidationError(
        'mcp-test-runtime-unsupported',
        `runtime '${selected}' does not support mcp-test-v1`,
      )
    }
    const binary = row.binaryPath ?? driver.defaultBinary(config)[0]
    if (binary === undefined || binary === '') {
      throw new ValidationError(
        'mcp-test-runtime-unsupported',
        `runtime '${selected}' has no executable`,
      )
    }
    const snapshot = {
      runtimeRowId: row.id,
      name: row.name,
      protocol: row.protocol,
      resolvedBinaryPath: binary,
      model: row.model,
      variant: row.variant,
      temperature: row.temperature,
      steps: row.steps,
      maxSteps: row.maxSteps,
      isSandbox: row.isSandbox,
      configDirEnv: row.configDirEnv,
      configDirName: row.configDirName,
      probeFence: row.probeFence,
      mcpTestProfileCodec: 'mcp-test-v1',
    }
    const snapshotJson = stableJson(snapshot)
    return { row, driver, binary, snapshotJson }
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
    mcpRuntimeTestsBroadcaster.broadcast(
      MCP_RUNTIME_TESTS_CHANNEL,
      {
        type: 'mcp-runtime-test.updated',
        sessionId,
        sessionVersion: session.sessionVersion,
        inFlightTurnId: session.inFlightTurnId,
        turnStatus: session.turnStatus,
        eventCursor: session.eventCursor,
        captureState: session.captureState,
      },
      {
        kind: 'mcp-runtime-test-owner',
        ownerUserId: session.ownerUserId,
      },
    )
  }

  private enqueue(item: QueueItem): void {
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
        nativeLease = await rotateMcpRuntimeTestSessionLease(
          this.deps.leaseOperations,
          nativeLease,
          runtimeSessionId,
        )
        return
      }
      if (nativeLease !== undefined) {
        if (nativeLease.runtimeSessionId !== runtimeSessionId) {
          throw new Error('runtime changed native session id during one turn')
        }
        return
      }
      nativeLease = await claimNewMcpRuntimeTestSessionLease(this.deps.leaseOperations, {
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
            ? await claimNewMcpRuntimeTestSessionLease(this.deps.leaseOperations, {
                protocol: session.runtimeProtocol,
                runtimeSessionId: session.runtimeSessionId,
                testSessionId: session.id,
                turnId: turn.id,
                leaseNonceDigest,
              })
            : await preclaimMcpRuntimeTestSessionLease(this.deps.leaseOperations, {
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
    let result: SystemAgentRunResult
    try {
      const assertSpawnAllowed = async (): Promise<void> => {
        const allowed = await this.deps.persistence.isSpawnAllowed({
          sessionId: session.id,
          turnId: turn.id,
          now: this.now(),
        })
        if (!allowed) throw new Error('mcp-test-spawn-no-longer-admitted')
      }
      result = await this.runFn({
        feature: 'mcp-runtime-test',
        agentName: AGENT_NAME,
        systemPrompt: SYSTEM_PROMPT,
        prompt: turn.promptText,
        protocol: session.runtimeProtocol,
        runtimeBinary: runtime.binary,
        model: runtime.row.model,
        scratchParent: join(this.deps.appHome, 'mcp-runtime-tests'),
        scratchName: session.id,
        timeoutMs,
        maxEventTextBytes: MCP_RUNTIME_TEST_EVENT_BYTES,
        maxRawFrameBytes: 2 * 1024 * 1024,
        abortSignal: controller.signal,
        eventSink: sink,
        nativeIdentityAuthoritative: true,
        retainScratchOnSuccess: true,
        // RFC-282 B1b (§2.1b) — the old `buildPlan` escape hatch could return an
        // arbitrary plan, making the declared manifest a SECOND computation at
        // settle. Narrowed: buildCtx customizes the assembly INPUT (admission
        // gate runs before assembling), wrapPlan only WRAPS cleanup/beforeSpawn,
        // and the declared manifest rides the run result (§2.1b-2).
        ...(this.deps.runFn !== undefined
          ? {
              // In-process fake runs (fixture runFn): no real assembly.
              testPlanOverride: (): SpawnPlan => {
                return {
                  cmd: [runtime.binary],
                  env: {},
                  stdin: { mode: 'ignore' },
                  beforeSpawn: assertSpawnAllowed,
                }
              },
            }
          : {
              buildCtx: ({
                worktreePath,
                runDir,
              }: {
                worktreePath: string
                runDir: string
              }): AgentSpawnContext => {
                const turnRunRoot = join(runDir, 'turns', turn.id)
                // RFC-284 T13（审计 N4）：手写二元 cast 会绕开 shared 的
                // RuntimeKind 完备性设计（新增第三 kind 编译照过、运行时
                // TypeError）——改走 runtimeRegistry 的穷尽访问器。
                const protocolDefaults = defaultConfigDirProfile(session.runtimeProtocol)
                // RFC-280 T6 — the playground rides the unified injection layer;
                // the RFC-029 inventory plugin is FORCED on runtimes that observe
                // via file (P1-4 — a strict consumer must never run blind).
                return {
                  injection: { mcps: [mcp] },
                  prompt: turn.promptText,
                  agentName: AGENT_NAME,
                  systemPrompt: SYSTEM_PROMPT,
                  resolvedParamsByAgent: new Map([
                    [
                      AGENT_NAME,
                      {
                        model: runtime.row.model ?? null,
                        variant: runtime.row.variant ?? null,
                        temperature: runtime.row.temperature ?? null,
                        steps: runtime.row.steps ?? null,
                        maxSteps: runtime.row.maxSteps ?? null,
                        isSandbox: runtime.row.isSandbox === true,
                      },
                    ],
                  ]),
                  cwd: worktreePath,
                  runRoot: turnRunRoot,
                  configDir: {
                    env: runtime.row.configDirEnv ?? protocolDefaults.env,
                    name: runtime.row.configDirName ?? protocolDefaults.name,
                  },
                  runtimeBinary: runtime.binary,
                  // RFC-297 T13：测试台每一轮都是**新 spawn 的 agent 运行**，
                  // 如实陈述即可；「据此要不要物化 dump 插件」是 driver 的知识
                  // （此前这里写的是 `startupObservation === 'inventory-file'`,
                  // 等于把某个运行时的实现细节搬进了调用方）。
                  freshAgentRun: true,
                  ...runtime.driver.mcpTestSessionReference?.({
                    turnSeq: turn.seq,
                    nativeSessionId: session.runtimeSessionId,
                  }),
                  nodeRunId: turn.id,
                  log: this.log,
                }
              },
              // §2.1b（实现门 P2-2）— wrap-only: return just the two slots;
              // the plan itself never passes through adapter hands.
              wrapPlan: (basePlan: AgentSpawnPlan, { runDir }: { runDir: string }) => ({
                // P1-7: secret material must not outlive the turn — the claude
                // mcp-config.json goes here; inventory.json is kept for the
                // post-run observation read (the session scratch owns the dir).
                cleanup: async () => {
                  await basePlan.cleanup?.()
                  await rm(join(runDir, 'turns', turn.id, 'mcp-config.json'), { force: true })
                },
                beforeSpawn: async () => {
                  await basePlan.beforeSpawn?.()
                  await assertSpawnAllowed()
                },
              }),
            }),
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
      result = {
        status: controller.signal.aborted ? 'aborted' : 'spawn-failed',
        exitCode: null,
        eventText: '',
        stderrTail: 'runtime test attempt failed before completion',
        durationMs: Math.max(0, this.now() - now),
        scratchDir: session.scratchRoot,
        scratchRetained: true,
        outputEvidence: emptySystemAgentOutputEvidence(),
      }
    }
    await sink.markTerminal('complete')
    // RFC-280 T6 — strict playground semantics (design-gate P1-4): only a run
    // whose PROCESS finished ok is judged by the verification layer; durable
    // failures (timeout / shutdown / cancel) keep their codes.
    // RFC-282 B1b (§2.1b-2) — the declared manifest rides the run result from
    // the SAME assembly that spawned the turn; the old re-render here was the
    // last "two computations" seam the unification exists to close.
    let verification: StartupVerificationResult | undefined
    if (result.status === 'ok' && this.deps.runFn === undefined) {
      const driver = getRuntimeDriver(session.runtimeProtocol)
      const turnRunRootForRead = join(session.scratchRoot, 'run', 'turns', turn.id)
      // RFC-282 C2 — observation source from the driver's static declaration
      // (the presence-proxy sent a third runtime down the claude branch).
      // RFC-297 T12：判据收进 execution 层单点，测试台与 runner 共用同一份
      // （此前两处各写一遍同样的 switch）。取数时机仍归调用方（它持有 runRoot），
      // 判据归被调方——收口后这里只剩一次赋值，故 const。
      const observation: StartupObservation = await observationForVerification(
        driver.capabilities,
        {
          claudeInit: result.startupInventory ?? null,
          // 惰性：只有以文件为观测源的运行时才会真的去读（判据在被调方）。
          loadSnapshot: async () =>
            (await driver
              .readInventory?.({ runRoot: turnRunRootForRead, nodeKind: 'agent-single' })
              .catch(() => null)) ?? null,
        },
      )
      if (result.declared === undefined) {
        throw new Error('mcp-test declared manifest missing from run result (assembly seam broken)')
      }
      verification = verifyStartup(result.declared, observation)
    }
    if (nativeLease !== undefined && result.status !== 'unreaped') {
      const released = await releaseMcpRuntimeTestSessionLease(
        this.deps.leaseOperations,
        nativeLease,
      )
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
    result: SystemAgentRunResult,
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
    const alreadyQuarantined = row.cleanupState === 'quarantined'

    const base = resolve(join(this.deps.appHome, 'mcp-runtime-tests'))
    const target = resolve(row.scratchRoot)
    const safe = dirname(target) === base && target !== base
    let cleanupState: SessionRow['cleanupState'] = alreadyQuarantined ? 'quarantined' : 'complete'
    let cleanupErrorCode: string | null = alreadyQuarantined ? row.cleanupErrorCode : null
    if (alreadyQuarantined) {
      // A known or possibly-live child may still own the directory. Retain it
      // and block replacement/deletion until explicit recovery proves reaping.
    } else if (!safe) {
      cleanupState = 'quarantined'
      cleanupErrorCode = 'mcp-test-cleanup-path-unsafe'
    } else {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {
        cleanupState = 'pending'
        cleanupErrorCode = 'mcp-test-cleanup-failed'
      }
    }
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
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.shuttingDown || this.paused) return
    void this.deps.persistence.nextDeadline().then((earliest) => {
      if (earliest === null || this.shuttingDown || this.paused) return
      const delay = Math.max(0, Math.min(earliest - this.now(), 2_147_483_647))
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null
        void this.reconcile()
      }, delay)
      this.idleTimer.unref?.()
    })
  }
}
