// RFC-234 §2/§6 (T5) — intent session CRUD + user-side turns.
//
// Visibility contract (design §2, design-gate P1-8): a session is readable by
// its CREATOR or a SYSTEM admin (`canAuditIntentSessions`) — managers get the same
// 404-shape as strangers. All writes are creator-only.
//
// Epoch discipline: mount add/remove and rebase bump `context_revision`; the
// current draft becomes stale by DERIVATION (draft.context_revision !==
// session.context_revision — no stored stale flag to drift). Any structural
// change while a turn is in flight is a 409 (`intent-turn-in-flight`).

import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  IntentMountRequestsSchema,
  type IntentMountRequest,
  type IntentMountApprovalReceipt,
  type IntentMountSuggestionDecision,
  type AclResourceType,
} from '@agent-workflow/shared'
/*
 * Keep all Intent wire parsing at this service boundary. Route handlers pass
 * already-Zod-validated bodies, but the persisted source turn is untrusted
 * storage and must be parsed again before it authorizes a write.
 */
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import {
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurns,
} from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  ACL_TABLES,
  canAuditIntentSessions,
  canViewResource,
  canViewResourceInTx,
  type AclRow,
} from '@/services/resourceAcl'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import {
  allocateHandle,
  createHandleAllocator,
  handleWatermarkOf,
  manifestEntryFor,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
} from './manifest'

export type IntentSessionRow = typeof intentSessions.$inferSelect
export type IntentSessionListRow = IntentSessionRow & {
  currentDraftRevision: number | null
  currentDraftContextRevision: number | null
  currentDraftValidationErrors: string[]
  latestAgentTurnKind: IntentTurnRow['kind'] | null
  latestCommit: null | {
    draftId: string
    state: 'prepared' | 'applying' | 'committed' | 'failed'
  }
}
export type IntentTurnRow = typeof intentTurns.$inferSelect

export interface ReservedIntentTurn {
  turnId: string
  envelopeNonce: string
  launchSession: IntentSessionRow
  budget: { generateRounds: number; questionRounds: number }
}

const TITLE_CAP = 80

export function sessionManifest(row: IntentSessionRow): IntentContextManifest {
  return JSON.parse(row.contextManifestJson) as IntentContextManifest
}

export function canReadIntentSession(actor: Actor, row: IntentSessionRow): boolean {
  return row.ownerUserId === actor.user.id || canAuditIntentSessions(actor)
}

/** 404-shape load: stranger AND manager get the same not-found as absent. */
export async function getIntentSessionForActor(
  db: DbClient,
  actor: Actor,
  sessionId: string,
): Promise<IntentSessionRow> {
  const row = (
    await db.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).limit(1)
  )[0]
  if (row === undefined || !canReadIntentSession(actor, row)) {
    throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
  }
  return row
}

