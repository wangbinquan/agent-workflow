// RFC-371: durable pages retain original identity, four buckets, model, issues and EOF.
// Real two-provider snapshots and transactions must not expose incomplete/corrupt caches.
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  observationNativeFactRoots,
  observationNativeFactPages,
  observationInvocations,
  observationUsageCurrent,
  observationPriceVersions,
} from '@/db/schema'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import {
  historicalNativeFactCollector,
  historicalNativeFactFileSpool,
  importHistoricalNativeFacts,
} from '@/modules/run-observability/composition/historicalNativeFacts'
import { HistoricalNativeFactInvalidation } from '@/modules/run-observability/public/participants'
import { historicalNativeFactRootKey } from '@/modules/run-observability/domain/historicalNativeFacts'
import { completeObservationSpoolDirectory } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import type {
  HistoricalNativeFactTransferItem,
  HistoricalNativeFactManifest,
} from '@/modules/run-observability/ports/historicalNativeFacts'
import type { HistoricalNativeObservationPage } from '@agent-workflow/shared'
import type { HistoricalNativeSourceProof } from '@/modules/runtime-management/public/participants'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  persistentNativeFixture,
  consumeNativeFactReader,
} from './helpers/rfc371PersistentNativeFactFixture'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
function fixture() {
  const source = persistentNativeFixture({ steps: 81, depth: 83 })
  cleanups.push(() => source.close())
  return source
}
function originalSnapshot(harness: ProviderHarness) {
  const binding = harness.applicationBinding
  return originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'persistent-native-original-generation' }
      : { provider: 'postgresql', runtime: binding.runtime },
  )
}
async function seal(
  source: ReturnType<typeof fixture>,
  proof: HistoricalNativeSourceProof,
  items: readonly HistoricalNativeFactTransferItem[],
) {
  async function* all() {
    yield* items
  }
  return historicalNativeFactFileSpool(source.home).seal({
    reportId: randomUUID(),
    owner: 'original-page-owner',
    proof,
    items: all(),
  })
}
async function collect(
  harness: ProviderHarness,
  source: ReturnType<typeof fixture>,
  proof: HistoricalNativeSourceProof,
  roots = ['root', 'empty'],
  forbidOriginalOpen = false,
  referenceId?: string,
) {
  return originalSnapshot(harness).run(async (snapshot) => {
    let opens = 0
    const collector = historicalNativeFactCollector({
      db: snapshot.executor,
      rows: snapshot.workspace,
      namespace: 'native-fact-test-' + randomUUID(),
      proof,
      native: {
        generation: source.query.generation,
        async open(selection) {
          opens++
          if (forbidOriginalOpen) throw new Error('A sealed original cache must actually be used')
          return source.query.open(selection)
        },
      },
    })
    const pages: Record<string, HistoricalNativeObservationPage[]> = {},
      rootCreatedAt: Record<string, number | null> = {},
      items: HistoricalNativeFactTransferItem[] = []
    for (const root of roots) {
      const reader = await collector.open({
        ...source.selection(root),
        ...(referenceId === undefined ? {} : { referenceId }),
      })
      if (!reader) throw new Error('Actual original reader unavailable')
      rootCreatedAt[root] = reader.rootCreatedAt
      pages[root] = await consumeNativeFactReader(reader)
    }
    for await (const item of collector.items()) items.push(item)
    return {
      pages,
      rootCreatedAt,
      items,
      opens,
      statistics: collector.statistics,
      usedCache: collector.usedCache,
      manifest: await seal(source, proof, items),
    }
  })
}
async function publish(
  harness: ProviderHarness,
  source: ReturnType<typeof fixture>,
  manifest: HistoricalNativeFactManifest,
) {
  await importHistoricalNativeFacts({
    db: harness.db,
    spool: historicalNativeFactFileSpool(source.home),
    manifest,
  })
}

