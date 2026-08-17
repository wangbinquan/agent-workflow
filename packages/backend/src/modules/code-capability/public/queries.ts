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
  /**
   * How many rounds exist beyond the ones returned (T66).
   *
   * Always present, zero included. A truncated list that does not say it is
   * truncated is the failure §11.7 names: a reader on an eighty-round merge
   * request sees three and concludes that is all there was.
   */
  roundsHidden: number
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

/**
 * RFC-304 T55 — one model call, as the state view's third level shows it.
 *
 * This is the layer that answers "why did this stage take four minutes and
 * three tries?". The determinism guard already writes every attempt with its
 * verdict; until this projection existed nothing read them back, so the retries
 * were invisible and a stage that eventually succeeded looked identical to one
 * that succeeded first time.
 */
export interface CodeAiAttemptProjection {
  attemptId: string
  stageName: string
  /** Which shard of a fanned-out stage; empty for a single-call stage. */
  shardKey: string
  /** Fresh-session re-run counter (0-based) — a NEW session was started. */
  rerunSeq: number
  /** Same-session retry counter (0-based) — the model was told what was wrong. */
  attemptSeq: number
  status: string
  /**
   * The guard's verdict in its own words: which rule rejected the envelope.
   *
   * Shown verbatim rather than reduced to pass/fail. "the envelope named a port
   * the stage does not declare" and "the JSON did not parse" lead to different
   * fixes, and collapsing them to "invalid" makes the reader open a transcript
   * to learn what this column already knew.
   */
  validationOutcome: string | null
  /** Native runtime session id, for cross-referencing a transcript. */
  sessionRef: string | null
  /** The node_run that carried the call; the page links to its task detail. */
  nodeRunId: string | null
  startedAt: number
  endedAt: number | null
}

export interface CodeRoundAttemptsQuery {
  /**
   * Every AI call of one round, in the order they happened.
   *
   * Per ROUND rather than folded into the work-item page: attempts are the
   * widest rows in the model and most rounds are never expanded. Loading them
   * with the list would make every visit pay for a level almost nobody opens
   * (the shape T66 has to fix later if it is built the other way round).
   */
  forRound(roundId: string): Promise<readonly CodeAiAttemptProjection[]>
}

/**
 * RFC-304 T58 — what the platform has actually achieved, per capability.
 *
 * The four adoption buckets are FOUR, not one rate, and that is the whole
 * design of this projection. The schema keeps `resolvedAt` and `codeChangedAt`
 * apart because they disagree in exactly the informative cases:
 *
 *   adopted      — the code changed AND a person resolved the thread. Agreed.
 *   quietFix     — the code changed, nobody resolved anything. Still a win, and
 *                  invisible to any metric that requires a human click.
 *   disagreed    — resolved with the code untouched: a person looked and said
 *                  no. Counting this as success is how a review bot convinces
 *                  itself it is helping while everyone mutes it.
 *   outstanding  — neither. Still open, or ignored.
 *
 * A single "adoption rate" has to pick one of those to be wrong about. Teams
 * act on this number — it is what decides whether a capability stays on — so
 * the projection refuses to compute it and hands over the parts.
 */
export interface CodeAdoptionBuckets {
  capability: string
  published: number
  adopted: number
  quietFix: number
  disagreed: number
  outstanding: number
}

/** Round outcomes over the window, so "is it working at all" has an answer. */
export interface CodeRunCounts {
  capability: string
  rounds: number
  published: number
  failed: number
  awaiting: number
  /** Rounds that ended with no outcome recorded — a daemon death, usually. */
  incomplete: number
}

export interface CodeMetricsSummary {
  /** Milliseconds; findings and rounds older than this are not counted. */
  windowMs: number
  adoption: readonly CodeAdoptionBuckets[]
  runs: readonly CodeRunCounts[]
}

export interface CodeMetricsQuery {
  summary(input?: { windowMs?: number; now?: number }): Promise<CodeMetricsSummary>
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
    input: CodeWorkItemFilter & {
      limit?: number
      cursor?: string | null
      /**
       * Rounds per item (T66). Defaults to the LIST bound; a caller looking at
       * one item may widen it to the round window, and the query caps it there
       * either way — twenty rounds across twenty items is the response size the
       * bound exists to prevent.
       */
      roundLimit?: number
    },
  ): Promise<CodeWorkItemPage>
}