export async function listIntentSessionsForActor(
  db: DbClient,
  actor: Actor,
  opts: {
    status?: 'active' | 'archived'
    all?: boolean
    before?: { updatedAt: number; id: string }
    limit?: number
  } = {},
): Promise<IntentSessionListRow[]> {
  const wantAll = opts.all === true && canAuditIntentSessions(actor)
  return dbTxSync(db, (tx) => {
    const visibility = wantAll ? undefined : eq(intentSessions.ownerUserId, actor.user.id)
    const status = opts.status === undefined ? undefined : eq(intentSessions.status, opts.status)
    const before =
      opts.before === undefined
        ? undefined
        : or(
            lt(intentSessions.updatedAt, opts.before.updatedAt),
            and(
              eq(intentSessions.updatedAt, opts.before.updatedAt),
              lt(intentSessions.id, opts.before.id),
            ),
          )
    const base = tx
      .select({
        session: intentSessions,
        currentDraftRevision: intentDrafts.revision,
        currentDraftContextRevision: intentDrafts.contextRevision,
        currentDraftValidationJson: intentDrafts.validationJson,
      })
      .from(intentSessions)
      .leftJoin(intentDrafts, eq(intentSessions.currentDraftId, intentDrafts.id))
      .where(and(visibility, status, before))
      .orderBy(desc(intentSessions.updatedAt), desc(intentSessions.id))
    const rows =
      opts.limit === undefined ? base.all() : base.limit(Math.max(1, Math.trunc(opts.limit))).all()
    const ids = rows.map(({ session }) => session.id)
    const agentTurns =
      ids.length === 0
        ? []
        : tx
            .select()
            .from(intentTurns)
            .where(and(inArray(intentTurns.sessionId, ids), eq(intentTurns.role, 'agent')))
            .orderBy(desc(intentTurns.seq), desc(intentTurns.id))
            .all()
    const commits =
      ids.length === 0
        ? []
        : tx
            .select({
              id: intentApplyJournal.id,
              sessionId: intentApplyJournal.sessionId,
              draftId: intentApplyJournal.draftId,
              state: intentApplyJournal.state,
              createdAt: intentApplyJournal.createdAt,
            })
            .from(intentApplyJournal)
            .where(inArray(intentApplyJournal.sessionId, ids))
            .orderBy(desc(intentApplyJournal.createdAt), desc(intentApplyJournal.id))
            .all()
    const latestTurnBySession = new Map<string, IntentTurnRow>()
    for (const turn of agentTurns) {
      if (!latestTurnBySession.has(turn.sessionId)) latestTurnBySession.set(turn.sessionId, turn)
    }
    const latestCommitBySession = new Map<string, (typeof commits)[number]>()
    for (const commit of commits) {
      if (!latestCommitBySession.has(commit.sessionId)) {
        latestCommitBySession.set(commit.sessionId, commit)
      }
    }
    return rows.map(
      ({
        session,
        currentDraftRevision,
        currentDraftContextRevision,
        currentDraftValidationJson,
      }) => {
        let currentDraftValidationErrors: string[] = []
        if (currentDraftValidationJson !== null) {
          try {
            const parsed = JSON.parse(currentDraftValidationJson) as { errors?: unknown }
            currentDraftValidationErrors = Array.isArray(parsed.errors)
              ? parsed.errors.filter((item): item is string => typeof item === 'string')
              : ['intent-draft-validation-unreadable']
          } catch {
            currentDraftValidationErrors = ['intent-draft-validation-unreadable']
          }
        }
        const latestCommit = latestCommitBySession.get(session.id)
        return {
          ...session,
          currentDraftRevision,
          currentDraftContextRevision,
          currentDraftValidationErrors,
          latestAgentTurnKind: latestTurnBySession.get(session.id)?.kind ?? null,
          latestCommit:
            latestCommit === undefined
              ? null
              : { draftId: latestCommit.draftId, state: latestCommit.state },
        }
      },
    )
  })
}

export async function listIntentTurns(db: DbClient, sessionId: string): Promise<IntentTurnRow[]> {
  return db
    .select()
    .from(intentTurns)
    .where(eq(intentTurns.sessionId, sessionId))
    .orderBy(intentTurns.seq)
}

function buildInitialManifestInTx(
  tx: DbTxSync,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: ReadonlyArray<{ resourceType: AclResourceType; resourceId: string }>
  },
): IntentContextManifest {
  // T13: mounts land BEFORE the first generation turn — a post-create mount
  // would race the auto-fired turn (409) and the first run would miss its
  // target. Visibility failures fail the CREATE (the user explicitly named
  // the resource; silently dropping it would generate from the wrong base).
  const manifest: IntentContextManifest = []
  const alloc = createHandleAllocator(manifest)
  for (const ref of input.mounts ?? []) {
    const table = ACL_TABLES[ref.resourceType]
    const aclRow = tx
      .select({
        id: table.id,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, ref.resourceId))
      .get() as AclRow | undefined
    if (aclRow === undefined || !canViewResourceInTx(tx, actor, ref.resourceType, aclRow)) {
      throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
    }
    if (manifestEntryFor(manifest, ref.resourceType, ref.resourceId) !== undefined) continue
    manifest.push({
      handle: allocateHandle(alloc, ref.resourceType, ref.resourceId),
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root: true,
      detail: false,
    })
  }
  return manifest
}

