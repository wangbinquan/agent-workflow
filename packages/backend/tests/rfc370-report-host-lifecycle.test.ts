// RFC-370: the real report cache/spool keep their original identity and results
// across host loss. Cold status reads must never create a build as a side effect.
import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { observationReports } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeCompleteObservationSnapshot } from '@/modules/run-observability/composition/completeObservationSnapshot'
import { completeObservationReportService } from '@/modules/run-observability/application/completeObservationReportService'
import { completeObservationReportCache } from '@/modules/run-observability/infrastructure/completeObservationReportStore'
import { completeObservationFileSpool } from '@/modules/run-observability/infrastructure/completeObservationFileSpool'
import { completeObservationHostClaims } from '@/modules/run-observability/infrastructure/completeObservationHostClaims'
import { completeObservationActorScope } from '@/modules/run-observability/infrastructure/completeObservationReportDocuments'
import type { CompleteObservationReport } from '@agent-workflow/shared'
import { bindObservationReportsHostOwner } from '../src/cli/daemonHostExecutionOwners'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'
import { deferred, nextTurn } from './helpers/taskHostExecution'

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
const query = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
const reportId = (report: CompleteObservationReport) =>
  report.state === 'ready' ? report.header.reportId : report.reportId
function lifetime(generation: string) {
  let active = true
  const context = {
    generation,
    reference: Object.freeze({}),
    current() {
      expect(this).toBe(context)
      return active
    },
  }
  return {
    context,
    lose: () => {
      active = false
    },
  }
}
async function fixture(harness: ProviderHarness) {
  await seedCompleteTask(harness, 1, 2)
  const binding = harness.applicationBinding
  const source =
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'report-host-generation' }
      : { provider: 'postgresql' as const, runtime: binding.runtime }
  const generation =
    source.provider === 'sqlite' ? source.generationId : source.runtime.generationId
  const store = completeObservationReportCache(
    harness.db,
    generation,
    createCompleteTaskObservationFacts,
  )
  const folder = mkdtempSync(join(tmpdir(), 'aw-report-host-')),
    spool = completeObservationFileSpool(folder)
  const input: Parameters<typeof completeObservationReportService>[0] = {
    store,
    spool,
    owner: randomUUID(),
    heartbeatDuringRead: false,
    scopeOf: completeObservationActorScope,
    keyOf: sha256Hex,
    newId: randomUUID,
    execution: completeObservationHostClaims(harness.db),
    build: (report, signal) =>
      originalReportSnapshotSession(source).run(
        (snapshot) =>
          composeCompleteObservationSnapshot({
            snapshot,
            tasks: createCompleteTaskObservationFacts(snapshot.executor),
            report,
            spool,
            signal,
          }),
        signal,
      ),
  }
  return {
    input,
    store,
    spool,
    generation,
    row: (id: string) =>
      harness.db.select().from(observationReports).where(eq(observationReports.id, id)).get(),
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  }
}

