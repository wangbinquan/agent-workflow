import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { nativeUsageStepMembers } from '@/db/schema'
import { nativeUsageBaselineRead } from '@/platform/persistence/nativeUsageBaselineRead'
import { withNativeUsageBaselineWorker } from '@/platform/background/nativeUsageBaselineWorkerHost'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/composition/nativeUsageInvocation'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import type { NativeUsageBaselineReadView } from '@/modules/task-execution/application/ports/nativeUsageBaseline'
import { describeEachProvider } from './helpers/eachProvider'
import { originalBaselineWorkerFixture } from './helpers/rfc371NativeBaselineWorkerFixture'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describeEachProvider('original baseline Worker and actual provider reservation', (harness) => {
  test('actual PG reads and verifies all 2501 before members once, retaining its snapshot across live deletion', async () => {
    const actual = harness.applicationBinding
    if (actual.provider === 'sqlite') {
      expect(
        nativeUsageBaselineRead({ ...actual, generationId: 'original-memory' }),
      ).toBeUndefined()
      return
    }
    const fixture = await originalBaselineWorkerFixture(2501, harness),
      recording = harness.recordStatements()
    let retained: NativeUsageBaselineReadView | undefined
    try {
      const read = nativeUsageBaselineRead(
        { provider: 'postgresql', runtime: actual.runtime },
        actual.databaseConfig.poolMax,
      )!
      await read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
        expect(view).not.toBeNull()
        retained = view!
        const pages = () =>
          recording.selects().filter((r) => r.sql.includes('native_usage_pass_pages'))
        const counts = () => pages().filter((r) => /\bcount\s*\(\s*\*\s*\)/i.test(r.sql))
        expect(
          pages()
            .filter((r) => !/\bcount\s*\(\s*\*\s*\)/i.test(r.sql))
            .reduce((n, r) => n + r.rows, 0),
        ).toBe(Number(fixture.original.pageCount))
        expect(counts()).toHaveLength(1)
        const queries = pages().length
        await fixture.f.db
          .delete(nativeUsageStepMembers)
          .where(
            and(
              eq(nativeUsageStepMembers.passId, fixture.original.ack.identity.passId),
              eq(nativeUsageStepMembers.stepId, fixture.step(0)),
            ),
          )
        let total = 0
        for (let from = 0; from < 2501; from += 97) {
          const ids = Array.from({ length: Math.min(97, 2501 - from) }, (_, n) =>
            fixture.step(from + n),
          )
          const found = await view!.members([...ids, 'not-original'])
          expect([...found].sort()).toEqual(ids)
          total += found.size
        }
        expect(total).toBe(2501)
        expect(pages()).toHaveLength(queries)
        expect(await view!.members([fixture.step(0)])).toEqual(new Set([fixture.step(0)]))
      })
      await expect(retained!.members([fixture.step(0)])).rejects.toThrow('already closed')
      expect(actual.runtime.telemetry().poolWait.failedCount).toBe(0)
    } finally {
      recording.stop()
      fixture.close()
    }
  }, 120_000)

  test('abort waits for real Worker close and the already started original PG read before returning the reservation', async () => {
    const actual = harness.applicationBinding
    if (actual.provider === 'sqlite') {
      expect(
        nativeUsageBaselineRead({ ...actual, generationId: 'original-memory' }),
      ).toBeUndefined()
      return
    }
    const fixture = await originalBaselineWorkerFixture(17, harness),
      readStarted = deferred(),
      releaseRead = deferred(),
      physicalClose = deferred(),
      stop = new AbortController()
    const OriginalWorker = globalThis.Worker
    class ObservedWorker extends OriginalWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args)
        this.addEventListener('close', () => physicalClose.resolve())
      }
    }
    globalThis.Worker = ObservedWorker
    let completed = false,
      held = false
    try {
      const snapshots = originalReportSnapshotSession({
        provider: 'postgresql',
        runtime: actual.runtime,
      })
      await snapshots.run(async (snapshot) => {
        const source = snapshot.readChannel!
        const channel = {
          ...source,
          values: async (statement: string, parameters: readonly unknown[]) => {
            const rows = await source.values(statement, parameters)
            if (!held) {
              held = true
              readStarted.resolve()
              await releaseRead.promise
            }
            return rows
          },
        }
        const capture = withNativeUsageBaselineWorker(
          {
            source: {
              kind: 'original-channel',
              snapshotId: snapshot.snapshotId,
              generationId: snapshot.generationId,
              asOf: snapshot.asOf,
            },
            binding: fixture.readBinding,
            original: fixture.original,
          },
          stop.signal,
          async () => {
            throw Error('cancelled verification must never enter callback')
          },
          { ...snapshot, readChannel: channel },
        )
        const settled = capture.then(
          () => {
            completed = true
          },
          (error: unknown) => {
            completed = true
            return error
          },
        )
        await readStarted.promise
        stop.abort(Error('actual original baseline cancelled'))
        await physicalClose.promise
        expect(completed).toBe(false)
        releaseRead.resolve()
        expect(await settled).toBeInstanceOf(Error)
        await expect(capture).rejects.toThrow('actual original baseline cancelled')
      })
      expect(completed).toBe(true)
      await snapshots.run(async (snapshot) => {
        expect(await snapshot.readChannel!.values('SELECT 1', [])).toEqual([[1]])
      })
    } finally {
      releaseRead.resolve()
      globalThis.Worker = OriginalWorker
      fixture.close()
    }
  }, 30_000)

  test('actual single-connection PG retains strict per-page before verification without nesting a reserved reader', async () => {
    const fixture = await originalBaselineWorkerFixture(17, harness),
      actual = harness.applicationBinding
    const single =
      actual.provider === 'postgresql'
        ? createPostgresqlDatabaseRuntime({
            config: { ...actual.databaseConfig, poolMax: 1 },
            generationId: actual.runtime.generationId,
          })
        : undefined
    try {
      const db = single ? createPostgresqlDatabaseClient(single) : harness.db
      const binding = single
        ? { provider: 'postgresql' as const, runtime: single }
        : {
            provider: 'sqlite' as const,
            db: actual.provider === 'sqlite' ? actual.db : fixture.ledger!,
            generationId: 'original-memory',
          }
      expect(nativeUsageBaselineRead(binding, 1)).toBeUndefined()
      const persistence = createTaskExecutionPersistence(db),
        context = createTaskExecutionContext({
          intentId: fixture.f.binding.executionContext.intentId,
          token: fixture.f.binding.executionContext.token,
          persistence,
        })
      const owner = runWithTaskExecutionContext(context, () =>
        createNativeUsageInvocationPersistence(db, {
          baselineRead: nativeUsageBaselineRead(binding, 1),
        }).forInvocation(fixture.readBinding),
      )!
      fixture.add(17, 19)
      const ack = await owner.withFinalOwner!(fixture.f.before, (pages) =>
        persistNativeUsagePass(fixture.f.open(fixture.path, fixture.f.identity('final'), 7), pages),
      )
      expect(ack.eof).not.toBeNull()
      expect(ack.nextCursor).toBeNull()
      expect(ack.counts.steps).toBe('19')
      if (single) expect(single.telemetry().poolWait.failedCount).toBe(0)
    } finally {
      await single?.close()
      fixture.close()
    }
  }, 120_000)
})