async function createIntentSessionInternal(
  db: DbClient,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: ReadonlyArray<{ resourceType: AclResourceType; resourceId: string }>
  },
  reserve: boolean,
): Promise<{
  session: IntentSessionRow
  turnId: string
  reservation?: ReservedIntentTurn
}> {
  const message = input.message.trim()
  if (message.length === 0) {
    throw new ValidationError('intent-message-empty', 'intent message must not be empty')
  }
  const now = Date.now()
  const sessionId = ulid()
  const userTurnId = ulid()
  const agentTurnId = reserve ? ulid() : null
  const envelopeNonce = reserve ? generateEnvelopeNonce() : null
  const title = message.length > TITLE_CAP ? `${message.slice(0, TITLE_CAP)}…` : message
  return dbTxSync(db, (tx) => {
    // The explicitly requested initial mounts are part of the same atomic
    // create boundary as the session. Rechecking ACL here prevents a deleted
    // or revoked resource from being admitted between validation and insert.
    const manifest = buildInitialManifestInTx(tx, actor, input)
    tx.insert(intentSessions)
      .values({
        id: sessionId,
        ownerUserId: actor.user.id,
        title,
        status: 'active',
        contextRevision: 0,
        contextManifestJson: JSON.stringify(manifest),
        // RFC-291 面 F — seed the watermark from the initial mounts so the very
        // first eviction cannot hand those ordinals to another resource.
        handleWatermarkJson: JSON.stringify(handleWatermarkOf(createHandleAllocator(manifest))),
        inFlightTurnId: agentTurnId,
        turnSeq: reserve ? 2 : 1,
        commitSeq: 0,
        budgetJson: JSON.stringify({ generateRounds: 0, questionRounds: 0 }),
        createdAt: now,
        updatedAt: now,
      })
      .run()
    tx.insert(intentTurns)
      .values({
        id: userTurnId,
        sessionId,
        seq: 1,
        role: 'user',
        kind: 'message',
        contentJson: JSON.stringify({
          message,
          ...(input.hint === undefined ? {} : { hint: input.hint }),
        }),
        contextRevision: 0,
        createdAt: now,
      })
      .run()
    if (agentTurnId !== null && envelopeNonce !== null) {
      tx.insert(intentTurns)
        .values({
          id: agentTurnId,
          sessionId,
          seq: 2,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision: 0,
          envelopeNonce,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          createdAt: now,
        })
        .run()
    }
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) throw new Error('intent session vanished after insert')
    return {
      session,
      turnId: userTurnId,
      ...(agentTurnId === null || envelopeNonce === null
        ? {}
        : {
            reservation: {
              turnId: agentTurnId,
              envelopeNonce,
              launchSession: session,
              budget: { generateRounds: 0, questionRounds: 0 },
            },
          }),
    }
  })
}

/** Low-level fixture/helper path: create only; callers may invoke runIntentTurn
 *  separately. Production HTTP uses createIntentSessionAndReserveTurn. */
export async function createIntentSession(
  db: DbClient,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: ReadonlyArray<{ resourceType: AclResourceType; resourceId: string }>
  },
): Promise<{ session: IntentSessionRow; turnId: string }> {
  return createIntentSessionInternal(db, actor, input, false)
}

export async function createIntentSessionAndReserveTurn(
  db: DbClient,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: ReadonlyArray<{ resourceType: AclResourceType; resourceId: string }>
  },
): Promise<{ session: IntentSessionRow; turnId: string; reservation: ReservedIntentTurn }> {
  const created = await createIntentSessionInternal(db, actor, input, true)
  if (created.reservation === undefined) throw new Error('intent reservation missing after create')
  return { ...created, reservation: created.reservation }
}

/** Codex impl-gate P1-1 — while an apply is between claim and settlement
 *  (prepared/applying), every session mutation is refused: a rebase or mount
 *  racing the prestage window would otherwise be silently overwritten by the
 *  final transaction's epoch bump. Works on the tx for same-connection reads. */
export function assertNoUnsettledApply(
  tx: { select: DbClient['select'] },
  sessionId: string,
): void {
  const unsettled = (
    tx
      .select({ id: intentApplyJournal.id, state: intentApplyJournal.state })
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, sessionId)) as unknown as {
      all: () => Array<{ id: string; state: string }>
    }
  ).all()
  if (unsettled.some((row) => row.state === 'prepared' || row.state === 'applying')) {
    throw new ConflictError(
      'intent-apply-in-flight',
      'a commit is being applied for this session; wait for it to settle',
    )
  }
}

