// RFC-341 — bootstrap-only assembly surface for the task lifecycle event family.

export {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '../application/taskLifecycleConsumers'
export { createTaskLifecycleWsProjector } from '../infrastructure/taskLifecycleWsProjector'
// RFC-359 W4-B1：WS 投影只有一份实现；provider 具名导出只做绑定（bootstrap 收敛后一并删）。
export {
  createDatabaseTaskLifecycleWsProjection,
  createDatabaseTaskLifecycleWsProjector,
  createDatabaseTaskLifecycleWsProjection as createSqliteTaskLifecycleWsProjection,
  createDatabaseTaskLifecycleWsProjector as createSqliteTaskLifecycleWsProjector,
  createDatabaseTaskLifecycleWsProjection as createPostgresqlTaskLifecycleWsProjection,
  createDatabaseTaskLifecycleWsProjector as createPostgresqlTaskLifecycleWsProjector,
} from '../infrastructure/taskLifecycleWsProjection'
export type { TaskLifecycleWsProjection } from '../application/ports/taskLifecycleWsProjection'
