// RFC-225 — versioned workgroup persistence.
//
// A workgroup is one editable document: metadata, runtime config, ordered
// roster and leader relation. Every production content write is fenced by the
// stable workgroup id + expected version and returns an exact in-transaction
// receipt. Launched tasks remain isolated by their frozen config snapshot.

import type {
  CopyWorkgroupRequest,
  CreateWorkgroup,
  DeleteWorkgroup,
  SaveWorkgroupReceipt,
  UpdateWorkgroup,
  Workgroup,
  WorkgroupDetail,
  WorkgroupDraftMember,
  WorkgroupDraftSnapshot,
  WorkgroupMember,
  WorkgroupRevision,
  WorkgroupSnapshotHash,
} from '@agent-workflow/shared'
import {
  CopyWorkgroupRequestSchema,
  DeleteWorkgroupSchema,
  QUARANTINED_SNAPSHOT_AGENT_ID,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  UpdateWorkgroupSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  WorkgroupNameSchema,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { type DbTxSync, dbTxSync } from '@/db/txSync'
import {
  agents,
  resourceGrants,
  scheduledTasks,
  users,
  workgroupMembers,
  workgroups,
} from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import {
  WORKGROUPS_CHANNEL,
  workgroupsBroadcaster,
  type WorkgroupDeletedAudienceContext,
} from '@/ws/broadcaster'
import {
  assertInitialResourceOwner,
  canViewResource,
  canViewResourceInTx,
  discloseScheduleRefs,
  initialPrivateResourceAcl,
  isResourceAdminActor,
  isResourceOwner,
} from './resourceAcl'
import { nextResourceCopyName } from './resourceCopyName'
import { assertNoMissingRefs, assertRefsUsableInTx, resolveRefsUsableById } from './resourceRefs'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { sha256Hex } from '@/util/hash'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export type WorkgroupWritePrincipal =
  | { kind: 'actor'; actor: Actor }
  | { kind: 'system'; reason: string }

interface PreparedAgentMembers {
  /** Canonical agent id → current display name. */
  nameById: ReadonlyMap<string, string>
}

export async function listWorkgroups(db: DbClient): Promise<Workgroup[]> {
  const rows = await db.select().from(workgroups)
  if (rows.length === 0) return []
  const memberRows = await db
    .select()
    .from(workgroupMembers)
    .where(
      inArray(
        workgroupMembers.workgroupId,
        rows.map((row) => row.id),
      ),
    )
  const byGroup = new Map<string, MemberRow[]>()
  for (const member of memberRows) {
    const list = byGroup.get(member.workgroupId)
    if (list === undefined) byGroup.set(member.workgroupId, [member])
    else list.push(member)
  }
  return rows.map((row) => rowToWorkgroup(row, byGroup.get(row.id) ?? []))
}

export async function getWorkgroupById(db: DbClient, id: string): Promise<WorkgroupDetail | null> {
  const row = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  return row[0] === undefined ? null : getWorkgroupDetailByRow(db, row[0])
}

/** RFC-234 (T6) — prepare/commit split (agent.ts precedent). */
export interface PreparedWorkgroupCreate {
  groupId: string
  input: CreateWorkgroup
  actor: Actor | null
  ownerUserId: string | null
  preparedAgentsNameById: ReadonlyMap<string, string>
  now: number
}

export async function prepareWorkgroupCreate(
  db: DbClient,
  input: CreateWorkgroup,
  aclOpts?: {
    ownerUserId?: string
    actor?: Actor | null
    /** RFC-234 (T6): same-bundle pending agent ids → display names. */
    pendingAgentNames?: ReadonlyMap<string, string>
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<PreparedWorkgroupCreate> {
  await assertHumanMembersActive(db, input.members)
  const preparedAgents = await prepareAgentMembers(
    db,
    aclOpts?.actor ?? null,
    input.members,
    [],
    aclOpts?.pendingAgentNames,
  )
  const groupId = ulid()
  const now = Date.now()
  const ownerUserId = aclOpts?.ownerUserId ?? null
  assertInitialResourceOwner(aclOpts?.actor, ownerUserId)

  return {
    groupId,
    input,
    actor: aclOpts?.actor ?? null,
    ownerUserId,
    preparedAgentsNameById: preparedAgents.nameById,
    now,
  }
}

/** The former createWorkgroup dbTxSync body, verbatim modulo destructuring. */
export function commitWorkgroupCreateInTx(
  tx: DbTxSync,
  p: PreparedWorkgroupCreate,
): WorkgroupDetail {
  const { groupId, input, ownerUserId, now } = p
  const aclOpts = { actor: p.actor }
  const preparedAgents = { nameById: p.preparedAgentsNameById }
  assertHumanMembersActiveInTx(tx, input.members)
  const freshPreparedAgents = prepareAgentMembersInTx(tx, aclOpts?.actor ?? null, input.members)
  const memberValues = buildCreateMemberValues(groupId, input.members, now, {
    // Refresh display labels at the write linearization point. Retain the
    // preflight map only as a defensive fallback for framework fixtures.
    nameById: new Map([...preparedAgents.nameById, ...freshPreparedAgents.nameById]),
  })
  const leaderMemberId = resolveLeaderMemberId(input, memberValues)
  if (
    tx
      .select({ id: workgroups.id })
      .from(workgroups)
      .where(ownerScopedNameWhere(workgroups.ownerUserId, workgroups.name, ownerUserId, input.name))
      .get()
  ) {
    throw new ConflictError('workgroup-name-in-use', `workgroup '${input.name}' already exists`)
  }
  const inserted = insertWorkgroupInTx(tx, {
    id: groupId,
    document: input,
    leaderMemberId,
    ownerUserId,
    now,
  })
  insertWorkgroupMembersInTx(tx, memberValues)
  const persistedMembers = tx
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, groupId))
    .all()
  return workgroupToDetail(rowToWorkgroup(inserted, persistedMembers))
}

export async function createWorkgroup(
  db: DbClient,
  input: CreateWorkgroup,
  aclOpts?: {
    ownerUserId?: string
    actor?: Actor | null
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<WorkgroupDetail> {
  const prepared = await prepareWorkgroupCreate(db, input, aclOpts)
  await aclOpts?.beforeWriteTransaction?.()
  let created: WorkgroupDetail
  try {
    created = dbTxSync(db, (tx) => commitWorkgroupCreateInTx(tx, prepared))
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'workgroups', 'workgroups_owner_name_unique')) {
      throw new ConflictError('workgroup-name-in-use', `workgroup '${input.name}' already exists`)
    }
    throw error
  }
  broadcastWorkgroupCreated(created)
  return created
}

/**
 * RFC-231 exact-copy operation. Nothing editable comes from the client: the
 * target is derived from one source revision inside the transaction.
 */
export async function copyWorkgroup(
  db: DbClient,
  sourceId: string,
  input: CopyWorkgroupRequest,
  actor: Actor,
): Promise<WorkgroupDetail> {
  const parsed = CopyWorkgroupRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workgroup-copy-invalid', 'invalid workgroup copy payload', {
      issues: parsed.error.issues,
    })
  }

  let created: WorkgroupDetail
  try {
    created = dbTxSync(db, (tx) => {
      // Do not read roster rows until the actor passes the fresh ACL gate.
      const aclRow = tx
        .select({
          id: workgroups.id,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(eq(workgroups.id, sourceId))
        .get()
      if (aclRow === undefined || !canViewResourceInTx(tx, actor, 'workgroup', aclRow)) {
        throwWorkgroupNotFound(sourceId)
      }

      const currentRow = tx.select().from(workgroups).where(eq(workgroups.id, sourceId)).get()
      if (currentRow === undefined) throwWorkgroupNotFound(sourceId)
      const currentMembers = tx
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, sourceId))
        .all()
      const source = rowToWorkgroup(currentRow, currentMembers)
      const currentRevision = workgroupRevisionOf(source)
      if (
        parsed.data.expectedVersion !== currentRevision.version ||
        parsed.data.expectedSnapshotHash !== currentRevision.snapshotHash
      ) {
        throw new ConflictError(
          'workgroup-copy-stale',
          `workgroup '${sourceId}' changed; reload before copying`,
          { current: currentRevision },
        )
      }

      const sourceSnapshot = workgroupDraftSnapshotOf(source)
      assertHumanMembersActiveInTx(tx, sourceSnapshot.members)
      const preparedAgents = prepareAgentMembersInTx(tx, actor, sourceSnapshot.members)
      const occupiedNames = tx
        .select({ name: workgroups.name })
        .from(workgroups)
        .where(eq(workgroups.ownerUserId, actor.user.id))
        .all()
        .map((row) => row.name)
      // RFC-264: persist the PARSED name — the schema is also the normalizer,
      // so ignoring its output would store an unfolded copy name.
      const name = WorkgroupNameSchema.parse(
        nextResourceCopyName(sourceSnapshot.name, occupiedNames, 'workgroup'),
      )
      const snapshot = { ...sourceSnapshot, name }
      const id = ulid()
      const now = Date.now()
      const memberValues = buildDraftMemberValues(id, snapshot.members, now, preparedAgents)
      const leaderMemberId = resolveLeaderMemberId(snapshot, memberValues)
      const inserted = insertWorkgroupInTx(tx, {
        id,
        document: snapshot,
        leaderMemberId,
        ownerUserId: actor.user.id,
        now,
      })
      insertWorkgroupMembersInTx(tx, memberValues)
      const persistedMembers = tx
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, id))
        .all()
      return workgroupToDetail(rowToWorkgroup(inserted, persistedMembers))
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'workgroups', 'workgroups_owner_name_unique')) {
      throw new ConflictError(
        'workgroup-copy-name-conflict',
        'the next copy name was claimed; try copying again',
      )
    }
    throw error
  }

  broadcastWorkgroupCreated(created)
  return created
}

