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
import {
  resolveAgentIdsExecutionPolicy,
  type ResolvedAgentExecutionPolicy,
} from '@/services/executionPolicy'
import { NotFoundError, ValidationError } from '@/util/errors'
import { loadWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'

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
  defaultRuntime?: string | null,
): Promise<LaunchableWorkflow> {
  const wf = await getWorkflow(db, workflowId)
  if (wf === null || !(await canViewResource(db, actor, 'workflow', wf))) {
    throw new NotFoundError('workflow-not-found', `workflow '${workflowId}' not found`)
  }
  assertNotBuiltin('workflow', wf)
  await assertWorkflowExecutionPolicy(db, wf.definition, defaultRuntime)
  // RFC-242 实现门 P1-2: launch is the ENFORCEMENT point of the call-node
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
      `workflow '${workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      { issues: validation.issues },
    )
  }
  return wf
}

/**
 * Effective-runtime gate shared by route preflight, scheduled save/fire and
 * startTask's final service funnel. The persisted workflow schema is flat:
 * wrapper membership points at node ids, so every agent-single node is found
 * by this single pass, including wrapper inner nodes.
 */
export async function assertWorkflowExecutionPolicy(
  db: DbClient,
  definition: LaunchableWorkflow['definition'],
  defaultRuntime?: string | null,
): Promise<ResolvedAgentExecutionPolicy[]> {
  const agentIds = (definition.nodes ?? []).flatMap((node) =>
    node.kind === 'agent-single' && typeof node.agentId === 'string' && node.agentId.length > 0
      ? [node.agentId]
      : [],
  )
  return resolveAgentIdsExecutionPolicy(db, agentIds, defaultRuntime)
}
