// RFC-304 §6.3 — a whole `requirement` round, against a real database.
//
// Real: the stage engine, the contract order, the produced-MR index, the gate
// reader, the document budget. Faked: the code host, git and the model.
//
// The three properties worth the most:
//
//   the PAUSE — `comprehend` may answer `needs-clarification`, and the round
//   must stop there having implemented nothing. An agent that cannot ask will
//   not ask: it fills the gap with the most plausible reading and produces a
//   merge request implementing a requirement nobody wrote. That result compiles
//   and solves the wrong problem, which is worse than no result.
//
//   the RESUME POINT — a clarification resumes at `comprehend`, so the model
//   reads the answer. That is the opposite of the frozen-artifact wait in
//   `mr-comment-fix`, where re-running the model is exactly what must not
//   happen. Two wait kinds, expressed as two resume points (T4b).
//
//   the INDEX — `open-mr` registers the produced merge request in the same
//   stage that created it. That is the only moment both facts are in one place;
//   without it the requirement never closes when its code ships.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  requirementAiStages,
  requirementProgramStages,
  readCreatedMrIid,
  renderMrDescription,
  requirementBranchName,
  type RequirementEnvironment,
} from '../src/modules/code-capability/composition/requirementStages'
import { lookupProducedMr } from '../src/modules/code-capability/application/producedMrIndex'
import { createGitPortFake } from './helpers/gitPortFake'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NONCE = 'reqnonce'
const BASE = 'a'.repeat(40)
const BUILT = 'c'.repeat(40)

const CLAUDE_MD = ['# Contributing', '', 'Run `bun run gate:local` before you push.'].join('\n')

const REQUIREMENT = {
  title: 'Retry logic drops the last attempt',
  body: 'When the third attempt fails the error is swallowed.',
  documents: [],
}

function fakeHost(): { port: CodeHostPort; calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    port: {
      call: async (call) => {
        calls.push(call)
        if (call.action === 'mr.create') {
          return { ok: true, status: 201, body: '{"iid":412,"id":99001}', truncated: false }
        }
        return { ok: true, status: 201, body: '{"id":7}', truncated: false }
      },
    },
  }
}

function fakeGit(): { port: GitPort; pushedBranches: string[]; refs: Set<string> } {
  const pushedBranches: string[] = []
  const refs = new Set<string>()
  const port = createGitPortFake(
    { resolvedSha: BASE, commitSha: BUILT },
    {
      async commitWorktree({ keepRef }) {
        refs.add(keepRef)
        return { ok: true, commitSha: BUILT }
      },
      async deleteRef({ ref }) {
        refs.delete(ref)
        return { ok: true }
      },
      async pushNewBranch({ branch }) {
        pushedBranches.push(branch)
        return { ok: true }
      },
    },
  )
  return { port, pushedBranches, refs }
}

/** A model that answers each slot with a fixed envelope. */
const modelReturning =
  (byPort: Record<string, unknown>): RequirementEnvironment['makeCaller'] =>
  (_prompt, slot) =>
  async () => {
    const port = slot === 'analyst' ? 'comprehension' : 'implementation'
    return {
      stdout: `<workflow-output nonce="${NONCE}"><port name="${port}">${JSON.stringify(byPort[port])}</port></workflow-output>`,
      sessionId: 'session-1',
    }
  }

const READY = {
  comprehension: { outcome: 'ready', understanding: 'Retry the third attempt and surface errors.' },
  implementation: {
    title: 'fix: surface the last retry failure',
    summary: 'The third attempt now propagates its error.',
    deferred: [],
  },
}

