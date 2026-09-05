import {
  WorkflowDraftSnapshotSchema,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  type CopyWorkflowRequest,
  type CreateWorkflow,
  type DeleteWorkflow,
  type SaveWorkflowReceipt,
  type UpdateWorkflow,
  type Workflow,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { resourceGrants, workflows } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { NotFoundError, staleConflictError } from '@/util/errors'
import type { WorkflowAclIdentity, WorkflowRepository } from '../application/workflows/ports'
import type { WorkflowOperationContext } from '../public/participants'
import {
  createWorkflowPersistenceValues,
  workflowDetailOf,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow,
  workflowRevisionOf,
} from './workflowPersistence'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

/** Owner-native semantics injected into the Workflow repository（一份合同，两个 provider 共用）。 */
export interface WorkflowPersistenceSemantics {
  canonicalizeCreate(
    authority: WorkflowOperationContext,
    input: CreateWorkflow,
    id: string,
  ): Promise<CreateWorkflow>
  assertCreateInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    candidate: CreateWorkflow,
  ): Promise<void>
  copyNameAndAssertInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    source: Workflow,
  ): Promise<string>
  canonicalizeUpdate(
    authority: WorkflowOperationContext,
    current: Workflow,
    input: UpdateWorkflow,
  ): Promise<WorkflowDraftSnapshot>
  assertUpdateInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    current: Workflow,
    candidate: WorkflowDraftSnapshot,
  ): Promise<void>
  /** 只拿 ACL 身份：删除必须对定义损坏的行仍可用。 */
  assertDeleteInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    current: WorkflowAclIdentity,
  ): Promise<void>
  created?(workflow: Workflow): Promise<void> | void
  updated?(receipt: SaveWorkflowReceipt): Promise<void> | void
  /**
   * 删除后的广播不能再读行：受众（可见性 / owner / 授权用户）在删除事务里一并取出，随事件带出去——
   * 冷缓存的私有工作流观众才能收到 delete 帧（旧 SQLite 路径一直如此，PG 版此前漏了这一段）。
   */
  deleted?(
    id: string,
    version: number,
    input: DeleteWorkflow,
    audience: WorkflowDeletedAudience,
  ): Promise<void> | void
}

export interface WorkflowDeletedAudience {
  readonly visibility: 'public' | 'private'
  readonly ownerUserId: string | null
  readonly grantedUserIds: ReadonlySet<string>
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
}

function stale(id: string, current: Workflow) {
  return staleConflictError('workflow', `workflow '${id}' changed; reload`, {
    current: workflowRevisionOf(current),
  })
}

/** 版本冲突：正常行带 revision 详情；定义损坏的行只报冲突，不让 stale 分支自己 422。 */
function staleRow(id: string, row: typeof workflows.$inferSelect) {
  try {
    return stale(id, workflowFromPersistenceRow(row))
  } catch {
    return staleConflictError('workflow', `workflow '${id}' changed; reload`)
  }
}

function aclIdentity(row: typeof workflows.$inferSelect): WorkflowAclIdentity {
  return Object.freeze({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    visibility: row.visibility ?? 'public',
    builtin: row.builtin === true,
  })
}

/**
 * RFC-359 W4-D15 —— Workflow 仓库：一份实现，两个 provider 共用。写路径全在统一的 serializable 事务里；
 * 删除只用原始行的 ACL 身份与版本（定义损坏的行必须能删，RFC-359 W1-T6）。
 */
