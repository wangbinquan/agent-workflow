import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationReports } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { CompleteObservationHostSelection } from '../application/completeObservationExecution'

/** Return only this service's unissued report claim, preserving its identity. */
export function completeObservationHostClaims(
  db: ProviderNeutralDatabase,
): CompleteObservationHostSelection {
  const session = databaseSessionFor(db)
  return {
    mode: 'host',
    deferUnissued: (report) =>
      session.transaction(async (tx) => {
        await engineOf(tx).lockAggregateRoot(
          tx,
          observationReports,
          observationReports.id,
          report.id,
        )
        const row = await tx
          .select()
          .from(observationReports)
          .where(eq(observationReports.id, report.id))
          .get()
        if (!row) return
        // A failed claim ACK may also mean it never acquired this owner. No
        // build was issued, so a different owner is left entirely untouched.
        if (row.owner !== report.owner || row.generation !== report.generation) return
        if (row.state !== 'building') return
        const stored = JSON.parse(row.report) as { phase?: string }
        if (stored.phase !== 'queued' && stored.phase !== 'collecting')
          throw new Error('observation-report-build-already-issued')
        await tx
          .update(observationReports)
          .set({
            leaseUntil: 0,
            report: JSON.stringify({ state: 'building', reportId: report.id, phase: 'queued' }),
          })
          .where(
            and(eq(observationReports.id, report.id), eq(observationReports.owner, report.owner)),
          )
          .run()
      }),
  }
}
