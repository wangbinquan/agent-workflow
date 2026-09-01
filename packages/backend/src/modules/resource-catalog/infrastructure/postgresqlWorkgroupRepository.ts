import {
  QUARANTINED_SNAPSHOT_AGENT_ID,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  TERMINAL_TASK_STATUSES,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  WorkgroupNameSchema,
  type CreateWorkgroup,
  type ResourceAccess,
  type SaveWorkgroupReceipt,
  type Workgroup,
  type WorkgroupDetail,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
  type WorkgroupMember,
  type WorkgroupRevision,
  type WorkgroupSnapshotHash,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm'
import { agents, scheduledTasks, tasks, users, workgroupMembers, workgroups } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import {
  canEditAccess,
  canGovernAccess,
  canViewAccess,
  discloseScheduleRefs,
} from '../domain/resourceAccess'
import type { UpdateWorkgroupCatalogInput } from '../public/types'
import type { WorkgroupOperationContext } from '../public/participants'
import type {
  ValidatedWorkgroupDeleteInput,
  WorkgroupDeleteResult,
  WorkgroupProjection,
  WorkgroupRepository,
  WorkgroupSaveResult,
} from '../application/workgroups/ports'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export interface PostgresqlWorkgroupAccessRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface PostgresqlWorkgroupScheduledReferenceRow {
  readonly id: string
  readonly name: string
  readonly launchKind: string
  readonly launchPayload: string
  readonly ownerUserId: string
}

export interface PostgresqlWorkgroupRepositoryDependencies {
  readonly canViewInTransaction: (
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    row: PostgresqlWorkgroupAccessRow,
  ) => Promise<boolean>
  readonly resolveAccessInTransaction: (
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    row: WorkgroupRow,
  ) => Promise<ResourceAccess>
  readonly assertAgentIdsUsable: (
    authority: WorkgroupOperationContext,
    ids: readonly string[],
    grandfatheredIds: ReadonlySet<string>,
  ) => Promise<void>
  readonly assertAgentIdsUsableInTransaction: (
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    ids: readonly string[],
  ) => Promise<void>
  readonly listGrantedUserIdsInTransaction: (
    transaction: PostgresqlResourceCatalogTransaction,
    workgroupId: string,
  ) => Promise<readonly string[]>
  readonly scheduledReferences: (
    rows: readonly PostgresqlWorkgroupScheduledReferenceRow[],
    workgroupId: string,
  ) => readonly PostgresqlWorkgroupScheduledReferenceRow[]
  readonly nextCopyName: (sourceName: string, occupiedNames: readonly string[]) => string
  readonly assertNameUnchangedForEditor: (
    access: ResourceAccess,
    currentName: string,
    nextName: string,
  ) => void
  readonly memberId: () => string
  readonly now: () => number
}

export interface PostgresqlWorkgroupRepositoryBundle {
  readonly repository: WorkgroupRepository
  readonly projection: WorkgroupProjection
}

function notFound(id: string): never {
  throw new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
}

function readOnly(): ForbiddenError {
  return new ForbiddenError(
    'resource-read-only',
    'you have read-only access to this workgroup; ask its owner for an edit grant or make your own copy',
  )
}

function normalizeSnapshot(
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

function snapshotOf(group: Workgroup): WorkgroupDraftSnapshot {
  const ordered = [...group.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return normalizeSnapshot({
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

function snapshotHashOf(snapshot: WorkgroupDraftSnapshot): WorkgroupSnapshotHash {
  return sha256Hex(
    serializeWorkgroupEditableSnapshotV1(normalizeSnapshot(snapshot)),
  ) as WorkgroupSnapshotHash
}

function revisionOf(group: Workgroup): WorkgroupRevision {
  const snapshot = snapshotOf(group)
  return {
    workgroupId: group.id,
    version: group.version,
    snapshotHash: snapshotHashOf(snapshot),
    updatedAt: group.updatedAt,
  }
}

function detailOf(group: Workgroup): WorkgroupDetail {
  return { ...group, snapshotHash: snapshotHashOf(snapshotOf(group)) }
}

export function workgroupFromPostgresqlRows(
  row: WorkgroupRow,
  memberRows: readonly MemberRow[],
): Workgroup {
  const members: WorkgroupMember[] = [...memberRows]
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

function rosterBytes(snapshot: WorkgroupDraftSnapshot): string {
  return JSON.stringify({
    leaderDisplayName: snapshot.leaderDisplayName ?? null,
    members: snapshot.members,
  })
}

function agentIds(
  members: ReadonlyArray<{ readonly memberType: string; readonly agentId?: string }>,
): string[] {
  return [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      ),
    ),
  ]
}

function newAgentIds(
  previous: Pick<Workgroup, 'members'> | null,
  next: ReadonlyArray<{ readonly memberType: string; readonly agentId?: string }>,
): string[] {
  const previousIds = new Set(
    (previous?.members ?? []).flatMap((member) =>
      member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
    ),
  )
  return agentIds(next).filter((id) => !previousIds.has(id))
}

function activeHumanIds(
  members: ReadonlyArray<{ readonly memberType: string; readonly userId?: string }>,
): string[] {
  return [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'human' && member.userId ? [member.userId] : [],
      ),
    ),
  ]
}

async function assertHumansActive(
  database: PostgresqlDatabaseClient | PostgresqlResourceCatalogTransaction,
  members: ReadonlyArray<{ readonly memberType: string; readonly userId?: string }>,
): Promise<void> {
  const ids = activeHumanIds(members)
  if (ids.length === 0) return
  const rows = await database
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

async function agentNames(
  database: PostgresqlDatabaseClient | PostgresqlResourceCatalogTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows =
    ids.length === 0
      ? []
      : await database
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids))
          .all()
  const names = new Map(rows.map((row) => [row.id, row.name]))
  const missing = ids.filter((id) => !names.has(id))
  if (missing.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missing,
    })
  }
  return names
}

