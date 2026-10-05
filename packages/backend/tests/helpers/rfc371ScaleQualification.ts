// RFC-371: full hosted qualification through the original producer and retained page reader.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { openDb } from '@/db/client'
import { observationReportRows } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { ReportSnapshotSession } from '@/platform/persistence/reportSnapshotTypes'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { selectCompleteUsage } from '@/modules/run-observability/application/completeUsageSelection'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { completeSourceCursor } from '@/modules/run-observability/domain/completeSourceCursor'
import type {
  CompleteObservationTask,
  CompleteObservationAllocation,
  CompleteObservationReportPage,
} from '@agent-workflow/shared'
import type { UsageContributionEvidence } from '@/modules/run-observability/domain/usageSelection'
import { COMPLETE_NOW, completeFixtureId } from './rfc371CompleteTaskFixture'
import {
  SCALE_ACTOR_USER,
  SCALE_BUCKETS,
  scaleExpected,
  scalePopulation,
  scaleTaskId,
  scaleSelfTotal,
  seedScaleCorpus,
} from './rfc371ScaleCorpus'

const actor = buildActor({ source: 'session', user: SCALE_ACTOR_USER })
const pico = (value: string) => {
  assert.match(value, /^(0|[1-9]\d*)(\.\d{1,12})?$/)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'))
}
function uniqueBitmap(size: number) {
  const bits = new Uint8Array(Math.ceil(size / 8))
  let seen = 0
  return {
    mark(n: number) {
      assert(
        Number.isSafeInteger(n) && n >= 0 && n < size,
        'Original scale identity outside declared population',
      )
      const mask = 1 << (n % 8),
        position = Math.floor(n / 8)
      assert((bits[position]! & mask) === 0, 'Original scale identity duplicated')
      bits[position] = bits[position]! | mask
      seen++
    },
    finish() {
      assert.equal(seen, size, 'Original scale identities did not reach full EOF')
      return seen
    },
  }
}
const suffix = (id: string, prefix: string) => {
  assert(id.startsWith(prefix + '-'))
  const n = Number(id.slice(prefix.length + 1))
  assert(Number.isSafeInteger(n) && n >= 0)
  assert.equal(id, completeFixtureId(prefix, n))
  return n
}
export function scaleTaskNumber(id: string) {
  const n = id === 'complete-original-task' ? 0 : suffix(id, 'scale-task')
  assert.equal(id, scaleTaskId(n), 'Original scale Task identity is not canonical')
  return n
}
const progress = (phase: string, count?: number) =>
  console.log(JSON.stringify({ phase, ...(count === undefined ? {} : { count }) }))
const percentiles = (samples: number[]) => {
  assert(samples.length > 0)
  const ordered = [...samples].sort((a, b) => a - b)
  return {
    samples: samples.length,
    p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1]!,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
    maxMs: ordered.at(-1)!,
  }
}

