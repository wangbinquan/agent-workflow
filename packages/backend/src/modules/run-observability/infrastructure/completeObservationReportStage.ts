import { and, eq, ne, notInArray, or, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  observationReports,
  observationReportPages,
  observationReportRows,
  observationReportCounts,
  observationReportReceipts,
  observationReportRetainedRevisions,
} from '@/db/schema'
import { databaseSessionFor, affectedRows } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import {
  COMPLETE_OBSERVATION_SECTIONS,
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  type CompleteObservationReport,
} from '@agent-workflow/shared'
import type {
  CompleteObservationManifest,
  CompleteObservationTransferPage,
} from '../ports/completeObservationReport'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import { assertCompleteReportTransferPage } from '../domain/completeReportEnvelope'
import { completeReportFactSummary, qualifiedCostEvidence } from '../domain/completeReportFacts'
import {
  decodeCompleteReport,
  type CompleteReportProgress,
} from './completeObservationReportDocuments'
import {
  assertCompleteReportActor,
  assertCompleteReportPopulation,
  ownedCompleteReport,
} from './completeObservationReportAdmission'

const countScope = (id: string, section: string, parent: string) =>
  and(
    eq(observationReportCounts.reportId, id),
    eq(observationReportCounts.section, section),
    eq(observationReportCounts.parent, parent),
  )
