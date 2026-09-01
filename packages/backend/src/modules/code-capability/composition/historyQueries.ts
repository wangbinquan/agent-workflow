// RFC-349 — provider-neutral composition for the four code-history read
// surfaces. HTTP receives one aggregate and never selects a database provider;
// bootstrap owns the explicit SQLite/PostgreSQL choice.

import type { DbClient } from '@/db/client'
import {
  createCodeMatrixQuery,
  createCodeDeliveryChainQuery,
  createCodeRoundAttemptsQuery,
  createCodeWorkItemProjectionQuery,
  type CodeDeliveryChainQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import {
  createTemplateUpstreamOperations,
  type TemplateUpstreamOperations,
} from '@/modules/code-capability/application/templateUpstreamStatus'
import { createPostgresqlCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/postgresqlCapabilityMatrixRead'
import { createPostgresqlCodeMetricsRead } from '@/modules/code-capability/infrastructure/postgresqlCodeMetricsQuery'
import { createPostgresqlDeliveryChainRead } from '@/modules/code-capability/infrastructure/postgresqlDeliveryChain'
import { createPostgresqlRoundAttemptsRead } from '@/modules/code-capability/infrastructure/postgresqlRoundAttemptsRead'
import { createPostgresqlTemplateUpstreamPersistence } from '@/modules/code-capability/infrastructure/postgresqlTemplateUpstreamPersistence'
import { createPostgresqlWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/postgresqlWorkItemProjectionRead'
import { createSqliteCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { createSqliteCodeMetricsRead } from '@/modules/code-capability/infrastructure/sqliteCodeMetricsRead'
import { createSqliteDeliveryChainRead } from '@/modules/code-capability/infrastructure/sqliteDeliveryChain'
import { createSqliteRoundAttemptsRead } from '@/modules/code-capability/infrastructure/sqliteRoundAttemptsRead'
import { createSqliteTemplateUpstreamPersistence } from '@/modules/code-capability/infrastructure/sqliteTemplateUpstreamPersistence'
import { createSqliteWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/sqliteWorkItemProjectionRead'
import type {
  CodeMetricsQuery,
  CodeMatrixQuery,
  CodeRoundAttemptsQuery,
  CodeWorkItemProjectionQuery,
} from '@/modules/code-capability/public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export interface CodeHistoryQueries {
  readonly matrix: CodeMatrixQuery
  readonly workItems: CodeWorkItemProjectionQuery
  readonly attempts: CodeRoundAttemptsQuery
  readonly deliveries: CodeDeliveryChainQuery
  readonly metrics: CodeMetricsQuery
  readonly templateUpstream: TemplateUpstreamOperations
}

export function composeSqliteCodeHistoryQueries(db: DbClient): CodeHistoryQueries {
  return Object.freeze({
    matrix: createCodeMatrixQuery(createSqliteCapabilityMatrixRead(db)),
    workItems: createCodeWorkItemProjectionQuery(createSqliteWorkItemProjectionRead(db)),
    attempts: createCodeRoundAttemptsQuery(createSqliteRoundAttemptsRead(db)),
    deliveries: createCodeDeliveryChainQuery(createSqliteDeliveryChainRead(db)),
    metrics: createCodeMetricsQuery(createSqliteCodeMetricsRead(db)),
    templateUpstream: createTemplateUpstreamOperations(createSqliteTemplateUpstreamPersistence(db)),
  })
}

export function composePostgresqlCodeHistoryQueries(
  db: PostgresqlDatabaseClient,
): CodeHistoryQueries {
  return Object.freeze({
    matrix: createCodeMatrixQuery(createPostgresqlCapabilityMatrixRead(db)),
    workItems: createCodeWorkItemProjectionQuery(createPostgresqlWorkItemProjectionRead(db)),
    attempts: createCodeRoundAttemptsQuery(createPostgresqlRoundAttemptsRead(db)),
    deliveries: createCodeDeliveryChainQuery(createPostgresqlDeliveryChainRead(db)),
    metrics: createCodeMetricsQuery(createPostgresqlCodeMetricsRead(db)),
    templateUpstream: createTemplateUpstreamOperations(
      createPostgresqlTemplateUpstreamPersistence(db),
    ),
  })
}