/**
 * The only workgroup content writer. Every caller supplies the canonical
 * workgroup id; mutable names are document fields only.
 */
/** RFC-234 (T6) — prepare/commit split of the workgroup full-document save. */
export interface PreparedWorkgroupSave {
  id: string
  principal: WorkgroupWritePrincipal
  parsed: { data: UpdateWorkgroup }
  snapshot: WorkgroupDraftSnapshot
  submittedBytes: string
  preparedAgents: PreparedAgentMembers
}

export async function prepareWorkgroupSave(
  db: DbClient,
  id: string,
  input: UpdateWorkgroup,
  principal: WorkgroupWritePrincipal,
): Promise<PreparedWorkgroupSave> {
  const parsed = UpdateWorkgroupSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workgroup-invalid', 'invalid workgroup save payload', {
      issues: parsed.error.issues,
    })
  }
  const preflight = await loadRawWorkgroup(db, id)
  if (preflight === null) throwWorkgroupNotFound(id)
  // A full-document client from before RFC-274 has no outputContract. Preserve
  // the persisted contract instead of letting a schema default rewrite it.
  const snapshot = normalizeWorkgroupSnapshot(parsed.data.snapshot, preflight.outputContract)
  const submittedBytes = serializeWorkgroupEditableSnapshotV1(snapshot)
  await assertPrincipalCanWritePreflight(db, principal, preflight)
  const currentMembers = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, preflight.id))
  await assertHumanMembersActive(db, snapshot.members)
  const preparedAgents = await prepareAgentMembers(
    db,
    principal.kind === 'actor' ? principal.actor : null,
    snapshot.members,
    currentMembers,
  )

  return {
    id,
    principal,
    parsed: { data: parsed.data },
    snapshot,
    submittedBytes,
    preparedAgents,
  }
}

