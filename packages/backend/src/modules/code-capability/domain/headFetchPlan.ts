// RFC-304 §6 — `prepare-worktree`: getting the MR's head commit into a worktree.
//
// ## Why not fetch the source branch
//
// The obvious move is "check out the MR's source branch". It works for a
// same-repo MR and fails for every fork MR, because the branch lives in another
// repository and the target clone has never heard of it. The webhook does not
// help: both adapters read the repo URL from the top-level `repository` /
// `project`, which is the TARGET project, while the branch comes from the
// source side (design §6.1 fork P1).
//
// The design's countermeasure was to freeze the SOURCE project's clone URL and
// fetch from that remote. This module takes a different route, recorded as a
// deviation in design.md §6.1:
//
//   Both hosts publish the MR head as a ref inside the TARGET repository —
//   `refs/merge-requests/{iid}/head` on GitLab, `refs/pull/{n}/head` on GitHub —
//   and those refs resolve fork heads too.
//
// Fetching from the target remote is strictly less machinery and removes a
// failure mode the source-remote route cannot avoid: the fork may be private,
// deleted, or on a host the configured token has no reach into, in which case
// there is nothing to fetch from and the review never runs. The target remote is
// the one credential the platform already holds.
//
// A ref can still be absent (housekeeping on self-managed instances prunes old
// MR refs), so the plan is an ordered chain rather than one attempt, and every
// attempt that was tried is reported when they all fail. That is the difference
// between an operator seeing `repo-ref-not-found` and seeing which two refspecs
// were tried against which remote.
//
// ## The head is a moving target
//
// Between the webhook arriving and this fetch running, the author can push
// again. The MR ref then points somewhere new, and checking out "whatever the
// ref says" would review code the round has no diff for: the findings would be
// anchored against the baseline's diff while the reviewer read a later revision.
// So the fetched commit is checked against the round's baseline, and a mismatch
// is a first-class outcome rather than an error — see `judgeFetchedHead`.

export type FetchAttemptKind = 'mr-ref' | 'commit-sha'

export interface FetchAttempt {
  readonly kind: FetchAttemptKind
  /** The refspec to hand `git fetch <remote> <refspec>`. */
  readonly refspec: string
  /** Why this attempt exists, for the failure report an operator reads. */
  readonly why: string
}

/**
 * The ordered fetch attempts for one MR head, most reliable first.
 *
 * Both entries target the same remote (the target repo's origin). The second is
 * not a duplicate of the first: fetching a bare SHA succeeds on servers that
 * allow reachable-SHA1 requests even when the MR ref has been pruned, and fails
 * where the first would have worked. Neither dominates, so both are tried.
 */
export function planHeadFetch(
  provider: 'gitlab' | 'github',
  anchorId: string,
  headSha: string,
): FetchAttempt[] {
  const mrRef =
    provider === 'gitlab' ? `refs/merge-requests/${anchorId}/head` : `refs/pull/${anchorId}/head`

  return [
    {
      kind: 'mr-ref',
      refspec: mrRef,
      why: `the host publishes the MR head under ${mrRef} in the target repository, which resolves fork heads without reaching into the fork`,
    },
    {
      kind: 'commit-sha',
      refspec: headSha,
      why: 'fetching the commit directly still works when the MR ref has been pruned, provided the server allows reachable-SHA1 requests',
    },
  ]
}

export type FetchOutcome =
  | { readonly kind: FetchAttemptKind; readonly ok: true; readonly resolvedSha: string }
  | { readonly kind: FetchAttemptKind; readonly ok: false; readonly error: string }

export type HeadVerdict =
  /** The baseline commit is in the repo and is what the round expected. */
  | { readonly state: 'ready'; readonly sha: string }
  /**
   * The head moved between the trigger and this fetch. NOT an error: the caller
   * re-arms the work item at `fetchedSha` and lets that round proceed.
   *
   * Re-arming rather than abandoning matters. Abandoning assumes the newer push
   * brings its own webhook, and that assumption fails often enough to be worth
   * designing around — the trigger may not subscribe to the event, or the host
   * may coalesce a rapid force-push into nothing. In those cases abandoning
   * means the MR is never reviewed at all, and the only symptom is silence.
   */
  | { readonly state: 'stale'; readonly expectedSha: string; readonly fetchedSha: string }
  /** Nothing reachable. Carries every attempt so the failure is diagnosable. */
  | {
      readonly state: 'unreachable'
      readonly expectedSha: string
      readonly attempts: ReadonlyArray<{ refspec: string; error: string }>
    }

/**
 * Decide what the fetch outcomes mean for the round.
 *
 * Takes the outcomes in attempt order and stops at the first success — the
 * caller is expected to stop fetching there too, but judging is kept separate
 * from fetching so this rule is testable without a git repository.
 */
export function judgeFetchedHead(input: {
  expectedSha: string
  plan: readonly FetchAttempt[]
  outcomes: readonly FetchOutcome[]
}): HeadVerdict {
  const { expectedSha, plan, outcomes } = input

  for (const outcome of outcomes) {
    if (!outcome.ok) continue
    return outcome.resolvedSha === expectedSha
      ? { state: 'ready', sha: expectedSha }
      : { state: 'stale', expectedSha, fetchedSha: outcome.resolvedSha }
  }

  // Report against the PLAN, not just the outcomes: an attempt that never ran
  // (the executor gave up early, the signal fired) is still something the
  // operator needs to see listed, otherwise the report reads as "we tried
  // everything" when we did not.
  const attempts = plan.map((attempt, index) => {
    const outcome = outcomes[index]
    return {
      refspec: attempt.refspec,
      error: outcome === undefined ? 'not attempted' : outcome.ok ? '' : outcome.error,
    }
  })
  return { state: 'unreachable', expectedSha, attempts }
}

/**
 * A one-line explanation of an unreachable head, for the event log.
 *
 * Spelled out rather than left to a generic error because this is the failure a
 * user meets as "the bot never responded to my MR", and the difference between
 * a pruned ref and a token without reach is the whole diagnosis.
 */
export function describeUnreachable(
  verdict: Extract<HeadVerdict, { state: 'unreachable' }>,
): string {
  const tried = verdict.attempts.map((a) => `${a.refspec} (${a.error})`).join('; ')
  return `cannot reach commit ${verdict.expectedSha} in the target repository — tried: ${tried}`
}
