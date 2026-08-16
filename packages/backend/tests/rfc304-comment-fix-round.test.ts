// RFC-304 §6.2 — a whole `mr-comment-fix` round, both paths.
//
// Real: the database, the stage engine, the contract order, the artifact store,
// the form decision, the suggestion rendering. Faked: the code host socket, git
// and the model — the three things a test cannot have.
//
// The two paths are asserted for what they do NOT do as much as for what they
// do, because that is where they differ in ways that matter:
//
//   suggestion — posts once and ENDS. It must freeze no artifact, hold no git
//                ref, and push nothing. A suggestion that quietly froze an
//                artifact would leak a pinned commit per review comment.
//   patch      — posts and STOPS, mid-sequence. It must not reach `push`, and
//                the round must not read as failed: an operator seeing red here
//                goes looking for a bug that is not there.
//
// The confirming round is the interesting one. It resumes at `verify-baseline`
// and pushes the FROZEN object — not a regenerated change — and it must refuse
// when the branch moved while the person was deciding.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeArtifacts, codeRoundStages } from '../src/db/schema'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  commentFixResumeArtifacts,
  mrCommentFixAiStages,
  mrCommentFixProgramStages,
  type MrCommentFixEnvironment,
} from '../src/modules/code-capability/composition/mrCommentFixStages'
import { ensureWorkItem } from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import { createGitPortFake } from './helpers/gitPortFake'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const FROZEN = 'c'.repeat(40)
const THREAD = 'disc-1'
const NONCE = 'fixnonce'

const SMALL_DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,1 @@',
  '-const x = 1',
  '+const x = 2',
].join('\n')

/** Wide enough that `decide-form` sends it down the patch path. */
const BIG_DIFF = (() => {
  const lines = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,40 +1,40 @@']
  for (let i = 1; i <= 40; i += 1) lines.push(`-line ${String(i)}`, `+LINE ${String(i)}`)
  return lines.join('\n')
})()

const webhook: WebhookTriggerFields = {
  event_type: 'note',
  provider: 'gitlab',
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  branch: 'feature/retry',
}

const discussions = JSON.stringify([
  {
    id: THREAD,
    notes: [
      {
        id: 10,
        body: 'this allocates on every call',
        author: { username: 'ann' },
        position: { new_path: 'src/a.ts', new_line: '1' },
      },
    ],
  },
])

function fakeHost(over: { listing?: string } = {}): { port: CodeHostPort; calls: CodeHostCall[] } {
  const calls: CodeHostCall[] = []
  return {
    calls,
    port: {
      call: async (call) => {
        calls.push(call)
        if (call.action === 'comment.list') {
          return { ok: true, status: 200, body: over.listing ?? discussions, truncated: false }
        }
        return { ok: true, status: 201, body: '{"id":99}', truncated: false }
      },
    },
  }
}

function fakeGit(
  diff: string,
  over: Partial<GitPort> = {},
): { port: GitPort; refs: Set<string>; pushes: string[] } {
  const refs = new Set<string>()
  const pushes: string[] = []
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
      async pushCommit({ commitSha }) {
        pushes.push(commitSha)
        return { ok: true }
      },
      ...over,
    },
  )
  return { port, refs, pushes }
}

/** A model that returns one fixed envelope. */
const modelReturning =
  (payload: unknown): MrCommentFixEnvironment['makeCaller'] =>
  () =>
  async () => ({
    stdout: `<workflow-output nonce="${NONCE}"><port name="fix">${JSON.stringify(payload)}</port></workflow-output>`,
    sessionId: 'session-1',
  })

