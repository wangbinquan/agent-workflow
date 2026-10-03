import { and, eq, ne, or, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationReportCounts,
  observationReportPages,
  observationReportReceipts,
  observationReportRows,
} from '@/db/schema'
import type { CompleteObservationStoredReport } from '../ports/completeObservationReport'
import { CompleteObservationError } from '../domain/completeObservationError'

/** Damaged derived output cannot keep exposing the original sealed total. */
export async function assertCompleteReportIntegrity(
  db: ProviderNeutralDatabase,
  report: CompleteObservationStoredReport,
) {
  if (report.report.state !== 'ready') return
  const manifest = report.manifest
  const invalid = () =>
    new CompleteObservationError(
      'not-ready',
      'Complete report retained output differs from its original seal; refresh',
    )
  if (
    !manifest ||
    manifest.reportId !== report.id ||
    manifest.owner !== report.owner ||
    manifest.requestKey !== report.requestKey ||
    JSON.stringify(manifest.header) !== JSON.stringify(report.report.header) ||
    JSON.stringify(manifest.summary) !== JSON.stringify(report.report.summary)
  )
    throw invalid()
  for (const [key, table] of [
    ['pages', observationReportPages],
    ['rows', observationReportRows],
    ['counts', observationReportCounts],
    ['receipts', observationReportReceipts],
  ] as const) {
    const actual = await db
      .select({ total: sql<string>`cast(count(*) as text)`.mapWith(String) })
      .from(table)
      .where(eq(table.reportId, report.id))
      .get()
    if ((actual?.total ?? '0') !== manifest[key]) throw invalid()
  }
  const physical = db
    .select({ total: sql<string>`cast(count(*) as text)`.mapWith(String) })
    .from(observationReportRows)
    .where(
      and(
        eq(observationReportRows.reportId, observationReportCounts.reportId),
        eq(observationReportRows.section, observationReportCounts.section),
        eq(observationReportRows.parent, observationReportCounts.parent),
      ),
    )
  const missing = await db
    .select({ section: observationReportCounts.section })
    .from(observationReportCounts)
    .where(
      and(
        eq(observationReportCounts.reportId, report.id),
        or(
          eq(observationReportCounts.declared, false),
          ne(observationReportCounts.actual, observationReportCounts.total),
          ne(observationReportCounts.total, sql`(${physical})`),
        ),
      ),
    )
    .limit(1)
    .get()
  if (missing) throw invalid()
}
