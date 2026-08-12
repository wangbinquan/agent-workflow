// RFC-293 — pure working-context delta. Persistence, ACL reads and turn
// reservation live at the service boundary; this function owns only manifest
// semantics so legacy mounts and the queued path cannot drift apart.

import { and, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  canonicalJson,
  IntentWorkingSetDeltaSchema,
  type IntentWorkingSetChangeDto,
  type IntentWorkingSetDelta,
  type PostIntentWorkingSetChange,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  intentApplyJournal,
  intentSessions,
  intentTurns,
  intentWorkingSetChanges,
} from '@/db/schema'
import { ACL_TABLES, canViewResourceInTx, type AclRow } from '@/services/resourceAcl'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import { sha256Hex } from '@/util/hash'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { ReservedIntentTurn } from './session'
import {
  allocateHandle,
  createHandleAllocator,
  handleWatermarkOf,
  manifestEntryFor,
  mergeHandleWatermarks,
  type IntentContextManifest,
  type IntentHandleWatermark,
} from './manifest'

export interface AppliedIntentWorkingSetDelta {
  manifest: IntentContextManifest
  handleWatermark: IntentHandleWatermark
  changed: boolean
  addedHandles: string[]
  removedHandles: string[]
}

export type IntentWorkingSetChangeRow = typeof intentWorkingSetChanges.$inferSelect

export interface SubmittedIntentWorkingSetChange {
  change: IntentWorkingSetChangeDto
  reservation: ReservedIntentTurn | null
  shouldInterrupt: boolean
}

export interface DrainedIntentWorkingSetChange {
  change: IntentWorkingSetChangeDto | null
  reservation: ReservedIntentTurn | null
}

function parseBudget(row: typeof intentSessions.$inferSelect): {
  generateRounds: number
  questionRounds: number
} {
  let parsed: { generateRounds?: unknown; questionRounds?: unknown } = {}
  try {
    parsed = JSON.parse(row.budgetJson) as typeof parsed
  } catch {
    // Older/corrupt auxiliary counters fall back to zero, matching session.ts.
  }
  return {
    generateRounds:
      typeof parsed.generateRounds === 'number' && Number.isInteger(parsed.generateRounds)
        ? parsed.generateRounds
        : 0,
    questionRounds:
      typeof parsed.questionRounds === 'number' && Number.isInteger(parsed.questionRounds)
        ? parsed.questionRounds
        : 0,
  }
}

function assertBudget(
  row: typeof intentSessions.$inferSelect,
  maxGenerateRounds: number,
): ReturnType<typeof parseBudget> {
  const budget = parseBudget(row)
  if (budget.generateRounds + budget.questionRounds >= maxGenerateRounds) {
    throw new ConflictError(
      'intent-budget-exhausted',
      `session reached its generation budget (${maxGenerateRounds}); raise intentBuilderMaxGenerateRounds or archive`,
    )
  }
  return budget
}

function assertWritable(actor: Actor, row: typeof intentSessions.$inferSelect): void {
  if (row.ownerUserId !== actor.user.id) {
    throw new NotFoundError('intent-session-not-found', `intent session '${row.id}' not found`)
  }
  if (row.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived; reopen it first')
  }
}

function assertNoApply(
  tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
  sessionId: string,
) {
  const rows = tx
    .select({ state: intentApplyJournal.state })
    .from(intentApplyJournal)
    .where(eq(intentApplyJournal.sessionId, sessionId))
    .all()
  if (rows.some((row) => row.state === 'prepared' || row.state === 'applying')) {
    throw new ConflictError(
      'intent-apply-in-flight',
      'a commit is being applied for this session; wait for it to settle',
    )
  }
}

