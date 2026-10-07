import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { nativeUsageStepMembers } from '@/db/schema'
import type { NativeUsageBaselineReadView } from '@/modules/task-execution/application/ports/nativeUsageBaseline'
import { DrizzleNativeUsagePages } from '@/modules/task-execution/infrastructure/drizzleNativeUsagePages'
import { createObservationUsageSource } from '@/modules/task-execution/infrastructure/observationUsageSource'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import { nativeUsageBaselineRead } from '@/platform/persistence/nativeUsageBaselineRead'
import { originalBaselineWorkerFixture } from './helpers/rfc371NativeBaselineWorkerFixture'

test('changed real Worker ready generation or request identity rejects before callback and physically closes', async () => {
  const fixture = await originalBaselineWorkerFixture(17),
    OriginalWorker = globalThis.Worker
  try {
    for (const corruption of ['generation', 'request-id'] as const) {
      let physicalClose = false,
        entered = false
      class AlteredReplyWorker extends OriginalWorker {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args)
          let handler: ((event: MessageEvent) => void) | null = null
          Object.defineProperty(this, 'onmessage', {
            get: () => handler,
            set: (value) => {
              handler = value
            },
          })
          this.addEventListener('close', () => {
            physicalClose = true
          })
          this.addEventListener('message', (event: MessageEvent) => {
            const message = event.data
            const data =
              message.kind === 'reply' && message.result.kind === 'opened'
                ? corruption === 'generation'
                  ? {
                      ...message,
                      result: { ...message.result, generationId: 'changed-original-generation' },
                    }
                  : { ...message, id: 'stale-request' }
                : message
            handler?.(new MessageEvent('message', { data }))
          })
        }
      }
      globalThis.Worker = AlteredReplyWorker
      const read = nativeUsageBaselineRead({
        provider: 'sqlite',
        db: fixture.ledger!,
        generationId: 'actual-file-worker',
      })!
      await expect(
        read.run({ binding: fixture.readBinding, original: fixture.original }, async () => {
          entered = true
        }),
      ).rejects.toThrow(
        corruption === 'generation' ? 'original identity or generation' : 'changed request',
      )
      expect(entered).toBe(false)
      expect(physicalClose).toBe(true)
      globalThis.Worker = OriginalWorker
      await read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
        expect(await view!.members([fixture.step(0), fixture.step(16)])).toEqual(
          new Set([fixture.step(0), fixture.step(16)]),
        )
      })
    }
  } finally {
    globalThis.Worker = OriginalWorker
    fixture.close()
  }
}, 30_000)

test('actual file Worker retains all 2501 original members across live loss and final commits; only the two new four-bin records are emitted', async () => {
  const fixture = await originalBaselineWorkerFixture(),
    { f, original, step } = fixture
  let retained: NativeUsageBaselineReadView | undefined
  try {
    const read = nativeUsageBaselineRead({
      provider: 'sqlite',
      db: fixture.ledger!,
      generationId: 'actual-file-worker',
    })!
    fixture.add(2501, 2503)
    await read.run({ binding: fixture.readBinding, original }, async (view) => {
      expect(view).not.toBeNull()
      retained = view!
      await f.db
        .delete(nativeUsageStepMembers)
        .where(
          and(
            eq(nativeUsageStepMembers.passId, original.ack.identity.passId),
            eq(nativeUsageStepMembers.stepId, step(0)),
          ),
        )
      let count = 0
      for (let from = 0; from < 2501; from += 97) {
        const ids = Array.from({ length: Math.min(97, 2501 - from) }, (_, n) => step(from + n))
        const members = await view!.members([...ids, 'not-an-original-member'])
        expect([...members].sort()).toEqual(ids)
        count += members.size
      }
      expect(count).toBe(2501)
      const pages = new DrizzleNativeUsagePages(f.db, true, view)
      await persistNativeUsagePass(f.open(fixture.path, f.identity('final'), 47), {
        admit: (identity, initialCursor, rootCreatedAt) =>
          pages.admit({
            binding: f.binding,
            identity,
            initialCursor,
            rootCreatedAt,
            beforeSpawnReceiptId: f.before.ownerReceiptId,
          }),
        persist: (page) =>
          pages.persist({
            binding: f.binding,
            page: {
              ...page,
              sessions: [...page.sessions],
              steps: [...page.steps],
              issues: [...page.issues],
            },
          }),
        interrupt: (identity, reason) => pages.interrupt({ binding: f.binding, identity, reason }),
      })
      expect(await view!.members([step(0)])).toEqual(new Set([step(0)]))
    })
    await expect(retained!.members([step(0)])).rejects.toThrow('already closed')
    const ledger = createUsageLedgerStore(f.db),
      project = createUsageSourceProjection({
        source: createObservationUsageSource(f.db),
        store: ledger,
        invocations: createObservationInvocationStore(f.db),
      })
    while (await project(f.binding.nodeRunId)) {
      /* Original source EOF. */
    }
    const records = await ledger.records(f.binding.taskId, { limit: 10 })
    expect(records.nextCursor).toBeUndefined()
    expect(
      [...records.items]
        .sort((a, b) => a.measurement.recordId.localeCompare(b.measurement.recordId))
        .map((r) => ({ id: r.measurement.recordId, bins: r.contribution })),
    ).toEqual([
      {
        id: 'opencode:step:' + step(2501),
        bins: { input: '2502', output: '5', cacheRead: '7', cacheWrite: '11' },
      },
      {
        id: 'opencode:step:' + step(2502),
        bins: { input: '2503', output: '5', cacheRead: '7', cacheWrite: '11' },
      },
    ])
  } finally {
    fixture.close()
  }
}, 120_000)

