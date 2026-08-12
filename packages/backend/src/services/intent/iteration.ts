// RFC-293 — source-bound continuous Intent iteration.

import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  canonicalJson,
  IntentMountRequestsSchema,
  IntentQuestionsSchema,
  type IntentGenerationReceipt,
  type IntentMountRequest,
  type IntentMountSuggestionDecision,
  type PostIntentCurrentAction,
  type PostIntentIteration,
  type PostIntentRetry,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { intentDraftResolutions, intentDrafts, intentSessions, intentTurns } from '@/db/schema'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import { ACL_TABLES, canViewResourceInTx, type AclRow } from '@/services/resourceAcl'
import { sha256Hex } from '@/util/hash'
import { ConflictError, NotFoundError } from '@/util/errors'
import { assertNoUnsettledApply, type ReservedIntentTurn } from './session'
import { applyIntentWorkingSetDelta } from './workingSet'
import { parseHandleWatermark, type IntentContextManifest } from './manifest'

export interface ReservedIntentGeneration {
  receipt: IntentGenerationReceipt
  reservation: ReservedIntentTurn | null
}

function requestDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

function budgetOf(session: typeof intentSessions.$inferSelect): {
  generateRounds: number
  questionRounds: number
} {
  let parsed: { generateRounds?: unknown; questionRounds?: unknown } = {}
  try {
    parsed = JSON.parse(session.budgetJson) as typeof parsed
  } catch {
    // Keep the same legacy fallback as the existing reservation path.
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
  session: typeof intentSessions.$inferSelect,
  maxGenerateRounds: number,
): ReturnType<typeof budgetOf> {
  const budget = budgetOf(session)
  if (budget.generateRounds + budget.questionRounds >= maxGenerateRounds) {
    throw new ConflictError(
      'intent-budget-exhausted',
      `session reached its generation budget (${maxGenerateRounds}); raise intentBuilderMaxGenerateRounds or archive`,
    )
  }
  return budget
}

function assertWritable(actor: Actor, session: typeof intentSessions.$inferSelect): void {
  if (session.ownerUserId !== actor.user.id) {
    throw new NotFoundError('intent-session-not-found', `intent session '${session.id}' not found`)
  }
  if (session.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived; reopen it first')
  }
  if (session.inFlightTurnId !== null) {
    throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
  }
}

function findReplay(
  tx: DbTxSync,
  sessionId: string,
  clientMutationId: string,
  digest: string,
): IntentGenerationReceipt | null {
  const userTurn = tx
    .select()
    .from(intentTurns)
    .where(
      and(eq(intentTurns.sessionId, sessionId), eq(intentTurns.clientMutationId, clientMutationId)),
    )
    .get()
  if (userTurn === undefined) return null
  let storedDigest: unknown
  try {
    storedDigest = (JSON.parse(userTurn.contentJson) as { requestDigest?: unknown }).requestDigest
  } catch {
    storedDigest = undefined
  }
  if (storedDigest !== digest) {
    throw new ConflictError(
      'intent-mutation-conflict',
      'clientMutationId was already used for a different generation request',
    )
  }
  const agentTurn = tx
    .select()
    .from(intentTurns)
    .where(
      and(
        eq(intentTurns.sessionId, sessionId),
        eq(intentTurns.seq, userTurn.seq + 1),
        eq(intentTurns.role, 'agent'),
      ),
    )
    .get()
  if (agentTurn === undefined) throw new Error('generation mutation has no successor turn')
  return { userTurnId: userTurn.id, agentTurnId: agentTurn.id, replayed: true }
}

function reserveAfterUserTurn(
  tx: DbTxSync,
  input: {
    session: typeof intentSessions.$inferSelect
    clientMutationId: string
    requestDigest: string
    message: string
    content: Record<string, unknown>
    maxGenerateRounds: number
    clearCurrentDraft?: boolean
  },
): { receipt: IntentGenerationReceipt; reservation: ReservedIntentTurn } {
  const now = Date.now()
  const userTurnId = ulid()
  const agentTurnId = ulid()
  const envelopeNonce = generateEnvelopeNonce()
  const budget = assertBudget(input.session, input.maxGenerateRounds)
  const userSeq = input.session.turnSeq + 1
  tx.insert(intentTurns)
    .values({
      id: userTurnId,
      sessionId: input.session.id,
      seq: userSeq,
      role: 'user',
      kind: 'message',
      contentJson: JSON.stringify({
        message: input.message,
        requestDigest: input.requestDigest,
        ...input.content,
      }),
      contextRevision: input.session.contextRevision,
      clientMutationId: input.clientMutationId,
      createdAt: now,
    })
    .run()
  tx.insert(intentTurns)
    .values({
      id: agentTurnId,
      sessionId: input.session.id,
      seq: userSeq + 1,
      role: 'agent',
      kind: 'running',
      contentJson: '{}',
      contextRevision: input.session.contextRevision,
      envelopeNonce,
      captureState: 'live',
      captureLastEventSeq: 0,
      captureEventBytes: 0,
      createdAt: now,
    })
    .run()
  tx.update(intentSessions)
    .set({
      ...(input.clearCurrentDraft === true ? { currentDraftId: null } : {}),
      inFlightTurnId: agentTurnId,
      turnSeq: userSeq + 1,
      updatedAt: now,
    })
    .where(eq(intentSessions.id, input.session.id))
    .run()
  const launchSession = tx
    .select()
    .from(intentSessions)
    .where(eq(intentSessions.id, input.session.id))
    .get()
  if (launchSession === undefined) throw new Error('intent session vanished after reservation')
  return {
    receipt: { userTurnId, agentTurnId, replayed: false },
    reservation: { turnId: agentTurnId, envelopeNonce, launchSession, budget },
  }
}

export function reserveIntentIteration(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  input: PostIntentIteration,
  maxGenerateRounds: number,
): ReservedIntentGeneration {
  const digest = requestDigest(input)
  return dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (session.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    const replay = findReplay(tx, sessionId, input.clientMutationId, digest)
    if (replay !== null) return { receipt: replay, reservation: null }
    assertWritable(actor, session)
    assertNoUnsettledApply(tx, sessionId)
    if (
      session.turnSeq !== input.expectedTurnSeq ||
      session.contextRevision !== input.expectedContextRevision
    ) {
      throw new ConflictError('intent-iteration-stale', 'the Intent session changed; refresh first')
    }

    if (input.mode === 'continue-checkpoint') {
      if (
        session.currentDraftId !== null ||
        session.commitSeq < 1 ||
        session.commitSeq !== input.sourceCommitSeq
      ) {
        throw new ConflictError(
          'intent-checkpoint-stale',
          'the latest committed checkpoint changed; refresh before continuing',
        )
      }
      return reserveAfterUserTurn(tx, {
        session,
        clientMutationId: input.clientMutationId,
        requestDigest: digest,
        message: input.feedback,
        content: { iterationMode: input.mode, sourceCommitSeq: input.sourceCommitSeq },
        maxGenerateRounds,
      })
    }

    const draft = tx
      .select()
      .from(intentDrafts)
      .where(eq(intentDrafts.id, input.sourceDraftId))
      .get()
    if (
      draft === undefined ||
      draft.sessionId !== sessionId ||
      session.currentDraftId !== draft.id ||
      draft.draftHash !== input.sourceDraftHash
    ) {
      throw new ConflictError(
        'intent-draft-superseded',
        'the current draft changed; refresh before iterating',
      )
    }
    if (draft.contextRevision !== session.contextRevision) {
      throw new ConflictError('intent-baseline-stale', 'the working context changed; refresh first')
    }

    if (input.mode === 'regenerate') {
      tx.insert(intentDraftResolutions)
        .values({
          draftId: draft.id,
          sessionId,
          reason: 'discarded',
          createdAt: Date.now(),
        })
        .run()
      return reserveAfterUserTurn(tx, {
        session,
        clientMutationId: input.clientMutationId,
        requestDigest: digest,
        message:
          'Discard the previous candidate and generate a fresh solution for the same intent. Do not restore the discarded draft.',
        content: {
          iterationMode: input.mode,
          sourceDraftId: draft.id,
          sourceDraftRevision: draft.revision,
        },
        maxGenerateRounds,
        clearCurrentDraft: true,
      })
    }

    return reserveAfterUserTurn(tx, {
      session,
      clientMutationId: input.clientMutationId,
      requestDigest: digest,
      message: input.feedback,
      content: {
        iterationMode: input.mode,
        sourceDraftId: draft.id,
        sourceDraftRevision: draft.revision,
      },
      maxGenerateRounds,
    })
  })
}

