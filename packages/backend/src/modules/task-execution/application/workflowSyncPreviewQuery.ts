// RFC-478 —— 工作流同步预览（RFC-109）的查询用例，原在 `services/task.ts`。路由操作调用它（design §3 常驻规则 10：用例入口
// 在 application）；四个读经 task-execution 自有端口 `WorkflowSyncPreviewReads`，实现在 infrastructure。函数体除这四处读取外逐字不变。
import {
  collectExecutionRefs,
  diffWorkflowForSync,
  isTaskWorkspaceUnbound,
  parseTriggerContextJson,
  type Task,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowSyncPreview,
} from '@agent-workflow/shared'
import { triggerPreflightIssue } from '@/modules/resource-catalog/public/queries'
import { DomainError, ValidationError } from '@/util/errors'
import {
  buildSyncRunSummary,
  builtinWorkflowSyncPreview,
  parseSnapshotDefinition,
  workflowSyncGateReason,
} from '../domain/workflowSyncPreview'
import type { NodeRunFactSnapshot } from './ports/nodeRunQueries'
import type { TaskExecutionResourceAuthority } from './ports/taskExecutionResourceSnapshots'
import type { WorkflowSyncPreviewReads } from './ports/workflowSyncPreviewReads'

// RFC-345 T4a / RFC-349 T4a — provider-neutral atomic reference-closure freeze (RFC-469: moved into
// `services/task.ts` from `services/execution/taskExecutionCallClosure.ts`; RFC-478: here with its only caller).
async function freezeTaskExecutionCallClosure(
  root: Readonly<{ readonly id: string; readonly definition: WorkflowDefinition }>,
  resourceAuthority: TaskExecutionResourceAuthority,
): Promise<string | null> {
  return await resourceAuthority.resources.freezeCallClosure(resourceAuthority, root)
}

/**
 * RFC-243 / RFC-345 T4a — closure freezing needs the exact Resource Catalog
 * authority captured for this launch. Call-node-free definitions skip the
 * participant (byte-compat); a call-bearing launch without that binding fails
 * closed instead of returning to the legacy live-row resolver.
 */