describe('RFC-304 §6.3 — the requirement round', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-req-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  const envOf = (over: Partial<RequirementEnvironment> = {}): RequirementEnvironment => ({
    db,
    codeHost: fakeHost().port,
    git: fakeGit().port,
    codeHostEndpointId: 'ep-1',
    provider: 'gitlab',
    projectRef: '41823',
    repoPath: home,
    worktreePath: home,
    targetBranch: 'main',
    input: REQUIREMENT,
    origin: { kind: 'platform' },
    workItemId: 'wi-1',
    roundId: ulid(),
    roundSeq: 1,
    makeCaller: modelReturning(READY),
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 0, freshSession: 0 },
    readWorktreeFile: async (path) => (path === 'CLAUDE.md' ? CLAUDE_MD : null),
    runGateCommand: async () => ({ exitCode: 0, output: 'all good' }),
    ...over,
  })

  const run = async (env: RequirementEnvironment, resumeFromStage: string | null = null) => {
    const runner = createCodeCapabilityRunner({
      db,
      programStages: requirementProgramStages(env),
      aiStages: requirementAiStages(env),
      // `self-review` invokes `mr-review`'s reading half. Stubbed here: what is
      // under test is the requirement sequence, and the invoke runner has its
      // own file.
      invokedStages: {
        'mr-review': {
          program: {
            'split-diff': async () => ({ status: 'done', produced: { shards: [] } }),
            'validate-findings': async () => ({ status: 'done', produced: { findings: [] } }),
          },
          ai: {
            'review-shard': async () => ({ status: 'done', produced: { shardFindings: [] } }),
            'review-global': async () => ({ status: 'done', produced: { globalFindings: [] } }),
          },
        },
      },
    })
    return await runner.runRound({
      roundId: env.roundId,
      capability: 'requirement',
      roundSeq: env.roundSeq,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage,
    })
  }

  test('a clear requirement is built, gated, reviewed and opened as an MR', async () => {
    const host = fakeHost()
    const git = fakeGit()
    const env = envOf({ codeHost: host.port, git: git.port })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('done')
    const created = host.calls.find((c) => c.action === 'mr.create')
    expect(created?.params.title).toBe('fix: surface the last retry failure')
    expect(created?.params.target_branch).toBe('main')
    expect(created?.params.source_branch).toBe(requirementBranchName(env.roundId, 1))
    // The gate line reaches the reviewer, naming the command and where it came
    // from — that is what tells them the platform ran the right thing.
    expect(created?.params.description).toContain('bun run gate:local')
    expect(created?.params.description).toContain('CLAUDE.md:3')

    expect(git.pushedBranches).toEqual([requirementBranchName(env.roundId, 1)])
    // The keep-alive ref is released once the branch makes the commit
    // reachable; leaving it would pin the object forever.
    expect(git.refs.size).toBe(0)
  })

  test('the produced MR is INDEXED, so the requirement can close later', async () => {
    // The only moment both facts are in one place. Without it the terminal
    // event — which knows only the merge request — has no way back, and the
    // work item stays open after its code ships.
    const env = envOf()
    await run(env)

    const indexed = await lookupProducedMr(db, {
      codeHostEndpointId: 'ep-1',
      stableProjectId: '41823',
      mrIid: '412',
    })
    expect(indexed?.workItemId).toBe('wi-1')
    expect(indexed?.roundId).toBe(env.roundId)
  })

  test('an unclear requirement WAITS, having implemented nothing', async () => {
    const host = fakeHost()
    const git = fakeGit()
    const env = envOf({
      codeHost: host.port,
      git: git.port,
      makeCaller: modelReturning({
        comprehension: {
          outcome: 'needs-clarification',
          understanding: 'It is not clear whether the retry should back off.',
          questions: [{ id: 'q1', text: 'Should the retry back off exponentially?' }],
        },
        implementation: READY.implementation,
      }),
    })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('awaiting')
    if (outcome.outcome !== 'awaiting') throw new Error('expected an awaiting round')
    expect(outcome.awaitingStage).toBe('clarify')
    // Back to `comprehend`, not to `implement`: the answer changes the reading,
    // so the model must read it again. The opposite of the frozen-artifact
    // wait, where re-running the model is what must NOT happen.
    expect(outcome.resumeAt).toBe('comprehend')

    // Nothing was built, pushed or opened.
    expect(git.pushedBranches).toEqual([])
    expect(host.calls.filter((c) => c.action === 'mr.create')).toEqual([])
  })

  test('an issue-entered question is posted to the ISSUE', async () => {
    const host = fakeHost()
    const env = envOf({
      codeHost: host.port,
      origin: { kind: 'issue', hasWritebackHandle: true, frameworkSupportsWriteback: true },
      input: {
        ...REQUIREMENT,
        writebackHandle: {
          kind: 'issue-comment',
          params: { __project__: '41823', mr: '88' },
        },
      },
      makeCaller: modelReturning({
        comprehension: {
          outcome: 'needs-clarification',
          understanding: 'unclear',
          questions: [{ id: 'q1', text: 'Which timeout?' }],
        },
        implementation: READY.implementation,
      }),
    })

    await run(env)

    const posted = host.calls.find((c) => c.action === 'comment.create')
    expect(posted?.params.body).toContain('Which timeout?')
    // The marker is what ties the eventual answer back to this round.
    expect(posted?.params.body).toContain('<!-- aw-clarify:')
  })

  test('an issue entry with no way back REFUSES rather than asking elsewhere', async () => {
    // The arm the design gate struck out. The person is watching the issue and
    // may not have an account here; a question that quietly lands somewhere
    // else is one they never see.
    const env = envOf({
      origin: { kind: 'issue', hasWritebackHandle: false, frameworkSupportsWriteback: true },
      makeCaller: modelReturning({
        comprehension: {
          outcome: 'needs-clarification',
          understanding: 'unclear',
          questions: [{ id: 'q1', text: 'Which timeout?' }],
        },
        implementation: READY.implementation,
      }),
    })

    const outcome = await run(env)
    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('clarify')
  })

  test('a failing target gate stops the round before the MR is opened', async () => {
    // Opening a merge request from a change the repository's own checks reject
    // spends a reviewer's attention on something already known to be wrong.
    const host = fakeHost()
    const env = envOf({
      codeHost: host.port,
      runGateCommand: async () => ({ exitCode: 1, output: '3 tests failed' }),
    })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('run-target-gate')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('3 tests failed')
    expect(host.calls.filter((c) => c.action === 'mr.create')).toEqual([])
  })

  test('NO gate found still opens the MR — and says so plainly', async () => {
    // The platform learned nothing, which is different from learning the change
    // is bad. Stopping here would make the capability unusable in every
    // repository that documents its checks somewhere unparseable.
    const host = fakeHost()
    const env = envOf({ codeHost: host.port, readWorktreeFile: async () => null })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('done')
    const created = host.calls.find((c) => c.action === 'mr.create')
    expect(created?.params.description).toContain('nothing was verified')
    expect(created?.params.description?.toLowerCase()).not.toContain('passed')
  })

  test('an oversized document set is refused before a model is called', async () => {
    // Refusing after the model has read a truncated set pays for the answer and
    // still throws it away.
    let called = false
    const env = envOf({
      input: {
        ...REQUIREMENT,
        documents: [{ name: 'design.md', content: 'x'.repeat(500_000) }],
      },
      makeCaller: () => async () => {
        called = true
        throw new Error('the model must not be called for an oversized set')
      },
    })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('resolve-input')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('design.md')
    expect(called).toBe(false)
  })

  test('a reference with no entry script is refused, not guessed', async () => {
    const outcome = await run(envOf({ input: null }))
    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('no entry script')
  })

  test('an agent that reports a change but edits nothing fails before the MR', async () => {
    const git = createGitPortFake(
      { resolvedSha: BASE },
      {
        async commitWorktree() {
          return { ok: false, reason: 'no-changes' }
        },
      },
    )
    const host = fakeHost()
    const outcome = await run(envOf({ git, codeHost: host.port }))

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('open-mr')
    expect(host.calls.filter((c) => c.action === 'mr.create')).toEqual([])
  })

  test('an MR the host will not name fails loudly', async () => {
    // The merge request exists but can never be indexed, so the requirement
    // could never close — a work item open forever after its code shipped.
    const host: CodeHostPort = {
      call: async (call) =>
        call.action === 'mr.create'
          ? { ok: true, status: 201, body: '{"id":99001}', truncated: false }
          : { ok: true, status: 201, body: '{}', truncated: false },
    }
    const outcome = await run(envOf({ codeHost: host }))

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('did not return its number')
  })
})

