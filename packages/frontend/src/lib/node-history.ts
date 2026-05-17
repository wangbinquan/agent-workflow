// Splits sibling node_runs of the same workflow node into two groups so the
// NodeDetailDrawer Stats tab can render "retries" and "iteration history"
// separately.
//
// Background: a single workflow node id may produce many node_runs that share
// no `retryIndex` bump — they were instead minted from a different orthogonal
// counter (loop wrapper `iteration`, RFC-005 `reviewIteration`, RFC-023
// `clarifyIteration`). Lumping all of them under "retries" makes every row
// label as `第 0 次` while clicking each shows wildly different prompts /
// outputs, which is the bug this helper is fixing.

import type { NodeRun } from '@agent-workflow/shared'

function sameTuple(a: NodeRun, b: NodeRun): boolean {
  return (
    a.iteration === b.iteration &&
    a.reviewIteration === b.reviewIteration &&
    a.clarifyIteration === b.clarifyIteration
  )
}

export interface NodeRunHistorySplit {
  /**
   * Process-level retries of the *current* (iteration, reviewIteration,
   * clarifyIteration) tuple. Excludes the current run itself.
   */
  retries: NodeRun[]
  /**
   * Full iteration history of the same nodeId — *includes* the current run
   * so the user always sees the complete `初次 + 反问#1 + 反问#2 + …`
   * timeline and the active row is highlighted. Empty when every sibling
   * shares the current run's (iteration, reviewIteration, clarifyIteration)
   * tuple — in that case only the retries list is relevant.
   */
  iterations: NodeRun[]
}

export function splitNodeRunHistory(
  current: NodeRun,
  runs: readonly NodeRun[],
): NodeRunHistorySplit {
  const siblings = runs.filter((r) => r.nodeId === current.nodeId && r.parentNodeRunId === null)
  const retries = siblings
    .filter((r) => r.id !== current.id && sameTuple(r, current))
    .sort((a, b) => a.retryIndex - b.retryIndex)
  const hasMultipleTuples = siblings.some((r) => !sameTuple(r, current))
  const iterations = hasMultipleTuples
    ? [...siblings].sort((a, b) => {
        if (a.iteration !== b.iteration) return a.iteration - b.iteration
        if (a.reviewIteration !== b.reviewIteration) return a.reviewIteration - b.reviewIteration
        if (a.clarifyIteration !== b.clarifyIteration)
          return a.clarifyIteration - b.clarifyIteration
        return a.retryIndex - b.retryIndex
      })
    : []
  return { retries, iterations }
}

interface IterationLabelOpts {
  t: (key: string, vars?: Record<string, string | number>) => string
}

/**
 * Joins the non-zero loop / review / clarify counters into a single label.
 * Retry index is appended only when >0 (process retry within that tuple).
 * All-zero tuple → `initial` — the very first attempt, no iteration counter
 * ever bumped.
 */
export function formatIterationLabel(run: NodeRun, opts: IterationLabelOpts): string {
  const parts: string[] = []
  if (run.iteration > 0) parts.push(opts.t('nodeDrawer.iterLoop', { n: run.iteration }))
  if (run.reviewIteration > 0)
    parts.push(opts.t('nodeDrawer.iterReview', { n: run.reviewIteration }))
  if (run.clarifyIteration > 0)
    parts.push(opts.t('nodeDrawer.iterClarify', { n: run.clarifyIteration }))
  if (parts.length === 0) parts.push(opts.t('nodeDrawer.iterInitial'))
  if (run.retryIndex > 0) parts.push(opts.t('nodeDrawer.iterRetry', { n: run.retryIndex }))
  return parts.join(' · ')
}
