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
import { assertAgentIdsExecutionPolicy } from '@/services/executionPolicy'
import { NotFoundError } from '@/util/errors'

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
): Promise<void> {
  const agentIds = (definition.nodes ?? []).flatMap((node) =>
    node.kind === 'agent-single' && typeof node.agentId === 'string' && node.agentId.length > 0
      ? [node.agentId]
      : [],
  )
  await assertAgentIdsExecutionPolicy(db, agentIds, defaultRuntime)
}