describe('RFC-304 §6.2 — the comment-fix round', () => {
  let db: DbClient
  let home: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-fix-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  const envOf = async (
    over: Partial<MrCommentFixEnvironment> & { diff?: string } = {},
  ): Promise<{ env: MrCommentFixEnvironment; workItemId: string }> => {
    const item = await ensureWorkItem({
      db,
      codeHostEndpointId: 'ep-1',
      stableProjectId: '41823',
      capability: 'mr-comment-fix',
      anchorKind: 'mr',
      anchorId: '412',
    })
    return {
      workItemId: item.id,
      env: {
        db,
        codeHost: fakeHost().port,
        git: fakeGit(over.diff ?? SMALL_DIFF).port,
        webhook,
        codeHostEndpointId: 'ep-1',
        repoPath: home,
        worktreePath: home,
        threadId: THREAD,
        workItemId: item.id,
        generation: 1,
        roundId: ulid(),
        makeCaller: modelReturning({ outcome: 'changed', message: 'Hoisted the allocation.' }),
        protocolBlock: '',
        nonce: NONCE,
        budget: { sameSession: 0, freshSession: 0 },
        ...over,
      },
    }
  }

  /** Stage name → recorded status, so a skipped branch is visible. */
  const stageStatuses = async (roundId: string): Promise<Record<string, string>> => {
    const rows = await db
      .select({ name: codeRoundStages.stageName, status: codeRoundStages.status })
      .from(codeRoundStages)
      .where(eq(codeRoundStages.roundId, roundId))
    return Object.fromEntries(rows.map((r) => [r.name, r.status]))
  }

  const run = async (env: MrCommentFixEnvironment, resumeFromStage: string | null = null) => {
    const runner = createCodeCapabilityRunner({
      db,
      programStages: mrCommentFixProgramStages(env),
      aiStages: mrCommentFixAiStages(env),
      // A confirming round starts cold: the posting round's task is gone, so
      // what the skipped stages would have produced is recomputed here from
      // durable state — exactly as the production caller does.
      ...(resumeFromStage === null ? {} : { inheritedArtifacts: commentFixResumeArtifacts(env) }),
    })
    return await runner.runRound({
      roundId: env.roundId,
      capability: 'mr-comment-fix',
      roundSeq: 1,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage,
    })
  }

  test('a small change is posted as a suggestion and the round ENDS', async () => {
    const host = fakeHost()
    const git = fakeGit(SMALL_DIFF)
    const { env } = await envOf({ codeHost: host.port, git: git.port })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('done')
    const replies = host.calls.filter((c) => c.action === 'comment.reply-thread')
    expect(replies.length).toBe(1)
    expect(replies[0]?.params.body).toContain('```suggestion')
    expect(replies[0]?.params.thread).toBe(THREAD)

    // Nothing frozen, nothing pinned, nothing pushed. A suggestion that quietly
    // froze an artifact would leak one pinned commit per review comment.
    expect((await db.select().from(codeArtifacts)).length).toBe(0)
    expect(git.refs.size).toBe(0)
    expect(git.pushes).toEqual([])

    // …and the patch branch's stages are recorded SKIPPED. This is the
    // assertion that can actually SEE the sequence stop: an implementation that
    // let `verify-baseline` and `push` run and quietly no-op would satisfy
    // every check above, while the state view showed a round that pushed.
    expect(await stageStatuses(env.roundId)).toMatchObject({
      'publish-suggestion': 'done',
      'post-patch': 'skipped',
      'verify-baseline': 'skipped',
      push: 'skipped',
    })
  })

  test('a large change is posted as a diff and the round WAITS', async () => {
    const host = fakeHost()
    const git = fakeGit(BIG_DIFF)
    const { env } = await envOf({ codeHost: host.port, git: git.port, diff: BIG_DIFF })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('awaiting')
    if (outcome.outcome !== 'awaiting') throw new Error('expected an awaiting round')
    expect(outcome.awaitingStage).toBe('post-patch')
    // Where the confirming round picks up. Resuming anywhere earlier would
    // re-run the model and push a change nobody read.
    expect(outcome.resumeAt).toBe('verify-baseline')

    const replies = host.calls.filter((c) => c.action === 'comment.reply-thread')
    expect(replies[0]?.params.body).toContain('```diff')
    expect(replies[0]?.params.body).toContain('/aw apply')
    // The invisible marker that ties a later confirmation to THIS change.
    expect(replies[0]?.params.body).toContain('<!-- aw-patch:')

    // Frozen and pinned, waiting for the human.
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('live')
    expect(row?.baseSha).toBe(HEAD)
    expect(git.refs.size).toBe(1)
    expect(git.pushes).toEqual([])
  })

  test('the confirming round pushes the FROZEN commit, not a fresh one', async () => {
    // The whole point of freezing. By now the worktree is gone and the model
    // would produce a different change with the same justification.
    const git = fakeGit(BIG_DIFF)
    const { env } = await envOf({ git: git.port, diff: BIG_DIFF })
    await run(env)

    const confirming: MrCommentFixEnvironment = {
      ...env,
      roundId: ulid(),
      // A model that would throw if called — proof the confirming round does
      // not re-run the fix.
      makeCaller: () => async () => {
        throw new Error('the confirming round must not call the model')
      },
    }
    const outcome = await run(confirming, 'verify-baseline')

    expect(outcome.outcome).toBe('done')
    expect(git.pushes).toEqual([FROZEN])
    // Consumed and unpinned.
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('consumed')
    expect(git.refs.size).toBe(0)
  })

  test('a branch that moved while waiting refuses the push and frees the artifact', async () => {
    // C7. Applying a change built on what the branch used to be would clobber
    // whatever the author pushed in the meantime.
    const git = fakeGit(BIG_DIFF)
    const { env } = await envOf({ git: git.port, diff: BIG_DIFF })
    await run(env)

    const moved: MrCommentFixEnvironment = {
      ...env,
      roundId: ulid(),
      webhook: { ...webhook, commit_sha: MOVED },
    }
    const outcome = await run(moved, 'verify-baseline')

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('moved')
    expect(git.pushes).toEqual([])
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('superseded')
    expect(git.refs.size).toBe(0)
  })

  test('a declined comment posts the reason and changes nothing', async () => {
    // "This whole approach is wrong" is a comment no edit answers. Forcing one
    // produces a plausible change for a question nobody asked — and it arrives
    // wearing the platform's authority.
    const host = fakeHost()
    const git = fakeGit(SMALL_DIFF)
    const { env } = await envOf({
      codeHost: host.port,
      git: git.port,
      makeCaller: modelReturning({
        outcome: 'declined',
        message: 'This is a design question rather than a change request.',
      }),
    })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('done')
    const replies = host.calls.filter((c) => c.action === 'comment.reply-thread')
    expect(replies[0]?.params.body).toContain('design question')
    expect(replies[0]?.params.body).not.toContain('```suggestion')
    expect((await db.select().from(codeArtifacts)).length).toBe(0)
    expect(git.pushes).toEqual([])
  })

  test('an agent that claims a change but edits nothing fails the round', async () => {
    // The claim is not the evidence. Without this the round freezes an empty
    // commit and asks a human to confirm a change that does not exist.
    const git = fakeGit('')
    const { env } = await envOf({ git: git.port, diff: '' })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('validate-change')
    expect((await db.select().from(codeArtifacts)).length).toBe(0)
  })

  test('a thread resolved before the round started is not answered', async () => {
    const resolvedListing = JSON.stringify([
      {
        id: THREAD,
        notes: [{ id: 10, body: 'fixed already', author: { username: 'ann' }, resolved: true }],
      },
    ])
    const host = fakeHost({ listing: resolvedListing })
    const { env } = await envOf({ codeHost: host.port })

    const outcome = await run(env)

    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.failedStage).toBe('collect-thread')
    expect(host.calls.filter((c) => c.action === 'comment.reply-thread')).toEqual([])
  })

  test('a truncated discussion listing fails rather than answering half of it', async () => {
    // A truncated listing reads as "the thread has three messages", and the
    // agent answers a conversation it only half received.
    const host: CodeHostPort = {
      call: async (call) =>
        call.action === 'comment.list'
          ? { ok: true, status: 200, body: discussions, truncated: true }
          : { ok: true, status: 201, body: '{}', truncated: false },
    }
    const { env } = await envOf({ codeHost: host })

    const outcome = await run(env)
    expect(outcome.outcome).toBe('failed')
    expect(outcome.outcome === 'failed' && outcome.error).toContain('truncated')
  })
})
