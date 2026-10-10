import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  observationReportRows,
  observationReportCounts,
  observationReportPages,
  observationReportReceipts,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import {
  completeReportInitialDigest,
  completeReportTransferPage,
  assertCompleteReportTransferPage,
  assertCompleteReportManifest,
} from '@/modules/run-observability/domain/completeReportEnvelope'
import type {
  CompleteObservationManifest,
  CompleteObservationSpool,
  CompleteObservationTransferItem,
  CompleteObservationTransferPage,
} from '@/modules/run-observability/ports/completeObservationReport'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'
import { describeEachProvider } from './helpers/eachProvider'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'complete-task-reader',
    username: 'complete-task-reader',
    displayName: 'Complete reader',
    role: 'admin',
    status: 'active',
  },
})

// Repack all original, already qualified disk items into smaller valid pages to
// exercise transaction boundaries with a small fixture. No source items change.
function smallerOriginalPages(folder: string, failAtEOF: boolean) {
  const disk = completeObservationFileSpool(folder)
  const pages: CompleteObservationTransferPage[] = []
  let manifest: CompleteObservationManifest | undefined
  let reachedEOF = false
  const spool: CompleteObservationSpool = {
    async seal(input) {
      const original = await disk.seal(input)
      const items: CompleteObservationTransferItem[] = []
      for await (const page of disk.pages(original, input.signal)) items.push(...page.items)
      let digest = completeReportInitialDigest
      const firstSize = items.length % 8 === 0 ? 2 : 1
      for (let index = 0; index < items.length; ) {
        const size = index === 0 ? firstSize : 1
        const page = completeReportTransferPage(
          original.reportId,
          String(pages.length),
          digest,
          items.slice(index, index + size),
          sha256Hex,
        )
        pages.push(page)
        digest = page.digest
        index += size
      }
      manifest = { ...original, pages: String(pages.length), digest }
      return manifest
    },
    async *pages(sealed, signal) {
      if (sealed !== manifest) throw new Error('Original fixture manifest changed')
      const actual = {
        pages: 0n,
        rows: 0n,
        counts: 0n,
        receipts: 0n,
        digest: completeReportInitialDigest,
      }
      for (const page of pages) {
        signal?.throwIfAborted()
        assertCompleteReportTransferPage(
          page,
          sealed.reportId,
          String(actual.pages),
          actual.digest,
          sha256Hex,
        )
        for (const item of page.items) {
          if (item.kind === 'row') actual.rows++
          else if (item.kind === 'count') actual.counts++
          else actual.receipts++
        }
        actual.pages++
        actual.digest = page.digest
        yield page
      }
      if (failAtEOF) throw new Error('Original spool rejected its final EOF')
      assertCompleteReportManifest(actual, sealed)
      reachedEOF = true
    },
    remove: (id, owner) => disk.remove(id, owner),
  }
  return { spool, manifest: () => manifest!, reachedEOF: () => reachedEOF }
}

describeEachProvider('RFC-371 complete report transaction batches', (harness) => {
  for (const failAtEOF of [false, true]) {
    test(
      failAtEOF
        ? 'final EOF failure clears every previously staged batch and publishes no metrics'
        : 'all batches and the nonempty tail retain every original item and classified CNY metrics',
      async () => {
        await seedCompleteTask(harness, 1, 2)
        const binding = harness.applicationBinding
        const source =
          binding.provider === 'sqlite'
            ? { ...binding, generationId: 'original-batched-report-generation' }
            : { provider: 'postgresql' as const, runtime: binding.runtime }
        const cache = completeObservationReportCache(
          harness.db,
          source.provider === 'sqlite' ? source.generationId : source.runtime.generationId,
          createCompleteTaskObservationFacts,
        )
        const folder = mkdtempSync(join(tmpdir(), 'aw-original-report-batch-'))
        const original = smallerOriginalPages(folder, failAtEOF)
        const batchSizes: number[] = []
        let singlePageCalls = 0
        const service = completeObservationReportService({
          store: {
            ...cache,
            async stage(id, owner, page) {
              singlePageCalls++
              return cache.stage(id, owner, page)
            },
            async stageBatch(id, owner, pages) {
              batchSizes.push(pages.length)
              return cache.stageBatch(id, owner, pages)
            },
            async publish(id, owner, manifest) {
              expect(original.reachedEOF()).toBe(true)
              return cache.publish(id, owner, manifest)
            },
          },
          spool: original.spool,
          owner: randomUUID(),
          heartbeatDuringRead: false,
          scopeOf: completeObservationActorScope,
          keyOf: sha256Hex,
          newId: randomUUID,
          build: (report, signal) =>
            originalReportSnapshotSession(source).run(
              (snapshot) =>
                composeCompleteObservationSnapshot({
                  snapshot,
                  tasks: createCompleteTaskObservationFacts(snapshot.executor),
                  report,
                  spool: original.spool,
                  signal,
                }),
              signal,
            ),
        })
        try {
          const accepted = await service.request(
            actor,
            {
              from: COMPLETE_NOW,
              to: COMPLETE_NOW + 60_000,
              timezone: 'UTC',
            },
            'original-batch-EOF',
          )
          const id = accepted.state === 'ready' ? accepted.header.reportId : accepted.reportId
          await service.worker.drain()
          const stored = (await cache.get(id))!
          const manifest = original.manifest()
          expect(Number(manifest.pages)).toBeGreaterThan(8)
          expect(Number(manifest.pages) % 8).toBeGreaterThan(0)
          expect(batchSizes.length).toBeGreaterThan(0)
          expect(singlePageCalls).toBe(0)
          if (failAtEOF) {
            expect(stored.report).toMatchObject({
              state: 'failed',
              error: 'Original spool rejected its final EOF',
            })
            expect(batchSizes.every((size) => size === 8)).toBe(true)
            expect(original.reachedEOF()).toBe(false)
            expect('summary' in stored.report).toBe(false)
          } else {
            expect(stored.report.state).toBe('ready')
            if (stored.report.state !== 'ready')
              throw new Error('Original batched report did not publish')
            expect(stored.report.summary.inventory).toEqual({
              tasks: '1',
              attempts: '1',
              invocations: '1',
              numericRecords: '2',
              nativeCaptures: '1',
            })
            expect(stored.report.summary.metrics).toEqual({
              state: 'ready',
              invocations: '1',
              observedInvocations: '1',
              records: '2',
              tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
              cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
            })
            expect(batchSizes.slice(0, -1).every((size) => size === 8)).toBe(true)
            expect(batchSizes.at(-1)).toBe(Number(manifest.pages) % 8)
            expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(Number(manifest.pages))
          }
          for (const [key, table] of [
            ['rows', observationReportRows],
            ['counts', observationReportCounts],
            ['pages', observationReportPages],
            ['receipts', observationReportReceipts],
          ] as const) {
            const retained = await harness.db
              .select()
              .from(table)
              .where(eq(table.reportId, id))
              .all()
            expect(String(retained.length)).toBe(failAtEOF ? '0' : manifest[key])
          }
        } finally {
          await service.worker.stop()
          rmSync(folder, { recursive: true, force: true })
        }
      },
    )
  }
})
