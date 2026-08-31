// RFC-159 — shared workflow-launch gate.
//
// Byte-equivalent to the JSON (routes/tasks.ts:236-246) and multipart (:790-795)
// launch gates it replaces, and reused by the scheduled-task scheduler so all three
// enforce the SAME RFC-099 (D3) `canViewResource` + RFC-104 `assertNotBuiltin` policy
// from one source (design.md finding 10). Returns the workflow — the multipart path
// needs it for upload-input extraction.
//
// Deliberately NOT folded into `startTask`: service-layer callers (fusion) launch
// built-in / not-route-visible workflows and must bypass the route guard.
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { canViewResource } from '@/services/resourceAcl'
import { assertNotBuiltin } from '@/services/systemResources'
import { getWorkflow } from '@/services/workflow'
import { NotFoundError, ValidationError } from '@/util/errors'
import { loadWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import type { TaskExecutionWorkflowSnapshot } from '@/modules/resource-catalog/public/types'

type LaunchableWorkflow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>

/**
 * Assert `actor` may launch `workflowId`; returns the workflow row on success.
 * Invisible and missing both raise the identical 404 (RFC-099 D1). Built-in →
 * 403 via `assertNotBuiltin` (the row IS visible).
 */
export async function assertWorkflowLaunchable(
  db: DbClient,
  actor: Actor,
  workflowId: string,
): Promise<LaunchableWorkflow> {
  const wf = await getWorkflow(db, workflowId)
  if (wf === null || !(await canViewResource(db, actor, 'workflow', wf))) {
    throw new NotFoundError('workflow-not-found', `workflow '${workflowId}' not found`)
  }
  assertNotBuiltin('workflow', wf)
  await assertWorkflowSnapshotLaunchable(db, wf)
  return wf
}

/**
 * Validate an already authorized Resource Catalog snapshot without re-reading
 * the target row. Integration triggers use this after the participant has
 * enforced visibility + built-in policy inside its transaction.
 */
export async function assertWorkflowSnapshotLaunchable(
  db: DbClient,
  wf: TaskExecutionWorkflowSnapshot,
): Promise<void> {
  // RFC-243 实现门 P1-2: launch is the ENFORCEMENT point of the call-node
  // rules — thread the candidate so 4f/4g (upload inputs / output collisions /
  // unwired inputs / cycles) actually gate here, not only in unit tests.
  const validation = validateWorkflowDef(
    wf.definition,
    await loadWorkflowValidationContext(db, {
      definition: wf.definition,
      currentWorkflow: { id: wf.id, name: wf.name },
    }),
  )
  if (!validation.ok) {
    const errors = validation.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
    throw new ValidationError(
      'workflow-invalid',
      `workflow '${wf.id}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      { issues: validation.issues },
    )
  }
}
