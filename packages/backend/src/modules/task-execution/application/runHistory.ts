import { requireRunSequence } from '../domain/runSequence'
export { requireRunSequence } from '../domain/runSequence'
import type { FamilyRef, HistoryFilter } from './ports/runSelection'

export interface RunHistoryFacts {
  readonly id: string
  readonly seq: number | null
  readonly nodeId: string
  readonly status?: string
  readonly taskId?: string
  readonly iteration?: number
  readonly retryIndex?: number | null
  readonly parentNodeRunId?: string | null
  readonly containerRunId?: string | null
  readonly shardKey?: string | null
  readonly reviewIteration?: number
  readonly wgRound?: number | null
  readonly startedAt?: number | null
  readonly rerunCause?: string | null
  readonly childTaskId?: string | null
  readonly consumedUpstreamRunsJson?: string | null
}

/** History ordering only. Executable choices come from the persisted selection reader. */
export function createRunHistorySnapshot<R extends RunHistoryFacts>(
  taskId: string,
  rows: readonly R[],
) {
  return {
    async familyHistory(
      requestTaskId: string,
      family: FamilyRef,
      filter: HistoryFilter = {},
    ): Promise<R[]> {
      if (requestTaskId !== taskId) throw new Error('run-history-task-mismatch')
      return rows
        .filter((row) => {
          const seq = requireRunSequence(row)
          return (
            (family.nodeId === undefined || row.nodeId === family.nodeId) &&
            (family.nodeIds === undefined || family.nodeIds.includes(row.nodeId)) &&
            (family.runIds === undefined || family.runIds.includes(row.id)) &&
            (family.iteration === undefined || row.iteration === family.iteration) &&
            (family.shardKey === undefined || row.shardKey === family.shardKey) &&
            (family.reviewIteration === undefined ||
              row.reviewIteration === family.reviewIteration) &&
            (family.parentNodeRunId === undefined ||
              row.parentNodeRunId === family.parentNodeRunId) &&
            (family.containerRunId === undefined || row.containerRunId === family.containerRunId) &&
            (family.wgRound === undefined || row.wgRound === family.wgRound) &&
            (filter.topLevelOnly !== true || row.parentNodeRunId === null) &&
            (filter.childOnly !== true || row.parentNodeRunId != null) &&
            (filter.consumedOnly !== true || row.consumedUpstreamRunsJson != null) &&
            (filter.childTaskOnly !== true || row.childTaskId != null) &&
            (filter.statusIn === undefined ||
              filter.statusIn.some((status) => status === row.status)) &&
            (filter.rerunCause === undefined || row.rerunCause === filter.rerunCause) &&
            (filter.attemptIndexGreaterThan === undefined ||
              (row.retryIndex != null && row.retryIndex > filter.attemptIndexGreaterThan)) &&
            (filter.after === undefined || seq > requireRunSequence(filter.after)) &&
            (filter.before === undefined || seq < requireRunSequence(filter.before)) &&
            (filter.from === undefined || seq >= requireRunSequence(filter.from)) &&
            (filter.through === undefined || seq <= requireRunSequence(filter.through))
          )
        })
        .sort((a, b) => {
          let priority = 0
          if (filter.order === 'retry-index') priority = (a.retryIndex ?? -1) - (b.retryIndex ?? -1)
          if (filter.order === 'iteration') priority = (a.iteration ?? 0) - (b.iteration ?? 0)
          if (filter.order === 'running-first')
            priority = Number(a.status === 'running') - Number(b.status === 'running')
          if (filter.order === 'started-at' || filter.order === 'api-timeline')
            priority =
              a.startedAt == null
                ? b.startedAt == null
                  ? 0
                  : -1
                : b.startedAt == null
                  ? 1
                  : a.startedAt - b.startedAt
          return (
            (priority || requireRunSequence(a) - requireRunSequence(b)) *
            (filter.direction === 'desc' ? -1 : 1)
          )
        })
    },
  }
}

export interface RunHistoryReader {
  familyHistory(
    taskId: string,
    family: FamilyRef,
    filter?: HistoryFilter,
  ): Promise<readonly RunHistoryFacts[]>
}

/** One batched projection, partitioned by persisted task ID; no per-task storage reads. */
export function createRunHistoryBatchSnapshot<
  R extends RunHistoryFacts & { readonly taskId: string },
>(rows: readonly R[]) {
  const tasks = new Map<string, R[]>()
  for (const row of rows) {
    const group = tasks.get(row.taskId) ?? []
    group.push(row)
    tasks.set(row.taskId, group)
  }
  return {
    familyHistory(taskId: string, family: FamilyRef, filter?: HistoryFilter) {
      return createRunHistorySnapshot(taskId, tasks.get(taskId) ?? []).familyHistory(
        taskId,
        family,
        filter,
      )
    },
  }
}