/** The former saveWorkgroup dbTxSync body, verbatim modulo destructuring. */
export function commitWorkgroupSaveInTx(
  tx: DbTxSync,
  p: PreparedWorkgroupSave,
): { receipt: SaveWorkgroupReceipt; committed: boolean } {
  const { id, principal, parsed, snapshot, submittedBytes, preparedAgents } = p
  const currentRow = tx.select().from(workgroups).where(eq(workgroups.id, id)).get()
  if (currentRow === undefined) throwWorkgroupNotFound(id)
  assertPrincipalCanWriteInTx(tx, principal, currentRow)
  // The async preflight is not the authorization/validity linearization point: an administrator
  // can disable a mapped human during a long package pre-stage. Recheck in the same transaction
  // that writes the replacement roster, matching the create path's final fence.
  assertHumanMembersActiveInTx(tx, snapshot.members)
  const memberRows = tx
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, id))
    .all()
  const current = rowToWorkgroup(currentRow, memberRows)
  assertRefsUsableInTx(tx, principal.kind === 'actor' ? principal.actor : null, [
    { type: 'agent', names: diffNewAgentMemberIds(current, snapshot), domain: 'id' },
  ])
  const currentSnapshot = workgroupDraftSnapshotOf(current)
  const currentBytes = serializeWorkgroupEditableSnapshotV1(currentSnapshot)
  const currentRevision = workgroupRevisionOf(current)
  const logicalSame = currentBytes === submittedBytes

  if (currentRow.version !== parsed.data.expectedVersion) {
    if (logicalSame) {
      const detail = workgroupToDetail(current)
      return {
        receipt: {
          clientMutationId: parsed.data.clientMutationId,
          requestedBaseVersion: parsed.data.expectedVersion,
          revision: currentRevision,
          snapshot: currentSnapshot,
          workgroup: detail,
          outcome: 'already-current',
        },
        committed: false,
      }
    }
    throw new ConflictError(
      'workgroup-version-conflict',
      `workgroup '${id}' is at version ${currentRow.version}, expected ${parsed.data.expectedVersion}`,
      { current: currentRevision },
    )
  }

  if (logicalSame) {
    const detail = workgroupToDetail(current)
    return {
      receipt: {
        clientMutationId: parsed.data.clientMutationId,
        requestedBaseVersion: parsed.data.expectedVersion,
        revision: currentRevision,
        snapshot: currentSnapshot,
        workgroup: detail,
        outcome: 'already-current',
      },
      committed: false,
    }
  }

  assertNameChangeAllowedInTx(tx, current, snapshot.name)
  const rosterChanged = rosterBytes(currentSnapshot) !== rosterBytes(snapshot)
  const now = Date.now()
  const replacementMembers = rosterChanged
    ? buildDraftMemberValues(id, snapshot.members, now, preparedAgents)
    : null
  const leaderMemberId =
    replacementMembers === null
      ? currentRow.leaderMemberId
      : resolveLeaderMemberId(snapshot, replacementMembers)

  const returned = tx
    .update(workgroups)
    .set({
      name: snapshot.name,
      description: snapshot.description,
      instructions: snapshot.instructions,
      mode: snapshot.mode,
      outputContract: resolveWorkgroupOutputContract(snapshot.outputContract),
      leaderMemberId,
      shareOutputs: snapshot.switches.shareOutputs,
      directMessages: snapshot.switches.directMessages,
      blackboard: snapshot.switches.blackboard,
      maxRounds: snapshot.maxRounds,
      completionGate: snapshot.completionGate,
      clarifyBudget: snapshot.clarifyBudget,
      fanOut: snapshot.fanOut,
      version: currentRow.version + 1,
      updatedAt: now,
    })
    .where(and(eq(workgroups.id, id), eq(workgroups.version, parsed.data.expectedVersion)))
    .returning()
    .get()
  if (returned === undefined) {
    throw new ConflictError('workgroup-version-conflict', `workgroup '${id}' changed; reload`, {
      current: currentRevision,
    })
  }

  if (replacementMembers !== null) {
    tx.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, id)).run()
    insertWorkgroupMembersInTx(tx, replacementMembers)
  }
  const returnedMembers = tx
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, id))
    .all()
  const detail = workgroupToDetail(rowToWorkgroup(returned, returnedMembers))
  const committedSnapshot = workgroupDraftSnapshotOf(detail)
  return {
    receipt: {
      clientMutationId: parsed.data.clientMutationId,
      requestedBaseVersion: parsed.data.expectedVersion,
      revision: workgroupRevisionOf(detail),
      snapshot: committedSnapshot,
      workgroup: detail,
      outcome: 'committed',
    },
    committed: true,
  }
}

