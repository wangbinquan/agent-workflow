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
  ResourceAccess,
  WorkgroupDetail,
  WorkgroupDraftMember,
  WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import {
  TERMINAL_TASK_STATUSES,
  CopyWorkgroupRequestSchema,
  DeleteWorkgroupSchema,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  UpdateWorkgroupSchema,
  WorkgroupNameSchema,
} from '@agent-workflow/shared'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, scheduledTasks, tasks, users, workgroupMembers, workgroups } from '@/db/schema'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import {
  WORKGROUPS_CHANNEL,
  workgroupsBroadcaster,
  type WorkgroupDeletedAudienceContext,
} from '@/ws/broadcaster'
import {
  assertInitialResourceOwner,
  initialPrivateResourceAcl,
} from '@/modules/resource-catalog/application/resourceDefaults'
import { assertNameUnchangedForEditor } from '@/modules/resource-catalog/application/resourceAccess'
import { resolveResourceAccessFor } from '@/modules/resource-catalog/composition/resourceAcl'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  discloseScheduleRefs,
} from '@/modules/resource-catalog/domain/resourceAccess'
import {
  resolveResourceAccessForTx,
  canViewResourceForTx,
} from '@/modules/resource-catalog/infrastructure/resourceAclTransaction'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { nextResourceCopyName } from '@/services/resourceCopyName'
import {
  assertNoMissingRefs,
  assertRefsUsableForTx,
  listResourceGrantUserIdsForTx,
  resolveRefsUsableById,
} from '@/modules/resource-catalog/infrastructure/legacy/resourceRefs'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from '@/services/ownerScopedName'
import {
  normalizeWorkgroupSnapshot,
  workgroupDraftSnapshotOf,
  workgroupRevisionOf,
  workgroupToDetail,
  workgroupFromCopiedRows,
  workgroupMemberPersistenceValues,
  resolveWorkgroupLeaderMemberId as resolveLeaderMemberId,
  workgroupContentPersistenceValues,
  type WorkgroupInsertDocument,
} from '../workgroupPersistence'
export {
  workgroupDraftSnapshotOf,
  workgroupSnapshotHashOf,
  workgroupRevisionOf,
  workgroupToDetail,
} from '../workgroupPersistence'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export type WorkgroupWritePrincipal =
  | { kind: 'actor'; actor: Actor }
  | { kind: 'system'; reason: string }

interface PreparedAgentMembers {
  /** Canonical agent id → current display name. */
  nameById: ReadonlyMap<string, string>
}

