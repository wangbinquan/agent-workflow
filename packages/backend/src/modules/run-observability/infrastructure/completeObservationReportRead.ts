import { eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationReports, observationReportRetainedRevisions } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { completeObservationReportContent } from '@agent-workflow/shared'
import type { CompleteObservationStoredReport } from '../ports/completeObservationReport'
import { CompleteObservationError } from '../domain/completeObservationError'
import { decodeCompleteReport } from './completeObservationReportDocuments'
import { assertStoredCompleteReport } from './completeObservationReportAdmission'
import { assertCompleteReportIntegrity } from './completeObservationReportIntegrity'

const changed = () =>
  new CompleteObservationError(
    'not-ready',
    'Complete report retained output differs from its original seal; refresh',
  )

/** Physical qualification only. Actor, Task population and cost visibility still run on every read. */
export function completeReportQualifiedReader(generation: string) {
  const qualifications = new Map<string, string>()
  return async (
    db: ProviderNeutralDatabase,
    actor: Actor,
    supplied: CompleteObservationStoredReport,
  ) => {
    const row = await db
      .select()
      .from(observationReports)
      .where(eq(observationReports.id, supplied.id))
      .get()
    if (!row || row.generation !== generation) throw changed()
    const current = decodeCompleteReport(row)
    // A building status may finish between get() and this snapshot read. Only a
    // supplied published seal is immutable; always qualify the current snapshot.
    const published = Boolean(completeObservationReportContent(supplied.report))
    if (
      published
        ? !isDeepStrictEqual(current, supplied)
        : current.owner !== supplied.owner ||
          current.requestKey !== supplied.requestKey ||
          current.actorScope !== supplied.actorScope ||
          !isDeepStrictEqual(current.request, supplied.request)
    )
      throw changed()
    await assertStoredCompleteReport(db, actor, current, async (snapshot, report) => {
      const retained = await snapshot
        .select({ revision: observationReportRetainedRevisions.revision })
        .from(observationReportRetainedRevisions)
        .where(eq(observationReportRetainedRevisions.reportId, report.id))
        .get()
      const revision = retained?.revision ?? ''
      if (revision !== '') throw changed()
      const identity = sha256Hex(
        JSON.stringify([
          row.id,
          row.generation,
          row.owner,
          row.requestKey,
          row.actorScope,
          row.request,
          row.state,
          row.report,
          row.manifest,
          revision,
        ]),
      )
      if (qualifications.get(report.id) === identity) return
      await assertCompleteReportIntegrity(snapshot, report)
      qualifications.set(report.id, identity)
    })
  }
}
