// RFC-304 §6.1 — one whole round of `mr-review`, from trigger to comment.
//
// Every stage has its own tests; this one is about the SEAMS, which is where a
// chain of individually-correct steps still produces a wrong review:
//
//   - a stale head must abort before the model is called at all (otherwise the
//     round pays for a review of a revision that is already obsolete, and then
//     posts it);
//   - the gate must run BEFORE positions (otherwise findings are anchored and
//     then discarded, and anchoring failures are reported for remarks nobody
//     was going to see);
//   - a reviewer that never conforms must publish NOTHING (constitution R5);
//   - a finding whose line is not in the diff must still reach the author,
//     through the overview.

import { describe, expect, test } from 'bun:test'
import { runMrReviewRound } from '../src/modules/code-capability/application/mrReviewRound'
import {
  resolveTarget,
  type RoundTarget,
} from '../src/modules/code-capability/domain/resolveTarget'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NONCE = 'roundnonce'

function targetOf(provider: 'gitlab' | 'github' = 'gitlab'): RoundTarget {
  const r = resolveTarget(
    {
      event_type: 'mr_opened',
      provider,
      project_id: '41823',
      mr_iid: '412',
      commit_sha: HEAD,
      repo_path: 'group/project',
      mr_title: 'Add retry logic',
    },
    'ep_7',
  )
  if (!r.ok) throw new Error('fixture did not resolve')
  return r.target
}

const PATCH = '@@ -10,3 +10,4 @@\n context\n-removed\n+added one\n+added two\n context2\n'

// The two hosts answer `mr.diff` in different shapes, and serving the wrong one
// is not a harmless fixture detail: normalization correctly yields NO files, so
// nothing anchors and every finding degrades into the overview. That is exactly
// what a real provider-shape mismatch would look like in production, which is
// why each provider gets its own body here.
const GITLAB_DIFF_BODY = [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH }]
const GITHUB_DIFF_BODY = [
  { filename: 'src/a.ts', status: 'modified', patch: PATCH, additions: 2, deletions: 1 },
]

const MR_BODY = {
  title: 'Add retry logic',
  diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: HEAD },
}

const okJson = (body: unknown): CodeHostResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(body),
  truncated: false,
})

function fakeHost(
  over: Partial<Record<string, CodeHostResult>> = {},
  provider: 'gitlab' | 'github' = 'gitlab',
) {
  const calls: CodeHostCall[] = []
  const port: CodeHostPort = {
    async call(call) {
      calls.push(call)
      if (over[call.action] !== undefined) return over[call.action]!
      if (call.action === 'mr.get') return okJson(MR_BODY)
      if (call.action === 'mr.diff') {
        return okJson(provider === 'github' ? GITHUB_DIFF_BODY : GITLAB_DIFF_BODY)
      }
      return okJson({ id: 1 })
    },
  }
  return { port, calls }
}

function fakeGit(resolvedSha = HEAD): GitPort {
  return {
    async fetchRef() {
      return { ok: true, resolvedSha }
    },
    async checkoutDetached() {
      return { ok: true }
    },
  }
}

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

function model(stdout: string) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    makeCaller: () => async () => {
      calls += 1
      return { stdout, sessionId: 's1' }
    },
  }
}

const FINDING = {
  file: 'src/a.ts',
  line: 11,
  severity: 'major',
  title: 'unchecked index',
  body: 'This can be undefined.',
}

const run = (opts: {
  host?: ReturnType<typeof fakeHost>
  git?: GitPort
  stdout?: string
  provider?: 'gitlab' | 'github'
  maxPerRound?: number
  threshold?: 'blocker' | 'major' | 'minor' | 'info'
  ai?: ReturnType<typeof model>
}) => {
  const host = opts.host ?? fakeHost({}, opts.provider)
  const ai = opts.ai ?? model(opts.stdout ?? envelope([FINDING]))
  return runMrReviewRound({
    codeHost: host.port,
    git: opts.git ?? fakeGit(),
    target: targetOf(opts.provider),
    repoPath: '/repo',
    worktreePath: '/wt',
    makeCaller: ai.makeCaller,
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 1, freshSession: 0 },
    gate: { threshold: opts.threshold ?? 'info', maxPerRound: opts.maxPerRound ?? 20 },
  })
}

