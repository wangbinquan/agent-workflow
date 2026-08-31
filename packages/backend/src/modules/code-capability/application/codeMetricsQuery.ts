// RFC-304 T58 — adoption and run counts, per capability.
//
// The one design decision here is a refusal: this does NOT compute an adoption
// rate. `resolvedAt` and `codeChangedAt` are stored separately because they
// disagree in the cases worth knowing about, and any single percentage has to
// pick one of those disagreements to be wrong about.
//
// Concretely, the number a team would act on:
//
//   counting "resolved" alone   — a reviewer who resolves threads to clear
//                                 their queue reads as 100% adoption while
//                                 nothing was fixed.
//   counting "code changed"     — a rebase that touches the anchored line reads
//                                 as adoption of a finding nobody agreed with.
//   counting either             — both mistakes at once.
//
// So the four buckets are returned as four numbers and the page shows them as
// four. It costs one extra column of screen space and buys a metric that cannot
// quietly flatter the platform that produced it.

import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { codeFindings, codeWorkItems, codeWorkRounds } from '@/db/schema'
import type {
  CodeAdoptionBuckets,
  CodeMetricsQuery,
  CodeMetricsSummary,
  CodeRunCounts,
} from '@/modules/code-capability/public/queries'

/**
 * The default reporting window: 30 days.
 *
 * Bounded rather than all-time because the question is "is this working now".
 * An all-time number is dominated by whatever the configuration looked like
 * months ago and barely moves when a capability starts or stops working, which
 * is precisely when someone is looking at it.
 */
export const DEFAULT_METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export interface CodeMetricFindingRow {
  readonly capability: string
  readonly resolvedAt: number | null
  readonly codeChangedAt: number | null
}

export interface CodeMetricRoundRow {
  readonly capability: string
  readonly outcome: string | null
  readonly endedAt: number | null
  readonly n: number
}

/**
 * Provider-neutral metrics projection. SQLite and PostgreSQL own their query
 * mechanics, while the four adoption buckets and run outcome vocabulary stay
 * one application-level behavior oracle.
 */
export function projectCodeMetricsSummary(input: {
  readonly windowMs: number
  readonly findings: readonly CodeMetricFindingRow[]
  readonly rounds: readonly CodeMetricRoundRow[]
}): CodeMetricsSummary {
  const adoptionBy = new Map<string, CodeAdoptionBuckets>()
  for (const row of input.findings) {
    const bucket = adoptionBy.get(row.capability) ?? {
      capability: row.capability,
      published: 0,
      adopted: 0,
      quietFix: 0,
      disagreed: 0,
      outstanding: 0,
    }
    bucket.published += 1
    const resolved = row.resolvedAt !== null
    const changed = row.codeChangedAt !== null
    if (changed && resolved) bucket.adopted += 1
    else if (changed) bucket.quietFix += 1
    else if (resolved) bucket.disagreed += 1
    else bucket.outstanding += 1
    adoptionBy.set(row.capability, bucket)
  }

  const runsBy = new Map<string, CodeRunCounts>()
  for (const row of input.rounds) {
    const counts = runsBy.get(row.capability) ?? {
      capability: row.capability,
      rounds: 0,
      published: 0,
      failed: 0,
      awaiting: 0,
      incomplete: 0,
    }
    counts.rounds += row.n
    if (row.outcome === 'published') counts.published += row.n
    else if (row.outcome === 'failed') counts.failed += row.n
    else if (row.outcome === 'awaiting') counts.awaiting += row.n
    else if (row.endedAt !== null) counts.incomplete += row.n
    runsBy.set(row.capability, counts)
  }

  const byCapability = (a: { capability: string }, b: { capability: string }): number =>
    a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0

  return {
    windowMs: input.windowMs,
    adoption: [...adoptionBy.values()].sort(byCapability),
    runs: [...runsBy.values()].sort(byCapability),
  }
}

export function createCodeMetricsQuery(db: DbClient): CodeMetricsQuery {
  return {
    async summary(input) {
      const windowMs = input?.windowMs ?? DEFAULT_METRICS_WINDOW_MS
      const now = input?.now ?? Date.now()
      const since = now - windowMs

      // Only findings that were actually PUBLISHED count. An unpublished one
      // was never put in front of anyone, so counting it as "outstanding" would
      // blame the reader for something they never saw.
      const findings = await db
        .select({
          capability: codeFindings.capability,
          resolvedAt: codeFindings.resolvedAt,
          codeChangedAt: codeFindings.codeChangedAt,
        })
        .from(codeFindings)
        .where(and(isNotNull(codeFindings.externalId), gte(codeFindings.createdAt, since)))

      // Rounds carry no capability of their own — it lives on the work item, so
      // this joins rather than reading a denormalized copy. A copy would drift
      // the first time a work item's capability is corrected.
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