function sessionBudget(row: IntentSessionRow): {
  generateRounds: number
  questionRounds: number
} {
  const parsed = JSON.parse(row.budgetJson) as {
    generateRounds?: unknown
    questionRounds?: unknown
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

function assertGenerationBudget(
  row: IntentSessionRow,
  maxGenerateRounds: number,
): {
  generateRounds: number
  questionRounds: number
} {
  const budget = sessionBudget(row)
  if (budget.generateRounds + budget.questionRounds >= maxGenerateRounds) {
    throw new ConflictError(
      'intent-budget-exhausted',
      `session reached its generation budget (${maxGenerateRounds}); raise intentBuilderMaxGenerateRounds or archive`,
    )
  }
  return budget
}

function assertWritable(actor: Actor, row: IntentSessionRow): void {
  if (row.ownerUserId !== actor.user.id) {
    // Admin READ bypass never extends to writes: same 404 shape as strangers.
    throw new NotFoundError('intent-session-not-found', `intent session '${row.id}' not found`)
  }
  if (row.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived; reopen it first')
  }
}

/** Insert a user-authored turn (message / answers / mount-approval). 409 while
 *  an agent turn is in flight. */
export async function insertUserTurn(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  kind: 'message' | 'answers' | 'mount-approval',
  content: Record<string, unknown>,
): Promise<{ turnId: string; seq: number }> {
  const row = await getIntentSessionForActor(db, actor, sessionId)
  assertWritable(actor, row)
  const now = Date.now()
  const turnId = ulid()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const seq = fresh.turnSeq + 1
    tx.insert(intentTurns)
      .values({
        id: turnId,
        sessionId,
        seq,
        role: 'user',
        kind,
        contentJson: JSON.stringify(content),
        contextRevision: fresh.contextRevision,
        createdAt: now,
      })
      .run()
    tx.update(intentSessions)
      .set({ turnSeq: seq, updatedAt: now })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { turnId, seq }
  })
}

function mountRequestKey(request: { resourceType: AclResourceType; name: string }): string {
  return `${request.resourceType}\u0000${request.name}`
}

function uniqueMountRequests(requests: readonly IntentMountRequest[]): IntentMountRequest[] {
  const seen = new Set<string>()
  const unique: IntentMountRequest[] = []
  for (const request of requests) {
    const key = mountRequestKey(request)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(request)
  }
  return unique
}

