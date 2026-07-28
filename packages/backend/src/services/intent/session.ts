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

import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { AclResourceType } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { intentApplyJournal, intentProvenance, intentSessions, intentTurns } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  ACL_TABLES,
  canAuditIntentSessions,
  canViewResource,
  type AclRow,
} from '@/services/resourceAcl'
import {
  allocateHandle,
  createHandleAllocator,
  manifestEntryFor,
  type IntentContextManifest,
} from './manifest'

export type IntentSessionRow = typeof intentSessions.$inferSelect
export type IntentTurnRow = typeof intentTurns.$inferSelect

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
  opts: { status?: 'active' | 'archived'; all?: boolean } = {},
): Promise<IntentSessionRow[]> {
  const wantAll = opts.all === true && canAuditIntentSessions(actor)
  const rows = await db
    .select()
    .from(intentSessions)
    .where(
      wantAll
        ? opts.status === undefined
          ? undefined
          : eq(intentSessions.status, opts.status)
        : opts.status === undefined
          ? eq(intentSessions.ownerUserId, actor.user.id)
          : and(
              eq(intentSessions.ownerUserId, actor.user.id),
              eq(intentSessions.status, opts.status),
            ),
    )
    .orderBy(desc(intentSessions.updatedAt))
  return rows
}

export async function listIntentTurns(db: DbClient, sessionId: string): Promise<IntentTurnRow[]> {
  return db
    .select()
    .from(intentTurns)
    .where(eq(intentTurns.sessionId, sessionId))
    .orderBy(intentTurns.seq)
}

export async function createIntentSession(
  db: DbClient,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: ReadonlyArray<{ resourceType: AclResourceType; resourceId: string }>
  },
): Promise<{ session: IntentSessionRow; turnId: string }> {
  const message = input.message.trim()
  if (message.length === 0) {
    throw new ValidationError('intent-message-empty', 'intent message must not be empty')
  }
  // T13: mounts land BEFORE the first generation turn — a post-create mount
  // would race the auto-fired turn (409) and the first run would miss its
  // target. Visibility failures fail the CREATE (the user explicitly named
  // the resource; silently dropping it would generate from the wrong base).
  const manifest: IntentContextManifest = []
  const alloc = createHandleAllocator(manifest)
  for (const ref of input.mounts ?? []) {
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
    if (manifestEntryFor(manifest, ref.resourceType, ref.resourceId) !== undefined) continue
    manifest.push({
      handle: allocateHandle(alloc, ref.resourceType, ref.resourceId),
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root: true,
      detail: false,
    })
  }
  const now = Date.now()
  const sessionId = ulid()
  const turnId = ulid()
  const title = message.length > TITLE_CAP ? `${message.slice(0, TITLE_CAP)}…` : message
  return dbTxSync(db, (tx) => {
    tx.insert(intentSessions)
      .values({
        id: sessionId,
        ownerUserId: actor.user.id,
        title,
        status: 'active',
        contextRevision: 0,
        contextManifestJson: JSON.stringify(manifest),
        turnSeq: 1,
        commitSeq: 0,
        budgetJson: JSON.stringify({ generateRounds: 0, questionRounds: 0 }),
        createdAt: now,
        updatedAt: now,
      })
      .run()
    tx.insert(intentTurns)
      .values({
        id: turnId,
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
    const session = tx.select().from(intentSessions).where(eq(intentSessions.id, sessionId)).get()
    if (session === undefined) throw new Error('intent session vanished after insert')
    return { session, turnId }
  })
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
      const alloc = createHandleAllocator(manifest)
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
  const row = await getIntentSessionForActor(db, actor, sessionId)
  if (row.ownerUserId !== actor.user.id) {
    throw new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
  }
  if (row.status === status) return
  if (row.inFlightTurnId !== null) {
    throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
  }
  await db
    .update(intentSessions)
    .set({ status, updatedAt: Date.now() })
    .where(eq(intentSessions.id, sessionId))
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