export function reserveExactIntentRetry(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  input: PostIntentRetry,
  maxGenerateRounds: number,
): ReservedIntentGeneration {
  const digest = requestDigest(input)
  return dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined || session.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    const replay = findReplay(tx, sessionId, input.clientMutationId, digest)
    if (replay !== null) return { receipt: replay, reservation: null }
    assertWritable(actor, session)
    assertNoUnsettledApply(tx, sessionId)
    if (
      session.turnSeq !== input.expectedTurnSeq ||
      session.contextRevision !== input.expectedContextRevision
    ) {
      throw new ConflictError(
        'intent-retry-stale',
        'the failed turn changed; refresh before retrying',
      )
    }
    const latestAgent = tx
      .select()
      .from(intentTurns)
      .where(and(eq(intentTurns.sessionId, sessionId), eq(intentTurns.role, 'agent')))
      .orderBy(desc(intentTurns.seq), desc(intentTurns.id))
      .limit(1)
      .get()
    if (
      latestAgent === undefined ||
      latestAgent.id !== input.sourceTurnId ||
      latestAgent.seq !== input.expectedTurnSeq ||
      latestAgent.kind !== 'error' ||
      latestAgent.contextRevision !== session.contextRevision
    ) {
      throw new ConflictError(
        'intent-retry-stale',
        'only the latest generation error can be retried',
      )
    }
    return reserveAfterUserTurn(tx, {
      session,
      clientMutationId: input.clientMutationId,
      requestDigest: digest,
      message: 'Retry the previous failed generation using the same intent and working context.',
      content: { retryOfTurnId: latestAgent.id },
      maxGenerateRounds,
    })
  })
}

