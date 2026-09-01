// Compatibility facade; the native PostgreSQL apply mechanism is selected by
// Intent infrastructure/composition rather than by a service-layer caller.
export {
  createPostgresqlIntentApplyOperations,
  type PostgresqlIntentApplyArtifactLifecycle,
  type PostgresqlIntentApplyDependencies,
  type PostgresqlIntentApplyOperations,
  type PostgresqlIntentApplyRequest,
  type PostgresqlIntentApplyResourceBinding,
} from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
