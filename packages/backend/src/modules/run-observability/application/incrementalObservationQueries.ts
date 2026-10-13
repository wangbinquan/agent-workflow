import type {
  CompleteHistoricalObservationExecution,
  CompleteObservationInvocation,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import {
  CompleteObservationPageQuerySchema,
  CompleteObservationReportQuerySchema,
  type CompleteObservationDimension,
  type CompleteObservationReport,
  type CompleteObservationReportPage,
  type CompleteObservationReportSummary,
  type CompleteObservationSection,
  type CompleteObservationTask,
  type CompleteObservationTrend,
} from '@agent-workflow/shared'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '../domain/completeObservationMetrics'
import { CompleteObservationError } from '../domain/completeObservationError'
import type {
  IncrementalObservationQuerySource,
  ObservationProjectionView,
} from '../ports/incrementalObservationQueries'
import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import type { CompleteObservationReportQueries } from '../public/queries'
import { incrementalObservationWindow } from './incrementalObservationWindow'
import { incrementalObservationDimensions } from './incrementalObservationDimensions'
import { incrementalObservationSelection } from './incrementalObservationSelection'
import { parseObservationSelection } from '../domain/analysisDimensions'
import { incrementalObservationPopulation } from '../domain/incrementalObservationPopulation'
import { completeIncrementalObservationFold } from '../domain/incrementalObservationFold'
import { incrementalObservationTiming } from './incrementalObservationTiming'
import { incrementalObservationHistoricalScope } from './incrementalObservationHistoricalScope'
import { incrementalObservationWindowRows } from './incrementalObservationWindowRows'

const dimensionSections = ['agents', 'runtimes', 'models', 'purposes', 'sources'] as const
const rowSource = (section: CompleteObservationSection, parent: string | null) =>
  JSON.stringify([section, parent])
/** Only qualified projection rows are read here. This path cannot open a native
 * store, start a Worker, allocate raw usage, or read a producer's numeric facts. */
export function incrementalObservationQueries(input: {
  readonly source: IncrementalObservationQuerySource
  readonly generation: string
  readonly scopeOf: (actor: Actor) => string
  readonly keyOf: (value: string) => string
}): CompleteObservationReportQueries {
  const metadataCache = new Map<string, Promise<QualifiedObservationContribution[]>>()
  let latestMetadata: { revision: string; rows: QualifiedObservationContribution[] } | undefined
  let metadataLoading: Promise<void> = Promise.resolve()
  const builds = new Map<string, Promise<Awaited<ReturnType<typeof build>>>>()
  const detailCache = new Map<string, Promise<QualifiedObservationContribution[]>>()
  const countCache = new Map<string, Promise<Partial<Record<CompleteObservationSection, string>>>>()
  function memo<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>) {
    const existing = cache.get(key)
    if (existing) return existing
    const value = create().catch((error: unknown) => {
      cache.delete(key)
      throw error
    })
    // This only bounds disposable query acceleration. Every report/version and
    // contribution remains durable and an evicted view reads its entire scope.
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    cache.set(key, value)
    return value
  }
  function allowedStandalone(
    actor: Actor,
    row: QualifiedObservationContribution,
    ids: ReadonlySet<string>,
  ) {
    if (actor.permissions.has('tasks:read:all')) return true
    const detail = row.detail.document as {
      readonly visibility?: readonly {
        readonly taskId: string | null
        readonly ownerUserId: string | null
      }[]
    } | null
    const visibility = row.detail.visibility ?? detail?.visibility
    return (
      visibility !== undefined &&
      visibility.length > 0 &&
      visibility.every((entry) =>
        entry.taskId !== null ? ids.has(entry.taskId) : entry.ownerUserId === actor.user.id,
      )
    )
  }
  async function assemble(actor: Actor, view: ObservationProjectionView, retainedViewId = view.id) {
    if (view.generation !== input.generation)
      throw new CompleteObservationError(
        'generation-changed',
        'Original projection generation changed',
      )
    const metadata = await memo(metadataCache, view.version.revision, async () => {
      let result: QualifiedObservationContribution[] = []
      const load = metadataLoading.then(async () => {
        const newer =
          latestMetadata &&
          (view.version.revision.length > latestMetadata.revision.length ||
            (view.version.revision.length === latestMetadata.revision.length &&
              view.version.revision >= latestMetadata.revision))
        if (newer && input.source.metadataChanges) {
          const byKey = new Map(latestMetadata!.rows.map((row) => [row.key, row]))
          let changed = false
          for await (const item of input.source.metadataChanges(
            latestMetadata!.revision,
            view.version,
          )) {
            changed = true
            if (item.row) byKey.set(item.key, item.row)
            else byKey.delete(item.key)
          }
          result = changed ? [...byKey.values()] : latestMetadata!.rows
        } else
          for await (const row of input.source.details({
            version: view.version,
            section: 'tasks',
            parent: null,
          }))
            result.push(row)
        if (!latestMetadata || newer)
          latestMetadata = { revision: view.version.revision, rows: result }
      })
      metadataLoading = load.catch(() => {})
      await load
      return result
    })
    const population = incrementalObservationPopulation(metadata, view.query, view.taskId),
      ids = new Set<string>(),
      visibilityIds = new Set<string>()
    for (let at = 0, all = [...population.originals.keys()]; at < all.length; at += 200)
      for (const id of await input.source.visibleTaskIds(actor, all.slice(at, at + 200))) {
        visibilityIds.add(id)
        if (population.ids.has(id)) ids.add(id)
      }
    if (view.taskId !== undefined && !ids.has(view.taskId))
      throw new CompleteObservationError('not-found', 'Original Task is unavailable')
    // Authorization is checked on every request, including cached pages.
    return memo(
      builds,
      input.keyOf(JSON.stringify([view.id, input.scopeOf(actor), [...visibilityIds].sort()])),
      () => build(actor, view, population, ids, visibilityIds, retainedViewId),
    )
  }
  async function build(
    actor: Actor,
    view: ObservationProjectionView,
    population: ReturnType<typeof incrementalObservationPopulation>,
    ids: Set<string>,
    visibilityIds: Set<string>,
    retainedViewId: string,
  ) {
    const entries: QualifiedObservationContribution[] = []
    let tasks: CompleteObservationTask[] = []
    const aggregates = await input.source.aggregates(
      [...ids].map((id) => 'task/' + id),
      view.version,
    )
    for (const id of ids) {
      const row = population.originals.get(id)!,
        aggregate = aggregates.get('task/' + id)
      if (!aggregate) throw new Error('Projection Task aggregate is unavailable')
      const fold = completeIncrementalObservationFold(aggregate),
        original = row.detail.document as CompleteObservationTask
      const combined = {
        ...fold,
        inventory: {
          tasks: aggregate.counters.tasks,
          attempts: aggregate.counters.attempts,
          numericRecords: aggregate.counters.numericRecords,
          nativeCaptures: aggregate.counters.nativeCaptures,
        },
      }
      entries.push({ ...row, fold: combined })
      tasks.push({
        ...original,
        metrics: completeObservationMetrics(fold),
        ...(row.detail.timingAttempts
          ? {
              timing: await incrementalObservationTiming(
                original.task,
                row.detail.timingAttempts.map((attempt) => ({ task: original.task, attempt })),
                view.version.asOf,
              ),
            }
          : {}),
      })
    }
    let fold = emptyCompleteObservationFold()
    const statuses: Record<string, string> = {},
      coverage = { readyTasks: 0n, missingTasks: 0n, notApplicableTasks: 0n }
    const historicalComponents = new Set<string>()
    if (view.taskId === undefined)
      for await (const row of (input.source.groupedDetails ?? input.source.details)({
        version: view.version,
        section: 'cohort-fold',
        parent: null,
      })) {
        if (
          (row.detail.taskId !== null && ids.has(row.detail.taskId)) ||
          !allowedStandalone(actor, row, visibilityIds)
        )
          continue
        const scoped = incrementalObservationHistoricalScope(row, {
          query: view.query,
          ids,
          originals: population.originals,
        })
        if (
          scoped &&
          (view.query.cohort === 'usage' ||
            scoped.detail.scopes?.length ||
            scoped.detail.cohortAt === null ||
            (scoped.detail.cohortAt >= view.query.from && scoped.detail.cohortAt < view.query.to))
        ) {
          entries.push(scoped)
          historicalComponents.add(row.component)
        }
      }
    const trends = new Map<
      string,
      {
        from: number
        to: number
        tasks: bigint
        fold: ReturnType<typeof emptyCompleteObservationFold>
      }
    >()
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: view.query.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    for (const row of entries) {
      mergeCompleteObservationFold(fold, row.fold)
      const at = row.detail.cohortAt
      if (at === null) continue
      const key = date.format(at),
        day = trends.get(key) ?? {
          from: at,
          to: at + 1,
          tasks: 0n,
          fold: emptyCompleteObservationFold(),
        }
      day.from = Math.min(day.from, at)
      day.to = Math.max(day.to, at + 1)
      if (row.detail.section === 'tasks') day.tasks++
      mergeCompleteObservationFold(day.fold, row.fold)
      trends.set(key, day)
    }
    let window: ReturnType<typeof incrementalObservationWindow> | undefined,
      windowAtoms: QualifiedObservationContribution[] = [],
      windowCaptureCount = 0n
    const selection = parseObservationSelection(view.query.selection)
    if ((view.query.cohort === 'usage' || selection !== null) && view.taskId === undefined) {
      let occurrences: QualifiedObservationContribution[] = []
      const standaloneComponents = new Set(
        entries.filter((row) => row.detail.section === 'cohort-fold').map((row) => row.component),
      )
      if (input.source.windowCells) {
        for await (const row of input.source.windowCells({
          version: view.version,
          taskIds: [...ids],
          components: [...standaloneComponents],
          from: view.query.from,
          to: view.query.to,
          timezone: view.query.timezone,
        }))
          occurrences.push(row)
      } else {
        for (let at = 0, all = [...ids]; at < all.length; at += 200)
          for await (const row of input.source.details({
            version: view.version,
            section: 'time-partitions',
            parent: null,
            taskIds: all.slice(at, at + 200),
          }))
            occurrences.push(row)
        for await (const row of input.source.details({
          version: view.version,
          section: 'time-partitions',
          parent: null,
          standalone: true,
        }))
          if (
            allowedStandalone(actor, row, visibilityIds) &&
            (view.query.cohort === 'usage' || standaloneComponents.has(row.component))
          )
            occurrences.push(row)
      }
      // Every bucket retains its original candidate set. Selecting a Task or
      // status must not turn a shared, unresolved native record into known usage.
      occurrences = occurrences.flatMap((row) => {
        const scoped = incrementalObservationHistoricalScope(row, {
          query: view.query,
          ids,
          originals: population.originals,
        })
        return scoped === null
          ? []
          : [
              {
                ...scoped,
                detail: { ...scoped.detail, cohortAt: row.detail.cohortAt },
              },
            ]
      })
      const captureCounts = new Map<string, string>()
      let invocations = (await records(
          actor,
          view,
          ids,
          'invocations',
          null,
          visibilityIds,
          [],
          population.originals,
          (row) => {
            const call = row.detail.document as CompleteObservationInvocation
            captureCounts.set(call.invocationId, row.fold.inventory?.nativeCaptures ?? '0')
          },
        )) as CompleteObservationInvocation[],
        historical = (await records(
          actor,
          view,
          ids,
          'historical-executions',
          null,
          visibilityIds,
          [...historicalComponents],
          population.originals,
        )) as CompleteHistoricalObservationExecution[]
      if (selection !== null) {
        const qualified = incrementalObservationSelection({
          selection,
          calls: invocations,
          atoms: occurrences,
          historical,
        })
        occurrences = qualified.atoms
        invocations = qualified.calls
        historical = qualified.historical
      }
      window = incrementalObservationWindow({
        query: view.query,
        tasks,
        occurrences,
        invocations,
        historical,
        mode: view.query.cohort === 'usage' ? 'usage' : 'cohort',
      })
      windowAtoms =
        view.query.cohort === 'usage'
          ? occurrences.filter(
              (row) =>
                row.detail.cohortAt === null ||
                (row.detail.cohortAt >= view.query.from && row.detail.cohortAt < view.query.to),
            )
          : occurrences
      if (
        view.query.cohort === 'usage' &&
        selection === null &&
        !input.source.windowCells &&
        !occurrences.some((row) => row.detail.scopes?.length)
      ) {
        const numeric = emptyCompleteObservationFold(),
          fullFrom = Math.ceil(view.query.from / 86400000) * 86400000,
          fullTo = Math.floor(view.query.to / 86400000) * 86400000
        const allowedComponents = [
          ...new Set(
            occurrences.filter((row) => row.detail.taskId === null).map((row) => row.component),
          ),
        ]
        for await (const day of input.source.days({
          version: view.version,
          taskIds: [...ids],
          components: allowedComponents,
          from: view.query.from,
          to: view.query.to,
        }))
          mergeCompleteObservationFold(numeric, completeIncrementalObservationFold(day))
        for (const row of windowAtoms)
          if (
            row.detail.cohortAt !== null &&
            (row.detail.cohortAt < fullFrom || row.detail.cohortAt >= fullTo)
          )
            mergeCompleteObservationFold(numeric, row.fold)
        // DISTINCT call/reference membership and source gaps come from the
        // selected immutable identities. Reused days supply numeric values.
        Object.assign(window.fold, {
          tokens: numeric.tokens,
          bucketRecords: numeric.bucketRecords,
          records: numeric.records,
          costRecords: numeric.costRecords,
          pricedRecords: numeric.pricedRecords,
          partiallyPricedRecords: numeric.partiallyPricedRecords,
          picos: numeric.picos,
          priced: numeric.priced,
          visible: numeric.visible,
          tokenCoverageKnown: numeric.tokenCoverageKnown,
        })
      }
      fold = window.fold
      tasks = window.tasks
      windowCaptureCount = window.invocations.reduce(
        (count, row) => count + BigInt(captureCounts.get(row.invocationId) ?? '0'),
        0n,
      )
    }
    let attempts = 0n,
      numericRecords = 0n,
      captures = 0n,
      wall = 0n,
      running = 0n,
      observedRunning = 0n,
      unknownTime = 0n
    const durations: bigint[] = []
    for (const task of tasks) {
      statuses[task.task.status] = String(BigInt(statuses[task.task.status] ?? '0') + 1n)
      coverage[
        task.metrics.state === 'ready'
          ? 'readyTasks'
          : task.metrics.state === 'not-ready'
            ? 'missingTasks'
            : 'notApplicableTasks'
      ]++
      attempts += BigInt(task.attemptCount)
      if (task.timing.wallMs === null) unknownTime++
      else {
        const duration = BigInt(task.timing.wallMs)
        durations.push(duration)
        wall += duration
      }
      if (task.timing.runningMs !== null) {
        running += BigInt(task.timing.runningMs)
        observedRunning++
      }
    }
    for (const row of entries) {
      numericRecords += BigInt(row.fold.inventory?.numericRecords ?? '0')
      captures += BigInt(row.fold.inventory?.nativeCaptures ?? '0')
    }
    durations.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const percentile = (percent: number) =>
      durations.length ? String(durations[Math.ceil((durations.length * percent) / 100) - 1]) : null
    const timing: CompleteObservationReportSummary['timing'] = {
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      wallMs: String(wall),
      runningMs: observedRunning === BigInt(tasks.length) ? String(running) : null,
      unknown: String(unknownTime),
      ...(observedRunning !== BigInt(tasks.length)
        ? {
            runningCoverage: {
              tasks: String(tasks.length),
              observedTasks: String(observedRunning),
            },
            ...(observedRunning > 0n ? { recordedRunningMs: String(running) } : {}),
          }
        : {}),
    }
    if (!(await input.source.bootstrapComplete(view.version)))
      completeObservationGap(fold, 'source-projection-pending')
    const metrics = completeObservationMetrics(fold)
    tasks.sort((a, b) => b.task.startedAt - a.task.startedAt || b.task.id.localeCompare(a.task.id))
    const sections = new Map<string, unknown[]>()
    sections.set(rowSource('tasks', null), tasks)
    sections.set(
      rowSource('trends', null),
      [...trends]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, value]) =>
            ({
              key,
              from: value.from,
              to: value.to,
              tasks: String(value.tasks),
              metrics: completeObservationMetrics(value.fold),
            }) satisfies CompleteObservationTrend,
        ),
    )
    // Public time partitions exist only for an explicit usage overview. Task
    // views and default/started cohorts retain their full original numeric
    // facts, but never publish the private occurrence acceleration rows.
    if (view.query.cohort !== 'usage' || view.taskId !== undefined) {
      sections.set(rowSource('time-partitions', null), [])
      sections.set(rowSource('time-unassigned', null), [])
    }
    if (window) {
      sections.set(rowSource('trends', null), window.trends)
      sections.set(rowSource('invocations', null), window.invocations)
      sections.set(rowSource('historical-executions', null), window.historical)
      if (window.mode === 'cohort') {
        // Occurrence atoms accelerate cohort metrics internally. The public
        // time-partition rows belong to the explicit usage-window contract.
        sections.set(rowSource('time-partitions', null), [])
        sections.set(rowSource('time-unassigned', null), [])
      } else if (!input.source.windowCells)
        sections.set(rowSource('time-partitions', null), window.timeRows)
      if (!input.source.windowCells)
        sections.set(
          rowSource('time-unassigned', null),
          window.timeRows.filter((row) => row.partition === 'unassigned-time'),
        )
      for (const task of window.tasks)
        sections.set(
          rowSource('invocations', task.task.id),
          window.invocations.filter((invocation) => invocation.taskId === task.task.id),
        )
    }
    const reasons = [
      ...new Set(
        tasks.flatMap((task) => (task.metrics.state === 'not-ready' ? task.metrics.gaps : [])),
      ),
    ].sort()
    sections.set(
      rowSource('quality', null),
      reasons.map((key) => ({
        key,
        taskCount: String(
          tasks.filter(
            (task) => task.metrics.state === 'not-ready' && task.metrics.gaps.includes(key),
          ).length,
        ),
        taskIndexVersion: 1,
      })),
    )
    for (const key of reasons)
      sections.set(
        rowSource('quality-tasks', key),
        tasks.filter(
          (task) => task.metrics.state === 'not-ready' && task.metrics.gaps.includes(key),
        ),
      )
    if (!window)
      for (const section of dimensionSections) {
        const groups = new Map<
          string,
          {
            original: CompleteObservationDimension
            fold: ReturnType<typeof emptyCompleteObservationFold>
            tasks: Set<string>
            members: Map<string, ReturnType<typeof emptyCompleteObservationFold>>
          }
        >()
        const add = (row: QualifiedObservationContribution) => {
          const original = row.detail.document as CompleteObservationDimension,
            group = groups.get(original.key) ?? {
              original,
              fold: emptyCompleteObservationFold(),
              tasks: new Set<string>(),
              members: new Map<string, ReturnType<typeof emptyCompleteObservationFold>>(),
            }
          mergeCompleteObservationFold(group.fold, row.fold)
          if (row.detail.taskId) {
            group.tasks.add(row.detail.taskId)
            const member = group.members.get(row.detail.taskId) ?? emptyCompleteObservationFold()
            mergeCompleteObservationFold(member, row.fold)
            group.members.set(row.detail.taskId, member)
          }
          groups.set(original.key, group)
        }
        for (let at = 0, all = [...ids]; at < all.length; at += 200)
          for await (const row of (input.source.groupedDetails ?? input.source.details)({
            version: view.version,
            section,
            taskIds: all.slice(at, at + 200),
          })) {
            add(row)
          }
        if (view.taskId === undefined)
          for await (const row of (input.source.groupedDetails ?? input.source.details)({
            version: view.version,
            section,
          })) {
            if (
              (row.detail.taskId !== null && ids.has(row.detail.taskId)) ||
              !allowedStandalone(actor, row, visibilityIds)
            )
              continue
            const scoped = incrementalObservationHistoricalScope(row, {
              query: view.query,
              ids,
              originals: population.originals,
            })
            if (
              scoped &&
              (view.query.cohort === 'usage' ||
                scoped.detail.scopes?.length ||
                scoped.detail.cohortAt === null ||
                (scoped.detail.cohortAt >= view.query.from &&
                  scoped.detail.cohortAt < view.query.to))
            )
              add(scoped)
          }
        sections.set(
          rowSource(section, null),
          [...groups.values()].map((group) => ({
            ...group.original,
            metrics: completeObservationMetrics(group.fold),
            taskCount: String(group.tasks.size),
          })),
        )
        for (const group of groups.values())
          sections.set(
            rowSource('dimension-tasks', group.original.key),
            [...group.members].map(([id, fold]) => {
              const task = tasks.find((task) => task.task.id === id)!
              return {
                task: task.task,
                metrics: completeObservationMetrics(fold),
                timing: task.timing,
              }
            }),
          )
      }
    if (window) {
      const dimensions = incrementalObservationDimensions({
        calls: window.invocations,
        historical: window.historical,
        atoms: windowAtoms,
        tasks: new Map(tasks.map((task) => [task.task.id, task.task])),
        keyOf: input.keyOf,
        mode: view.query.cohort === 'usage' ? 'usage' : 'cohort',
      })
      const sectionOf = {
        agent: 'agents',
        runtime: 'runtimes',
        model: 'models',
        purpose: 'purposes',
        source: 'sources',
      } as const
      for (const section of dimensionSections)
        sections.set(
          rowSource(section, null),
          dimensions
            .filter((group) => sectionOf[group.dimension.kind] === section)
            .map((group) => group.dimension),
        )
      for (const group of dimensions)
        sections.set(
          rowSource('dimension-tasks', group.dimension.key),
          group.memberships.flatMap((member) => {
            const task = tasks.find((task) => task.task.id === member.task.id)
            return task ? [{ ...member, timing: task.timing }] : []
          }),
        )
    }
    if (window) captures = windowCaptureCount
    let rootTask =
      view.taskId === undefined
        ? null
        : (tasks.find((task) => task.task.id === view.taskId) ?? null)
    if (rootTask)
      rootTask = {
        ...rootTask,
        metrics,
        attemptCount: String(attempts),
        timing: await incrementalObservationTiming(
          rootTask.task,
          [...ids].flatMap((id) => {
            const row = population.originals.get(id)!,
              task = (row.detail.document as CompleteObservationTask).task
            return (row.detail.timingAttempts ?? []).map((attempt) => ({ task, attempt }))
          }),
          view.version.asOf,
        ),
      }
    const summary: CompleteObservationReportSummary = {
      metrics,
      ...(window && view.query.cohort === 'usage' ? { usageWindow: window.usageWindow } : {}),
      inventory: {
        tasks: String(tasks.length),
        attempts: String(attempts),
        invocations: fold.invocations,
        numericRecords: window ? fold.records : String(numericRecords),
        nativeCaptures: String(captures),
        ...(BigInt(fold.historicalReferences ?? '0')
          ? { historicalReferences: fold.historicalReferences }
          : {}),
      },
      statuses,
      timing,
      rootTask,
      usageCoverage: {
        readyTasks: String(coverage.readyTasks),
        missingTasks: String(coverage.missingTasks),
        notApplicableTasks: String(coverage.notApplicableTasks),
      },
    }
    const standaloneComponents = [
      ...new Set(
        entries.filter((row) => row.detail.section === 'cohort-fold').map((row) => row.component),
      ),
    ]
    const scopeKey = input.keyOf(
      JSON.stringify([
        view.version.revision,
        [...ids].sort(),
        [...historicalComponents, ...standaloneComponents].sort(),
      ]),
    )
    const indexedDetails = (await input.source.indexedDetails?.(view.version)) ?? false
    if (indexedDetails)
      await input.source.retainScope?.(
        scopeKey,
        [...ids],
        [...new Set([...historicalComponents, ...standaloneComponents])],
        retainedViewId,
      )
    return {
      sections,
      summary,
      scopeKey,
      indexedDetails,
      ids,
      visibilityIds,
      fold,
      window,
      originals: population.originals,
      historicalComponents: [...historicalComponents],
      standaloneComponents: [
        ...new Set(
          entries.filter((row) => row.detail.section === 'cohort-fold').map((row) => row.component),
        ),
      ],
    }
  }
  async function records(
    actor: Actor,
    view: ObservationProjectionView,
    ids: ReadonlySet<string>,
    section: CompleteObservationSection,
    parent: string | null,
    visibilityIds = ids,
    components: readonly string[] = [],
    originals: ReadonlyMap<string, QualifiedObservationContribution> = new Map(),
    observe?: (row: QualifiedObservationContribution) => void,
  ) {
    if (parent?.startsWith('["task-tree",')) parent = null
    const rows = await memo(
      detailCache,
      input.keyOf(
        JSON.stringify([view.id, section, parent, [...visibilityIds].sort(), components]),
      ),
      async () => {
        const rows: QualifiedObservationContribution[] = []
        for (let at = 0, all = [...ids]; at < all.length; at += 200)
          for await (const row of input.source.details({
            version: view.version,
            section,
            parent,
            taskIds: all.slice(at, at + 200),
          }))
            rows.push(row)
        if (view.taskId === undefined)
          for await (const row of input.source.details({
            version: view.version,
            section,
            parent,
            standalone: true,
            ...(view.query.cohort === 'usage' ? {} : { from: view.query.from, to: view.query.to }),
          }))
            if (allowedStandalone(actor, row, visibilityIds)) rows.push(row)
        for (let at = 0; at < components.length; at += 200)
          for await (const row of input.source.details({
            version: view.version,
            section,
            parent,
            components: components.slice(at, at + 200),
          }))
            if (
              row.detail.taskId !== null &&
              !ids.has(row.detail.taskId) &&
              allowedStandalone(actor, row, visibilityIds)
            )
              rows.push(row)
        const scoped = rows.flatMap((row) => {
          const value = incrementalObservationHistoricalScope(row, {
            query: view.query,
            ids,
            originals,
            ...(view.taskId ? { taskId: view.taskId } : {}),
          })
          return value ? [value] : []
        })
        const unique = new Map(scoped.map((row) => [row.detail.key, row]))
        return [...unique.values()].sort((a, b) => a.detail.key.localeCompare(b.detail.key))
      },
    )
    for (const row of rows) observe?.(row)
    return rows.map((row) => row.detail.document)
  }
  async function report(
    actor: Actor,
    view: ObservationProjectionView,
  ): Promise<CompleteObservationReport> {
    const build = await assemble(actor, view),
      counts: Partial<Record<CompleteObservationSection, string>> = {}
    for (const [key, rows] of build.sections) {
      const [section, parent] = JSON.parse(key) as [CompleteObservationSection, string | null]
      if (parent === null) counts[section] = String(rows.length)
    }
    // Exact derived row counts; packet sizes affect transfer only. No producer
    // facts or full numerical allocation are repeated for a time-range query.
    const cached = await memo(
      countCache,
      input.keyOf(JSON.stringify([view.id, [...build.visibilityIds].sort()])),
      async () => {
        if (build.indexedDetails && input.source.countGroups) {
          const totals: Partial<Record<CompleteObservationSection, string>> = {},
            windowCalls = new Set(build.window?.invocations.map((call) => call.invocationId) ?? [])
          for await (const group of input.source.countGroups(build.scopeKey, view.version)) {
            const section = group.detail.section
            if (
              section === 'cohort-fold' ||
              group.detail.parent !== null ||
              build.sections.has(rowSource(section, null))
            )
              continue
            if (
              build.window &&
              ['allocations', 'historical-records', 'time-partitions', 'time-unassigned'].includes(
                section,
              )
            )
              continue
            const row = {
              key: group.detail.key,
              component: group.component,
              detail: group.detail,
              aggregates: [],
              fold: emptyCompleteObservationFold(),
            }
            if (
              (row.detail.taskId === null || !build.ids.has(row.detail.taskId)) &&
              !allowedStandalone(actor, row, build.visibilityIds)
            )
              continue
            if (
              !incrementalObservationHistoricalScope(row, {
                query: view.query,
                ids: build.ids,
                originals: build.originals,
                ...(view.taskId ? { taskId: view.taskId } : {}),
              })
            )
              continue
            const invocation = (row.detail.document as { invocationId?: string } | null)
              ?.invocationId
            if (build.window && invocation && !windowCalls.has(invocation)) continue
            totals[section] = String(BigInt(totals[section] ?? '0') + BigInt(group.total))
          }
          return totals
        }
        const unique = new Map<string, Set<string>>()
        const add = (row: {
          readonly section: string
          readonly key: string
          readonly component: string
          readonly detail: QualifiedObservationContribution['detail']
        }) => {
          if (build.sections.has(rowSource(row.section as CompleteObservationSection, null))) return
          if (
            (row.detail.taskId === null || !build.ids.has(row.detail.taskId)) &&
            !allowedStandalone(
              actor,
              { ...row, aggregates: [], fold: emptyCompleteObservationFold() },
              build.visibilityIds,
            )
          )
            return
          if (
            !incrementalObservationHistoricalScope(
              { ...row, aggregates: [], fold: emptyCompleteObservationFold() },
              {
                query: view.query,
                ids: build.ids,
                originals: build.originals,
                ...(view.taskId ? { taskId: view.taskId } : {}),
              },
            )
          )
            return
          const keys = unique.get(row.section) ?? new Set<string>()
          keys.add(row.key)
          unique.set(row.section, keys)
        }
        for (let at = 0, ids = [...build.ids]; at < ids.length; at += 200)
          for await (const row of input.source.identities({
            version: view.version,
            taskIds: ids.slice(at, at + 200),
          }))
            add(row)
        for (let at = 0; at < build.standaloneComponents.length; at += 200)
          for await (const row of input.source.identities({
            version: view.version,
            components: build.standaloneComponents.slice(at, at + 200),
          }))
            add(row)
        const result: Partial<Record<CompleteObservationSection, string>> = {}
        for (const [section, keys] of unique)
          result[section as CompleteObservationSection] = String(keys.size)
        return result
      },
    )
    Object.assign(counts, cached)
    const header = {
      projectionVersion: 2 as const,
      reportId: view.id,
      generation: view.generation,
      snapshotId: 'projection/' + view.version.revision,
      asOf: view.version.asOf,
      sourceRevision: view.version.revision,
      actorScope: view.actorScope,
      authorizationRevision: String(actor.authorityRevision ?? 0),
      filters: view.query,
      taskId: view.taskId ?? null,
    }
    return build.summary.metrics.state === 'not-ready'
      ? {
          state: 'not-ready',
          reportId: view.id,
          gaps: build.summary.metrics.gaps,
          facts: { header, summary: { ...build.summary, metrics: build.summary.metrics }, counts },
        }
      : { state: 'ready', header, summary: build.summary, counts }
  }
  return {
    async compare(actor, id, left, right) {
      const view = await input.source.view(id, input.scopeOf(actor)),
        original = await assemble(actor, view)
      if (!original.ids.has(left) || !original.ids.has(right))
        throw new CompleteObservationError('not-found', 'Comparison Tasks are outside this report')
      const a = await assemble(
          actor,
          { ...view, id: view.id + '/compare/' + left, taskId: left },
          view.id,
        ),
        b = await assemble(
          actor,
          { ...view, id: view.id + '/compare/' + right, taskId: right },
          view.id,
        )
      if (!a.summary.rootTask || !b.summary.rootTask)
        throw new CompleteObservationError('not-ready', 'Original comparison Task is unavailable')
      return {
        revision: view.version.revision,
        asOf: view.version.asOf,
        basis: 'task-subtree-lifecycle',
        left: a.summary.rootTask,
        right: b.summary.rootTask,
        criticalPath: { state: 'not-ready', reasons: ['causal-dependencies-unobserved'] },
      }
    },
    async request(actor, query, _refreshKey, taskId) {
      const filters = CompleteObservationReportQuerySchema.parse(query),
        head = await input.source.snapshot()
      const version = head && (await input.source.bootstrapComplete(head)) ? head : null
      const view = await input.source.retainView({
        actorScope: input.scopeOf(actor),
        generation: input.generation,
        version: version ?? { revision: '0', asOf: 0 },
        query: filters,
        ...(taskId ? { taskId } : {}),
      })
      // Keep the prior complete report visible while initial enumeration runs;
      // an unfinished population is never substituted for that report.
      if (!version) return { state: 'building', reportId: view.id, phase: 'projection-bootstrap' }
      return report(actor, view)
    },
    async status(actor, id) {
      if (id === 'projection-bootstrap')
        return { state: 'building', reportId: id, phase: 'projection-bootstrap' }
      let view = await input.source.view(id, input.scopeOf(actor))
      if (view.version.revision === '0') {
        const version = await input.source.snapshot()
        if (!version || !(await input.source.bootstrapComplete(version)))
          return { state: 'building', reportId: id, phase: 'projection-bootstrap' }
        view = await input.source.activateView(id, input.scopeOf(actor), version)
      }
      return report(actor, view)
    },
    async page<T>(
      actor: Actor,
      id: string,
      raw: unknown,
    ): Promise<CompleteObservationReportPage<T>> {
      const query = CompleteObservationPageQuerySchema.parse(raw),
        view = await input.source.view(id, input.scopeOf(actor)),
        build = await assemble(actor, view),
        parent = query.parent ?? null
      const prepared = build.sections.get(rowSource(query.section, parent))
      if (
        !prepared &&
        build.indexedDetails &&
        input.source.detailPacket &&
        input.source.countGroups
      ) {
        const scope = input.keyOf(JSON.stringify([id, query.section, parent, input.scopeOf(actor)]))
        let after: string | undefined
        if (query.after) {
          const value: unknown = JSON.parse(query.after)
          if (
            !Array.isArray(value) ||
            value.length !== 3 ||
            value[0] !== 2 ||
            value[1] !== scope ||
            typeof value[2] !== 'string'
          )
            throw new RangeError('Projection page cursor changed scope')
          after = value[2]
        }
        const sourceSection =
            query.section === 'time-unassigned' ? 'time-partitions' : query.section,
          sourceParent = parent?.startsWith('["task-tree",') ? null : parent,
          items: T[] = [],
          keys: string[] = [],
          window = build.window
        const convert = (row: QualifiedObservationContribution): unknown[] => {
          if (
            (row.detail.taskId === null || !build.ids.has(row.detail.taskId)) &&
            !allowedStandalone(actor, row, build.visibilityIds)
          )
            return []
          const scoped = incrementalObservationHistoricalScope(row, {
            query: view.query,
            ids: build.ids,
            originals: build.originals,
            ...(view.taskId ? { taskId: view.taskId } : {}),
          })
          if (!scoped) return []
          return window
            ? incrementalObservationWindowRows(
                [scoped.detail.document],
                query.section,
                parent,
                window,
                build.sections.get(rowSource('tasks', null)) as CompleteObservationTask[],
                view.version.asOf,
              )
            : [scoped.detail.document]
        }
        let cursor = after,
          tail = false
        for (;;) {
          const packet = await input.source.detailPacket({
            version: view.version,
            scope: build.scopeKey,
            section: sourceSection,
            parent: sourceParent,
            limit: 200,
            ...(cursor ? { after: cursor } : {}),
          })
          for (const row of packet.rows) {
            for (const value of convert(row)) {
              items.push(value as T)
              keys.push(row.key)
              if (items.length > query.limit) {
                tail = true
                break
              }
            }
            if (tail) break
          }
          if (tail || packet.next === null) break
          cursor = packet.next
        }
        let total = 0n
        if (!window) {
          for await (const group of input.source.countGroups(build.scopeKey, view.version)) {
            if (group.detail.section !== sourceSection || group.detail.parent !== sourceParent)
              continue
            const row = {
              key: group.detail.key,
              component: group.component,
              detail: group.detail,
              aggregates: [],
              fold: emptyCompleteObservationFold(),
            }
            if (convert(row).length) total += BigInt(group.total)
          }
        } else {
          // Exact requested-output count; large numerical populations are never copied into the report.
          let countCursor: string | undefined
          for (;;) {
            const packet = await input.source.detailPacket({
              version: view.version,
              scope: build.scopeKey,
              section: sourceSection,
              parent: sourceParent,
              limit: 200,
              ...(countCursor ? { after: countCursor } : {}),
            })
            for (const row of packet.rows) total += BigInt(convert(row).length)
            if (packet.next === null) break
            countCursor = packet.next
          }
        }
        const selected = items.slice(0, query.limit)
        return {
          reportId: id,
          section: query.section,
          parent,
          items: selected,
          total: String(total),
          nextCursor: tail ? JSON.stringify([2, scope, keys[query.limit - 1]]) : null,
        }
      }
      const original =
        prepared ??
        (await records(
          actor,
          view,
          build.ids,
          query.section,
          parent,
          build.visibilityIds,
          build.historicalComponents,
          build.originals,
        ))
      const rows =
        prepared || !build.window
          ? original
          : incrementalObservationWindowRows(
              original,
              query.section,
              parent,
              build.window,
              build.sections.get(rowSource('tasks', null)) as CompleteObservationTask[],
              view.version.asOf,
            )
      const scope = input.keyOf(JSON.stringify([id, query.section, parent]))
      let offset = 0
      if (query.after !== undefined) {
        const cursor: unknown = JSON.parse(query.after)
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          cursor[0] !== 1 ||
          cursor[1] !== scope ||
          !Number.isSafeInteger(cursor[2]) ||
          (cursor[2] as number) < 0
        )
          throw new RangeError('Projection page cursor changed scope')
        offset = cursor[2] as number
      }
      const items = rows.slice(offset, offset + query.limit) as T[],
        next = offset + items.length
      return {
        reportId: id,
        section: query.section,
        parent,
        items,
        total: String(rows.length),
        nextCursor: next < rows.length ? JSON.stringify([1, scope, next]) : null,
      }
    },
  }
}
