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

const ok = (): CodeHostResult => ({ ok: true, status: 201, body: '{}', truncated: false })

const placed = (line: number, label: string) => ({
  body: `something is wrong on line ${line}`,
  anchor: added(line),
  label,
  // Distinct per finding: the publish result is keyed by fingerprint, so a
  // shared constant would make two findings look like one to the ledger.
  fingerprint: `fp-${label}-${line}`,
})

describe('RFC-304 — publishing on GitLab', () => {
  test('each finding becomes its own inline comment, then an overview', async () => {
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
      'comment.create-inline',
      'comment.create-inline',
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

  test('a host error partway carries EVERY remaining finding into the overview', async () => {
    // The invariant. Findings 2 and 3 must not vanish because finding 2 failed.
    let seen = 0
    const h = host((call) => {
      if (call.action !== 'comment.create-inline') return ok()
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
    expect(result.posted).toBe(1)
    expect(result.carriedInOverview.map((c) => c.label)).toEqual(['b', 'c'])
    expect(result.failure?.code).toBe('code-host-rate-limited')
  })

  test('the overview is still posted after a partial failure', async () => {
    // Otherwise the carried findings are computed and then thrown away, which
    // is the silent loss this whole design avoids.
    const h = host((call) =>
      call.action === 'comment.create-inline'
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
  test('the whole review is one request', async () => {
    // GitHub has no partial window: one request carries every comment, so there
    // is no half-posted state to compensate for.
    const h = host(ok)
    const result = await publishReview({
      codeHost: h,
      target: targetOf('github'),
      placed: [placed(11, 'a'), placed(12, 'b')],
      unplaced: [],
      overviewPrelude: 'Reviewed.',
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.action).toBe('review.submit')
    expect(result.posted).toBe(2)
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
    expect(h.calls.at(-1)?.params.body).toBe('Reviewed 2 files, 1 finding.')
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