export async function saveWorkgroup(
  db: DbClient,
  id: string,
  input: UpdateWorkgroup,
  principal: WorkgroupWritePrincipal,
  opts?: {
    /** Deterministic race-test seam after preflight, before the final dbTxSync. */
    beforeWriteTransaction?: () => void | Promise<void>
  },
): Promise<SaveWorkgroupReceipt> {
  const prepared = await prepareWorkgroupSave(db, id, input, principal)
  await opts?.beforeWriteTransaction?.()
  const result = dbTxSync<{ receipt: SaveWorkgroupReceipt; committed: boolean }>(db, (tx) =>
    commitWorkgroupSaveInTx(tx, prepared),
  )

  if (result.committed) {
    workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
      type: 'workgroup.updated',
      workgroupId: result.receipt.revision.workgroupId,
      clientMutationId: result.receipt.clientMutationId,
      version: result.receipt.revision.version,
      snapshotHash: result.receipt.revision.snapshotHash,
      updatedAt: result.receipt.revision.updatedAt,
    })
  }
  return result.receipt
}

export async function deleteWorkgroup(
  db: DbClient,
  id: string,
  input: DeleteWorkgroup,
  principal: WorkgroupWritePrincipal,
): Promise<void> {
  const parsed = DeleteWorkgroupSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workgroup-invalid', 'invalid workgroup delete payload', {
      issues: parsed.error.issues,
    })
  }
  const deleted = dbTxSync<{
    deletedVersion: number
    audience: WorkgroupDeletedAudienceContext
  }>(db, (tx) => {
    const currentRow = tx.select().from(workgroups).where(eq(workgroups.id, id)).get()
    if (currentRow === undefined) throwWorkgroupNotFound(id)
    assertPrincipalCanWriteInTx(tx, principal, currentRow)
    if (currentRow.version !== parsed.data.expectedVersion) {
      const members = tx
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, id))
        .all()
      throw new ConflictError(
        'workgroup-version-conflict',
        `workgroup '${id}' is at version ${currentRow.version}, expected ${parsed.data.expectedVersion}`,
        { current: workgroupRevisionOf(rowToWorkgroup(currentRow, members)) },
      )
    }
    assertNoScheduledReferencesInTx(tx, principal, currentRow)
    const grants = tx
      .select({ userId: resourceGrants.userId })
      .from(resourceGrants)
      .where(and(eq(resourceGrants.resourceType, 'workgroup'), eq(resourceGrants.resourceId, id)))
      .all()
    const audience: WorkgroupDeletedAudienceContext = {
      kind: 'workgroup.deleted-audience',
      workgroupId: id,
      visibility: currentRow.visibility,
      ownerUserId: currentRow.ownerUserId,
      grantedUserIds: new Set(grants.map((grant) => grant.userId)),
    }
    const deleted = tx
      .delete(workgroups)
      .where(and(eq(workgroups.id, id), eq(workgroups.version, parsed.data.expectedVersion)))
      .returning({ id: workgroups.id })
      .get()
    if (deleted === undefined) {
      throw new ConflictError('workgroup-version-conflict', `workgroup '${id}' changed; reload`)
    }
    return { deletedVersion: currentRow.version, audience }
  })
  workgroupsBroadcaster.broadcast(
    WORKGROUPS_CHANNEL,
    {
      type: 'workgroup.deleted',
      workgroupId: id,
      clientMutationId: parsed.data.clientMutationId,
      deletedVersion: deleted.deletedVersion,
    },
    deleted.audience,
  )
}

