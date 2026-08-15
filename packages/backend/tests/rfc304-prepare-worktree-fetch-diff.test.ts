// RFC-304 §6 — `prepare-worktree` and `fetch-diff` running against fake ports.
//
// These two stages decide what the round is ABOUT: which commit gets reviewed
// and which diff the findings are anchored against. Every bug here is a review
// of the wrong thing that still looks like a successful review, so the tests
// below are mostly about what the stages refuse and what they stop short of.
//
// The ports are fakes rather than a real clone or a real host: the behaviour
// worth locking is the ordering and the judgement, and a test that needs a
// repository on disk gets deleted the first time it is slow.

import { describe, expect, test } from 'bun:test'
import {
  prepareWorktree,
  type PrepareWorktreeResult,
} from '../src/modules/code-capability/application/prepareWorktree'
import { fetchDiff } from '../src/modules/code-capability/application/fetchDiff'
import {
  apiProjectAddress,
  resolveTarget,
  type RoundTarget,
} from '../src/modules/code-capability/domain/resolveTarget'
import type { GitPort, GitFetchResult } from '../src/modules/code-capability/ports/gitPort'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function targetOf(over: Partial<WebhookTriggerFields> = {}): RoundTarget {
  const r = resolveTarget(
    {
      event_type: 'mr_opened',
      provider: 'gitlab',
      project_id: '41823',
      mr_iid: '412',
      commit_sha: SHA,
      repo_path: 'group/project',
      ...over,
    },
    'ep_7',
  )
  if (!r.ok) throw new Error(`fixture did not resolve: ${r.missing.join(',')}`)
  return r.target
}

/** Records what was asked for, so ordering can be asserted. */
function fakeGit(
  fetches: Record<string, GitFetchResult>,
  opts: { checkout?: { ok: true } | { ok: false; error: string } } = {},
): GitPort & { asked: string[]; checkedOut: string[] } {
  const asked: string[] = []
  const checkedOut: string[] = []
  return {
    asked,
    checkedOut,
    async fetchRef({ refspec }) {
      asked.push(refspec)
      return fetches[refspec] ?? { ok: false, error: 'couldn’t find remote ref' }
    },
    async checkoutDetached({ sha }) {
      checkedOut.push(sha)
      return opts.checkout ?? { ok: true }
    },
  }
}

describe('RFC-304 — prepare-worktree', () => {
  test('the MR ref is tried first and the worktree lands on the baseline', async () => {
    const git = fakeGit({ 'refs/merge-requests/412/head': { ok: true, resolvedSha: SHA } })
    const result = await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf(),
    })
    expect(result).toEqual({ state: 'ready', sha: SHA })
    expect(git.asked).toEqual(['refs/merge-requests/412/head'])
    expect(git.checkedOut).toEqual([SHA])
  })

  test('a successful fetch stops the chain', async () => {
    // Continuing would refetch the same commit and, worse, let a later answer
    // override the one already accepted.
    const git = fakeGit({
      'refs/merge-requests/412/head': { ok: true, resolvedSha: SHA },
      [SHA]: { ok: true, resolvedSha: SHA },
    })
    await prepareWorktree({ git, repoPath: '/repo', worktreePath: '/wt', target: targetOf() })
    expect(git.asked).toHaveLength(1)
  })

  test('a pruned MR ref falls through to the bare sha', async () => {
    const git = fakeGit({ [SHA]: { ok: true, resolvedSha: SHA } })
    const result = await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf(),
    })
    expect(result.state).toBe('ready')
    expect(git.asked).toEqual(['refs/merge-requests/412/head', SHA])
  })

  test('a head that moved is stale and NOTHING is checked out', async () => {
    // The whole point. Checking out the newer commit would review revision B
    // against revision A's diff, and every comment would be placed by a line
    // number computed from contents the reviewer never saw.
    const git = fakeGit({ 'refs/merge-requests/412/head': { ok: true, resolvedSha: NEWER } })
    const result = await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf(),
    })
    expect(result).toEqual({ state: 'stale', expectedSha: SHA, fetchedSha: NEWER })
    expect(git.checkedOut).toEqual([])
  })

  test('nothing reachable reports both refspecs and does not check out', async () => {
    const git = fakeGit({})
    const result = await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf(),
    })
    expect(result.state).toBe('unreachable')
    expect(messageOf(result)).toContain('refs/merge-requests/412/head')
    expect(messageOf(result)).toContain(SHA)
    expect(git.checkedOut).toEqual([])
  })

  test('a checkout failure is its own state, not "unreachable"', async () => {
    // The commit IS present; conflating the two sends an operator looking at
    // remote refs when the problem is a dirty or locked worktree.
    const git = fakeGit(
      { 'refs/merge-requests/412/head': { ok: true, resolvedSha: SHA } },
      { checkout: { ok: false, error: 'worktree is locked' } },
    )
    const result = await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf(),
    })
    expect(result.state).toBe('checkout-failed')
    expect(messageOf(result)).toContain('worktree is locked')
  })

  test('GitHub asks for the pull ref', async () => {
    const git = fakeGit({ 'refs/pull/412/head': { ok: true, resolvedSha: SHA } })
    await prepareWorktree({
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      target: targetOf({ provider: 'github' }),
    })
    expect(git.asked[0]).toBe('refs/pull/412/head')
  })
})

