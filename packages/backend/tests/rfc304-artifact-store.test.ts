// RFC-304 T2c — freezing a change, and letting it go again.
//
// The freeze half is easy to get right and easy to test. The RELEASE half is
// the one that gets forgotten, and its failure is invisible for months: every
// artifact holds a git ref pinning a commit, so an artifact that is never
// released is a commit the object store can never collect. A team running a few
// of these a day notices as a slowly growing clone, long after the cause.
//
// So the tests below count refs as carefully as they check content, and the
// negative cases — a superseded change, an abandoned one — assert that the ref
// actually went away rather than that the row changed state.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeArtifacts } from '../src/db/schema'
import {
  artifactKeepRef,
  digestOfDiff,
  findLiveArtifactByDigest,
  findPendingArtifact,
  freezeArtifact,
  releaseArtifact,
  retainArtifact,
  supersedeArtifacts,
} from '../src/modules/code-capability/application/artifactStore'
import { createGitPortFake } from './helpers/gitPortFake'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BASE = 'b'.repeat(40)
const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,1 @@', '-a', '+A'].join('\n')

/** A git double that records which refs exist, so leaks are visible. */
function refTrackingGit(over: Partial<GitPort> = {}): {
  port: GitPort
  refs: Set<string>
  pushes: Array<{ commitSha: string; branch: string; expectedRemoteSha: string }>
} {
  const refs = new Set<string>()
  const pushes: Array<{ commitSha: string; branch: string; expectedRemoteSha: string }> = []
  const port = createGitPortFake(
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
      async pushCommit(input) {
        pushes.push({
          commitSha: input.commitSha,
          branch: input.branch,
          expectedRemoteSha: input.expectedRemoteSha,
        })
        return { ok: true }
      },
      ...over,
    },
  )
  return { port, refs, pushes }
}

describe('RFC-304 T2c — the digest identifies the CHANGE', () => {
  test('the same change digests the same, whatever produced it', () => {
    expect(digestOfDiff(DIFF)).toBe(digestOfDiff(DIFF))
  })

  test('line endings do not change a change', () => {
    // Otherwise the identical edit produced on Windows and on Linux reads as
    // two different fixes, and the platform offers the same one twice.
    expect(digestOfDiff(DIFF.replace(/\n/g, '\r\n'))).toBe(digestOfDiff(DIFF))
  })

  test('a different change digests differently', () => {
    expect(digestOfDiff(DIFF.replace('+A', '+B'))).not.toBe(digestOfDiff(DIFF))
  })
})

describe('RFC-304 T2c — freezing', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a frozen change is committed, kept alive, and recorded', async () => {
    const git = refTrackingGit()
    const result = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix: address review comment',
      workItemId: 'wi-1',
      generation: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a frozen artifact')
    expect(result.artifact.digest).toBe(digestOfDiff(DIFF))
    expect(result.artifact.baseSha).toBe(BASE)

    // The ref is what stops `git gc` from collecting the commit while a human
    // decides. Without it the confirmation arrives to a missing object.
    expect(git.refs.has(artifactKeepRef(result.artifact.id))).toBe(true)

    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('live')
    // One reference from the moment it is frozen — the thread it is posted to.
    // Starting at zero would make it collectable before it has been shown.
    expect(row?.refCount).toBe(1)
    expect(row?.generation).toBe(2)
  })

  test('an agent that changed nothing produces no artifact and no row', async () => {
    // Not a failure: the agent looked and concluded nothing needed doing. But
    // posting an empty diff and asking a human to confirm it would be absurd.
    const git = refTrackingGit({
      async commitWorktree() {
        return { ok: false, reason: 'no-changes' }
      },
    })

    const result = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
    })

    expect(result).toEqual({ ok: false, reason: 'no-changes' })
    expect((await db.select().from(codeArtifacts)).length).toBe(0)
    expect(git.refs.size).toBe(0)
  })

  test('a commit whose diff cannot be read drops its ref rather than pinning it', async () => {
    // The object exists but can never be shown or verified, so it is dead the
    // moment it is created. Leaving the ref would pin it forever.
    const git = refTrackingGit({
      async readCommitDiff() {
        return { ok: false, error: 'bad object' }
      },
    })

    const result = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
    })

    expect(result.ok).toBe(false)
    expect(git.refs.size).toBe(0)
    expect((await db.select().from(codeArtifacts)).length).toBe(0)
  })
})

