import { and, eq, gt, asc } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationReports,
  observationReportPages,
  observationReportRows,
  observationReportCounts,
  observationReportReceipts,
} from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  affectedRows,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { CompleteObservationReportCache } from '../ports/completeObservationReportCache'
import type { CompleteObservationReportPage } from '@agent-workflow/shared'
import {
  decodeCompleteReport,
  encodeCompleteReportRequest,
  completeReportEmptyProgress,
} from './completeObservationReportDocuments'
import {
  assertStoredCompleteReport,
  assertCompleteReportActor,
  ownedCompleteReport,
} from './completeObservationReportAdmission'
import { stageCompleteReportPage, publishCompleteReport } from './completeObservationReportStage'

export const completeReportLeaseKey = (id: string) => 'observation-report/' + id
export async function clearCompleteReportRows(tx: DatabaseTransaction, id: string) {
  for (const table of [
    observationReportPages,
    observationReportRows,
    observationReportCounts,
    observationReportReceipts,
  ])
    await tx.delete(table).where(eq(table.reportId, id)).run()
}
export function completeObservationReportCache(
  db: ProviderNeutralDatabase,
  generation: string,
  now = Date.now,
): CompleteObservationReportCache {
  if (!generation) throw new Error('Original report database generation missing')
  const session = databaseSessionFor(db)
  const terminal = async (
    id: string,
    owner: string,
    report:
      | { state: 'not-ready'; reportId: string; gaps: readonly string[] }
      | { state: 'failed'; reportId: string; error: string; retryable: boolean },
  ) =>
    session.transaction(async (tx) => {
      await engineOf(tx).lockAggregateRoot(tx, observationReports, observationReports.id, id)
      const row = await tx
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, id))
        .get()
      if (!row || row.owner !== owner || row.state !== 'building') return
      await clearCompleteReportRows(tx, id)
      await tx
        .update(observationReports)
        .set({
          state: report.state,
          report: JSON.stringify(report),
          manifest: null,
          progress: JSON.stringify(completeReportEmptyProgress()),
          updatedAt: now(),
        })
        .where(eq(observationReports.id, id))
        .run()
    })
  return {
    generation,
    async get(id) {
      const row = await db
        .select()
        .from(observationReports)
        .where(eq(observationReports.id, id))
        .get()
      return row ? decodeCompleteReport(row) : undefined
    },
    async ensure(request, requestKey, actorScope, owner, id) {
      return session.transaction(async (tx) => {
        await assertCompleteReportActor(tx, request.actor, request.taskId)
        const time = now()
        await tx
          .insert(observationReports)
          .values({
            id,
            requestKey,
            actorScope,
            generation,
            owner,
            request: encodeCompleteReportRequest(request),
            state: 'building',
            report: JSON.stringify({ state: 'building', reportId: id, phase: 'queued' }),
            progress: JSON.stringify(completeReportEmptyProgress()),
            leaseUntil: time + 45_000,
            createdAt: time,
            updatedAt: time,
          })
          .onConflictDoNothing({ target: observationReports.requestKey })
          .run()
        const row = await tx
          .select()
          .from(observationReports)
          .where(eq(observationReports.requestKey, requestKey))
          .get()
        if (!row || row.generation !== generation || row.actorScope !== actorScope)
          throw new Error('Complete original report request identity changed')
        return decodeCompleteReport(row)
      })
    },
    async claim(id, owner) {
      return session.transaction(async (tx) => {
        const acquired = await engineOf(tx).tryAdvisoryLock(tx, completeReportLeaseKey(id))
        await engineOf(tx).lockAggregateRoot(tx, observationReports, observationReports.id, id)
        const row = await tx
          .select()
          .from(observationReports)
          .where(eq(observationReports.id, id))
          .get()
        if (!row || row.generation !== generation)
          throw new Error('Original complete report recovery request missing')
        if (
          acquired &&
          (row.state === 'failed' || (row.state === 'building' && row.leaseUntil <= now()))
        ) {
          await clearCompleteReportRows(tx, id)
          await tx
            .update(observationReports)
            .set({
              owner,
              state: 'building',
              report: JSON.stringify({ state: 'building', reportId: id, phase: 'queued' }),
              manifest: null,
              progress: JSON.stringify(completeReportEmptyProgress()),
              leaseUntil: now() + 45_000,
              updatedAt: now(),
            })
            .where(eq(observationReports.id, id))
            .run()
          const claimed = await tx
            .select()
            .from(observationReports)
            .where(eq(observationReports.id, id))
            .get()
          return decodeCompleteReport(claimed!)
        }
        return decodeCompleteReport(row)
      })
    },
    async renew(id, owner) {
      return (
        affectedRows(
          await db
            .update(observationReports)
            .set({ leaseUntil: now() + 45_000, updatedAt: now() })
            .where(
              and(
                eq(observationReports.id, id),
                eq(observationReports.owner, owner),
                eq(observationReports.state, 'building'),
                eq(observationReports.generation, generation),
              ),
            )
            .run(),
        ) === 1
      )
    },
    async phase(id, owner, phase) {
      await session.transaction(async (tx) => {
        await ownedCompleteReport(tx, id, owner)
        await tx
          .update(observationReports)
          .set({
            report: JSON.stringify({ state: 'building', reportId: id, phase }),
            updatedAt: now(),
            leaseUntil: now() + 45_000,
          })
          .where(eq(observationReports.id, id))
          .run()
      })
    },
    stage: (id, owner, page) => stageCompleteReportPage(db, id, owner, page, now),
    publish: (id, owner, manifest) =>
      publishCompleteReport(db, generation, id, owner, manifest, now),
    unavailable: (id, owner, gaps) =>
      terminal(id, owner, { state: 'not-ready', reportId: id, gaps }),
    fail: (id, owner, error) =>
      terminal(id, owner, { state: 'failed', reportId: id, error, retryable: true }),
    assertReadable: (actor, report) =>
      session.snapshotRead((tx) => assertStoredCompleteReport(tx, actor, report)),
    async page<T>(report, query): Promise<CompleteObservationReportPage<T>> {
      return session.snapshotRead(async (tx) => {
        await assertStoredCompleteReport(tx, report.request.actor, report)
        const scope = and(
          eq(observationReportRows.reportId, report.id),
          eq(observationReportRows.section, query.section),
          eq(observationReportRows.parent, query.parent ?? ''),
        )
        const rows = await tx
          .select({
            ordinal: observationReportRows.ordinal,
            document: observationReportRows.document,
          })
          .from(observationReportRows)
          .where(
            and(
              scope,
              query.after === null ? undefined : gt(observationReportRows.ordinal, query.after),
            ),
          )
          .orderBy(asc(observationReportRows.ordinal))
          .limit(query.limit + 1)
          .all()
        const count = await tx
          .select({ total: observationReportCounts.total })
          .from(observationReportCounts)
          .where(
            and(
              eq(observationReportCounts.reportId, report.id),
              eq(observationReportCounts.section, query.section),
              eq(observationReportCounts.parent, query.parent ?? ''),
            ),
          )
          .get()
        const items = rows.slice(0, query.limit),
          last = items.at(-1)
        return {
          reportId: report.id,
          section: query.section,
          parent: query.parent,
          items: items.map((row) => JSON.parse(row.document) as T),
          total: count?.total ?? '0',
          nextCursor: rows.length > query.limit && last ? last.ordinal : null,
        }
      })
    },
  }
}