describeEachProvider('RFC-371 persistent original native numeric pages', (harness) => {
  test('cold and actual hot pages match every original document beyond multiple bounded packets and deep children', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!
    const oracle: Record<string, HistoricalNativeObservationPage[]> = {}
    for (const root of ['root', 'empty']) {
      const original = await source.query.open(source.selection(root))
      if (!original) throw new Error('Original fixture reader missing')
      oracle[root] = await consumeNativeFactReader(original)
    }
    const cold = await collect(harness, source, proof)
    expect(cold.usedCache).toBe(false)
    expect(cold.opens).toBe(2)
    expect(cold.pages).toEqual(oracle)
    expect(BigInt(cold.manifest.packets)).toBeGreaterThan(2n)
    expect(BigInt(cold.manifest.pages)).toBeGreaterThan(20n)
    expect(cold.pages.root!.at(-1)?.eof?.counts.sessions).toBe('84')
    expect(cold.pages.empty![0]!.steps).toEqual([])
    expect(cold.rootCreatedAt.empty).toBeNull()
    const steps = cold.pages.root!.flatMap((page) => page.steps)
    expect(steps).toHaveLength(83)
    expect(steps.find((step) => step.stepId === 'no-model-or-time')).toMatchObject({
      usage: { input: '9007199254740997', cacheRead: '2', cacheWrite: '3', output: '1' },
      model: null,
      occurredAt: null,
    })
    expect(steps.find((step) => step.stepId === 'zero')?.usage).toEqual({
      input: '0',
      cacheRead: '0',
      cacheWrite: '0',
      output: '0',
    })
    expect(steps.some((step) => step.stepId === 'outside')).toBe(false)
    expect(JSON.stringify(cold.items)).not.toContain('ORIGINAL_CONVERSATION_BODY')
    expect(JSON.stringify(cold.items)).not.toContain('ORIGINAL_TOOL_BODY')
    expect(await source.observer.sample()).toEqual(proof)
    await publish(harness, source, cold.manifest)
    const hot = await collect(harness, source, proof, ['root', 'empty'], true)
    expect(hot.usedCache).toBe(true)
    expect(hot.opens).toBe(0)
    expect(hot.statistics).toEqual({
      cachedRoots: '2',
      cachedPages: cold.manifest.pages,
      sourceRoots: '0',
      sourcePages: '0',
    })
    expect(hot.pages).toEqual(oracle)
    expect(hot.rootCreatedAt).toEqual(cold.rootCreatedAt)
    expect(hot.items).toEqual([])
    const durableRoots = await harness.db.select().from(observationNativeFactRoots).all()
    expect(durableRoots).toHaveLength(2)
    const emptyRoot = durableRoots.find((root) => root.rootSessionId === 'empty')
    if (!emptyRoot) throw new Error('Actual empty original root was not sealed')
    expect(JSON.parse(emptyRoot.document)).toMatchObject({
      identity: { rootSessionId: 'empty' },
      rootCreatedAt: null,
      eof: { counts: { sessions: '1', parts: '0', steps: '0' } },
    })
    expect(await harness.db.select().from(observationNativeFactPages).all()).toHaveLength(
      Number(cold.manifest.pages),
    )
    // Derived numerical transport cannot fabricate accepted usage, prices or invoices.
    expect(await harness.db.select().from(observationInvocations).all()).toEqual([])
    expect(await harness.db.select().from(observationUsageCurrent).all()).toEqual([])
    expect(await harness.db.select().from(observationPriceVersions).all()).toEqual([])
  })

  test('an absent original root retains the original failure and publishes no fabricated empty pages', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!
    await expect(collect(harness, source, proof, ['missing'])).rejects.toThrow(
      'Native root unavailable',
    )
    expect(await harness.db.select().from(observationNativeFactRoots).all()).toEqual([])
    expect(await harness.db.select().from(observationNativeFactPages).all()).toEqual([])
  })

  test('a genuinely absent reasoning counter stays unknown in the uncached, cold and persisted hot pages', async () => {
    const source = fixture()
    // A complete-output fixture must supply reasoning; an actual omission cannot become zero.
    source.part('missing-reasoning-counter', 'root', {
      type: 'step-finish',
      tokens: { input: 7, output: 9, cache: { read: 2, write: 3 } },
    })
    const proof = (await source.observer.sample())!,
      reader = await source.query.open(source.selection())
    if (!reader) throw new Error('Actual original unknown-counter reader missing')
    const original = await consumeNativeFactReader(reader),
      cold = await collect(harness, source, proof, ['root'])
    expect(cold.pages.root).toEqual(original)
    const missing = original
      .flatMap((page) => page.steps)
      .find((step) => step.stepId === 'missing-reasoning-counter')
    expect(missing?.usage).toEqual({ input: '7', output: null, cacheRead: '2', cacheWrite: '3' })
    expect(original.at(-1)?.issues).toContain('native-token-bucket-unknown')
    await publish(harness, source, cold.manifest)
    const hot = await collect(harness, source, proof, ['root'], true)
    expect(hot.usedCache).toBe(true)
    expect(hot.opens).toBe(0)
    expect(hot.pages.root).toEqual(original)
    expect(
      hot.pages.root!.flatMap((page) => page.steps).find((step) => step.stepId === missing!.stepId)
        ?.usage,
    ).toEqual(missing!.usage)
    expect(hot.pages.root!.at(-1)?.issues).toContain('native-token-bucket-unknown')
  })

  test('two original references to one physical root retain their own identity and independently reuse every page', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!
    const references = ['original-reference-a', 'original-reference-b']
    const oracles: Record<string, HistoricalNativeObservationPage[]> = {}
    for (const referenceId of references) {
      const original = await source.query.open({ ...source.selection(), referenceId })
      if (!original) throw new Error('Original shared-root reader unavailable')
      oracles[referenceId] = await consumeNativeFactReader(original)
      const cold = await collect(harness, source, proof, ['root'], false, referenceId)
      expect(cold.pages.root).toEqual(oracles[referenceId])
      await publish(harness, source, cold.manifest)
    }
    expect(await harness.db.select().from(observationNativeFactRoots).all()).toHaveLength(2)
    for (const referenceId of references) {
      const hot = await collect(harness, source, proof, ['root'], true, referenceId)
      expect(hot.opens).toBe(0)
      expect(hot.usedCache).toBe(true)
      expect(hot.pages.root).toEqual(oracles[referenceId])
    }
  })

  test('a changed physical spool packet fails before any derived database population is published', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!,
      cold = await collect(harness, source, proof, ['root'])
    const packetPath = resolve(
      completeObservationSpoolDirectory(source.home, cold.manifest.reportId, cold.manifest.owner),
      'native-facts',
      '0.json',
    )
    const packet = JSON.parse(readFileSync(packetPath, 'utf8'))
    packet.items.pop()
    writeFileSync(packetPath, JSON.stringify(packet))
    await expect(publish(harness, source, cold.manifest)).rejects.toThrow('transfer packet changed')
    expect(await harness.db.select().from(observationNativeFactRoots).all()).toEqual([])
    expect(await harness.db.select().from(observationNativeFactPages).all()).toEqual([])
  })

  test('an explicitly canceled import retains its previously sealed root and every page', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!,
      cold = await collect(harness, source, proof, ['root'])
    await publish(harness, source, cold.manifest)
    const originalRoots = await harness.db
        .select()
        .from(observationNativeFactRoots)
        .orderBy(observationNativeFactRoots.cacheKey)
        .all(),
      originalPages = await harness.db
        .select()
        .from(observationNativeFactPages)
        .orderBy(observationNativeFactPages.cacheKey, observationNativeFactPages.cursor)
        .all(),
      stop = new AbortController()
    stop.abort(new Error('Original numerical import explicitly canceled'))
    await expect(
      importHistoricalNativeFacts({
        db: harness.db,
        spool: historicalNativeFactFileSpool(source.home),
        manifest: cold.manifest,
        signal: stop.signal,
      }),
    ).rejects.toThrow('explicitly canceled')
    expect(
      await harness.db
        .select()
        .from(observationNativeFactRoots)
        .orderBy(observationNativeFactRoots.cacheKey)
        .all(),
    ).toEqual(originalRoots)
    expect(
      await harness.db
        .select()
        .from(observationNativeFactPages)
        .orderBy(observationNativeFactPages.cacheKey, observationNativeFactPages.cursor)
        .all(),
    ).toEqual(originalPages)
  })

  test.each([
    'missing-page',
    'wrong-four-bucket',
    'wrong-identity',
    'wrong-EOF',
    'invalid-json',
  ] as const)(
    'sealed %s is invalidated rather than returned as a partial or empty source',
    async (fault) => {
      const source = fixture(),
        proof = (await source.observer.sample())!,
        cold = await collect(harness, source, proof, ['root'])
      await publish(harness, source, cold.manifest)
      const cacheKey = historicalNativeFactRootKey(proof, source.selection()),
        first = cold.pages.root![0]!
      if (fault === 'missing-page')
        await harness.db
          .delete(observationNativeFactPages)
          .where(eq(observationNativeFactPages.cacheKey, cacheKey))
          .run()
      else if (fault === 'wrong-EOF') {
        const row = await harness.db
          .select()
          .from(observationNativeFactRoots)
          .where(eq(observationNativeFactRoots.cacheKey, cacheKey))
          .get()
        const header = JSON.parse(row!.document)
        header.eof.counts.parts = String(BigInt(header.eof.counts.parts) + 1n)
        await harness.db
          .update(observationNativeFactRoots)
          .set({ document: JSON.stringify(header) })
          .where(eq(observationNativeFactRoots.cacheKey, cacheKey))
          .run()
      } else {
        let page = structuredClone(first)
        if (fault === 'wrong-identity')
          page = { ...page, identity: { ...page.identity, rootSessionId: 'changed-root' } }
        if (fault === 'wrong-four-bucket') {
          const numeric = cold.pages.root!.find((value) => value.steps.length)!
          const changed = {
            ...numeric,
            steps: numeric.steps.map((step, index) =>
              index === 0 ? { ...step, usage: { ...step.usage, cacheWrite: '999' } } : step,
            ),
          }
          await harness.db
            .update(observationNativeFactPages)
            .set({ document: JSON.stringify(changed) })
            .where(eq(observationNativeFactPages.cursor, numeric.cursor))
            .run()
        } else
          await harness.db
            .update(observationNativeFactPages)
            .set({ document: fault === 'invalid-json' ? '{' : JSON.stringify(page) })
            .where(eq(observationNativeFactPages.cursor, first.cursor))
            .run()
      }
      await expect(collect(harness, source, proof, ['root'], true)).rejects.toBeInstanceOf(
        HistoricalNativeFactInvalidation,
      )
    },
  )

  test('a final page without its actual ACK never becomes sealed', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!
    await originalSnapshot(harness).run(async (snapshot) => {
      const collector = historicalNativeFactCollector({
        db: snapshot.executor,
        rows: snapshot.workspace,
        namespace: 'unacked-root',
        proof,
        native: source.query,
      })
      const reader = (await collector.open(source.selection()))!
      let cursor = reader.initialCursor
      while (true) {
        const page = await reader.next(cursor)
        if (page.eof) break
        await reader.acknowledge(page.ordinal, page.payloadDigest)
        cursor = page.nextCursor!
      }
      await reader.close()
      const retained: HistoricalNativeFactTransferItem[] = []
      for await (const item of collector.items()) retained.push(item)
      expect(retained).toEqual([])
    })
    expect(await harness.db.select().from(observationNativeFactRoots).all()).toEqual([])
  })

  test('an original source close failure cannot publish its fully acknowledged numerical pages', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!
    await originalSnapshot(harness).run(async (snapshot) => {
      const collector = historicalNativeFactCollector({
        db: snapshot.executor,
        rows: snapshot.workspace,
        namespace: 'original-reader-close-failure',
        proof,
        native: {
          generation: source.query.generation,
          async open(selection) {
            const original = await source.query.open(selection)
            if (!original) return null
            return {
              identity: original.identity,
              initialCursor: original.initialCursor,
              rootCreatedAt: original.rootCreatedAt,
              next: (cursor) => original.next(cursor),
              acknowledge: (ordinal, digest) => original.acknowledge(ordinal, digest),
              close() {
                original.close()
                throw new Error('Original native reader close acknowledgement failed')
              },
            }
          },
        },
      })
      const reader = (await collector.open(source.selection()))!
      await expect(consumeNativeFactReader(reader)).rejects.toThrow('close acknowledgement failed')
      const sealed: HistoricalNativeFactTransferItem[] = []
      for await (const item of collector.items()) sealed.push(item)
      expect(sealed).toEqual([])
    })
    expect(await harness.db.select().from(observationNativeFactRoots).all()).toEqual([])
    expect(await harness.db.select().from(observationNativeFactPages).all()).toEqual([])
  })

  test('a corrupted numeric packet rolls back that whole root and preserves its previous valid pages', async () => {
    const source = fixture(),
      proof = (await source.observer.sample())!,
      cold = await collect(harness, source, proof, ['root'])
    await publish(harness, source, cold.manifest)
    const readRoots = () =>
        harness.db
          .select()
          .from(observationNativeFactRoots)
          .orderBy(observationNativeFactRoots.cacheKey)
          .all(),
      readPages = () =>
        harness.db
          .select()
          .from(observationNativeFactPages)
          .orderBy(observationNativeFactPages.cacheKey, observationNativeFactPages.cursor)
          .all(),
      beforeRoots = await readRoots(),
      beforePages = await readPages()
    const broken = structuredClone(cold.items),
      final = broken.at(-1)!
    if (final.kind !== 'page') throw new Error('Original final packet page missing')
    broken[broken.length - 1] = {
      ...final,
      page: { ...final.page, payloadDigest: '0'.repeat(64) },
    }
    const manifest = await seal(source, proof, broken)
    await expect(publish(harness, source, manifest)).rejects.toThrow('digest changed')
    expect(await readRoots()).toEqual(beforeRoots)
    expect(await readPages()).toEqual(beforePages)
    const hot = await collect(harness, source, proof, ['root'], true)
    expect(hot.pages).toEqual(cold.pages)
  })

  test.each([
    [
      'same-ID usage',
      "UPDATE part SET data=json_set(data,'$.tokens.input','123456') WHERE id='step-00000'",
    ],
    ['delete', "DELETE FROM part WHERE id='step-00000'"],
    ['reparent', "UPDATE session SET parent_id='unrelated' WHERE id='child-0'"],
    ['DDL', 'ALTER TABLE part ADD COLUMN late_schema_revision TEXT'],
  ] as const)(
    'real external %s causes a cold new proof instead of stale persisted pages',
    async (_name, statement) => {
      const source = fixture(),
        before = (await source.observer.sample())!,
        cold = await collect(harness, source, before, ['root'])
      await publish(harness, source, cold.manifest)
      source.writer.exec(statement)
      const after = (await source.observer.sample())!
      expect(after.revisionToken).not.toBe(before.revisionToken)
      const fresh = await collect(harness, source, after, ['root'])
      expect(fresh.usedCache).toBe(false)
      expect(fresh.opens).toBe(1)
      const original = (await source.query.open(source.selection()))!
      expect(fresh.pages.root).toEqual(await consumeNativeFactReader(original))
      if (_name === 'DDL') expect(fresh.pages.root).toEqual(cold.pages.root)
      else expect(fresh.pages.root).not.toEqual(cold.pages.root)
    },
  )
})