function messageOf(result: PrepareWorktreeResult): string {
  return 'message' in result ? result.message : ''
}

function fakeHost(reply: CodeHostResult): CodeHostPort & { calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    async call(call) {
      calls.push(call)
      return reply
    },
  }
}

const GITLAB_DIFF = JSON.stringify([
  {
    old_path: 'src/a.ts',
    new_path: 'src/a.ts',
    diff: '@@ -10,3 +10,4 @@\n context\n-removed\n+added\n+also added\n context2\n',
  },
  { old_path: 'img.png', new_path: 'img.png', diff: '' },
])

describe('RFC-304 — fetch-diff', () => {
  test('the host diff becomes files, a unified diff and hunks in one step', async () => {
    const host = fakeHost({ ok: true, status: 200, body: GITLAB_DIFF, truncated: false })
    const result = await fetchDiff({ codeHost: host, target: targetOf() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toHaveLength(2)
    expect(result.hunks.map((h) => h.newPath)).toEqual(['src/a.ts'])
    expect(result.omitted).toEqual([{ path: 'img.png', omission: 'binary' }])
  })

  test('the response cap is RAISED for this call', async () => {
    // The client default is sized for small JSON bodies. A diff is the one read
    // that routinely exceeds it, and an exceeded cap is refused rather than
    // parsed — so leaving the default would turn every medium MR into "too
    // large to review".
    const host = fakeHost({ ok: true, status: 200, body: GITLAB_DIFF, truncated: false })
    await fetchDiff({ codeHost: host, target: targetOf() })
    expect(host.calls[0]?.maxResponseBytes).toBeGreaterThan(1024 * 1024)
  })

  test('a truncated response fails the stage instead of reviewing a prefix', async () => {
    const host = fakeHost({ ok: true, status: 200, body: GITLAB_DIFF, truncated: true })
    const result = await fetchDiff({ codeHost: host, target: targetOf() })
    expect(!result.ok && result.reason).toBe('truncated')
  })

  test('a refused call carries the host’s own code', async () => {
    const host = fakeHost({ ok: false, code: 'code-host-auth-failed', message: 'Bad credentials' })
    const result = await fetchDiff({ codeHost: host, target: targetOf() })
    expect(!result.ok && result.reason).toBe('call-failed')
  })
})

describe('RFC-304 — addressing a project is not identifying it', () => {
  test('GitLab addresses by the same numeric id it is keyed by', async () => {
    const host = fakeHost({ ok: true, status: 200, body: '[]', truncated: false })
    await fetchDiff({ codeHost: host, target: targetOf() })
    expect(host.calls[0]?.params).toEqual({ project: '41823', mr: '412' })
  })

  test('GitHub addresses by owner/repo, NOT by the numeric id', async () => {
    // `/repos/{id}/pulls` is not a route. Sending the identity here makes every
    // call 404 while the identity itself stays correct — two different values
    // for two different jobs.
    const host = fakeHost({ ok: true, status: 200, body: '[]', truncated: false })
    await fetchDiff({ codeHost: host, target: targetOf({ provider: 'github' }) })
    expect(host.calls[0]?.params.project).toBe('group/project')
  })

  test('GitHub with no repo path refuses rather than sending the id on a hunch', async () => {
    // Refusing is the point: a path-shaped value sent on a hunch can resolve to
    // a same-named project on the wrong host, and the round then comments on a
    // stranger's code (services/codeHost/project.ts records the same rule).
    const target = targetOf({ provider: 'github', repo_path: undefined })
    expect(apiProjectAddress(target).ok).toBe(false)

    const host = fakeHost({ ok: true, status: 200, body: '[]', truncated: false })
    const result = await fetchDiff({ codeHost: host, target })
    expect(!result.ok && result.reason).toBe('unaddressable')
    expect(host.calls).toHaveLength(0)
  })

  test('a GitLab target still resolves without a repo path', async () => {
    expect(apiProjectAddress(targetOf({ repo_path: undefined }))).toEqual({
      ok: true,
      value: '41823',
    })
  })
})