describe('RFC-304 — a round that works', () => {
  test('a finding on a changed line ends up as an inline comment', async () => {
    const host = fakeHost()
    const result = await run({ host })
    expect(result).toMatchObject({ state: 'published', posted: 1, carried: 0, failure: null })
    expect(host.calls.map((c) => c.action)).toEqual([
      'mr.get',
      'mr.diff',
      'comment.create-inline',
      'comment.create',
    ])
  })

  test('the comment carries the severity, the title and the explanation', async () => {
    const host = fakeHost()
    await run({ host })
    const body = String(host.calls.find((c) => c.action === 'comment.create-inline')?.params.body)
    expect(body).toContain('**Major — unchecked index**')
    expect(body).toContain('This can be undefined.')
  })

  test('an empty review still posts an overview saying so', async () => {
    // Silence would be indistinguishable from a broken bot.
    const host = fakeHost()
    const result = await run({ host, stdout: envelope([]) })
    expect(result).toMatchObject({ state: 'published', posted: 0 })
    const overview = String(host.calls.at(-1)?.params.body)
    expect(overview).toContain('no findings this round')
  })

  test('GitHub takes the whole round as one review', async () => {
    const host = fakeHost({}, 'github')
    const result = await run({ host, provider: 'github' })
    expect(result).toMatchObject({ state: 'published', posted: 1 })
    expect(host.calls.map((c) => c.action)).toEqual(['mr.get', 'mr.diff', 'review.submit'])
  })
})

describe('RFC-304 — a stale head stops the round early', () => {
  test('a moved head aborts BEFORE the model is called', async () => {
    // Paying for a review of an obsolete revision is the smaller half of the
    // cost; publishing it is the larger one.
    const ai = model(envelope([FINDING]))
    const host = fakeHost()
    const result = await run({ host, git: fakeGit(NEWER), ai })
    expect(result).toEqual({ state: 'stale', fetchedSha: NEWER })
    expect(ai.calls).toBe(0)
    expect(host.calls).toHaveLength(0)
  })
})

describe('RFC-304 — nothing is published on a bad review', () => {
  test('a reviewer that never conforms publishes NOTHING', async () => {
    // Constitution R5. A best-effort value escaping here would be posted as a
    // review comment with nothing marking it unvalidated.
    const host = fakeHost()
    const result = await run({ host, stdout: 'no envelope here' })
    expect(result).toMatchObject({ state: 'aborted', stage: 'review' })
    expect(host.calls.some((c) => c.action.startsWith('comment.'))).toBe(false)
  })

  test('a diff the host would not return aborts before the model runs', async () => {
    const ai = model(envelope([FINDING]))
    const host = fakeHost({
      'mr.diff': { ok: false, code: 'code-host-forbidden', message: 'no access' },
    })
    const result = await run({ host, ai })
    expect(result).toMatchObject({ state: 'aborted', stage: 'fetch-diff' })
    expect(ai.calls).toBe(0)
  })

  test('a GitLab MR with no diff_refs is named, not left to fail per comment', async () => {
    const host = fakeHost({ 'mr.get': okJson({ title: 'x' }) })
    const result = await run({ host })
    expect(result).toMatchObject({ state: 'aborted', stage: 'mr.get' })
    expect(result.state === 'aborted' && result.message).toContain('diff_refs')
  })
})

describe('RFC-304 — the gate runs before positions', () => {
  test('a below-threshold finding is never positioned or posted', async () => {
    const host = fakeHost()
    const result = await run({
      host,
      stdout: envelope([{ ...FINDING, severity: 'info' }]),
      threshold: 'major',
    })
    expect(result).toMatchObject({ state: 'published', posted: 0, carried: 0 })
    expect(host.calls.some((c) => c.action === 'comment.create-inline')).toBe(false)
    expect(String(host.calls.at(-1)?.params.body)).toContain('below the configured severity')
  })

  test('cap-withheld findings are counted in the overview, not silently dropped', async () => {
    const host = fakeHost()
    await run({
      host,
      stdout: envelope([FINDING, { ...FINDING, line: 12, title: 'second' }]),
      maxPerRound: 1,
    })
    expect(String(host.calls.at(-1)?.params.body)).toContain('withheld by the per-round limit')
  })
})

describe('RFC-304 — a finding that cannot be placed still reaches the author', () => {
  test('a line outside the diff rides the overview', async () => {
    // AC-3/AC-4: not a validation failure, not a retry, and above all not a
    // finding that disappears.
    const host = fakeHost()
    const result = await run({ host, stdout: envelope([{ ...FINDING, line: 900 }]) })
    expect(result).toMatchObject({ state: 'published', posted: 0, carried: 1 })
    const overview = String(host.calls.at(-1)?.params.body)
    expect(overview).toContain('could not be placed')
    expect(overview).toContain('unchecked index')
  })

  test('a finding on an untouched file rides the overview too', async () => {
    const host = fakeHost()
    const result = await run({ host, stdout: envelope([{ ...FINDING, file: 'src/elsewhere.ts' }]) })
    expect(result).toMatchObject({ state: 'published', posted: 0, carried: 1 })
  })

  test('placed and unplaced findings coexist in one round', async () => {
    const host = fakeHost()
    const result = await run({
      host,
      stdout: envelope([FINDING, { ...FINDING, line: 900, title: 'elsewhere' }]),
    })
    expect(result).toMatchObject({ state: 'published', posted: 1, carried: 1 })
    expect(String(host.calls.at(-1)?.params.body)).toContain('2 findings')
  })
})
