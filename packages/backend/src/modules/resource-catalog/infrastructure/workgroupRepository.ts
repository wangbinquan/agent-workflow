// RFC-359 W4-D18 —— Workgroup 聚合的唯一仓库实现（此前 `sqliteWorkgroupRepository` / `postgresqlWorkgroupRepository`
// 各一份、逐字同形）。写路径全在统一的 serializable 事务里；owner + name 唯一冲突经能力矩阵 `uniqueViolationTarget`
// 映射回 `workgroup-name-in-use` / `workgroup-copy-name-conflict`。
import {
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  TERMINAL_TASK_STATUSES,
  WorkgroupNameSchema,
  type CreateWorkgroup,
  type ResourceAccess,
  type SaveWorkgroupReceipt,
  type Workgroup,
  type WorkgroupDetail,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm'
import { agents, scheduledTasks, tasks, users, workgroupMembers, workgroups } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
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
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'
import {
  normalizeWorkgroupSnapshot as normalizeSnapshot,
  workgroupDraftSnapshotOf as snapshotOf,
  workgroupRevisionOf as revisionOf,
  workgroupToDetail as detailOf,
  workgroupFromCopiedRows,
  workgroupMemberPersistenceValues as memberValues,
  resolveWorkgroupLeaderMemberId as leaderMemberId,
  workgroupContentPersistenceValues,
} from './workgroupPersistence'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export interface WorkgroupAclIdentityRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface WorkgroupScheduledReferenceRow {
  readonly id: string
  readonly name: string
  readonly launchKind: string
  readonly launchPayload: string
  readonly ownerUserId: string
}

export interface WorkgroupRepositoryDependencies {
  readonly canViewInTransaction: (
    transaction: ResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    row: WorkgroupAclIdentityRow,
  ) => Promise<boolean>
  readonly resolveAccessInTransaction: (
    transaction: ResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    row: WorkgroupRow,
  ) => Promise<ResourceAccess>
  readonly assertAgentIdsUsable: (
    authority: WorkgroupOperationContext,
    ids: readonly string[],
    grandfatheredIds: ReadonlySet<string>,
  ) => Promise<void>
  readonly assertAgentIdsUsableInTransaction: (
    transaction: ResourceCatalogTransaction,
    authority: WorkgroupOperationContext,
    ids: readonly string[],
  ) => Promise<void>
  readonly listGrantedUserIdsInTransaction: (
    transaction: ResourceCatalogTransaction,
    workgroupId: string,
  ) => Promise<readonly string[]>
  readonly scheduledReferences: (
    rows: readonly WorkgroupScheduledReferenceRow[],
    workgroupId: string,
  ) => readonly WorkgroupScheduledReferenceRow[]
  readonly nextCopyName: (sourceName: string, occupiedNames: readonly string[]) => string
  readonly assertNameUnchangedForEditor: (
    access: ResourceAccess,
    currentName: string,
    nextName: string,
  ) => void
  readonly memberId: () => string
  readonly now: () => number
}

export interface WorkgroupRepositoryBundle {
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

export function workgroupFromRows(row: WorkgroupRow, memberRows: readonly MemberRow[]): Workgroup {
  return workgroupFromCopiedRows(row, [...memberRows])
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
  database: ProviderNeutralDatabase | ResourceCatalogTransaction,
  members: ReadonlyArray<{ readonly memberType: string; readonly userId?: string }>,
): Promise<void> {
  const ids = activeHumanIds(members)
  if (ids.length === 0) return
  const rows = await database
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

async function agentNames(
  database: ProviderNeutralDatabase | ResourceCatalogTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows =
    ids.length === 0
      ? []
      : await database
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, ids))
  const names = new Map(rows.map((row) => [row.id, row.name]))
  const missing = ids.filter((id) => !names.has(id))
  if (missing.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missing,
    })
  }
  return names
}

async function insertMembers(
  transaction: ResourceCatalogTransaction,
  members: readonly (typeof workgroupMembers.$inferInsert)[],
): Promise<void> {
  for (const member of members) {
    await transaction.insert(workgroupMembers).values(member)
  }
}

