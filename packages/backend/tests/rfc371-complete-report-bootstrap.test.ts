// RFC-371: formal bootstraps use full reports, and their real Worker closes before its provider.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Hono, type MiddlewareHandler } from 'hono'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { observationReportBuild } from '@/platform/background/observationReportBuild'
import { composeCompleteObservationReports } from '@/modules/run-observability/composition/completeObservationReports'
import { mountObservationRoutes } from '@/modules/run-observability/composition/observationRoutes'
import { createPausableDaemonRuntimeServiceBindings } from '@/cli/daemonProviderRuntimeHandles'
import type {
  CompleteObservationReport,
  CompleteObservationReportPage,
} from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { originalWorkerFixture } from './helpers/rfc371OriginalWorkerFixture'
import { COMPLETE_NOW } from './helpers/rfc371CompleteTaskFixture'

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
const filters = { from: COMPLETE_NOW, to: COMPLETE_NOW + 60_000, timezone: 'UTC' }
const reportId = (report: CompleteObservationReport) =>
  report.state === 'ready' ? report.header.reportId : report.reportId
const unavailable = async (): Promise<never> => {
  throw new Error('Capped legacy statistical query must not run in a formal full-report root')
}

describeEachProvider('RFC-371 serving report routes and provider lifetime', (harness) => {
  test('formal report routes and legacy statistical aliases read one full original Worker result', async () => {
    const fixture = await originalWorkerFixture(harness)
    const bound = observationReportBuild(fixture.binding, fixture.appHome)
    const reports = composeCompleteObservationReports({
      db: fixture.db,
      generation:
        fixture.binding.provider === 'sqlite'
          ? fixture.binding.generationId
          : fixture.binding.runtime.generationId,
      appHome: fixture.appHome,
      heartbeatDuringRead: bound.heartbeatDuringRead,
      build: (report, _spool, signal) => bound.build(report, signal),
    })
    const app = new Hono()
    const injectActor: MiddlewareHandler = async (c, next) => {
      c.set('actor', actor)
      await next()
    }
    app.use('*', injectActor)
    app.onError(errorHandler)
    mountObservationRoutes(app, {
      reports: reports.queries,
      commands: { save: unavailable },
      queries: { runtimes: unavailable, history: unavailable, priceAtAcceptance: unavailable },
      tasks: { overview: unavailable, list: unavailable, detail: unavailable },
    })
    const bindings = await createPausableDaemonRuntimeServiceBindings({
      runtimeId: 'observation-reports',
      closeParticipantId: 'observation-reports-final-close',
      service: {
        pause: () => reports.worker.stop(),
        resume: async () => reports.worker.start(),
        stop: () => reports.worker.stop(),
      },
    })
    const parameters = new URLSearchParams(
      Object.entries(filters).map(([key, value]): [string, string] => [key, String(value)]),
    )
    const url = '/api/observability/overview?' + parameters
    let handle: Awaited<ReturnType<typeof bindings.runtimeFactory.start>> | undefined
    try {
      expect((await app.request(url)).status).toBe(425)
      handle = await bindings.runtimeFactory.start({
        operationId: 'complete-report-bootstrap-resume',
        provider: fixture.binding.provider,
        generationId:
          fixture.binding.provider === 'sqlite'
            ? fixture.binding.generationId
            : fixture.binding.runtime.generationId,
      })
      const request = await app.request('/api/observability/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters, refreshKey: 'full-alias' }),
      })
      expect(request.status).toBe(200)
      const id = reportId((await request.json()) as CompleteObservationReport)
      await reports.worker.drain()
      for (const path of [
        '/api/observability/reports/' + id,
        url,
        '/api/observability/tasks?' + parameters,
      ]) {
        const response = await app.request(path)
        expect(response.status).toBe(200)
        const report = (await response.json()) as CompleteObservationReport
        expect(report.state).toBe('ready')
        if (report.state !== 'ready') throw new Error(JSON.stringify(report))
        expect(report.header.reportId).toBe(id)
        expect(report.summary.metrics).toEqual({
          state: 'ready',
          invocations: '1',
          observedInvocations: '1',
          records: '2',
          tokens: { input: '3', cacheRead: '9', cacheWrite: '15', output: '21', total: '48' },
          cost: { currency: 'CNY', state: 'complete', amount: '0.00015' },
        })
      }
      const detailUrl = '/api/observability/tasks/complete-original-task?' + parameters
      const detail = (await (await app.request(detailUrl)).json()) as CompleteObservationReport
      await reports.worker.drain()
      const readyDetail = (await (await app.request(detailUrl)).json()) as CompleteObservationReport
      expect(readyDetail.state).toBe('ready')
      expect(reportId(readyDetail)).toBe(reportId(detail))
      const response = await app.request(
        '/api/observability/reports/' + id + '/pages?section=invocations&limit=1',
      )
      const page = (await response.json()) as CompleteObservationReportPage<unknown>
      expect(response.status).toBe(200)
      expect(page.total).toBe('1')
      expect(page.items).toHaveLength(1)
      expect(page.nextCursor).toBeNull()
      expect(
        (await app.request('/api/observability/tasks?' + parameters + '&after=old-cursor')).status,
      ).toBe(422)
      await handle.stop()
      await handle.drain()
      expect((await app.request(url)).status).toBe(425)
    } finally {
      await handle?.stop()
      await handle?.drain()
      await bindings.closeParticipant.close({
        reason: 'daemon-shutdown',
        provider: fixture.binding.provider,
        generationId:
          fixture.binding.provider === 'sqlite'
            ? fixture.binding.generationId
            : fixture.binding.runtime.generationId,
      })
      await fixture.close()
    }
  }, 60000)
})

test('both actual serving roots mount reports and include the worker in pause/drain and final close', () => {
  const start = readFileSync(new URL('../src/cli/start.ts', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  const postgresql = readFileSync(
    new URL('../src/cli/postgresqlDaemonApplication.ts', import.meta.url),
    'utf8',
  )
  expect(start).toContain('completeObservationReports: observationReports.queries')
  expect(server).toContain('reports: deps.completeObservationReports')
  expect(postgresql).toContain("phase.kind === 'daemon' ? { reports: observationReports.queries }")
  expect(start.match(/observationReportBindings\.runtimeFactory/g)).toHaveLength(2)
  expect(start.match(/observationReportBindings\.closeParticipant/g)).toHaveLength(2)
  expect(start).toContain('pause: () => runtime.observationReports.stop()')
  expect(start).toContain('pause: () => observationReports.worker.stop()')
})
