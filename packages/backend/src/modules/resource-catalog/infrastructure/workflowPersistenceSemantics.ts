import {
  TERMINAL_TASK_STATUSES,
  RESOURCE_DISPLAY_NAME_MAX,
  WorkflowDraftSnapshotSchema,
  WorkflowNameSchema,
  migrateWorkflowDefinitionToLatest,
  normalizeResourceDisplayName,
  rehydratePrivilegedNodes,
  type CreateWorkflow,
  type DeleteWorkflow,
  type SaveWorkflowReceipt,
  type UpdateWorkflow,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { agents, resourceGrants, scheduledTasks, tasks, workflows, workgroups } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import { assertCodeHostAuthorAllowed } from '@/services/codeHostAuthorGate'
import { scheduledRowsReferencing } from '@/services/scheduledTaskRefs'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'
import { assertScriptAuthorAllowed } from '@/services/scriptAuthorGate'

import { assertNameUnchangedForEditor } from '../application/resourceAccess'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import { hasResourceAclBypass, isVisibleRow, type AclRow } from '../domain/resourceAccess'
import type { WorkflowOperationContext } from '../public/participants'
import {
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from './legacy/resourceRefs'
import { WORKFLOW_NAME_INVALID_MESSAGE } from './legacy/workflow'
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

type ReferenceType = 'agent' | 'workflow' | 'workgroup'

interface ReferenceRow extends AclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
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
 * RFC-264 —— 只有**改名**才受统一命名规则约束：存量的历史名字（slug 规则之前写入的）原样回存必须继续能存。
 * 旧 SQLite 路径一直有这道门，PG 版此前漏了——现在两个 provider 同一条门、同一段措辞。
 */
function assertChangedWorkflowName(currentName: string, submittedName: string): void {
  if (currentName === submittedName) return
  const parsed = WorkflowNameSchema.safeParse(submittedName)
  if (!parsed.success) {
    throw new ValidationError('workflow-name-invalid', WORKFLOW_NAME_INVALID_MESSAGE, {
      issues: parsed.error.issues,
    })
  }
}

function canonicalDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const migrated = migrateWorkflowDefinitionToLatest(definition)
  const missingAgentNodeIds = (migrated.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)
    .map((node) => node.id)
    .sort()
  if (missingAgentNodeIds.length > 0) {
    throw new ValidationError(
      'workflow-agent-id-required',
      'agent-single nodes require a canonical agentId',
      { nodeIds: missingAgentNodeIds },
    )
  }
  return migrated
}

function referenceGroups(definition: WorkflowDefinition): ReadonlyArray<{
  readonly type: ReferenceType
  readonly domain: 'id' | 'name'
  readonly values: readonly string[]
}> {
  return [
    { type: 'agent', domain: 'id', values: [...extractWorkflowAgentRefs(definition)] },
    { type: 'workflow', domain: 'name', values: extractWorkflowWorkflowRefs(definition) },
    { type: 'workgroup', domain: 'name', values: extractWorkflowWorkgroupRefs(definition) },
  ]
}

async function loadReferenceRows(
  transaction: ResourceCatalogTransaction,
  type: ReferenceType,
  domain: 'id' | 'name',
  values: readonly string[],
): Promise<readonly ReferenceRow[]> {
  if (values.length === 0) return []
  const selected = [...new Set(values)]
  switch (type) {
    case 'agent':
      return transaction
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(domain === 'id' ? agents.id : agents.name, selected))
    case 'workflow':
      return transaction
        .select({
          id: workflows.id,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(inArray(domain === 'id' ? workflows.id : workflows.name, selected))
    case 'workgroup':
      return transaction
        .select({
          id: workgroups.id,
          name: workgroups.name,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(inArray(domain === 'id' ? workgroups.id : workgroups.name, selected))
  }
}

async function grantedIds(
  transaction: ResourceCatalogTransaction,
  authority: WorkflowOperationContext,
  type: ReferenceType,
): Promise<ReadonlySet<string>> {
  if (hasResourceAclBypass(authority)) return new Set()
  const rows = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, authority.user.id)))
  return new Set(rows.map((row) => row.resourceId))
}

async function assertDefinitionReferences(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: WorkflowOperationContext
  readonly definition: WorkflowDefinition
  readonly previous?: WorkflowDefinition
}): Promise<void> {
  const previous = new Map(
    (input.previous === undefined ? [] : referenceGroups(input.previous)).map((group) => [
      `${group.type}:${group.domain}`,
      new Set(group.values),
    ]),
  )
  const missing: Array<{ readonly type: ReferenceType; readonly name: string }> = []
  for (const group of referenceGroups(input.definition)) {
    const grandfathered = previous.get(`${group.type}:${group.domain}`) ?? new Set<string>()
    const values = [...new Set(group.values)].filter((value) => !grandfathered.has(value))
    if (values.length === 0) continue
    const [rows, grants] = await Promise.all([
      loadReferenceRows(input.transaction, group.type, group.domain, values),
      grantedIds(input.transaction, input.authority, group.type),
    ])
    if (group.domain === 'id') {
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const value of values) {
        const row = byId.get(value)
        if (row !== undefined && !isVisibleRow(input.authority, row, grants)) {
          missing.push({ type: group.type, name: value })
        }
      }
      continue
    }
    const byName = new Map<string, ReferenceRow[]>()
    for (const row of rows) {
      const bucket = byName.get(row.name) ?? []
      bucket.push(row)
      byName.set(row.name, bucket)
    }
    for (const value of values) {
      const matches = byName.get(value)
      if (
        matches !== undefined &&
        !matches.some((row) => isVisibleRow(input.authority, row, grants))
      ) {
        missing.push({ type: group.type, name: value })
      }
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${missing.map((entry) => `${entry.type} '${entry.name}'`).join(', ')}`,
      { missing },
    )
  }
}

/**
 * RFC-359 W1-T6：与 SQLite deleteWorkflow 同规则——只拒**非终态**引用（running / pending / awaiting_* /
 * interrupted）；仅被历史（终态）任务引用的 workflow 允许删除。此前 PG 删除完全不查任务引用。
 */
async function assertNoNonTerminalTaskReferences(
  transaction: ResourceCatalogTransaction,
  workflowId: string,
): Promise<void> {
  const rows = await transaction
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(eq(tasks.workflowId, workflowId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
    )
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
  const rows = await transaction
    .select({ id: workflows.id, definition: workflows.definition })
    .from(workflows)
  const caller = rows.find((row) => {
    if (row.id === current.id) return false
    try {
      const parsed: unknown = JSON.parse(row.definition)
      if (typeof parsed !== 'object' || parsed === null) return false
      return extractWorkflowWorkflowRefs(parsed as WorkflowDefinition).includes(current.name)
    } catch {
      return false
    }
  })
  if (caller !== undefined) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${current.id}' is referenced by another workflow`,
    )
  }
}

