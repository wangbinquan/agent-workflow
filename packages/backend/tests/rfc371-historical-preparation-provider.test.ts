// RFC-371: a different range must use the complete sealed historical population,
// avoid parsing original owners/native artifacts again, and qualify the new range afresh.
import { afterEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  nodeRuns,
  observationCalculationRows,
  observationCalculationVersions,
  agents,
} from '@/db/schema'
import { completeCalculationFactFileSpool } from '@/modules/run-observability/infrastructure/completeCalculationFactSpool'
import { importCompleteTaskCalculations } from '@/modules/run-observability/infrastructure/completeCalculationFactStore'
import { describeEachProvider } from './helpers/eachProvider'
import {
  COMPLETE_NOW,
  completeFixtureId,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { persistentNativeFixture } from './helpers/rfc371PersistentNativeFactFixture'
import { collectHistoricalPreparation } from './helpers/rfc371HistoricalPreparationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }

describeEachProvider('RFC-371 complete persistent historical preparation', (harness) => {
  async function fixture(steps = 7, attempts = 1) {
    await seedCompleteTask(harness, attempts, 0)
    await harness.db
      .update(nodeRuns)
      .set({ runtime: 'opencode', opencodeSessionId: 'root' })
      .where(eq(nodeRuns.id, completeFixtureId('run', 0)))
      .run()
    const native = persistentNativeFixture({ steps, depth: 2 })
    cleanups.push(() => native.close())
    return native
  }
  async function publish(
    native: ReturnType<typeof persistentNativeFixture>,
    cold: Awaited<ReturnType<typeof collectHistoricalPreparation>>,
  ) {
    if (!cold.manifest) throw new Error('Actual preparation manifest missing')
    await importCompleteTaskCalculations({
      db: harness.db,
      spool: completeCalculationFactFileSpool(native.home),
      manifest: cold.manifest,
    })
  }
  test('all 1005 original records and complete candidate groups survive real storage/transport EOF and a different period', async () => {
    const native = await fixture(1003)
    const cold = await collectHistoricalPreparation(harness, { native, query, cache: true })
    expect(cold.records).toHaveLength(1005)
    expect(cold.candidates).toHaveLength(1005)
    expect(cold.candidates.every((group) => group.refs.length > 0)).toBe(true)
    expect(BigInt(cold.manifest!.rows)).toBeGreaterThan(6000n)
    expect(BigInt(cold.manifest!.packets)).toBeGreaterThan(20n)
    await publish(native, cold)
    const hot = await collectHistoricalPreparation(harness, {
      native,
      cache: true,
      forbidOriginalRead: true,
      query: { ...query, from: COMPLETE_NOW + 60_001, to: COMPLETE_NOW + 120_000 },
    })
    expect(hot.usedCache).toBe(true)
    expect(hot.reads).toEqual({ owners: 0, events: 0, parents: 0, native: 0 })
    expect(hot.records).toEqual(cold.records)
    expect(hot.candidates).toEqual(cold.candidates)
    expect(hot.executions).toHaveLength(cold.executions.length)
    expect(cold.executions.every((row) => row.document.scopeMatch === 'matched')).toBe(true)
    expect(hot.executions.every((row) => row.document.scopeMatch === 'excluded')).toBe(true)
    expect(hot.receipts.length).toBe(cold.receipts.length + 1)
    expect(hot.receipts.map((row) => row.document)).toEqual(
      expect.arrayContaining(cold.receipts.map((row) => row.document)),
    )
    expect(hot.manifest!.versions).toBe('0')
    const back = await collectHistoricalPreparation(harness, {
      native,
      query,
      cache: true,
      forbidOriginalRead: true,
    })
    expect(back.executions).toEqual(cold.executions)
    expect(back.records).toEqual(cold.records)
    expect(back.candidates).toEqual(cold.candidates)
  }, 120_000)
  test('unreadable roots retain their gaps and are individually retried while every readable root and owner is reused', async () => {
    const native = await fixture(7, 2)
    await harness.db
      .update(nodeRuns)
      .set({ runtime: 'opencode', opencodeSessionId: 'missing-root' })
      .where(eq(nodeRuns.id, completeFixtureId('run', 1)))
      .run()
    const cold = await collectHistoricalPreparation(harness, { native, query, cache: true })
    expect(cold.manifest!.versions).toBe('1')
    expect(cold.statistics.prepared).toBe(true)
    await publish(native, cold)
    const hot = await collectHistoricalPreparation(harness, {
      native,
      query,
      cache: true,
      forbidOriginalRead: true,
      allowNativeRetry: true,
    })
    expect(hot.usedCache).toBe(true)
    expect(hot.reads).toEqual({ owners: 0, events: 0, parents: 0, native: 1 })
    expect(hot.nativeRoots).toEqual(['missing-root'])
    expect(hot.records).toEqual(cold.records)
    expect(hot.candidates).toEqual(cold.candidates)
    expect(hot.executions).toEqual(cold.executions)
    expect(hot.receipts.map((row) => row.document)).toEqual(
      expect.arrayContaining(cold.receipts.map((row) => row.document)),
    )
    const root = hot.receipts.find(
      (row) => (row.document as { rootSessionId?: string }).rootSessionId === 'missing-root',
    )
    expect(root).toBeDefined()
    expect(root!.document).toMatchObject({ eof: null, issues: ['historical-native-unavailable'] })
  })
  for (const damage of [
    'missing-data',
    'missing-group',
    'row-json',
    'extra-group',
    'header-json',
  ] as const) {
    test(`a ${damage} preparation performs complete original reading instead of publishing partial history`, async () => {
      const native = await fixture()
      const cold = await collectHistoricalPreparation(harness, { native, query, cache: true })
      await publish(native, cold)
      const version = (await harness.db.select().from(observationCalculationVersions).all())[0]!
      const rows = await harness.db
        .select()
        .from(observationCalculationRows)
        .where(eq(observationCalculationRows.cacheKey, version.cacheKey))
        .all()
      const row = rows.find((row) =>
        damage === 'missing-group'
          ? row.namespace === '/@groups'
          : row.namespace === '/native-records',
      )!
      if (damage === 'header-json')
        await harness.db
          .update(observationCalculationVersions)
          .set({ document: '{broken' })
          .where(eq(observationCalculationVersions.cacheKey, version.cacheKey))
          .run()
      else if (damage === 'extra-group')
        await harness.db
          .insert(observationCalculationRows)
          .values({
            cacheKey: version.cacheKey,
            namespace: '/unexpected',
            key: 'extra',
            document: '{}',
          })
          .run()
      else if (damage === 'row-json')
        await harness.db
          .update(observationCalculationRows)
          .set({ document: '{broken' })
          .where(
            and(
              eq(observationCalculationRows.cacheKey, row.cacheKey),
              eq(observationCalculationRows.namespace, row.namespace),
              eq(observationCalculationRows.key, row.key),
            ),
          )
          .run()
      else
        await harness.db
          .delete(observationCalculationRows)
          .where(
            and(
              eq(observationCalculationRows.cacheKey, row.cacheKey),
              eq(observationCalculationRows.namespace, row.namespace),
              eq(observationCalculationRows.key, row.key),
            ),
          )
          .run()
      const fallback = await collectHistoricalPreparation(harness, { native, query, cache: true })
      expect(fallback.usedCache).toBe(false)
      expect(fallback.reads.owners).toBeGreaterThan(0)
      expect(fallback.reads.native).toBeGreaterThan(0)
      expect(fallback.records).toEqual(cold.records)
      expect(fallback.candidates).toEqual(cold.candidates)
      expect(fallback.executions).toEqual(cold.executions)
    })
  }
  for (const change of ['actor', 'business-source', 'native-source'] as const) {
    test(`a changed ${change} proof cannot reuse historical preparation`, async () => {
      const native = await fixture()
      const cold = await collectHistoricalPreparation(harness, { native, query, cache: true })
      await publish(native, cold)
      if (change === 'business-source')
        await harness.db.insert(agents).values({ id: 'source-change', name: 'Source change' }).run()
      if (change === 'native-source')
        native.part('new-original-step', 'root', {
          type: 'step-finish',
          tokens: { input: 41, output: 43, cache: { read: 47, write: 53 } },
        })
      const next = await collectHistoricalPreparation(harness, {
        native,
        query,
        cache: true,
        ...(change === 'actor' ? { actorScope: 'other-historical-preparation-reader' } : {}),
      })
      expect(next.usedCache).toBe(false)
      expect(next.reads.owners).toBeGreaterThan(0)
      expect(next.reads.native).toBeGreaterThan(0)
      expect(next.records.length).toBe(cold.records.length + (change === 'native-source' ? 1 : 0))
    })
  }
})