/**
 * Fenced rename endpoint adapter. It delegates to saveWorkgroup, so it cannot
 * race the autosave writer and never resolves identity through the old name.
 */
export async function renameWorkgroup(
  db: DbClient,
  id: string,
  input: {
    newName: string
    description?: string
    expectedVersion: number
    clientMutationId: string
  },
  principal: WorkgroupWritePrincipal,
): Promise<SaveWorkgroupReceipt> {
  const current = await getWorkgroupById(db, id)
  if (current === null) throwWorkgroupNotFound(id)
  const snapshot = workgroupDraftSnapshotOf(current)
  return saveWorkgroup(
    db,
    id,
    {
      expectedVersion: input.expectedVersion,
      clientMutationId: input.clientMutationId,
      snapshot: {
        ...snapshot,
        name: input.newName,
        description: input.description ?? snapshot.description,
      },
    },
    principal,
  )
}

/** Complete editable snapshot; member DB ids and ACL fields never enter it. */
export function workgroupDraftSnapshotOf(group: Workgroup): WorkgroupDraftSnapshot {
  const ordered = [...group.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return normalizeWorkgroupSnapshot({
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: { ...group.switches },
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId ?? QUARANTINED_SNAPSHOT_AGENT_ID,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

export function workgroupSnapshotHashOf(snapshot: WorkgroupDraftSnapshot): WorkgroupSnapshotHash {
  return sha256Hex(
    serializeWorkgroupEditableSnapshotV1(normalizeWorkgroupSnapshot(snapshot)),
  ) as WorkgroupSnapshotHash
}

export function workgroupRevisionOf(group: Workgroup): WorkgroupRevision {
  const snapshot = workgroupDraftSnapshotOf(group)
  return {
    workgroupId: group.id,
    version: group.version,
    snapshotHash: workgroupSnapshotHashOf(snapshot),
    updatedAt: group.updatedAt,
  }
}

export function workgroupToDetail(group: Workgroup): WorkgroupDetail {
  return { ...group, snapshotHash: workgroupSnapshotHashOf(workgroupDraftSnapshotOf(group)) }
}

/** New canonical agent ids referenced by `next` that `prev` did not reference. */
export function diffNewAgentMemberIds(
  prev: Pick<Workgroup, 'members'> | null,
  next: { members: ReadonlyArray<{ memberType: string; agentId?: string }> },
): string[] {
  const previous = new Set(
    (prev?.members ?? []).flatMap((member) =>
      member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
    ),
  )
  return [
    ...new Set(
      next.members.flatMap((member) => {
        if (member.memberType !== 'agent') return []
        return member.agentId && !previous.has(member.agentId) ? [member.agentId] : []
      }),
    ),
  ]
}

type WorkgroupInsertDocument = Pick<
  CreateWorkgroup,
  | 'name'
  | 'description'
  | 'instructions'
  | 'mode'
  | 'outputContract'
  | 'switches'
  | 'maxRounds'
  | 'completionGate'
  | 'clarifyBudget'
  | 'fanOut'
>

function insertWorkgroupInTx(
  tx: DbTxSync,
  input: {
    id: string
    document: WorkgroupInsertDocument
    leaderMemberId: string | null
    ownerUserId: string | null
    now: number
  },
): WorkgroupRow {
  const inserted = tx
    .insert(workgroups)
    .values({
      id: input.id,
      name: input.document.name,
      description: input.document.description,
      instructions: input.document.instructions,
      mode: input.document.mode,
      outputContract: resolveWorkgroupOutputContract(input.document.outputContract),
      leaderMemberId: input.leaderMemberId,
      shareOutputs: input.document.switches.shareOutputs,
      directMessages: input.document.switches.directMessages,
      blackboard: input.document.switches.blackboard,
      maxRounds: input.document.maxRounds,
      completionGate: input.document.completionGate,
      clarifyBudget: input.document.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
      fanOut: input.document.fanOut ?? false,
      version: 1,
      // RFC-231: every user-created resource starts private with ACL rev 0.
      ...initialPrivateResourceAcl(input.ownerUserId),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get()
  if (inserted === undefined) throw new Error('workgroup insert returned no row')
  return inserted
}

function insertWorkgroupMembersInTx(
  tx: DbTxSync,
  members: ReadonlyArray<typeof workgroupMembers.$inferInsert>,
): void {
  for (const member of members) tx.insert(workgroupMembers).values(member).run()
}

export function broadcastWorkgroupCreated(created: WorkgroupDetail): void {
  workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
    type: 'workgroup.created',
    workgroupId: created.id,
    name: created.name,
    version: created.version,
  })
}

function normalizeWorkgroupSnapshot(
  snapshot: WorkgroupDraftSnapshot,
  fallbackOutputContract: unknown = 'files',
): WorkgroupDraftSnapshot {
  return WorkgroupDraftSnapshotSchema.parse({
    name: snapshot.name,
    description: snapshot.description,
    instructions: snapshot.instructions,
    mode: snapshot.mode,
    outputContract: resolveWorkgroupOutputContract(
      snapshot.outputContract ?? fallbackOutputContract,
    ),
    ...(snapshot.mode === 'leader_worker' && snapshot.leaderDisplayName
      ? { leaderDisplayName: snapshot.leaderDisplayName }
      : {}),
    switches: { ...snapshot.switches },
    maxRounds: snapshot.maxRounds,
    completionGate: snapshot.completionGate,
    clarifyBudget: snapshot.clarifyBudget,
    fanOut: snapshot.fanOut,
    members: snapshot.members.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

function rosterBytes(snapshot: WorkgroupDraftSnapshot): string {
  return JSON.stringify({
    leaderDisplayName: snapshot.leaderDisplayName ?? null,
    members: snapshot.members,
  })
}

async function loadRawWorkgroup(db: DbClient, id: string): Promise<WorkgroupRow | null> {
  const rows = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  return rows[0] ?? null
}

async function getWorkgroupDetailByRow(db: DbClient, row: WorkgroupRow): Promise<WorkgroupDetail> {
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, row.id))
  return workgroupToDetail(rowToWorkgroup(row, members))
}

async function assertPrincipalCanWritePreflight(
  db: DbClient,
  principal: WorkgroupWritePrincipal,
  row: WorkgroupRow,
): Promise<void> {
  if (principal.kind === 'system') return
  if (!(await canViewResource(db, principal.actor, 'workgroup', row))) {
    throwWorkgroupNotFound(row.id)
  }
  if (!isResourceOwner(principal.actor, row)) {
    throw new ForbiddenError(
      'forbidden',
      'only the workgroup owner or a resource admin can modify it',
    )
  }
}

function assertPrincipalCanWriteInTx(
  tx: DbTxSync,
  principal: WorkgroupWritePrincipal,
  row: WorkgroupRow,
): void {
  if (principal.kind === 'system') return
  const actor = principal.actor
  const isAdmin = isResourceAdminActor(actor)
  const isOwner = row.ownerUserId !== null && row.ownerUserId === actor.user.id
  // RFC-282 D1 — visibility is the shared predicate; isAdmin/isOwner stay
  // local for the 403 below (404 before 403 is contract).
  if (!canViewResourceInTx(tx, actor, 'workgroup', row)) throwWorkgroupNotFound(row.id)
  if (!isAdmin && !isOwner) {
    throw new ForbiddenError(
      'forbidden',
      'only the workgroup owner or a resource admin can modify it',
    )
  }
}

function assertNameChangeAllowedInTx(tx: DbTxSync, current: Workgroup, nextName: string): void {
  if (nextName === current.name) return
  const collision = tx
    .select({ id: workgroups.id })
    .from(workgroups)
    .where(
      ownerScopedNameWhere(
        workgroups.ownerUserId,
        workgroups.name,
        current.ownerUserId ?? null,
        nextName,
        { column: workgroups.id, id: current.id },
      ),
    )
    .get()
  if (collision !== undefined) {
    throw new ConflictError(
      'workgroup-name-in-use',
      `workgroup '${nextName}' already exists; pick a different name`,
    )
  }
}

function assertNoScheduledReferencesInTx(
  tx: DbTxSync,
  principal: WorkgroupWritePrincipal,
  target: { id: string; name: string },
): void {
  const rows = tx
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      launchKind: scheduledTasks.launchKind,
      launchPayload: scheduledTasks.launchPayload,
      ownerUserId: scheduledTasks.ownerUserId,
    })
    .from(scheduledTasks)
    .all()
  const refs = rows.filter((row) => {
    if (row.launchKind !== 'workgroup') return false
    try {
      const payload = JSON.parse(row.launchPayload) as {
        workgroupId?: unknown
      }
      return payload.workgroupId === target.id
    } catch {
      return false
    }
  })
  if (refs.length === 0) return
  const details =
    principal.kind === 'actor'
      ? discloseScheduleRefs(principal.actor, refs)
      : {
          scheduledCount: refs.length,
          visibleScheduled: refs.map((row) => ({ id: row.id, name: row.name })),
          hiddenCount: 0,
        }
  throw new ConflictError(
    'workgroup-scheduled-referenced',
    `workgroup '${target.name}' is the target of ${refs.length} scheduled task(s); delete or repoint them first`,
    details,
  )
}

async function prepareAgentMembers(
  db: DbClient,
  actor: Actor | null,
  members: readonly WorkgroupDraftMember[],
  existingMembers: readonly MemberRow[],
  // RFC-234 (T6): agent ids being CREATED in the same intent bundle — they have
  // no row yet at prepare time; their display names come from the bundle and
  // the commit-time prepareAgentMembersInTx re-resolves them in-tx (they exist
  // there, created earlier in topo order).
  pendingAgentNames?: ReadonlyMap<string, string>,
): Promise<PreparedAgentMembers> {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      ),
    ),
  ]
  const grandfatheredIds = new Set(
    existingMembers.flatMap((member) => (member.agentId ? [member.agentId] : [])),
  )
  const persistedIds = ids.filter((id) => !(pendingAgentNames?.has(id) ?? false))
  const resolved = await resolveRefsUsableById(db, actor, 'agent', persistedIds, {
    grandfatheredIds,
  })
  assertNoMissingRefs(resolved.missing)
  const rows =
    persistedIds.length === 0
      ? []
      : await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, persistedIds))
  const nameById = new Map([
    ...(pendingAgentNames ?? []),
    ...rows.map((row) => [row.id, row.name] as const),
  ])
  const missingIds = ids.filter((id) => !nameById.has(id))
  if (missingIds.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missingIds,
    })
  }

  return { nameById }
}