/** RFC-235 v22 — source-bound, all-or-nothing mount suggestion decisions. */
export async function decideIntentMountSuggestions(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  input: {
    sourceTurnId: string
    expectedTurnSeq: number
    expectedContextRevision: number
    decisions: readonly IntentMountSuggestionDecision[]
  },
): Promise<IntentMountApprovalReceipt> {
  const approvalTurnId = ulid()
  const now = Date.now()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    assertWritable(actor, fresh)
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const sourceTurn = tx
      .select()
      .from(intentTurns)
      .where(eq(intentTurns.id, input.sourceTurnId))
      .get()
    if (
      sourceTurn === undefined ||
      sourceTurn.sessionId !== sessionId ||
      sourceTurn.role !== 'agent' ||
      (sourceTurn.kind !== 'questions' && sourceTurn.kind !== 'changeset') ||
      sourceTurn.seq !== fresh.turnSeq ||
      fresh.turnSeq !== input.expectedTurnSeq ||
      fresh.contextRevision !== input.expectedContextRevision ||
      sourceTurn.contextRevision !== fresh.contextRevision
    ) {
      throw new ConflictError(
        'intent-approval-stale',
        'the mount suggestions changed; refresh before deciding',
      )
    }
    let sourceContent: unknown
    try {
      sourceContent = JSON.parse(sourceTurn.contentJson)
    } catch {
      throw new ValidationError('intent-invalid', 'mount suggestion source is unreadable')
    }
    const sourceRecord =
      typeof sourceContent === 'object' && sourceContent !== null && !Array.isArray(sourceContent)
        ? (sourceContent as Record<string, unknown>)
        : null
    const requestsParse = IntentMountRequestsSchema.safeParse(sourceRecord?.mountRequests)
    if (!requestsParse.success) {
      throw new ValidationError('intent-invalid', 'source turn has no valid mount suggestions')
    }
    const requests = uniqueMountRequests(requestsParse.data)
    const decisionByKey = new Map<string, IntentMountSuggestionDecision>()
    for (const decision of input.decisions) {
      const key = mountRequestKey(decision)
      if (decisionByKey.has(key)) {
        throw new ValidationError('intent-invalid', 'duplicate mount suggestion decision')
      }
      decisionByKey.set(key, decision)
    }
    if (
      decisionByKey.size !== requests.length ||
      requests.some((request) => !decisionByKey.has(mountRequestKey(request)))
    ) {
      throw new ValidationError(
        'intent-invalid',
        'every mount suggestion requires exactly one decision',
      )
    }

    const manifest = JSON.parse(fresh.contextManifestJson) as IntentContextManifest
    const approved: IntentMountApprovalReceipt['approved'] = []
    const rejected: IntentMountApprovalReceipt['rejected'] = []
    let manifestChanged = false
    for (const request of requests) {
      const decision = decisionByKey.get(mountRequestKey(request))
      if (decision === undefined) throw new Error('validated mount decision vanished')
      if (decision.action === 'reject') {
        rejected.push({ resourceType: request.resourceType, name: request.name })
        continue
      }
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
      const existing = manifestEntryFor(manifest, request.resourceType, decision.resourceId)
      let handle: string
      if (existing !== undefined) {
        handle = existing.handle
        if (!existing.root) {
          existing.root = true
          manifestChanged = true
        }
      } else {
        // RFC-291 面 F — seed from the persisted watermark, not just the
        // manifest: entries evicted by the inventory cap are gone from it.
        const alloc = createHandleAllocator(
          manifest,
          parseHandleWatermark(fresh.handleWatermarkJson),
        )
        handle = allocateHandle(alloc, request.resourceType, decision.resourceId)
        manifest.push({
          handle,
          resourceType: request.resourceType,
          resourceId: decision.resourceId,
          root: true,
          detail: false,
        })
        manifestChanged = true
      }
      approved.push({
        resourceType: request.resourceType,
        name: request.name,
        resourceId: decision.resourceId,
        handle,
      })
    }

    const approvalTurnSeq = fresh.turnSeq + 1
    const resultingContextRevision = fresh.contextRevision + (manifestChanged ? 1 : 0)
    const receipt: IntentMountApprovalReceipt = {
      sourceTurnId: sourceTurn.id,
      sourceTurnSeq: sourceTurn.seq,
      approvalTurnId,
      approvalTurnSeq,
      resultingContextRevision,
      approved,
      rejected,
    }
    tx.insert(intentTurns)
      .values({
        id: approvalTurnId,
        sessionId,
        seq: approvalTurnSeq,
        role: 'user',
        kind: 'mount-approval',
        contentJson: JSON.stringify(receipt),
        contextRevision: resultingContextRevision,
        createdAt: now,
      })
      .run()
    tx.update(intentSessions)
      .set({
        contextManifestJson: JSON.stringify(manifest),
        contextRevision: resultingContextRevision,
        turnSeq: approvalTurnSeq,
        handleWatermarkJson: JSON.stringify(
          mergeHandleWatermarks(
            parseHandleWatermark(fresh.handleWatermarkJson),
            handleWatermarkOf(createHandleAllocator(manifest)),
          ),
        ),
        updatedAt: now,
      })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return receipt
  })
}

/** RFC-235 v22 production path: user history and its agent reservation are one
 *  transaction. A competing tab fails before either row is written. */