function memberValues(
  workgroupId: string,
  members: readonly WorkgroupDraftMember[],
  now: number,
  names: ReadonlyMap<string, string>,
  nextId: () => string,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((member, index) => ({
    id: nextId(),
    workgroupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId ? (names.get(member.agentId) ?? null) : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
    createdAt: now,
  }))
}

function leaderMemberId(
  input: { readonly mode: string; readonly leaderDisplayName?: string },
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

async function insertMembers(
  transaction: PostgresqlResourceCatalogTransaction,
  members: readonly (typeof workgroupMembers.$inferInsert)[],
): Promise<void> {
  for (const member of members) {
    await transaction.insert(workgroupMembers).values(member).run()
  }
}

async function insertWorkgroup(
  transaction: PostgresqlResourceCatalogTransaction,
  input: {
    readonly id: string
    readonly document: CreateWorkgroup | WorkgroupDraftSnapshot
    readonly leaderMemberId: string | null
    readonly initialAcl: {
      readonly ownerUserId: string | null
      readonly visibility: 'private'
      readonly aclRevision: 0
    }
    readonly now: number
  },
): Promise<WorkgroupRow> {
  const row = await transaction
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
      ...input.initialAcl,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get()
  if (row === undefined) throw new Error('workgroup insert returned no row')
  return row
}

function assertEditAccess(access: ResourceAccess, id: string): void {
  if (!canViewAccess(access)) notFound(id)
  if (!canEditAccess(access)) throw readOnly()
}

function assertGovernAccess(access: ResourceAccess, id: string): void {
  if (!canViewAccess(access)) notFound(id)
  if (!canGovernAccess(access)) {
    throw new ForbiddenError(
      'resource-govern-owner-only',
      'deleting, renaming, transferring or re-granting a workgroup is reserved for its owner',
    )
  }
}

function ownerScopedNameWhere(ownerUserId: string | null, name: string, excludeId?: string) {
  const owner =
    ownerUserId === null ? isNull(workgroups.ownerUserId) : eq(workgroups.ownerUserId, ownerUserId)
  const identity = and(owner, eq(workgroups.name, name))
  return excludeId === undefined ? identity : and(identity, ne(workgroups.id, excludeId))
}

async function assertNameAvailableInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
  current: Workgroup,
  nextName: string,
): Promise<void> {
  if (current.name === nextName) return
  const collision = await transaction
    .select({ id: workgroups.id })
    .from(workgroups)
    .where(ownerScopedNameWhere(current.ownerUserId ?? null, nextName, current.id))
    .get()
  if (collision !== undefined) {
    throw new ConflictError(
      'workgroup-name-in-use',
      `workgroup '${nextName}' already exists; pick a different name`,
    )
  }
}

