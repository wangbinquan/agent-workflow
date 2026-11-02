import type { SubjectTaskReferencePort } from '../composition/required-ports'
// RFC-359 W4-D18 —— Workgroup 聚合的唯一仓库实现（此前 `sqliteWorkgroupRepository` / `postgresqlWorkgroupRepository`
// 各一份、逐字同形）。写路径全在统一的 serializable 事务里。RFC-401 A3b：新建 / 复制 / 保存的成员校验、版本 fence、
// 名称冲突与成员行重建交给唯一的 workgroup 写入参与者（`workgroupMutationParticipant.ts`）；这里只剩普通编辑自己的规则
// （编辑权、改名权限、复制命名与复制名冲突 `workgroup-copy-name-conflict`）、删除与读。
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import {
  WorkgroupNameSchema,
  type ResourceAccess,
  type SaveWorkgroupReceipt,
  type Workgroup,
  type WorkgroupDetail,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ConflictError, ForbiddenError, NotFoundError, staleConflictError } from '@/util/errors'
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
import { createWorkgroupMutationParticipant } from './workgroupMutationParticipant'
import {
  normalizeWorkgroupSnapshot as normalizeSnapshot,
  workgroupCreateSnapshot,
  workgroupDraftSnapshotOf as snapshotOf,
  workgroupRevisionOf as revisionOf,
  workgroupToDetail as detailOf,
  workgroupFromCopiedRows,
} from './workgroupPersistence'

type WorkgroupRow = PersistenceTables['workgroups']['$inferSelect']
type MemberRow = PersistenceTables['workgroupMembers']['$inferSelect']

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
  readonly taskReferences: SubjectTaskReferencePort
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

export function createWorkgroupRepository(
  db: PersistenceDb,
  deps: WorkgroupRepositoryDependencies,
): WorkgroupRepositoryBundle {
  /** RFC-401 A3b：新建、复制、保存都经唯一的 workgroup 写入参与者（design §9.5）。 */
  const mutations = (transaction: ResourceCatalogTransaction, now: () => number) =>
    createWorkgroupMutationParticipant(transaction, { now, memberId: deps.memberId })
  async function get(id: string): Promise<WorkgroupDetail | null> {
    return runResourceCatalogTransaction(db, async (transaction) => {
      const { workgroups, workgroupMembers } = tablesOf(transaction)
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
        const { workgroups, workgroupMembers } = tablesOf(transaction)
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
      return runResourceCatalogTransaction(db, async (transaction) =>
        detailOf(
          await mutations(transaction, () => input.now).create(input.authority, {
            id: input.id,
            snapshot: workgroupCreateSnapshot(input.document),
          }),
        ),
      )
    },
    async copy(input): Promise<WorkgroupDetail> {
      try {
        return await runResourceCatalogTransaction(db, async (transaction) => {
          const { workgroups, workgroupMembers } = tablesOf(transaction)
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
          const occupiedNames = (
            await transaction
              .select({ name: workgroups.name })
              .from(workgroups)
              .where(eq(workgroups.ownerUserId, input.authority.user.id))
          ).map((candidate) => candidate.name)
          const name = WorkgroupNameSchema.parse(
            deps.nextCopyName(sourceSnapshot.name, occupiedNames),
          )
          return detailOf(
            await mutations(transaction, () => input.now).create(input.authority, {
              id: input.id,
              snapshot: { ...sourceSnapshot, name },
              provenance: 'copy',
            }),
          )
        })
      } catch (error) {
        // 复制名在同一事务里按已占用的名字分配；撞上只可能是并发复制抢先占了它。
        if (error instanceof ConflictError && error.code === 'workgroup-name-in-use') {
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
      return runResourceCatalogTransaction(db, async (transaction) => {
        const { workgroups } = tablesOf(transaction)
        const row = (
          await transaction.select().from(workgroups).where(eq(workgroups.id, input.id)).limit(1)
        )[0]
        if (row === undefined) notFound(input.id)
        const access = await deps.resolveAccessInTransaction(transaction, authority, row)
        assertEditAccess(access, input.id)
        const saved = await mutations(transaction, deps.now).update(authority, {
          id: input.id,
          expectedVersion: input.update.expectedVersion,
          patch: (current) => normalizeSnapshot(input.update.snapshot, current.outputContract),
          guard: (current, name) => {
            deps.assertNameUnchangedForEditor(access, current.name, name)
            return name
          },
        })
        const receipt: SaveWorkgroupReceipt = {
          clientMutationId: input.update.clientMutationId,
          requestedBaseVersion: input.update.expectedVersion,
          revision: revisionOf(saved.workgroup),
          snapshot: saved.snapshot,
          workgroup: detailOf(saved.workgroup),
          outcome: saved.outcome,
        }
        return { receipt, committed: saved.outcome === 'committed' }
      })
    },
    async delete(
      authority: WorkgroupOperationContext,
      input: ValidatedWorkgroupDeleteInput,
    ): Promise<WorkgroupDeleteResult> {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const { workgroups, workgroupMembers, scheduledTasks } = tablesOf(transaction)
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
          await deps
            .taskReferences(transaction)
            .nonTerminalTaskIds({ kind: 'workgroup', sourceId: input.id })
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
