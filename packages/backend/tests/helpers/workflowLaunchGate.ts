// RFC-466 (RFC-294 W9-D) — moved verbatim from `services/taskLaunchGate.ts`.
//
// RFC-159's shared workflow-launch gate: the RFC-099 (D3) view check + RFC-104 `assertNotBuiltin` + the launch-time static
// validation, composed from the production primitives. No production path calls this composition any more — the launch
// routes go through the task-execution launch participant and the scheduled-task scheduler validates an already
// authorized Resource Catalog snapshot (`assertWorkflowSnapshotLaunchable`, still in `services/taskLaunchGate.ts`) — so
// it lives with the tests that pin the gate.
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { canViewResource } from '@/modules/resource-catalog/composition/resourceAcl'
import { assertNotBuiltin } from '@/modules/resource-catalog/public/types'
import { getWorkflow } from '@/services/workflow'
import { NotFoundError } from '@/util/errors'
import { assertWorkflowSnapshotLaunchable } from '@/services/taskLaunchGate'

type LaunchableWorkflow = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>

/**
 * Assert `actor` may launch `workflowId`; returns the workflow row on success.
 * Invisible and missing both raise the identical 404 (RFC-099 D1). Built-in →
 * 403 via `assertNotBuiltin` (the row IS visible).
 */
export async function assertWorkflowLaunchable(
  db: PersistenceDb,
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
