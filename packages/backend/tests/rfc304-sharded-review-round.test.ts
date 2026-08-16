// RFC-304 §6.1 (T23/T24/T25) — the sharded review segment, through the real runner.
//
// The unit suites cover `splitDiff` and `runReviewShards` on their own. What
// only shows up here is the WIRING between them, and the first draft of that
// wiring had a bug no unit test could see: `prepare-worktree` published its path
// but not the sha it had resolved, so every shard tree was created at
// `undefined`. Nothing failed — the shard fakes ignore the sha — and the round
// went green while reviewing whatever the tree happened to contain.
//
// So the assertions here are deliberately about the joins:
//
//   - a multi-directory MR really does become several shards and several calls;
//   - every shard tree is created at the round's BASELINE sha;
//   - the global pass runs after the shards and is told what they found;
//   - a global finding that repeats a shard's is merged away, because the
//     fingerprint cannot dedupe it later (different text, different hunk).

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
import { createReviewHostFake } from './helpers/codeHostReviewFake'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import { createGitPortFake } from './helpers/gitPortFake'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NONCE = 'shardroundnonce'

const webhook: WebhookTriggerFields = {
  event_type: 'mr_opened',
  provider: 'gitlab',
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  mr_title: 'Touch three packages',
}

const PATCH = '@@ -1,2 +1,3 @@\n one\n+two\n three\n'

/** Three directories → three shards, at the default cap. */
const THREE_DIRS = [
  { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH },
  { old_path: 'lib/b.ts', new_path: 'lib/b.ts', diff: PATCH },
  { old_path: 'app/c.ts', new_path: 'app/c.ts', diff: PATCH },
]

const MR_BODY = {
  title: 'Touch three packages',
  diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: HEAD },
}

function fakeHost(files: unknown[] = THREE_DIRS) {
  return createReviewHostFake({ mrBody: MR_BODY, diff: files })
}

/** Records the sha every shard tree is created at. */
function recordingGit() {
  const shardShas: string[] = []
  const shardPaths: string[] = []
  const live = new Set<string>()
  const port: GitPort = createGitPortFake(
    { resolvedSha: HEAD },
    {
      async addDisposableWorktree({ worktreePath, sha }) {
        shardShas.push(sha)
        shardPaths.push(worktreePath)
        live.add(worktreePath)
        return { ok: true }
      },
      async removeDisposableWorktree({ worktreePath }) {
        live.delete(worktreePath)
        return { ok: true }
      },
    },
  )
  return { port, shardShas, shardPaths, live }
}

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

const finding = (file: string, title: string) => ({
  file,
  line: 2,
  severity: 'major',
  title,
  body: `Something is wrong in ${file}.`,
})

interface Scripted {
  prompts: string[]
  makeCaller: MrReviewEnvironment['makeCaller']
}

/**
 * Answers per call, and keeps every prompt.
 *
 * The prompts are what prove the global pass is a DIFFERENT pass rather than
 * the shard prompt run once more.
 */
function scripted(answers: (call: number, prompt: string) => unknown[]): Scripted {
  const prompts: string[] = []
  return {
    prompts,
    makeCaller: (prompt: string) => {
      prompts.push(prompt)
      const index = prompts.length
      return async () => ({ stdout: envelope(answers(index, prompt)), sessionId: `s${index}` })
    },
  }
}

async function runRound(
  db: DbClient,
  home: string,
  host: ReturnType<typeof fakeHost>,
  ai: Scripted,
  git: ReturnType<typeof recordingGit>,
) {
  const roundId = ulid()
  const env: MrReviewEnvironment = {
    codeHost: host.port,
    git: git.port,
    webhook,
    codeHostEndpointId: 'ep_7',
    repoPath: home,
    worktreePath: home,
    makeCaller: ai.makeCaller,
    nonce: NONCE,
    budget: { sameSession: 0, freshSession: 0 },
    gate: { threshold: 'info', maxPerRound: 20 },
    // Serial, so "which call was which" is deterministic in the assertions.
    shardConcurrency: 1,
  }
  const runner = createCodeCapabilityRunner({
    db,
    programStages: mrReviewProgramStages(env),
    aiStages: mrReviewAiStages(env),
  })
  const outcome = await runner.runRound({
    roundId,
    capability: 'mr-review',
    roundSeq: 1,
    worktreePath: home,
    repos: [{ name: 'main', path: home }],
    envelopeNonce: NONCE,
    resumeFromStage: null,
  })
  return { outcome, roundId }
}