/** Owner-native semantics for the Workflow repository（RFC-359 W4-D15：一份实现，两个 provider 共用）。 */
export function createWorkflowPersistenceSemantics(input: {
  readonly authorization: ResourceAuthorizationApplication
  readonly events?: WorkflowPersistenceEvents
}): WorkflowPersistenceSemantics {
  return Object.freeze<WorkflowPersistenceSemantics>({
    async canonicalizeCreate(authority, submitted): Promise<CreateWorkflow> {
      const definition = canonicalDefinition(submitted.definition)
      assertScriptAuthorAllowed({
        next: definition,
        principal: { kind: 'actor', actor: authority },
      })
      assertCodeHostAuthorAllowed({
        next: definition,
        principal: { kind: 'actor', actor: authority },
      })
      return Object.freeze({
        ...submitted,
        name: WorkflowNameSchema.parse(submitted.name),
        definition,
      })
    },
    async assertCreateInTransaction(transaction, authority, candidate) {
      await assertDefinitionReferences({
        transaction,
        authority,
        definition: candidate.definition,
      })
    },
    async copyNameAndAssertInTransaction(transaction, authority, source) {
      await assertDefinitionReferences({ transaction, authority, definition: source.definition })
      const occupied = await transaction
        .select({ name: workflows.name })
        .from(workflows)
        .where(eq(workflows.ownerUserId, authority.user.id))
      return copyName(
        source.name,
        occupied.map((row) => row.name),
      )
    },
    async canonicalizeUpdate(
      authority,
      current,
      submitted: UpdateWorkflow,
    ): Promise<WorkflowDraftSnapshot> {
      const name = normalizeResourceDisplayName(submitted.snapshot.name)
      const submittedDefinition = canonicalDefinition(submitted.snapshot.definition)
      const definition = rehydratePrivilegedNodes(
        submittedDefinition,
        current.definition,
        privilegedNodeLensFor(authority),
      )
      const access = await input.authorization.resolveResourceAccessFor(
        authority,
        'workflow',
        current,
      )
      assertNameUnchangedForEditor(access, current.name, name)
      assertChangedWorkflowName(current.name, name)
      assertScriptAuthorAllowed({
        next: definition,
        previous: current.definition,
        principal: { kind: 'actor', actor: authority },
      })
      assertCodeHostAuthorAllowed({
        next: definition,
        previous: current.definition,
        principal: { kind: 'actor', actor: authority },
      })
      return WorkflowDraftSnapshotSchema.parse({
        ...submitted.snapshot,
        name,
        definition,
      })
    },
    async assertUpdateInTransaction(transaction, authority, current, candidate) {
      await assertDefinitionReferences({
        transaction,
        authority,
        definition: candidate.definition,
        previous: current.definition,
      })
    },
    async assertDeleteInTransaction(transaction, authority, current) {
      await assertNoNonTerminalTaskReferences(transaction, current.id)
      await assertNoScheduledReferences(transaction, authority, current.id)
      await assertNotCalledByWorkflow(transaction, current)
    },
    created: input.events?.created,
    updated: input.events?.updated,
    deleted: input.events?.deleted,
  })
}