test('actual Worker rejects a broken original baseline before callback and recovers after the original row is restored', async () => {
  const fixture = await originalBaselineWorkerFixture(17),
    { f, original, step } = fixture
  try {
    const condition = and(
      eq(nativeUsageStepMembers.passId, original.ack.identity.passId),
      eq(nativeUsageStepMembers.stepId, step(0)),
    )
    const saved = (await f.db.select().from(nativeUsageStepMembers).where(condition))[0]!
    await f.db.delete(nativeUsageStepMembers).where(condition)
    const read = nativeUsageBaselineRead({
      provider: 'sqlite',
      db: fixture.ledger!,
      generationId: 'actual-file-worker',
    })!
    let entered = false
    await expect(
      read.run({ binding: fixture.readBinding, original }, async () => {
        entered = true
      }),
    ).rejects.toThrow('original step member')
    expect(entered).toBe(false)
    await f.db.insert(nativeUsageStepMembers).values(saved)
    await read.run({ binding: fixture.readBinding, original }, async (view) => {
      expect(await view!.members([step(0), step(16), 'not-old'])).toEqual(
        new Set([step(0), step(16)]),
      )
    })
  } finally {
    fixture.close()
  }
}, 30_000)

test('callback failure closes the actual Worker view and the next original snapshot remains usable', async () => {
  const fixture = await originalBaselineWorkerFixture(17)
  let retained: NativeUsageBaselineReadView | undefined
  try {
    const read = nativeUsageBaselineRead({
      provider: 'sqlite',
      db: fixture.ledger!,
      generationId: 'actual-file-worker',
    })!
    await expect(
      read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
        retained = view!
        expect(await view!.members([fixture.step(0)])).toEqual(new Set([fixture.step(0)]))
        throw Error('actual callback failure')
      }),
    ).rejects.toThrow('actual callback failure')
    await expect(retained!.members([fixture.step(0)])).rejects.toThrow('already closed')
    await read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
      expect(await view!.members([fixture.step(16)])).toEqual(new Set([fixture.step(16)]))
    })
  } finally {
    fixture.close()
  }
}, 30_000)

// Locks the post-ready no-pending-request gap: a successful callback cannot erase reader failure.
test('post-ready abort or unexpected real Worker exit rejects after callback and physical close; the next snapshot recovers', async () => {
  const fixture = await originalBaselineWorkerFixture(17),
    OriginalWorker = globalThis.Worker
  try {
    for (const reason of ['abort', 'exit'] as const) {
      const actualWorkers: Worker[] = []
      let physicalClose = false,
        callbackFinished = false
      let opened!: () => void, release!: () => void, exited!: () => void
      const callbackEntered = new Promise<void>((resolve) => {
        opened = resolve
      })
      const callbackBarrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const physicalExit = new Promise<void>((resolve) => {
        exited = resolve
      })
      class ActualTrackedWorker extends OriginalWorker {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args)
          actualWorkers.push(this)
          this.addEventListener('close', () => {
            physicalClose = true
            exited()
          })
        }
      }
      globalThis.Worker = ActualTrackedWorker
      const controller = new AbortController(),
        failure = new Error('actual post-ready abort')
      const read = nativeUsageBaselineRead({
        provider: 'sqlite',
        db: fixture.ledger!,
        generationId: 'actual-file-worker',
      })!
      const operation = read.run(
        { binding: fixture.readBinding, original: fixture.original, signal: controller.signal },
        async (view) => {
          expect(await view!.members([fixture.step(0)])).toEqual(new Set([fixture.step(0)]))
          // The actual member reply was consumed; no request is pending while the callback is held.
          opened()
          await callbackBarrier
          callbackFinished = true
          return 'callback returned successfully'
        },
      )
      await callbackEntered
      if (reason === 'abort') controller.abort(failure)
      else actualWorkers[0]!.terminate()
      await physicalExit
      expect(physicalClose).toBe(true)
      expect(callbackFinished).toBe(false)
      release()
      await expect(operation).rejects.toThrow(
        reason === 'abort' ? 'actual post-ready abort' : 'Native baseline Worker exited',
      )
      if (reason === 'abort') expect(await operation.catch((error) => error)).toBe(failure)
      expect(callbackFinished).toBe(true)
      globalThis.Worker = OriginalWorker
      await read.run({ binding: fixture.readBinding, original: fixture.original }, async (view) => {
        expect(await view!.members([fixture.step(0), fixture.step(16)])).toEqual(
          new Set([fixture.step(0), fixture.step(16)]),
        )
      })
    }
  } finally {
    globalThis.Worker = OriginalWorker
    fixture.close()
  }
}, 30_000)
