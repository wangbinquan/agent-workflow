// RFC-225 — versioned workgroup persistence.
//
// A workgroup is one editable document: metadata, runtime config, ordered
// roster and leader relation. Every production content write is fenced by the
// stable workgroup id + expected version and returns an exact in-transaction
// receipt. Launched tasks remain isolated by their frozen config snapshot.

import type {
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
  DeleteWorkgroupSchema,
  serializeWorkgroupEditableSnapshotV1,
  UpdateWorkgroupSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
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
import { discloseScheduleRefs } from './resourceAcl'
import { canViewResource, isResourceAdminActor, isResourceOwner } from './resourceAcl'
import { assertNoMissingRefs, resolveRefsUsableById } from './resourceRefs'

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

export async function getWorkgroup(db: DbClient, name: string): Promise<WorkgroupDetail | null> {
  const row = await db.select().from(workgroups).where(eq(workgroups.name, name)).limit(1)
  return row[0] === undefined ? null : getWorkgroupDetailByRow(db, row[0])
}

export async function getWorkgroupById(db: DbClient, id: string): Promise<WorkgroupDetail | null> {
  const row = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  return row[0] === undefined ? null : getWorkgroupDetailByRow(db, row[0])
}

export async function createWorkgroup(
  db: DbClient,
  input: CreateWorkgroup,
  aclOpts?: { ownerUserId?: string; actor?: Actor | null },
): Promise<WorkgroupDetail> {
  await assertHumanMembersActive(db, input.members)
  const agentIdByName = await resolveCreateMemberAgentIds(db, aclOpts?.actor ?? null, input.members)
  const groupId = ulid()
  const now = Date.now()
  const memberValues = buildCreateMemberValues(groupId, input.members, now, agentIdByName)
  const leaderMemberId = resolveLeaderMemberId(input, memberValues)

  const created = dbTxSync(db, (tx) => {
    if (
      tx.select({ id: workgroups.id }).from(workgroups).where(eq(workgroups.name, input.name)).get()
    ) {
      throw new ConflictError('workgroup-name-in-use', `workgroup '${input.name}' already exists`)
    }
    const inserted = tx
      .insert(workgroups)
      .values({
        id: groupId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        mode: input.mode,
        leaderMemberId,
        shareOutputs: input.switches.shareOutputs,
        directMessages: input.switches.directMessages,
        blackboard: input.switches.blackboard,
        maxRounds: input.maxRounds,
        completionGate: input.completionGate,
        clarifyBudget: input.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
        fanOut: input.fanOut ?? false,
        version: 1,
        ownerUserId: aclOpts?.ownerUserId ?? null,
        visibility: 'public',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    if (inserted === undefined) throw new Error('workgroup insert returned no row')
    for (const member of memberValues) tx.insert(workgroupMembers).values(member).run()
    const persistedMembers = tx
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, groupId))
      .all()
    return workgroupToDetail(rowToWorkgroup(inserted, persistedMembers))
  })
  workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
    type: 'workgroup.created',
    workgroupId: created.id,
    name: created.name,
    version: created.version,
  })
  return created
}

/**
 * The only workgroup content writer. Route adapters resolve the current
 * name-based endpoint to this stable id until RFC-223 PR-7 switches the URL.
 */
export async function saveWorkgroup(
  db: DbClient,
  id: string,
  input: UpdateWorkgroup,
  principal: WorkgroupWritePrincipal,
): Promise<SaveWorkgroupReceipt> {
  const parsed = UpdateWorkgroupSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError('workgroup-invalid', 'invalid workgroup save payload', {
      issues: parsed.error.issues,
    })
  }
  const snapshot = normalizeWorkgroupSnapshot(parsed.data.snapshot)
  const submittedBytes = serializeWorkgroupEditableSnapshotV1(snapshot)

  const preflight = await loadRawWorkgroup(db, id)
  if (preflight === null) throwWorkgroupNotFound(id)
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

  const result = dbTxSync<{ receipt: SaveWorkgroupReceipt; committed: boolean }>(db, (tx) => {
    const currentRow = tx.select().from(workgroups).where(eq(workgroups.id, id)).get()
    if (currentRow === undefined) throwWorkgroupNotFound(id)
    assertPrincipalCanWriteInTx(tx, principal, currentRow)
    const memberRows = tx
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, id))
      .all()
    const current = rowToWorkgroup(currentRow, memberRows)
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

    assertNameChangeAllowedInTx(tx, principal, current, snapshot.name)
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
      for (const member of replacementMembers) tx.insert(workgroupMembers).values(member).run()
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
  })

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
 * Compatibility adapter for the historical rename endpoint. It is fenced and
 * delegates to saveWorkgroup, so it cannot race the autosave writer.
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
            ...(member.agentId
              ? { agentId: member.agentId }
              : { agentName: member.agentName ?? '__unresolved__' }),
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
  return createHash('sha256')
    .update(serializeWorkgroupEditableSnapshotV1(normalizeWorkgroupSnapshot(snapshot)), 'utf8')
    .digest('hex') as WorkgroupSnapshotHash
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