export function createWorkflowRepository(input: {
  readonly db: ProviderNeutralDatabase
  readonly semantics: WorkflowPersistenceSemantics
  readonly id?: () => string
  readonly now?: () => number
}): WorkflowRepository {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now

  async function get(id: string) {
    const row = (await input.db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0]
    return row === undefined ? null : workflowDetailOf(workflowFromPersistenceRow(row))
  }

  const repository: WorkflowRepository = {
    async list() {
      return (await input.db.select().from(workflows)).map(workflowFromPersistenceRow)
    },
    get,
    async getAclIdentity(id) {
      const row = (await input.db.select().from(workflows).where(eq(workflows.id, id)).limit(1))[0]
      return row === undefined ? null : aclIdentity(row)
    },
    async create(authority, submitted) {
      const id = mintId()
      const canonical = await input.semantics.canonicalizeCreate(authority, submitted, id)
      const values = createWorkflowPersistenceValues({
        id,
        workflow: canonical,
        ownerUserId: authority.user.id,
        now: now(),
      })
      const created = await runResourceCatalogTransaction(input.db, async (transaction) => {
        await input.semantics.assertCreateInTransaction(transaction, authority, canonical)
        const row = (await transaction.insert(workflows).values(values).returning())[0]
        if (row === undefined) throw new Error('workflow insert returned no row')
        return workflowFromPersistenceRow(row)
      })
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async copy(authority, id, copy: CopyWorkflowRequest) {
      const created = await runResourceCatalogTransaction(input.db, async (transaction) => {
        const sourceRow = (
          await transaction.select().from(workflows).where(eq(workflows.id, id)).limit(1)
        )[0]
        if (sourceRow === undefined) throw notFound(id)
        const source = workflowFromPersistenceRow(sourceRow)
        const revision = workflowRevisionOf(source)
        if (
          revision.version !== copy.expectedVersion ||
          revision.snapshotHash !== copy.expectedSnapshotHash
        ) {
          throw stale(id, source)
        }
        const name = await input.semantics.copyNameAndAssertInTransaction(
          transaction,
          authority,
          source,
        )
        const values = createWorkflowPersistenceValues({
          id: mintId(),
          workflow: {
            name,
            description: source.description,
            definition: source.definition,
          },
          ownerUserId: authority.user.id,
          now: now(),
        })
        const row = (await transaction.insert(workflows).values(values).returning())[0]
        if (row === undefined) throw new Error('workflow copy insert returned no row')
        return workflowFromPersistenceRow(row)
      })
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async update(authority, id, submitted) {
      const before = await get(id)
      if (before === null) throw notFound(id)
      const candidate = WorkflowDraftSnapshotSchema.parse(
        await input.semantics.canonicalizeUpdate(authority, before, submitted),
      )
      const candidateBytes = serializeWorkflowEditableSnapshotV1(candidate)
      const definition = serializeWorkflowDefinitionStorageV1(candidate.definition)
      const result = await runResourceCatalogTransaction(
        input.db,
        async (transaction): Promise<{ receipt: SaveWorkflowReceipt; committed: boolean }> => {
          const row = (
            await transaction.select().from(workflows).where(eq(workflows.id, id)).limit(1)
          )[0]
          if (row === undefined) throw notFound(id)
          const current = workflowFromPersistenceRow(row)
          await input.semantics.assertUpdateInTransaction(
            transaction,
            authority,
            current,
            candidate,
          )
          const currentSnapshot = workflowDraftSnapshotOf(current)
          const logicalSame =
            serializeWorkflowEditableSnapshotV1(currentSnapshot) === candidateBytes
          const currentRevision = workflowRevisionOf(current)
          if (current.version !== submitted.expectedVersion) {
            if (!logicalSame) throw stale(id, current)
            return {
              receipt: {
                clientMutationId: submitted.clientMutationId,
                requestedBaseVersion: submitted.expectedVersion,
                revision: currentRevision,
                snapshot: candidate,
                outcome: 'already-current',
              },
              committed: false,
            }
          }
          if (logicalSame && row.definition === definition) {
            return {
              receipt: {
                clientMutationId: submitted.clientMutationId,
                requestedBaseVersion: submitted.expectedVersion,
                revision: currentRevision,
                snapshot: candidate,
                outcome: 'already-current',
              },
              committed: false,
            }
          }
          const changed = await transaction
            .update(workflows)
            .set({
              name: candidate.name,
              description: candidate.description,
              definition,
              version: current.version + 1,
              updatedAt: now(),
            })
            .where(and(eq(workflows.id, id), eq(workflows.version, submitted.expectedVersion)))
            .returning()
          if (changed[0] === undefined) throw stale(id, current)
          const committed = workflowFromPersistenceRow(changed[0])
          return {
            receipt: {
              clientMutationId: submitted.clientMutationId,
              requestedBaseVersion: submitted.expectedVersion,
              revision: workflowRevisionOf(committed),
              snapshot: candidate,
              outcome: 'committed',
            },
            committed: true,
          }
        },
      )
      if (result.committed) await input.semantics.updated?.(result.receipt)
      return result.receipt
    },
    async delete(authority, id, deletion) {
      const deletedVersion = await runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (
          await transaction.select().from(workflows).where(eq(workflows.id, id)).limit(1)
        )[0]
        if (row === undefined) throw notFound(id)
        // RFC-359 W1-T6（P0-6）：删除路径不解析 definition——定义损坏的工作流必须能删（与 SQLite
        // deleteWorkflow 同规则：只用原始行的 ACL 身份与版本）。此前第二条语句就是
        // workflowFromPersistenceRow(row)，坏行在 PG 上 422、永远删不掉。
        if (row.version !== deletion.expectedVersion) throw staleRow(id, row)
        await input.semantics.assertDeleteInTransaction(transaction, authority, aclIdentity(row))
        const granted = await transaction
          .select({ userId: resourceGrants.userId })
          .from(resourceGrants)
          .where(
            and(eq(resourceGrants.resourceType, 'workflow'), eq(resourceGrants.resourceId, id)),
          )
        const removed = await transaction
          .delete(workflows)
          .where(and(eq(workflows.id, id), eq(workflows.version, deletion.expectedVersion)))
          .returning({ version: workflows.version })
        if (removed[0] === undefined) throw staleRow(id, row)
        const audience: WorkflowDeletedAudience = {
          visibility: row.visibility ?? 'public',
          ownerUserId: row.ownerUserId ?? null,
          grantedUserIds: new Set(granted.map((grant) => grant.userId)),
        }
        return { deletedVersion: removed[0].version, audience }
      })
      await input.semantics.deleted?.(
        id,
        deletedVersion.deletedVersion,
        deletion,
        deletedVersion.audience,
      )
    },
  }
  return Object.freeze(repository)
}
