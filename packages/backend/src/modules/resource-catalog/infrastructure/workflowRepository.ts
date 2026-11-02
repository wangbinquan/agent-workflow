import { createWorkflowMutationParticipant } from './workflowMutationParticipant'
import { workflowCatalogPredicate } from './workflowCatalogPredicate'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type {
  CopyWorkflowRequest,
  DeleteWorkflow,
  SaveWorkflowReceipt,
  Workflow,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { NotFoundError, staleConflictError } from '@/util/errors'
import type { WorkflowAclIdentity, WorkflowRepository } from '../application/workflows/ports'
import type { WorkflowOperationContext } from '../public/participants'
import {
  workflowDetailOf,
  workflowFromPersistenceRow,
  workflowRevisionOf,
} from './workflowPersistence'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

/** 普通编辑的改名规则：对事务内的当前行检查提交的名称，返回规范化后的名称。 */
export type WorkflowRenameRule = (current: Workflow, submittedName: string) => string

/**
 * 普通编辑这一入口自己的规则（RFC-401 A3：定义、作者门、引用与版本由唯一的 workflow 写入参与者负责）。
 * 一份合同，两个 provider 共用。
 */
export interface WorkflowPersistenceSemantics {
  /** 编辑者（非 owner）不能改名、改动后的名称须合法。访问级别在事务外按保存前的行解析。 */
  renameRule(authority: WorkflowOperationContext, before: Workflow): Promise<WorkflowRenameRule>
  /** 复制命名：在事务内读本人已占用的名称，分配 `-copy` / `-copy-N`。 */
  copyNameInTransaction(
    transaction: ResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    source: Workflow,
  ): Promise<string>
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
function staleRow(id: string, row: PersistenceTables['workflows']['$inferSelect']) {
  try {
    return stale(id, workflowFromPersistenceRow(row))
  } catch {
    return staleConflictError('workflow', `workflow '${id}' changed; reload`)
  }
}

function aclIdentity(row: PersistenceTables['workflows']['$inferSelect']): WorkflowAclIdentity {
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
  readonly db: PersistenceDb
  readonly semantics: WorkflowPersistenceSemantics
  readonly id?: () => string
  readonly now?: () => number
}): WorkflowRepository {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now

  async function get(id: string) {
    const { workflows } = tablesOf(input.db)
    const row = (
      await input.db
        .select()
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
        .limit(1)
    )[0]
    return row === undefined ? null : workflowDetailOf(workflowFromPersistenceRow(row))
  }

  const repository: WorkflowRepository = {
    async list() {
      const { workflows } = tablesOf(input.db)
      return (
        await input.db.select().from(workflows).where(workflowCatalogPredicate(workflows.id))
      ).map(workflowFromPersistenceRow)
    },
    get,
    async getAclIdentity(id) {
      const { workflows } = tablesOf(input.db)
      const row = (
        await input.db
          .select()
          .from(workflows)
          .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
          .limit(1)
      )[0]
      return row === undefined ? null : aclIdentity(row)
    },
    async create(authority, submitted) {
      const id = mintId()
      const created = await runResourceCatalogTransaction(input.db, (transaction) =>
        createWorkflowMutationParticipant(transaction, { now }).create(
          { kind: 'actor', actor: authority },
          {
            id,
            content: {
              name: submitted.name,
              description: submitted.description,
              definition: submitted.definition,
            },
          },
        ),
      )
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async copy(authority, id, copy: CopyWorkflowRequest) {
      const created = await runResourceCatalogTransaction(input.db, async (transaction) => {
        const { workflows } = tablesOf(transaction)
        const sourceRow = (
          await transaction
            .select()
            .from(workflows)
            .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
            .limit(1)
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
        const name = await input.semantics.copyNameInTransaction(transaction, authority, source)
        return createWorkflowMutationParticipant(transaction, { now }).create(
          { kind: 'actor', actor: authority },
          {
            id: mintId(),
            content: { name, description: source.description, definition: source.definition },
            provenance: 'verbatim-copy',
          },
        )
      })
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async update(authority, id, submitted) {
      const before = await get(id)
      if (before === null) throw notFound(id)
      const renameRule = await input.semantics.renameRule(authority, before)
      const result = await runResourceCatalogTransaction(
        input.db,
        async (transaction): Promise<{ receipt: SaveWorkflowReceipt; committed: boolean }> => {
          const saved = await createWorkflowMutationParticipant(transaction, { now }).update(
            { kind: 'actor', actor: authority },
            {
              id,
              expectedVersion: submitted.expectedVersion,
              patch: () => ({
                name: submitted.snapshot.name,
                description: submitted.snapshot.description,
                definition: submitted.snapshot.definition,
              }),
              guard: renameRule,
            },
          )
          return {
            receipt: {
              clientMutationId: submitted.clientMutationId,
              requestedBaseVersion: submitted.expectedVersion,
              revision: workflowRevisionOf(saved.workflow),
              snapshot: saved.snapshot,
              outcome: saved.outcome,
            },
            committed: saved.outcome === 'committed',
          }
        },
      )
      if (result.committed) await input.semantics.updated?.(result.receipt)
      return result.receipt
    },
    async delete(authority, id, deletion) {
      const deletedVersion = await runResourceCatalogTransaction(input.db, async (transaction) => {
        const { workflows, resourceGrants } = tablesOf(transaction)
        const row = (
          await transaction
            .select()
            .from(workflows)
            .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id)))
            .limit(1)
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