async function freezeClosureForLaunch(
  deps: { readonly launchResources?: TaskExecutionResourceAuthority },
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<string | null> {
  const refs = collectExecutionRefs(definition)
  if (refs.workflowNames.size === 0 && refs.workgroupNames.size === 0) return null
  if (deps.launchResources === undefined) {
    throw new ValidationError(
      'workflow-call-ref-missing',
      'call-node launches require an authenticated resource authority for closure resolution',
    )
  }
  return await freezeTaskExecutionCallClosure({ id: workflowId, definition }, deps.launchResources)
}

/**
 * RFC-109 — assemble the `workflow-sync-preview` for a task whose workflow is
 * resolved + visible (the route handles deleted / not-visible before calling).
 * Computes the version delta, the full node diff (with the data-loss warnings
 * that need the preserved runs' actual produced ports), and whether the live
 * definition currently fails static validation.
 */
/**
 * RFC-470: the static validation the preview runs, injected by the route (the production value is the
 * agent-launch resource seam's `validateHostWorkflow` — resource-catalog's `validateWorkflowDef` over
 * `loadWorkflowValidationContext(db, candidate)`). Written structurally here so the query does not take
 * another module's internal port.
 */
export type WorkflowSyncPreviewValidation = (
  definition: WorkflowDefinition,
  candidate: Readonly<{
    definition: WorkflowDefinition
    currentWorkflow: Readonly<{ id: string; name: string }>
    frozenClosureJson: string | null
  }>,
) => Promise<{
  readonly ok: boolean
  readonly issues: readonly {
    readonly code: string
    readonly message: string
    readonly severity?: string
  }[]
}>

export async function computeWorkflowSyncPreview(
  reads: WorkflowSyncPreviewReads,
  task: Task,
  workflow: Workflow,
  resourceAuthority: TaskExecutionResourceAuthority,
  validateHostWorkflow: WorkflowSyncPreviewValidation,
): Promise<WorkflowSyncPreview> {
  // RFC-104 built-in workflows are never manually executed (POST sync-workflow
  // would 403) — so the banner must not appear for them (Codex impl-gate F4).
  // RFC-359: the projection lives in the shared domain so PostgreSQL answers identically.
  if (workflow.builtin) return builtinWorkflowSyncPreview(task, workflow.version)
  const oldDef = parseSnapshotDefinition(task.workflowSnapshot)
  const newDef = workflow.definition
  let candidateClosureJson: string | null = null
  const closureIssues: Array<{ code: string; message: string }> = []
  try {
    candidateClosureJson = await freezeClosureForLaunch(
      { launchResources: resourceAuthority },
      workflow.id,
      newDef,
    )
  } catch (error) {
    closureIssues.push({
      code: error instanceof DomainError ? error.code : 'workflow-call-ref-missing',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const runs = await reads.listNodeRuns(task.id)

  // The freshest done top-level run per node + the output ports it produced —
  // the basis for the `dangling-input-port` warning (Codex F2).
  const freshestDoneRunIdByNode = new Map<string, string>()
  const runsByNode = new Map<string, NodeRunFactSnapshot[]>()
  for (const r of runs) {
    const list = runsByNode.get(r.nodeId)
    if (list === undefined) runsByNode.set(r.nodeId, [r])
    else list.push(r)
  }
  for (const nodeId of runsByNode.keys()) {
    const fresh = await reads.freshestDoneTopLevelRunId(task.id, nodeId)
    if (fresh !== null) freshestDoneRunIdByNode.set(nodeId, fresh)
  }
  const runIds = [...freshestDoneRunIdByNode.values()]
  const outRows = await reads.producedPorts(runIds)
  const portsByRun = new Map<string, Set<string>>()
  for (const o of outRows) {
    const set = portsByRun.get(o.nodeRunId)
    if (set === undefined) portsByRun.set(o.nodeRunId, new Set([o.portName]))
    else set.add(o.portName)
  }
  const producedPortsByNode = new Map<string, ReadonlySet<string>>()
  for (const [nodeId, runId] of freshestDoneRunIdByNode) {
    producedPortsByNode.set(nodeId, portsByRun.get(runId) ?? new Set<string>())
  }

  const diff = diffWorkflowForSync(oldDef, newDef, buildSyncRunSummary(runs, producedPortsByNode))
  const validation = await validateHostWorkflow(newDef, {
    definition: newDef,
    currentWorkflow: { id: workflow.id, name: workflow.name },
    frozenClosureJson: candidateClosureJson,
  })
  const validationIssues = validation.ok
    ? []
    : validation.issues
        .filter((i) => (i.severity ?? 'error') === 'error')
        .map((i) => ({ code: i.code, message: i.message }))
  const triggerContextJson = await reads.frozenTriggerContext(task.id)
  const triggerIssue = triggerPreflightIssue({
    root: newDef,
    closureJson: candidateClosureJson,
    source: parseTriggerContextJson(triggerContextJson),
  })
  const triggerIssues =
    triggerIssue === null
      ? []
      : [
          {
            code: triggerIssue.code,
            message:
              triggerIssue.code === 'trigger-context-invalid'
                ? 'the frozen task trigger context is invalid'
                : triggerIssue.code === 'trigger-context-missing'
                  ? `workflow requires webhook trigger context at ${triggerIssue.dependency.pointer}`
                  : `workflow trigger field '${triggerIssue.dependency.field}' is unavailable at ${triggerIssue.dependency.pointer}`,
          },
        ]
  const invalidIssues = [...closureIssues, ...validationIssues, ...triggerIssues]

  // RFC-359: 判据落在共用 domain 里，PostgreSQL 的预览用同一条。
  const reason = workflowSyncGateReason({
    status: task.status,
    worktreeMissing: isTaskWorkspaceUnbound(task.worktreePath),
  })
  const syncable = reason === 'ok'

  return {
    syncable,
    reason,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    currentVersion: task.workflowVersion,
    latestVersion: workflow.version,
    differs: diff.differs,
    invalid: invalidIssues.length > 0,
    invalidIssues,
    diff,
  }
}
