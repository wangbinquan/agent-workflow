// RFC-011 — Prompt-tab attempts helpers.
//
// These are the pure functions backing the NodeDetailDrawer Prompt tab's
// attempts switcher. Kept as plain helpers so the unit tests can exercise
// the contract without rendering the drawer.
//
//   - `sortNodeRunsForPromptHistory` orders runs by (iteration, retryIndex,
//     parent-first-then-shards, shardKey, startedAt) so the switcher reads
//     left-to-right chronologically.
//   - `isPromptCapableKind` answers whether a workflow node kind ever has
//     an opencode user prompt — input / output / wrappers / review do not.
//   - `formatAttemptLabel` returns the `<option>` text for one attempt.

import type { NodeRun } from '@agent-workflow/shared'
import { displayNoderunStatusKey } from '@/lib/noderun-status'

export function sortNodeRunsForPromptHistory(runs: readonly NodeRun[]): NodeRun[] {
  return [...runs].sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration
    if (a.retryIndex !== b.retryIndex) return a.retryIndex - b.retryIndex
    // Parent (parentNodeRunId === null) sorts before its shard children.
    const ap = a.parentNodeRunId === null ? 0 : 1
    const bp = b.parentNodeRunId === null ? 0 : 1
    if (ap !== bp) return ap - bp
    // shardKey lexicographic among siblings.
    const ak = a.shardKey ?? ''
    const bk = b.shardKey ?? ''
    if (ak !== bk) return ak < bk ? -1 : 1
    // startedAt tiebreaker — null sorts last (run not started yet).
    const at = a.startedAt ?? Number.POSITIVE_INFINITY
    const bt = b.startedAt ?? Number.POSITIVE_INFINITY
    return at - bt
  })
}

// RFC-146: isPromptCapableKind was a copy of the agent-kind predicate —
// callers now import shared `isAgentNodeKind` (NODE_KIND_BEHAVIORS.isAgent).

/**
 * True iff this run row represents a multi-process fan-out parent — it has
 * shard children (parentNodeRunId pointing back to its id) somewhere in the
 * same task. Parent rows never carry a promptText of their own; the Prompt
 * tab labels them so the user knows to drill into a shard.
 */
export function isFanoutParentRun(run: NodeRun, allRuns: readonly NodeRun[]): boolean {
  if (run.parentNodeRunId !== null) return false
  return allRuns.some((r) => r.parentNodeRunId === run.id)
}

interface AttemptLabelOpts {
  fanoutParent: boolean
  /**
   * Translator from i18next. Pulled in as a prop so the helper stays pure
   * and the test can stub it with `(k, v) => k` to assert key + interpolated
   * values without booting the i18n runtime.
   */
  t: (key: string, vars?: Record<string, string | number>) => string
  /**
   * Override the wall-clock string in tests so snapshots aren't TZ-flaky.
   * If absent we render `new Date(startedAt).toLocaleTimeString()`.
   */
  timeString?: string
}

export function formatAttemptLabel(run: NodeRun, opts: AttemptLabelOpts): string {
  const time =
    opts.timeString ?? (run.startedAt === null ? '' : new Date(run.startedAt).toLocaleTimeString())
  // Localized status — superseded rows render "Superseded / 已被新尝试取代"
  // instead of raw "canceled" so the dropdown stays in lock-step with the
  // Stats tab chip.
  const status = opts.t(displayNoderunStatusKey(run))
  if (opts.fanoutParent) {
    return opts.t('nodeDrawer.promptAttemptParent', {
      iter: run.iteration,
      retry: run.retryIndex,
      status,
      time,
    })
  }
  if (run.shardKey !== null && run.shardKey !== '') {
    return opts.t('nodeDrawer.promptAttemptShard', {
      iter: run.iteration,
      retry: run.retryIndex,
      shard: run.shardKey,
      status,
      time,
    })
  }
  return opts.t('nodeDrawer.promptAttemptEntry', {
    iter: run.iteration,
    retry: run.retryIndex,
    status,
    time,
  })
}
