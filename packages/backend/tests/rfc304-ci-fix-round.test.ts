// RFC-304 §6.4 — a whole `ci-fix` round, and the quota that spans rounds.
//
// Real: the database, the stage engine, the contract order, the attempt ledger,
// the fingerprinting, the anti-cheat adjudication. Faked: the code host socket,
// git, the model, and the gate command — the four things a test cannot have.
//
// The properties worth testing here are the ones that are invisible inside a
// single round:
//
//   the quota SURVIVES the round. One round is one attempt, so a count held in
//   memory would restart at 1 on every pipeline event and "three attempts"
//   would mean "forever". Only a test that runs several rounds can see this.
//
//   the quota is keyed by FAILURE, not by merge request. A long-lived merge
//   request that met three unrelated CI problems must not lose automatic repair
//   permanently — and the author, who has forgotten the first two, would have no
//   way to find out why it stopped.
//
//   the push is a compare-and-swap. The author may push while the agent works,
//   and a force-update would make the platform the thing that broke the branch
//   it was sent to repair.
//
// Each terminal branch is also asserted through `code_round_stages`, because a
// stage that returns `done` having done nothing is indistinguishable from one
// that worked — the recorded `skipped` is the only thing that can see the stop.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeFixAttempts, codeRoundStages } from '../src/db/schema'
import {
  CI_FIX_RESUME_STAGE,
  ciFixAiStages,
  ciFixProgramStages,
  ciFixResumeArtifacts,
  evidenceFrom,
  type CiFixEnvironment,
  type GateRun,
} from '../src/modules/code-capability/composition/ciFixStages'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import { ensureWorkItem } from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import { createGitPortFake } from './helpers/gitPortFake'
import type { CollectResult } from '../src/modules/code-capability/domain/monitorContracts'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'a'.repeat(40)
const FROZEN = 'c'.repeat(40)
const NONCE = 'cifixnonce'
const BRANCH = 'feature/retry'

const COMPILE_ISSUE = {
  type: 'compile',
  file: 'src/retry.ts',
  message: "src/retry.ts:12:5 cannot find name 'Foo'",
}
/** A genuinely different failure — different type AND file. */
const LINT_ISSUE = { type: 'codecheck', file: 'src/other.ts', message: 'unused import' }

const HONEST_DIFF = [
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -1,3 +1,3 @@',
  '-import { Bar } from "./bar"',
  '+import { Foo } from "./foo"',
].join('\n')

/** Deletes an assertion from a test file — the structural signal. */
const CHEATING_DIFF = [
  '--- a/tests/retry.test.ts',
  '+++ b/tests/retry.test.ts',
  '@@ -1,5 +1,4 @@',
  '   const out = retry()',
  '-  expect(out.attempts).toBe(3)',
].join('\n')

const gateState = (over: Partial<CollectResult> = {}): CollectResult => ({
  conflict: false,
  unresolvedComments: [],
  gate: { status: 'fail' },
  headSha: HEAD,
  ...over,
})

function fakeHost(): { port: CodeHostPort; calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    port: {
      call: async (call) => {
        calls.push(call)
        return { ok: true, status: 201, body: '{"id":99}', truncated: false }
      },
    },
  }
}

function fakeGit(
  diff: string,
  over: Partial<GitPort> = {},
): { port: GitPort; pushes: string[]; leases: string[]; refs: Set<string> } {
  const refs = new Set<string>()
  const pushes: string[] = []
  const leases: string[] = []
  const port = createGitPortFake(
    { resolvedSha: HEAD, commitSha: FROZEN, diff },
    {
      async commitWorktree({ keepRef }) {
        refs.add(keepRef)
        return { ok: true, commitSha: FROZEN }
      },
      async deleteRef({ ref }) {
        refs.delete(ref)
        return { ok: true }
      },
      async pushCommit({ commitSha, expectedRemoteSha }) {
        pushes.push(commitSha)
        leases.push(expectedRemoteSha)
        return { ok: true }
      },
      ...over,
    },
  )
  return { port, pushes, leases, refs }
}

const modelReturning =
  (payload: unknown): CiFixEnvironment['makeCaller'] =>
  () =>
  async () => ({
    stdout: `<workflow-output nonce="${NONCE}"><port name="fix">${JSON.stringify(payload)}</port></workflow-output>`,
    sessionId: 'session-1',
  })