describeEachProvider('RFC-370 original report host lifecycle', (harness) => {
  test('cold status reads stored output without claiming, and cold requests cannot ensure a new report', async () => {
    const f = await fixture(harness),
      service = completeObservationReportService(f.input)
    const original = await f.store.ensure(
      { actor, query, refreshKey: 'cold' },
      'cold-request',
      completeObservationActorScope(actor),
      'old-worker',
      randomUUID(),
    )
    const claim = spyOn(f.store, 'claim'),
      ensure = spyOn(f.store, 'ensure')
    try {
      expect(await service.status(actor, original.id)).toEqual(original.report)
      await expect(service.request(actor, query, 'new')).rejects.toThrow(
        'Report execution is not available',
      )
      expect(() => service.worker.start()).toThrow('host-lifetime-required')
      expect(claim).not.toHaveBeenCalled()
      expect(ensure).not.toHaveBeenCalled()
      expect((await f.row(original.id))?.owner).toBe('old-worker')
    } finally {
      claim.mockRestore()
      ensure.mockRestore()
      f.cleanup()
    }
  })

  test('issued original build is not aborted by loss and drain includes its real published report', async () => {
    const f = await fixture(harness),
      entered = deferred(),
      release = deferred()
    let signal: AbortSignal | undefined,
      calls = 0
    const service = completeObservationReportService({
      ...f.input,
      async build(report, received) {
        calls++
        signal = received
        entered.resolve()
        await release.promise
        return f.input.build(report, received)
      },
    })
    const owner = bindObservationReportsHostOwner(service.execution!),
      g = lifetime(f.generation)
    const handle = await owner.start({
      context: g.context,
      scope: {
        provider: harness.applicationBinding.provider,
        generationId: f.generation,
        operationId: 'report-host',
      },
    })
    try {
      const id = reportId(await service.request(actor, query, 'issued'))
      await entered.promise
      g.lose()
      await owner.quiesceAuthorityLoss({ context: g.context, handle })
      let drained = false
      const pending = Promise.resolve(
        owner.drainAuthorityLoss({ context: g.context, handle }),
      ).then(() => {
        drained = true
      })
      await nextTurn()
      expect(drained).toBe(false)
      expect(signal?.aborted).toBe(false)
      release.resolve()
      await pending
      expect(calls).toBe(1)
      expect((await service.status(actor, id)).state).toBe('ready')
      expect((await service.page(actor, id, { section: 'tasks', limit: 10 })).items).toHaveLength(1)
      expect(owner.group).toBe('observation')
    } finally {
      release.resolve()
      await service.worker.stop()
      f.cleanup()
    }
  })

  test('loss during ensure ACK returns the same unissued claim for the next lifetime', async () => {
    const f = await fixture(harness),
      g = lifetime(f.generation),
      entered = deferred(),
      release = deferred()
    const original = f.store.ensure.bind(f.store)
    const ensure = spyOn(f.store, 'ensure').mockImplementation(async (...args) => {
      const row = await original(...args)
      entered.resolve()
      await release.promise
      return row
    })
    const service = completeObservationReportService(f.input)
    await service.execution!.start(g.context)
    try {
      const request = service.request(actor, query, 'late-ensure')
      await entered.promise
      g.lose()
      await service.execution!.quiesce(g.context)
      release.resolve()
      const id = reportId(await request)
      await service.execution!.awaitDrained(g.context)
      expect(await f.row(id)).toMatchObject({ state: 'building', leaseUntil: 0 })
      ensure.mockRestore()
      const next = lifetime(f.generation)
      await service.execution!.start(next.context)
      expect(reportId(await service.status(actor, id))).toBe(id)
      await service.worker.drain()
      expect((await service.status(actor, id)).state).toBe('ready')
      await service.execution!.quiesce(next.context)
      await service.execution!.awaitDrained(next.context)
    } finally {
      release.resolve()
      ensure.mockRestore()
      await service.worker.stop()
      f.cleanup()
    }
  })

  test('a queued second report is returned without building while the first original result finishes', async () => {
    const f = await fixture(harness),
      g = lifetime(f.generation),
      entered = deferred(),
      release = deferred(),
      built: string[] = []
    const service = completeObservationReportService({
      ...f.input,
      async build(report, signal) {
        built.push(report.id)
        entered.resolve()
        await release.promise
        return f.input.build(report, signal)
      },
    })
    await service.execution!.start(g.context)
    try {
      const first = reportId(await service.request(actor, query, 'first'))
      await entered.promise
      const second = reportId(await service.request(actor, query, 'second'))
      g.lose()
      await service.execution!.quiesce(g.context)
      release.resolve()
      await service.execution!.awaitDrained(g.context)
      expect(built).toEqual([first])
      expect((await f.row(first))?.state).toBe('ready')
      expect(await f.row(second)).toMatchObject({ state: 'building', leaseUntil: 0 })
    } finally {
      release.resolve()
      await service.worker.stop()
      f.cleanup()
    }
  })

  test.each(['failure-receipt', 'spool-cleanup'] as const)(
    'unconfirmed %s prevents drain ACK and retries only original settlement',
    async (held) => {
      const f = await fixture(harness),
        g = lifetime(f.generation)
      let allow = false,
        builds = 0
      const originalFail = f.store.fail.bind(f.store),
        originalRemove = f.spool.remove.bind(f.spool)
      const write =
        held === 'failure-receipt'
          ? spyOn(f.store, 'fail').mockImplementation(async (...args) => {
              await originalFail(...args)
              if (!allow) throw new Error('held-report-settlement')
            })
          : spyOn(f.spool, 'remove').mockImplementation(async (...args) => {
              await originalRemove(...args)
              if (!allow) throw new Error('held-report-settlement')
            })
      const service = completeObservationReportService({
        ...f.input,
        async build() {
          builds++
          throw new Error('original-build-failed')
        },
      })
      await service.execution!.start(g.context)
      try {
        const id = reportId(await service.request(actor, query, 'failed'))
        await service.worker.drain()
        g.lose()
        await service.execution!.quiesce(g.context)
        await expect(service.execution!.awaitDrained(g.context)).rejects.toThrow(
          'held-report-settlement',
        )
        expect(() => service.execution!.start(lifetime(f.generation).context)).toThrow(
          'prior-lifetime-not-drained',
        )
        allow = true
        await service.execution!.awaitDrained(g.context)
        expect(builds).toBe(1)
        expect((await f.store.get(id))?.report).toMatchObject({
          state: 'failed',
          error: 'original-build-failed',
        })
      } finally {
        allow = true
        write.mockRestore()
        await service.worker.stop()
        f.cleanup()
      }
    },
  )

  test('normal pause retains the original abort and failure receipt', async () => {
    const f = await fixture(harness),
      g = lifetime(f.generation),
      entered = deferred()
    let aborted = false,
      closed = 0
    const service = completeObservationReportService({
      ...f.input,
      closeBuild: async () => {
        closed++
      },
      async build(_report, signal) {
        entered.resolve()
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          )
          if (signal.aborted) {
            aborted = true
            resolve()
          }
        })
        signal.throwIfAborted()
        throw new Error('normal pause did not abort')
      },
    })
    await service.execution!.start(g.context)
    try {
      const id = reportId(await service.request(actor, query, 'normal-pause'))
      await entered.promise
      await service.execution!.pause(g.context)
      expect(aborted).toBe(true)
      expect(closed).toBe(1)
      expect((await f.store.get(id))?.report.state).toBe('failed')
    } finally {
      await service.worker.stop()
      f.cleanup()
    }
  })

  test('unissued claim release never changes a later original owner or an issued publishing phase', async () => {
    const f = await fixture(harness),
      claims = completeObservationHostClaims(harness.db)
    try {
      const first = await f.store.ensure(
        { actor, query, refreshKey: 'claims' },
        'claims-key',
        completeObservationActorScope(actor),
        'first-owner',
        randomUUID(),
      )
      await claims.deferUnissued(first)
      const second = await f.store.claim(first.id, 'second-owner')
      await claims.deferUnissued(first)
      expect((await f.row(first.id))?.owner).toBe('second-owner')
      await f.store.phase(second.id, second.owner, 'publishing')
      await expect(claims.deferUnissued(second)).rejects.toThrow('build-already-issued')
      expect((await f.row(first.id))?.owner).toBe('second-owner')
    } finally {
      f.cleanup()
    }
  })
})
