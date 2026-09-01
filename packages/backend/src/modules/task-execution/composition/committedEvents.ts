// RFC-341 — bootstrap-only assembly surface for the task lifecycle event family.

export {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '../application/taskLifecycleConsumers'
export { createTaskLifecycleWsProjector } from '../infrastructure/taskLifecycleWsProjector'
export {
  createSqliteTaskLifecycleWsProjection,
  createSqliteTaskLifecycleWsProjector,
} from '../infrastructure/sqliteTaskLifecycleWsProjection'
export {
  createPostgresqlTaskLifecycleWsProjection,
  createPostgresqlTaskLifecycleWsProjector,
} from '../infrastructure/postgresqlTaskLifecycleWsProjection'
export type { TaskLifecycleWsProjection } from '../application/ports/taskLifecycleWsProjection'