export async function listWorkgroups(db: ProviderNeutralDatabase): Promise<Workgroup[]> {
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

export async function getWorkgroupById(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<WorkgroupDetail | null> {
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
  db: ProviderNeutralDatabase,
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
export async function commitWorkgroupCreateInTx(
  tx: DatabaseTransaction,
  p: PreparedWorkgroupCreate,
): Promise<WorkgroupDetail> {
  const { groupId, input, ownerUserId, now } = p
  const aclOpts = { actor: p.actor }
  const preparedAgents = { nameById: p.preparedAgentsNameById }
  await assertHumanMembersActiveInTx(tx, input.members)
  const freshPreparedAgents = await prepareAgentMembersInTx(
    tx,
    aclOpts?.actor ?? null,
    input.members,
  )
  const memberValues = buildCreateMemberValues(groupId, input.members, now, {
    // Refresh display labels at the write linearization point. Retain the
    // preflight map only as a defensive fallback for framework fixtures.
    nameById: new Map([...preparedAgents.nameById, ...freshPreparedAgents.nameById]),
  })
  const leaderMemberId = resolveLeaderMemberId(input, memberValues)
  if (
    await tx
      .select({ id: workgroups.id })
      .from(workgroups)
      .where(ownerScopedNameWhere(workgroups.ownerUserId, workgroups.name, ownerUserId, input.name))
      .get()
  ) {
    throw new ConflictError('workgroup-name-in-use', `workgroup '${input.name}' already exists`)
  }
  const inserted = await insertWorkgroupInTx(tx, {
    id: groupId,
    document: input,
    leaderMemberId,
    ownerUserId,
    now,
  })
  await insertWorkgroupMembersInTx(tx, memberValues)
  const persistedMembers = await tx
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, groupId))
    .all()
  return workgroupToDetail(rowToWorkgroup(inserted, persistedMembers))
}

export async function createWorkgroup(
  db: ProviderNeutralDatabase,
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
    created = await databaseSessionFor(db).transaction(
      async (tx) => await commitWorkgroupCreateInTx(tx, prepared),
    )
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
  db: ProviderNeutralDatabase,
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
    created = await databaseSessionFor(db).transaction(async (tx) => {
      // Do not read roster rows until the actor passes the fresh ACL gate.
      const aclRow = await tx
        .select({
          id: workgroups.id,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(eq(workgroups.id, sourceId))
        .get()
      if (aclRow === undefined || !(await canViewResourceForTx(tx, actor, 'workgroup', aclRow))) {
        throwWorkgroupNotFound(sourceId)
      }

      const currentRow = await tx.select().from(workgroups).where(eq(workgroups.id, sourceId)).get()
      if (currentRow === undefined) throwWorkgroupNotFound(sourceId)
      const currentMembers = await tx
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
        throw staleConflictError(
          'workgroup',
          `workgroup '${sourceId}' changed; reload before copying`,
          { current: currentRevision },
        )
      }

      const sourceSnapshot = workgroupDraftSnapshotOf(source)
      await assertHumanMembersActiveInTx(tx, sourceSnapshot.members)
      const preparedAgents = await prepareAgentMembersInTx(tx, actor, sourceSnapshot.members)
      const occupiedNames = (
        await tx
          .select({ name: workgroups.name })
          .from(workgroups)
          .where(eq(workgroups.ownerUserId, actor.user.id))
          .all()
      ).map((row) => row.name)
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
      const inserted = await insertWorkgroupInTx(tx, {
        id,
        document: snapshot,
        leaderMemberId,
        ownerUserId: actor.user.id,
        now,
      })
      await insertWorkgroupMembersInTx(tx, memberValues)
      const persistedMembers = await tx
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
  db: ProviderNeutralDatabase,
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
  await assertPrincipalCanEditPreflight(db, principal, preflight)
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
export async function commitWorkgroupSaveInTx(
  tx: DatabaseTransaction,
  p: PreparedWorkgroupSave,
): Promise<{ receipt: SaveWorkgroupReceipt; committed: boolean }> {
  const { id, principal, parsed, snapshot, submittedBytes, preparedAgents } = p
  const currentRow = await tx.select().from(workgroups).where(eq(workgroups.id, id)).get()
  if (currentRow === undefined) throwWorkgroupNotFound(id)
  const access = await assertPrincipalCanEditInTx(tx, principal, currentRow)
  // The async preflight is not the authorization/validity linearization point: an administrator
  // can disable a mapped human during a long package pre-stage. Recheck in the same transaction
  // that writes the replacement roster, matching the create path's final fence.
  await assertHumanMembersActiveInTx(tx, snapshot.members)
  const memberRows = await tx
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, id))
    .all()
  const current = rowToWorkgroup(currentRow, memberRows)
  await assertRefsUsableForTx(tx, principal.kind === 'actor' ? principal.actor : null, [
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
    throw staleConflictError(
      'workgroup',
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

  // RFC-324 —— 改名是治理动作：先判资格，再判 owner 名字域是否撞车。
  assertNameUnchangedForEditor(access, current.name, snapshot.name)
  await assertNameChangeAllowedInTx(tx, current, snapshot.name)
  const rosterChanged = rosterBytes(currentSnapshot) !== rosterBytes(snapshot)
  const now = Date.now()
  const replacementMembers = rosterChanged
    ? buildDraftMemberValues(id, snapshot.members, now, preparedAgents)
    : null
  const leaderMemberId =
    replacementMembers === null
      ? currentRow.leaderMemberId
      : resolveLeaderMemberId(snapshot, replacementMembers)

  const returned = await tx
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
    throw staleConflictError('workgroup', `workgroup '${id}' changed; reload`, {
      current: currentRevision,
    })
  }

  if (replacementMembers !== null) {
    await tx.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, id)).run()
    await insertWorkgroupMembersInTx(tx, replacementMembers)
  }
  const returnedMembers = await tx
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
  db: ProviderNeutralDatabase,
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
  const result = await databaseSessionFor(db).transaction<{
    receipt: SaveWorkgroupReceipt
    committed: boolean
  }>(async (tx) => await commitWorkgroupSaveInTx(tx, prepared))

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
  db: ProviderNeutralDatabase,
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
  // RFC-359 W9：删除面从 bun:sqlite 独有的同步 `dbTxSync` 迁到中立事务原语，两个引擎共用一条。
  // 能迁是因为删除面的 in-tx 门（`assertPrincipalCanGovernInTx` / `assertNoScheduledReferencesInTx`）
  // 的**唯一**调用方就是这一笔，跟着改成异步零级联；create / copy / save 三笔仍钉着——它们体内的
  // `commitWorkgroupCreateInTx` / `commitWorkgroupSaveInTx` 与 `insertWorkgroupInTx` /
  // `insertWorkgroupMembersInTx` / `prepareAgentMembersInTx` / `assertHumanMembersActiveInTx`
  // 都被 aggregateAdapters 的 `(tx: DbTxSync, …) => …` 参与者契约共用。
  const deleted = await databaseSessionFor(db).transaction<{
    deletedVersion: number
    audience: WorkgroupDeletedAudienceContext
  }>(async (tx) => {
    const [currentRow] = await tx.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
    if (currentRow === undefined) throwWorkgroupNotFound(id)
    await assertPrincipalCanGovernForTx(tx, principal, currentRow)
    if (currentRow.version !== parsed.data.expectedVersion) {
      const members = await tx
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, id))
      throw staleConflictError(
        'workgroup',
        `workgroup '${id}' is at version ${currentRow.version}, expected ${parsed.data.expectedVersion}`,
        { current: workgroupRevisionOf(rowToWorkgroup(currentRow, members)) },
      )
    }
    await assertNoScheduledReferencesForTx(tx, principal, currentRow)
    // RFC-285 B2（D5/E3，能力收缩——Q2 现网检查已记 T5 实施记录）：删除中档
    // 统一——workgroup 从「可删留孤儿」收紧为拒**非终态**任务引用
    // （tasks.workgroupId 软链查询；终态引用不阻删，与 workflow/agent 同档）。
    // 披露沿 workflow.ts 的 task-ACL 论证：只给聚合 count。
    // 只用行数，不用 SQL 的 `count(*)`：**PG 的 `count` 回字符串**，`> 0` 在两个引擎上不同义。
    const nonTerminalRefs = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.workgroupId, id), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
        )
    ).length
    if (nonTerminalRefs > 0) {
      throw new ConflictError(
        'workgroup-in-use',
        `workgroup '${id}' has ${nonTerminalRefs} non-terminal task(s) referencing it; finish or cancel them first`,
        { referenceCount: nonTerminalRefs },
      )
    }
    // RFC-284 T10（§2.3）：grant 全清单查询收编 resourceAcl 单点。
    const audience: WorkgroupDeletedAudienceContext = {
      kind: 'workgroup.deleted-audience',
      workgroupId: id,
      visibility: currentRow.visibility,
      ownerUserId: currentRow.ownerUserId,
      grantedUserIds: new Set(await listResourceGrantUserIdsForTx(tx, 'workgroup', id)),
    }
    const [deleted] = await tx
      .delete(workgroups)
      .where(and(eq(workgroups.id, id), eq(workgroups.version, parsed.data.expectedVersion)))
      .returning({ id: workgroups.id })
    if (deleted === undefined) {
      throw staleConflictError('workgroup', `workgroup '${id}' changed; reload`)
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
  db: ProviderNeutralDatabase,
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

async function insertWorkgroupInTx(
  tx: DatabaseTransaction,
  input: {
    id: string
    document: WorkgroupInsertDocument
    leaderMemberId: string | null
    ownerUserId: string | null
    now: number
  },
): Promise<WorkgroupRow> {
  const inserted = await tx
    .insert(workgroups)
    .values({
      ...workgroupContentPersistenceValues(input),
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

async function insertWorkgroupMembersInTx(
  tx: DatabaseTransaction,
  members: ReadonlyArray<typeof workgroupMembers.$inferInsert>,
): Promise<void> {
  for (const member of members) await tx.insert(workgroupMembers).values(member).run()
}

export function broadcastWorkgroupCreated(created: WorkgroupDetail): void {
  workgroupsBroadcaster.broadcast(WORKGROUPS_CHANNEL, {
    type: 'workgroup.created',
    workgroupId: created.id,
    name: created.name,
    version: created.version,
  })
}

function rosterBytes(snapshot: WorkgroupDraftSnapshot): string {
  return JSON.stringify({
    leaderDisplayName: snapshot.leaderDisplayName ?? null,
    members: snapshot.members,
  })
}

async function loadRawWorkgroup(
  db: ProviderNeutralDatabase,
  id: string,
): Promise<WorkgroupRow | null> {
  const rows = await db.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
  return rows[0] ?? null
}

async function getWorkgroupDetailByRow(
  db: ProviderNeutralDatabase,
  row: WorkgroupRow,
): Promise<WorkgroupDetail> {
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, row.id))
  return workgroupToDetail(rowToWorkgroup(row, members))
}

/** RFC-324 —— 保存面的预检门：内容写；返回 access 供改名围栏用。 */
async function assertPrincipalCanEditPreflight(
  db: ProviderNeutralDatabase,
  principal: WorkgroupWritePrincipal,
  row: WorkgroupRow,
): Promise<ResourceAccess> {
  if (principal.kind === 'system') return 'own'
  const access = await resolveResourceAccessFor(db, principal.actor, 'workgroup', row)
  if (!canViewAccess(access)) throwWorkgroupNotFound(row.id)
  if (!canEditAccess(access)) throw workgroupReadOnlyError()
  return access
}

/** In-tx twin of the save gate — the authoritative one. */
async function assertPrincipalCanEditInTx(
  tx: DatabaseTransaction,
  principal: WorkgroupWritePrincipal,
  row: WorkgroupRow,
): Promise<ResourceAccess> {
  if (principal.kind === 'system') return 'own'
  // RFC-282 D1 — visibility and edit right come off ONE resolved verdict;
  // 404 before 403 is contract.
  const access = await resolveResourceAccessForTx(tx, principal.actor, 'workgroup', row)
  if (!canViewAccess(access)) throwWorkgroupNotFound(row.id)
  if (!canEditAccess(access)) throw workgroupReadOnlyError()
  return access
}

/** RFC-324 —— 删除面的 in-tx 门：治理写，编辑授权不覆盖。 */
async function assertPrincipalCanGovernForTx(
  tx: DatabaseTransaction,
  principal: WorkgroupWritePrincipal,
  row: WorkgroupRow,
): Promise<void> {
  if (principal.kind === 'system') return
  const access = await resolveResourceAccessForTx(tx, principal.actor, 'workgroup', row)
  if (!canViewAccess(access)) throwWorkgroupNotFound(row.id)
  if (!canGovernAccess(access)) {
    throw new ForbiddenError(
      'resource-govern-owner-only',
      'deleting, renaming, transferring or re-granting a workgroup is reserved for its owner',
    )
  }
}

function workgroupReadOnlyError(): ForbiddenError {
  return new ForbiddenError(
    'resource-read-only',
    'you have read-only access to this workgroup; ask its owner for an edit grant or make your own copy',
  )
}

async function assertNameChangeAllowedInTx(
  tx: DatabaseTransaction,
  current: Workgroup,
  nextName: string,
): Promise<void> {
  if (nextName === current.name) return
  const collision = await tx
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

async function assertNoScheduledReferencesForTx(
  tx: DatabaseTransaction,
  principal: WorkgroupWritePrincipal,
  target: { id: string; name: string },
): Promise<void> {
  const rows = await tx
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      launchKind: scheduledTasks.launchKind,
      launchPayload: scheduledTasks.launchPayload,
      ownerUserId: scheduledTasks.ownerUserId,
    })
    .from(scheduledTasks)
  // RFC-284 T9（§2.2）：内联副本收编 scheduledTasks.scheduledRowsReferencing。
  const refs = scheduledRowsReferencing(rows, {
    launchKind: 'workgroup',
    payloadKey: 'workgroupId',
    id: target.id,
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
  db: ProviderNeutralDatabase,
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

async function prepareAgentMembersInTx(
  tx: DatabaseTransaction,
  actor: Actor | null,
  members: ReadonlyArray<{ memberType: string; agentId?: string }>,
): Promise<PreparedAgentMembers> {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      ),
    ),
  ]
  await assertRefsUsableForTx(tx, actor, [{ type: 'agent', names: ids, domain: 'id' }])
  const rows =
    ids.length === 0
      ? []
      : await tx
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
  return workgroupMemberPersistenceValues(groupId, members, now, agentsPrepared.nameById, ulid)
}

function buildDraftMemberValues(
  groupId: string,
  members: readonly WorkgroupDraftMember[],
  now: number,
  agentsPrepared: PreparedAgentMembers,
): Array<typeof workgroupMembers.$inferInsert> {
  return workgroupMemberPersistenceValues(groupId, members, now, agentsPrepared.nameById, ulid)
}

async function assertHumanMembersActive(
  db: ProviderNeutralDatabase,
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

async function assertHumanMembersActiveInTx(
  tx: DatabaseTransaction,
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
  const rows = await tx
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

export function rowToWorkgroup(row: WorkgroupRow, memberRows: MemberRow[]): Workgroup {
  return workgroupFromCopiedRows(row, memberRows.slice())
}

function throwWorkgroupNotFound(id: string): never {
  throw new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
}