async function insertWorkgroup(
  transaction: ResourceCatalogTransaction,
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
  const row = (
    await transaction
      .insert(workgroups)
      .values({
        ...workgroupContentPersistenceValues(input),
        ...input.initialAcl,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning()
  )[0]
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
  transaction: ResourceCatalogTransaction,
  current: Workgroup,
  nextName: string,
): Promise<void> {
  if (current.name === nextName) return
  const collision = (
    await transaction
      .select({ id: workgroups.id })
      .from(workgroups)
      .where(ownerScopedNameWhere(current.ownerUserId ?? null, nextName, current.id))
      .limit(1)
  )[0]
  if (collision !== undefined) {
    throw new ConflictError(
      'workgroup-name-in-use',
      `workgroup '${nextName}' already exists; pick a different name`,
    )
  }
}

export function createWorkgroupRepository(
  db: ProviderNeutralDatabase,
  deps: WorkgroupRepositoryDependencies,
): WorkgroupRepositoryBundle {
  const engine = databaseSessionFor(db).engine
  const isOwnerNameConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /workgroups[._](?:owner|name)/i.test(target)
  }
  async function get(id: string): Promise<WorkgroupDetail | null> {
    return runResourceCatalogTransaction(db, async (transaction) => {
      const row = (
        await transaction.select().from(workgroups).where(eq(workgroups.id, id)).limit(1)
      )[0]
      if (row === undefined) return null
      const members = await transaction
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, id))
      return detailOf(workgroupFromRows(row, members))
    })
  }

  const projection: WorkgroupProjection = Object.freeze({
    resourceOf: (workgroup: Workgroup) => Object.freeze({ ...workgroup }),
    snapshotOf,
  })

  const repository: WorkgroupRepository = {
    async list(): Promise<readonly Workgroup[]> {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const rows = await transaction.select().from(workgroups)
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
        const byGroup = new Map<string, MemberRow[]>()
        for (const member of members) {
          const bucket = byGroup.get(member.workgroupId)
          if (bucket === undefined) byGroup.set(member.workgroupId, [member])
          else bucket.push(member)
        }
        return rows.map((row) => workgroupFromRows(row, byGroup.get(row.id) ?? []))
      })
    },
    get,
    async create(input): Promise<WorkgroupDetail> {
      await assertHumansActive(db, input.document.members)
      const ids = agentIds(input.document.members)
      await deps.assertAgentIdsUsable(input.authority, ids, new Set())
      await agentNames(db, ids)
      try {
        return await runResourceCatalogTransaction(db, async (transaction) => {
          await assertHumansActive(transaction, input.document.members)
          await deps.assertAgentIdsUsableInTransaction(transaction, input.authority, ids)
          const names = await agentNames(transaction, ids)
          const collision = (
            await transaction
              .select({ id: workgroups.id })
              .from(workgroups)
              .where(ownerScopedNameWhere(input.initialAcl.ownerUserId, input.document.name))
              .limit(1)
          )[0]
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
          return detailOf(workgroupFromRows(row, persistedMembers))
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
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
        return await runResourceCatalogTransaction(db, async (transaction) => {
          const aclRow = (
            await transaction
              .select({
                id: workgroups.id,
                ownerUserId: workgroups.ownerUserId,
                visibility: workgroups.visibility,
              })
              .from(workgroups)
              .where(eq(workgroups.id, input.request.id))
              .limit(1)
          )[0]
          if (
            aclRow === undefined ||
            !(await deps.canViewInTransaction(transaction, input.authority, aclRow))
          ) {
            notFound(input.request.id)
          }
          const row = (
            await transaction
              .select()
              .from(workgroups)
              .where(eq(workgroups.id, input.request.id))
              .limit(1)
          )[0]
          if (row === undefined) notFound(input.request.id)
          const currentMembers = await transaction
            .select()
            .from(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, row.id))
          const source = workgroupFromRows(row, currentMembers)
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
          return detailOf(workgroupFromRows(inserted, persistedMembers))
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) {
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
      const preflight = (
        await db.select().from(workgroups).where(eq(workgroups.id, input.id)).limit(1)
      )[0]
      if (preflight === undefined) notFound(input.id)
      const snapshot = normalizeSnapshot(input.update.snapshot, preflight.outputContract)
      const submittedBytes = serializeWorkgroupEditableSnapshotV1(snapshot)
      const currentMembers = await db
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, input.id))
      await assertHumansActive(db, snapshot.members)
      const ids = agentIds(snapshot.members)
      await deps.assertAgentIdsUsable(
        authority,
        ids,
        new Set(currentMembers.flatMap((member) => (member.agentId ? [member.agentId] : []))),
      )
      return runResourceCatalogTransaction(db, async (transaction) => {
        const row = (
          await transaction.select().from(workgroups).where(eq(workgroups.id, input.id)).limit(1)
        )[0]
        if (row === undefined) notFound(input.id)
        const access = await deps.resolveAccessInTransaction(transaction, authority, row)
        assertEditAccess(access, input.id)
        await assertHumansActive(transaction, snapshot.members)
        const memberRows = await transaction
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, input.id))
        const current = workgroupFromRows(row, memberRows)
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
        const updated = (
          await transaction
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
              and(
                eq(workgroups.id, input.id),
                eq(workgroups.version, input.update.expectedVersion),
              ),
            )
            .returning()
        )[0]
        if (updated === undefined) {
          throw staleConflictError('workgroup', `workgroup '${input.id}' changed; reload`, {
            current: currentRevision,
          })
        }
        if (replacement !== null) {
          await transaction
            .delete(workgroupMembers)
            .where(eq(workgroupMembers.workgroupId, input.id))
          await insertMembers(transaction, replacement)
        }
        const returnedMembers = await transaction
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, input.id))
        const detail = detailOf(workgroupFromRows(updated, returnedMembers))
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
      return runResourceCatalogTransaction(db, async (transaction) => {
        const row = (
          await transaction.select().from(workgroups).where(eq(workgroups.id, input.id)).limit(1)
        )[0]
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
          throw staleConflictError(
            'workgroup',
            `workgroup '${input.id}' is at version ${row.version}, expected ${input.deletion.expectedVersion}`,
            { current: revisionOf(workgroupFromRows(row, members)) },
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
        const deleted = (
          await transaction
            .delete(workgroups)
            .where(
              and(
                eq(workgroups.id, input.id),
                eq(workgroups.version, input.deletion.expectedVersion),
              ),
            )
            .returning({ id: workgroups.id })
        )[0]
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
