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
import {
  CompleteObservationExecution,
  type CompleteObservationHostSelection,
  type ObservationExecutionLifecycle,
} from './completeObservationExecution'
import type { CompleteObservationReportCache } from '../ports/completeObservationReportCache'
import type {
  CompleteObservationBuildResult,
  CompleteObservationReportRequest,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
  CompleteObservationTransferPage,
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
  readonly closeBuild?: () => Promise<void>
  readonly execution?: CompleteObservationHostSelection
  /** Optional diagnostics observe the main job; they never replace original work. */
  readonly observePhase?: (
    report: CompleteObservationStoredReport,
  ) => ((phase: string) => void) | undefined
}) {
  if (
    input.execution &&
    (input.execution.mode !== 'host' || typeof input.execution.deferUnissued !== 'function')
  )
    throw new Error('observation-report-host-selection-incomplete')
  const execution = input.execution ? new CompleteObservationExecution() : undefined
  type Frame = ReturnType<CompleteObservationExecution['admit']>
  const settle = (frame: Frame | undefined, write: () => Promise<void>) =>
    frame ? execution!.settle(frame, write) : write()
  const defer = (report: CompleteObservationStoredReport, frame: Frame) =>
    settle(frame, () => input.execution!.deferUnissued(report))
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
  async function run(report: CompleteObservationStoredReport, frame?: Frame) {
    let returningUnissued = false
    const returnUnissued = () => {
      returningUnissued = true
      return defer(report, frame!)
    }
    let observer: ((phase: string) => void) | undefined
    try {
      observer = input.observePhase?.(report)
    } catch {
      // A diagnostic factory failure leaves the complete original report path intact.
    }
    const mark = (phase: string) => {
      try {
        observer?.(phase)
      } catch {
        // Only diagnostics are inside this catch; original operations remain below.
      }
    }
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
      mark('main-job-started')
      stop.signal.throwIfAborted()
      if (frame && !execution!.accepting(frame)) {
        await returnUnissued()
        return
      }
      await input.store.assertReadable(report.request.actor, report)
      if (frame && !execution!.accepting(frame)) {
        await returnUnissued()
        return
      }
      await input.store.phase(report.id, report.owner, 'collecting')
      mark('main-inputs-qualified')
      if (frame && !execution!.accepting(frame)) {
        await returnUnissued()
        return
      }
      if (input.heartbeatDuringRead) heartbeat()
      const result = await input.build(report, job.signal)
      mark('main-build-returned')
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
      mark('main-transfer-opened')
      let pages: CompleteObservationTransferPage[] = []
      for await (const page of input.spool.pages(manifest, job.signal)) {
        pages.push(page)
        if (pages.length === 8) {
          mark('main-stage-started')
          await input.store.stageBatch(report.id, report.owner, pages)
          mark('main-stage-finished')
          pages = []
        }
      }
      if (pages.length) {
        mark('main-stage-started')
        await input.store.stageBatch(report.id, report.owner, pages)
        mark('main-stage-finished')
      }
      mark('main-transfer-staged')
      await input.store.assertReadable(report.request.actor, report)
      mark('main-publish-qualified')
      await input.store.publish(report.id, report.owner, manifest)
      mark('main-published')
    } catch (error) {
      if (returningUnissued) throw error
      await settle(frame, () =>
        input.store.fail(
          report.id,
          report.owner,
          error instanceof Error ? error.message : String(error),
        ),
      )
    } finally {
      keepAlive = false
      job.abort(new Error('Original report job finished'))
      if (timer !== undefined) clearTimeout(timer)
      await pulse
      stop.signal.removeEventListener('abort', abort)
      await settle(frame, () => input.spool.remove(report.id, report.owner))
      mark('main-job-finished')
    }
  }
  function schedule(report: CompleteObservationStoredReport, frame?: Frame) {
    if (
      stop.signal.aborted ||
      report.report.state !== 'building' ||
      jobs.has(report.id) ||
      !report.owner.startsWith(input.owner + '/')
    )
      return
    const predecessor = tail
    const job = frame
      ? execution!.track(frame, () => predecessor.then(() => run(report, frame)))
      : tail.then(() => run(report))
    jobs.set(report.id, job)
    tail = job.catch(() => {})
    void job.finally(() => jobs.delete(report.id)).catch(() => {})
  }
  async function claim(report: CompleteObservationStoredReport, frame?: Frame) {
    if (frame && !execution!.accepting(frame)) return report
    if (stop.signal.aborted)
      throw new CompleteObservationError('not-ready', 'Report worker is stopping')
    if (report.report.state !== 'building' && report.report.state !== 'failed') return report
    if (jobs.has(report.id)) return report
    const owner = input.owner + '/' + input.newId()
    try {
      return await input.store.claim(report.id, owner)
    } catch (error) {
      // The claim may have committed before its ACK failed. Only return that
      // exact candidate owner; never retry claim/build during drain.
      if (frame) await defer({ ...report, owner }, frame)
      throw error
    }
  }
  async function request(
    actor: Actor,
    query: ObservationOverviewQuery,
    refreshKey: string,
    taskId?: string,
    frame?: Frame,
  ): Promise<CompleteObservationReport> {
    if (frame && !execution!.accepting(frame)) throw execution!.unavailable()
    if (stop.signal.aborted)
      throw new CompleteObservationError('not-ready', 'Report worker is stopping')
    const parsed = CompleteObservationReportQuerySchema.parse(query)
    if (taskId !== undefined && parsed.cohort === 'usage')
      throw new RangeError('Task details show lifecycle usage; omit cohort=usage')
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
          'scope-metrics/13',
          input.store.generation,
          actorScope,
          parsed,
          taskId ?? null,
          refreshKey,
        ]),
      )
    const owner = input.owner + '/' + input.newId(),
      id = input.newId()
    let report: CompleteObservationStoredReport = {
      id,
      owner,
      request,
      requestKey,
      actorScope,
      generation: input.store.generation,
      report: { state: 'building', reportId: id, phase: 'queued' },
      manifest: null,
    }
    try {
      report = await input.store.ensure(request, requestKey, actorScope, owner, id)
      await input.store.assertReadable(actor, report)
      report = await claim(report, frame)
      if (!frame || execution!.accepting(frame)) schedule(report, frame)
      return report.report
    } finally {
      if (
        frame &&
        report.report.state === 'building' &&
        report.owner.startsWith(input.owner + '/') &&
        !jobs.has(report.id)
      )
        await defer(report, frame)
    }
  }
  return {
    async request(
      actor: Actor,
      query: ObservationOverviewQuery,
      refreshKey: string,
      taskId?: string,
    ) {
      if (!execution) return request(actor, query, refreshKey, taskId)
      const frame = execution.admit()
      return execution.track(frame, () => request(actor, query, refreshKey, taskId, frame))
    },
    async status(actor: Actor, id: string): Promise<CompleteObservationReport> {
      const original = await readable(actor, id)
      // A read must expose a terminal failure. Only an explicit request retries it.
      if (original.report.state === 'failed') return original.report
      if (execution && !execution.accepting()) return original.report
      const frame = execution?.admit()
      const resume = async () => {
        const report = await claim(original, frame)
        if (frame && !execution!.accepting(frame)) {
          if (report.owner.startsWith(input.owner + '/') && !jobs.has(report.id))
            await defer(report, frame)
        } else schedule(report, frame)
        return report.report
      }
      return frame ? execution!.track(frame, resume) : resume()
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
        if (execution) throw new Error('observation-report-host-lifetime-required')
        if (stop.signal.aborted) stop = new AbortController()
      },
      async drain() {
        await tail
      },
      async stop() {
        stop.abort(new Error('Original report worker stopped'))
        await tail
        await input.closeBuild?.()
      },
    },
    ...(execution
      ? {
          execution: {
            start(lifetime) {
              execution.start(lifetime)
              if (stop.signal.aborted) stop = new AbortController()
            },
            quiesce: execution.quiesce.bind(execution),
            awaitDrained: execution.awaitDrained.bind(execution),
            async pause(lifetime) {
              const wasCurrent = execution.controlCurrent()
              execution.quiesce(lifetime)
              if (wasCurrent) stop.abort(new Error('Original report worker stopped'))
              await execution.awaitDrained(lifetime)
              await input.closeBuild?.()
            },
          } satisfies ObservationExecutionLifecycle,
        }
      : {}),
  }
}
