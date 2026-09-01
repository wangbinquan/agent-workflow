// RFC-349 — SQLite rows behind the shared code metrics projection.

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type { CodeMetricsReadPort } from '../application/ports/codeMetricsRead'

export function createSqliteCodeMetricsRead(db: DbClient): CodeMetricsReadPort {
  return {
    async loadSince(since) {
      // Only findings that were actually published count. An unpublished one
      // was never shown to anyone and cannot be outstanding adoption work.
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

      return { findings, rounds }
    },
  }
}