function mountRequestKey(request: { resourceType: string; name: string }): string {
  return `${request.resourceType}\u0000${request.name}`
}

function uniqueMountRequests(requests: readonly IntentMountRequest[]): IntentMountRequest[] {
  const seen = new Set<string>()
  return requests.filter((request) => {
    const key = mountRequestKey(request)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validateCurrentAnswers(
  questions: ReadonlyArray<{
    id: string
    options: string[]
    multiSelect: boolean
  }>,
  answers: PostIntentCurrentAction['answers'],
): void {
  const byId = new Map<string, PostIntentCurrentAction['answers'][number]>()
  for (const answer of answers) {
    if (byId.has(answer.id)) {
      throw new ConflictError('intent-current-action-invalid', 'duplicate question answer')
    }
    byId.set(answer.id, answer)
  }
  if (byId.size !== questions.length || questions.some((question) => !byId.has(question.id))) {
    throw new ConflictError(
      'intent-current-action-invalid',
      'every current question requires exactly one answer',
    )
  }
  for (const question of questions) {
    const answer = byId.get(question.id)!
    if (!question.multiSelect && answer.picked.length !== 1) {
      throw new ConflictError(
        'intent-current-action-invalid',
        `question '${question.id}' accepts one answer`,
      )
    }
    if (answer.picked.some((picked) => !question.options.includes(picked))) {
      throw new ConflictError(
        'intent-current-action-invalid',
        `question '${question.id}' contains an unknown option`,
      )
    }
  }
}

function validateCurrentDecisions(
  requests: readonly IntentMountRequest[],
  decisions: readonly IntentMountSuggestionDecision[],
): Map<string, IntentMountSuggestionDecision> {
  const byKey = new Map<string, IntentMountSuggestionDecision>()
  for (const decision of decisions) {
    const key = mountRequestKey(decision)
    if (byKey.has(key)) {
      throw new ConflictError('intent-current-action-invalid', 'duplicate resource decision')
    }
    byKey.set(key, decision)
  }
  if (
    byKey.size !== requests.length ||
    requests.some((request) => !byKey.has(mountRequestKey(request)))
  ) {
    throw new ConflictError(
      'intent-current-action-invalid',
      'every current resource suggestion requires exactly one decision',
    )
  }
  return byKey
}

/** Resolve structured questions and resource suggestions as one user action
 * and reserve one — never two — successor turns. */
export function reserveIntentCurrentAction(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  input: PostIntentCurrentAction,
  maxGenerateRounds: number,
): ReservedIntentGeneration {
  const digest = requestDigest(input)
  return dbTxSync(db, (tx) => {
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined || session.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    const replay = findReplay(tx, sessionId, input.clientMutationId, digest)
    if (replay !== null) return { receipt: replay, reservation: null }
    assertWritable(actor, session)
    assertNoUnsettledApply(tx, sessionId)
    if (
      session.turnSeq !== input.expectedTurnSeq ||
      session.contextRevision !== input.expectedContextRevision
    ) {
      throw new ConflictError(
        'intent-current-action-stale',
        'the current action changed; refresh first',
      )
    }
    const source = tx.select().from(intentTurns).where(eq(intentTurns.id, input.sourceTurnId)).get()
    if (
      source === undefined ||
      source.sessionId !== sessionId ||
      source.role !== 'agent' ||
      (source.kind !== 'questions' && source.kind !== 'changeset') ||
      source.seq !== session.turnSeq ||
      source.contextRevision !== session.contextRevision
    ) {
      throw new ConflictError(
        'intent-current-action-stale',
        'the current action changed; refresh first',
      )
    }
    let content: Record<string, unknown>
    try {
      const parsed = JSON.parse(source.contentJson) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      content = parsed as Record<string, unknown>
    } catch {
      throw new ConflictError('intent-current-action-invalid', 'the current action is unreadable')
    }
    const parsedQuestions = IntentQuestionsSchema.safeParse(content.questions)
    const questions = parsedQuestions.success ? parsedQuestions.data : []
    const parsedRequests = IntentMountRequestsSchema.safeParse(content.mountRequests)
    const requests = uniqueMountRequests(parsedRequests.success ? parsedRequests.data : [])
    if (questions.length === 0 && requests.length === 0) {
      throw new ConflictError('intent-current-action-stale', 'there is no current action to submit')
    }
    validateCurrentAnswers(questions, input.answers)
    const decisions = validateCurrentDecisions(requests, input.decisions)

    const additions: Array<{
      resourceType: IntentMountRequest['resourceType']
      resourceId: string
    }> = []
    for (const request of requests) {
      const decision = decisions.get(mountRequestKey(request))!
      if (decision.action === 'reject') continue
      const table = ACL_TABLES[request.resourceType]
      const candidate = tx
        .select({
          id: table.id,
          name: table.name,
          ownerUserId: table.ownerUserId,
          visibility: table.visibility,
        })
        .from(table)
        .where(eq(table.id, decision.resourceId))
        .get() as (AclRow & { name: string }) | undefined
      if (
        candidate === undefined ||
        candidate.name !== request.name ||
        !canViewResourceInTx(tx, actor, request.resourceType, candidate)
      ) {
        throw new NotFoundError('resource-not-found', `${request.resourceType} not found`)
      }
      additions.push({ resourceType: request.resourceType, resourceId: decision.resourceId })
    }

    const applied = applyIntentWorkingSetDelta(
      JSON.parse(session.contextManifestJson) as IntentContextManifest,
      parseHandleWatermark(session.handleWatermarkJson),
      { additions, removals: [] },
    )
    const now = Date.now()
    const userTurnId = ulid()
    const agentTurnId = ulid()
    const envelopeNonce = generateEnvelopeNonce()
    const budget = assertBudget(session, maxGenerateRounds)
    const contextRevision = session.contextRevision + (applied.changed ? 1 : 0)
    const userSeq = session.turnSeq + 1
    tx.insert(intentTurns)
      .values({
        id: userTurnId,
        sessionId,
        seq: userSeq,
        role: 'user',
        kind: 'answers',
        contentJson: JSON.stringify({
          answers: input.answers,
          mountDecisions: input.decisions,
          sourceTurnId: source.id,
          requestDigest: digest,
        }),
        contextRevision,
        clientMutationId: input.clientMutationId,
        createdAt: now,
      })
      .run()
    tx.insert(intentTurns)
      .values({
        id: agentTurnId,
        sessionId,
        seq: userSeq + 1,
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
        turnSeq: userSeq + 1,
        updatedAt: now,
      })
      .where(eq(intentSessions.id, sessionId))
      .run()
    const launchSession = tx
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, sessionId))
      .get()
    if (launchSession === undefined) throw new Error('intent session vanished after current action')
    return {
      receipt: { userTurnId, agentTurnId, replayed: false },
      reservation: { turnId: agentTurnId, envelopeNonce, launchSession, budget },
    }
  })
}