export async function insertUserTurnAndReserve(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  kind: 'message' | 'answers',
  content: Record<string, unknown>,
  maxGenerateRounds: number,
): Promise<{ turnId: string; seq: number; reservation: ReservedIntentTurn }> {
  const now = Date.now()
  const userTurnId = ulid()
  const agentTurnId = ulid()
  const envelopeNonce = generateEnvelopeNonce()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    assertWritable(actor, fresh)
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const budget = assertGenerationBudget(fresh, maxGenerateRounds)
    const seq = fresh.turnSeq + 1
    tx.insert(intentTurns)
      .values({
        id: userTurnId,
        sessionId,
        seq,
        role: 'user',
        kind,
        contentJson: JSON.stringify(content),
        contextRevision: fresh.contextRevision,
        createdAt: now,
      })
      .run()
    tx.insert(intentTurns)
      .values({
        id: agentTurnId,
        sessionId,
        seq: seq + 1,
        role: 'agent',
        kind: 'running',
        contentJson: '{}',
        contextRevision: fresh.contextRevision,
        envelopeNonce,
        captureState: 'live',
        captureLastEventSeq: 0,
        captureEventBytes: 0,
        createdAt: now,
      })
      .run()
    tx.update(intentSessions)
      .set({ inFlightTurnId: agentTurnId, turnSeq: seq + 1, updatedAt: now })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return {
      turnId: userTurnId,
      seq,
      reservation: {
        turnId: agentTurnId,
        envelopeNonce,
        launchSession: fresh,
        budget,
      },
    }
  })
}

export async function reserveIntentRetryTurn(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  maxGenerateRounds: number,
): Promise<ReservedIntentTurn> {
  const now = Date.now()
  const turnId = ulid()
  const envelopeNonce = generateEnvelopeNonce()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    assertWritable(actor, fresh)
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const budget = assertGenerationBudget(fresh, maxGenerateRounds)
    const seq = fresh.turnSeq + 1
    tx.insert(intentTurns)
      .values({
        id: turnId,
        sessionId,
        seq,
        role: 'agent',
        kind: 'running',
        contentJson: '{}',
        contextRevision: fresh.contextRevision,
        envelopeNonce,
        captureState: 'live',
        captureLastEventSeq: 0,
        captureEventBytes: 0,
        createdAt: now,
      })
      .run()
    tx.update(intentSessions)
      .set({ inFlightTurnId: turnId, turnSeq: seq, updatedAt: now })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { turnId, envelopeNonce, launchSession: fresh, budget }
  })
}

/** Mount an existing resource as a session root. Bumps the context epoch. */
export async function addIntentMount(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  ref: { resourceType: AclResourceType; resourceId: string },
): Promise<{ handle: string; contextRevision: number }> {
  const row = await getIntentSessionForActor(db, actor, sessionId)
  assertWritable(actor, row)
  // 404-shape for invisible resources — mounting is a read of the resource.
  const table = ACL_TABLES[ref.resourceType]
  const aclRow = (
    await db
      .select({
        id: table.id,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, ref.resourceId))
      .limit(1)
  )[0] as AclRow | undefined
  if (aclRow === undefined || !(await canViewResource(db, actor, ref.resourceType, aclRow))) {
    throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
  }
  const now = Date.now()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const manifest = JSON.parse(fresh.contextManifestJson) as IntentContextManifest
    const existing = manifestEntryFor(manifest, ref.resourceType, ref.resourceId)
    if (existing?.root === true) {
      throw new ConflictError('intent-mount-exists', 'resource is already mounted')
    }
    let handle: string
    if (existing !== undefined) {
      existing.root = true
      handle = existing.handle
    } else {
      // RFC-291 面 F — persisted watermark, so a manual mount cannot re-mint an
      // ordinal that an evicted entry already used earlier in this session.
      const alloc = createHandleAllocator(manifest, parseHandleWatermark(fresh.handleWatermarkJson))
      handle = allocateHandle(alloc, ref.resourceType, ref.resourceId)
      manifest.push({
        handle,
        resourceType: ref.resourceType,
        resourceId: ref.resourceId,
        root: true,
        detail: false,
      })
    }
    const contextRevision = fresh.contextRevision + 1
    tx.update(intentSessions)
      .set({
        contextManifestJson: JSON.stringify(manifest),
        contextRevision,
        handleWatermarkJson: JSON.stringify(
          mergeHandleWatermarks(
            parseHandleWatermark(fresh.handleWatermarkJson),
            handleWatermarkOf(createHandleAllocator(manifest)),
          ),
        ),
        updatedAt: now,
      })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { handle, contextRevision }
  })
}

