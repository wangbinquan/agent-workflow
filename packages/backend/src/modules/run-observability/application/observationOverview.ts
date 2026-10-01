import type {
  ObservationOverview,
  ObservationOverviewQuery,
  ObservationTaskFacts,
  ObservationTaskSummary,
  ObservationTaskDetail,
} from '@agent-workflow/shared'
import { observationRuntimeKey } from '@agent-workflow/shared'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { aggregateObservationMetrics as aggregate } from '../domain/aggregateMetrics'
import type { ObservationSnapshotSources } from '../ports/taskObservations'
import {
  boundedObservationSources,
  ObservationReadBudgetReached,
  OBSERVATION_READ_LIMITS as LIMITS,
  readDimensionTasks,
} from './dimensionTasks'

type Agent = ObservationOverview['agents'][number]
type Model = ObservationOverview['models'][number]
type Runtime = ObservationOverview['runtimes'][number]
export interface ObservationAnalysisTask {
  readonly summary: ObservationTaskSummary
  readonly agents: readonly Omit<Agent, 'tasks'>[]
  readonly models: readonly Model[]
  readonly runtimes: readonly Runtime[]
  readonly purposes?: NonNullable<ObservationOverview['purposes']>
  readonly sources?: NonNullable<ObservationOverview['sources']>
  readonly collection: {
    readonly firstObservedAt: number | null
    readonly lastObservedAt: number | null
    readonly platforms: ObservationTaskDetail['sources']
  }
}
export async function readObservationOverview(input: {
  readonly actor: Actor
  readonly query: ObservationOverviewQuery
  readonly asOf: number
  readonly sources: ObservationSnapshotSources
  readonly summarize: (
    sources: ObservationSnapshotSources,
    task: ObservationTaskFacts,
  ) => Promise<ObservationAnalysisTask | null>
  readonly unresolved?: (task: ObservationTaskFacts) => ObservationAnalysisTask
}): Promise<ObservationOverview> {
  const sources = boundedObservationSources(input.sources),
    rows: ObservationAnalysisTask[] = []
  let after: string | undefined,
    partial = false
  let scannedTasks: number | undefined, unresolvedTasks: number | undefined
  if (input.query.selection !== undefined) {
    const unresolved = input.unresolved
    if (!unresolved) throw new Error('Dimension observation unknown-task projection missing')
    const selected = await readDimensionTasks({
      actor: input.actor,
      query: { ...input.query, limit: 20 },
      sources: input.sources,
      matchLimit: LIMITS.tasks,
      summarize: input.summarize,
      unresolved,
    })
    rows.push(...selected.rows)
    partial = selected.partial || selected.nextCursor !== null
    scannedTasks = selected.scannedTasks
    unresolvedTasks = selected.unresolvedTasks
  } else
    read: do {
      const page = await sources.tasks.list({
        actor: input.actor,
        query: { ...input.query, limit: 25, ...(after ? { after } : {}) },
      })
      for (const task of page.items) {
        if (rows.length === LIMITS.tasks) {
          partial = true
          break read
        }
        try {
          const row = await input.summarize(sources, task)
          if (row) rows.push(row)
        } catch (error) {
          if (!(error instanceof ObservationReadBudgetReached)) throw error
          partial = true
          break read
        }
      }
      after = page.nextCursor ?? undefined
    } while (after)
  partial ||= rows.some((row) => row.summary.metrics.truncated)
  const tasks = rows.map((row) => row.summary)
  const backlog = new Map(
    (await sources.tasks.sourceBacklog(tasks.map((row) => row.task.id))).map((row) => [
      row.taskId,
      row,
    ]),
  )
  const collectionTasks = rows.map((row) => {
    const source = backlog.get(row.summary.task.id)
    if (!source) throw new Error('Observation source status missing from owner snapshot')
    return {
      ...source,
      firstObservedAt: row.collection.firstObservedAt,
      lastObservedAt: row.collection.lastObservedAt,
    }
  })
  const firstObserved = collectionTasks.flatMap((row) =>
    row.firstObservedAt === null ? [] : [row.firstObservedAt],
  )
  const lastObserved = collectionTasks.flatMap((row) =>
    row.lastObservedAt === null ? [] : [row.lastObservedAt],
  )
  const statuses = new Map<string, number>(),
    quality = new Map<string, string[]>()
  const agents = new Map<string, { value: Omit<Agent, 'tasks'>; tasks: Agent['tasks'][number][] }>()
  const models = new Map<string, Model[]>(),
    runtimes = new Map<string, Runtime[]>()
  const purposes = new Map<string, NonNullable<ObservationOverview['purposes']>[number][]>(),
    sourceGroups = new Map<string, NonNullable<ObservationOverview['sources']>[number][]>()
  for (const row of rows) {
    const task = row.summary.task
    statuses.set(task.status, (statuses.get(task.status) ?? 0) + 1)
    for (const reason of row.summary.metrics.cost.reasons) {
      const ids = quality.get(reason) ?? []
      ids.push(task.id)
      quality.set(reason, ids)
    }
    for (const agent of row.agents) {
      const key = JSON.stringify([agent.agentId, agent.agentRevision, agent.purpose])
      const entry = agents.get(key) ?? { value: agent, tasks: [] }
      entry.tasks.push({ taskId: task.id, metrics: agent.metrics })
      agents.set(key, entry)
    }
    for (const model of row.models) {
      const key = JSON.stringify([model.authority, model.sourceId, model.provider, model.model])
      const group = models.get(key) ?? []
      group.push({ ...model, tasks: [{ taskId: task.id, metrics: model.metrics }] })
      models.set(key, group)
    }
    for (const runtime of row.runtimes) {
      const key = observationRuntimeKey(runtime)
      const group = runtimes.get(key) ?? []
      group.push({ ...runtime, tasks: [{ taskId: task.id, metrics: runtime.metrics }] })
      runtimes.set(key, group)
    }
    for (const purpose of row.purposes ?? []) {
      const group = purposes.get(purpose.purpose) ?? []
      group.push({ ...purpose, tasks: [{ taskId: task.id, metrics: purpose.metrics }] })
      purposes.set(purpose.purpose, group)
    }
    for (const source of row.sources ?? []) {
      const key = JSON.stringify([source.authority, source.sourceId]),
        group = sourceGroups.get(key) ?? []
      group.push({ ...source, tasks: [{ taskId: task.id, metrics: source.metrics }] })
      sourceGroups.set(key, group)
    }
  }
  const count = Math.min(30, Math.max(1, Math.ceil((input.query.to - input.query.from) / 86400000)))
  const trend = Array.from({ length: count }, (_, i) => {
    const from = input.query.from + Math.floor(((input.query.to - input.query.from) * i) / count)
    const to =
      input.query.from + Math.floor(((input.query.to - input.query.from) * (i + 1)) / count)
    const bucket = tasks.filter((row) => row.task.startedAt >= from && row.task.startedAt < to)
    return {
      from,
      to,
      taskCount: bucket.length,
      metrics: aggregate(
        bucket.map((row) => row.metrics),
        partial,
      ),
    }
  })
  // Only observed terminal boundaries participate; running tasks cannot become short "completed" samples.
  const durations = tasks
    .filter(
      (row) =>
        (TERMINAL_TASK_STATUSES as readonly string[]).includes(row.task.status) &&
        row.task.finishedAt !== null &&
        row.task.finishedAt >= row.task.startedAt &&
        row.task.finishedAt <= input.asOf,
    )
    .map((row) => row.wallMs)
    .sort((a, b) => a - b)
  const percentile = (p: number) =>
    durations.length ? durations[Math.max(0, Math.ceil(durations.length * p) - 1)]! : null
  return {
    asOf: input.asOf,
    projectionVersion: 1,
    cohort: 'started',
    taskScope: 'direct',
    filtersEcho: input.query,
    partial,
    ...(scannedTasks === undefined ? {} : { scannedTasks, unresolvedTasks }),
    collection: {
      retainedRecords: collectionTasks.reduce((sum, row) => sum + row.retainedRecords, 0),
      pendingRecords: collectionTasks.reduce((sum, row) => sum + row.pendingRecords, 0),
      firstObservedAt: firstObserved.length ? Math.min(...firstObserved) : null,
      lastObservedAt: lastObserved.length ? Math.max(...lastObserved) : null,
      tasks: collectionTasks,
      platforms: rows.flatMap((row) =>
        row.collection.platforms.map((source) => ({ ...source, taskId: row.summary.task.id })),
      ),
    },
    limits: LIMITS,
    metrics: aggregate(
      tasks.map((row) => row.metrics),
      partial,
    ),
    tasks,
    statuses: [...statuses].map(([status, count]) => ({ status, count })),
    trend,
    agents: [...agents.values()].map(({ value, tasks }) => ({
      ...value,
      tasks,
      metrics: aggregate(
        tasks.map((row) => row.metrics),
        partial,
      ),
    })),
    models: [...models.values()].map((group) => ({
      ...group[0]!,
      tasks: group.flatMap((row) => row.tasks ?? []),
      metrics: aggregate(
        group.map((row) => row.metrics),
        partial,
      ),
    })),
    purposes: [...purposes.values()].map((group) => ({
      ...group[0]!,
      tasks: group.flatMap((row) => row.tasks),
      metrics: aggregate(
        group.map((row) => row.metrics),
        partial,
      ),
    })),
    sources: [...sourceGroups.values()].map((group) => ({
      ...group[0]!,
      tasks: group.flatMap((row) => row.tasks),
      metrics: aggregate(
        group.map((row) => row.metrics),
        partial,
      ),
    })),
    runtimes: [...runtimes.values()].map((group) => ({
      ...group[0]!,
      acceptedNames: [...new Set(group.flatMap((row) => row.acceptedNames ?? []))].sort(),
      ...(group[0]!.authority === 'local' && group[0]!.registrationId !== null
        ? {
            unnamedInvocations: group.reduce(
              (sum, row) => sum + (row.unnamedInvocations ?? row.metrics.invocations),
              0,
            ),
          }
        : {}),
      tasks: group.flatMap((row) => row.tasks ?? []),
      metrics: aggregate(
        group.map((row) => row.metrics),
        partial,
      ),
    })),
    durations: {
      completedTasks: durations.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: durations.at(-1) ?? null,
    },
    quality: [...quality].map(([reason, taskIds]) => ({ reason, taskIds })),
  }
}