function requestHash(input: PostIntentWorkingSetChange): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`
}

function parseDelta(row: IntentWorkingSetChangeRow): IntentWorkingSetDelta {
  return IntentWorkingSetDeltaSchema.parse(JSON.parse(row.deltaJson))
}

export function projectIntentWorkingSetChange(
  row: IntentWorkingSetChangeRow,
): IntentWorkingSetChangeDto {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    delta: parseDelta(row),
    expectedTurnSeq: row.expectedTurnSeq,
    expectedContextRevision: row.expectedContextRevision,
    resultingContextRevision: row.resultingContextRevision,
    resultingTurnId: row.resultingTurnId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getLatestIntentWorkingSetChange(
  db: DbClient,
  sessionId: string,
): Promise<IntentWorkingSetChangeRow | null> {
  return (
    (
      await db
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.sessionId, sessionId))
        .orderBy(desc(intentWorkingSetChanges.createdAt), desc(intentWorkingSetChanges.id))
        .limit(1)
    )[0] ?? null
  )
}

function validateAdditionsInTx(
  tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
  actor: Actor,
  delta: IntentWorkingSetDelta,
): void {
  for (const ref of delta.additions) {
    const table = ACL_TABLES[ref.resourceType]
    const row = tx
      .select({ id: table.id, ownerUserId: table.ownerUserId, visibility: table.visibility })
      .from(table)
      .where(eq(table.id, ref.resourceId))
      .get() as AclRow | undefined
    if (row === undefined || !canViewResourceInTx(tx, actor, ref.resourceType, row)) {
      throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
    }
  }
}

/**
 * Apply one complete staged delta to an immutable copy of the manifest.
 *
 * - only explicit roots may be removed;
 * - adding a closure/inventory entry promotes its existing handle;
 * - new handles seed from the persisted high-water mark;
 * - add+remove of the same resource is rejected instead of order-dependent;
 * - no product-level root cap is introduced.
 */
export function applyIntentWorkingSetDelta(
  manifest: readonly IntentContextManifest[number][],
  watermark: IntentHandleWatermark,
  delta: IntentWorkingSetDelta,
): AppliedIntentWorkingSetDelta {
  const next: IntentContextManifest = manifest.map((entry) => ({ ...entry }))
  const byHandle = new Map(next.map((entry) => [entry.handle, entry]))
  const removing = new Set(delta.removals)

  for (const handle of delta.removals) {
    const entry = byHandle.get(handle)
    if (entry === undefined || !entry.root) {
      throw new ValidationError('intent-mount-not-found', 'working-context root not found')
    }
  }

  for (const addition of delta.additions) {
    const existing = manifestEntryFor(next, addition.resourceType, addition.resourceId)
    if (existing !== undefined && removing.has(existing.handle)) {
      throw new ValidationError(
        'intent-working-set-contradiction',
        'the same resource cannot be added and removed in one update',
      )
    }
  }

  const removedHandles: string[] = []
  for (const handle of delta.removals) {
    const entry = byHandle.get(handle)!
    entry.root = false
    removedHandles.push(handle)
  }

  const allocator = createHandleAllocator(next, watermark)
  const addedHandles: string[] = []
  for (const addition of delta.additions) {
    const existing = manifestEntryFor(next, addition.resourceType, addition.resourceId)
    if (existing !== undefined) {
      if (!existing.root) {
        existing.root = true
        addedHandles.push(existing.handle)
      }
      continue
    }
    const handle = allocateHandle(allocator, addition.resourceType, addition.resourceId)
    next.push({
      handle,
      resourceType: addition.resourceType,
      resourceId: addition.resourceId,
      root: true,
      detail: false,
    })
    addedHandles.push(handle)
  }

  return {
    manifest: next,
    handleWatermark: mergeHandleWatermarks(watermark, handleWatermarkOf(allocator)),
    changed: addedHandles.length > 0 || removedHandles.length > 0,
    addedHandles,
    removedHandles,
  }
}

function markWorkingSetChangeFailed(
  db: DbClient,
  changeId: string,
  error: unknown,
): IntentWorkingSetChangeRow | null {
  const message =
    error instanceof DomainError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error)
  return dbTxSync(db, (tx) => {
    const row = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(eq(intentWorkingSetChanges.id, changeId))
      .get()
    if (row === undefined || row.state !== 'queued') return row ?? null
    const now = Date.now()
    tx.update(intentWorkingSetChanges)
      .set({ state: 'failed', error: message.slice(0, 2000), updatedAt: now })
      .where(eq(intentWorkingSetChanges.id, changeId))
      .run()
    return (
      tx
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, changeId))
        .get() ?? null
    )
  })
}

/**
 * Claim one queued working-context update and atomically apply its full delta,
 * append a product-readable history turn, and reserve exactly one successor.
 */
export function activateIntentWorkingSetChange(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  maxGenerateRounds: number,
  changeId?: string,
): DrainedIntentWorkingSetChange {
  const candidate = dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) return null
    assertWritable(actor, session)
    if (session.inFlightTurnId !== null) return null
    const rows = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(
        changeId === undefined
          ? and(
              eq(intentWorkingSetChanges.sessionId, sessionId),
              eq(intentWorkingSetChanges.state, 'queued'),
            )
          : and(
              eq(intentWorkingSetChanges.id, changeId),
              eq(intentWorkingSetChanges.sessionId, sessionId),
              eq(intentWorkingSetChanges.state, 'queued'),
            ),
      )
      .orderBy(intentWorkingSetChanges.createdAt, intentWorkingSetChanges.id)
      .limit(1)
      .all()
    return rows[0] ?? null
  })
  if (candidate === null) return { change: null, reservation: null }

  try {
    const activated = dbTxSync(db, (tx) => {
      const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
      const row = tx
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, candidate.id))
        .get()
      if (session === undefined || row === undefined || row.state !== 'queued') return null
      assertWritable(actor, session)
      if (session.inFlightTurnId !== null) return null
      assertNoApply(tx, sessionId)
      const delta = parseDelta(row)
      validateAdditionsInTx(tx, actor, delta)
      const applied = applyIntentWorkingSetDelta(
        JSON.parse(session.contextManifestJson) as IntentContextManifest,
        JSON.parse(session.handleWatermarkJson) as IntentHandleWatermark,
        delta,
      )
      const budget = assertBudget(session, maxGenerateRounds)
      const now = Date.now()
      const userTurnId = ulid()
      const agentTurnId = ulid()
      const envelopeNonce = generateEnvelopeNonce()
      const contextRevision = session.contextRevision + (applied.changed ? 1 : 0)
      const userSeq = session.turnSeq + 1
      const agentSeq = userSeq + 1
      const message =
        `Working context refreshed: ${applied.addedHandles.length} added, ` +
        `${applied.removedHandles.length} removed. Continue the intent using the updated context.`

      tx.update(intentWorkingSetChanges)
        .set({ state: 'applying', error: null, updatedAt: now })
        .where(eq(intentWorkingSetChanges.id, row.id))
        .run()
      tx.insert(intentTurns)
        .values({
          id: userTurnId,
          sessionId,
          seq: userSeq,
          role: 'user',
          kind: 'message',
          contentJson: JSON.stringify({
            message,
            workingSetChangeId: row.id,
            addedHandles: applied.addedHandles,
            removedHandles: applied.removedHandles,
          }),
          contextRevision,
          createdAt: now,
        })
        .run()
      tx.insert(intentTurns)
        .values({
          id: agentTurnId,
          sessionId,
          seq: agentSeq,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision,
          envelopeNonce,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          createdAt: now,
        })
        .run()
      tx.update(intentSessions)
        .set({
          contextManifestJson: JSON.stringify(applied.manifest),
          handleWatermarkJson: JSON.stringify(applied.handleWatermark),
          contextRevision,
          inFlightTurnId: agentTurnId,
          turnSeq: agentSeq,
          updatedAt: now,
        })
        .where(eq(intentSessions.id, sessionId))
        .run()
      tx.update(intentWorkingSetChanges)
        .set({
          state: 'applied',
          resultingContextRevision: contextRevision,
          resultingTurnId: agentTurnId,
          updatedAt: now,
        })
        .where(eq(intentWorkingSetChanges.id, row.id))
        .run()
      const launchSession = tx
        .select()
        .from(intentSessions)
        .where(eq(intentSessions.id, sessionId))
        .get()
      const finalRow = tx
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, row.id))
        .get()
      if (launchSession === undefined || finalRow === undefined) {
        throw new Error('working-context activation vanished')
      }
      return {
        row: finalRow,
        reservation: {
          turnId: agentTurnId,
          envelopeNonce,
          launchSession,
          budget,
        } satisfies ReservedIntentTurn,
      }
    })
    if (activated === null) return { change: null, reservation: null }
    return {
      change: projectIntentWorkingSetChange(activated.row),
      reservation: activated.reservation,
    }
  } catch (error) {
    const failed = markWorkingSetChangeFailed(db, candidate.id, error)
    if (failed === null) throw error
    return { change: projectIntentWorkingSetChange(failed), reservation: null }
  }
}

/** Persist a staged delta. Idle sessions activate immediately; running ones
 * remain queued for the dispatcher. Same-mutation replay is side-effect free. */
export function submitIntentWorkingSetChange(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  input: PostIntentWorkingSetChange,
  maxGenerateRounds: number,
): SubmittedIntentWorkingSetChange {
  const hash = requestHash(input)
  const now = Date.now()
  const changeId = ulid()
  const admitted = dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    assertWritable(actor, session)
    assertNoApply(tx, sessionId)
    const replay = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(
        and(
          eq(intentWorkingSetChanges.sessionId, sessionId),
          eq(intentWorkingSetChanges.clientMutationId, input.clientMutationId),
        ),
      )
      .get()
    if (replay !== undefined) {
      if (replay.requestHash !== hash) {
        throw new ConflictError(
          'intent-mutation-conflict',
          'clientMutationId was already used for a different working-context request',
        )
      }
      return { row: replay, replayed: true, wasRunning: session.inFlightTurnId !== null }
    }
    if (
      session.turnSeq !== input.expectedTurnSeq ||
      session.contextRevision !== input.expectedContextRevision
    ) {
      throw new ConflictError(
        'intent-working-set-stale',
        'the session changed; refresh the working context before saving',
      )
    }
    const unresolved = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(
        and(
          eq(intentWorkingSetChanges.sessionId, sessionId),
          inArray(intentWorkingSetChanges.state, ['queued', 'applying', 'failed']),
        ),
      )
      .get()
    if (unresolved !== undefined) {
      if (input.replacesChangeId !== unresolved.id || unresolved.state === 'applying') {
        throw new ConflictError(
          'intent-working-set-pending',
          'another working-context update is still pending',
          { changeId: unresolved.id },
        )
      }
      tx.update(intentWorkingSetChanges)
        .set({ state: 'canceled', updatedAt: now })
        .where(eq(intentWorkingSetChanges.id, unresolved.id))
        .run()
    } else if (input.replacesChangeId !== undefined) {
      throw new ConflictError(
        'intent-working-set-stale',
        'the working-context update to replace is no longer pending',
      )
    }
    tx.insert(intentWorkingSetChanges)
      .values({
        id: changeId,
        sessionId,
        clientMutationId: input.clientMutationId,
        requestHash: hash,
        expectedTurnSeq: input.expectedTurnSeq,
        expectedContextRevision: input.expectedContextRevision,
        mode: input.mode,
        deltaJson: canonicalJson(input.delta),
        state: 'queued',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const row = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(eq(intentWorkingSetChanges.id, changeId))
      .get()
    if (row === undefined) throw new Error('working-context change vanished after insert')
    return { row, replayed: false, wasRunning: session.inFlightTurnId !== null }
  })

  if (admitted.replayed) {
    return {
      change: projectIntentWorkingSetChange(admitted.row),
      reservation: null,
      shouldInterrupt: false,
    }
  }
  if (!admitted.wasRunning) {
    const activated = activateIntentWorkingSetChange(
      db,
      actor,
      sessionId,
      maxGenerateRounds,
      admitted.row.id,
    )
    return {
      change: activated.change ?? projectIntentWorkingSetChange(admitted.row),
      reservation: activated.reservation,
      shouldInterrupt: false,
    }
  }
  return {
    change: projectIntentWorkingSetChange(admitted.row),
    reservation: null,
    shouldInterrupt: input.mode === 'interrupt',
  }
}

export function cancelIntentWorkingSetChange(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  changeId: string,
): IntentWorkingSetChangeDto {
  return projectIntentWorkingSetChange(
    dbTxSync(db, (tx) => {
      const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
      if (session === undefined) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${sessionId}' not found`,
        )
      }
      assertWritable(actor, session)
      const row = tx
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, changeId))
        .get()
      if (row === undefined || row.sessionId !== sessionId) {
        throw new NotFoundError('intent-working-set-not-found', 'working-context update not found')
      }
      if (row.state === 'applying') {
        throw new ConflictError('intent-working-set-applying', 'working-context update is applying')
      }
      if (row.state === 'queued' || row.state === 'failed') {
        tx.update(intentWorkingSetChanges)
          .set({ state: 'canceled', updatedAt: Date.now() })
          .where(eq(intentWorkingSetChanges.id, row.id))
          .run()
      }
      return (
        tx
          .select()
          .from(intentWorkingSetChanges)
          .where(eq(intentWorkingSetChanges.id, row.id))
          .get() ?? row
      )
    }),
  )
}

export function retryIntentWorkingSetChange(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  changeId: string,
  maxGenerateRounds: number,
): DrainedIntentWorkingSetChange {
  dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    assertWritable(actor, session)
    const row = tx
      .select()
      .from(intentWorkingSetChanges)
      .where(eq(intentWorkingSetChanges.id, changeId))
      .get()
    if (row === undefined || row.sessionId !== sessionId) {
      throw new NotFoundError('intent-working-set-not-found', 'working-context update not found')
    }
    if (row.state !== 'failed') {
      throw new ConflictError(
        'intent-working-set-not-failed',
        'only a failed update can be retried',
      )
    }
    tx.update(intentWorkingSetChanges)
      .set({ state: 'queued', error: null, updatedAt: Date.now() })
      .where(eq(intentWorkingSetChanges.id, row.id))
      .run()
  })
  return activateIntentWorkingSetChange(db, actor, sessionId, maxGenerateRounds, changeId)
}
