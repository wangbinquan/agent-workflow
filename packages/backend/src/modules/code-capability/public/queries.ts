// RFC-304 T31b — what the outside world may ASK this module.
//
// Exact entrypoint (RFC-294): `public/queries` is one of the five names another
// context may import, and it exports named types only — no star re-export, so
// nothing internal leaks by being added to a barrel later.
//
// ## Why the queries carry repair actions
//
// A matrix that says `misconfigured` and stops has moved the problem rather
// than solved it: somebody now has to work out WHICH of five prerequisites is
// missing, and where to go. The readiness issues already name the missing
// piece; these queries pair each one with the route that fixes it, so the page
// can offer the fix rather than describe the fault.
//
// That is also why `repairActions` is derived here and not in the frontend. The
// mapping from "no binding" to "where you bind one" is a property of how this
// module is configured, and duplicating it in a component would let the two
// drift the day a route moves.

import type {
  ReadinessIssue,
  ReadinessState,
} from '@/modules/code-capability/domain/templateLayers'

/** One repository × capability cell, as a configuration page shows it. */
export interface CodeMatrixRow {
  repoId: string
  capability: string
  enabled: boolean
  readiness: ReadinessState
  /** The specific missing pieces; empty when ready. */
  issues: readonly ReadinessIssue[]
  /** Where to go to fix each issue, in the same order. */
  repairActions: readonly CodeRepairAction[]
  bindingId: string | null
}

/**
 * A fix a person can act on.
 *
 * `route` is a platform route rather than free text so the page can link
 * straight to it; `label` is what the link says.
 */
export interface CodeRepairAction {
  code: ReadinessIssue['code']
  label: string
  route: string
}

export interface CodeMatrixQuery {
  /** Every capability cell for one repository, ready or not. */
  forRepo(repoId: string): Promise<readonly CodeMatrixRow[]>
}

/**
 * The state machine, as the first two levels of the design's diagram.
 *
 * Level one is the work item's own lifecycle; level two expands the CURRENT
 * round into its stages. Deeper levels (per-shard attempts) are deliberately
 * not here — they are per-round detail, and folding them into the same query
 * would make the common case pay for the rare one.
 */
export interface CodeWorkItemProjection {
  workItemId: string
  capability: string
  anchorKind: string
  anchorId: string
  status: string
  epoch: number
  /** Rounds newest first — the one someone is watching is the newest. */
  rounds: readonly CodeRoundProjection[]
}

export interface CodeRoundProjection {
  roundId: string
  roundSeq: number
  status: string
  outcome: string | null
  baselineSha: string | null
  startedAt: number
  endedAt: number | null
  /** In contract order, so the sequence reads as the engine ran it. */
  stages: readonly CodeStageProjection[]
}

export interface CodeStageProjection {
  stageName: string
  stageSeq: number
  kind: string
  status: string
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface CodeWorkItemPage {
  items: readonly CodeWorkItemProjection[]
  /**
   * Opaque cursor for the next page, or null at the end.
   *
   * Cursor rather than offset: work items are created while somebody is paging
   * through them, and an offset would silently skip or repeat rows as the list
   * shifts underneath.
   */
  nextCursor: string | null
}

/**
 * Filters a caller may narrow the list by.
 *
 * NOT `repoId`, deliberately. A work item is keyed by
 * `(codeHostEndpointId, stableProjectId)` because a repository PATH changes
 * when a project is renamed or moved, and an item keyed to the old path would
 * detach from its own history. There is currently no stored mapping from a
 * matrix cell's `repoId` to a project id — so accepting `repoId` here would
 * compile, return an empty page forever, and look like "this repository has
 * done nothing" rather than "this filter cannot be resolved".
 *
 * Every filter is optional: with none, this lists what the viewer may see,
 * newest first, which is what a global "what has the platform been doing" view
 * needs.
 */
export interface CodeWorkItemFilter {
  codeHostEndpointId?: string
  stableProjectId?: string
  capability?: string
}

export interface CodeWorkItemProjectionQuery {
  page(
    input: CodeWorkItemFilter & { limit?: number; cursor?: string | null },
  ): Promise<CodeWorkItemPage>
}
