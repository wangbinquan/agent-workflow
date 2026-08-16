// RFC-304 §11.4 (T62) — what is kept, what is summarised, what is thrown away.
//
// The arithmetic that forces this, from the design section: one repository with
// 50 active merge requests × 3 rounds a day × 180 days = 27,000 rounds. For
// `mr-review` alone that is ~350,000 stage rows; with 4 shards + 1 global pass
// and roughly one retry each, ~400,000 AI attempt rows; at 10 new findings a
// round, ~270,000 ledger rows. Plus a `templateSnapshot` per round.
//
// Without lifetime rules the lists and the metrics get slower every week until
// an administrator deletes rows by hand — and a hand-deletion takes the ledger
// and the adoption numbers with it, which is the one thing that must survive.
// So the rules are written to make the manual cleanup unnecessary rather than
// to make it safe.
//
// The ordering principle throughout: SUMMARISE before discarding, and keep
// whatever the adoption metric reads forever. A number nobody can reproduce is
// worse than no number.

/** What a closed work item keeps after its detail is archived. */
export interface WorkItemRollup {
  workItemId: string
  rounds: number
  /** Wall-clock from first round start to last round end. */
  elapsedMs: number
  findingsPublished: number
  findingsAdopted: number
}

export type RetentionAction =
  /** Keep the row as it is. */
  | { kind: 'keep'; reason: string }
  /** Replace detail with a rollup, keeping the aggregate. */
  | { kind: 'summarise'; reason: string }
  /** Delete outright — nothing downstream reads it. */
  | { kind: 'discard'; reason: string }

export interface RetentionInput {
  /** `closed` items are the only ones whose detail may be archived. */
  workItemClosed: boolean
  /** Age of the row, in ms. */
  ageMs: number
  now?: number
}

/** 90 days of full round/stage detail before a closed item is summarised. */
export const DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** 30 days of per-attempt detail; the per-stage aggregate outlives it. */
export const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Rounds and stages of a work item.
 *
 * An ACTIVE item keeps everything however old it is — a merge request open for
 * six months is exactly the one whose history somebody needs, and age is not
 * evidence of irrelevance while work is still arriving on it.
 */
export function judgeRoundRetention(input: RetentionInput): RetentionAction {
  if (!input.workItemClosed) {
    return { kind: 'keep', reason: 'the work item is still active; its history is still in use' }
  }
  if (input.ageMs < DETAIL_RETENTION_MS) {
    return { kind: 'keep', reason: 'recently closed; the detail is still worth reading' }
  }
  return {
    kind: 'summarise',
    reason: 'closed long enough that the rollup answers what the detail would',
  }
}

/**
 * AI attempts.
 *
 * These are the widest rows and the fastest-growing, and what anyone actually
 * asks of them later is "how often did this stage need a retry" — a question
 * the per-stage aggregate answers. The individual prompts and verdicts are only
 * useful while somebody is debugging a specific round, which is a matter of
 * days, not months.
 */
export function judgeAttemptRetention(input: RetentionInput): RetentionAction {
  if (input.ageMs < ATTEMPT_RETENTION_MS) {
    return { kind: 'keep', reason: 'recent enough that a specific round may still be debugged' }
  }
  return {
    kind: 'summarise',
    reason: 'older than the debugging window; the per-stage counts and timings survive',
  }
}

/**
 * Findings.
 *
 * Kept indefinitely, and this is the one rule with no age term. The adoption
 * metric reads them, and a metric whose denominator quietly shrinks over time
 * does not degrade gracefully — it reports a CHANGING number for an unchanged
 * past, which is worse than reporting nothing.
 */
export function judgeFindingRetention(): RetentionAction {
  return {
    kind: 'keep',
    reason: 'the adoption metric reads these; a shrinking denominator invents a trend',
  }
}

/**
 * Frozen artifacts.
 *
 * Reclaimed as soon as they are consumed or superseded, WITHOUT waiting for the
 * work item to close. Each one pins a commit in the object store against `git
 * gc`; on a busy repository, holding them until close is how a repository's
 * object store grows without anyone changing a setting.
 */
export function judgeArtifactRetention(input: {
  state: 'live' | 'consumed' | 'superseded'
  refCount: number
}): RetentionAction {
  if (input.state === 'live' && input.refCount > 0) {
    return { kind: 'keep', reason: 'something is still waiting on this exact change' }
  }
  return {
    kind: 'discard',
    reason: 'nothing references it; the keep-alive ref pins a commit against git gc',
  }
}

/**
 * Whether two rounds may share one stored template snapshot.
 *
 * Content-addressed: the same template version across 27,000 rounds is one copy
 * rather than 27,000. The digest is the identity — comparing by template id and
 * version would collide two DIFFERENT bodies that happened to share a version
 * number, which is exactly the case where sharing corrupts a round's record of
 * what it actually ran.
 */
export function snapshotKey(digest: string): string {
  return `snap:${digest}`
}