describe('RFC-304 §6.3 — reading the created merge request', () => {
  test('GitLab returns `iid`, GitHub returns `number`', () => {
    expect(readCreatedMrIid('gitlab', '{"iid":412,"id":99001}')).toBe('412')
    expect(readCreatedMrIid('github', '{"number":7,"id":88002}')).toBe('7')
  })

  test('`id` is never used — it is the global object id, which no REST path takes', () => {
    expect(readCreatedMrIid('gitlab', '{"id":99001}')).toBeNull()
    expect(readCreatedMrIid('github', '{"id":88002}')).toBeNull()
  })

  test('a non-JSON body is null rather than a crash', () => {
    expect(readCreatedMrIid('gitlab', '<html>502</html>')).toBeNull()
  })
})

describe('RFC-304 §6.3 — the merge request description', () => {
  test('deferred work is its own section, not buried in prose', () => {
    // The part a reviewer most needs and the part most easily lost in a wall of
    // text.
    const text = renderMrDescription(
      { title: 't', summary: 'Did the thing.', deferred: ['the migration', 'the docs'] },
      { kind: 'passed', command: 'make check', source: { file: 'CLAUDE.md', line: 4 } },
    )
    expect(text).toContain('Deliberately not done:')
    expect(text).toContain('- the migration')
    expect(text).toContain('- the docs')
  })

  test('an empty deferred list adds no empty section', () => {
    const text = renderMrDescription(
      { title: 't', summary: 'Did the thing.', deferred: [] },
      { kind: 'not-found', searched: ['CLAUDE.md'] },
    )
    expect(text).not.toContain('Deliberately not done')
  })
})

describe('RFC-304 §6.3 — the branch name', () => {
  test('a second round on one issue gets a DIFFERENT branch', () => {
    // Reusing it would either be refused as a non-fast-forward or silently
    // rewrite the first attempt's merge request.
    const a = requirementBranchName('01ABC', 1)
    const b = requirementBranchName('01ABC', 2)
    expect(a).not.toBe(b)
  })

  test('the name is a legal ref path', () => {
    expect(requirementBranchName('01ABCDEF', 3)).toBe('aw/requirement/01abcdef-3')
  })
})