/** New agent selectors referenced by `next` that `prev` did not reference. */
export function diffNewAgentMemberNames(
  prev: Pick<Workgroup, 'members'> | null,
  next: {
    members: ReadonlyArray<{ memberType: string; agentId?: string; agentName?: string }>
  },
): string[] {
  const previous = new Set(
    (prev?.members ?? []).flatMap((member) =>
      member.memberType !== 'agent'
        ? []
        : [member.agentId ?? member.agentName].filter((value): value is string => Boolean(value)),
    ),
  )
  return [
    ...new Set(
      next.members.flatMap((member) => {
        if (member.memberType !== 'agent') return []
        const token = member.agentId ?? member.agentName
        return token && !previous.has(token) ? [token] : []
      }),
    ),
  ]
}

function normalizeWorkgroupSnapshot(snapshot: WorkgroupDraftSnapshot): WorkgroupDraftSnapshot {
  return WorkgroupDraftSnapshotSchema.parse({
    name: snapshot.name,
    description: snapshot.description,
    instructions: snapshot.instructions,
    mode: snapshot.mode,
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
            ...(member.agentId ? { agentId: member.agentId } : { agentName: member.agentName }),
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
  let visible = isAdmin || isOwner || row.visibility === 'public'
  if (!visible) {
    visible =
      tx
        .select({ resourceId: resourceGrants.resourceId })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, 'workgroup'),
            eq(resourceGrants.resourceId, row.id),
            eq(resourceGrants.userId, actor.user.id),
          ),
        )
        .get() !== undefined
  }
  if (!visible) throwWorkgroupNotFound(row.id)
  if (!isAdmin && !isOwner) {
    throw new ForbiddenError(
      'forbidden',
      'only the workgroup owner or a resource admin can modify it',
    )
  }
}

function assertNameChangeAllowedInTx(
  tx: DbTxSync,
  principal: WorkgroupWritePrincipal,
  current: Workgroup,
  nextName: string,
): void {
  if (nextName === current.name) return
  const collision = tx
    .select({ id: workgroups.id })
    .from(workgroups)
    .where(eq(workgroups.name, nextName))
    .get()
  if (collision !== undefined && collision.id !== current.id) {
    throw new ConflictError(
      'workgroup-name-in-use',
      `workgroup '${nextName}' already exists; pick a different name`,
    )
  }
  assertNoScheduledReferencesInTx(tx, principal, {
    id: current.id,
    name: current.name,
  })
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
        workgroupName?: unknown
      }
      return payload.workgroupId === target.id || payload.workgroupName === target.name
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
  const resolved = await resolveRefsUsableById(db, actor, 'agent', ids, { grandfatheredIds })
  assertNoMissingRefs(resolved.missing)
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids))
  const nameById = new Map(rows.map((row) => [row.id, row.name]))
  const missingIds = ids.filter((id) => !nameById.has(id))
  if (missingIds.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missingIds,
    })
  }

  const existingLegacyNames = new Set(
    existingMembers.flatMap((member) =>
      member.memberType === 'agent' && member.agentId === null && member.agentName
        ? [member.agentName]
        : [],
    ),
  )
  const newLegacyNames = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' &&
        !member.agentId &&
        member.agentName &&
        !existingLegacyNames.has(member.agentName)
          ? [member.agentName]
          : [],
      ),
    ),
  ]
  if (newLegacyNames.length > 0) {
    const checked = await resolveRefsUsableById(db, actor, 'agent', newLegacyNames)
    assertNoMissingRefs(checked.missing)
  }
  return { nameById }
}

async function resolveCreateMemberAgentIds(
  db: DbClient,
  actor: Actor | null,
  members: Readonly<CreateWorkgroup['members']>,
): Promise<Map<string, string>> {
  const names = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentName ? [member.agentName] : [],
      ),
    ),
  ]
  const result = await resolveRefsUsableById(db, actor, 'agent', names)
  assertNoMissingRefs(result.missing)
  return result.byToken
}

function buildCreateMemberValues(
  groupId: string,
  members: Readonly<CreateWorkgroup['members']>,
  now: number,
  agentIdByName: ReadonlyMap<string, string>,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((member, index) => ({
    id: ulid(),
    workgroupId: groupId,
    memberType: member.memberType,
    agentName: member.memberType === 'agent' ? (member.agentName ?? null) : null,
    agentId:
      member.memberType === 'agent' && member.agentName
        ? (agentIdByName.get(member.agentName) ?? null)
        : null,
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
          : (member.agentName ?? null)
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
