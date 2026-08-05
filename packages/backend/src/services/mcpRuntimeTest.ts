// RFC-238 — persistent multi-turn MCP runtime playground.
//
// HTTP requests only perform short state-machine transactions. Accepted turns
// are executed by the daemon-scoped coordinator below; Dialog visibility has no
// bearing on process or session lifetime.

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
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
import type { DbClient } from '@/db/client'
import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  opencodeMcpTestSessionOwners,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { getRuntimeDriver } from '@/services/runtime'
import type {
  McpTestSpawnPlan,
  RuntimeMcpTestCapabilityV1,
  SpawnPlan,
} from '@/services/runtime/types'
import { getRuntime, type RuntimeRow } from '@/services/runtimeRegistry'
import type { ContainmentCoordinator } from '@/services/sandbox'
import {
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import type {
  SessionCaptureIncompleteReason,
  SessionCaptureTerminalState,
  SystemAgentEventSinkV1,
} from '@/services/sessionEventSink'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  killStaleRunProcessTree as productionKillStaleRunProcessTree,
  type StaleRunKillOutcome,
} from '@/util/process'
import { prepareMcpTestExecutionMaterial } from '@/services/runtime/mcpTestExecutionMaterial'
import { opencodeMcpTestSessionStore } from '@/services/runtime/opencode/verifiedMcpTestPlan'
import {
  ControlMarkerTracker,
  writeControlAckExclusive,
} from '@/services/runtime/opencode/controlProtocol'
import { removeHermeticOpencodeLayout } from '@/services/runtime/opencode/hermetic'
import {
  inspectAbandonedOpencodeStoreLock,
  removeAbandonedOpencodeStoreLock,
} from '@/services/runtime/opencode/storeHygiene'
import {
  claimNewMcpRuntimeTestSession,
  confirmMcpRuntimeTestResume,
  getMcpRuntimeTestOwner,
  preclaimMcpRuntimeTestResume,
  releaseMcpRuntimeTestLease,
  type McpRuntimeTestLeaseToken,
} from '@/services/mcpRuntimeTestOwner'
import { MCP_RUNTIME_TESTS_CHANNEL, mcpRuntimeTestsBroadcaster } from '@/ws/broadcaster'

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

type SessionRow = typeof mcpRuntimeTestSessions.$inferSelect
type TurnRow = typeof mcpRuntimeTestTurns.$inferSelect

export interface McpRuntimeTestDependencies {
  db: DbClient
  configPath: string
  appHome: string
  containmentCoordinator?: ContainmentCoordinator
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
  const key = deps.db as object
  const existing = SERVICE_INSTANCES.get(key)
  if (existing !== undefined) return existing
  const created = new McpRuntimeTestService(deps)
  SERVICE_INSTANCES.set(key, created)
  return created
}

interface ResolvedTestRuntime {
  row: RuntimeRow
  capability: RuntimeMcpTestCapabilityV1
  binary: string
  snapshotJson: string
  fingerprint: string
}

