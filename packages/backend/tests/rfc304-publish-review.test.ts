// RFC-304 §6.1 — putting the review on the MR.
//
// The invariant this suite exists to hold is that **a finding is never silently
// lost**. A review that posts four of seven findings and says nothing about the
// other three is worse than one that posts none: the author reasonably reads
// the four as the whole answer and closes the MR.
//
// So every path that drops a finding off the inline lane — an unbuildable
// position, a host error partway through — is asserted to carry that finding
// into the overview instead. The provider split is real and load-bearing:
// GitLab posts one request per comment (partial failures exist), GitHub sends
// one review (they cannot).

import { describe, expect, test } from 'bun:test'
import { publishReview } from '../src/modules/code-capability/application/publishReview'
import { OVERVIEW_MARKER } from '../src/modules/code-capability/domain/publishReconcileRemote'
import {
  resolveTarget,
  type RoundTarget,
} from '../src/modules/code-capability/domain/resolveTarget'
import type { AnchoredLine } from '../src/modules/code-capability/domain/reviewPosition'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const REFS = { baseSha: 'base', startSha: 'start', headSha: HEAD }

function targetOf(provider: 'gitlab' | 'github' = 'gitlab'): RoundTarget {
  const r = resolveTarget(
    {
      event_type: 'mr_opened',
      provider,
      project_id: '41823',
      mr_iid: '412',
      commit_sha: HEAD,
      repo_path: 'group/project',
    },
    'ep_7',
  )
  if (!r.ok) throw new Error('fixture did not resolve')
  return r.target
}

const added = (line: number): AnchoredLine => ({
  kind: 'added',
  oldPath: 'src/a.ts',
  oldLine: null,
  newPath: 'src/a.ts',
  newLine: line,
})

/** An anchor no provider can address — both sides missing. */
const unbuildable: AnchoredLine = {
  kind: 'added',
  oldPath: null,
  oldLine: null,
  newPath: null,
  newLine: null,
}

function host(
  replies: (call: CodeHostCall) => CodeHostResult,
): CodeHostPort & { calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    async call(call) {
      calls.push(call)
      return replies(call)
    },
  }
}

// Every create returns an id, because both hosts do: GitLab's draft_notes POST
// returns the draft note, and a draft whose id we never learned is a draft we
// can never withdraw. A fixture returning `{}` would quietly exercise the
// can't-compensate path on every test.
let nextId = 0
const ok = (): CodeHostResult => ({
  ok: true,
  status: 201,
  body: JSON.stringify({ id: `id-${++nextId}` }),
  truncated: false,
})

const placed = (line: number, label: string) => ({
  body: `something is wrong on line ${line}`,
  anchor: added(line),
  label,
  // Distinct per finding: the publish result is keyed by fingerprint, so a
  // shared constant would make two findings look like one to the ledger.
  fingerprint: `fp-${label}-${line}`,
})

