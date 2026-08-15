// RFC-304 §6 — `prepare-worktree`, executed.
//
// The decisions live in `domain/headFetchPlan.ts`; this runs them against a
// repository. It is thin on purpose — the interesting behaviour (which refs to
// try, what a moved head means, what an operator is told when nothing is
// reachable) is all in the pure layer where it can be tested without a clone.

import {
  describeUnreachable,
  judgeFetchedHead,
  planHeadFetch,
  type FetchOutcome,
} from '@/modules/code-capability/domain/headFetchPlan'
import type { RoundTarget } from '@/modules/code-capability/domain/resolveTarget'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'

export type PrepareWorktreeResult =
  /** The worktree is at the round's baseline commit. */
  | { readonly state: 'ready'; readonly sha: string }
  /**
   * The head moved. The caller re-arms the work item at `fetchedSha`; it does
   * NOT fail the round, and it does not proceed either.
   */
  | { readonly state: 'stale'; readonly expectedSha: string; readonly fetchedSha: string }
  /** The baseline commit could not be reached; `message` lists every attempt. */
  | { readonly state: 'unreachable'; readonly message: string }
  /** The commit is present but the worktree could not be moved onto it. */
  | { readonly state: 'checkout-failed'; readonly message: string }

export async function prepareWorktree(input: {
  git: GitPort
  repoPath: string
  worktreePath: string
  target: RoundTarget
}): Promise<PrepareWorktreeResult> {
  const { git, repoPath, worktreePath, target } = input
  const plan = planHeadFetch(target.provider, target.anchorId, target.headSha)

  const outcomes: FetchOutcome[] = []
  for (const attempt of plan) {
    const result = await git.fetchRef({ repoPath, refspec: attempt.refspec })
    outcomes.push(
      result.ok
        ? { kind: attempt.kind, ok: true, resolvedSha: result.resolvedSha }
        : { kind: attempt.kind, ok: false, error: result.error },
    )
    // Stop at the first success. Continuing would fetch the same commit twice
    // and, worse, let a later attempt's answer override an earlier one.
    if (result.ok) break
  }

  const verdict = judgeFetchedHead({ expectedSha: target.headSha, plan, outcomes })
  if (verdict.state === 'stale') {
    return { state: 'stale', expectedSha: verdict.expectedSha, fetchedSha: verdict.fetchedSha }
  }
  if (verdict.state === 'unreachable') {
    return { state: 'unreachable', message: describeUnreachable(verdict) }
  }

  const checkout = await git.checkoutDetached({ worktreePath, sha: verdict.sha })
  if (!checkout.ok) {
    return {
      state: 'checkout-failed',
      message: `fetched ${verdict.sha} but could not move the worktree onto it: ${checkout.error}`,
    }
  }
  return { state: 'ready', sha: verdict.sha }
}
