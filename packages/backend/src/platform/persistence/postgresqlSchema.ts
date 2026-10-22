// RFC-395 I-a: stable compiler API; callers supply the epoch-1 contract.
export {
  POSTGRESQL_APPLICATION_SCHEMA,
  POSTGRESQL_METADATA_SCHEMA,
  POSTGRESQL_BASELINE_ID,
  PostgresqlSchemaProjectionError,
  renderPostgresqlColumnSql,
  buildPostgresqlSchemaPlan,
  renderPostgresqlBaselineSql,
  compilePostgresqlPlan,
  type PostgresqlSchemaStatement,
  type PostgresqlSchemaPlan,
} from './schema/postgresqlPlan'
