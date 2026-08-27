import { createWebSocketTaskStatusPublisher } from '../infrastructure/webSocketTaskStatusPublisher'

export type {
  SchedulerDriverPort,
  SchedulerRuntimeTopology,
  TaskDriveRuntimeOptions,
  TaskStatusPublisher,
} from '../application/ports/taskExecutionTopology'
export {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
} from '../application/ports/taskExecutionTopology'

export function createTaskStatusPublisher() {
  return createWebSocketTaskStatusPublisher()
}
