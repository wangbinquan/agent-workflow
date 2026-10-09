import type { TaskExecutionPersistence } from './ports/taskExecutionPersistence'
import type { TaskNodeWritePurposes } from './ports/taskNodeWritePurposes'
import type { NodeRunLifecyclePersistence } from './ports/nodeRunLifecyclePersistence'
import type { NodeExecutionPersistence } from './ports/nodeExecutionPersistence'

type Purpose = keyof TaskNodeWritePurposes
type Selection = Pick<TaskExecutionPersistence, 'nodeWriteMode' | 'nodeWritePurposes'>
type RunSelection = Selection & Pick<TaskExecutionPersistence, 'nodeRuns'>
type ExecutionSelection = Selection & Pick<TaskExecutionPersistence, 'nodeExecution'>

function selectedPurpose<K extends Purpose>(
  persistence: Selection,
  purpose: K,
): TaskNodeWritePurposes[K] | undefined {
  if (persistence.nodeWriteMode === undefined && persistence.nodeWritePurposes === undefined)
    return undefined
  const view = persistence.nodeWritePurposes?.[purpose]
  if (view === undefined) throw new Error('task-node-write-purposes-not-composed')
  return view
}

export function selectTaskNodeRunWrites(
  persistence: RunSelection,
  purpose: 'preparation',
): NodeRunLifecyclePersistence
export function selectTaskNodeRunWrites(
  persistence: RunSelection,
  purpose: Purpose,
): Omit<NodeRunLifecyclePersistence, 'mint'>
export function selectTaskNodeRunWrites(
  persistence: RunSelection,
  purpose: Purpose,
): Omit<NodeRunLifecyclePersistence, 'mint'> {
  const view = selectedPurpose(persistence, purpose)
  return view === undefined ? persistence.nodeRuns : view.nodeRuns
}

export function selectTaskNodeExecutionWrites(
  persistence: ExecutionSelection,
  purpose: Purpose,
): NodeExecutionPersistence {
  const view = selectedPurpose(persistence, purpose)
  return view === undefined ? persistence.nodeExecution : view.nodeExecution
}
