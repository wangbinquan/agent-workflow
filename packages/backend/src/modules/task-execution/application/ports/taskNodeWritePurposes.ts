import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'

/** The business caller selects the purpose; native method names do not decide it. */
export interface TaskNodeWritePurposes {
  readonly preparation: Readonly<{
    nodeRuns: NodeRunLifecyclePersistence
    nodeExecution: NodeExecutionPersistence
  }>
  readonly issuedResults: Readonly<{
    nodeRuns: Omit<NodeRunLifecyclePersistence, 'mint'>
    nodeExecution: NodeExecutionPersistence
  }>
}