describe('RFC-304 — publishing on GitLab', () => {
  test('findings are STAGED as drafts and published in one call (T29)', async () => {
    // PR-4b replaced the comment-per-request loop. The author now sees the whole
    // review appear at once rather than watching it arrive line by line — and,
    // more importantly, a failure part-way can be withdrawn (below).
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed 2 files.',
    })
    expect(result.posted).toBe(2)
    expect(result.overviewPosted).toBe(true)
    expect(h.calls.map((c) => c.action)).toEqual([
      'review.draft-create',
      'review.draft-create',
      'review.draft-publish',
      // The published discussions have new ids — `bulk_publish` does not keep
      // the drafts' — so they are read back before the ledger records them.
      'comment.list',
      // And again, at MR-comment scope, to find the overview this platform left
      // last round: there is ONE overview and each round edits it.
      'comment.list',
      'comment.create',
    ])
  })

  test('the position carries the diff refs GitLab requires', async () => {
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: '',
    })
    const position = JSON.parse(String(h.calls[0]?.params.position))
    expect(position).toMatchObject({
      base_sha: 'base',
      start_sha: 'start',
      head_sha: HEAD,
      new_path: 'src/a.ts',
      new_line: 11,
    })
  })

  test('missing diff refs refuse UP FRONT rather than failing once per comment', async () => {
    // Without them GitLab rejects every position, so attempting would look like
    // a host outage instead of a missing input — and would post N failures.
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(result.failure?.code).toBe('diff-refs-missing')
    expect(h.calls).toHaveLength(0)
  })

  test('a staging failure WITHDRAWS the drafts that landed', async () => {
    // The reason drafts are worth the extra calls. Under the old
    // comment-per-request loop, findings 1 stayed on the MR while 2 and 3 did
    // not — a review that is visibly half-finished and cannot be undone.
    // Now the partial batch is deleted and the MR looks untouched.
    let seen = 0
    const h = host((call) => {
      if (call.action !== 'review.draft-create') return ok()
      seen += 1
      return seen === 2 ? { ok: false, code: 'code-host-rate-limited', message: 'slow down' } : ok()
    })
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a'), placed(12, 'b'), placed(13, 'c')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(result.posted).toBe(0)
    // The two that DID stage are discarded — not the one that failed, which
    // never existed remotely. Compensating the failed one is the easy
    // inversion, and it would delete nothing while leaving the batch on show.
    expect(h.calls.filter((c) => c.action === 'review.draft-discard')).toHaveLength(2)
    expect(h.calls.some((c) => c.action === 'review.draft-publish')).toBe(false)
  })

  test('a withdrawn batch still reaches the author, through the overview', async () => {
    // Withdrawing must not mean discarding. The findings are real; they just
    // could not be placed on lines, so they ride the overview instead.
    const h = host((call) =>
      call.action === 'review.draft-create'
        ? { ok: false, code: 'code-host-rate-limited', message: 'slow down' }
        : ok(),
    )
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(result.carriedInOverview.map((c) => c.label).sort()).toEqual(['a', 'b'])
    expect(result.failure?.code).toBe('draft-staging-failed')
  })

  test('a draft that could NOT be withdrawn is named, not hidden', async () => {
    // The one outcome the whole draft mechanism exists to prevent: notes left
    // on the MR that will never be published. If withdrawal itself fails, the
    // round must say so — a message claiming a clean withdrawal would send
    // somebody looking for a problem they were told did not exist.
    let created = 0
    const h = host((call) => {
      if (call.action === 'review.draft-create') {
        created += 1
        return created === 2
          ? { ok: false, code: 'code-host-rate-limited', message: 'slow down' }
          : ok()
      }
      if (call.action === 'review.draft-discard') {
        return { ok: false, code: 'code-host-forbidden', message: 'cannot delete' }
      }
      return ok()
    })
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(result.failure?.code).toBe('draft-staging-failed')
    expect(String(result.failure?.message)).toContain('could NOT be withdrawn')
  })

  test('a publish that fails after staging also withdraws the drafts', async () => {
    // The second window: everything staged, the bulk publish rejected. Leaving
    // them would put a batch of never-published drafts on the MR — visible, and
    // reading as a bot that got halfway and stopped.
    const h = host((call) =>
      call.action === 'review.draft-publish'
        ? { ok: false, code: 'code-host-forbidden', message: 'no' }
        : ok(),
    )
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(h.calls.filter((c) => c.action === 'review.draft-discard')).toHaveLength(2)
    expect(result.posted).toBe(0)
    expect(result.carriedInOverview).toHaveLength(2)
  })

  test('the overview is still posted after a partial failure', async () => {
    // Otherwise the carried findings are computed and then thrown away, which
    // is the silent loss this whole design avoids.
    const h = host((call) =>
      call.action === 'review.draft-create'
        ? { ok: false, code: 'code-host-forbidden', message: 'no' }
        : ok(),
    )
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(result.overviewPosted).toBe(true)
    const overview = String(h.calls.at(-1)?.params.body)
    expect(overview).toContain('could not be placed')
    expect(overview).toContain('something is wrong on line 11')
  })

  test('an unbuildable position degrades instead of failing the round', async () => {
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [
        { body: 'x', anchor: unbuildable, label: 'broken', fingerprint: 'fp-broken' },
        placed(11, 'a'),
      ],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: '',
    })
    expect(result.posted).toBe(1)
    expect(result.failure).toBeNull()
    expect(result.carriedInOverview.map((c) => c.label)).toEqual(['broken'])
  })
})

