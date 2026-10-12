// RFC-371: real snapshots seal every Task numeric row; the hot path must actually
// avoid preparation, preserve original receipts, and recompute current open timing.
// Independent trace snapshots have independent receipt identities; each must
// match its own original source before all other receipt fields are compared.
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  nodeRuns,
  tasks,
  observationCalculationVersions,
  observationCalculationRows,
  observationUsageCurrent,
  observationSourceRevisions,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import {
  completeCalculationSourceProof,
  completeCalculationFactFileSpool,
  importCompleteTaskCalculations,
} from '@/modules/run-observability/composition/completeCalculations'
import type { CompleteCalculationFactItem } from '@/modules/run-observability/ports/completeCalculationFacts'
import { persistentNativeFixture } from './helpers/rfc371PersistentNativeFactFixture'
import {
  collectTaskCalculation,
  publishTaskCalculation,
} from './helpers/rfc371TaskCalculationFixture'
import {
  COMPLETE_NOW,
  completeFixtureId,
  completeTaskRecord,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function fixture() {
  const native = persistentNativeFixture({ steps: 2, depth: 1 })
  cleanups.push(() => native.close())
  return native
}
function numeric(result: Awaited<ReturnType<typeof collectTaskCalculation>>) {
  const {
    summary: { timing: _timing, ...summary },
    sourceReceipts: _receipts,
    trace: _trace,
    ...fields
  } = result.result
  for (const name of [
    'attemptsNamespace',
    'invocationsNamespace',
    'allocationsNamespace',
    'originalNativeAllocationsNamespace',
    'unallocatedQualityNamespace',
    'nativeCapturesNamespace',
    'platformCapturesNamespace',
  ] as const)
    if (fields[name] !== undefined) Reflect.set(fields, name, '<structural-namespace>')
  return { summary, fields }
}

describeEachProvider('RFC-371 sealed Task numerical calculations', (harness) => {
  test('actual hot reuse equals all original rows and exact four buckets/CNY beyond multiple storage and transport packets', async () => {
    await seedCompleteTask(harness, 3, 1003)
    const source = fixture(),
      proof = (await source.observer.sample())!
    const original = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: false,
    })
    const cold = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    expect(numeric(cold)).toEqual(numeric(original))
    expect(cold.groups).toEqual(original.groups)
    expect(cold.statistics).toEqual({ cachedTasks: '0', calculatedTasks: '1', cachedRows: '0' })
    expect(BigInt(cold.manifest!.rows)).toBeGreaterThan(1000n)
    expect(BigInt(cold.manifest!.packets)).toBeGreaterThan(3n)
    const sum = (1003n * 1004n) / 2n
    expect(original.result.summary.metrics).toEqual({
      state: 'ready',
      invocations: '3',
      observedInvocations: '3',
      records: '1003',
      tokens: {
        input: String(sum),
        cacheRead: String(sum * 3n),
        cacheWrite: String(sum * 5n),
        output: String(sum * 7n),
        total: String(sum * 16n),
      },
      cost: { currency: 'CNY', state: 'complete', amount: '25.1753' },
    })
    await publishTaskCalculation(harness, source.home, cold.manifest)
    const before = await completeCalculationSourceProof(harness.db, 'same-generation')
    const hot = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
      forbidNumericRead: true,
    })
    expect(hot.statistics).toEqual({
      cachedTasks: '1',
      calculatedTasks: '0',
      cachedRows: cold.manifest!.rows,
    })
    expect(numeric(hot)).toEqual(numeric(original))
    expect(hot.groups).toEqual(original.groups)
    expect(hot.manifest!.versions).toBe('0')
    expect(hot.result.sourceReceipts.slice(0, -1)).toEqual([...cold.result.sourceReceipts])
    expect(hot.result.sourceReceipts.at(-1)).toMatchObject({
      snapshotId: hot.snapshotId,
      rows: cold.manifest!.rows,
      eof: true,
    })
    expect(hot.result.sourceReceipts.at(-1)!.source).toStartWith(
      'derived-task-calculation-confirmation/',
    )
    expect(await completeCalculationSourceProof(harness.db, 'same-generation')).toEqual(before)
    const durable = await harness.db.select().from(observationCalculationRows).all()
    expect(String(durable.length)).toBe(cold.manifest!.rows)
    expect(hot.groups.allocationsNamespace).toHaveLength(1003)
    expect(
      hot.groups
        .allocationsNamespace!.map(
          (value) => (value as { document: { recordId: string } }).document.recordId,
        )
        .sort(),
    ).toEqual(Array.from({ length: 1003 }, (_, n) => completeFixtureId('meter', n)))
  }, 120_000)

  test('the same numerical version recomputes running Task and attempt intervals for every new asOf', async () => {
    await seedCompleteTask(harness, 2, 3)
    await harness.db
      .update(tasks)
      .set({ status: 'running', finishedAt: null, runningMs: 0, runningSince: COMPLETE_NOW })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    await harness.db
      .update(nodeRuns)
      .set({ status: 'running', finishedAt: null })
      .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
      .run()
    const source = fixture(),
      proof = (await source.observer.sample())!
    const cold = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
      asOf: COMPLETE_NOW + 1000,
    })
    await publishTaskCalculation(harness, source.home, cold.manifest)
    const hot = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
      forbidNumericRead: true,
      asOf: COMPLETE_NOW + 9000,
    })
    expect(hot.statistics!.cachedTasks).toBe('1')
    expect(numeric(hot)).toEqual(numeric(cold))
    expect(cold.result.summary.timing.wallMs).toBe('1000')
    expect(hot.result.summary.timing.wallMs).toBe('9000')
    expect(hot.result.summary.timing.runningMs).toBe('9000')
    expect((cold.groups.attemptsNamespace![0] as { document: unknown }).document).toMatchObject({
      durationMs: '1000',
      open: true,
    })
    expect((hot.groups.attemptsNamespace![0] as { document: unknown }).document).toMatchObject({
      durationMs: '9000',
      open: true,
    })
    expect(hot.result.summary.timing.intervals).toMatchObject({
      state: 'complete',
      cumulativeMs: '9010',
      activeUnionMs: '9000',
    })
  })

  for (const damage of ['header-json', 'row-json', 'missing-row', 'extra-namespace'] as const) {
    test(`the ${damage} cache falls back to complete original calculation without partial restoration`, async () => {
      await seedCompleteTask(harness, 2, 7)
      const source = fixture(),
        proof = (await source.observer.sample())!
      const cold = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
      await publishTaskCalculation(harness, source.home, cold.manifest)
      const [version] = await harness.db.select().from(observationCalculationVersions).all()
      if (!version) throw new Error('Real sealed calculation missing')
      if (damage === 'header-json')
        await harness.db
          .update(observationCalculationVersions)
          .set({ document: '{bad' })
          .where(eq(observationCalculationVersions.cacheKey, version.cacheKey))
          .run()
      else if (damage === 'extra-namespace')
        await harness.db
          .insert(observationCalculationRows)
          .values({
            cacheKey: version.cacheKey,
            namespace: '/zzz-extra',
            key: 'unexpected',
            document: '{}',
          })
          .run()
      else {
        const row = (await harness.db.select().from(observationCalculationRows).all())[0]!
        if (damage === 'missing-row')
          await harness.db
            .delete(observationCalculationRows)
            .where(eq(observationCalculationRows.key, row.key))
            .run()
        else
          await harness.db
            .update(observationCalculationRows)
            .set({ document: '{bad' })
            .where(eq(observationCalculationRows.key, row.key))
            .run()
      }
      const recovered = await collectTaskCalculation(harness, {
        home: source.home,
        proof,
        cache: true,
      })
      expect(recovered.statistics!.cachedTasks).toBe('0')
      expect(recovered.statistics!.calculatedTasks).toBe('1')
      expect(numeric(recovered)).toEqual(numeric(cold))
      expect(recovered.groups).toEqual(cold.groups)
      expect(
        recovered.result.sourceReceipts.some((receipt) =>
          receipt.source.startsWith('derived-task-calculation-confirmation/'),
        ),
      ).toBe(false)
    })
  }

  test('same-ID revision and deletion invalidate the version; known partial buckets/CNY and the gap remain exact', async () => {
    await seedCompleteTask(harness, 2, 5)
    const source = fixture(),
      proof = (await source.observer.sample())!
    const cold = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    await publishTaskCalculation(harness, source.home, cold.manifest)
    const original = completeTaskRecord(4, 2),
      id = sha256Hex(
        JSON.stringify([
          original.sourceId,
          original.measurement.invocationId,
          original.measurement.recordId,
        ]),
      )
    await harness.db.delete(observationUsageCurrent).where(eq(observationUsageCurrent.id, id)).run()
    const missing = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    expect(missing.statistics!.cachedTasks).toBe('0')
    expect(missing.result.summary.metrics).toMatchObject({
      state: 'not-ready',
      gaps: ['native-capture-records-missing'],
      recordedUsage: {
        tokens: { input: '10', cacheRead: '30', cacheWrite: '50', output: '70', total: '160' },
      },
      recordedCost: { currency: 'CNY', amount: '0.0005' },
    })
    await harness.db
      .insert(observationUsageCurrent)
      .values({
        id,
        taskId: original.measurement.taskId,
        sourceId: original.sourceId,
        document: JSON.stringify(original),
      })
      .run()
    const restored = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
    })
    expect(restored.statistics!.cachedTasks).toBe('0')
    expect(numeric(restored)).toEqual(numeric(cold))
    const changed = {
      ...original,
      measurement: {
        ...original.measurement,
        revision: 2,
        usage: { ...original.measurement.usage!, input: '15' },
      },
      contribution: { ...original.contribution!, input: '15' },
      observedRevision: 2,
    }
    await harness.db
      .update(observationUsageCurrent)
      .set({ document: JSON.stringify(changed) })
      .where(eq(observationUsageCurrent.id, id))
      .run()
    const revised = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    const oracle = await collectTaskCalculation(harness, { home: source.home, proof, cache: false })
    expect(revised.statistics!.cachedTasks).toBe('0')
    expect(numeric(revised)).toEqual(numeric(oracle))
    expect(revised.groups).toEqual(oracle.groups)
  })

  test('an incomplete source vector uses the full original calculation and never publishes an empty cache result', async () => {
    await seedCompleteTask(harness, 2, 3)
    const source = fixture(),
      proof = (await source.observer.sample())!
    const original = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: false,
    })
    await harness.db
      .delete(observationSourceRevisions)
      .where(eq(observationSourceRevisions.sourceId, 'tasks'))
      .run()
    expect(await completeCalculationSourceProof(harness.db, 'original-generation')).toBeNull()
    const result = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    expect(result.manifest).toBeUndefined()
    expect(numeric(result)).toEqual(numeric(original))
    expect(result.groups).toEqual(original.groups)
  })

  test('a valid transport with one altered numeric row rolls back the entire version and retains the prior sealed version', async () => {
    await seedCompleteTask(harness, 2, 7)
    const source = fixture(),
      proof = (await source.observer.sample())!
    const cold = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    await publishTaskCalculation(harness, source.home, cold.manifest)
    const beforeVersions = await harness.db.select().from(observationCalculationVersions).all()
    const beforeRows = await harness.db.select().from(observationCalculationRows).all()
    const spool = completeCalculationFactFileSpool(source.home)
    const entries: CompleteCalculationFactItem[] = []
    for (const packet of spool.pages(cold.manifest!)) entries.push(...structuredClone(packet.items))
    const row = entries.find((item) => item.kind === 'row')!
    if (row.kind !== 'row') throw new Error('Original numerical row missing')
    Object.assign(row, { document: { originalNumericRowWasChanged: true } })
    const broken = await spool.seal({
      reportId: randomUUID(),
      owner: 'altered-derived-version',
      context: cold.manifest!.context,
      items: (async function* () {
        yield* entries
      })(),
    })
    await expect(
      importCompleteTaskCalculations({ db: harness.db, spool, manifest: broken }),
    ).rejects.toThrow('Task calculation group content changed')
    expect(await harness.db.select().from(observationCalculationVersions).all()).toEqual(
      beforeVersions,
    )
    expect(await harness.db.select().from(observationCalculationRows).all()).toEqual(beforeRows)
    const hot = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
      forbidNumericRead: true,
    })
    expect(hot.statistics!.cachedTasks).toBe('1')
    expect(numeric(hot)).toEqual(numeric(cold))
  })

  test('trace requests bypass numeric reuse and run the original span projection', async () => {
    await seedCompleteTask(harness, 2, 3)
    const source = fixture(),
      proof = (await source.observer.sample())!
    const cold = await collectTaskCalculation(harness, { home: source.home, proof, cache: true })
    await publishTaskCalculation(harness, source.home, cold.manifest)
    const trace = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: true,
      trace: true,
    })
    const oracle = await collectTaskCalculation(harness, {
      home: source.home,
      proof,
      cache: false,
      trace: true,
    })
    expect(trace.statistics).toEqual({ cachedTasks: '0', calculatedTasks: '0', cachedRows: '0' })
    expect(trace.result.trace).toBeDefined()
    const projection = (calculation: typeof trace) => {
      const { projection, receipt } = calculation.result.trace!
      expect(receipt).not.toBeNull()
      if (!receipt) throw new Error('Original trace receipt missing')
      expect(receipt.snapshotId).toBe(calculation.snapshotId)
      expect(receipt.source).toBe(
        projection.spansNamespace.slice(0, -'projected-spans'.length) + 'original-spans',
      )
      expect(receipt.eof).toBe(true)
      expect(Reflect.get(projection, 'receipt')).toEqual(receipt)
      return {
        ...projection,
        spansNamespace: '<namespace>',
        capturesNamespace: '<namespace>',
        repairsNamespace: '<namespace>',
        receipt: { ...receipt, source: '<original-source>', snapshotId: '<original-snapshot>' },
      }
    }
    expect(trace.snapshotId).not.toBe(oracle.snapshotId)
    expect(projection(trace)).toEqual(projection(oracle))
    expect(numeric(trace)).toEqual(numeric(oracle))
    expect(trace.groups).toEqual(oracle.groups)
  })
})
