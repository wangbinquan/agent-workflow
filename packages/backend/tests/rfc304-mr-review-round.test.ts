// RFC-304 §6.1 — one whole round of `mr-review`, driven the way production
// drives it: through `createCodeCapabilityRunner` and the stage engine.
//
// Going through the runner rather than calling a chain function directly is the
// point of this file. The engine is what enforces stage ORDER, writes a row per
// stage, and fires hooks at each boundary; a test that called the stages itself
// would pass while the real path was mis-registered, mis-ordered, or hookless.
// An earlier draft of PR-4a did exactly that — one function running the whole
// chain — and it would have shipped a capability whose hooks never fire.
//
// What is exercised here is the SEAMS, since each stage has its own unit tests:
//
//   - a stale head aborts before the model is called at all;
//   - the gate runs BEFORE positions, so nothing withheld is ever positioned;
//   - a reviewer that never conforms publishes NOTHING (constitution R5);
//   - a finding that cannot be anchored still reaches the author, via the
//     overview;
//   - every stage lands a row, in contract order.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  mrReviewAiStages,
  mrReviewProgramStages,
  type MrReviewEnvironment,
} from '../src/modules/code-capability/composition/mrReviewStages'
import { readRoundStages } from '../src/modules/code-capability/application/stageEngine'
import type {
  CodeHostCall,
  CodeHostPort,
  CodeHostResult,
} from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import { createGitPortFake } from './helpers/gitPortFake'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEWER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NONCE = 'roundnonce'

const webhookOf = (provider: 'gitlab' | 'github' = 'gitlab'): WebhookTriggerFields => ({
  event_type: 'mr_opened',
  provider,
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  mr_title: 'Add retry logic',
})

const PATCH = '@@ -10,3 +10,4 @@\n context\n-removed\n+added one\n+added two\n context2\n'

// Each host answers `mr.diff` in its own shape; serving the wrong one yields no
// files at all, which is what a real provider mismatch looks like.
const GITLAB_DIFF = [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH }]
const GITHUB_DIFF = [
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
        return okJson(provider === 'github' ? GITHUB_DIFF : GITLAB_DIFF)
      }
      return okJson({ id: 1 })
    },
  }
  return { port, calls }
}

const fakeGit = (resolvedSha = HEAD): GitPort => createGitPortFake({ resolvedSha })

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

function scriptedModel(stdout: string) {
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

interface RunOpts {
  host: ReturnType<typeof fakeHost>
  ai: ReturnType<typeof scriptedModel>
  home: string
  git?: GitPort
  provider?: 'gitlab' | 'github'
  gate?: { threshold: 'blocker' | 'major' | 'minor' | 'info'; maxPerRound: number }
}

/** Exactly the production wiring: name→stage maps handed to the real runner. */
function runRound(db: DbClient, opts: RunOpts) {
  const env: MrReviewEnvironment = {
    codeHost: opts.host.port,
    git: opts.git ?? fakeGit(),
    webhook: webhookOf(opts.provider),
    codeHostEndpointId: 'ep_7',
    repoPath: opts.home,
    worktreePath: opts.home,
    makeCaller: opts.ai.makeCaller,
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 1, freshSession: 0 },
    gate: opts.gate ?? { threshold: 'info', maxPerRound: 20 },
  }
  const runner = createCodeCapabilityRunner({
    db,
    programStages: mrReviewProgramStages(env),
    aiStages: mrReviewAiStages(env),
  })
  const roundId = ulid()
  return runner
    .runRound({
      roundId,
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: opts.home,
      repos: [{ name: 'main', path: opts.home }],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })
    .then((outcome) => ({ outcome, roundId }))
}

describe('RFC-304 — mr-review through the real runner', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-round-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a finding on a changed line becomes an inline comment', async () => {
    const host = fakeHost()
    const { outcome } = await runRound(db, { host, ai: scriptedModel(envelope([FINDING])), home })
    expect(outcome.outcome).toBe('done')
    expect(host.calls.map((c) => c.action)).toEqual([
      'mr.get',
      'mr.diff',
      // T29: staged as a draft, published in one call, then read back for the
      // discussion id (`bulk_publish` does not keep the draft's).
      'review.draft-create',
      'review.draft-publish',
      // Read back for the discussion ids, then again at MR-comment scope to
      // find the overview to edit (there is one, not one per round).
      'comment.list',
      'comment.list',
      'comment.create',
    ])
  })

  test('every contract stage lands a row, in order', async () => {
    // The property only the engine path can show: a chain function running the
    // stages internally would produce one row, or none.
    const { roundId } = await runRound(db, {
      host: fakeHost(),
      ai: scriptedModel(envelope([FINDING])),
      home,
    })
    const rows = await readRoundStages(db, roundId)
    expect(rows.map((r) => r.stageName)).toEqual([
      'resolve-target',
      'prepare-worktree',
      'fetch-diff',
      // PR-4b: the design's sharded segment replaces the single `review`.
      'split-diff',
      'review-shard',
      'review-global',
      'validate-findings',
      'gate',
      'resolve-positions',
      // PR-4b: the two stages that make a second round differ from the first.
      'reconcile',
      'publish',
      'settle-stale',
      'ledger',
    ])
    expect(rows.every((r) => r.status === 'done')).toBe(true)
  })

  test('the comment carries severity, title and explanation', async () => {
    const host = fakeHost()
    await runRound(db, { host, ai: scriptedModel(envelope([FINDING])), home })
    const body = String(host.calls.find((c) => c.action === 'review.draft-create')?.params.body)
    expect(body).toContain('**Major — unchecked index**')
    expect(body).toContain('This can be undefined.')
  })

  test('an empty review still posts an overview saying so', async () => {
    // Silence is indistinguishable from a broken bot.
    const host = fakeHost()
    const { outcome } = await runRound(db, { host, ai: scriptedModel(envelope([])), home })
    expect(outcome.outcome).toBe('done')
    expect(String(host.calls.at(-1)?.params.body)).toContain('no findings this round')
  })

  test('GitHub takes the whole round as one review', async () => {
    const host = fakeHost({}, 'github')
    const { outcome } = await runRound(db, {
      host,
      ai: scriptedModel(envelope([FINDING])),
      home,
      provider: 'github',
    })
    expect(outcome.outcome).toBe('done')
    // The WRITE sequence — `comment.list` after the submit is PR-4b's read-back
    // for the per-comment ids GitHub's review response does not return. It is a
    // read, so it does not reintroduce a half-posted state; what this asserts is
    // that exactly one write carried the whole review.
    expect(host.calls.filter((c) => c.action !== 'comment.list').map((c) => c.action)).toEqual([
      'mr.get',
      'mr.diff',
      'review.submit',
    ])
  })
})

