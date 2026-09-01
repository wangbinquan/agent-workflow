import { resolveHandlerRun, type RunLineageView } from '@agent-workflow/shared'

export interface TaskDagParkEntry {
  readonly dispatchedAt: number | null
  readonly triggerRunId: string | null
  readonly defaultTargetNodeId: string | null
  readonly overrideTargetNodeId: string | null
}

export interface TaskDagNodeRun {
  readonly id: string
  readonly nodeId: string
  readonly iteration: number
  readonly rerunCause: string | null
  readonly status: RunLineageView['status']
  readonly startedAt: number | null
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
}

/**
 * Shared behavior oracle for SQLite and PostgreSQL park projections. A target
 * parks only while it has undispatched work and no unconsumed dispatched rerun
 * across any collaboration role.
 */
export function partitionTaskDagParkTargets(
  entries: readonly TaskDagParkEntry[],
  runs: readonly TaskDagNodeRun[],
  outputRunIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (entries.length === 0) return new Set()
  const lineageViews: RunLineageView[] = runs.map((run) => ({
    id: run.id,
    nodeId: run.nodeId,
    iteration: run.iteration,
    loopIter: 0,
    rerunCause: run.rerunCause,
    status: run.status,
    startedAt: run.startedAt,
    hasOutput: outputRunIds.has(run.id),
    parentNodeRunId: run.parentNodeRunId,
    shardKey: run.shardKey,
  }))
  const undispatched = new Set<string>()
  const inFlight = new Set<string>()
  for (const entry of entries) {
    const target = entry.overrideTargetNodeId ?? entry.defaultTargetNodeId
    if (target === null || target.length === 0) continue
    if (entry.dispatchedAt === null) {
      undispatched.add(target)
      continue
    }
    if (entry.triggerRunId === null) {
      inFlight.add(target)
      continue
    }
    const anchor = runs.find((run) => run.id === entry.triggerRunId)
    if (anchor === undefined) {
      inFlight.add(target)
      continue
    }
    const handler = resolveHandlerRun({
      effectiveTargetNodeId: anchor.nodeId,
      iteration: anchor.iteration,
      loopIter: 0,
      triggerRunId: entry.triggerRunId,
      runs: lineageViews,
      ...(anchor.shardKey === null ? {} : { shardKey: anchor.shardKey }),
    })
    if (handler === null || handler.status !== 'done') inFlight.add(target)
  }
  return new Set([...undispatched].filter((target) => !inFlight.has(target)))
}