export async function stageCompleteReportPage(
  db: ProviderNeutralDatabase,
  id: string,
  owner: string,
  page: CompleteObservationTransferPage,
  now: () => number,
) {
  await databaseSessionFor(db).transaction(async (tx) => {
    const report = await ownedCompleteReport(tx, id, owner),
      progress = JSON.parse(report.progress) as CompleteReportProgress
    const ordinal = completeOrdinalKey(BigInt(page.ordinal))
    const previous = await tx
      .select()
      .from(observationReportPages)
      .where(
        and(eq(observationReportPages.reportId, id), eq(observationReportPages.ordinal, ordinal)),
      )
      .get()
    if (previous) {
      if (
        page.reportId !== id ||
        previous.digest !== page.digest ||
        previous.previousDigest !== page.previousDigest ||
        previous.itemsCount !== page.items.length
      )
        throw new Error('Original sealed report replay changed')
      assertCompleteReportTransferPage(page, id, page.ordinal, page.previousDigest, sha256Hex)
      return
    }
    assertCompleteReportTransferPage(page, id, progress.pages, progress.digest, sha256Hex)
    const rows: (typeof observationReportRows.$inferInsert)[] = [],
      receipts: (typeof observationReportReceipts.$inferInsert)[] = []
    const groups = new Map<string, { section: string; parent: string; size: bigint }>()
    for (let index = 0; index < page.items.length; index++) {
      const item = page.items[index]!
      if (item.kind === 'row') {
        const row = item.row
        if (!COMPLETE_OBSERVATION_SECTIONS.includes(row.section) || !row.key)
          throw new Error('Unknown original report row identity')
        const parent = row.parent ?? '',
          groupKey = JSON.stringify([row.section, parent])
        const group = groups.get(groupKey) ?? { section: row.section, parent, size: 0n }
        group.size++
        groups.set(groupKey, group)
        rows.push({
          reportId: id,
          ordinal: completeOrdinalKey(BigInt(page.ordinal) * 500n + BigInt(index)),
          section: row.section,
          parent,
          key: row.key,
          document: JSON.stringify(row.document),
        })
        progress.rows = String(BigInt(progress.rows) + 1n)
      } else if (item.kind === 'receipt') {
        if (!item.key) throw new Error('Original report receipt identity missing')
        receipts.push({ reportId: id, key: item.key, document: JSON.stringify(item.document) })
        progress.receipts = String(BigInt(progress.receipts) + 1n)
      } else if (item.kind === 'count') {
        const count = item.count,
          parent = count.parent ?? ''
        if (
          !COMPLETE_OBSERVATION_SECTIONS.includes(count.section) ||
          !/^(0|[1-9]\d*)$/.test(count.total)
        )
          throw new Error('Original report count invalid')
        const current = await tx
          .select()
          .from(observationReportCounts)
          .where(countScope(id, count.section, parent))
          .get()
        if (current?.declared) throw new Error('Original report count identity duplicated')
        if (current)
          await tx
            .update(observationReportCounts)
            .set({ total: count.total, declared: true })
            .where(countScope(id, count.section, parent))
            .run()
        else
          await tx
            .insert(observationReportCounts)
            .values({
              reportId: id,
              section: count.section,
              parent,
              total: count.total,
              actual: '0',
              declared: true,
            })
            .run()
        progress.counts = String(BigInt(progress.counts) + 1n)
      } else throw new Error('Unknown complete report transfer kind')
    }
    if (rows.length) await tx.insert(observationReportRows).values(rows).run()
    if (receipts.length) await tx.insert(observationReportReceipts).values(receipts).run()
    for (const group of groups.values()) {
      const current = await tx
        .select()
        .from(observationReportCounts)
        .where(countScope(id, group.section, group.parent))
        .get()
      if (current) {
        const changed = await tx
          .update(observationReportCounts)
          .set({ actual: String(BigInt(current.actual) + group.size) })
          .where(
            and(
              countScope(id, group.section, group.parent),
              eq(observationReportCounts.actual, current.actual),
            ),
          )
          .run()
        if (affectedRows(changed) !== 1)
          throw new Error('Original report row count changed during transfer')
      } else
        await tx
          .insert(observationReportCounts)
          .values({
            reportId: id,
            section: group.section,
            parent: group.parent,
            actual: String(group.size),
            total: '0',
            declared: false,
          })
          .run()
    }
    await tx
      .insert(observationReportPages)
      .values({
        reportId: id,
        ordinal,
        previousDigest: page.previousDigest,
        digest: page.digest,
        itemsCount: page.items.length,
      })
      .run()
    progress.pages = String(BigInt(progress.pages) + 1n)
    progress.digest = page.digest
    await tx
      .update(observationReports)
      .set({ progress: JSON.stringify(progress), updatedAt: now(), leaseUntil: now() + 45_000 })
      .where(eq(observationReports.id, id))
      .run()
  })
}
/** All payload writes are already committed; this transaction validates and publishes only the small header. */
export async function publishCompleteReport(
  db: ProviderNeutralDatabase,
  generation: string,
  id: string,
  owner: string,
  manifest: CompleteObservationManifest,
  now: () => number,
) {
  await databaseSessionFor(db).transaction(async (tx) => {
    const row = await ownedCompleteReport(tx, id, owner),
      report = decodeCompleteReport(row)
    if (
      manifest.reportId !== id ||
      manifest.owner !== owner ||
      manifest.requestKey !== row.requestKey ||
      row.generation !== generation ||
      manifest.header.generation !== generation ||
      manifest.header.reportId !== id ||
      manifest.header.actorScope !== row.actorScope
    )
      throw new Error('Complete original report seal or authority changed')
    await assertCompleteReportActor(tx, report.request.actor, report.request.taskId)
    const progress = JSON.parse(row.progress) as CompleteReportProgress
    for (const key of ['pages', 'rows', 'counts', 'receipts', 'digest'] as const)
      if (progress[key] !== manifest[key])
        throw new Error('Complete original staging seal missing: ' + key)
    const population = async (
      table:
        | typeof observationReportRows
        | typeof observationReportPages
        | typeof observationReportCounts
        | typeof observationReportReceipts,
    ) =>
      (
        await tx
          .select({ total: sql<string>`cast(count(*) as text)`.mapWith(String) })
          .from(table)
          .where(eq(table.reportId, id))
          .get()
      )?.total ?? '0'
    for (const [key, table] of [
      ['pages', observationReportPages],
      ['rows', observationReportRows],
      ['counts', observationReportCounts],
      ['receipts', observationReportReceipts],
    ] as const)
      if ((await population(table)) !== manifest[key])
        throw new Error('Complete original staged population missing: ' + key)
    const mismatch = await tx
      .select({ section: observationReportCounts.section })
      .from(observationReportCounts)
      .where(
        and(
          eq(observationReportCounts.reportId, id),
          or(
            eq(observationReportCounts.declared, false),
            ne(observationReportCounts.total, observationReportCounts.actual),
          ),
        ),
      )
      .limit(1)
      .get()
    if (mismatch)
      throw new Error('Complete original report group population differs from its sealed count')
    const counts = await tx
      .select({ section: observationReportCounts.section, total: observationReportCounts.total })
      .from(observationReportCounts)
      .where(and(eq(observationReportCounts.reportId, id), eq(observationReportCounts.parent, '')))
      .all()
    const summaryCounts = Object.fromEntries(counts.map((count) => [count.section, count.total]))
    const hasCostEvidence =
      'recordedCost' in manifest.summary.metrics || 'costCoverage' in manifest.summary.metrics
    if (hasCostEvidence && !qualifiedCostEvidence(manifest.summary.metrics))
      throw new Error('Original recorded summary cost is not qualified')
    if (
      'recordedUsage' in manifest.summary ||
      (manifest.summary.metrics.state === 'not-ready' &&
        (hasCostEvidence ||
          'tokenCoverage' in manifest.summary.metrics ||
          'recordedUsage' in manifest.summary.metrics))
    )
      completeReportFactSummary(manifest.summary)
    if (manifest.summary.metrics.state === 'not-ready') {
      const unexpected = await tx
        .select({ section: observationReportCounts.section })
        .from(observationReportCounts)
        .where(
          and(
            eq(observationReportCounts.reportId, id),
            notInArray(observationReportCounts.section, [...COMPLETE_OBSERVATION_FACT_SECTIONS]),
          ),
        )
        .limit(1)
        .get()
      if (
        unexpected ||
        'numericRecords' in manifest.summary.inventory ||
        'nativeCaptures' in manifest.summary.inventory
      )
        throw new Error(
          'Incomplete original report cannot publish numeric collections or subtotals',
        )
    }
    if ((summaryCounts['tasks'] ?? '0') !== manifest.summary.inventory.tasks)
      throw new Error('Complete original Task EOF count changed')
    const coverage = manifest.summary.usageCoverage
    if (
      coverage &&
      (!Object.values(coverage).every(
        (value) => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value),
      ) ||
        BigInt(coverage.readyTasks) +
          BigInt(coverage.missingTasks) +
          BigInt(coverage.notApplicableTasks) !==
          BigInt(manifest.summary.inventory.tasks))
    )
      throw new Error('Original Task usage coverage differs from the complete Task population')
    await assertCompleteReportPopulation(
      tx,
      report.request.actor,
      id,
      manifest.summary.inventory.tasks,
    )
    const summary = manifest.summary
    let published: CompleteObservationReport
    if (summary.metrics.state === 'not-ready') {
      published = {
        state: 'not-ready',
        reportId: id,
        gaps: summary.metrics.gaps,
        facts: {
          header: manifest.header,
          summary: { ...summary, metrics: summary.metrics },
          counts: summaryCounts,
        },
      }
    } else {
      if (!('numericRecords' in summary.inventory) || !('nativeCaptures' in summary.inventory))
        throw new Error('Original numeric report inventory is missing')
      published = {
        state: 'ready',
        header: manifest.header,
        summary: {
          ...summary,
          inventory: {
            tasks: summary.inventory.tasks,
            attempts: summary.inventory.attempts,
            invocations: summary.inventory.invocations,
            numericRecords: summary.inventory.numericRecords,
            nativeCaptures: summary.inventory.nativeCaptures,
          },
        },
        counts: summaryCounts,
      }
    }
    await tx
      .delete(observationReportRetainedRevisions)
      .where(eq(observationReportRetainedRevisions.reportId, id))
      .run()
    if (
      affectedRows(
        await tx
          .update(observationReports)
          .set({
            state: published.state,
            report: JSON.stringify(published),
            manifest: JSON.stringify(manifest),
            updatedAt: now(),
          })
          .where(
            and(
              eq(observationReports.id, id),
              eq(observationReports.owner, owner),
              eq(observationReports.state, 'building'),
              eq(observationReports.generation, generation),
            ),
          )
          .run(),
      ) !== 1
    )
      throw new Error('Complete original report publication CAS changed')
  })
}