describe('RFC-304 — a stale head stops the round before the model runs', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-stale-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a moved head fails at prepare-worktree, naming the newer sha', async () => {
    // Paying for a review of an obsolete revision is the smaller half of the
    // cost; publishing it is the larger one. The sha rides in the message
    // because re-arming the work item is what happens next.
    const host = fakeHost()
    const ai = scriptedModel(envelope([FINDING]))
    const { outcome } = await runRound(db, { host, ai, home, git: fakeGit(NEWER) })

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('prepare-worktree')
    expect(outcome.outcome === 'failed' && outcome.error).toContain(NEWER)
    expect(ai.calls).toBe(0)
    expect(host.calls).toHaveLength(0)
  })
})

describe('RFC-304 — nothing is published on a bad review', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-bad-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a reviewer that never conforms publishes NOTHING', async () => {
    // Constitution R5. A best-effort value escaping here would be posted as a
    // review comment with nothing marking it unvalidated.
    const host = fakeHost()
    const { outcome } = await runRound(db, { host, ai: scriptedModel('no envelope here'), home })
    // `review-shard` since PR-4b: with every shard exhausted there is no review
    // at all, so the stage fails rather than reporting an empty one — "no
    // findings" would tell the author their code is clean when nothing read it.
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('review-shard')
    expect(host.calls.some((c) => c.action.startsWith('comment.'))).toBe(false)
  })

  test('a diff the host refuses aborts before the model runs', async () => {
    const ai = scriptedModel(envelope([FINDING]))
    const host = fakeHost({
      'mr.diff': { ok: false, code: 'code-host-forbidden', message: 'no access' },
    })
    const { outcome } = await runRound(db, { host, ai, home })
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('fetch-diff')
    expect(ai.calls).toBe(0)
  })

  test('a GitLab MR with no diff_refs is named, not left to fail per comment', async () => {
    const host = fakeHost({ 'mr.get': okJson({ title: 'x' }) })
    const { outcome } = await runRound(db, {
      host,
      ai: scriptedModel(envelope([FINDING])),
      home,
    })
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('fetch-diff')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('diff_refs')
  })
})

describe('RFC-304 — the gate runs before positions', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-gate-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a below-threshold finding is never positioned or posted', async () => {
    const host = fakeHost()
    const { outcome } = await runRound(db, {
      host,
      ai: scriptedModel(envelope([{ ...FINDING, severity: 'info' }])),
      home,
      gate: { threshold: 'major', maxPerRound: 20 },
    })
    expect(outcome.outcome).toBe('done')
    expect(host.calls.some((c) => c.action === 'review.draft-create')).toBe(false)
    expect(String(host.calls.at(-1)?.params.body)).toContain('below the configured severity')
  })

  test('cap-withheld findings are counted in the overview, not silently dropped', async () => {
    const host = fakeHost()
    await runRound(db, {
      host,
      ai: scriptedModel(envelope([FINDING, { ...FINDING, line: 12, title: 'second' }])),
      home,
      gate: { threshold: 'info', maxPerRound: 1 },
    })
    expect(String(host.calls.at(-1)?.params.body)).toContain('withheld by the per-round limit')
  })

  test('a finding outside the diff rides the overview rather than vanishing', async () => {
    // AC-3/AC-4: not a validation failure, not a retry, and above all not a
    // finding that disappears.
    const host = fakeHost()
    const { outcome } = await runRound(db, {
      host,
      ai: scriptedModel(envelope([{ ...FINDING, line: 900 }])),
      home,
    })
    expect(outcome.outcome).toBe('done')
    expect(host.calls.some((c) => c.action === 'review.draft-create')).toBe(false)
    const overview = String(host.calls.at(-1)?.params.body)
    expect(overview).toContain('could not be placed')
    expect(overview).toContain('unchecked index')
  })

  test('placed and unplaced findings coexist in one round', async () => {
    const host = fakeHost()
    await runRound(db, {
      host,
      ai: scriptedModel(envelope([FINDING, { ...FINDING, line: 900, title: 'elsewhere' }])),
      home,
    })
    expect(host.calls.filter((c) => c.action === 'review.draft-create')).toHaveLength(1)
    expect(String(host.calls.at(-1)?.params.body)).toContain('2 findings')
  })
})
