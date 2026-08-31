// RFC-349 — PostgreSQL implementation of the code-capability metrics read
// model. Provider SQL stays in infrastructure; application owns the bucket and
// outcome projection shared with SQLite.

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'

import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import {
  DEFAULT_METRICS_WINDOW_MS,
  projectCodeMetricsSummary,
} from '@/modules/code-capability/application/codeMetricsQuery'
import type { CodeMetricsQuery } from '@/modules/code-capability/public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function createPostgresqlCodeMetricsQuery(db: PostgresqlDatabaseClient): CodeMetricsQuery {
  return {
    async summary(input) {
      const windowMs = input?.windowMs ?? DEFAULT_METRICS_WINDOW_MS
      const now = input?.now ?? Date.now()
      const since = now - windowMs

      const findings = await db
        .select({
          capability: codeFindings.capability,
          resolvedAt: codeFindings.resolvedAt,
          codeChangedAt: codeFindings.codeChangedAt,
        })
        .from(codeFindings)
        .where(and(isNotNull(codeFindings.externalId), gte(codeFindings.createdAt, since)))

      const rounds = await db
        .select({
          capability: codeWorkItems.capability,
          outcome: codeWorkRounds.outcome,
          endedAt: codeWorkRounds.endedAt,
          n: sql<number>`count(*)`,
        })
        .from(codeWorkRounds)
        .innerJoin(codeWorkItems, eq(codeWorkRounds.workItemId, codeWorkItems.id))
        .where(gte(codeWorkRounds.startedAt, since))
        .groupBy(codeWorkItems.capability, codeWorkRounds.outcome, codeWorkRounds.endedAt)

      return projectCodeMetricsSummary({ windowMs, findings, rounds })
    },
  }
}