export function createPostgresqlWorkgroupRepository(
  db: PostgresqlDatabaseClient,
  deps: PostgresqlWorkgroupRepositoryDependencies,
): PostgresqlWorkgroupRepositoryBundle {
  async function get(id: string): Promise<WorkgroupDetail | null> {
    return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
      const row = await transaction
        .select()
        .from(workgroups)
        .where(eq(workgroups.id, id))
        .limit(1)
        .get()
      if (row === undefined) return null
      const members = await transaction
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, id))
        .all()
      return detailOf(workgroupFromPostgresqlRows(row, members))
    })
  }

  const projection: WorkgroupProjection = Object.freeze({
    resourceOf: (workgroup: Workgroup) => Object.freeze({ ...workgroup }),
    snapshotOf,
  })

  const repository: WorkgroupRepository = {
    async list(): Promise<readonly Workgroup[]> {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const rows = await transaction.select().from(workgroups).all()
        if (rows.length === 0) return []
        const members = await transaction
          .select()
          .from(workgroupMembers)
          .where(
            inArray(
              workgroupMembers.workgroupId,
              rows.map((row) => row.id),
            ),
          )
          .all()
        const byGroup = new Map<string, MemberRow[]>()
        for (const member of members) {
          const bucket = byGroup.get(member.workgroupId)
          if (bucket === undefined) byGroup.set(member.workgroupId, [member])
          else bucket.push(member)
        }
        return rows.map((row) => workgroupFromPostgresqlRows(row, byGroup.get(row.id) ?? []))
      })
    },
    get,
    async create(input): Promise<WorkgroupDetail> {
      await assertHumansActive(db, input.document.members)
      const ids = agentIds(input.document.members)
      await deps.assertAgentIdsUsable(input.authority, ids, new Set())
      await agentNames(db, ids)
      try {
        return await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          await assertHumansActive(transaction, input.document.members)
          await deps.assertAgentIdsUsableInTransaction(transaction, input.authority, ids)
          const names = await agentNames(transaction, ids)
          const collision = await transaction
            .select({ id: workgroups.id })
            .from(workgroups)
            .where(ownerScopedNameWhere(input.initialAcl.ownerUserId, input.document.name))
            .get()
          if (collision !== undefined) {
            throw new ConflictError(
              'workgroup-name-in-use',
              `workgroup '${input.document.name}' already exists`,
            )
          }
          const values = memberValues(
            input.id,
            input.document.members,
            input.now,
            names,
            deps.memberId,
          )
          const row = await insertWorkgroup(transaction, {
            id: input.id,
            document: input.document,
            leaderMemberId: leaderMemberId(input.document, values),
            initialAcl: input.initialAcl,
            now: input.now,
          })
          await insertMembers(transaction, values)
          const persistedMembers = await transaction
            .select()
            .from(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, input.id))
            .all()
          return detailOf(workgroupFromPostgresqlRows(row, persistedMembers))
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['workgroups_owner_name_unique'])) {
          throw new ConflictError(
            'workgroup-name-in-use',
            `workgroup '${input.document.name}' already exists`,
          )
        }
        throw error
      }
    },
    async copy(input): Promise<WorkgroupDetail> {
      try {
        return await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          const aclRow = await transaction
            .select({
              id: workgroups.id,
              ownerUserId: workgroups.ownerUserId,
              visibility: workgroups.visibility,
            })
            .from(workgroups)
            .where(eq(workgroups.id, input.request.id))
            .get()
          if (
            aclRow === undefined ||
            !(await deps.canViewInTransaction(transaction, input.authority, aclRow))
          ) {
            notFound(input.request.id)
          }
          const row = await transaction
            .select()
            .from(workgroups)
            .where(eq(workgroups.id, input.request.id))
            .get()
          if (row === undefined) notFound(input.request.id)
          const currentMembers = await transaction
            .select()
            .from(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, row.id))
            .all()
          const source = workgroupFromPostgresqlRows(row, currentMembers)
          const revision = revisionOf(source)
          if (
            input.request.copy.expectedVersion !== revision.version ||
            input.request.copy.expectedSnapshotHash !== revision.snapshotHash
          ) {
            throw staleConflictError(
              'workgroup',
              `workgroup '${source.id}' changed; reload before copying`,
              { current: revision },
            )
          }
          const sourceSnapshot = snapshotOf(source)
          await assertHumansActive(transaction, sourceSnapshot.members)
          const ids = agentIds(sourceSnapshot.members)
          await deps.assertAgentIdsUsableInTransaction(transaction, input.authority, ids)
          const names = await agentNames(transaction, ids)
          const occupiedNames = (
            await transaction
              .select({ name: workgroups.name })
              .from(workgroups)
              .where(eq(workgroups.ownerUserId, input.authority.user.id))
              .all()
          ).map((candidate) => candidate.name)
          const name = WorkgroupNameSchema.parse(
            deps.nextCopyName(sourceSnapshot.name, occupiedNames),
          )
          const document = { ...sourceSnapshot, name }
          const values = memberValues(input.id, document.members, input.now, names, deps.memberId)
          const inserted = await insertWorkgroup(transaction, {
            id: input.id,
            document,
            leaderMemberId: leaderMemberId(document, values),
            initialAcl: input.initialAcl,
            now: input.now,
          })
          await insertMembers(transaction, values)
          const persistedMembers = await transaction
            .select()
            .from(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, input.id))
            .all()
          return detailOf(workgroupFromPostgresqlRows(inserted, persistedMembers))
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['workgroups_owner_name_unique'])) {
          throw new ConflictError(
            'workgroup-copy-name-conflict',
            'the next copy name was claimed; try copying again',
          )
        }
        throw error
      }
    },
    async save(
      authority: WorkgroupOperationContext,
      input: UpdateWorkgroupCatalogInput,
    ): Promise<WorkgroupSaveResult> {
      const preflight = await db
        .select()
        .from(workgroups)
        .where(eq(workgroups.id, input.id))
        .limit(1)
        .get()
      if (preflight === undefined) notFound(input.id)
      const snapshot = normalizeSnapshot(input.update.snapshot, preflight.outputContract)
      const submittedBytes = serializeWorkgroupEditableSnapshotV1(snapshot)
      const currentMembers = await db
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, input.id))
        .all()
      await assertHumansActive(db, snapshot.members)
      const ids = agentIds(snapshot.members)
      await deps.assertAgentIdsUsable(
        authority,
        ids,
        new Set(currentMembers.flatMap((member) => (member.agentId ? [member.agentId] : []))),
      )
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const row = await transaction
          .select()
          .from(workgroups)
          .where(eq(workgroups.id, input.id))
          .get()
        if (row === undefined) notFound(input.id)
        const access = await deps.resolveAccessInTransaction(transaction, authority, row)
        assertEditAccess(access, input.id)
        await assertHumansActive(transaction, snapshot.members)
        const memberRows = await transaction
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, input.id))
          .all()
        const current = workgroupFromPostgresqlRows(row, memberRows)
        await deps.assertAgentIdsUsableInTransaction(
          transaction,
          authority,
          newAgentIds(current, snapshot.members),
        )
        const preparedNames = await agentNames(transaction, ids)
        const currentSnapshot = snapshotOf(current)
        const currentBytes = serializeWorkgroupEditableSnapshotV1(currentSnapshot)
        const currentRevision = revisionOf(current)
        const logicalSame = currentBytes === submittedBytes
        if (row.version !== input.update.expectedVersion) {
          if (logicalSame) {
            return {
              receipt: {
                clientMutationId: input.update.clientMutationId,
                requestedBaseVersion: input.update.expectedVersion,
                revision: currentRevision,
                snapshot: currentSnapshot,
                workgroup: detailOf(current),
                outcome: 'already-current',
              },
              committed: false,
            }
          }
          throw staleConflictError(
            'workgroup',
            `workgroup '${input.id}' is at version ${row.version}, expected ${input.update.expectedVersion}`,
            { current: currentRevision },
          )
        }
        if (logicalSame) {
          return {
            receipt: {
              clientMutationId: input.update.clientMutationId,
              requestedBaseVersion: input.update.expectedVersion,
              revision: currentRevision,
              snapshot: currentSnapshot,
              workgroup: detailOf(current),
              outcome: 'already-current',
            },
            committed: false,
          }
        }
        deps.assertNameUnchangedForEditor(access, current.name, snapshot.name)
        await assertNameAvailableInTransaction(transaction, current, snapshot.name)
        const rosterChanged = rosterBytes(currentSnapshot) !== rosterBytes(snapshot)
        const now = deps.now()
        const replacement = rosterChanged
          ? memberValues(input.id, snapshot.members, now, preparedNames, deps.memberId)
          : null
        const nextLeaderId =
          replacement === null ? row.leaderMemberId : leaderMemberId(snapshot, replacement)
        const updated = await transaction
          .update(workgroups)
          .set({
            name: snapshot.name,
            description: snapshot.description,
            instructions: snapshot.instructions,
            mode: snapshot.mode,
            outputContract: resolveWorkgroupOutputContract(snapshot.outputContract),
            leaderMemberId: nextLeaderId,
            shareOutputs: snapshot.switches.shareOutputs,
            directMessages: snapshot.switches.directMessages,
            blackboard: snapshot.switches.blackboard,
            maxRounds: snapshot.maxRounds,
            completionGate: snapshot.completionGate,
            clarifyBudget: snapshot.clarifyBudget,
            fanOut: snapshot.fanOut,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(
            and(eq(workgroups.id, input.id), eq(workgroups.version, input.update.expectedVersion)),
          )
          .returning()
          .get()
        if (updated === undefined) {
          throw staleConflictError('workgroup', `workgroup '${input.id}' changed; reload`, {
            current: currentRevision,
          })
        }
        if (replacement !== null) {
          await transaction
            .delete(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, input.id))
            .run()
          await insertMembers(transaction, replacement)
        }
        const returnedMembers = await transaction
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, input.id))
          .all()
        const detail = detailOf(workgroupFromPostgresqlRows(updated, returnedMembers))
        const committedSnapshot = snapshotOf(detail)
        const receipt: SaveWorkgroupReceipt = {
          clientMutationId: input.update.clientMutationId,
          requestedBaseVersion: input.update.expectedVersion,
          revision: revisionOf(detail),
          snapshot: committedSnapshot,
          workgroup: detail,
          outcome: 'committed',
        }
        return { receipt, committed: true }
      })
    },
    async delete(
      authority: WorkgroupOperationContext,
      input: ValidatedWorkgroupDeleteInput,
    ): Promise<WorkgroupDeleteResult> {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const row = await transaction
          .select()
          .from(workgroups)
          .where(eq(workgroups.id, input.id))
          .get()
        if (row === undefined) notFound(input.id)
        assertGovernAccess(
          await deps.resolveAccessInTransaction(transaction, authority, row),
          input.id,
        )
        if (row.version !== input.deletion.expectedVersion) {
          const members = await transaction
            .select()
            .from(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, input.id))
            .all()
          throw staleConflictError(
            'workgroup',
            `workgroup '${input.id}' is at version ${row.version}, expected ${input.deletion.expectedVersion}`,
            { current: revisionOf(workgroupFromPostgresqlRows(row, members)) },
          )
        }
        const scheduledRows = await transaction
          .select({
            id: scheduledTasks.id,
            name: scheduledTasks.name,
            launchKind: scheduledTasks.launchKind,
            launchPayload: scheduledTasks.launchPayload,
            ownerUserId: scheduledTasks.ownerUserId,
          })
          .from(scheduledTasks)
          .all()
        const scheduledRefs = deps.scheduledReferences(scheduledRows, input.id)
        if (scheduledRefs.length > 0) {
          throw new ConflictError(
            'workgroup-scheduled-referenced',
            `workgroup '${row.name}' is the target of ${scheduledRefs.length} scheduled task(s); delete or repoint them first`,
            discloseScheduleRefs(authority, scheduledRefs),
          )
        }
        const nonTerminalRefs = (
          await transaction
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.workgroupId, input.id),
                notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
              ),
            )
            .all()
        ).length
        if (nonTerminalRefs > 0) {
          throw new ConflictError(
            'workgroup-in-use',
            `workgroup '${input.id}' has ${nonTerminalRefs} non-terminal task(s) referencing it; finish or cancel them first`,
            { referenceCount: nonTerminalRefs },
          )
        }
        const audience = {
          kind: 'workgroup.deleted-audience' as const,
          workgroupId: input.id,
          visibility: row.visibility,
          ownerUserId: row.ownerUserId,
          grantedUserIds: new Set(
            await deps.listGrantedUserIdsInTransaction(transaction, input.id),
          ),
        }
        const deleted = await transaction
          .delete(workgroups)
          .where(
            and(
              eq(workgroups.id, input.id),
              eq(workgroups.version, input.deletion.expectedVersion),
            ),
          )
          .returning({ id: workgroups.id })
          .get()
        if (deleted === undefined) {
          throw staleConflictError('workgroup', `workgroup '${input.id}' changed; reload`)
        }
        return {
          receipt: {
            id: input.id,
            deletedVersion: row.version,
            clientMutationId: input.deletion.clientMutationId,
          },
          audience,
        }
      })
    },
  }

  return Object.freeze({ repository: Object.freeze(repository), projection })
}