function prepareAgentMembersInTx(
  tx: DbTxSync,
  actor: Actor | null,
  members: ReadonlyArray<{ memberType: string; agentId?: string }>,
): PreparedAgentMembers {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      ),
    ),
  ]
  assertRefsUsableInTx(tx, actor, [{ type: 'agent', names: ids, domain: 'id' }])
  const rows =
    ids.length === 0
      ? []
      : tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids))
          .all()
  const nameById = new Map(rows.map((row) => [row.id, row.name]))
  const missingIds = ids.filter((id) => !nameById.has(id))
  if (missingIds.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missingIds,
    })
  }
  return { nameById }
}

function buildCreateMemberValues(
  groupId: string,
  members: Readonly<CreateWorkgroup['members']>,
  now: number,
  agentsPrepared: PreparedAgentMembers,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((member, index) => ({
    id: ulid(),
    workgroupId: groupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId
        ? (agentsPrepared.nameById.get(member.agentId) ?? null)
        : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
    createdAt: now,
  }))
}

function buildDraftMemberValues(
  groupId: string,
  members: readonly WorkgroupDraftMember[],
  now: number,
  agentsPrepared: PreparedAgentMembers,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((member, index) => ({
    id: ulid(),
    workgroupId: groupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent'
        ? member.agentId
          ? (agentsPrepared.nameById.get(member.agentId) ?? null)
          : null
        : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
    createdAt: now,
  }))
}