describe('RFC-304 T2c — releasing', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const freeze = async (git: GitPort, over: { workItemId?: string; generation?: number } = {}) => {
    const out = await freezeArtifact({
      db,
      git,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
      workItemId: over.workItemId ?? 'wi-1',
      generation: over.generation ?? 1,
    })
    if (!out.ok) throw new Error('fixture did not freeze')
    return out.artifact
  }

  test('the last release collects the object', async () => {
    const git = refTrackingGit()
    const artifact = await freeze(git.port)

    const released = await releaseArtifact(db, git.port, artifact.id, 'consumed')

    expect(released.collected).toBe(true)
    expect(git.refs.size).toBe(0)
    const [row] = await db.select().from(codeArtifacts)
    // Marked, not deleted: "a change was proposed and never answered" is a
    // question the activity view still has to answer after the object is gone.
    expect(row?.state).toBe('consumed')
    expect(row?.releasedAt).not.toBeNull()
  })

  test('a release with another holder does NOT collect', async () => {
    const git = refTrackingGit()
    const artifact = await freeze(git.port)
    await retainArtifact(db, artifact.id)

    const released = await releaseArtifact(db, git.port, artifact.id, 'consumed')

    expect(released.collected).toBe(false)
    expect(git.refs.size).toBe(1)
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('live')
    expect(row?.refCount).toBe(1)
  })

  test('releasing twice is harmless', async () => {
    const git = refTrackingGit()
    const artifact = await freeze(git.port)

    await releaseArtifact(db, git.port, artifact.id, 'consumed')
    const second = await releaseArtifact(db, git.port, artifact.id, 'abandoned')

    expect(second.collected).toBe(false)
    // The first reason survives — an artifact that was pushed did not later
    // become abandoned.
    const [row] = await db.select().from(codeArtifacts)
    expect(row?.state).toBe('consumed')
  })

  test('a moved branch supersedes the pending artifact and frees its ref', async () => {
    // The change was computed against code that has since been rewritten.
    // Leaving it live means a confirmation could still name it.
    const git = refTrackingGit()
    const pending = await freeze(git.port, { generation: 2 })
    expect(git.refs.size).toBe(1)

    const out = await supersedeArtifacts(db, git.port, 'wi-1', 2)

    expect(out.superseded).toEqual([pending.id])
    // The ref, not just the row: a superseded artifact whose ref survived is a
    // commit the object store can never collect.
    expect(git.refs.size).toBe(0)
    const [row] = await db.select().from(codeArtifacts).where(eq(codeArtifacts.id, pending.id))
    expect(row?.state).toBe('superseded')
  })

  test('superseding leaves a NEWER generation alone', async () => {
    // A fresh artifact prepared in response to the very push that superseded
    // the old one must survive it, or the platform would immediately discard
    // its own replacement.
    const git = refTrackingGit()
    await freeze(git.port, { generation: 1 })
    const newer = await freeze(git.port, { generation: 5 })

    await supersedeArtifacts(db, git.port, 'wi-1', 3)

    const [row] = await db.select().from(codeArtifacts).where(eq(codeArtifacts.id, newer.id))
    expect(row?.state).toBe('live')
    expect(git.refs.has(newer.keepRef)).toBe(true)
  })

  test('another work item’s artifacts are untouched', async () => {
    const git = refTrackingGit()
    const mine = await freeze(git.port, { workItemId: 'wi-1' })
    const theirs = await freeze(git.port, { workItemId: 'wi-2' })

    await supersedeArtifacts(db, git.port, 'wi-1', 9)

    const [row] = await db.select().from(codeArtifacts).where(eq(codeArtifacts.id, theirs.id))
    expect(row?.state).toBe('live')
    expect(git.refs.has(theirs.keepRef)).toBe(true)
    expect(git.refs.has(mine.keepRef)).toBe(false)
  })
})

describe('RFC-304 T2c — lookup', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('an artifact is found by the SHORT digest a comment carried', async () => {
    const git = refTrackingGit()
    const out = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
      workItemId: 'wi-1',
    })
    if (!out.ok) throw new Error('fixture did not freeze')

    const found = await findLiveArtifactByDigest(db, out.artifact.digest.slice(0, 12))
    expect(found?.id).toBe(out.artifact.id)
  })

  test('a wildcard in the digest matches nothing', async () => {
    // The prefix comes from a comment body. Matched with SQL `LIKE` it would be
    // a pattern, and `%` would return whichever artifact happened to sort
    // first — belonging to any merge request in the deployment.
    const git = refTrackingGit()
    await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
      workItemId: 'wi-1',
    })

    expect(await findLiveArtifactByDigest(db, '%')).toBeNull()
    expect(await findLiveArtifactByDigest(db, '_')).toBeNull()
  })

  test('a released artifact is not found', async () => {
    const git = refTrackingGit()
    const out = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'fix',
      workItemId: 'wi-1',
    })
    if (!out.ok) throw new Error('fixture did not freeze')
    await releaseArtifact(db, git.port, out.artifact.id, 'consumed')

    expect(await findLiveArtifactByDigest(db, out.artifact.digest)).toBeNull()
    expect(await findPendingArtifact(db, 'wi-1')).toBeNull()
  })

  test('freezing a second artifact supersedes the first — at most one is pending', async () => {
    // Enforced at freeze time rather than sorted out at read time, for two
    // reasons. Two live diffs on one thread are ambiguous for the PERSON —
    // "/aw apply" has no answer to "which one?" — and picking the newer by id
    // does not even work: `ulid()` draws fresh randomness per call, so two ids
    // minted in the same millisecond sort in random order. This test failed
    // exactly that way before the rule existed, and the production cost of the
    // coin-flip is pushing a change nobody confirmed.
    const git = refTrackingGit()
    const older = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'first',
      workItemId: 'wi-1',
    })
    const newer = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'second',
      workItemId: 'wi-1',
    })
    if (!older.ok || !newer.ok) throw new Error('fixture did not freeze')

    expect((await findPendingArtifact(db, 'wi-1'))?.id).toBe(newer.artifact.id)

    const [supersededRow] = await db
      .select()
      .from(codeArtifacts)
      .where(eq(codeArtifacts.id, older.artifact.id))
    expect(supersededRow?.state).toBe('superseded')
    // …and its ref is gone, so the old commit is collectable again.
    expect(git.refs.has(older.artifact.keepRef)).toBe(false)
    expect(git.refs.has(newer.artifact.keepRef)).toBe(true)
  })

  test('a second artifact on ANOTHER work item supersedes nothing', async () => {
    const git = refTrackingGit()
    const mine = await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'first',
      workItemId: 'wi-1',
    })
    await freezeArtifact({
      db,
      git: git.port,
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: BASE,
      message: 'second',
      workItemId: 'wi-2',
    })
    if (!mine.ok) throw new Error('fixture did not freeze')

    expect((await findPendingArtifact(db, 'wi-1'))?.id).toBe(mine.artifact.id)
    expect(git.refs.size).toBe(2)
  })
})
