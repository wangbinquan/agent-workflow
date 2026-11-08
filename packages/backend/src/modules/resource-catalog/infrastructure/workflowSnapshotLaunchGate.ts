// RFC-159 — shared workflow-launch gate.
//
// RFC-466 (RFC-294 W9-D): only the snapshot validation stays here. The full gate (`assertWorkflowLaunchable`: RFC-099 D3
// view check + RFC-104 `assertNotBuiltin` + this validation) had no production caller left — the launch routes go
// through the task-execution launch participant and the scheduled-task scheduler validates an already authorized
// snapshot — so it moved, verbatim, to `tests/helpers/workflowLaunchGate.ts` with the tests that pin it.
// RFC-359 AC-6：形参放宽到中立客户端。`@/db/*` 不能直接出现在 services 层
//（`rfc349-provider-cutover` 的「业务面只持有 port、不持有 DB 机制」那条），
// 所以走 legacy transport 那份既有的中立别名——与 `services/taskArchive.ts` 同形。
// RFC-470 (RFC-294 W9-D): moved here verbatim from `services/taskLaunchGate.ts` — the gate is resource-catalog's
// static validation of its own snapshot; the assembly root takes it through `composition/agentLaunchResources.ts`.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ValidationError } from '@/util/errors'
import { loadWorkflowValidationContext, validateWorkflowDef } from './legacy/workflow.validator'
import type { TaskExecutionWorkflowSnapshot } from '@/modules/resource-catalog/public/types'

/**
 * Validate an already authorized Resource Catalog snapshot without re-reading
 * the target row. Integration triggers use this after the participant has
 * enforced visibility + built-in policy inside its transaction.
 */
export async function assertWorkflowSnapshotLaunchable(
  db: PersistenceDb,
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