describe('RFC-304 — a multi-directory MR is really sharded', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-shardround-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('three directories become three shard trees', async () => {
    const git = recordingGit()
    const ai = scripted(() => [])
    await runRound(db, home, fakeHost(), ai, git)
    expect(git.shardPaths).toHaveLength(3)
  })

  test('every shard tree is created at the round’s BASELINE sha', async () => {
    // The bug this file exists for: `prepare-worktree` used to publish its path
    // and drop the sha, so every tree was created at `undefined` and no test
    // noticed, because the fakes ignore it.
    const git = recordingGit()
    await runRound(
      db,
      home,
      fakeHost(),
      scripted(() => []),
      git,
    )
    expect(git.shardShas).toEqual([HEAD, HEAD, HEAD])
  })

  test('no shard tree is left behind', async () => {
    const git = recordingGit()
    await runRound(
      db,
      home,
      fakeHost(),
      scripted(() => []),
      git,
    )
    expect(git.live.size).toBe(0)
  })

  test('no shard tree is inside the round’s own worktree', async () => {
    // A tree created under the round's worktree would appear in the round's own
    // diff — the reviewer's scratch space showing up as the change under review.
    const git = recordingGit()
    await runRound(
      db,
      home,
      fakeHost(),
      scripted(() => []),
      git,
    )
    expect(git.shardPaths.every((p) => !p.startsWith(`${home}/`))).toBe(true)
  })

  test('the model is called once per shard, plus once globally', async () => {
    const ai = scripted(() => [])
    await runRound(db, home, fakeHost(), ai, recordingGit())
    expect(ai.prompts).toHaveLength(4)
  })

  test('each shard is shown only ITS OWN files', async () => {
    // The whole point of sharding: a small context per reviewer. A shard shown
    // the entire diff would be the unsharded review wearing a shard's name.
    const ai = scripted(() => [])
    await runRound(db, home, fakeHost(), ai, recordingGit())
    const shardPrompts = ai.prompts.slice(0, 3)
    for (const prompt of shardPrompts) {
      const mentioned = ['src/a.ts', 'lib/b.ts', 'app/c.ts'].filter((f) => prompt.includes(f))
      expect(mentioned).toHaveLength(1)
    }
  })

  test('the global pass is a different pass, and sees the whole change', async () => {
    const ai = scripted(() => [])
    await runRound(db, home, fakeHost(), ai, recordingGit())
    const globalPrompt = ai.prompts.at(-1) ?? ''
    expect(globalPrompt).toContain('span more than one of those parts')
    for (const file of ['src/a.ts', 'lib/b.ts', 'app/c.ts']) {
      expect(globalPrompt).toContain(file)
    }
  })

  test('the global pass is told what the shards already found', async () => {
    // Without it, the cross-file pass spends its answer repeating them.
    const ai = scripted((call) => (call <= 3 ? [finding('src/a.ts', `shard finding ${call}`)] : []))
    await runRound(db, home, fakeHost(), ai, recordingGit())
    expect(ai.prompts.at(-1) ?? '').toContain('shard finding 1')
  })

  test('every stage lands a row, in the contract’s order', async () => {
    const { roundId } = await runRound(
      db,
      home,
      fakeHost(),
      scripted(() => []),
      recordingGit(),
    )
    const rows = await readRoundStages(db, roundId)
    expect(rows.map((r) => r.stageName)).toEqual([
      'resolve-target',
      'prepare-worktree',
      'fetch-diff',
      'split-diff',
      'review-shard',
      'review-global',
      'validate-findings',
      'gate',
      'resolve-positions',
      'reconcile',
      'publish',
      'settle-stale',
      'ledger',
    ])
  })
})

describe('RFC-304 — findings from both passes are merged', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-shardround-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a shard finding and a distinct global finding are both published', async () => {
    const host = fakeHost()
    const ai = scripted((call) =>
      call === 1
        ? [finding('src/a.ts', 'unchecked index')]
        : call === 4
          ? [finding('lib/b.ts', 'callers were not updated')]
          : [],
    )
    await runRound(db, home, host, ai, recordingGit())
    expect(host.calls.filter((c) => c.action === 'review.draft-create')).toHaveLength(2)
  })

  test('a global finding that REPEATS a shard’s is published once', async () => {
    // The dedupe that has to happen before publishing: the same problem said
    // twice in different words has a different fingerprint and a different
    // hunk, so nothing downstream could ever merge it.
    const host = fakeHost()
    const same = finding('src/a.ts', 'unchecked index')
    const ai = scripted((call) => (call === 1 || call === 4 ? [same] : []))
    await runRound(db, home, host, ai, recordingGit())
    expect(host.calls.filter((c) => c.action === 'review.draft-create')).toHaveLength(1)
  })
})

describe('RFC-304 — degraded passes do not sink the round', () => {
  let db: DbClient
  let home: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-shardround-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a global pass that never conforms still publishes the shards’ findings', async () => {
    // The cross-file pass is the smaller half of the job. Withholding real,
    // validated per-shard findings because it misbehaved would lose the review
    // over the part that worked.
    const host = fakeHost()
    const prompts: string[] = []
    const makeCaller: MrReviewEnvironment['makeCaller'] = (prompt) => {
      prompts.push(prompt)
      const index = prompts.length
      return async () =>
        index === 4
          ? { stdout: 'not an envelope at all', sessionId: 's' }
          : { stdout: envelope([finding('src/a.ts', `finding ${index}`)]), sessionId: 's' }
    }
    const { outcome } = await runRound(db, home, host, { prompts, makeCaller }, recordingGit())

    expect(outcome.outcome).toBe('done')
    expect(host.calls.filter((c) => c.action === 'review.draft-create').length).toBeGreaterThan(0)
  })
})