/** Unmount a root (the handle survives as a summary entry for history
 *  coherence). Bumps the context epoch. */
export async function removeIntentMount(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  handle: string,
): Promise<{ contextRevision: number }> {
  const row = await getIntentSessionForActor(db, actor, sessionId)
  assertWritable(actor, row)
  const now = Date.now()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const manifest = JSON.parse(fresh.contextManifestJson) as IntentContextManifest
    const entry = manifest.find((e) => e.handle === handle)
    if (entry === undefined || !entry.root) {
      throw new NotFoundError('intent-mount-not-found', 'mount not found')
    }
    entry.root = false
    const contextRevision = fresh.contextRevision + 1
    tx.update(intentSessions)
      .set({
        contextManifestJson: JSON.stringify(manifest),
        contextRevision,
        updatedAt: now,
      })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { contextRevision }
  })
}

/** Rebase: bump the epoch so the stale draft cannot commit and the next turn
 *  re-dumps every mounted resource at the new baseline. */
export async function rebaseIntentSession(
  db: DbClient,
  actor: Actor,
  sessionId: string,
): Promise<{ contextRevision: number }> {
  const row = await getIntentSessionForActor(db, actor, sessionId)
  assertWritable(actor, row)
  const now = Date.now()
  return dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    const contextRevision = fresh.contextRevision + 1
    tx.update(intentSessions)
      .set({ contextRevision, updatedAt: now })
      .where(eq(intentSessions.id, sessionId))
      .run()
    return { contextRevision }
  })
}

export async function setIntentSessionStatus(
  db: DbClient,
  actor: Actor,
  sessionId: string,
  status: 'active' | 'archived',
): Promise<void> {
  dbTxSync(db, (tx) => {
    const fresh = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (fresh === undefined || fresh.ownerUserId !== actor.user.id) {
      throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
    }
    if (fresh.status === status) return
    if (fresh.inFlightTurnId !== null) {
      throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
    }
    assertNoUnsettledApply(tx, sessionId)
    tx.update(intentSessions)
      .set({ status, updatedAt: Date.now() })
      .where(eq(intentSessions.id, sessionId))
      .run()
  })
}

// AC-11: the provenance annotation is visible only to actors who can read the
// originating session. Everyone else — including viewers of a public resource —
// gets [] so "intent-built but not yours" and "hand-built" are the same shape.
// The resource-visibility precheck is defense-in-depth (session owner is always
// the created resource's owner today, but copy/grant evolution shouldn't widen
// this read), and an invisible resource also yields [] rather than a 404 so the
// endpoint never confirms existence.
export async function listIntentProvenanceForActor(
  db: DbClient,
  actor: Actor,
  ref: { resourceType: AclResourceType; resourceId: string },
): Promise<
  Array<{ commitId: string; sessionId: string; sessionTitle: string; createdAt: number }>
> {
  const table = ACL_TABLES[ref.resourceType]
  const aclRow = (
    await db
      .select({
        id: table.id,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(eq(table.id, ref.resourceId))
      .limit(1)
  )[0] as AclRow | undefined
  if (aclRow === undefined || !(await canViewResource(db, actor, ref.resourceType, aclRow))) {
    return []
  }
  const rows = await db
    .select({
      commitId: intentProvenance.commitId,
      sessionId: intentProvenance.sessionId,
      createdAt: intentProvenance.createdAt,
      sessionTitle: intentSessions.title,
      sessionOwnerUserId: intentSessions.ownerUserId,
    })
    .from(intentProvenance)
    .innerJoin(intentSessions, eq(intentSessions.id, intentProvenance.sessionId))
    .where(
      and(
        eq(intentProvenance.resourceType, ref.resourceType),
        eq(intentProvenance.resourceId, ref.resourceId),
      ),
    )
    .orderBy(desc(intentProvenance.createdAt))
  const audit = canAuditIntentSessions(actor)
  return rows
    .filter((row) => audit || row.sessionOwnerUserId === actor.user.id)
    .map((row) => ({
      commitId: row.commitId,
      sessionId: row.sessionId,
      sessionTitle: row.sessionTitle,
      createdAt: row.createdAt,
    }))
}