function resolveLeaderMemberId(
  input: { mode: string; leaderDisplayName?: string },
  members: ReadonlyArray<typeof workgroupMembers.$inferInsert>,
): string | null {
  if (input.mode !== 'leader_worker' || input.leaderDisplayName === undefined) return null
  const leader = members.find((member) => member.displayName === input.leaderDisplayName)
  if (leader === undefined || leader.memberType !== 'agent') {
    throw new ValidationError(
      'workgroup-leader-invalid',
      'leaderDisplayName must match an agent member',
    )
  }
  return leader.id
}

async function assertHumanMembersActive(
  db: DbClient,
  members: ReadonlyArray<{ memberType: string; userId?: string }>,
): Promise<void> {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'human' && member.userId ? [member.userId] : [],
      ),
    ),
  ]
  if (ids.length === 0) return
  const rows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, ids))
  const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
  const invalid = ids.filter((id) => !active.has(id))
  if (invalid.length > 0) {
    throw new ValidationError('workgroup-member-user-invalid', 'human member user(s) not active', {
      userIds: invalid,
    })
  }
}

function assertHumanMembersActiveInTx(
  tx: DbTxSync,
  members: ReadonlyArray<{ memberType: string; userId?: string }>,
): void {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'human' && member.userId ? [member.userId] : [],
      ),
    ),
  ]
  if (ids.length === 0) return
  const rows = tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, ids))
    .all()
  const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
  const invalid = ids.filter((id) => !active.has(id))
  if (invalid.length > 0) {
    throw new ValidationError('workgroup-member-user-invalid', 'human member user(s) not active', {
      userIds: invalid,
    })
  }
}

function rowToWorkgroup(row: WorkgroupRow, memberRows: MemberRow[]): Workgroup {
  const members: WorkgroupMember[] = memberRows
    .slice()
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
    )
    .map((member) => ({
      id: member.id,
      memberType: member.memberType,
      agentName: member.agentName,
      agentId: member.agentId,
      userId: member.userId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
      sortOrder: member.sortOrder,
    }))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    mode: row.mode,
    outputContract: resolveWorkgroupOutputContract(row.outputContract),
    leaderMemberId: row.leaderMemberId,
    switches: {
      shareOutputs: row.shareOutputs,
      directMessages: row.directMessages,
      blackboard: row.blackboard,
    },
    maxRounds: row.maxRounds,
    completionGate: row.completionGate,
    clarifyBudget: row.clarifyBudget,
    fanOut: row.fanOut,
    members,
    version: row.version,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function throwWorkgroupNotFound(id: string): never {
  throw new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
}