export async function qualifyScaleReport(input: {
  db: ProviderNeutralDatabase
  snapshots: ReportSnapshotSession
  generation: string
  directory: string
  taskCount: number
  records: number
  readySamples?: number
  observations?: Record<string, unknown>
}) {
  const perTask = scalePopulation(input.taskCount, input.records),
    expected = scaleExpected(input.records),
    observations = input.observations ?? {}
  const cache = completeObservationReportCache(input.db, input.generation)
  const service = completeObservationReportService({
    store: cache,
    spool: completeObservationFileSpool(input.directory),
    owner: randomUUID(),
    heartbeatDuringRead: false,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    build: (report, signal) =>
      input.snapshots.run(
        (snapshot) =>
          composeCompleteObservationSnapshot({
            snapshot,
            tasks: createCompleteTaskObservationFacts(snapshot.executor),
            report,
            spool: completeObservationFileSpool(input.directory),
            signal,
          }),
        signal,
      ),
  })
  try {
    const start = performance.now(),
      accepted = await service.request(
        actor,
        { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' },
        'synthetic-full-scale',
      )
    const id = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
    await service.worker.drain()
    observations['firstBuildMs'] = performance.now() - start
    const published = await cache.get(id)
    assert(
      published && published.report.state === 'ready',
      'Original full scale report did not become ready: ' + JSON.stringify(published?.report),
    )
    const report = published.report
    assert.deepEqual(report.summary.inventory, {
      tasks: String(input.taskCount),
      attempts: String(input.taskCount),
      invocations: String(input.taskCount),
      numericRecords: String(input.records),
      nativeCaptures: String(input.taskCount),
    })
    assert.equal(report.summary.metrics.state, 'ready')
    if (report.summary.metrics.state !== 'ready')
      throw new Error('Original scale metrics unavailable')
    assert.deepEqual(report.summary.metrics.tokens, expected.tokens)
    assert.equal(report.summary.metrics.cost.currency, 'CNY')
    assert.equal(report.summary.metrics.cost.state, 'complete')
    assert(report.summary.metrics.cost.amount !== null)
    assert.equal(pico(report.summary.metrics.cost.amount), expected.costPico)
    // The real retained ordinal before the final 200 Tasks; no guessed cursor or substituted reader.
    const beforeLast = await input.db
      .select({ ordinal: observationReportRows.ordinal })
      .from(observationReportRows)
      .where(
        and(
          eq(observationReportRows.reportId, id),
          eq(observationReportRows.section, 'tasks'),
          eq(observationReportRows.parent, ''),
        ),
      )
      .orderBy(desc(observationReportRows.ordinal))
      .offset(200)
      .limit(1)
      .get()
    const lastCursor = beforeLast
      ? completeSourceCursor(
          report.header.snapshotId,
          JSON.stringify([id, 'tasks', null]),
          published.requestKey,
          beforeLast.ordinal,
        )
      : undefined
    const latency: Record<string, ReturnType<typeof percentiles>> = {}
    for (const kind of ['status', 'first-page', 'last-page'] as const) {
      const samples: number[] = []
      for (let n = 0; n < (input.readySamples ?? 100); n++) {
        const before = performance.now()
        if (kind === 'status') assert.equal((await service.status(actor, id)).state, 'ready')
        else {
          const page = await service.page<CompleteObservationTask>(actor, id, {
            section: 'tasks',
            limit: 200,
            ...(kind === 'last-page' && lastCursor ? { after: lastCursor } : {}),
          })
          assert.equal(page.total, String(input.taskCount))
          assert(page.items.length > 0)
          if (kind === 'last-page') assert.equal(page.nextCursor, null)
        }
        samples.push(performance.now() - before)
      }
      latency[kind] = percentiles(samples)
    }
    observations['readyLatency'] = latency
    // A failed full target is not allowed to become a successful reduced-population run.
    for (const result of Object.values(latency))
      assert(
        result.p95Ms < 500,
        'Original ready report P95 exceeded 500ms: ' + JSON.stringify(result),
      )
    const taskBits = uniqueBitmap(input.taskCount),
      recordBits = uniqueBitmap(input.records)
    let after: string | null = null,
      taskRows = 0,
      allocationRows = 0
    const verifyStarted = performance.now()
    do {
      const page: CompleteObservationReportPage<CompleteObservationTask> = await service.page(
        actor,
        id,
        { section: 'tasks', limit: 200, ...(after === null ? {} : { after }) },
      )
      assert.equal(page.total, String(input.taskCount))
      for (const row of page.items) {
        taskBits.mark(scaleTaskNumber(row.task.id))
        assert.equal(row.metrics.state, 'ready')
        if (row.metrics.state !== 'ready') throw new Error('Original scale Task metrics missing')
        assert.equal(row.metrics.records, String(perTask))
        assert.deepEqual(row.metrics.tokens, scaleExpected(perTask).tokens)
        assert.equal(row.metrics.cost.currency, 'CNY')
        assert.equal(row.metrics.cost.state, 'complete')
        assert(row.metrics.cost.amount !== null)
        assert.equal(pico(row.metrics.cost.amount), scaleExpected(perTask).costPico)
      }
      taskRows += page.items.length
      assert(page.nextCursor === null || (page.items.length > 0 && page.nextCursor !== after))
      after = page.nextCursor
    } while (after !== null)
    taskBits.finish()
    do {
      const page: CompleteObservationReportPage<CompleteObservationAllocation> = await service.page(
        actor,
        id,
        { section: 'allocations', limit: 200, ...(after === null ? {} : { after }) },
      )
      assert.equal(page.total, String(input.records))
      for (const row of page.items) {
        const n = scaleTaskNumber(row.invocation.taskId),
          meter = suffix(row.recordId, 'meter')
        assert(meter < perTask)
        assert.equal(row.invocation.taskId, scaleTaskId(n))
        assert.equal(row.invocation.invocationId, completeFixtureId('invocation', n))
        assert.equal(row.invocation.nodeRunId, completeFixtureId('run', n))
        assert.equal(row.sourceId, 'complete-native-source')
        assert.deepEqual(row.model, { provider: 'native', id: 'actual' })
        assert.deepEqual(row.contribution, SCALE_BUCKETS)
        assert.equal(row.observedAt, COMPLETE_NOW + meter)
        assert(row.cost.complete && !row.cost.hidden && row.cost.amount !== null)
        assert.equal(pico(row.cost.amount), 50_000_000n)
        recordBits.mark(n * perTask + meter)
      }
      allocationRows += page.items.length
      if (allocationRows % 100000 === 0) progress('verified-allocations', allocationRows)
      assert(page.nextCursor === null || (page.items.length > 0 && page.nextCursor !== after))
      after = page.nextCursor
    } while (after !== null)
    recordBits.finish()
    return {
      reportId: id,
      inventory: report.summary.inventory,
      metrics: report.summary.metrics,
      firstBuildMs: observations['firstBuildMs'],
      readyLatency: latency,
      taskRows,
      allocationRows,
      verifyEofMs: performance.now() - verifyStarted,
    }
  } finally {
    await service.worker.stop()
  }
}

export async function qualifyScaleSelfTotals(snapshots: ReportSnapshotSession, records: number) {
  scalePopulation(1, records)
  const expected = scaleExpected(records),
    started = performance.now()
  return snapshots.run(async (snapshot) => {
    const usage = completeUsageWorkspace<UsageContributionEvidence>({
      rows: snapshot.workspace,
      namespace: 'synthetic-scale-self-total',
      keyOf: sha256Hex,
      identity: (row) => row.measurement.recordId,
    })
    for (let n = 0; n < records; n += 1000) {
      await usage.append(
        Array.from({ length: Math.min(1000, records - n) }, (_, i) => scaleSelfTotal(n + i)),
      )
      if ((n + 1000) % 100000 === 0) progress('self-total-input', Math.min(n + 1000, records))
    }
    usage.seal(String(records))
    progress('self-total-original-selection')
    const selected = await selectCompleteUsage(usage.workspace)
    await usage.flush()
    assert.equal(selected.selected, String(records))
    assert.equal(selected.excluded, '0')
    assert.equal(selected.unavailableSummaries, '0')
    assert.equal(selected.ambiguousOverlaps, '0')
    assert(selected.allSelectedComplete)
    for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
      assert.equal(selected.tokens[bucket], expected.tokens[bucket])
    const bitmap = uniqueBitmap(records)
    for await (const row of completeWorkingTraversal<{
      record: UsageContributionEvidence
      contribution: typeof SCALE_BUCKETS
    }>(snapshot.workspace, usage.allocationsNamespace)) {
      const n = suffix(row.document.record.measurement.recordId, 'self-total')
      assert.deepEqual(row.document.record, scaleSelfTotal(n))
      assert.deepEqual(row.document.contribution, SCALE_BUCKETS)
      bitmap.mark(n)
    }
    return { selected, allocationRows: bitmap.finish(), elapsedMs: performance.now() - started }
  })
}

if (import.meta.main) {
  const mode = process.env.AW_OBSERVABILITY_SCALE_MODE
  assert(mode === 'full-report' || mode === 'self-total', 'Choose an exact full scale scenario')
  assert.match(process.env.AW_OBSERVABILITY_SCALE_SHA ?? '', /^[a-f0-9]{40}$/)
  const directory = resolve(
    process.env.AW_OBSERVABILITY_SCALE_OUTPUT ?? 'test-results/rfc371-scale-' + mode,
  )
  mkdirSync(directory)
  const observations: Record<string, unknown> = {
    syntheticValidationOnly: true,
    supplierInvoice: false,
    mode,
    sourceSha: process.env.AW_OBSERVABILITY_SCALE_SHA,
    taskCount: mode === 'full-report' ? 100000 : 0,
    records: 10000000,
    startedAt: new Date().toISOString(),
  }
  let db: ReturnType<typeof openDb> | undefined
  try {
    db = openDb({
      path: join(directory, 'original.db'),
      migrationsFolder: resolve(import.meta.dir, '../../db/migrations'),
      mmapMib: 0,
      pageCacheMib: 64,
    })
    const generation = 'synthetic-scale-original-file',
      snapshots = originalReportSnapshotSession({
        provider: 'sqlite',
        db,
        generationId: generation,
      })
    if (mode === 'full-report') {
      const before = performance.now()
      observations['originalCounts'] = await seedScaleCorpus({
        db,
        taskCount: 100000,
        records: 10000000,
        progress,
      })
      observations['seedMs'] = performance.now() - before
      db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE); ANALYZE')
      observations['result'] = await qualifyScaleReport({
        db,
        snapshots,
        generation,
        directory,
        taskCount: 100000,
        records: 10000000,
        observations,
      })
    } else observations['result'] = await qualifyScaleSelfTotals(snapshots, 10000000)
    observations['verdict'] = 'PASS'
  } catch (error) {
    observations['verdict'] = 'FAIL'
    observations['error'] = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    db?.$client.close()
    observations['processResourceUsage'] = process.resourceUsage()
    observations['finishedAt'] = new Date().toISOString()
    writeFileSync(
      join(directory, 'qualification.json'),
      JSON.stringify(observations, null, 2) + '\n',
      { flag: 'wx' },
    )
    console.log(JSON.stringify(observations))
  }
}
