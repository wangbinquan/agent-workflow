// RFC-349 — PostgreSQL implementation of the code-capability metrics read
// model. Provider SQL stays in infrastructure; application owns the bucket and
// outcome projection shared with SQLite.

import { and, count, eq, gte, isNotNull } from 'drizzle-orm'

import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type { CodeMetricsReadPort } from '@/modules/code-capability/application/ports/codeMetricsRead'
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
