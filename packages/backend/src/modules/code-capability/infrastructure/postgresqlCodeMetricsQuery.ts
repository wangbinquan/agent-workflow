// RFC-349 — PostgreSQL implementation of the code-capability metrics read
// model. Provider SQL stays in infrastructure; application owns the bucket and
// outcome projection shared with SQLite.

import { and, count, eq, gte, isNotNull } from 'drizzle-orm'

import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import type { CodeMetricsReadPort } from '@/modules/code-capability/application/ports/codeMetricsRead'
import type { CodeMetricsQuery } from '@/modules/code-capability/public/queries'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function createPostgresqlCodeMetricsRead(db: PostgresqlDatabaseClient): CodeMetricsReadPort {
  return {
    async loadSince(since) {
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
          n: count(),
        })
        .from(codeWorkRounds)
        .innerJoin(codeWorkItems, eq(codeWorkRounds.workItemId, codeWorkItems.id))
        .where(gte(codeWorkRounds.startedAt, since))
        .groupBy(codeWorkItems.capability, codeWorkRounds.outcome, codeWorkRounds.endedAt)

      return { findings, rounds }
    },
  }
}

/** Retained as the infrastructure convenience used by focused adapter tests. */
export function createPostgresqlCodeMetricsQuery(db: PostgresqlDatabaseClient): CodeMetricsQuery {
  return createCodeMetricsQuery(createPostgresqlCodeMetricsRead(db))
}
