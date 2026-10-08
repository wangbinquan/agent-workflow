import { and, eq, gt, asc } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationReports,
  observationReportPages,
  observationReportRows,
  observationReportCounts,
  observationReportReceipts,
  observationReportRetainedRevisions,
} from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  affectedRows,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { CompleteObservationReportCache } from '../ports/completeObservationReportCache'
import {
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationReportPage,
  type CompleteObservationQuality,
} from '@agent-workflow/shared'
import { CompleteObservationError } from '../domain/completeObservationError'
import { completeReportFactRow } from '../domain/completeReportFacts'
import {
  decodeCompleteReport,
  encodeCompleteReportRequest,
  completeReportEmptyProgress,
} from './completeObservationReportDocuments'
import {
  assertCompleteReportActor,
  ownedCompleteReport,
  type CompleteReportTaskSource,
} from './completeObservationReportAdmission'
import { stageCompleteReportPage, publishCompleteReport } from './completeObservationReportStage'
import { completeReportQualifiedReader } from './completeObservationReportRead'

export const completeReportLeaseKey = (id: string) => 'observation-report/' + id
/** Older immutable reports must not fabricate an empty association index that was never sealed. */
async function assertCompleteQualityTaskIndex(
  tx: DatabaseTransaction,
  id: string,
  parent: string | null,
) {
  if (parent === null)
    throw new CompleteObservationError('not-ready', 'Original quality reason is required')
  const original = await tx
    .select({ document: observationReportRows.document })
    .from(observationReportRows)
    .where(
      and(
        eq(observationReportRows.reportId, id),
        eq(observationReportRows.section, 'quality'),
        eq(observationReportRows.parent, ''),
        eq(observationReportRows.key, parent),
      ),
    )
    .get()
  const quality = original ? (JSON.parse(original.document) as CompleteObservationQuality) : null
  if (
    !quality ||
    quality.key !== parent ||
    quality.taskIndexVersion !== 1 ||
    !/^(0|[1-9]\d*)$/.test(quality.taskCount)
  )
    throw new CompleteObservationError('not-ready', 'Original quality Task index was not sealed')
  const count = await tx
    .select({ total: observationReportCounts.total })
    .from(observationReportCounts)
    .where(
      and(
        eq(observationReportCounts.reportId, id),
        eq(observationReportCounts.section, 'quality-tasks'),
        eq(observationReportCounts.parent, parent),
      ),
    )
    .get()
  if ((count?.total ?? '0') !== quality.taskCount)
    throw new CompleteObservationError('not-ready', 'Original quality Task population changed')
}
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
  taskSource: CompleteReportTaskSource,
  now = Date.now,
): CompleteObservationReportCache {
  if (!generation) throw new Error('Original report database generation missing')
  const session = databaseSessionFor(db)
  const read = completeReportQualifiedReader(generation, taskSource)
  const dirty = async (tx: DatabaseTransaction, id: string) => {
    const row = await tx
      .select({ revision: observationReportRetainedRevisions.revision })
      .from(observationReportRetainedRevisions)
      .where(eq(observationReportRetainedRevisions.reportId, id))
      .get()
    return Boolean(row?.revision)
  }
  const rebuild = async (tx: DatabaseTransaction, id: string, owner: string) => {
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
    await clearCompleteReportRows(tx, id)
    await tx
      .delete(observationReportRetainedRevisions)
      .where(eq(observationReportRetainedRevisions.reportId, id))
      .run()
    const row = await tx
      .select()
      .from(observationReports)
      .where(eq(observationReports.id, id))
      .get()
    return decodeCompleteReport(row!)
  }
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
        await assertCompleteReportActor(tx, request.actor, taskSource(tx), request.taskId)
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
        let row = await tx
          .select()
          .from(observationReports)
          .where(eq(observationReports.requestKey, requestKey))
          .get()
        if (!row || row.generation !== generation || row.actorScope !== actorScope)
          throw new Error('Complete original report request identity changed')
        await engineOf(tx).lockAggregateRoot(tx, observationReports, observationReports.id, row.id)
        row = await tx
          .select()
          .from(observationReports)
          .where(eq(observationReports.id, row.id))
          .get()
        if (!row || row.generation !== generation || row.actorScope !== actorScope)
          throw new Error('Complete original report request identity changed')
        if (row.state !== 'building' && (await dirty(tx, row.id))) return rebuild(tx, row.id, owner)
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
          (row.state === 'failed' ||
            (row.state === 'building' && row.leaseUntil <= now()) ||
            (row.state !== 'building' && (await dirty(tx, id))))
        ) {
          return rebuild(tx, id, owner)
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
      publishCompleteReport(db, generation, id, owner, manifest, now, taskSource),
    unavailable: (id, owner, gaps) =>
      terminal(id, owner, { state: 'not-ready', reportId: id, gaps }),
    fail: (id, owner, error) =>
      terminal(id, owner, { state: 'failed', reportId: id, error, retryable: true }),
    assertReadable: (actor, report) => session.snapshotRead((tx) => read(tx, actor, report)),
    async page<T>(
      report: Parameters<CompleteObservationReportCache['page']>[0],
      query: Parameters<CompleteObservationReportCache['page']>[1],
    ): Promise<CompleteObservationReportPage<T>> {
      return session.snapshotRead(async (tx) => {
        await read(tx, report.request.actor, report)
        if (
          report.report.state === 'not-ready' &&
          !COMPLETE_OBSERVATION_FACT_SECTIONS.includes(query.section)
        )
          throw new CompleteObservationError(
            'not-ready',
            'Original numeric evidence is incomplete; only sealed execution facts are available',
          )
        if (query.section === 'quality-tasks')
          await assertCompleteQualityTaskIndex(tx, report.id, query.parent)
        const scope = and(
          eq(observationReportRows.reportId, report.id),
          eq(observationReportRows.section, query.section),
          eq(observationReportRows.parent, query.parent ?? ''),
        )
        const rows = await tx
          .select({
            ordinal: observationReportRows.ordinal,
            key: observationReportRows.key,
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
          items: items.map((row) => {
            const document = JSON.parse(row.document) as T
            if (report.report.state === 'not-ready') {
              const original = {
                section: query.section,
                parent: query.parent,
                key: row.key,
                document,
              }
              const qualified = completeReportFactRow(original, report.report.gaps)
              if (!qualified || !isDeepStrictEqual(qualified, original))
                throw new Error('Original retained scope metrics are not qualified')
            }
            return document
          }),
          total: count?.total ?? '0',
          nextCursor: rows.length > query.limit && last ? last.ordinal : null,
        }
      })
    },
  }
}