const GREEN: GateRun = { exitCode: 0, output: 'all checks passed' }
const RED: GateRun = { exitCode: 1, output: "src/retry.ts:12:5 cannot find name 'Foo'" }

describe('RFC-304 §6.4 — the ci-fix round', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-cifix-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  const newItem = async (): Promise<string> =>
    (
      await ensureWorkItem({
        db,
        codeHostEndpointId: 'ep-1',
        stableProjectId: '41823',
        capability: 'ci-fix',
        anchorKind: 'mr',
        anchorId: '412',
      })
    ).id

  const envOf = (
    workItemId: string,
    over: Partial<CiFixEnvironment> & { diff?: string } = {},
  ): CiFixEnvironment => ({
    db,
    codeHost: fakeHost().port,
    git: fakeGit(over.diff ?? HONEST_DIFF).port,
    repoPath: home,
    worktreePath: home,
    reportTarget: { __project__: '41823', mr: '412' },
    sourceBranch: BRANCH,
    workItemId,
    roundId: ulid(),
    makeCaller: modelReturning({ summary: 'Corrected the import.', touched: ['src/retry.ts'] }),
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 0, freshSession: 0 },
    runGate: async () => GREEN,
    readWorktreeDiff: async () => over.diff ?? HONEST_DIFF,
    ...over,
  })

  const stageStatuses = async (roundId: string): Promise<Record<string, string>> => {
    const rows = await db
      .select({ name: codeRoundStages.stageName, status: codeRoundStages.status })
      .from(codeRoundStages)
      .where(eq(codeRoundStages.roundId, roundId))
    return Object.fromEntries(rows.map((r) => [r.name, r.status]))
  }

  const run = async (env: CiFixEnvironment, issues = [COMPILE_ISSUE]) => {
    const runner = createCodeCapabilityRunner({
      db,
      programStages: ciFixProgramStages(env),
      aiStages: ciFixAiStages(env),
      // `self-review` invokes a slice of `mr-review`; stubbed to a clean result
      // so these tests are about the fix path rather than about review.
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
      inheritedArtifacts: ciFixResumeArtifacts({
        gateState: gateState(),
        issues,
        workPackage: { capability: 'ci-fix', items: [{ issueRef: 'compile:src/retry.ts' }] },
      }),
    })
    return await runner.runRound({
      roundId: env.roundId,
      capability: 'ci-fix',
      roundSeq: 1,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage: CI_FIX_RESUME_STAGE,
    })
  }

  const attemptsOf = async (workItemId: string) =>
    await db.select().from(codeFixAttempts).where(eq(codeFixAttempts.workItemId, workItemId))

  test('a fix that makes the gate green is pushed', async () => {
    const workItemId = await newItem()
    const git = fakeGit(HONEST_DIFF)
    const env = envOf(workItemId, { git: git.port })

    const out = await run(env)

    expect(out.outcome).toBe('done')
    expect(git.pushes).toEqual([FROZEN])
    // The lease is against the revision the round was ABOUT — the head
    // `collect` reported — not against whatever the branch points at now.
    // Leasing against the current head would compare a value to itself and the
    // guard would pass every time, including the one time it matters.
    expect(git.leases).toEqual([HEAD])
    // The keep-alive ref is released once the branch makes the commit
    // reachable; leaving it would pin an object per repaired pipeline.
    expect([...git.refs]).toEqual([])

    const attempts = await attemptsOf(workItemId)
    expect(attempts.length).toBe(1)
    expect(attempts[0]?.attemptSeq).toBe(1)
    expect(attempts[0]?.outcome).toBe('fixed')
  })

  test('a fix that leaves the gate red is NOT pushed, and says so', async () => {
    const workItemId = await newItem()
    const host = fakeHost()
    const git = fakeGit(HONEST_DIFF)
    const env = envOf(workItemId, {
      git: git.port,
      codeHost: host.port,
      runGate: async () => RED,
    })

    const out = await run(env)

    expect(git.pushes).toEqual([])
    // Settled, not failed: the attempt did not work, but nothing about the
    // platform went wrong, and a red round sends someone hunting a bug that
    // does not exist.
    expect(out.outcome).not.toBe('failed')

    // The stages after the decision must be RECORDED skipped. Without this
    // assertion a `push` that quietly ran and no-opped would look identical.
    const stages = await stageStatuses(env.roundId)
    expect(stages.push).toBe('skipped')
    expect(stages.ledger).toBe('skipped')

    // And the person is told, with the gate's own words rather than a summary.
    const body = String(host.calls.at(-1)?.params.body ?? '')
    expect(body).toContain('Attempt 1 of 3')
    expect(body).toContain('Corrected the import.')
    expect(body).toContain('cannot find name')
  })

  test('the quota SURVIVES the round — three attempts, then hand-off', async () => {
    // The property a single-round test cannot see. Each round is one attempt;
    // an in-memory count would restart at 1 every time and never run out.
    const workItemId = await newItem()
    const hosts: ReturnType<typeof fakeHost>[] = []

    for (let i = 1; i <= 3; i += 1) {
      const host = fakeHost()
      hosts.push(host)
      const env = envOf(workItemId, {
        codeHost: host.port,
        runGate: async () => RED,
        makeCaller: modelReturning({ summary: `Attempt ${String(i)} change.`, touched: [] }),
      })
      await run(env)
    }

    const attempts = await attemptsOf(workItemId)
    expect(attempts.map((a) => a.attemptSeq)).toEqual([1, 2, 3])

    // The fourth round finds the quota spent and hands off instead of trying.
    const fourth = fakeHost()
    const git = fakeGit(HONEST_DIFF)
    const env = envOf(workItemId, {
      codeHost: fourth.port,
      git: git.port,
      // Even a fix that WOULD work does not get to run: the quota is spent, and
      // the point of the quota is that it stops trying.
      runGate: async () => GREEN,
    })
    await run(env)

    expect(git.pushes).toEqual([])
    expect((await attemptsOf(workItemId)).length).toBe(3)

    const body = String(fourth.calls.at(-1)?.params.body ?? '')
    expect(body).toContain('1. Attempt 1 change.')
    expect(body).toContain('3. Attempt 3 change.')
    expect(body).toContain('needs a person')
    // The reset condition — without it the reader concludes automatic repair is
    // permanently off for this merge request, which is untrue.
    expect(body).toContain('starts again from zero')
  })

  test('a DIFFERENT failure gets its own quota', async () => {
    // Keyed by (item, fingerprint). Keyed by item alone, this merge request
    // would already be out of attempts for a problem nobody has tried once.
    const workItemId = await newItem()

    for (let i = 1; i <= 3; i += 1) {
      await run(envOf(workItemId, { runGate: async () => RED }), [COMPILE_ISSUE])
    }

    const git = fakeGit(HONEST_DIFF)
    const out = await run(envOf(workItemId, { git: git.port }), [LINT_ISSUE])

    expect(out.outcome).toBe('done')
    expect(git.pushes).toEqual([FROZEN])

    // Two independent ledgers under one work item.
    const rows = await attemptsOf(workItemId)
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2)
  })

  test('the same failure fingerprints the same across rounds despite volatile text', async () => {
    // If it did not, the quota would never engage: every re-run of the same
    // compile error would look like a brand-new failure with a fresh three.
    const workItemId = await newItem()

    await run(envOf(workItemId, { runGate: async () => RED }), [
      { ...COMPILE_ISSUE, message: "src/retry.ts:12:5 cannot find name 'Foo'" },
    ])
    await run(envOf(workItemId, { runGate: async () => RED }), [
      { ...COMPILE_ISSUE, message: "src/retry.ts:88:1 cannot find name 'Foo'" },
    ])

    const rows = await attemptsOf(workItemId)
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(1)
    expect(rows.map((r) => r.attemptSeq)).toEqual([1, 2])
  })

  test('a green bought by deleting a test, with the baseline already green, is REJECTED', async () => {
    const workItemId = await newItem()
    const host = fakeHost()
    const git = fakeGit(CHEATING_DIFF)
    const env = envOf(workItemId, {
      codeHost: host.port,
      git: git.port,
      diff: CHEATING_DIFF,
      // The gate passed on the baseline too — so this change is what removed a
      // test that was working.
      runGateOnBaseline: async () => GREEN,
    })

    const out = await run(env)

    expect(out.outcome).toBe('failed')
    expect(git.pushes).toEqual([])
    const body = String(host.calls.at(-1)?.params.body ?? '')
    expect(body).toContain('already passing')
    expect(body).toContain('tests/retry.test.ts')
  })

  test('a green bought by deleting a test, with a red baseline, is allowed', async () => {
    // The test was failing and now passes. Whatever it did to the file, it
    // fixed what the test was checking — and that is a fact, not a claim.
    const workItemId = await newItem()
    const git = fakeGit(CHEATING_DIFF)
    const env = envOf(workItemId, {
      git: git.port,
      diff: CHEATING_DIFF,
      runGateOnBaseline: async () => RED,
    })

    const out = await run(env)

    expect(out.outcome).toBe('done')
    expect(git.pushes).toEqual([FROZEN])
  })

  test('an unverifiable baseline neither rejects NOR pushes', async () => {
    // The case the whole design section is about. Some tests genuinely should
    // go, so rejecting would be wrong; the platform has no basis to approve, so
    // pushing would be worse.
    const workItemId = await newItem()
    const host = fakeHost()
    const git = fakeGit(CHEATING_DIFF)
    const env = envOf(workItemId, {
      codeHost: host.port,
      git: git.port,
      diff: CHEATING_DIFF,
      runGateOnBaseline: async () => null,
    })

    const out = await run(env)

    expect(git.pushes).toEqual([])
    expect(out.outcome).toBe('awaiting')
    // Resumes at `push`, NOT at `fix`: the change under discussion is the one
    // already made, and re-running the agent would produce a different change
    // carrying the same conversation.
    expect(out.outcome === 'awaiting' && out.resumeAt).toBe('push')

    const body = String(host.calls.at(-1)?.params.body ?? '')
    expect(body).toContain('Nothing was pushed')
  })

  test('the push is refused when the branch moved under it', async () => {
    // The author pushed while the agent worked. Force-updating here would make
    // the platform the thing that broke the branch it was sent to repair.
    const workItemId = await newItem()
    const git = fakeGit(HONEST_DIFF, {
      async pushCommit() {
        return { ok: false, reason: 'stale', error: 'remote ref moved' }
      },
    })
    const env = envOf(workItemId, { git: git.port })

    const out = await run(env)

    expect(out.outcome).not.toBe('failed')
    const stages = await stageStatuses(env.roundId)
    expect(stages.ledger).toBe('skipped')
  })

  test('two rounds racing spend ONE attempt, not two', async () => {
    // A work item is supposed to have at most one running round, so this should
    // not happen — but "should not" and "cannot" differ by one bug in the lease,
    // and the quota is the thing that would silently pay for it.
    //
    // Reading a count and writing `count + 1` is the shape that loses here:
    // both rounds read "0 so far", both write attempt 1, and a three-attempt
    // quota quietly becomes six. The number is claimed BY the insert instead,
    // under a unique index, so the loser finds out it lost.
    const workItemId = await newItem()
    const envs = [
      envOf(workItemId, { runGate: async () => RED }),
      envOf(workItemId, { runGate: async () => RED }),
    ]

    const outcomes = await Promise.all(envs.map(async (env) => await run(env)))

    const rows = await attemptsOf(workItemId)
    expect(rows.length).toBe(1)
    expect(rows[0]?.attemptSeq).toBe(1)

    // And the loser says why rather than quietly doing nothing — a duplicate
    // round means the lease let two through, which someone should look at.
    const refused = outcomes.filter(
      (o) => o.outcome === 'failed' && o.error.includes('already working'),
    )
    expect(refused.length).toBe(1)
  })
})

describe('RFC-304 §6.4 — baseline evidence', () => {
  test('an unrunnable baseline is inconclusive, not "assume red"', () => {
    // Naming this mapping because the wrong version is dangerous in both
    // directions: "assume red" clears every weakened test in a repository whose
    // gate needs a live database, and "assume green" rejects every honest
    // deletion in the same repository.
    expect(evidenceFrom({ baselineSha: HEAD, baselineGate: null }).kind).toBe('inconclusive')
    expect(evidenceFrom({ baselineSha: HEAD, baselineGate: GREEN }).kind).toBe('was-already-green')
    expect(evidenceFrom({ baselineSha: HEAD, baselineGate: RED }).kind).toBe(
      'red-before-green-after',
    )
  })
})