export function isRuntimeMcpTestEligible(row: Pick<RuntimeRow, 'protocol' | 'model'>): boolean {
  const capability = getRuntimeDriver(row.protocol).mcpTest
  if (capability === undefined) return false
  if (capability.sessionOwnerReceipt === null) return true
  const model = row.model
  if (typeof model !== 'string' || model.includes('\0')) return false
  const slash = model.indexOf('/')
  return slash > 0 && slash < model.length - 1
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
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
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

function isTerminalTurn(status: TurnRow['status']): boolean {
  return !['queued', 'running'].includes(status)
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
  if (auditOnly && actor.user.role === 'admin') return
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
  if (result.failureCode !== undefined) return result.failureCode
  if (result.status === 'ok') return null
  return `mcp-test-${result.status}`
}

export class McpRuntimeTestEventSink implements SystemAgentEventSinkV1 {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private terminalIntent:
    | { state: SessionCaptureTerminalState; reason?: SessionCaptureIncompleteReason }
    | undefined

  constructor(
    private readonly db: DbClient,
    private readonly owner: EventSinkOwner,
    private readonly notify?: () => void,
  ) {}

  append(event: Parameters<SystemAgentEventSinkV1['append']>[0]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.enqueue(() => {
      if (this.stopped) return
      dbTxSync(this.db, (tx) => {
        const turn = tx
          .select({
            captureState: mcpRuntimeTestTurns.captureState,
            lastEventSeq: mcpRuntimeTestTurns.captureLastEventSeq,
            eventBytes: mcpRuntimeTestTurns.captureEventBytes,
            firstEventSeq: mcpRuntimeTestTurns.captureFirstEventSeq,
          })
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.id, this.owner.turnId),
              eq(mcpRuntimeTestTurns.sessionId, this.owner.sessionId),
            ),
          )
          .get()
        if (turn === undefined) {
          throw new NotFoundError('mcp-test-turn-not-found', 'MCP test turn not found')
        }
        if (turn.captureState !== 'live') {
          this.stopped = true
          return
        }

        const externalEventKey =
          event.externalEventId === undefined
            ? null
            : sha256(
                stableJson({
                  runtimeSessionId: event.sessionId,
                  externalEventId: event.externalEventId,
                }),
              )
        if (externalEventKey !== null) {
          const duplicate = tx
            .select({ id: mcpRuntimeTestEvents.id })
            .from(mcpRuntimeTestEvents)
            .where(
              and(
                eq(mcpRuntimeTestEvents.testSessionId, this.owner.sessionId),
                eq(mcpRuntimeTestEvents.externalEventKey, externalEventKey),
              ),
            )
            .get()
          if (duplicate !== undefined) return
        }

        const payloadBytes = Buffer.byteLength(event.payload, 'utf8')
        const sessionEventCount =
          tx
            .select({ count: sql<number>`count(*)` })
            .from(mcpRuntimeTestEvents)
            .where(eq(mcpRuntimeTestEvents.testSessionId, this.owner.sessionId))
            .get()?.count ?? 0
        const sessionBytes =
          tx
            .select({
              bytes: sql<number>`coalesce(sum(${mcpRuntimeTestTurns.captureEventBytes}), 0)`,
            })
            .from(mcpRuntimeTestTurns)
            .where(eq(mcpRuntimeTestTurns.sessionId, this.owner.sessionId))
            .get()?.bytes ?? 0
        if (
          payloadBytes > MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES ||
          sessionEventCount >= MCP_RUNTIME_TEST_EVENT_ROWS ||
          sessionBytes + payloadBytes > MCP_RUNTIME_TEST_EVENT_BYTES
        ) {
          tx.update(mcpRuntimeTestTurns)
            .set({ captureState: 'truncated', captureIncompleteReason: null })
            .where(eq(mcpRuntimeTestTurns.id, this.owner.turnId))
            .run()
          tx.update(mcpRuntimeTestSessions)
            .set({ continuationBlockedReason: 'capture-truncated' })
            .where(eq(mcpRuntimeTestSessions.id, this.owner.sessionId))
            .run()
          this.stopped = true
          return
        }

        const lastSessionEvent = tx
          .select({ seq: mcpRuntimeTestEvents.eventSeq })
          .from(mcpRuntimeTestEvents)
          .where(eq(mcpRuntimeTestEvents.testSessionId, this.owner.sessionId))
          .orderBy(desc(mcpRuntimeTestEvents.eventSeq))
          .limit(1)
          .get()
        const eventSeq = (lastSessionEvent?.seq ?? 0) + 1
        tx.insert(mcpRuntimeTestEvents)
          .values({
            testSessionId: this.owner.sessionId,
            firstSeenTurnId: this.owner.turnId,
            eventSeq,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
            sessionId: event.sessionId,
            parentSessionId: event.parentSessionId,
            source: event.source,
            externalEventKey,
          })
          .run()
        tx.update(mcpRuntimeTestTurns)
          .set({
            captureFirstEventSeq: turn.firstEventSeq ?? eventSeq,
            captureLastEventSeq: eventSeq,
            captureEventBytes: turn.eventBytes + payloadBytes,
          })
          .where(eq(mcpRuntimeTestTurns.id, this.owner.turnId))
          .run()
      })
      this.notify?.()
    })
  }

  setRootSessionId(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      dbTxSync(this.db, (tx) => {
        const row = tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, this.owner.sessionId))
          .get()
        if (row === undefined) {
          throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
        }
        if (row.runtimeSessionId !== null && row.runtimeSessionId !== sessionId) {
          tx.update(mcpRuntimeTestSessions)
            .set({
              nativeSessionState: 'unusable',
              continuationBlockedReason: 'session-root-mismatch',
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
          throw new ConflictError(
            'mcp-test-session-root-mismatch',
            'runtime returned a different native session id',
          )
        }
        if (row.runtimeSessionId === null) {
          tx.update(mcpRuntimeTestSessions)
            .set({ runtimeSessionId: sessionId })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
      })
      this.notify?.()
    })
  }

  markTerminal(
    state: SessionCaptureTerminalState,
    reason?: SessionCaptureIncompleteReason,
  ): Promise<void> {
    const terminal = this.rememberTerminal(state, reason)
    return this.enqueue(() => {
      const finalState =
        terminal.state === 'truncated'
          ? 'truncated'
          : terminal.state === 'incomplete'
            ? 'incomplete'
            : 'complete'
      dbTxSync(this.db, (tx) => {
        const turn = tx
          .select({ captureState: mcpRuntimeTestTurns.captureState })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, this.owner.turnId))
          .get()
        if (turn === undefined) return
        if (turn.captureState === 'incomplete') return
        if (turn.captureState === 'truncated' && finalState !== 'incomplete') return
        tx.update(mcpRuntimeTestTurns)
          .set({
            captureState: finalState,
            captureIncompleteReason: finalState === 'incomplete' ? (terminal.reason ?? null) : null,
          })
          .where(eq(mcpRuntimeTestTurns.id, this.owner.turnId))
          .run()
        if (finalState !== 'complete') {
          tx.update(mcpRuntimeTestSessions)
            .set({
              continuationBlockedReason:
                finalState === 'truncated' ? 'capture-truncated' : 'capture-incomplete',
            })
            .where(eq(mcpRuntimeTestSessions.id, this.owner.sessionId))
            .run()
        }
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

  private enqueue(work: () => void): Promise<void> {
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
      if (!this.shuttingDown && this.reconcileTimer === null) {
        this.reconcileTimer = setInterval(() => {
          void this.reconcile().catch((error: unknown) => {
            this.log.warn('mcp-test-periodic-reconcile-failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }, 60_000)
        this.reconcileTimer.unref?.()
      }
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
    this.accepting = false
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer)
    this.idleTimer = null
    this.reconcileTimer = null

    const now = this.now()
    const affected = dbTxSync(this.deps.db, (tx) => {
      const sessions = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
        .all()
      const rows: Array<{ sessionId: string; turnId: string | null }> = []
      for (const session of sessions) {
        if (session.inFlightTurnId === null) continue
        const turn = tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId))
          .get()
        if (turn?.status === 'queued') {
          const timedOut = turn.hardDeadlineAt <= now
          tx.update(mcpRuntimeTestTurns)
            .set({
              status: timedOut ? 'timed_out' : 'interrupted',
              cancelRequestedAt: timedOut ? turn.cancelRequestedAt : now,
              captureState: 'complete',
              captureIncompleteReason: null,
              failureCode: timedOut ? 'mcp-test-turn-timeout' : 'mcp-test-daemon-shutdown',
              finishedAt: now,
              durationMs: Math.max(0, now - turn.createdAt),
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          const resumable = session.status === 'active' && canResumeNativeSession(session)
          tx.update(mcpRuntimeTestSessions)
            .set(
              resumable
                ? {
                    inFlightTurnId: null,
                    idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
                    sessionVersion: session.sessionVersion + 1,
                    updatedAt: now,
                  }
                : {
                    status: 'ending',
                    endReason: session.endReason ?? 'session-unusable',
                    inFlightTurnId: null,
                    idleDeadlineAt: null,
                    sessionVersion: session.sessionVersion + 1,
                    updatedAt: now,
                    ...(session.status === 'active'
                      ? {
                          nativeSessionState: 'unusable' as const,
                          continuationBlockedReason:
                            session.continuationBlockedReason ?? 'session-store-missing',
                        }
                      : {}),
                  },
            )
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          rows.push({ sessionId: session.id, turnId: null })
          continue
        }
        if (turn?.status === 'running') {
          tx.update(mcpRuntimeTestTurns)
            .set({
              cancelRequestedAt: turn.cancelRequestedAt ?? now,
              failureCode:
                turn.failureCode ??
                (turn.hardDeadlineAt <= now ? 'mcp-test-turn-timeout' : 'mcp-test-daemon-shutdown'),
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          tx.update(mcpRuntimeTestSessions)
            .set({
              sessionVersion: session.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          rows.push({ sessionId: session.id, turnId: turn.id })
          continue
        }
        rows.push({ sessionId: session.id, turnId: null })
      }
      return rows
    })

    this.queue.splice(0)
    this.queued.clear()
    for (const row of affected) {
      this.broadcastSession(row.sessionId)
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

    const cleanup = this.deps.db
      .select({ id: mcpRuntimeTestSessions.id })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.status, 'ending'),
          isNull(mcpRuntimeTestSessions.inFlightTurnId),
        ),
      )
      .all()
    for (const row of cleanup) await this.finishEndingSession(row.id)
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
    const replay = this.deps.db
      .select()
      .from(mcpRuntimeTestCreateReceipts)
      .where(
        and(
          eq(mcpRuntimeTestCreateReceipts.mcpId, mcp.id),
          eq(mcpRuntimeTestCreateReceipts.ownerUserId, actor.user.id),
          eq(mcpRuntimeTestCreateReceipts.clientCreateId, input.clientCreateId),
        ),
      )
      .get()
    if (replay !== undefined) {
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
      throw new ConflictError(
        'resource-operation-stale',
        'the MCP changed; reload before testing',
        {
          expectedConfigHash: input.expectedMcpConfigHash,
          currentConfigHash: currentHash,
        },
      )
    }
    const runtime = await this.resolveRuntime(input.runtimeName)
    const now = this.now()

    const sessionId = ulid()
    const turnId = ulid()
    const scratchRoot = join(this.deps.appHome, 'mcp-runtime-tests', sessionId)
    const runtimeSessionId = runtime.capability.createNativeSessionId()
    const sessionStoreRoot =
      runtime.capability.sessionOwnerReceipt !== null
        ? opencodeMcpTestSessionStore({
            appHome: this.deps.appHome,
            sessionId,
          }).root
        : join(scratchRoot, 'session-store')

    const receipt = dbTxSync(this.deps.db, (tx) => {
      const racedReplay = tx
        .select()
        .from(mcpRuntimeTestCreateReceipts)
        .where(
          and(
            eq(mcpRuntimeTestCreateReceipts.mcpId, mcp.id),
            eq(mcpRuntimeTestCreateReceipts.ownerUserId, actor.user.id),
            eq(mcpRuntimeTestCreateReceipts.clientCreateId, input.clientCreateId),
          ),
        )
        .get()
      if (racedReplay !== undefined) {
        if (racedReplay.requestDigest !== digest) {
          throw new ConflictError(
            'mcp-test-idempotency-mismatch',
            'clientCreateId was already used with different inputs',
          )
        }
        return {
          sessionId: racedReplay.sessionId,
          acceptedTurnId: racedReplay.acceptedTurnId,
          shouldQueue: false,
        }
      }

      const live = tx
        .select({
          id: mcpRuntimeTestSessions.id,
          status: mcpRuntimeTestSessions.status,
        })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcp.id),
            eq(mcpRuntimeTestSessions.ownerUserId, actor.user.id),
            inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
          ),
        )
        .get()
      if (live !== undefined) {
        throw new ConflictError(
          'mcp-test-session-exists',
          'an MCP test session is already active',
          {
            sessionId: live.id,
            status: live.status,
          },
        )
      }
      const quarantined = tx
        .select({ id: mcpRuntimeTestSessions.id })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcp.id),
            eq(mcpRuntimeTestSessions.ownerUserId, actor.user.id),
            eq(mcpRuntimeTestSessions.cleanupState, 'quarantined'),
          ),
        )
        .get()
      if (quarantined !== undefined) {
        throw new ConflictError(
          'mcp-test-cleanup-quarantined',
          'a previous MCP test could not be safely cleaned up',
          { sessionId: quarantined.id },
        )
      }
      const replaceable = tx
        .select({ id: mcpRuntimeTestSessions.id })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcp.id),
            eq(mcpRuntimeTestSessions.ownerUserId, actor.user.id),
            eq(mcpRuntimeTestSessions.status, 'ended'),
            eq(mcpRuntimeTestSessions.cleanupState, 'complete'),
          ),
        )
        .all()
      for (const previous of replaceable) {
        tx.delete(opencodeMcpTestSessionOwners)
          .where(eq(opencodeMcpTestSessionOwners.testSessionId, previous.id))
          .run()
        tx.delete(mcpRuntimeTestSessions).where(eq(mcpRuntimeTestSessions.id, previous.id)).run()
      }

      tx.insert(mcpRuntimeTestSessions)
        .values({
          id: sessionId,
          mcpId: mcp.id,
          ownerUserId: actor.user.id,
          clientCreateId: input.clientCreateId,
          clientCreateDigest: digest,
          status: 'active',
          endReason: null,
          mcpConfigHash: currentHash,
          runtimeRowId: runtime.row.id,
          runtimeName: runtime.row.name,
          runtimeProtocol: runtime.row.protocol,
          runtimeSnapshotJson: runtime.snapshotJson,
          runtimeFingerprint: runtime.fingerprint,
          runtimeBinaryPath: runtime.binary,
          runtimeSessionId,
          nativeSessionState: 'pending',
          inFlightTurnId: turnId,
          turnSeq: 1,
          sessionVersion: 1,
          idleDeadlineAt: null,
          scratchRoot,
          sessionStoreRoot,
          sessionStoreDbPath: runtime.capability.sessionStoreDbPath(sessionStoreRoot),
          cleanupState: 'not-started',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      tx.insert(mcpRuntimeTestTurns)
        .values({
          id: turnId,
          sessionId,
          seq: 1,
          clientMessageId: input.clientMessageId,
          promptText: input.message,
          status: 'queued',
          hardDeadlineAt: now + MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
          captureState: 'live',
          createdAt: now,
        })
        .run()
      tx.insert(mcpRuntimeTestCreateReceipts)
        .values({
          mcpId: mcp.id,
          ownerUserId: actor.user.id,
          clientCreateId: input.clientCreateId,
          requestDigest: digest,
          sessionId,
          acceptedTurnId: turnId,
          createdAt: now,
          expiresAt: now + MCP_RUNTIME_TEST_RECEIPT_MS,
        })
        .run()
      return { sessionId, acceptedTurnId: turnId, shouldQueue: true }
    })
    this.broadcastSession(receipt.sessionId)
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
    const session = this.requireSession(sessionId, mcp.id)
    assertSessionActor(session, actor)
    const replay = this.deps.db
      .select()
      .from(mcpRuntimeTestTurns)
      .where(
        and(
          eq(mcpRuntimeTestTurns.sessionId, sessionId),
          eq(mcpRuntimeTestTurns.clientMessageId, input.clientMessageId),
        ),
      )
      .get()
    if (replay !== undefined) {
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
      runtime.fingerprint !== session.runtimeFingerprint
    ) {
      await this.invalidateSession(session.id, 'runtime-profile-changed')
      throw new ConflictError('mcp-test-session-stale', 'the runtime changed; start a new test')
    }

    const now = this.now()
    const turnId = ulid()
    const accepted = dbTxSync(this.deps.db, (tx) => {
      const exactReplay = tx
        .select()
        .from(mcpRuntimeTestTurns)
        .where(
          and(
            eq(mcpRuntimeTestTurns.sessionId, sessionId),
            eq(mcpRuntimeTestTurns.clientMessageId, input.clientMessageId),
          ),
        )
        .get()
      if (exactReplay !== undefined) {
        if (exactReplay.promptText !== input.message) {
          throw new ConflictError(
            'mcp-test-idempotency-mismatch',
            'clientMessageId was already used with a different message',
          )
        }
        const replaySession = tx
          .select({ version: mcpRuntimeTestSessions.sessionVersion })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, sessionId))
          .get()
        return {
          turnId: exactReplay.id,
          version: replaySession?.version ?? input.expectedSessionVersion,
          shouldQueue: false,
        }
      }
      const current = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      if (current === undefined || current.mcpId !== mcp.id) {
        throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
      }
      if (
        current.status !== 'active' ||
        current.inFlightTurnId !== null ||
        current.nativeSessionState !== 'ready' ||
        current.continuationBlockedReason !== null
      ) {
        throw new ConflictError(
          'mcp-test-session-not-ready',
          'the MCP test session cannot accept another message',
          { sessionId, status: current.status, inFlightTurnId: current.inFlightTurnId },
        )
      }
      if (current.idleDeadlineAt === null || current.idleDeadlineAt <= now) {
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: 'idle-timeout',
            idleDeadlineAt: null,
            sessionVersion: current.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, sessionId))
          .run()
        return { turnId: null, version: current.sessionVersion + 1, shouldQueue: false }
      }
      if (current.sessionVersion !== input.expectedSessionVersion) {
        throw new ConflictError(
          'mcp-test-session-version-stale',
          'the MCP test session changed; reload before sending',
          { currentSessionVersion: current.sessionVersion },
        )
      }
      if (current.turnSeq >= MCP_RUNTIME_TEST_MAX_TURNS) {
        throw new ConflictError(
          'mcp-test-turn-limit',
          `an MCP test session supports at most ${MCP_RUNTIME_TEST_MAX_TURNS} turns`,
        )
      }
      const seq = current.turnSeq + 1
      tx.insert(mcpRuntimeTestTurns)
        .values({
          id: turnId,
          sessionId,
          seq,
          clientMessageId: input.clientMessageId,
          promptText: input.message,
          status: 'queued',
          hardDeadlineAt: now + MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
          captureState: 'live',
          createdAt: now,
        })
        .run()
      tx.update(mcpRuntimeTestSessions)
        .set({
          inFlightTurnId: turnId,
          idleDeadlineAt: null,
          turnSeq: seq,
          sessionVersion: current.sessionVersion + 1,
          updatedAt: now,
        })
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .run()
      return { turnId, version: current.sessionVersion + 1, shouldQueue: true }
    })
    if (accepted.turnId === null) {
      await this.finishEndingSession(sessionId)
      throw new ConflictError('mcp-test-session-expired', 'the MCP test session expired')
    }
    this.broadcastSession(sessionId)
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
    const initial = this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, actor)
    const now = this.now()
    const result = dbTxSync(this.deps.db, (tx) => {
      const session = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      const turn = tx
        .select()
        .from(mcpRuntimeTestTurns)
        .where(
          and(
            eq(mcpRuntimeTestTurns.id, input.turnId),
            eq(mcpRuntimeTestTurns.sessionId, sessionId),
          ),
        )
        .get()
      if (session === undefined || turn === undefined) {
        throw new NotFoundError('mcp-test-turn-not-found', 'MCP test turn not found')
      }
      if (isTerminalTurn(turn.status)) return { abort: false, cleanup: false }
      if (session.inFlightTurnId !== turn.id) {
        throw new ConflictError('mcp-test-turn-not-current', 'the requested turn is not current')
      }
      if (turn.status === 'queued') {
        tx.update(mcpRuntimeTestTurns)
          .set({
            status: 'canceled',
            cancelRequestedAt: now,
            captureState: 'complete',
            finishedAt: now,
            durationMs: 0,
          })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        if (canResumeNativeSession(session)) {
          tx.update(mcpRuntimeTestSessions)
            .set({
              inFlightTurnId: null,
              idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
              sessionVersion: session.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          return { abort: false, cleanup: false }
        }
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: 'session-unusable',
            inFlightTurnId: null,
            idleDeadlineAt: null,
            nativeSessionState: 'unusable',
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return { abort: false, cleanup: true }
      }
      tx.update(mcpRuntimeTestTurns)
        .set({ cancelRequestedAt: turn.cancelRequestedAt ?? now })
        .where(eq(mcpRuntimeTestTurns.id, turn.id))
        .run()
      tx.update(mcpRuntimeTestSessions)
        .set({ sessionVersion: session.sessionVersion + 1, updatedAt: now })
        .where(eq(mcpRuntimeTestSessions.id, session.id))
        .run()
      return { abort: true, cleanup: false }
    })
    if (result.abort) this.controllers.get(input.turnId)?.abort()
    if (result.cleanup) await this.finishEndingSession(sessionId)
    this.scheduleIdleTimer()
    this.broadcastSession(sessionId)
    return { session: await this.get(actor, mcpId, sessionId) }
  }

  async end(
    actor: Actor,
    mcpId: string,
    sessionId: string,
  ): Promise<McpRuntimeTestMutationReceipt> {
    await this.start()
    const initial = this.requireSession(sessionId, mcpId)
    assertSessionActor(initial, actor)
    const now = this.now()
    const transitioned = dbTxSync(this.deps.db, (tx) => {
      const session = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      if (session === undefined) {
        throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
      }
      if (session.status === 'ended') return { turnId: null, cleanup: false }
      if (session.status === 'ending') {
        return { turnId: session.inFlightTurnId, cleanup: session.inFlightTurnId === null }
      }
      const turn =
        session.inFlightTurnId === null
          ? undefined
          : tx
              .select()
              .from(mcpRuntimeTestTurns)
              .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId))
              .get()
      let inFlightTurnId = session.inFlightTurnId
      if (turn?.status === 'queued') {
        tx.update(mcpRuntimeTestTurns)
          .set({
            status: 'interrupted',
            cancelRequestedAt: now,
            captureState: 'complete',
            failureCode: 'mcp-test-ended',
            finishedAt: now,
            durationMs: 0,
          })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        inFlightTurnId = null
      } else if (turn?.status === 'running') {
        tx.update(mcpRuntimeTestTurns)
          .set({ cancelRequestedAt: turn.cancelRequestedAt ?? now })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
      }
      tx.update(mcpRuntimeTestSessions)
        .set({
          status: 'ending',
          endReason: 'user',
          inFlightTurnId,
          idleDeadlineAt: null,
          sessionVersion: session.sessionVersion + 1,
          updatedAt: now,
        })
        .where(eq(mcpRuntimeTestSessions.id, session.id))
        .run()
      return { turnId: inFlightTurnId, cleanup: inFlightTurnId === null }
    })
    if (transitioned.turnId !== null) {
      this.controllers.get(transitioned.turnId)?.abort()
      await this.turnPromises.get(transitioned.turnId)
    }
    if (transitioned.cleanup || transitioned.turnId !== null) {
      await this.finishEndingSession(sessionId)
    }
    this.broadcastSession(sessionId)
    return { session: await this.get(actor, mcpId, sessionId) }
  }

  async latest(actor: Actor, mcpId: string): Promise<McpRuntimeTestSessionDto | null> {
    await this.start()
    await this.reconcile()
    const live = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.mcpId, mcpId),
          eq(mcpRuntimeTestSessions.ownerUserId, actor.user.id),
          inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
        ),
      )
      .orderBy(desc(mcpRuntimeTestSessions.updatedAt))
      .limit(1)
      .get()
    const row =
      live ??
      this.deps.db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcpId),
            eq(mcpRuntimeTestSessions.ownerUserId, actor.user.id),
            eq(mcpRuntimeTestSessions.status, 'ended'),
          ),
        )
        .orderBy(desc(mcpRuntimeTestSessions.updatedAt))
        .limit(1)
        .get()
    return row === undefined ? null : this.project(row)
  }

  async get(actor: Actor, mcpId: string, sessionId: string): Promise<McpRuntimeTestSessionDto> {
    await this.start()
    await this.reconcile()
    const row = this.requireSession(sessionId, mcpId)
    assertSessionActor(row, actor, true)
    return this.project(row)
  }

  async sessionView(actor: Actor, mcpId: string, sessionId: string): Promise<SessionViewResponse> {
    await this.start()
    const session = this.requireSession(sessionId, mcpId)
    assertSessionActor(session, actor, true)
    const turns = this.deps.db
      .select()
      .from(mcpRuntimeTestTurns)
      .where(eq(mcpRuntimeTestTurns.sessionId, sessionId))
      .orderBy(asc(mcpRuntimeTestTurns.seq))
      .all()
    const events = this.deps.db
      .select()
      .from(mcpRuntimeTestEvents)
      .where(eq(mcpRuntimeTestEvents.testSessionId, sessionId))
      .orderBy(asc(mcpRuntimeTestEvents.eventSeq))
      .all()
    const inputEvents: ParseSessionInputEvent[] = events.map((event) => ({
      id: event.eventSeq,
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
    const running = dbTxSync(this.deps.db, (tx) => {
      const rows = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcpId),
            inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
          ),
        )
        .all()
      for (const row of rows) {
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason:
              reason === 'mcp-deleted' || row.status === 'active'
                ? reason
                : (row.endReason ?? reason),
            idleDeadlineAt: null,
            sessionVersion: row.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, row.id))
          .run()
      }
      return rows.map((row) => ({ sessionId: row.id, turnId: row.inFlightTurnId }))
    })
    for (const row of running) this.broadcastSession(row.sessionId)
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
    const running = dbTxSync(this.deps.db, (tx) => {
      const rows = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.ownerUserId, ownerUserId),
            eq(mcpRuntimeTestSessions.status, 'active'),
          ),
        )
        .all()
      for (const row of rows) {
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: reason,
            idleDeadlineAt: null,
            sessionVersion: row.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, row.id))
          .run()
      }
      return rows.map((row) => ({ sessionId: row.id, turnId: row.inFlightTurnId }))
    })
    for (const row of running) this.broadcastSession(row.sessionId)
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
    const idleSessionIds = dbTxSync(this.deps.db, (tx) => {
      const rows = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(eq(mcpRuntimeTestSessions.mcpId, mcpId), eq(mcpRuntimeTestSessions.status, 'active')),
        )
        .all()
      const idle: string[] = []
      for (const row of rows) {
        if (row.inFlightTurnId === null) {
          idle.push(row.id)
          tx.update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: 'mcp-config-changed',
              continuationBlockedReason: 'mcp-config-changed',
              idleDeadlineAt: null,
              sessionVersion: row.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        } else {
          tx.update(mcpRuntimeTestSessions)
            .set({
              continuationBlockedReason: 'mcp-config-changed',
              sessionVersion: row.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
      }
      return idle
    })
    const changedSessionIds = this.deps.db
      .select({ id: mcpRuntimeTestSessions.id })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.mcpId, mcpId),
          inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
        ),
      )
      .all()
    for (const row of changedSessionIds) this.broadcastSession(row.id)
    for (const sessionId of idleSessionIds) await this.finishEndingSession(sessionId)
  }

  async markRuntimeProfileChanged(runtimeName: string): Promise<void> {
    await this.start()
    const now = this.now()
    const idleSessionIds = dbTxSync(this.deps.db, (tx) => {
      const rows = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.runtimeName, runtimeName),
            eq(mcpRuntimeTestSessions.status, 'active'),
          ),
        )
        .all()
      const idle: string[] = []
      for (const row of rows) {
        if (row.inFlightTurnId === null) {
          idle.push(row.id)
          tx.update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: 'runtime-profile-changed',
              continuationBlockedReason: 'runtime-profile-changed',
              idleDeadlineAt: null,
              sessionVersion: row.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        } else {
          tx.update(mcpRuntimeTestSessions)
            .set({
              continuationBlockedReason: 'runtime-profile-changed',
              sessionVersion: row.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
      }
      return idle
    })
    const changedSessionIds = this.deps.db
      .select({ id: mcpRuntimeTestSessions.id })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.runtimeName, runtimeName),
          inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
        ),
      )
      .all()
    for (const row of changedSessionIds) this.broadcastSession(row.id)
    for (const sessionId of idleSessionIds) await this.finishEndingSession(sessionId)
  }

  async invalidateRuntime(
    runtimeName: string,
    reason: 'runtime-disabled' | 'runtime-deleted',
  ): Promise<void> {
    await this.start()
    const now = this.now()
    const rows = dbTxSync(this.deps.db, (tx) => {
      const sessions = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.runtimeName, runtimeName),
            eq(mcpRuntimeTestSessions.status, 'active'),
          ),
        )
        .all()
      for (const session of sessions) {
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: reason,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
      }
      return sessions.map((session) => ({
        sessionId: session.id,
        turnId: session.inFlightTurnId,
      }))
    })
    for (const row of rows) this.broadcastSession(row.sessionId)
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
    const unsafe = this.deps.db
      .select({
        id: mcpRuntimeTestSessions.id,
        status: mcpRuntimeTestSessions.status,
        cleanupState: mcpRuntimeTestSessions.cleanupState,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.mcpId, mcpId))
      .all()
      .find((session) => session.status !== 'ended' || session.cleanupState !== 'complete')
    if (unsafe !== undefined) {
      throw new ConflictError(
        'mcp-test-cleanup-incomplete',
        'an MCP runtime test could not be safely stopped',
        { sessionId: unsafe.id },
      )
    }
  }

  async reconcile(): Promise<void> {
    await this.start()
    await this.reconcileCore()
  }

  /**
   * Complete lifecycle work whose durable intent was committed atomically by
   * an MCP/ACL/runtime/user mutation. This post-commit phase may abort and reap
   * a child, clean its store, and publish the owner-scoped locator frame.
   */
  async reconcileDurableIntents(): Promise<void> {
    await this.start()
    await this.reconcileDurableIntentsCore(true)
  }

  private async reconcileCore(): Promise<void> {
    await this.reconcileDurableIntentsCore()
    await this.reconcileExpiredTurns()
    const now = this.now()
    const expired = dbTxSync(this.deps.db, (tx) => {
      const rows = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.status, 'active'),
            isNull(mcpRuntimeTestSessions.inFlightTurnId),
            lte(mcpRuntimeTestSessions.idleDeadlineAt, now),
          ),
        )
        .all()
      for (const row of rows) {
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: 'idle-timeout',
            idleDeadlineAt: null,
            sessionVersion: row.sessionVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(mcpRuntimeTestSessions.id, row.id),
              eq(mcpRuntimeTestSessions.status, 'active'),
              isNull(mcpRuntimeTestSessions.inFlightTurnId),
            ),
          )
          .run()
      }
      return rows.map((row) => row.id)
    })
    for (const sessionId of expired) {
      this.broadcastSession(sessionId)
      await this.finishEndingSession(sessionId)
    }
    await this.reconcileQuarantinedSessions()
    const cleanupCandidates = this.deps.db
      .select({ id: mcpRuntimeTestSessions.id })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.status, 'ended'),
          eq(mcpRuntimeTestSessions.cleanupState, 'pending'),
        ),
      )
      .all()
    for (const row of cleanupCandidates) await this.finishEndingSession(row.id)

    const expiredReceipts = this.deps.db
      .select({
        mcpId: mcpRuntimeTestCreateReceipts.mcpId,
        ownerUserId: mcpRuntimeTestCreateReceipts.ownerUserId,
        clientCreateId: mcpRuntimeTestCreateReceipts.clientCreateId,
      })
      .from(mcpRuntimeTestCreateReceipts)
      .where(lte(mcpRuntimeTestCreateReceipts.expiresAt, now))
      .all()
    for (const receipt of expiredReceipts) {
      const key = `${receipt.mcpId}\0${receipt.ownerUserId}\0${receipt.clientCreateId}`
      if (this.activeReceiptAttempts.has(key)) continue
      this.deps.db
        .delete(mcpRuntimeTestCreateReceipts)
        .where(
          and(
            eq(mcpRuntimeTestCreateReceipts.mcpId, receipt.mcpId),
            eq(mcpRuntimeTestCreateReceipts.ownerUserId, receipt.ownerUserId),
            eq(mcpRuntimeTestCreateReceipts.clientCreateId, receipt.clientCreateId),
            lte(mcpRuntimeTestCreateReceipts.expiresAt, now),
          ),
        )
        .run()
    }
    this.scheduleIdleTimer()
  }

  private async reconcileQuarantinedSessions(): Promise<void> {
    const candidates = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.status, 'ended'),
          eq(mcpRuntimeTestSessions.cleanupState, 'quarantined'),
        ),
      )
      .all()
    for (const session of candidates) {
      const turn = this.deps.db
        .select()
        .from(mcpRuntimeTestTurns)
        .where(
          and(eq(mcpRuntimeTestTurns.sessionId, session.id), isNotNull(mcpRuntimeTestTurns.pid)),
        )
        .orderBy(desc(mcpRuntimeTestTurns.seq))
        .limit(1)
        .get()
      if (turn === undefined || turn.pid === null) continue
      const outcome = await this.killStaleRunProcessTree(
        {
          pid: turn.pid,
          startedAt: turn.startedAt,
          spawnBinaryPath: turn.spawnBinaryPath,
        },
        { now: this.now() },
      )
      if (!['not-alive', 'killed'].includes(outcome)) continue
      const owner = getMcpRuntimeTestOwner(this.deps.db, session.id)
      if (!(await this.recoverOwnerStoreAfterReap(session, turn, owner))) continue

      const recovered = dbTxSync(this.deps.db, (tx) => {
        const currentSession = tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .get()
        const currentTurn = tx
          .select({ pid: mcpRuntimeTestTurns.pid })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .get()
        if (
          currentSession?.status !== 'ended' ||
          currentSession.cleanupState !== 'quarantined' ||
          currentTurn?.pid !== turn.pid
        ) {
          return false
        }
        tx.update(mcpRuntimeTestTurns)
          .set({ pid: null })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        tx.update(mcpRuntimeTestSessions)
          .set({
            cleanupState: 'pending',
            cleanupErrorCode: null,
            sessionVersion: currentSession.sessionVersion + 1,
            updatedAt: this.now(),
          })
          .where(eq(mcpRuntimeTestSessions.id, currentSession.id))
          .run()
        return true
      })
      if (!recovered) continue
      this.broadcastSession(session.id)
      await this.finishEndingSession(session.id)
    }
  }

  private async reconcileExpiredTurns(): Promise<void> {
    const now = this.now()
    const expired = dbTxSync(this.deps.db, (tx) => {
      const turns = tx
        .select()
        .from(mcpRuntimeTestTurns)
        .where(
          and(
            inArray(mcpRuntimeTestTurns.status, ['queued', 'running']),
            lte(mcpRuntimeTestTurns.hardDeadlineAt, now),
          ),
        )
        .all()
      const settled: Array<{ sessionId: string; turnId: string; end: boolean }> = []
      const abort: Array<{ sessionId: string; turnId: string }> = []
      for (const turn of turns) {
        const session = tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, turn.sessionId))
          .get()
        if (session?.status !== 'active' || session.inFlightTurnId !== turn.id) {
          continue
        }
        if (turn.status === 'running') {
          if (turn.cancelRequestedAt === null || turn.failureCode !== 'mcp-test-turn-timeout') {
            tx.update(mcpRuntimeTestTurns)
              .set({
                cancelRequestedAt: turn.cancelRequestedAt ?? now,
                failureCode: 'mcp-test-turn-timeout',
              })
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .run()
            tx.update(mcpRuntimeTestSessions)
              .set({
                sessionVersion: session.sessionVersion + 1,
                updatedAt: now,
              })
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .run()
          }
          abort.push({ sessionId: session.id, turnId: turn.id })
          continue
        }

        tx.update(mcpRuntimeTestTurns)
          .set({
            status: 'timed_out',
            captureState: 'complete',
            captureIncompleteReason: null,
            failureCode: 'mcp-test-turn-timeout',
            finishedAt: now,
            durationMs: Math.max(0, now - turn.createdAt),
          })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        const resumable = canResumeNativeSession(session)
        tx.update(mcpRuntimeTestSessions)
          .set(
            resumable
              ? {
                  inFlightTurnId: null,
                  idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: now,
                }
              : {
                  status: 'ending',
                  endReason: 'session-unusable',
                  nativeSessionState: 'unusable',
                  continuationBlockedReason:
                    session.continuationBlockedReason ?? 'session-store-missing',
                  inFlightTurnId: null,
                  idleDeadlineAt: null,
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: now,
                },
          )
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        settled.push({ sessionId: session.id, turnId: turn.id, end: !resumable })
      }
      return { settled, abort }
    })

    for (const row of expired.settled) {
      this.queued.delete(row.turnId)
      const index = this.queue.findIndex((item) => item.turnId === row.turnId)
      if (index >= 0) this.queue.splice(index, 1)
      this.broadcastSession(row.sessionId)
      if (row.end) await this.finishEndingSession(row.sessionId)
    }
    for (const row of expired.abort) {
      this.broadcastSession(row.sessionId)
      this.controllers.get(row.turnId)?.abort()
    }
  }

  private async reconcileDurableIntentsCore(awaitRunning = false): Promise<void> {
    const candidates = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
      .all()
      .filter(
        (session) => session.status === 'ending' || session.continuationBlockedReason !== null,
      )

    for (const snapshot of candidates) {
      this.broadcastSession(snapshot.id)
      if (snapshot.status !== 'ending') continue
      if (snapshot.inFlightTurnId === null) {
        await this.finishEndingSession(snapshot.id)
        continue
      }

      const turn = this.deps.db
        .select()
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, snapshot.inFlightTurnId))
        .get()
      if (turn === undefined) {
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
        dbTxSync(this.deps.db, (tx) => {
          const currentSession = tx
            .select()
            .from(mcpRuntimeTestSessions)
            .where(eq(mcpRuntimeTestSessions.id, snapshot.id))
            .get()
          const currentTurn = tx
            .select()
            .from(mcpRuntimeTestTurns)
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .get()
          if (
            currentSession?.status !== 'ending' ||
            currentSession.inFlightTurnId !== turn.id ||
            currentTurn?.status !== 'queued'
          ) {
            return
          }
          tx.update(mcpRuntimeTestTurns)
            .set({
              status: 'interrupted',
              cancelRequestedAt: now,
              captureState: 'complete',
              failureCode: `mcp-test-${currentSession.endReason ?? 'invalidated'}`,
              finishedAt: now,
              durationMs: 0,
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          tx.update(mcpRuntimeTestSessions)
            .set({
              inFlightTurnId: null,
              sessionVersion: currentSession.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, currentSession.id))
            .run()
        })
        this.broadcastSession(snapshot.id)
        await this.finishEndingSession(snapshot.id)
        continue
      }

      if (turn.status === 'running') {
        const now = this.now()
        this.deps.db
          .update(mcpRuntimeTestTurns)
          .set({ cancelRequestedAt: turn.cancelRequestedAt ?? now })
          .where(
            and(eq(mcpRuntimeTestTurns.id, turn.id), eq(mcpRuntimeTestTurns.status, 'running')),
          )
          .run()
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
      dbTxSync(this.deps.db, (tx) => {
        const current = tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, snapshot.id))
          .get()
        if (current?.status !== 'ending' || current.inFlightTurnId !== turn.id) {
          return
        }
        tx.update(mcpRuntimeTestSessions)
          .set({
            inFlightTurnId: null,
            sessionVersion: current.sessionVersion + 1,
            updatedAt: now,
          })
          .where(eq(mcpRuntimeTestSessions.id, current.id))
          .run()
      })
      this.broadcastSession(snapshot.id)
      await this.finishEndingSession(snapshot.id)
    }
  }

  private async recoverOwnerStoreAfterReap(
    session: SessionRow,
    turn: TurnRow,
    owner: ReturnType<typeof getMcpRuntimeTestOwner>,
  ): Promise<boolean> {
    const capability = getRuntimeDriver(session.runtimeProtocol).mcpTest
    if (capability === undefined) return false
    if (capability.sessionOwnerReceipt === null) return true
    if (session.sessionStoreDbPath === null) return false
    try {
      const abandoned = await inspectAbandonedOpencodeStoreLock(session.sessionStoreDbPath)
      const leaseHeld =
        owner !== undefined &&
        owner.leaseTurnId !== null &&
        owner.leaseAcquiredAt !== null &&
        owner.leaseNonceDigest !== null
      if (
        owner !== undefined &&
        !leaseHeld &&
        (owner.leaseTurnId !== null ||
          owner.leaseAcquiredAt !== null ||
          owner.leaseNonceDigest !== null)
      ) {
        return false
      }
      if (
        leaseHeld &&
        (owner.leaseTurnId !== turn.id ||
          (abandoned?.nonceDigest !== undefined &&
            abandoned.nonceDigest !== owner.leaseNonceDigest))
      ) {
        return false
      }
      if (abandoned !== null) {
        const server = abandoned.server
        if (server === null && !leaseHeld) return false
        if (server !== null) {
          const expectedStoreKey = owner?.sessionStoreKey ?? basename(session.sessionStoreRoot)
          if (
            server.scope.kind !== 'mcp-test' ||
            server.scope.testSessionId !== session.id ||
            server.scope.turnId !== turn.id ||
            server.scope.mode !== (turn.seq === 1 ? 'new' : 'resume') ||
            server.sessionStoreKey !== expectedStoreKey ||
            session.runtimeBinaryDigest === null ||
            server.runtimeBinaryDigest !== session.runtimeBinaryDigest
          ) {
            return false
          }
        }
        const removed = await removeAbandonedOpencodeStoreLock({
          dbPath: session.sessionStoreDbPath,
          expectedNonceDigest: abandoned.nonceDigest,
          expectedServer: abandoned.server,
          outerSandboxProcessGroupDead: true,
        })
        if (!removed) return false
      }
      if (leaseHeld && owner !== undefined && owner.leaseNonceDigest !== null) {
        return releaseMcpRuntimeTestLease(this.deps.db, {
          runtimeSessionId: owner.runtimeSessionId,
          testSessionId: session.id,
          turnId: turn.id,
          leaseNonceDigest: owner.leaseNonceDigest,
        })
      }
      return true
    } catch {
      return false
    }
  }

  private async bootRecover(): Promise<void> {
    const sessions = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
      .all()
    for (const session of sessions) {
      const capability = getRuntimeDriver(session.runtimeProtocol).mcpTest
      const hasOwnerReceipt = capability?.sessionOwnerReceipt != null
      if (session.inFlightTurnId === null) {
        if (session.status === 'ending') await this.finishEndingSession(session.id)
        continue
      }
      const turn = this.deps.db
        .select()
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId))
        .get()
      let reapOutcome: StaleRunKillOutcome | 'missing-turn' = 'no-pid'
      if (turn === undefined) {
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
      const owner = getMcpRuntimeTestOwner(this.deps.db, session.id)
      const queuedWithoutChild = turn?.status === 'queued' && turn.pid === null
      const storeRecovered =
        turn !== undefined && childReapProven
          ? await this.recoverOwnerStoreAfterReap(session, turn, owner)
          : queuedWithoutChild
      const quarantine =
        reapOutcome === 'missing-turn' ||
        (reapOutcome === 'no-pid' && !queuedWithoutChild) ||
        reapOutcome === 'command-mismatch' ||
        reapOutcome === 'window-expired' ||
        reapOutcome === 'kill-failed' ||
        !storeRecovered
      const captureComplete =
        queuedWithoutChild || (turn !== undefined && turn.captureState === 'complete')
      const storePresent = hasOwnerReceipt
        ? existsSync(session.sessionStoreRoot)
        : existsSync(session.scratchRoot)
      const ownerProven = !hasOwnerReceipt || this.deps.runFn !== undefined || owner !== undefined
      const resumable =
        capability !== undefined &&
        !quarantine &&
        session.status === 'active' &&
        canResumeNativeSession(session) &&
        captureComplete &&
        storePresent &&
        ownerProven
      const now = this.now()
      dbTxSync(this.deps.db, (tx) => {
        const current = tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .get()
        if (
          current === undefined ||
          current.inFlightTurnId !== session.inFlightTurnId ||
          !['active', 'ending'].includes(current.status)
        ) {
          return
        }
        const currentTurn = tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId!))
          .get()
        if (currentTurn !== undefined && !isTerminalTurn(currentTurn.status)) {
          tx.update(mcpRuntimeTestTurns)
            .set({
              status: 'interrupted',
              captureState:
                currentTurn.status === 'queued' || currentTurn.captureState === 'complete'
                  ? 'complete'
                  : 'incomplete',
              captureIncompleteReason:
                currentTurn.status === 'queued' || currentTurn.captureState === 'complete'
                  ? null
                  : 'post-exit-flush-timeout',
              failureCode: 'mcp-test-daemon-restarted',
              pid: quarantine ? currentTurn.pid : null,
              finishedAt: now,
              durationMs:
                currentTurn.startedAt === null ? 0 : Math.max(0, now - currentTurn.startedAt),
            })
            .where(eq(mcpRuntimeTestTurns.id, currentTurn.id))
            .run()
        }
        if (resumable) {
          tx.update(mcpRuntimeTestSessions)
            .set({
              inFlightTurnId: null,
              idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
              sessionVersion: current.sessionVersion + 1,
              updatedAt: now,
            })
            .where(eq(mcpRuntimeTestSessions.id, current.id))
            .run()
        } else {
          tx.update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: current.endReason ?? 'session-unusable',
              nativeSessionState: 'unusable',
              continuationBlockedReason:
                current.continuationBlockedReason ??
                (current.nativeSessionState === 'ready'
                  ? 'capture-incomplete'
                  : 'session-store-missing'),
              inFlightTurnId: null,
              idleDeadlineAt: null,
              sessionVersion: current.sessionVersion + 1,
              updatedAt: now,
              ...(quarantine
                ? {
                    cleanupState: 'quarantined' as const,
                    cleanupErrorCode: `mcp-test-boot-reap-${reapOutcome}`,
                  }
                : {}),
            })
            .where(eq(mcpRuntimeTestSessions.id, current.id))
            .run()
        }
      })
      this.broadcastSession(session.id)
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
    const row = await getRuntime(this.deps.db, selected)
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
    const capability = driver.mcpTest
    if (capability === undefined || !isRuntimeMcpTestEligible(row)) {
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
      configDirEnv: row.configDirEnv,
      configDirName: row.configDirName,
      probeFence: row.probeFence,
      mcpTestProfileCodec: capability.codec,
    }
    const snapshotJson = stableJson(snapshot)
    return { row, capability, binary, snapshotJson, fingerprint: sha256(snapshotJson) }
  }

  private requireSession(sessionId: string, mcpId: string): SessionRow {
    const row = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(and(eq(mcpRuntimeTestSessions.id, sessionId), eq(mcpRuntimeTestSessions.mcpId, mcpId)))
      .get()
    if (row === undefined) {
      throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
    }
    return row
  }

  private project(row: SessionRow): McpRuntimeTestSessionDto {
    const turns = this.deps.db
      .select()
      .from(mcpRuntimeTestTurns)
      .where(eq(mcpRuntimeTestTurns.sessionId, row.id))
      .orderBy(asc(mcpRuntimeTestTurns.seq))
      .all()
    const cursor =
      this.deps.db
        .select({ seq: mcpRuntimeTestEvents.eventSeq })
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, row.id))
        .orderBy(desc(mcpRuntimeTestEvents.eventSeq))
        .limit(1)
        .get()?.seq ?? 0
    return McpRuntimeTestSessionDtoSchema.parse({
      id: row.id,
      mcpId: row.mcpId,
      status: row.status,
      endReason: row.endReason,
      runtime: { name: row.runtimeName, protocol: row.runtimeProtocol },
      mcpConfigHash: row.mcpConfigHash,
      runtimeFingerprint: row.runtimeFingerprint,
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

  private broadcastSession(sessionId: string): void {
    const session = this.deps.db
      .select({
        ownerUserId: mcpRuntimeTestSessions.ownerUserId,
        sessionVersion: mcpRuntimeTestSessions.sessionVersion,
        inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, sessionId))
      .get()
    if (session === undefined) return
    const turn = this.deps.db
      .select({
        status: mcpRuntimeTestTurns.status,
        captureState: mcpRuntimeTestTurns.captureState,
      })
      .from(mcpRuntimeTestTurns)
      .where(
        session.inFlightTurnId === null
          ? eq(mcpRuntimeTestTurns.sessionId, sessionId)
          : and(
              eq(mcpRuntimeTestTurns.sessionId, sessionId),
              eq(mcpRuntimeTestTurns.id, session.inFlightTurnId),
            ),
      )
      .orderBy(desc(mcpRuntimeTestTurns.seq))
      .limit(1)
      .get()
    const eventCursor =
      this.deps.db
        .select({ seq: mcpRuntimeTestEvents.eventSeq })
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, sessionId))
        .orderBy(desc(mcpRuntimeTestEvents.eventSeq))
        .limit(1)
        .get()?.seq ?? 0
    mcpRuntimeTestsBroadcaster.broadcast(
      MCP_RUNTIME_TESTS_CHANNEL,
      {
        type: 'mcp-runtime-test.updated',
        sessionId,
        sessionVersion: session.sessionVersion,
        inFlightTurnId: session.inFlightTurnId,
        turnStatus: turn?.status ?? null,
        eventCursor,
        captureState: turn?.captureState ?? null,
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
    const admitted = dbTxSync(this.deps.db, (tx) => {
      const session = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, item.sessionId))
        .get()
      const turn = tx
        .select()
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, item.turnId))
        .get()
      if (
        session === undefined ||
        turn === undefined ||
        session.status !== 'active' ||
        session.inFlightTurnId !== turn.id ||
        turn.status !== 'queued'
      ) {
        return null
      }
      if (turn.hardDeadlineAt <= now) {
        const resumable = canResumeNativeSession(session)
        tx.update(mcpRuntimeTestTurns)
          .set({
            status: 'timed_out',
            captureState: 'complete',
            failureCode: 'mcp-test-turn-timeout',
            finishedAt: now,
            durationMs: now - turn.createdAt,
          })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        tx.update(mcpRuntimeTestSessions)
          .set(
            resumable
              ? {
                  inFlightTurnId: null,
                  idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: now,
                }
              : {
                  status: 'ending',
                  endReason: 'session-unusable',
                  inFlightTurnId: null,
                  idleDeadlineAt: null,
                  nativeSessionState: 'unusable',
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: now,
                },
          )
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return null
      }
      tx.update(mcpRuntimeTestTurns)
        .set({ status: 'running', startedAt: now })
        .where(eq(mcpRuntimeTestTurns.id, turn.id))
        .run()
      return { session, turn: { ...turn, status: 'running' as const } }
    })
    if (admitted === null) {
      const current = this.deps.db
        .select({
          status: mcpRuntimeTestSessions.status,
          inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
        })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, item.sessionId))
        .get()
      if (current?.status === 'ending') await this.finishEndingSession(item.sessionId)
      else if (current?.status === 'active' && current.inFlightTurnId === null) {
        this.broadcastSession(item.sessionId)
        this.scheduleIdleTimer()
      }
      return
    }
    this.broadcastSession(item.sessionId)

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
      runtime.fingerprint !== session.runtimeFingerprint
    ) {
      await this.failBeforeRun(item, 'mcp-test-runtime-profile-changed', 'runtime-profile-changed')
      return
    }

    const sink = new McpRuntimeTestEventSink(this.deps.db, item, () =>
      this.broadcastSession(item.sessionId),
    )
    const controlTracker = new ControlMarkerTracker()
    const controlNonce = randomBytes(32).toString('base64url')
    const leaseNonceDigest = sha256(controlNonce)
    let leaseToken: McpRuntimeTestLeaseToken | undefined
    let resumeOwner: ReturnType<typeof getMcpRuntimeTestOwner>
    let opencodeControl:
      | NonNullable<Parameters<RuntimeMcpTestCapabilityV1['buildSpawn']>[0]['opencodeControl']>
      | undefined
    if (runtime.capability.sessionOwnerReceipt !== null && this.deps.runFn === undefined) {
      try {
        resumeOwner = getMcpRuntimeTestOwner(this.deps.db, session.id)
        if (turn.seq === 1) {
          if (resumeOwner !== undefined || session.runtimeSessionId !== null) {
            throw new Error('mcp-test-new-owner-already-exists')
          }
          opencodeControl = {
            kind: 'new',
            nonce: controlNonce,
            leaseNonceDigest,
            createdTurnId: turn.id,
          }
        } else {
          if (
            resumeOwner === undefined ||
            session.runtimeSessionId === null ||
            resumeOwner.runtimeSessionId !== session.runtimeSessionId
          ) {
            throw new Error('mcp-test-resume-owner-missing')
          }
          preclaimMcpRuntimeTestResume(this.deps.db, {
            runtimeSessionId: resumeOwner.runtimeSessionId,
            testSessionId: session.id,
            turnId: turn.id,
            createdTurnId: resumeOwner.createdTurnId,
            identityDigest: resumeOwner.identityDigest,
            runtimeBinaryDigest: resumeOwner.runtimeBinaryDigest,
            sessionContractDigest: resumeOwner.sessionContractDigest,
            sessionStoreKey: resumeOwner.sessionStoreKey,
            protocolCodec: resumeOwner.protocolCodec,
            leaseNonceDigest,
            leasedAt: this.now(),
          })
          leaseToken = {
            runtimeSessionId: resumeOwner.runtimeSessionId,
            testSessionId: session.id,
            turnId: turn.id,
            leaseNonceDigest,
          }
          opencodeControl = {
            kind: 'resume',
            nonce: controlNonce,
            leaseNonceDigest,
            createdTurnId: resumeOwner.createdTurnId,
            expectedSessionId: resumeOwner.runtimeSessionId,
            expectedProjectId: resumeOwner.projectId,
            expectedIdentityDigest: resumeOwner.identityDigest,
            expectedRuntimeBinaryDigest: resumeOwner.runtimeBinaryDigest,
            expectedSessionContractDigest: resumeOwner.sessionContractDigest,
            expectedSessionStoreKey: resumeOwner.sessionStoreKey,
            expectedProtocolCodec: resumeOwner.protocolCodec,
          }
        }
      } catch {
        await this.failBeforeRun(item, 'execution-identity-control-failed', 'session-unusable')
        return
      }
    }
    const timeoutMs = Math.max(1, turn.hardDeadlineAt - this.now())
    let result: SystemAgentRunResult
    let runReturned = false
    try {
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
        bridgeCredentials: runtime.capability.bridgeCredentials,
        containmentCoordinator: this.deps.containmentCoordinator,
        containmentProfile: runtime.capability.containmentProfile({ mcp }),
        retainScratchOnSuccess: true,
        buildPlan: async ({ worktreePath, runDir, containment, log }): Promise<SpawnPlan> => {
          const turnRunRoot = join(runDir, 'turns', turn.id)
          let plan: McpTestSpawnPlan
          if (containment === undefined) {
            if (this.deps.runFn === undefined) {
              throw new Error('execution-identity-containment-required')
            }
            // Explicit dependency-injected tests exercise coordinator fences
            // without touching a host binary/store. This branch is impossible
            // in production because production never supplies runFn.
            plan = {
              cmd: [runtime.binary],
              env: {},
              stdin: { mode: 'ignore' },
              identity: {
                codec: 'mcp-test-plan-identity-v1',
                runtimeBinaryDigest: sha256(`test-runtime:${runtime.fingerprint}`),
                mcpExecutionDigest: sha256(`test-mcp:${session.mcpConfigHash}`),
                sessionContractDigest: sha256(
                  stableJson({
                    testOnly: true,
                    sessionId: session.id,
                    runtimeFingerprint: session.runtimeFingerprint,
                  }),
                ),
                rawCommandDigest: sha256(`test-command:${runtime.binary}`),
              },
            }
          } else {
            const executionMaterial = await prepareMcpTestExecutionMaterial({
              mcp,
              root: join(turnRunRoot, 'material'),
              worktreePath,
              appHome: this.deps.appHome,
              containment,
            })
            plan = await runtime.capability.buildSpawn({
              sessionId: session.id,
              turnId: turn.id,
              agentName: AGENT_NAME,
              systemPrompt: SYSTEM_PROMPT,
              prompt: turn.promptText,
              executionMaterial,
              model: runtime.row.model,
              variant: runtime.row.variant,
              temperature: runtime.row.temperature,
              steps: runtime.row.steps,
              maxSteps: runtime.row.maxSteps,
              worktreePath,
              sessionRoot: session.scratchRoot,
              sessionStoreRoot: session.sessionStoreRoot,
              runDir: turnRunRoot,
              appHome: this.deps.appHome,
              configDir: {
                env: runtime.row.configDirEnv ?? runtime.capability.defaultConfigDir.env,
                name: runtime.row.configDirName ?? runtime.capability.defaultConfigDir.name,
              },
              runtimeBinary: runtime.binary,
              ...runtime.capability.sessionReference({
                turnSeq: turn.seq,
                nativeSessionId: session.runtimeSessionId,
              }),
              bridgeCredentials: runtime.capability.bridgeCredentials,
              log,
              containment,
              ...(opencodeControl === undefined ? {} : { opencodeControl }),
            })
          }
          const identity = plan.identity
          if (
            identity.codec !== 'mcp-test-plan-identity-v1' ||
            ![
              identity.runtimeBinaryDigest,
              identity.mcpExecutionDigest,
              identity.sessionContractDigest,
              identity.rawCommandDigest,
            ].every((digest) => /^[0-9a-f]{64}$/.test(digest))
          ) {
            throw new Error('mcp-test-plan-identity-invalid')
          }
          dbTxSync(this.deps.db, (tx) => {
            const currentSession = tx
              .select()
              .from(mcpRuntimeTestSessions)
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .get()
            const currentTurn = tx
              .select()
              .from(mcpRuntimeTestTurns)
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .get()
            if (
              currentSession?.status !== 'active' ||
              currentSession.inFlightTurnId !== turn.id ||
              currentTurn?.status !== 'running' ||
              currentTurn.cancelRequestedAt !== null
            ) {
              throw new Error('mcp-test-plan-no-longer-admitted')
            }
            const anyIdentity =
              currentSession.runtimeBinaryDigest !== null ||
              currentSession.mcpExecutionDigest !== null ||
              currentSession.sessionContractDigest !== null
            if (
              anyIdentity &&
              (currentSession.runtimeBinaryDigest !== identity.runtimeBinaryDigest ||
                currentSession.mcpExecutionDigest !== identity.mcpExecutionDigest ||
                currentSession.sessionContractDigest !== identity.sessionContractDigest)
            ) {
              tx.update(mcpRuntimeTestSessions)
                .set({
                  continuationBlockedReason:
                    currentSession.mcpExecutionDigest !== identity.mcpExecutionDigest
                      ? 'mcp-execution-changed'
                      : 'runtime-identity-changed',
                })
                .where(eq(mcpRuntimeTestSessions.id, session.id))
                .run()
              throw new Error('mcp-test-plan-identity-mismatch')
            }
            tx.update(mcpRuntimeTestSessions)
              .set({
                runtimeBinaryDigest: identity.runtimeBinaryDigest,
                mcpExecutionDigest: identity.mcpExecutionDigest,
                sessionContractDigest: identity.sessionContractDigest,
              })
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .run()
            tx.update(mcpRuntimeTestTurns)
              .set({ rawCommandDigest: identity.rawCommandDigest })
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .run()
          })
          const capabilityVerify = plan.preSpawnVerify
          return {
            ...plan,
            preSpawnVerify: async () => {
              await capabilityVerify?.()
              const allowed = dbTxSync(this.deps.db, (tx) => {
                const currentSession = tx
                  .select({
                    status: mcpRuntimeTestSessions.status,
                    inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
                  })
                  .from(mcpRuntimeTestSessions)
                  .where(eq(mcpRuntimeTestSessions.id, session.id))
                  .get()
                const currentTurn = tx
                  .select({
                    status: mcpRuntimeTestTurns.status,
                    cancelRequestedAt: mcpRuntimeTestTurns.cancelRequestedAt,
                    hardDeadlineAt: mcpRuntimeTestTurns.hardDeadlineAt,
                  })
                  .from(mcpRuntimeTestTurns)
                  .where(eq(mcpRuntimeTestTurns.id, turn.id))
                  .get()
                return (
                  currentSession?.status === 'active' &&
                  currentSession.inFlightTurnId === turn.id &&
                  currentTurn?.status === 'running' &&
                  currentTurn.cancelRequestedAt === null &&
                  currentTurn.hardDeadlineAt > this.now()
                )
              })
              if (!allowed) throw new Error('mcp-test-spawn-no-longer-admitted')
            },
          }
        },
        onSpawned: async (receipt) => {
          const spawnedFenceAt = this.now()
          const admittedForPrompt = dbTxSync(this.deps.db, (tx) => {
            const currentSession = tx
              .select()
              .from(mcpRuntimeTestSessions)
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .get()
            const currentTurn = tx
              .select()
              .from(mcpRuntimeTestTurns)
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .get()
            if (currentSession === undefined || currentTurn === undefined) {
              throw new Error('mcp-test-spawn-receipt-owner-missing')
            }
            tx.update(mcpRuntimeTestTurns)
              .set({
                pid: receipt.pid,
                spawnedAt: receipt.spawnedAt,
                spawnBinaryPath: receipt.spawnBinaryPath,
                rawCommandDigest: receipt.rawCommandDigest,
                spawnCommandDigest: receipt.spawnCommandDigest,
              })
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .run()
            const expired = currentTurn.hardDeadlineAt <= spawnedFenceAt
            if (expired) {
              tx.update(mcpRuntimeTestTurns)
                .set({
                  cancelRequestedAt: currentTurn.cancelRequestedAt ?? spawnedFenceAt,
                  failureCode: 'mcp-test-turn-timeout',
                })
                .where(eq(mcpRuntimeTestTurns.id, turn.id))
                .run()
            }
            return (
              currentSession.status === 'active' &&
              currentSession.inFlightTurnId === turn.id &&
              currentTurn.status === 'running' &&
              currentTurn.cancelRequestedAt === null &&
              !expired
            )
          })
          if (!admittedForPrompt) throw new Error('mcp-test-spawn-canceled-before-prompt')
        },
        onControlLine: async ({ line, control }) => {
          if (control.kind !== 'opencode-mcp-test') {
            throw new Error('mcp-test-unexpected-control-kind')
          }
          const nack = (): void => {
            try {
              writeControlAckExclusive(control.ackPath, {
                decision: 'nack',
                nonce: control.nonce,
              })
            } catch {
              // The first O_EXCL decision remains authoritative.
            }
          }
          try {
            const parsed = controlTracker.accept(line)
            if (parsed.kind === 'stderr') return parsed
            const marker = parsed.marker
            if (
              marker.kind !== control.mode ||
              marker.nodeRunId !== turn.id ||
              marker.leaseNonceDigest !== control.leaseNonceDigest ||
              marker.binaryDigest !== control.runtimeBinaryDigest ||
              marker.protocolCodec !== control.protocolCodec
            ) {
              throw new Error('mcp-test-control-marker-mismatch')
            }
            if (control.mode === 'new') {
              leaseToken = claimNewMcpRuntimeTestSession(this.deps.db, {
                runtimeSessionId: marker.sessionId,
                testSessionId: session.id,
                turnId: turn.id,
                createdTurnId: control.createdTurnId,
                identityDigest: control.identityDigest,
                runtimeBinaryDigest: control.runtimeBinaryDigest,
                sessionContractDigest: control.sessionContractDigest,
                sessionStoreKey: control.sessionStoreKey,
                projectId: marker.projectId,
                protocolCodec: marker.protocolCodec,
                reportedVersion: marker.reportedVersion,
                leaseNonceDigest: control.leaseNonceDigest,
                leasedAt: this.now(),
              })
            } else {
              const token = leaseToken
              if (
                token === undefined ||
                control.expectedSessionId === undefined ||
                marker.sessionId !== control.expectedSessionId ||
                resumeOwner === undefined ||
                marker.projectId !== resumeOwner.projectId
              ) {
                throw new Error('mcp-test-resume-control-mismatch')
              }
              confirmMcpRuntimeTestResume(this.deps.db, {
                ...token,
                projectId: marker.projectId,
                reportedVersion: marker.reportedVersion,
              })
            }
            writeControlAckExclusive(control.ackPath, {
              decision: 'ok',
              nonce: control.nonce,
            })
            return { kind: 'session-ready' as const, sessionId: marker.sessionId }
          } catch (error) {
            nack()
            throw error
          }
        },
      })
      runReturned = true
    } catch {
      result = {
        status: controller.signal.aborted ? 'aborted' : 'spawn-failed',
        exitCode: null,
        eventText: '',
        stderrTail: 'runtime test attempt failed before completion',
        durationMs: Math.max(0, this.now() - now),
        scratchDir: session.scratchRoot,
        scratchRetained: true,
      }
    }
    if (runReturned && result.status !== 'unreaped' && leaseToken !== undefined) {
      if (!releaseMcpRuntimeTestLease(this.deps.db, leaseToken)) {
        result = {
          ...result,
          status: 'identity-failed',
          failureCode: 'execution-identity-control-failed',
        }
      }
      leaseToken = undefined
    }
    await sink.markTerminal('complete')
    await this.settleTurn(session, turn, result)
  }

  private async loadMcpForRun(mcpId: string): Promise<Mcp | null> {
    const { getMcpById } = await import('@/services/mcp')
    return getMcpById(this.deps.db, mcpId)
  }

  private async failBeforeRun(
    item: QueueItem,
    failureCode: string,
    endReason: McpRuntimeTestEndReason,
  ): Promise<void> {
    const now = this.now()
    dbTxSync(this.deps.db, (tx) => {
      const session = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, item.sessionId))
        .get()
      if (session === undefined) return
      tx.update(mcpRuntimeTestTurns)
        .set({
          status: 'failed',
          captureState: 'complete',
          failureCode,
          finishedAt: now,
        })
        .where(eq(mcpRuntimeTestTurns.id, item.turnId))
        .run()
      tx.update(mcpRuntimeTestSessions)
        .set({
          status: 'ending',
          endReason,
          inFlightTurnId: null,
          idleDeadlineAt: null,
          sessionVersion: session.sessionVersion + 1,
          updatedAt: now,
        })
        .where(eq(mcpRuntimeTestSessions.id, item.sessionId))
        .run()
    })
    await this.finishEndingSession(item.sessionId)
  }

  private async settleTurn(
    originalSession: SessionRow,
    originalTurn: TurnRow,
    result: SystemAgentRunResult,
  ): Promise<void> {
    const now = this.now()
    const shouldCleanup = dbTxSync(this.deps.db, (tx) => {
      const session = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, originalSession.id))
        .get()
      const turn = tx
        .select()
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, originalTurn.id))
        .get()
      if (session === undefined || turn === undefined || isTerminalTurn(turn.status)) {
        return session?.status === 'ending'
      }

      let nativeState = session.nativeSessionState
      let nativeSessionId = session.runtimeSessionId
      let blocked = session.continuationBlockedReason
      const childUnreaped = result.status === 'unreaped'
      const identityFailed = result.status === 'identity-failed'
      const captured = result.capturedSessionId
      if (captured !== undefined) {
        if (nativeSessionId !== null && nativeSessionId !== captured) {
          nativeState = 'unusable'
          blocked = 'session-root-mismatch'
        } else {
          nativeSessionId = captured
          nativeState = 'ready'
        }
      } else if (originalTurn.seq === 1) {
        nativeState = 'unusable'
        blocked = 'session-store-missing'
      }
      if (childUnreaped) {
        nativeState = 'unusable'
        blocked ??= 'capture-incomplete'
      }
      if (identityFailed) {
        nativeState = 'unusable'
        blocked ??= 'runtime-identity-changed'
      }

      const turnStatus = resultTurnStatus(
        result,
        turn.cancelRequestedAt !== null,
        session.status === 'ending',
        turn.failureCode,
      )
      tx.update(mcpRuntimeTestTurns)
        .set({
          status: turnStatus,
          exitCode: result.exitCode,
          failureCode: resultFailureCode(result, turn.failureCode),
          stderrTail:
            result.stderrTail === ''
              ? null
              : result.stderrTail.slice(Math.max(0, result.stderrTail.length - STDERR_TAIL_BYTES)),
          durationMs: result.durationMs,
          finishedAt: now,
          pid: childUnreaped ? turn.pid : null,
        })
        .where(eq(mcpRuntimeTestTurns.id, turn.id))
        .run()

      const captureBlocked = turn.captureState === 'truncated' || turn.captureState === 'incomplete'
      const mustEnd =
        session.status === 'ending' || nativeState !== 'ready' || blocked !== null || captureBlocked
      if (mustEnd) {
        const reasonFromBlock =
          blocked === 'mcp-config-changed'
            ? 'mcp-config-changed'
            : blocked === 'runtime-profile-changed'
              ? 'runtime-profile-changed'
              : blocked === 'runtime-identity-changed'
                ? 'runtime-identity-changed'
                : 'session-unusable'
        const reason =
          session.endReason ??
          (captureBlocked
            ? turn.captureState === 'truncated'
              ? 'capture-truncated'
              : 'capture-incomplete'
            : reasonFromBlock)
        tx.update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: reason,
            runtimeSessionId: nativeSessionId,
            nativeSessionState: nativeState,
            continuationBlockedReason: blocked,
            inFlightTurnId: null,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
            ...(childUnreaped
              ? {
                  cleanupState: 'quarantined' as const,
                  cleanupErrorCode: 'mcp-test-child-unreaped',
                }
              : {}),
          })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return true
      }
      tx.update(mcpRuntimeTestSessions)
        .set({
          runtimeSessionId: nativeSessionId,
          nativeSessionState: nativeState,
          inFlightTurnId: null,
          idleDeadlineAt: now + MCP_RUNTIME_TEST_IDLE_MS,
          sessionVersion: session.sessionVersion + 1,
          updatedAt: now,
        })
        .where(eq(mcpRuntimeTestSessions.id, session.id))
        .run()
      return false
    })
    this.broadcastSession(originalSession.id)
    if (shouldCleanup) await this.finishEndingSession(originalSession.id)
    else this.scheduleIdleTimer()
  }

  private async invalidateSession(
    sessionId: string,
    reason: McpRuntimeTestEndReason,
  ): Promise<void> {
    const now = this.now()
    const turnId = dbTxSync(this.deps.db, (tx) => {
      const row = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      if (row === undefined || row.status !== 'active') return row?.inFlightTurnId ?? null
      tx.update(mcpRuntimeTestSessions)
        .set({
          status: 'ending',
          endReason: reason,
          idleDeadlineAt: null,
          sessionVersion: row.sessionVersion + 1,
          updatedAt: now,
        })
        .where(eq(mcpRuntimeTestSessions.id, row.id))
        .run()
      return row.inFlightTurnId
    })
    if (turnId !== null) this.controllers.get(turnId)?.abort()
    else await this.finishEndingSession(sessionId)
  }

  private async finishEndingSession(sessionId: string): Promise<void> {
    const row = this.deps.db
      .select()
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, sessionId))
      .get()
    if (
      row === undefined ||
      row.inFlightTurnId !== null ||
      (row.status !== 'ending' && !(row.status === 'ended' && row.cleanupState === 'pending'))
    ) {
      return
    }
    const running = this.deps.db
      .select({ id: mcpRuntimeTestTurns.id })
      .from(mcpRuntimeTestTurns)
      .where(
        and(
          eq(mcpRuntimeTestTurns.sessionId, sessionId),
          inArray(mcpRuntimeTestTurns.status, ['queued', 'running']),
        ),
      )
      .get()
    if (running !== undefined) return
    const alreadyQuarantined = row.cleanupState === 'quarantined'
    if (!alreadyQuarantined) {
      this.deps.db
        .update(mcpRuntimeTestSessions)
        .set({ cleanupState: 'pending', updatedAt: this.now() })
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .run()
    }

    const base = resolve(join(this.deps.appHome, 'mcp-runtime-tests'))
    const target = resolve(row.scratchRoot)
    const safe = dirname(target) === base && target !== base
    const owner = getMcpRuntimeTestOwner(this.deps.db, sessionId)
    const storeBase = resolve(join(this.deps.appHome, 'opencode-stores', 'mcp-test'))
    const storeTarget = resolve(row.sessionStoreRoot)
    const capability = getRuntimeDriver(row.runtimeProtocol).mcpTest
    const externalStore = capability?.sessionOwnerReceipt != null
    const safeStore =
      capability !== undefined &&
      (!externalStore ||
        (dirname(storeTarget) === storeBase &&
          storeTarget !== storeBase &&
          storeTarget ===
            opencodeMcpTestSessionStore({
              appHome: this.deps.appHome,
              sessionId,
            }).root))
    let cleanupState: SessionRow['cleanupState'] = alreadyQuarantined ? 'quarantined' : 'complete'
    let cleanupErrorCode: string | null = alreadyQuarantined ? row.cleanupErrorCode : null
    if (alreadyQuarantined) {
      // A known or possibly-live child may still own the directory. Retain it
      // and block replacement/deletion until explicit recovery proves reaping.
    } else if (
      !safe ||
      !safeStore ||
      (owner !== undefined &&
        (owner.leaseTurnId !== null ||
          owner.leaseAcquiredAt !== null ||
          owner.leaseNonceDigest !== null))
    ) {
      cleanupState = 'quarantined'
      cleanupErrorCode =
        owner !== undefined && owner.leaseTurnId !== null
          ? 'mcp-test-store-lease-held'
          : 'mcp-test-cleanup-path-unsafe'
    } else {
      try {
        if (externalStore && row.sessionStoreDbPath !== null) {
          await removeHermeticOpencodeLayout(storeTarget)
        }
        rmSync(target, { recursive: true, force: true })
      } catch {
        cleanupState = 'pending'
        cleanupErrorCode = 'mcp-test-cleanup-failed'
      }
    }
    const endedAt = this.now()
    dbTxSync(this.deps.db, (tx) => {
      const current = tx
        .select()
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      if (
        current === undefined ||
        current.inFlightTurnId !== null ||
        (current.status !== 'ending' &&
          !(current.status === 'ended' && current.cleanupState === 'pending'))
      ) {
        return
      }
      tx.update(mcpRuntimeTestSessions)
        .set({
          status: 'ended',
          cleanupState,
          cleanupErrorCode,
          endedAt: current.endedAt ?? endedAt,
          updatedAt: endedAt,
          sessionVersion: current.sessionVersion + 1,
        })
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .run()
    })
    this.broadcastSession(sessionId)
    this.scheduleIdleTimer()
  }

  private scheduleIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.shuttingDown) return
    const earliestIdle = this.deps.db
      .select({ deadline: mcpRuntimeTestSessions.idleDeadlineAt })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.status, 'active'),
          isNull(mcpRuntimeTestSessions.inFlightTurnId),
        ),
      )
      .orderBy(asc(mcpRuntimeTestSessions.idleDeadlineAt))
      .limit(1)
      .get()?.deadline
    const activeInFlight = this.deps.db
      .select({ turnId: mcpRuntimeTestSessions.inFlightTurnId })
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.status, 'active'),
          sql`${mcpRuntimeTestSessions.inFlightTurnId} IS NOT NULL`,
        ),
      )
      .all()
    let earliestTurn: number | null = null
    for (const row of activeInFlight) {
      if (row.turnId === null) continue
      const turn = this.deps.db
        .select({
          deadline: mcpRuntimeTestTurns.hardDeadlineAt,
          cancelRequestedAt: mcpRuntimeTestTurns.cancelRequestedAt,
          status: mcpRuntimeTestTurns.status,
        })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, row.turnId))
        .get()
      if (
        turn === undefined ||
        !['queued', 'running'].includes(turn.status) ||
        turn.cancelRequestedAt !== null
      ) {
        continue
      }
      earliestTurn = earliestTurn === null ? turn.deadline : Math.min(earliestTurn, turn.deadline)
    }
    const deadlines = [earliestIdle, earliestTurn].filter(
      (deadline): deadline is number => typeof deadline === 'number',
    )
    if (deadlines.length === 0) return
    const earliest = Math.min(...deadlines)
    const delay = Math.max(0, Math.min(earliest - this.now(), 2_147_483_647))
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.reconcile()
    }, delay)
    this.idleTimer.unref?.()
  }
}
