// RFC-304 T44/T45 — who may confirm a push, and what a push invalidates.
//
// T44 is the last thing standing between a comment and a commit on somebody
// else's branch: the platform pushes with its own credentials, so nothing
// downstream consults anyone's permissions. A false positive here means an
// unexpected commit on a branch someone is mid-thought on.
//
// T45 is about not lying by omission. `verify-baseline` already refuses to push
// a stale change, so nothing WRONG happens without invalidation — the diff just
// sits on the thread looking live until someone tries it days later and learns
// it expired. They were told to reply, and replying turned out not to work.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeArtifacts } from '../src/db/schema'
import { judgePushAuthority } from '../src/modules/code-capability/domain/pushAuthority'
import { freezeArtifact } from '../src/modules/code-capability/application/artifactStore'
import { invalidatePendingOnPush } from '../src/modules/code-capability/application/invalidatePending'
import { createGitPortFake } from './helpers/gitPortFake'
import type { CodeHostCall, CodeHostPort } from '../src/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BASE = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const DIFF = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+A'].join('\n')

describe('RFC-304 T44 — who may confirm a push', () => {
  const ctx = {
    commenter: 'ann',
    mrAuthor: 'ann',
    initiator: null,
    botUsername: 'aw-bot',
  }

  test('the branch owner may confirm', () => {
    expect(judgePushAuthority(ctx)).toEqual({ allowed: true, because: 'author' })
  })

  test('username comparison is case-insensitive', () => {
    // Hosts display and return names inconsistently cased. A case-sensitive
    // check refuses the author on their own branch, which reads as the feature
    // being broken.
    expect(judgePushAuthority({ ...ctx, commenter: 'Ann' }).allowed).toBe(true)
  })

  test('a reviewer with write access may NOT have the platform push', () => {
    // They can push to the branch themselves. What nobody should be able to do
    // is have the platform push to someone else's in-progress branch on their
    // say-so — a rebase conflict at best, an overwritten local change at worst.
    const verdict = judgePushAuthority({ ...ctx, commenter: 'bob' })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.message).toContain('ann')
    // And they are told what they CAN do, rather than just refused.
    expect(verdict.allowed === false && verdict.message).toContain('apply it yourself')
  })

  test('the platform never authorises itself', () => {
    // Without this, one of its own comments quoting the instructions could
    // confirm its own change.
    const verdict = judgePushAuthority({ ...ctx, commenter: 'aw-bot', mrAuthor: 'aw-bot' })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.message).toContain('own account')
  })

  test('on a bot-opened MR the INITIATOR decides, not the author', () => {
    // `mr.author` is the platform there, so treating it as the authority would
    // be the platform authorising itself — not an authorisation at all.
    const botMr = { commenter: 'ann', mrAuthor: 'aw-bot', initiator: 'ann', botUsername: 'aw-bot' }
    expect(judgePushAuthority(botMr)).toEqual({ allowed: true, because: 'initiator' })
  })

  test('on a bot-opened MR, someone else still cannot confirm', () => {
    const verdict = judgePushAuthority({
      commenter: 'bob',
      mrAuthor: 'aw-bot',
      initiator: 'ann',
      botUsername: 'aw-bot',
    })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.message).toContain('ann')
  })

  test('an unattributable comment confirms nothing', () => {
    expect(judgePushAuthority({ ...ctx, commenter: null }).allowed).toBe(false)
    expect(judgePushAuthority({ ...ctx, commenter: '   ' }).allowed).toBe(false)
  })

  test('an unknown author refuses rather than defaulting open', () => {
    // The failure direction matters: defaulting open here would let anyone
    // confirm on any merge request the platform could not read properly.
    const verdict = judgePushAuthority({ ...ctx, mrAuthor: null })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.message).toContain('could not be determined')
  })
})

describe('RFC-304 T45 — a push invalidates what was waiting', () => {
  let db: DbClient

  function trackingGit(): { port: GitPort; refs: Set<string> } {
    const refs = new Set<string>()
    return {
      refs,
      port: createGitPortFake(
        { diff: DIFF },
        {
          async commitWorktree({ keepRef }) {
            refs.add(keepRef)
            return { ok: true, commitSha: 'c'.repeat(40) }
          },
          async deleteRef({ ref }) {
            refs.delete(ref)
            return { ok: true }
          },
        },
      ),
    }
  }

  function recordingHost(): { port: CodeHostPort; calls: CodeHostCall[] } {
    const calls: CodeHostCall[] = []
    return {
      calls,
      port: {
        call: async (call) => {
          calls.push(call)
          return { ok: true, status: 201, body: '{}', truncated: false }
        },
      },
    }
  }

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const freeze = async (git: GitPort) => {
    const out = await freezeArtifact({
      db,
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
      workItemId: 'wi-1',
    })
    if (!out.ok) throw new Error('fixture did not freeze')
    return out.artifact
  }

  test('a moved branch releases the change and says so on the thread', async () => {
    const git = trackingGit()
    const host = recordingHost()
    const artifact = await freeze(git.port)

    const out = await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-1',
      newHeadSha: MOVED,
      notify: { codeHost: host.port, threadParams: { __project__: 'p', mr: '412', thread: 't1' } },
    })

    expect(out).toEqual({ invalidated: true, artifactId: artifact.id, notified: true })
    // The ref is freed, not just the row: an unreleased ref pins the commit.
    expect(git.refs.size).toBe(0)
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('superseded')

    // And the person who was told to reply learns that replying will not work.
    expect(host.calls.length).toBe(1)
    expect(host.calls[0]?.params.body).toContain('no longer applies')
    expect(host.calls[0]?.params.body).toContain(MOVED.slice(0, 12))
  })

  test('a push that lands exactly on the artifact’s base changes nothing', async () => {
    // The platform's own push, or the same revision re-reported. The change
    // still applies, and discarding it would throw away work for no reason.
    const git = trackingGit()
    const host = recordingHost()
    await freeze(git.port)

    const out = await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-1',
      newHeadSha: BASE,
      notify: { codeHost: host.port, threadParams: {} },
    })

    expect(out).toEqual({ invalidated: false, reason: 'still-current' })
    expect(git.refs.size).toBe(1)
    expect(host.calls).toEqual([])
  })

  test('invalidating twice posts once', async () => {
    // The same push arrives as several events — `mr_updated`, a pipeline start,
    // a comment from CI — and each wakes the monitor. One notice, not three.
    const git = trackingGit()
    const host = recordingHost()
    await freeze(git.port)

    const notify = { codeHost: host.port, threadParams: {} }
    await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-1',
      newHeadSha: MOVED,
      notify,
    })
    const second = await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-1',
      newHeadSha: MOVED,
      notify,
    })

    expect(second).toEqual({ invalidated: false, reason: 'nothing-pending' })
    expect(host.calls.length).toBe(1)
  })

  test('with nothing pending, a push is a no-op', async () => {
    const git = trackingGit()
    const out = await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-none',
      newHeadSha: MOVED,
    })
    expect(out).toEqual({ invalidated: false, reason: 'nothing-pending' })
  })

  test('without a notify target the change is still released', async () => {
    // Releasing is the part that must not be optional: an unreleased artifact
    // pins a commit in the object store forever.
    const git = trackingGit()
    await freeze(git.port)

    const out = await invalidatePendingOnPush({
      db,
      git: git.port,
      workItemId: 'wi-1',
      newHeadSha: MOVED,
    })

    expect(out).toEqual({ invalidated: true, artifactId: expect.any(String), notified: false })
    expect(git.refs.size).toBe(0)
  })
})
