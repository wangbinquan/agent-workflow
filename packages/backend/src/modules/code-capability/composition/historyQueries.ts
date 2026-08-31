// RFC-349 — provider-neutral composition for the four code-history read
// surfaces. HTTP receives one aggregate and never selects a database provider;
// bootstrap owns the explicit SQLite/PostgreSQL choice.

import type { DbClient } from '@/db/client'
import {
  createCodeDeliveryChainQuery,
  createCodeRoundAttemptsQuery,
  createCodeWorkItemProjectionQuery,
  type CodeDeliveryChainQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import { createPostgresqlCodeMetricsQuery } from '@/modules/code-capability/infrastructure/postgresqlCodeMetricsQuery'
import { createPostgresqlDeliveryChainRead } from '@/modules/code-capability/infrastructure/postgresqlDeliveryChain'
import { createPostgresqlRoundAttemptsRead } from '@/modules/code-capability/infrastructure/postgresqlRoundAttemptsRead'
import { createPostgresqlWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/postgresqlWorkItemProjectionRead'
import type {
  CodeMetricsQuery,
  CodeRoundAttemptsQuery,
  CodeWorkItemProjectionQuery,
} from '@/modules/code-capability/public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export interface CodeHistoryQueries {
  readonly workItems: CodeWorkItemProjectionQuery
  readonly attempts: CodeRoundAttemptsQuery
  readonly deliveries: CodeDeliveryChainQuery
  readonly metrics: CodeMetricsQuery
}

export function composeSqliteCodeHistoryQueries(db: DbClient): CodeHistoryQueries {
  return Object.freeze({
    workItems: createCodeWorkItemProjectionQuery(db),
    attempts: createCodeRoundAttemptsQuery(db),
    deliveries: createCodeDeliveryChainQuery(db),
    metrics: createCodeMetricsQuery(db),
  })
}

export function composePostgresqlCodeHistoryQueries(
  db: PostgresqlDatabaseClient,
): CodeHistoryQueries {
  return Object.freeze({
    workItems: createCodeWorkItemProjectionQuery(createPostgresqlWorkItemProjectionRead(db)),
    attempts: createCodeRoundAttemptsQuery(createPostgresqlRoundAttemptsRead(db)),
    deliveries: createCodeDeliveryChainQuery(createPostgresqlDeliveryChainRead(db)),
    metrics: createPostgresqlCodeMetricsQuery(db),
  })
}
