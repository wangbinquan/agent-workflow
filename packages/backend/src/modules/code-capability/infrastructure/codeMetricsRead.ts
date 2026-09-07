// RFC-359 W12 — one row reader behind the shared code metrics projection.

import { and, count, eq, gte, isNotNull } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type { CodeMetricsReadPort } from '../application/ports/codeMetricsRead'

export function createCodeMetricsRead(db: ProviderNeutralDatabase): CodeMetricsReadPort {
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
          // RFC-359 W8 — drizzle's `count()` carries `.mapWith(Number)`; the
          // bare ``sql<number>`count(*)` `` this replaces carried only the TYPE.
          // SQLite's driver happens to hand back a JS number so the lie was
          // invisible here, but PostgreSQL returns `count(*)` as bigint, i.e. a
          // STRING — and the projection adds these (`counts.rounds += row.n`),
          // so the /code metrics panel rendered `rounds: "021"` instead of 3.
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
