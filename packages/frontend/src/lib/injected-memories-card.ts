// RFC-046 — pure helpers backing <InjectedMemoriesCard>. Kept separate
// from the component so each branch is unit-testable in isolation.

import type { InjectedMemorySnapshot, NodeRun } from '@agent-workflow/shared'

// RFC-146: isAgentKind was a copy of the agent-kind predicate — callers now
// import shared `isAgentNodeKind` (NODE_KIND_BEHAVIORS.isAgent), which is
// already defensive on unknown/null strings.

/**
 * Three render branches for the card body:
 *   - 'captured'   : runner persisted a non-empty array; render the list.
 *   - 'empty'      : runner persisted an empty array (inject succeeded but
 *                    no scope had approved memories — distinct from null).
 *   - 'pre-rfc046' : column was NULL (pre-RFC-046 row or runner failed to
 *                    persist). Show the "Not captured" disclaimer.
 *
 * `undefined` (api response without the field, e.g. older clients) is
 * treated identically to null.
 */
export function decideStatus(
  list: readonly InjectedMemorySnapshot[] | null | undefined,
): 'captured' | 'empty' | 'pre-rfc046' {
  if (list === null || list === undefined) return 'pre-rfc046'
  if (list.length === 0) return 'empty'
  return 'captured'
}

export interface GroupedSnapshots {
  agent: InjectedMemorySnapshot[]
  workflow: InjectedMemorySnapshot[]
  repo: InjectedMemorySnapshot[]
  global: InjectedMemorySnapshot[]
}

/** Stable display order: most-specific → most-general. */
export const SCOPE_ORDER = ['agent', 'workflow', 'repo', 'global'] as const
export type ScopeKey = (typeof SCOPE_ORDER)[number]

export function groupByScope(list: readonly InjectedMemorySnapshot[]): GroupedSnapshots {
  const out: GroupedSnapshots = { agent: [], workflow: [], repo: [], global: [] }
  for (const m of list) {
    out[m.scopeType].push(m)
  }
  return out
}

/**
 * Truncate body markdown for the summary preview. The full body is rendered
 * in the row's expanded `<details>` via MarkdownRenderer; the summary just
 * wants a single-line teaser. Strips newlines so multi-paragraph bodies
 * collapse cleanly.
 */
export function previewOf(bodyMd: string, max = 200): string {
  const oneLine = bodyMd.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max) + '…'
}

/**
 * RFC-046 + RFC-042: detect a same-session envelope-followup retry. The
 * runner's followup path copies attempt 0's snapshot to the followup row,
 * so the UI labels it "Inherited from attempt 0" to make that contract
 * legible. We can't infer this from `injectedMemories` alone — multiple
 * legitimate paths can produce identical lists across attempts — so the
 * caller must also know which attempts share the same opencodeSessionId.
 *
 * Returns true iff `run.retryIndex > 0` AND the run shares
 * `opencodeSessionId` with the generation-anchor sibling (see
 * `findFirstAttemptSibling`). A run that IS its generation's first attempt
 * (anchor === run) is never an inherit, which also covers a cross-clarify
 * designer rerun (minted at retry=max+1, so it does not early-return on
 * retryIndex===0 but anchors to itself).
 */
export function isFollowupInherit(run: NodeRun, attempt0: NodeRun | undefined): boolean {
  if (run.retryIndex === 0) return false
  if (attempt0 === undefined) return false
  if (attempt0.id === run.id) return false
  const sid = run.opencodeSessionId
  if (sid === null || sid === '') return false
  return attempt0.opencodeSessionId === sid
}

/**
 * Pick the sibling that ANCHORS the active run's clarify generation (its first
 * attempt — the one that ran inject), scoped to the same (nodeId, iteration,
 * shardKey, reviewIteration). RFC-074 PR-C: mirrors the backend
 * `memoryInject.loadInjectedSnapshotFromFirstAttempt` / scheduler
 * `priorDoneGenerationsForRun` — the generation starts at the first in-scope
 * row OR at any row whose nearest prior in-scope row (by id) is `done`. This is
 * retry-AGNOSTIC: a process / envelope-followup retry follows a `failed`
 * attempt (same generation), while a clarify-driven rerun follows the prior
 * generation's `done` row. The earlier `retry_index === 0` anchor under-counted
 * cross-clarify DESIGNER reruns, which mint at retry=max+1 (not 0).
 */
export function findFirstAttemptSibling(
  run: NodeRun,
  allRuns: readonly NodeRun[],
): NodeRun | undefined {
  const scoped = allRuns
    .filter(
      (r) =>
        r.nodeId === run.nodeId &&
        r.parentNodeRunId === null &&
        r.iteration === run.iteration &&
        r.shardKey === run.shardKey &&
        r.reviewIteration === run.reviewIteration &&
        r.id <= run.id,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let anchor: NodeRun | undefined
  let prevStatus: string | undefined
  for (const r of scoped) {
    if (prevStatus === undefined || prevStatus === 'done') anchor = r
    prevStatus = r.status
  }
  return anchor
}
