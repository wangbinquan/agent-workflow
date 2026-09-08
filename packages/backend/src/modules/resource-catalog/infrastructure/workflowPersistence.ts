import {
  RESOURCE_DISPLAY_NAME_MSG,
  WorkflowDefinitionSchema,
  WorkflowDraftSnapshotSchema,
  WorkflowNameSchema,
  migrateWorkflowDefinitionToLatest,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  type CreateWorkflow,
  type Workflow,
  type WorkflowDetail,
  type WorkflowDefinition,
  type WorkflowDraftSnapshot,
  type WorkflowRevision,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

export interface WorkflowPersistenceRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly definition: string
  readonly version: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
  readonly builtin: boolean
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Advisory reference loading skips unreadable rows; ordinary detail reads still report 422. */
export function workflowReferenceFromPersistenceRow(
  row: Pick<WorkflowPersistenceRow, 'id' | 'name' | 'definition'>,
): Pick<Workflow, 'id' | 'name' | 'definition'> | null {
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition))
    if (!parsed.success) return null
    return {
      id: row.id,
      name: row.name,
      definition: migrateWorkflowDefinitionToLatest(parsed.data),
    }
  } catch {
    return null
  }
}

/** The editor and YAML resolver stamp canonical ids before the write boundary. */
export function assertCanonicalWorkflowAgentIds(definition: WorkflowDefinition): void {
  const nodeIds = (definition.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)
    .map((node) => node.id)
    .sort()
  if (nodeIds.length === 0) return
  throw new ValidationError(
    'workflow-agent-id-required',
    'agent-single nodes require a canonical agentId',
    { nodeIds },
  )
}

/** Shared wording for the changed-name check and YAML import. */
export const WORKFLOW_NAME_INVALID_MESSAGE = `workflow ${RESOURCE_DISPLAY_NAME_MSG}`

/** Historical names may be saved unchanged; only a changed name is parsed. */
export function assertChangedWorkflowName(currentName: string, submittedName: string): void {
  if (currentName === submittedName) return
  const parsed = WorkflowNameSchema.safeParse(submittedName)
  if (!parsed.success) {
    throw new ValidationError('workflow-name-invalid', WORKFLOW_NAME_INVALID_MESSAGE, {
      issues: parsed.error.issues,
    })
  }
}

export function workflowFromPersistenceRow(row: WorkflowPersistenceRow): Workflow {
  let definition: Workflow['definition']
  try {
    const decoded: unknown = JSON.parse(row.definition)
    const parsed = WorkflowDefinitionSchema.safeParse(decoded)
    if (!parsed.success) {
      throw new ValidationError('workflow-definition-corrupt', 'stored definition is invalid', {
        workflowId: row.id,
        issues: parsed.error.issues,
      })
    }
    definition = migrateWorkflowDefinitionToLatest(parsed.data)
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('workflow-definition-corrupt', 'stored definition is not JSON', {
      workflowId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition,
    version: row.version,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Normalize the editable projection without rewriting a stored display name. */
export function normalizeWorkflowSnapshot(snapshot: WorkflowDraftSnapshot): WorkflowDraftSnapshot {
  return WorkflowDraftSnapshotSchema.parse({
    name: snapshot.name,
    description: snapshot.description,
    definition: migrateWorkflowDefinitionToLatest(snapshot.definition),
  })
}

export function workflowDraftSnapshotOf(workflow: Workflow): WorkflowDraftSnapshot {
  return normalizeWorkflowSnapshot({
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
  })
}

export function workflowSnapshotHashOf(snapshot: WorkflowDraftSnapshot): string {
  return sha256Hex(serializeWorkflowEditableSnapshotV1(WorkflowDraftSnapshotSchema.parse(snapshot)))
}

export function workflowRevisionOf(workflow: Workflow): WorkflowRevision {
  const snapshot = workflowDraftSnapshotOf(workflow)
  return {
    workflowId: workflow.id,
    version: workflow.version,
    snapshotHash: workflowSnapshotHashOf(snapshot),
    updatedAt: workflow.updatedAt,
  }
}

export function workflowDetailOf(workflow: Workflow): WorkflowDetail {
  const snapshot = workflowDraftSnapshotOf(workflow)
  return {
    ...workflow,
    definition: snapshot.definition,
    snapshotHash: workflowSnapshotHashOf(snapshot),
  }
}

export function createWorkflowPersistenceValues(input: {
  readonly id: string
  readonly workflow: CreateWorkflow
  readonly ownerUserId: string
  readonly now: number
}): Omit<WorkflowPersistenceRow, 'aclRevision' | 'schemaVersion'> & {
  readonly aclRevision: 0
  readonly schemaVersion: 1
} {
  return {
    id: input.id,
    name: input.workflow.name,
    description: input.workflow.description,
    definition: serializeWorkflowDefinitionStorageV1(
      migrateWorkflowDefinitionToLatest(input.workflow.definition),
    ),
    version: 1,
    ownerUserId: input.ownerUserId,
    visibility: 'private',
    aclRevision: 0,
    builtin: false,
    schemaVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }
}