describe('RFC-304 — publishing on GitHub', () => {
  test('the whole review is ONE write, so there is no half-posted state', async () => {
    // GitHub has no partial window: one request carries every comment, so there
    // is nothing to compensate for.
    //
    // Asserted as "one WRITE" rather than "one call": PR-4b added a read-back
    // afterwards to recover the per-comment ids GitHub's review response does
    // not return. A read cannot create a half-posted state, so it does not
    // weaken this property — but a second WRITE would, and that is what this
    // guards.
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      overviewPrelude: 'Reviewed.',
    })
    const writes = h.calls.filter((c) => c.action !== 'comment.list')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.action).toBe('review.submit')
    expect(result.posted).toBe(2)
  })

  test('the comment ids are read back, so a finding can be settled later', async () => {
    // Without them every GitHub finding lands in the ledger with a null thread
    // and `settle-stale` can never say the problem is gone — the remark just
    // goes quiet.
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: 'Reviewed.',
    })
    expect(h.calls.some((c) => c.action === 'comment.list')).toBe(true)
  })

  test('the review is pinned to the head sha the round actually read', async () => {
    // Omitting commit_id makes GitHub attach the review to the PR's LATEST
    // commit. A push landing mid-review would then move every comment onto a
    // revision the reviewer never saw, with line numbers from the one it did.
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(h.calls[0]?.params.commit_id).toBe(HEAD)
  })

  test('the review comments carry path, line and side', async () => {
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(JSON.parse(String(h.calls[0]?.params.comments))).toEqual([
      { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'something is wrong on line 11' },
    ])
  })

  test('it submits as a comment, never as an approval', async () => {
    // Pressing approve on someone's behalf is outside the product boundary.
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(h.calls[0]?.params.review_event).toBe('COMMENT')
  })

  test('a failed submit posts nothing and says so', async () => {
    const h = host(() => ({ ok: false, code: 'code-host-forbidden', message: 'no' }))
    const result = await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(result.posted).toBe(0)
    expect(result.overviewPosted).toBe(false)
    expect(result.failure?.code).toBe('code-host-forbidden')
  })
})

describe('RFC-304 — the overview is the safety net', () => {
  test('findings degraded earlier are carried too', async () => {
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a')],
      unplaced: [
        {
          body: 'about an untouched file',
          label: 'z',
          reason: 'file-not-in-diff',
          fingerprint: 'fp-z',
        },
      ],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed.',
    })
    expect(result.carriedInOverview.map((c) => c.label)).toEqual(['z'])
    expect(String(h.calls.at(-1)?.params.body)).toContain('about an untouched file')
  })

  test('with nothing carried the overview is exactly the prelude', async () => {
    // No empty "could not be placed" heading on a clean run.
    const h = host(ok)
    await publishReview({
      codeHost: h,
      target: targetOf(),
      placed: [placed(11, 'a')],
      unplaced: [],
      diffRefs: REFS,
      overviewPrelude: 'Reviewed 2 files, 1 finding.',
    })
    // The visible content is exactly the prelude — nothing invented. The marker
    // is an HTML comment a reader never sees, and it is what lets the NEXT round
    // find and edit this same comment instead of posting another one.
    const body = String(h.calls.at(-1)?.params.body)
    expect(body).toContain('Reviewed 2 files, 1 finding.')
    expect(body.replace(OVERVIEW_MARKER, '').trim()).toBe('Reviewed 2 files, 1 finding.')
  })

  test('an unaddressable GitHub target refuses before any call', async () => {
    const target = { ...targetOf('github'), meta: { title: null, url: null, repoPath: null } }
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target,
      placed: [placed(11, 'a')],
      unplaced: [],
      overviewPrelude: '',
    })
    expect(result.failure?.code).toBe('unaddressable')
    expect(h.calls).toHaveLength(0)
  })
})
