import type { Actor } from '@/auth/actor'
import {
  CompleteObservationPageQuerySchema,
  CompleteObservationReportQuerySchema,
  COMPLETE_OBSERVATION_FACT_SECTIONS,
  completeObservationReportContent,
  type CompleteObservationReport,
  type CompleteObservationReportPage,
  type ObservationOverviewQuery,
} from '@agent-workflow/shared'
import { completeSourceCursor, completeSourcePosition } from '../domain/completeSourceCursor'
import { CompleteObservationError } from '../domain/completeObservationError'
import type { CompleteObservationReportCache } from '../ports/completeObservationReportCache'
import type {
  CompleteObservationBuildResult,
  CompleteObservationReportRequest,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'

/** A page only selects retained output from one completed original report. */
export function completeObservationReportService(input: {
  readonly store: CompleteObservationReportCache
  readonly spool: CompleteObservationSpool
  readonly scopeOf: (actor: Actor) => string
  readonly keyOf: (text: string) => string
  readonly newId: () => string
  readonly owner: string
  readonly heartbeatDuringRead: boolean
  readonly build: (
    report: CompleteObservationStoredReport,
    signal: AbortSignal,
  ) => Promise<CompleteObservationBuildResult>
}) {
  let stop = new AbortController()
  const jobs = new Map<string, Promise<void>>()
  let tail = Promise.resolve()
  async function readable(actor: Actor, id: string) {
    const report = await input.store.get(id)
    if (!report || report.actorScope !== input.scopeOf(actor))
      throw new CompleteObservationError(
        'not-found',
        'Complete observation report is not available',
      )
    if (report.generation !== input.store.generation)
      throw new CompleteObservationError(
        'generation-changed',
        'Original database generation changed; refresh the report',
      )
    await input.store.assertReadable(actor, report)
    return report
  }
  async function run(report: CompleteObservationStoredReport) {
    const job = new AbortController()
    const abort = () => job.abort(stop.signal.reason)
    stop.signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined,
      pulse = Promise.resolve(),
      keepAlive = true
    const heartbeat = () => {
      timer = setTimeout(() => {
        pulse = input.store
          .renew(report.id, report.owner)
          .then((owned) => {
            if (!owned) job.abort(new Error('Original report build lease changed'))
          })
          .catch((error) => job.abort(error))
          .then(() => {
            if (keepAlive && !job.signal.aborted) heartbeat()
          })
      }, 15_000)
      timer.unref?.()
    }
    try {
      stop.signal.throwIfAborted()
      await input.store.assertReadable(report.request.actor, report)
      await input.store.phase(report.id, report.owner, 'collecting')
      if (input.heartbeatDuringRead) heartbeat()
      const result = await input.build(report, job.signal)
      keepAlive = false
      if (timer !== undefined) clearTimeout(timer)
      await pulse
      job.signal.throwIfAborted()
      if (result.state === 'not-ready' && !result.manifest) {
        await input.store.unavailable(report.id, report.owner, result.gaps)
        return
      }
      const manifest = result.manifest
      if (!manifest) throw new Error('Original complete report manifest missing')
      // build has released the one original reader reservation before the first writer operation.
      await input.store.phase(report.id, report.owner, 'publishing')
      for await (const page of input.spool.pages(manifest, job.signal))
        await input.store.stage(report.id, report.owner, page)
      await input.store.assertReadable(report.request.actor, report)
      await input.store.publish(report.id, report.owner, manifest)
    } catch (error) {
      await input.store.fail(
        report.id,
        report.owner,
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      keepAlive = false
      job.abort(new Error('Original report job finished'))
      if (timer !== undefined) clearTimeout(timer)
      await pulse
      stop.signal.removeEventListener('abort', abort)
      await input.spool.remove(report.id, report.owner)
    }
  }
  function schedule(report: CompleteObservationStoredReport) {
    if (
      stop.signal.aborted ||
      report.report.state !== 'building' ||
      jobs.has(report.id) ||
      !report.owner.startsWith(input.owner + '/')
    )
      return
    const job = tail.then(() => run(report))
    jobs.set(report.id, job)
    tail = job.catch(() => {})
    void job.finally(() => jobs.delete(report.id)).catch(() => {})
  }
  async function claim(report: CompleteObservationStoredReport) {
    if (stop.signal.aborted)
      throw new CompleteObservationError('not-ready', 'Report worker is stopping')
    if (report.report.state !== 'building' && report.report.state !== 'failed') return report
    if (jobs.has(report.id)) return report
    return input.store.claim(report.id, input.owner + '/' + input.newId())
  }
  return {
    async request(
      actor: Actor,
      query: ObservationOverviewQuery,
      refreshKey: string,
      taskId?: string,
    ): Promise<CompleteObservationReport> {
      if (stop.signal.aborted)
        throw new CompleteObservationError('not-ready', 'Report worker is stopping')
      const parsed = CompleteObservationReportQuerySchema.parse(query)
      if (!refreshKey || refreshKey.length > 200)
        throw new RangeError('Invalid complete report refresh identity')
      const request: CompleteObservationReportRequest = {
        actor,
        query: parsed,
        refreshKey,
        ...(taskId === undefined ? {} : { taskId }),
      }
      const actorScope = input.scopeOf(actor),
        requestKey = input.keyOf(
          JSON.stringify([
            2,
            'scope-metrics/10',
            input.store.generation,
            actorScope,
            parsed,
            taskId ?? null,
            refreshKey,
          ]),
        )
      const existing = await input.store.ensure(
        request,
        requestKey,
        actorScope,
        input.owner + '/' + input.newId(),
        input.newId(),
      )
      await input.store.assertReadable(actor, existing)
      const report = await claim(existing)
      schedule(report)
      return report.report
    },
    async status(actor: Actor, id: string): Promise<CompleteObservationReport> {
      const original = await readable(actor, id)
      // A read must expose a terminal failure. Only an explicit request retries it.
      if (original.report.state === 'failed') return original.report
      const report = await claim(original)
      schedule(report)
      return report.report
    },
    async page<T>(
      actor: Actor,
      id: string,
      raw: unknown,
    ): Promise<CompleteObservationReportPage<T>> {
      const report = await readable(actor, id)
      const content = completeObservationReportContent(report.report)
      if (!content)
        throw new CompleteObservationError('not-ready', 'Complete original report is not ready')
      const query = CompleteObservationPageQuerySchema.parse(raw),
        parent = query.parent ?? null
      if (
        report.report.state === 'not-ready' &&
        !COMPLETE_OBSERVATION_FACT_SECTIONS.includes(query.section)
      )
        throw new CompleteObservationError(
          'not-ready',
          'Original numeric evidence is incomplete; only sealed execution facts are available',
        )
      const source = JSON.stringify([id, query.section, parent]),
        header = content.header
      const after =
        completeSourcePosition(query.after ?? null, header.snapshotId, source, report.requestKey) ??
        null
      if (after !== null && !/^\d{16}:[1-9]\d*$|^\d{16}:0$/.test(after))
        throw new RangeError('Invalid complete report ordinal')
      const page = await input.store.page<T>(report, {
        section: query.section,
        parent,
        after,
        limit: query.limit,
      })
      return {
        ...page,
        nextCursor:
          page.nextCursor === null
            ? null
            : completeSourceCursor(header.snapshotId, source, report.requestKey, page.nextCursor),
      }
    },
    worker: {
      start() {
        if (stop.signal.aborted) stop = new AbortController()
      },
      async drain() {
        await tail
      },
      async stop() {
        stop.abort(new Error('Original report worker stopped'))
        await tail
      },
    },
  }
}
