import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
} from '@/db/schema'
import { runPostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'
import type {
  McpRuntimeTestAcceptMessageInput,
  McpRuntimeTestAdmittedTurn,
  McpRuntimeTestBootRecoveryInput,
  McpRuntimeTestBroadcastSnapshot,
  McpRuntimeTestCreatePersistenceInput,
  McpRuntimeTestEventAppendResult,
  McpRuntimeTestExpiredTurnResult,
  McpRuntimeTestPersistence,
  McpRuntimeTestQuarantinedCandidate,
  McpRuntimeTestRunningRef,
  McpRuntimeTestSettlementInput,
  McpRuntimeTestSpawnReceiptInput,
} from '../application/mcps/runtimeTestPersistence'
import { ConflictError, NotFoundError } from '@/util/errors'

type SessionRow = typeof mcpRuntimeTestSessions.$inferSelect
type TurnRow = typeof mcpRuntimeTestTurns.$inferSelect
const UNUSABLE_NATIVE_SESSION_STATE: SessionRow['nativeSessionState'] = 'unusable'
const QUARANTINED_CLEANUP_STATE: SessionRow['cleanupState'] = 'quarantined'
const RUNNING_TURN_STATUS: TurnRow['status'] = 'running'

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

export function createPostgresqlMcpRuntimeTestPersistence(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestPersistence {
  const persistence: McpRuntimeTestPersistence = {
    identity: db,

    async appendEvent(input): Promise<McpRuntimeTestEventAppendResult> {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const turn = await tx
          .select({
            captureState: mcpRuntimeTestTurns.captureState,
            lastEventSeq: mcpRuntimeTestTurns.captureLastEventSeq,
            eventBytes: mcpRuntimeTestTurns.captureEventBytes,
            firstEventSeq: mcpRuntimeTestTurns.captureFirstEventSeq,
          })
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.id, input.turnId),
              eq(mcpRuntimeTestTurns.sessionId, input.sessionId),
            ),
          )
          .get()
        if (turn === undefined) {
          throw new NotFoundError('mcp-test-turn-not-found', 'MCP test turn not found')
        }
        if (turn.captureState !== 'live') return 'stopped'
        if (input.externalEventKey !== null) {
          const duplicate = await tx
            .select({ id: mcpRuntimeTestEvents.id })
            .from(mcpRuntimeTestEvents)
            .where(
              and(
                eq(mcpRuntimeTestEvents.testSessionId, input.sessionId),
                eq(mcpRuntimeTestEvents.externalEventKey, input.externalEventKey),
              ),
            )
            .get()
          if (duplicate !== undefined) return 'duplicate'
        }
        const sessionEventCount =
          (
            await tx
              .select({ count: sql<number>`count(*)` })
              .from(mcpRuntimeTestEvents)
              .where(eq(mcpRuntimeTestEvents.testSessionId, input.sessionId))
              .get()
          )?.count ?? 0
        const sessionBytes =
          (
            await tx
              .select({
                bytes: sql<number>`coalesce(sum(${mcpRuntimeTestTurns.captureEventBytes}), 0)`,
              })
              .from(mcpRuntimeTestTurns)
              .where(eq(mcpRuntimeTestTurns.sessionId, input.sessionId))
              .get()
          )?.bytes ?? 0
        if (
          input.payloadBytes > input.maxSingleEventBytes ||
          sessionEventCount >= input.maxSessionRows ||
          sessionBytes + input.payloadBytes > input.maxSessionBytes
        ) {
          await tx
            .update(mcpRuntimeTestTurns)
            .set({ captureState: 'truncated', captureIncompleteReason: null })
            .where(eq(mcpRuntimeTestTurns.id, input.turnId))
            .run()
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              continuationBlockedReason: sql`CASE
                WHEN ${mcpRuntimeTestSessions.continuationBlockedReason} IN ('mcp-config-changed', 'runtime-profile-changed')
                  THEN ${mcpRuntimeTestSessions.continuationBlockedReason}
                ELSE 'capture-truncated'
              END`,
            })
            .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
            .run()
          return 'truncated'
        }
        const last = await tx
          .select({ seq: mcpRuntimeTestEvents.eventSeq })
          .from(mcpRuntimeTestEvents)
          .where(eq(mcpRuntimeTestEvents.testSessionId, input.sessionId))
          .orderBy(desc(mcpRuntimeTestEvents.eventSeq))
          .limit(1)
          .get()
        const eventSeq = (last?.seq ?? 0) + 1
        await tx
          .insert(mcpRuntimeTestEvents)
          .values({
            testSessionId: input.sessionId,
            firstSeenTurnId: input.turnId,
            eventSeq,
            ts: input.ts,
            kind: input.kind,
            payload: input.payload,
            sessionId: input.runtimeSessionId,
            parentSessionId: input.parentSessionId,
            source: input.source,
            externalEventKey: input.externalEventKey,
          })
          .run()
        await tx
          .update(mcpRuntimeTestTurns)
          .set({
            captureFirstEventSeq: turn.firstEventSeq ?? eventSeq,
            captureLastEventSeq: eventSeq,
            captureEventBytes: turn.eventBytes + input.payloadBytes,
          })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        return 'appended'
      })
    },

    async loadRuntimeSessionId(sessionId) {
      return (
        await db
          .select({ runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, sessionId))
          .get()
      )?.runtimeSessionId
    },

    async setRootSession(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const row = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (row === undefined) {
          throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
        }
        const turn = await tx
          .select({ captureState: mcpRuntimeTestTurns.captureState })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (turn === undefined) {
          throw new NotFoundError('mcp-test-turn-not-found', 'MCP test turn not found')
        }
        if (
          input.previousRuntimeSessionId !== undefined &&
          row.runtimeSessionId !== input.previousRuntimeSessionId
        ) {
          throw new ConflictError(
            'mcp-test-runtime-session-changed',
            'runtime conversation reset did not match the persisted native session',
          )
        }
        if (row.runtimeSessionId !== null && row.runtimeSessionId !== input.runtimeSessionId) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({ nativeSessionState: 'unusable' })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
          throw new ConflictError(
            'mcp-test-runtime-session-changed',
            'runtime returned a different native session id',
          )
        }
        if (row.runtimeSessionId === null) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({ runtimeSessionId: input.runtimeSessionId })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        if (input.previousRuntimeSessionId !== undefined) {
          await tx
            .update(mcpRuntimeTestEvents)
            .set({ sessionId: input.runtimeSessionId })
            .where(
              and(
                eq(mcpRuntimeTestEvents.testSessionId, input.sessionId),
                eq(mcpRuntimeTestEvents.sessionId, input.previousRuntimeSessionId),
                isNull(mcpRuntimeTestEvents.parentSessionId),
              ),
            )
            .run()
          await tx
            .update(mcpRuntimeTestEvents)
            .set({ parentSessionId: input.runtimeSessionId })
            .where(
              and(
                eq(mcpRuntimeTestEvents.testSessionId, input.sessionId),
                eq(mcpRuntimeTestEvents.parentSessionId, input.previousRuntimeSessionId),
              ),
            )
            .run()
          await tx
            .update(mcpRuntimeTestSessions)
            .set({ nativeSessionState: 'ready' })
            .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
            .run()
        }
        return { captureLive: turn.captureState === 'live' }
      })
    },

    async markRootSessionResetPending(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const row = await tx
          .select({ runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (row?.runtimeSessionId !== input.runtimeSessionId) {
          throw new ConflictError(
            'mcp-test-runtime-session-changed',
            'runtime conversation reset did not match the persisted native session',
          )
        }
        const turn = await tx
          .select({ captureState: mcpRuntimeTestTurns.captureState })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (turn === undefined) {
          throw new NotFoundError('mcp-test-turn-not-found', 'MCP test turn not found')
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set({ nativeSessionState: 'unusable' })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return { captureLive: turn.captureState === 'live' }
      })
    },

    async markCaptureTerminal(input) {
      runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const turn = await tx
          .select({ captureState: mcpRuntimeTestTurns.captureState })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (turn === undefined || turn.captureState === 'incomplete') return
        if (turn.captureState === 'truncated' && input.state !== 'incomplete') return
        await tx
          .update(mcpRuntimeTestTurns)
          .set({ captureState: input.state, captureIncompleteReason: input.reason })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        if (input.state !== 'complete') {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              continuationBlockedReason: sql`CASE
                WHEN ${mcpRuntimeTestSessions.continuationBlockedReason} IN ('mcp-config-changed', 'runtime-profile-changed')
                  THEN ${mcpRuntimeTestSessions.continuationBlockedReason}
                WHEN ${input.state === 'incomplete'} THEN 'capture-incomplete'
                WHEN ${mcpRuntimeTestSessions.continuationBlockedReason} IS NULL
                  THEN 'capture-truncated'
                ELSE ${mcpRuntimeTestSessions.continuationBlockedReason}
              END`,
            })
            .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
            .run()
        }
      })
    },

    async shutdown(now, idleDeadlineAt) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const sessions = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
          .all()
        const rows: McpRuntimeTestRunningRef[] = []
        for (const session of sessions) {
          if (session.inFlightTurnId === null) continue
          const turn = await tx
            .select()
            .from(mcpRuntimeTestTurns)
            .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId))
            .get()
          if (turn?.status === 'queued') {
            const timedOut = turn.hardDeadlineAt <= now
            await tx
              .update(mcpRuntimeTestTurns)
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
            await tx
              .update(mcpRuntimeTestSessions)
              .set(
                resumable
                  ? {
                      inFlightTurnId: null,
                      idleDeadlineAt,
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
                        ? { nativeSessionState: UNUSABLE_NATIVE_SESSION_STATE }
                        : {}),
                    },
              )
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .run()
            rows.push({ sessionId: session.id, turnId: null })
          } else if (turn?.status === 'running') {
            await tx
              .update(mcpRuntimeTestTurns)
              .set({
                cancelRequestedAt: turn.cancelRequestedAt ?? now,
                failureCode:
                  turn.failureCode ??
                  (turn.hardDeadlineAt <= now
                    ? 'mcp-test-turn-timeout'
                    : 'mcp-test-daemon-shutdown'),
              })
              .where(eq(mcpRuntimeTestTurns.id, turn.id))
              .run()
            await tx
              .update(mcpRuntimeTestSessions)
              .set({ sessionVersion: session.sessionVersion + 1, updatedAt: now })
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .run()
            rows.push({ sessionId: session.id, turnId: turn.id })
          } else {
            rows.push({ sessionId: session.id, turnId: null })
          }
        }
        return rows
      })
    },

    async listEndingWithoutInFlight() {
      const rows = await db
        .select({ id: mcpRuntimeTestSessions.id })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.status, 'ending'),
            isNull(mcpRuntimeTestSessions.inFlightTurnId),
          ),
        )
        .all()
      return rows.map((row) => row.id)
    },

    async findCreateReceipt(input) {
      return (
        (await db
          .select()
          .from(mcpRuntimeTestCreateReceipts)
          .where(
            and(
              eq(mcpRuntimeTestCreateReceipts.mcpId, input.mcpId),
              eq(mcpRuntimeTestCreateReceipts.ownerUserId, input.ownerUserId),
              eq(mcpRuntimeTestCreateReceipts.clientCreateId, input.clientCreateId),
            ),
          )
          .get()) ?? null
      )
    },

    async create(input: McpRuntimeTestCreatePersistenceInput) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const replay = await tx
          .select()
          .from(mcpRuntimeTestCreateReceipts)
          .where(
            and(
              eq(mcpRuntimeTestCreateReceipts.mcpId, input.mcpId),
              eq(mcpRuntimeTestCreateReceipts.ownerUserId, input.ownerUserId),
              eq(mcpRuntimeTestCreateReceipts.clientCreateId, input.clientCreateId),
            ),
          )
          .get()
        if (replay !== undefined) {
          if (replay.requestDigest !== input.requestDigest) {
            throw new ConflictError(
              'mcp-test-idempotency-mismatch',
              'clientCreateId was already used with different inputs',
            )
          }
          return {
            sessionId: replay.sessionId,
            acceptedTurnId: replay.acceptedTurnId,
            shouldQueue: false,
          }
        }
        const live = await tx
          .select({ id: mcpRuntimeTestSessions.id, status: mcpRuntimeTestSessions.status })
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              eq(mcpRuntimeTestSessions.ownerUserId, input.ownerUserId),
              inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
            ),
          )
          .get()
        if (live !== undefined) {
          throw new ConflictError(
            'mcp-test-session-exists',
            'an MCP test session is already active',
            { sessionId: live.id, status: live.status },
          )
        }
        const quarantined = await tx
          .select({ id: mcpRuntimeTestSessions.id })
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              eq(mcpRuntimeTestSessions.ownerUserId, input.ownerUserId),
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
        const replaceable = await tx
          .select({ id: mcpRuntimeTestSessions.id })
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              eq(mcpRuntimeTestSessions.ownerUserId, input.ownerUserId),
              eq(mcpRuntimeTestSessions.status, 'ended'),
              eq(mcpRuntimeTestSessions.cleanupState, 'complete'),
            ),
          )
          .all()
        for (const previous of replaceable) {
          await tx
            .delete(mcpRuntimeTestSessions)
            .where(eq(mcpRuntimeTestSessions.id, previous.id))
            .run()
        }
        await tx
          .insert(mcpRuntimeTestSessions)
          .values({
            id: input.sessionId,
            mcpId: input.mcpId,
            ownerUserId: input.ownerUserId,
            clientCreateId: input.clientCreateId,
            clientCreateDigest: input.requestDigest,
            status: 'active',
            endReason: null,
            mcpConfigHash: input.mcpConfigHash,
            runtimeRowId: input.runtimeRowId,
            runtimeName: input.runtimeName,
            runtimeProtocol: input.runtimeProtocol,
            runtimeSnapshotJson: input.runtimeSnapshotJson,
            runtimeBinaryPath: input.runtimeBinaryPath,
            runtimeSessionId: input.runtimeSessionId,
            nativeSessionState: 'pending',
            inFlightTurnId: input.turnId,
            turnSeq: 1,
            sessionVersion: 1,
            idleDeadlineAt: null,
            scratchRoot: input.scratchRoot,
            cleanupState: 'not-started',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        await tx
          .insert(mcpRuntimeTestTurns)
          .values({
            id: input.turnId,
            sessionId: input.sessionId,
            seq: 1,
            clientMessageId: input.clientMessageId,
            promptText: input.message,
            status: 'queued',
            hardDeadlineAt: input.hardDeadlineAt,
            captureState: 'live',
            createdAt: input.now,
          })
          .run()
        await tx
          .insert(mcpRuntimeTestCreateReceipts)
          .values({
            mcpId: input.mcpId,
            ownerUserId: input.ownerUserId,
            clientCreateId: input.clientCreateId,
            requestDigest: input.requestDigest,
            sessionId: input.sessionId,
            acceptedTurnId: input.turnId,
            createdAt: input.now,
            expiresAt: input.receiptExpiresAt,
          })
          .run()
        return { sessionId: input.sessionId, acceptedTurnId: input.turnId, shouldQueue: true }
      })
    },

    async findTurnByClientMessage(sessionId, clientMessageId) {
      return (
        (await db
          .select()
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.sessionId, sessionId),
              eq(mcpRuntimeTestTurns.clientMessageId, clientMessageId),
            ),
          )
          .get()) ?? null
      )
    },

    async acceptMessage(input: McpRuntimeTestAcceptMessageInput) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const replay = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.sessionId, input.sessionId),
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
          const session = await tx
            .select({ version: mcpRuntimeTestSessions.sessionVersion })
            .from(mcpRuntimeTestSessions)
            .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
            .get()
          return {
            turnId: replay.id,
            version: session?.version ?? input.expectedSessionVersion,
            shouldQueue: false,
          }
        }
        const current = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (current === undefined || current.mcpId !== input.mcpId) {
          throw new NotFoundError('mcp-test-session-not-found', 'MCP test session not found')
        }
        if (
          current.status !== 'active' ||
          current.inFlightTurnId !== null ||
          !canResumeNativeSession(current)
        ) {
          throw new ConflictError(
            'mcp-test-session-not-ready',
            'the MCP test session cannot accept another message',
            {
              sessionId: input.sessionId,
              status: current.status,
              inFlightTurnId: current.inFlightTurnId,
            },
          )
        }
        if (current.idleDeadlineAt === null || current.idleDeadlineAt <= input.now) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: 'idle-timeout',
              idleDeadlineAt: null,
              sessionVersion: current.sessionVersion + 1,
              updatedAt: input.now,
            })
            .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
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
        if (current.turnSeq >= input.maxTurns) {
          throw new ConflictError(
            'mcp-test-turn-limit',
            `an MCP test session supports at most ${input.maxTurns} turns`,
          )
        }
        const seq = current.turnSeq + 1
        await tx
          .insert(mcpRuntimeTestTurns)
          .values({
            id: input.turnId,
            sessionId: input.sessionId,
            seq,
            clientMessageId: input.clientMessageId,
            promptText: input.message,
            status: 'queued',
            hardDeadlineAt: input.hardDeadlineAt,
            captureState: 'live',
            createdAt: input.now,
          })
          .run()
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            inFlightTurnId: input.turnId,
            idleDeadlineAt: null,
            turnSeq: seq,
            sessionVersion: current.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return { turnId: input.turnId, version: current.sessionVersion + 1, shouldQueue: true }
      })
    },

    async cancel(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.id, input.turnId),
              eq(mcpRuntimeTestTurns.sessionId, input.sessionId),
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
          await tx
            .update(mcpRuntimeTestTurns)
            .set({
              status: 'canceled',
              cancelRequestedAt: input.now,
              captureState: 'complete',
              finishedAt: input.now,
              durationMs: 0,
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          if (canResumeNativeSession(session)) {
            await tx
              .update(mcpRuntimeTestSessions)
              .set({
                inFlightTurnId: null,
                idleDeadlineAt: input.idleDeadlineAt,
                sessionVersion: session.sessionVersion + 1,
                updatedAt: input.now,
              })
              .where(eq(mcpRuntimeTestSessions.id, session.id))
              .run()
            return { abort: false, cleanup: false }
          }
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: 'session-unusable',
              inFlightTurnId: null,
              idleDeadlineAt: null,
              nativeSessionState: 'unusable',
              sessionVersion: session.sessionVersion + 1,
              updatedAt: input.now,
            })
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          return { abort: false, cleanup: true }
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({ cancelRequestedAt: turn.cancelRequestedAt ?? input.now })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        await tx
          .update(mcpRuntimeTestSessions)
          .set({ sessionVersion: session.sessionVersion + 1, updatedAt: input.now })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return { abort: true, cleanup: false }
      })
    },

    async end(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
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
            : await tx
                .select()
                .from(mcpRuntimeTestTurns)
                .where(eq(mcpRuntimeTestTurns.id, session.inFlightTurnId))
                .get()
        let inFlightTurnId = session.inFlightTurnId
        if (turn?.status === 'queued') {
          await tx
            .update(mcpRuntimeTestTurns)
            .set({
              status: 'interrupted',
              cancelRequestedAt: input.now,
              captureState: 'complete',
              failureCode: 'mcp-test-ended',
              finishedAt: input.now,
              durationMs: 0,
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          inFlightTurnId = null
        } else if (turn?.status === 'running') {
          await tx
            .update(mcpRuntimeTestTurns)
            .set({ cancelRequestedAt: turn.cancelRequestedAt ?? input.now })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: 'user',
            inFlightTurnId,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return { turnId: inFlightTurnId, cleanup: inFlightTurnId === null }
      })
    },

    async loadSession(sessionId, mcpId) {
      const row = await db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          mcpId === undefined
            ? eq(mcpRuntimeTestSessions.id, sessionId)
            : and(
                eq(mcpRuntimeTestSessions.id, sessionId),
                eq(mcpRuntimeTestSessions.mcpId, mcpId),
              ),
        )
        .get()
      return row ?? null
    },

    async loadTurn(turnId) {
      return (
        (await db
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, turnId))
          .get()) ?? null
      )
    },

    async findLatestSession(mcpId, ownerUserId) {
      const live = await db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.mcpId, mcpId),
            eq(mcpRuntimeTestSessions.ownerUserId, ownerUserId),
            inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
          ),
        )
        .orderBy(desc(mcpRuntimeTestSessions.updatedAt))
        .limit(1)
        .get()
      return (
        live ??
        (await db
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, mcpId),
              eq(mcpRuntimeTestSessions.ownerUserId, ownerUserId),
              eq(mcpRuntimeTestSessions.status, 'ended'),
            ),
          )
          .orderBy(desc(mcpRuntimeTestSessions.updatedAt))
          .limit(1)
          .get()) ??
        null
      )
    },

    async listTurns(sessionId) {
      return await db
        .select()
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.sessionId, sessionId))
        .orderBy(asc(mcpRuntimeTestTurns.seq))
        .all()
    },

    async listEvents(sessionId) {
      return await db
        .select({
          id: mcpRuntimeTestEvents.eventSeq,
          ts: mcpRuntimeTestEvents.ts,
          kind: mcpRuntimeTestEvents.kind,
          payload: mcpRuntimeTestEvents.payload,
          sessionId: mcpRuntimeTestEvents.sessionId,
          parentSessionId: mcpRuntimeTestEvents.parentSessionId,
          source: mcpRuntimeTestEvents.source,
        })
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, sessionId))
        .orderBy(asc(mcpRuntimeTestEvents.eventSeq))
        .all()
    },

    async latestEventSequence(sessionId) {
      return (
        (
          await db
            .select({ seq: mcpRuntimeTestEvents.eventSeq })
            .from(mcpRuntimeTestEvents)
            .where(eq(mcpRuntimeTestEvents.testSessionId, sessionId))
            .orderBy(desc(mcpRuntimeTestEvents.eventSeq))
            .limit(1)
            .get()
        )?.seq ?? 0
      )
    },

    async loadBroadcastSnapshot(sessionId): Promise<McpRuntimeTestBroadcastSnapshot | null> {
      const session = await db
        .select({
          ownerUserId: mcpRuntimeTestSessions.ownerUserId,
          sessionVersion: mcpRuntimeTestSessions.sessionVersion,
          inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
        })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, sessionId))
        .get()
      if (session === undefined) return null
      const turn = await db
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
      return {
        ...session,
        turnStatus: turn?.status ?? null,
        captureState: turn?.captureState ?? null,
        eventCursor: await persistence.latestEventSequence(sessionId),
      }
    },

    async invalidateMcp(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
            ),
          )
          .all()
        for (const row of rows) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason:
                input.reason === 'mcp-deleted' || row.status === 'active'
                  ? input.reason
                  : (row.endReason ?? input.reason),
              idleDeadlineAt: null,
              sessionVersion: row.sessionVersion + 1,
              updatedAt: input.now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        return rows.map((row) => ({ sessionId: row.id, turnId: row.inFlightTurnId }))
      })
    },

    async invalidateOwner(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.ownerUserId, input.ownerUserId),
              eq(mcpRuntimeTestSessions.status, 'active'),
            ),
          )
          .all()
        for (const row of rows) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: input.reason,
              idleDeadlineAt: null,
              sessionVersion: row.sessionVersion + 1,
              updatedAt: input.now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        return rows.map((row) => ({ sessionId: row.id, turnId: row.inFlightTurnId }))
      })
    },

    async markMcpConfigChanged(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              eq(mcpRuntimeTestSessions.status, 'active'),
            ),
          )
          .all()
        const idleSessionIds: string[] = []
        for (const row of rows) {
          if (row.inFlightTurnId === null) idleSessionIds.push(row.id)
          await tx
            .update(mcpRuntimeTestSessions)
            .set(
              row.inFlightTurnId === null
                ? {
                    status: 'ending',
                    endReason: 'mcp-config-changed',
                    continuationBlockedReason: 'mcp-config-changed',
                    idleDeadlineAt: null,
                    sessionVersion: row.sessionVersion + 1,
                    updatedAt: input.now,
                  }
                : {
                    continuationBlockedReason: 'mcp-config-changed',
                    sessionVersion: row.sessionVersion + 1,
                    updatedAt: input.now,
                  },
            )
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        const changedRows = await tx
          .select({ id: mcpRuntimeTestSessions.id })
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
              inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
            ),
          )
          .all()
        return { idleSessionIds, changedSessionIds: changedRows.map((row) => row.id) }
      })
    },

    async markRuntimeProfileChanged(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.runtimeName, input.runtimeName),
              eq(mcpRuntimeTestSessions.status, 'active'),
            ),
          )
          .all()
        const idleSessionIds: string[] = []
        for (const row of rows) {
          if (row.inFlightTurnId === null) idleSessionIds.push(row.id)
          await tx
            .update(mcpRuntimeTestSessions)
            .set(
              row.inFlightTurnId === null
                ? {
                    status: 'ending',
                    endReason: 'runtime-profile-changed',
                    continuationBlockedReason: 'runtime-profile-changed',
                    idleDeadlineAt: null,
                    sessionVersion: row.sessionVersion + 1,
                    updatedAt: input.now,
                  }
                : {
                    continuationBlockedReason: 'runtime-profile-changed',
                    sessionVersion: row.sessionVersion + 1,
                    updatedAt: input.now,
                  },
            )
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        const changedRows = await tx
          .select({ id: mcpRuntimeTestSessions.id })
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.runtimeName, input.runtimeName),
              inArray(mcpRuntimeTestSessions.status, ['active', 'ending']),
            ),
          )
          .all()
        return { idleSessionIds, changedSessionIds: changedRows.map((row) => row.id) }
      })
    },

    async invalidateRuntime(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(
            and(
              eq(mcpRuntimeTestSessions.runtimeName, input.runtimeName),
              eq(mcpRuntimeTestSessions.status, 'active'),
            ),
          )
          .all()
        for (const row of rows) {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: input.reason,
              idleDeadlineAt: null,
              sessionVersion: row.sessionVersion + 1,
              updatedAt: input.now,
            })
            .where(eq(mcpRuntimeTestSessions.id, row.id))
            .run()
        }
        return rows.map((row) => ({ sessionId: row.id, turnId: row.inFlightTurnId }))
      })
    },

    async assertMcpDeleteReady(mcpId) {
      const sessions = await db
        .select({
          id: mcpRuntimeTestSessions.id,
          status: mcpRuntimeTestSessions.status,
          cleanupState: mcpRuntimeTestSessions.cleanupState,
        })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.mcpId, mcpId))
        .all()
      const unsafe = sessions.find(
        (row) => row.status !== 'ended' || row.cleanupState !== 'complete',
      )
      if (unsafe !== undefined) {
        throw new ConflictError(
          'mcp-test-cleanup-incomplete',
          'an MCP runtime test could not be safely stopped',
          { sessionId: unsafe.id },
        )
      }
    },

    async expireIdle(now) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const rows = await tx
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
          await tx
            .update(mcpRuntimeTestSessions)
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
    },

    async listCleanupCandidates() {
      const rows = await db
        .select({ id: mcpRuntimeTestSessions.id })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.status, 'ended'),
            eq(mcpRuntimeTestSessions.cleanupState, 'pending'),
          ),
        )
        .all()
      return rows.map((row) => row.id)
    },

    async listExpiredReceipts(now) {
      return await db
        .select()
        .from(mcpRuntimeTestCreateReceipts)
        .where(lte(mcpRuntimeTestCreateReceipts.expiresAt, now))
        .all()
    },

    async deleteExpiredReceipt(receipt, now) {
      await db
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
    },

    async listQuarantinedCandidates() {
      const sessions = await db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.status, 'ended'),
            eq(mcpRuntimeTestSessions.cleanupState, 'quarantined'),
          ),
        )
        .all()
      return Promise.all(
        sessions.map(async (session): Promise<McpRuntimeTestQuarantinedCandidate> => {
          const turn = await db
            .select()
            .from(mcpRuntimeTestTurns)
            .where(
              and(
                eq(mcpRuntimeTestTurns.sessionId, session.id),
                isNotNull(mcpRuntimeTestTurns.pid),
              ),
            )
            .orderBy(desc(mcpRuntimeTestTurns.seq))
            .limit(1)
            .get()
          return { session, turn: turn ?? null }
        }),
      )
    },

    async recoverQuarantined(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select({ pid: mcpRuntimeTestTurns.pid })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (
          session?.status !== 'ended' ||
          session.cleanupState !== 'quarantined' ||
          turn?.pid !== input.expectedPid
        ) {
          return false
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({ pid: null })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            cleanupState: 'pending',
            cleanupErrorCode: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return true
      })
    },

    async expireTurns(now, idleDeadlineAt): Promise<McpRuntimeTestExpiredTurnResult> {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const turns = await tx
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
          const session = await tx
            .select()
            .from(mcpRuntimeTestSessions)
            .where(eq(mcpRuntimeTestSessions.id, turn.sessionId))
            .get()
          if (session?.status !== 'active' || session.inFlightTurnId !== turn.id) continue
          if (turn.status === 'running') {
            if (turn.cancelRequestedAt === null || turn.failureCode !== 'mcp-test-turn-timeout') {
              await tx
                .update(mcpRuntimeTestTurns)
                .set({
                  cancelRequestedAt: turn.cancelRequestedAt ?? now,
                  failureCode: 'mcp-test-turn-timeout',
                })
                .where(eq(mcpRuntimeTestTurns.id, turn.id))
                .run()
              await tx
                .update(mcpRuntimeTestSessions)
                .set({ sessionVersion: session.sessionVersion + 1, updatedAt: now })
                .where(eq(mcpRuntimeTestSessions.id, session.id))
                .run()
            }
            abort.push({ sessionId: session.id, turnId: turn.id })
            continue
          }
          await tx
            .update(mcpRuntimeTestTurns)
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
          await tx
            .update(mcpRuntimeTestSessions)
            .set(
              resumable
                ? {
                    inFlightTurnId: null,
                    idleDeadlineAt,
                    sessionVersion: session.sessionVersion + 1,
                    updatedAt: now,
                  }
                : {
                    status: 'ending',
                    endReason: 'session-unusable',
                    nativeSessionState: 'unusable',
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
    },

    async listDurableIntentCandidates() {
      const rows = await db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
        .all()
      return rows.filter((row) => row.status === 'ending' || row.continuationBlockedReason !== null)
    },

    async settleQueuedDurableIntent(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (
          session?.status !== 'ending' ||
          session.inFlightTurnId !== input.turnId ||
          turn?.status !== 'queued'
        ) {
          return false
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({
            status: 'interrupted',
            cancelRequestedAt: input.now,
            captureState: 'complete',
            failureCode: `mcp-test-${session.endReason ?? 'invalidated'}`,
            finishedAt: input.now,
            durationMs: 0,
          })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            inFlightTurnId: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return true
      })
    },

    async requestRunningTurnCancel(turnId, now) {
      await db
        .update(mcpRuntimeTestTurns)
        .set({
          cancelRequestedAt: sql`coalesce(${mcpRuntimeTestTurns.cancelRequestedAt}, ${now})`,
        })
        .where(and(eq(mcpRuntimeTestTurns.id, turnId), eq(mcpRuntimeTestTurns.status, 'running')))
        .run()
    },

    async clearTerminalDurableIntent(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (session?.status !== 'ending' || session.inFlightTurnId !== input.turnId) return false
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            inFlightTurnId: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return true
      })
    },

    async listBootSessions() {
      return await db
        .select()
        .from(mcpRuntimeTestSessions)
        .where(inArray(mcpRuntimeTestSessions.status, ['active', 'ending']))
        .all()
    },

    async recoverBootSession(input: McpRuntimeTestBootRecoveryInput) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (
          session === undefined ||
          session.inFlightTurnId !== input.expectedTurnId ||
          !['active', 'ending'].includes(session.status)
        ) {
          return false
        }
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.expectedTurnId))
          .get()
        if (turn !== undefined && !isTerminalTurn(turn.status)) {
          await tx
            .update(mcpRuntimeTestTurns)
            .set({
              status: 'interrupted',
              captureState:
                turn.status === 'queued' || turn.captureState === 'complete'
                  ? 'complete'
                  : 'incomplete',
              captureIncompleteReason:
                turn.status === 'queued' || turn.captureState === 'complete'
                  ? null
                  : 'post-exit-flush-timeout',
              failureCode: 'mcp-test-daemon-restarted',
              pid: input.quarantine ? turn.pid : null,
              finishedAt: input.now,
              durationMs: turn.startedAt === null ? 0 : Math.max(0, input.now - turn.startedAt),
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set(
            input.resumable
              ? {
                  inFlightTurnId: null,
                  idleDeadlineAt: input.idleDeadlineAt,
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: input.now,
                }
              : {
                  status: 'ending',
                  endReason: session.endReason ?? 'session-unusable',
                  nativeSessionState: 'unusable',
                  continuationBlockedReason:
                    session.continuationBlockedReason ??
                    (session.nativeSessionState === 'ready' ? 'capture-incomplete' : null),
                  inFlightTurnId: null,
                  idleDeadlineAt: null,
                  sessionVersion: session.sessionVersion + 1,
                  updatedAt: input.now,
                  ...(input.quarantine
                    ? {
                        cleanupState: QUARANTINED_CLEANUP_STATE,
                        cleanupErrorCode: `mcp-test-boot-reap-${input.reapOutcome}`,
                      }
                    : {}),
                },
          )
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return true
      })
    },

    async admitTurn(input): Promise<McpRuntimeTestAdmittedTurn | null> {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
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
        if (turn.hardDeadlineAt <= input.now) {
          const resumable = canResumeNativeSession(session)
          await tx
            .update(mcpRuntimeTestTurns)
            .set({
              status: 'timed_out',
              captureState: 'complete',
              failureCode: 'mcp-test-turn-timeout',
              finishedAt: input.now,
              durationMs: input.now - turn.createdAt,
            })
            .where(eq(mcpRuntimeTestTurns.id, turn.id))
            .run()
          await tx
            .update(mcpRuntimeTestSessions)
            .set(
              resumable
                ? {
                    inFlightTurnId: null,
                    idleDeadlineAt: input.idleDeadlineAt,
                    sessionVersion: session.sessionVersion + 1,
                    updatedAt: input.now,
                  }
                : {
                    status: 'ending',
                    endReason: 'session-unusable',
                    inFlightTurnId: null,
                    idleDeadlineAt: null,
                    nativeSessionState: 'unusable',
                    sessionVersion: session.sessionVersion + 1,
                    updatedAt: input.now,
                  },
            )
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          return null
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({ status: 'running', startedAt: input.now })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()
        return { session, turn: { ...turn, status: RUNNING_TURN_STATUS, startedAt: input.now } }
      })
    },

    async isSpawnAllowed(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select({
            status: mcpRuntimeTestSessions.status,
            inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
          })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select({
            status: mcpRuntimeTestTurns.status,
            cancelRequestedAt: mcpRuntimeTestTurns.cancelRequestedAt,
            hardDeadlineAt: mcpRuntimeTestTurns.hardDeadlineAt,
          })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        return (
          session?.status === 'active' &&
          session.inFlightTurnId === input.turnId &&
          turn?.status === 'running' &&
          turn.cancelRequestedAt === null &&
          turn.hardDeadlineAt > input.now
        )
      })
    },

    async recordSpawn(input: McpRuntimeTestSpawnReceiptInput) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (session === undefined || turn === undefined) {
          throw new Error('mcp-test-spawn-receipt-owner-missing')
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({
            pid: input.pid,
            spawnedAt: input.spawnedAt,
            spawnBinaryPath: input.spawnBinaryPath,
          })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        const expired = turn.hardDeadlineAt <= input.fenceAt
        if (expired) {
          await tx
            .update(mcpRuntimeTestTurns)
            .set({
              cancelRequestedAt: turn.cancelRequestedAt ?? input.fenceAt,
              failureCode: 'mcp-test-turn-timeout',
            })
            .where(eq(mcpRuntimeTestTurns.id, input.turnId))
            .run()
        }
        return (
          session.status === 'active' &&
          session.inFlightTurnId === input.turnId &&
          turn.status === 'running' &&
          turn.cancelRequestedAt === null &&
          !expired
        )
      })
    },

    async failBeforeRun(input) {
      runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (session === undefined || session.status === 'ended') return
        const ending = session.status === 'ending'
        await tx
          .update(mcpRuntimeTestTurns)
          .set({
            status: ending ? 'interrupted' : 'failed',
            captureState: 'complete',
            failureCode:
              ending && session.endReason !== null
                ? `mcp-test-${session.endReason}`
                : input.failureCode,
            finishedAt: input.now,
          })
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .run()
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: session.endReason ?? input.endReason,
            inFlightTurnId: null,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
      })
    },

    async settleTurn(input: McpRuntimeTestSettlementInput) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        const turn = await tx
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, input.turnId))
          .get()
        if (session === undefined || turn === undefined || isTerminalTurn(turn.status)) {
          return session?.status === 'ending'
        }

        let nativeState = session.nativeSessionState
        let nativeSessionId = session.runtimeSessionId
        let blocked = session.continuationBlockedReason
        if (input.nativeSessionIntegrityFailed) {
          nativeState = 'unusable'
          blocked ??= 'capture-incomplete'
        } else if (input.capturedSessionId !== null) {
          if (nativeSessionId !== null && nativeSessionId !== input.capturedSessionId) {
            nativeState = 'unusable'
          } else {
            nativeSessionId = input.capturedSessionId
            nativeState = 'ready'
          }
        } else if (input.originalTurnSeq === 1) {
          nativeState = 'unusable'
        }
        if (input.childUnreaped) {
          nativeState = 'unusable'
          blocked ??= 'capture-incomplete'
        }
        await tx
          .update(mcpRuntimeTestTurns)
          .set({
            status: input.status,
            exitCode: input.exitCode,
            failureCode: input.failureCode,
            stderrTail: input.stderrTail,
            durationMs: input.durationMs,
            finishedAt: input.now,
            pid: input.childUnreaped ? turn.pid : null,
          })
          .where(eq(mcpRuntimeTestTurns.id, turn.id))
          .run()

        const captureBlocked =
          turn.captureState === 'truncated' || turn.captureState === 'incomplete'
        const mustEnd =
          session.status === 'ending' ||
          nativeState !== 'ready' ||
          blocked !== null ||
          captureBlocked
        if (mustEnd) {
          const reasonFromBlock =
            blocked === 'mcp-config-changed'
              ? 'mcp-config-changed'
              : blocked === 'runtime-profile-changed'
                ? 'runtime-profile-changed'
                : 'session-unusable'
          const reason =
            session.endReason ??
            (input.nativeSessionIntegrityFailed
              ? 'session-unusable'
              : captureBlocked
                ? turn.captureState === 'truncated'
                  ? 'capture-truncated'
                  : 'capture-incomplete'
                : reasonFromBlock)
          await tx
            .update(mcpRuntimeTestSessions)
            .set({
              status: 'ending',
              endReason: reason,
              runtimeSessionId: nativeSessionId,
              nativeSessionState: nativeState,
              continuationBlockedReason: blocked,
              inFlightTurnId: null,
              idleDeadlineAt: null,
              sessionVersion: session.sessionVersion + 1,
              updatedAt: input.now,
              ...(input.childUnreaped
                ? {
                    cleanupState: QUARANTINED_CLEANUP_STATE,
                    cleanupErrorCode: 'mcp-test-child-unreaped',
                  }
                : {}),
            })
            .where(eq(mcpRuntimeTestSessions.id, session.id))
            .run()
          return true
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            runtimeSessionId: nativeSessionId,
            nativeSessionState: nativeState,
            inFlightTurnId: null,
            idleDeadlineAt: input.idleDeadlineAt,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
        return false
      })
    },

    async invalidateSession(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (session === undefined || session.status !== 'active') {
          return session?.inFlightTurnId ?? null
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            status: 'ending',
            endReason: input.reason,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: input.now,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return session.inFlightTurnId
      })
    },

    async prepareCleanup(sessionId, now) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, sessionId))
          .get()
        if (
          session === undefined ||
          session.inFlightTurnId !== null ||
          (session.status !== 'ending' &&
            !(session.status === 'ended' && session.cleanupState === 'pending'))
        ) {
          return null
        }
        const running = await tx
          .select({ id: mcpRuntimeTestTurns.id })
          .from(mcpRuntimeTestTurns)
          .where(
            and(
              eq(mcpRuntimeTestTurns.sessionId, sessionId),
              inArray(mcpRuntimeTestTurns.status, ['queued', 'running']),
            ),
          )
          .get()
        if (running !== undefined) return null
        if (session.cleanupState !== 'quarantined') {
          await tx
            .update(mcpRuntimeTestSessions)
            .set({ cleanupState: 'pending', updatedAt: now })
            .where(eq(mcpRuntimeTestSessions.id, sessionId))
            .run()
        }
        return {
          scratchRoot: session.scratchRoot,
          cleanupState: session.cleanupState === 'quarantined' ? 'quarantined' : 'pending',
          cleanupErrorCode: session.cleanupErrorCode,
        }
      })
    },

    async finishCleanup(input) {
      return runPostgresqlResourceCatalogTransaction(db, async (tx) => {
        const session = await tx
          .select()
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .get()
        if (
          session === undefined ||
          session.inFlightTurnId !== null ||
          (session.status !== 'ending' &&
            !(session.status === 'ended' && session.cleanupState === 'pending'))
        ) {
          return false
        }
        await tx
          .update(mcpRuntimeTestSessions)
          .set({
            status: 'ended',
            cleanupState: input.cleanupState,
            cleanupErrorCode: input.cleanupErrorCode,
            endedAt: session.endedAt ?? input.now,
            updatedAt: input.now,
            sessionVersion: session.sessionVersion + 1,
          })
          .where(eq(mcpRuntimeTestSessions.id, input.sessionId))
          .run()
        return true
      })
    },

    async nextDeadline() {
      const earliestIdle = (
        await db
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
          .get()
      )?.deadline
      const activeInFlight = await db
        .select({ turnId: mcpRuntimeTestSessions.inFlightTurnId })
        .from(mcpRuntimeTestSessions)
        .where(
          and(
            eq(mcpRuntimeTestSessions.status, 'active'),
            isNotNull(mcpRuntimeTestSessions.inFlightTurnId),
          ),
        )
        .all()
      let earliestTurn: number | null = null
      for (const row of activeInFlight) {
        if (row.turnId === null) continue
        const turn = await db
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
      return deadlines.length === 0 ? null : Math.min(...deadlines)
    },
  }

  return Object.freeze(persistence)
}
