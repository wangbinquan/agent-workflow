// RFC-304 §6 — getting the MR head into a worktree, and knowing when not to.
//
// Two failure modes are covered here, and neither announces itself:
//
//   1. A fork MR. Checking out the source branch works on every same-repo MR a
//      developer tests with, and fails on every fork MR. The symptom is "the bot
//      ignores MRs from contributors" with one `repo-ref-not-found` in the log.
//
//   2. A head that moved. The author pushes again between the webhook and the
//      fetch. Checking out whatever the ref now points at means the reviewer
//      reads revision B while the findings are anchored against revision A's
//      diff — every comment then lands on a line chosen from the wrong file
//      contents, and nothing in the output says so.

import { describe, expect, test } from 'bun:test'
import {
  describeUnreachable,
  judgeFetchedHead,
  planHeadFetch,
  type FetchOutcome,
} from '../src/modules/code-capability/domain/headFetchPlan'

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('RFC-304 — which refs a head fetch tries', () => {
  test('GitLab reaches for the MR ref in the TARGET repo', () => {
    // Not the source branch: a fork MR's branch does not exist in the target
    // clone, and `fetch --all` cannot conjure a ref from another repository.
    const [first] = planHeadFetch('gitlab', '412', SHA)
    expect(first?.refspec).toBe('refs/merge-requests/412/head')
    expect(first?.kind).toBe('mr-ref')
  })

  test('GitHub reaches for the PR ref in the base repo', () => {
    const [first] = planHeadFetch('github', '77', SHA)
    expect(first?.refspec).toBe('refs/pull/77/head')
  })

  test('the plan never names a branch', () => {
    // The branch is exactly what breaks on forks; a plan that mentions one has
    // regressed to the shape this module exists to replace.
    const refspecs = planHeadFetch('gitlab', '412', SHA).map((a) => a.refspec)
    expect(refspecs.join(' ')).not.toContain('refs/heads/')
  })

  test('a bare sha fetch backs up the MR ref', () => {
    // Self-managed housekeeping prunes old MR refs. Neither attempt dominates
    // the other, so a single-attempt plan would leave real MRs unreachable.
    const plan = planHeadFetch('gitlab', '412', SHA)
    expect(plan).toHaveLength(2)
    expect(plan[1]).toMatchObject({ kind: 'commit-sha', refspec: SHA })
  })

  test('every attempt carries a reason', () => {
    // The reasons are what the operator reads when both fail; an attempt with
    // an empty `why` produces a report that lists refspecs and explains nothing.
    for (const attempt of planHeadFetch('github', '77', SHA)) {
      expect(attempt.why.length).toBeGreaterThan(20)
    }
  })
})

describe('RFC-304 — judging what came back', () => {
  const plan = planHeadFetch('gitlab', '412', SHA)

  test('the expected commit ⇒ ready', () => {
    const outcomes: FetchOutcome[] = [{ kind: 'mr-ref', ok: true, resolvedSha: SHA }]
    expect(judgeFetchedHead({ expectedSha: SHA, plan, outcomes })).toEqual({
      state: 'ready',
      sha: SHA,
    })
  })

  test('the first success wins and later attempts are not consulted', () => {
    const outcomes: FetchOutcome[] = [
      { kind: 'mr-ref', ok: true, resolvedSha: SHA },
      { kind: 'commit-sha', ok: false, error: 'should never be read' },
    ]
    expect(judgeFetchedHead({ expectedSha: SHA, plan, outcomes }).state).toBe('ready')
  })

  test('the fallback carries the round when the MR ref is gone', () => {
    const outcomes: FetchOutcome[] = [
      { kind: 'mr-ref', ok: false, error: 'couldn’t find remote ref' },
      { kind: 'commit-sha', ok: true, resolvedSha: SHA },
    ]
    expect(judgeFetchedHead({ expectedSha: SHA, plan, outcomes }).state).toBe('ready')
  })

  test('a moved head is stale, NOT ready — and carries the new sha', () => {
    // The critical case. Returning `ready` here would review revision B against
    // revision A's diff, placing every comment by a line number computed from
    // contents the reviewer never saw.
    const outcomes: FetchOutcome[] = [{ kind: 'mr-ref', ok: true, resolvedSha: NEWER }]
    const verdict = judgeFetchedHead({ expectedSha: SHA, plan, outcomes })
    expect(verdict).toEqual({ state: 'stale', expectedSha: SHA, fetchedSha: NEWER })
  })

  test('stale reports the newer sha so the round can re-arm rather than vanish', () => {
    // Dropping the round assumes the newer push brings its own webhook. When it
    // does not — the trigger does not subscribe to that event, or the host
    // coalesced a force-push — the MR is never reviewed and the only symptom is
    // silence. The new sha is what makes re-arming possible.
    const outcomes: FetchOutcome[] = [{ kind: 'mr-ref', ok: true, resolvedSha: NEWER }]
    const verdict = judgeFetchedHead({ expectedSha: SHA, plan, outcomes })
    expect(verdict.state === 'stale' && verdict.fetchedSha).toBe(NEWER)
  })
})

describe('RFC-304 — when nothing is reachable', () => {
  const plan = planHeadFetch('gitlab', '412', SHA)

  test('all attempts failing reports every refspec with its own error', () => {
    const outcomes: FetchOutcome[] = [
      { kind: 'mr-ref', ok: false, error: 'couldn’t find remote ref' },
      {
        kind: 'commit-sha',
        ok: false,
        error: 'server does not allow request for unadvertised object',
      },
    ]
    const verdict = judgeFetchedHead({ expectedSha: SHA, plan, outcomes })
    expect(verdict.state).toBe('unreachable')
    expect(verdict.state === 'unreachable' && verdict.attempts).toEqual([
      { refspec: 'refs/merge-requests/412/head', error: 'couldn’t find remote ref' },
      { refspec: SHA, error: 'server does not allow request for unadvertised object' },
    ])
  })

  test('an attempt that never ran says so rather than being omitted', () => {
    // A report listing only what was tried reads as "we tried everything". If
    // the executor stopped early, the operator has to be able to see that.
    const verdict = judgeFetchedHead({
      expectedSha: SHA,
      plan,
      outcomes: [{ kind: 'mr-ref', ok: false, error: 'network unreachable' }],
    })
    expect(verdict.state === 'unreachable' && verdict.attempts[1]?.error).toBe('not attempted')
  })

  test('zero outcomes is unreachable, not ready', () => {
    // An executor that returned nothing at all must not read as success.
    const verdict = judgeFetchedHead({ expectedSha: SHA, plan, outcomes: [] })
    expect(verdict.state).toBe('unreachable')
  })

  test('the description names the commit and each thing tried', () => {
    const verdict = judgeFetchedHead({
      expectedSha: SHA,
      plan,
      outcomes: [
        { kind: 'mr-ref', ok: false, error: 'couldn’t find remote ref' },
        { kind: 'commit-sha', ok: false, error: 'unadvertised object' },
      ],
    })
    if (verdict.state !== 'unreachable') throw new Error('expected unreachable')
    const text = describeUnreachable(verdict)
    expect(text).toContain(SHA)
    expect(text).toContain('refs/merge-requests/412/head')
    expect(text).toContain('unadvertised object')
  })
})
