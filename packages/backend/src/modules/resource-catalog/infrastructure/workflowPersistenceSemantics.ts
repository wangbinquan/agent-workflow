import type { SubjectTaskReferencePort } from '../composition/required-ports'
import { createWorkflowCallReferenceLookup } from './referenceLookup'
import { workflowCatalogPredicate } from './workflowCatalogPredicate'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  RESOURCE_DISPLAY_NAME_MAX,
  WorkflowNameSchema,
  normalizeResourceDisplayName,
  type DeleteWorkflow,
  type SaveWorkflowReceipt,
  type Workflow,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import { ConflictError } from '@/util/errors'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'

import { assertNameUnchangedForEditor } from '../application/resourceAccess'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import type { WorkflowOperationContext } from '../public/participants'
import { assertChangedWorkflowName } from './workflowPersistence'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'
import type { WorkflowDeletedAudience, WorkflowPersistenceSemantics } from './workflowRepository'

interface WorkflowPersistenceEvents {
  created(workflow: Workflow): Promise<void> | void
  updated(receipt: SaveWorkflowReceipt): Promise<void> | void
  deleted(
    id: string,
    version: number,
    input: DeleteWorkflow,
    audience: WorkflowDeletedAudience,
  ): Promise<void> | void
}

function normalizeCopyBase(value: string): string {
  const normalized = normalizeResourceDisplayName(value).replace(/^[-_]+|[-_]+$/g, '')
  return normalized.length > 0 ? normalized : 'workflow'
}

function copyName(sourceName: string, occupiedNames: Iterable<string>): string {
  const normalized = normalizeCopyBase(sourceName)
  const match = /^(.*)-copy(?:-([2-9][0-9]*))?$/.exec(normalized)
  const base = match === null ? normalized : normalizeCopyBase(match[1] ?? '')
  let sequence = match === null ? 1n : match[2] === undefined ? 2n : BigInt(match[2]) + 1n
  const occupied = new Set(occupiedNames)
  for (;;) {
    const suffix = sequence === 1n ? '-copy' : `-copy-${sequence.toString()}`
    const truncated = [...base]
      .slice(0, RESOURCE_DISPLAY_NAME_MAX - suffix.length)
      .join('')
      .replace(/[-_\s]+$/gu, '')
    const candidate = `${truncated.length > 0 ? truncated : 'workflow'}${suffix}`
    if (!occupied.has(candidate)) return WorkflowNameSchema.parse(candidate)
    sequence += 1n
  }
}

/**
 * RFC-359 W1-T6：与 SQLite deleteWorkflow 同规则——只拒**非终态**引用（running / pending / awaiting_* /
 * interrupted）；仅被历史（终态）任务引用的 workflow 允许删除。此前 PG 删除完全不查任务引用。
 */
async function assertNoNonTerminalTaskReferences(
  transaction: ResourceCatalogTransaction,
  workflowId: string,
  taskReferences: SubjectTaskReferencePort,
): Promise<void> {
  const rows = await taskReferences(transaction).nonTerminalTaskIds({
    kind: 'workflow',
    sourceId: workflowId,
  })
  if (rows.length > 0) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${workflowId}' has ${rows.length} non-terminal task(s) referencing it; finish or cancel them first`,
      { referenceCount: rows.length },
    )
  }
}

/** RFC-202 T5 / RFC-359 W1-T6：定时任务仍以该 workflow 为启动目标时拒删（与 SQLite 同形，同样只对
 * 主体可见的 schedule 披露名字，其余只给计数）。 */
async function assertNoScheduledReferences(
  transaction: ResourceCatalogTransaction,
  authority: WorkflowOperationContext,
  workflowId: string,
): Promise<void> {
  const { scheduledTasks } = tablesOf(transaction)
  const schedRows = await transaction
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      launchKind: scheduledTasks.launchKind,
      launchPayload: scheduledTasks.launchPayload,
      ownerUserId: scheduledTasks.ownerUserId,
    })
    .from(scheduledTasks)
  const referencing = scheduledRowsReferencing(schedRows, {
    launchKind: 'workflow',
    payloadKey: 'workflowId',
    id: workflowId,
  })
  if (referencing.length === 0) return
  const canSeeAll = authority.permissions.has('tasks:read:all' as never)
  const visible = referencing.filter((r) => canSeeAll || r.ownerUserId === authority.user.id)
  throw new ConflictError(
    'workflow-scheduled-referenced',
    `workflow '${workflowId}' is the launch target of ${referencing.length} scheduled task(s); delete or repoint them first`,
    {
      scheduledCount: referencing.length,
      visibleScheduled: visible.map((r) => ({ id: r.id, name: r.name })),
      hiddenCount: referencing.length - visible.length,
    },
  )
}

async function assertNotCalledByWorkflow(
  transaction: ResourceCatalogTransaction,
  current: Pick<Workflow, 'id' | 'name'>,
): Promise<void> {
  const caller = (await createWorkflowCallReferenceLookup(transaction).find(current))[0]
  if (caller !== undefined) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${current.id}' is referenced by another workflow`,
    )
  }
}

/**
 * 普通编辑这一入口的规则（RFC-359 W4-D15：一份实现，两个 provider 共用）。定义、作者门、引用可见性与版本由唯一的
 * workflow 写入参与者负责（RFC-401 A3）；这里只剩改名权限、复制命名、删除前的引用检查与事件。
 */
export function createWorkflowPersistenceSemantics(input: {
  readonly authorization: ResourceAuthorizationApplication
  readonly taskReferences: SubjectTaskReferencePort
  readonly events?: WorkflowPersistenceEvents
}): WorkflowPersistenceSemantics {
  return Object.freeze<WorkflowPersistenceSemantics>({
    async renameRule(authority, before) {
      const access = await input.authorization.resolveResourceAccessFor(
        authority,
        'workflow',
        before,
      )
      return (current, submittedName) => {
        const name = normalizeResourceDisplayName(submittedName)
        assertNameUnchangedForEditor(access, current.name, name)
        assertChangedWorkflowName(current.name, name)
        return name
      }
    },
    async copyNameInTransaction(transaction, authority, source) {
      const { workflows } = tablesOf(transaction)
      const occupied = await transaction
        .select({ name: workflows.name })
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, eq(workflows.ownerUserId, authority.user.id)))
      return copyName(
        source.name,
        occupied.map((row) => row.name),
      )
    },
    async assertDeleteInTransaction(transaction, authority, current) {
      await assertNoNonTerminalTaskReferences(transaction, current.id, input.taskReferences)
      await assertNoScheduledReferences(transaction, authority, current.id)
      await assertNotCalledByWorkflow(transaction, current)
    },
    created: input.events?.created,
    updated: input.events?.updated,
    deleted: input.events?.deleted,
  })
}
