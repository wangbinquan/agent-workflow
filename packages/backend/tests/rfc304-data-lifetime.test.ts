// RFC-304 §11.4 (T62) — the lifetime rules, and the one that has no age term.
//
// The arithmetic forcing this: one repository, 50 active merge requests, 3
// rounds a day, 180 days = 27,000 rounds — ~350k stage rows, ~400k AI attempt
// rows, ~270k finding rows, plus a template snapshot per round.
//
// The failure being prevented is not "the database is large". It is what an
// administrator DOES about a large database: delete rows by hand, which takes
// the ledger and the adoption numbers with it. So these rules exist to make the
// manual cleanup unnecessary, not to make it safe.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeAiAttempts, codeArtifacts } from '../src/db/schema'
import { sweepCapabilityData } from '../src/modules/code-capability/application/dataLifetimeGc'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
import {
  ATTEMPT_RETENTION_MS,
  DETAIL_RETENTION_MS,
  judgeArtifactRetention,
  judgeAttemptRetention,
  judgeFindingRetention,
  judgeRoundRetention,
  snapshotKey,
} from '../src/modules/code-capability/domain/dataLifetime'

const DAY = 24 * 60 * 60 * 1000

describe('RFC-304 T62 — rounds and stages', () => {
  test('an ACTIVE work item keeps everything, however old', () => {
    // A merge request open six months is exactly the one whose history somebody
    // needs. Age is not evidence of irrelevance while work still arrives on it.
    const verdict = judgeRoundRetention({ workItemClosed: false, ageMs: 365 * DAY })
    expect(verdict.kind).toBe('keep')
    expect(verdict.reason).toContain('still active')
  })

  test('a recently closed item still keeps its detail', () => {
    expect(judgeRoundRetention({ workItemClosed: true, ageMs: 10 * DAY }).kind).toBe('keep')
  })

  test('an old closed item is SUMMARISED, not discarded', () => {
    // The distinction that keeps the metric honest: the rollup survives, so
    // "how many rounds did this take" still has an answer after the per-stage
    // detail is gone.
    const verdict = judgeRoundRetention({
      workItemClosed: true,
      ageMs: DETAIL_RETENTION_MS + DAY,
    })
    expect(verdict.kind).toBe('summarise')
  })

  test('closing is required — age alone never archives', () => {
    // Mutation bait: a rule keyed on age alone would archive the history of the
    // longest-running merge requests, which are the ones under active
    // discussion.
    expect(
      judgeRoundRetention({ workItemClosed: false, ageMs: DETAIL_RETENTION_MS * 10 }).kind,
    ).toBe('keep')
  })
})

describe('RFC-304 T62 — AI attempts', () => {
  test('recent attempts are kept for debugging a specific round', () => {
    expect(judgeAttemptRetention({ workItemClosed: false, ageMs: DAY }).kind).toBe('keep')
  })

  test('old attempts are summarised — the per-stage counts survive', () => {
    // What anyone asks of these later is "how often did this stage need a
    // retry", which the aggregate answers. The individual prompts are only
    // useful for days.
    const verdict = judgeAttemptRetention({
      workItemClosed: true,
      ageMs: ATTEMPT_RETENTION_MS + DAY,
    })
    expect(verdict.kind).toBe('summarise')
    expect(verdict.reason).toContain('counts')
  })

  test('attempt retention does NOT depend on the work item being closed', () => {
    // Different rule from rounds on purpose: attempts are the fastest-growing
    // table, and a long-lived active merge request is precisely where they pile
    // up. Gating on `closed` would exempt the worst case.
    expect(
      judgeAttemptRetention({ workItemClosed: false, ageMs: ATTEMPT_RETENTION_MS + DAY }).kind,
    ).toBe('summarise')
  })
})

describe('RFC-304 T62 — findings have no age term at all', () => {
  test('findings are kept indefinitely', () => {
    // The adoption metric reads them. A denominator that quietly shrinks with
    // age does not degrade gracefully — it reports a CHANGING number for an
    // unchanged past, which is worse than reporting nothing.
    expect(judgeFindingRetention().kind).toBe('keep')
    expect(judgeFindingRetention().reason).toContain('adoption')
  })
})

describe('RFC-304 T62 — artifacts are reclaimed immediately', () => {
  test('a live artifact something waits on is kept', () => {
    expect(judgeArtifactRetention({ state: 'live', refCount: 1 }).kind).toBe('keep')
  })

  test('an unreferenced artifact goes without waiting for the work item to close', () => {
    // Each one pins a commit against `git gc`. Holding them until close is how
    // an object store grows without anybody changing a setting.
    expect(judgeArtifactRetention({ state: 'live', refCount: 0 }).kind).toBe('discard')
    expect(judgeArtifactRetention({ state: 'consumed', refCount: 0 }).kind).toBe('discard')
    expect(judgeArtifactRetention({ state: 'superseded', refCount: 0 }).kind).toBe('discard')
  })

  test('a superseded artifact goes even if a stale refcount says otherwise', () => {
    // Superseded means a newer change replaced it; nobody can confirm it any
    // more. A lingering refcount is a bug, and keeping the object because of
    // one would make that bug permanent rather than transient.
    expect(judgeArtifactRetention({ state: 'superseded', refCount: 3 }).kind).toBe('discard')
  })
})

describe('RFC-304 T62 — template snapshots are content-addressed', () => {
  test('the same content shares one key across rounds', () => {
    expect(snapshotKey('abc123')).toBe(snapshotKey('abc123'))
  })

  test('different content never shares', () => {
    // Keyed by DIGEST rather than by template id + version: two different
    // bodies that happen to share a version number would collide, and that is
    // exactly the case where sharing corrupts a round's record of what it ran.
    expect(snapshotKey('abc123')).not.toBe(snapshotKey('def456'))
  })
})

// The sweep that actually runs the rules. Rules with no sweeper are a policy
// nobody enforces, and the consequence here is specific: an administrator
// eventually deletes rows by hand and takes the finding ledger — and therefore
// the adoption numbers — with it.
describe('RFC-304 T62 — the hourly sweep', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  const NOW = 1_700_000_000_000

  const artifact = async (over: Partial<typeof codeArtifacts.$inferInsert> = {}) => {
    await db.insert(codeArtifacts).values({
      id: ulid(),
      repoPath: '/tmp/r',
      commitSha: 'c'.repeat(40),
      baseSha: 'b'.repeat(40),
      digest: 'd',
      keepRef: 'refs/aw/x',
      refCount: 0,
      state: 'live',
      createdAt: NOW,
      releasedAt: NOW,
      ...over,
    })
  }

  // Distinct shard keys: the table's identity index is
  // (round, stage, shard, rerun, attempt), so two rows of the same stage need
  // to differ somewhere real rather than only in their id.
  let shard = 0
  const attempt = async (startedAt: number) => {
    shard += 1
    await db.insert(codeAiAttempts).values({
      id: ulid(),
      roundId: 'round-1',
      stageName: 'review-shard',
      shardKey: `src/f${String(shard)}.ts`,
      status: 'validated',
      startedAt,
    })
  }

  test('unreferenced artifacts are reclaimed', async () => {
    await artifact()
    await artifact()
    const out = await sweepCapabilityData({ db, now: () => NOW })
    expect(out.artifactsReclaimed).toBe(2)
    expect(await db.select().from(codeArtifacts)).toHaveLength(0)
  })

  test('an artifact something still waits on is left alone', async () => {
    // The confirmation path holds exactly one of these across days of waiting.
    // Reclaiming it would delete the change a person is being asked about.
    await artifact({ refCount: 1, releasedAt: null })
    const out = await sweepCapabilityData({ db, now: () => NOW })
    expect(out.artifactsReclaimed).toBe(0)
    expect(await db.select().from(codeArtifacts)).toHaveLength(1)
  })

  test('attempts past the window go; recent ones stay', async () => {
    await attempt(NOW - ATTEMPT_RETENTION_MS - DAY)
    await attempt(NOW - DAY)

    const out = await sweepCapabilityData({ db, now: () => NOW })
    expect(out.attemptsSwept).toBe(1)
    expect(await db.select().from(codeAiAttempts)).toHaveLength(1)
  })

  test('a tick is BOUNDED, so a first sweep cannot hold the write lock', async () => {
    // A database that has never been swept would otherwise try to delete
    // hundreds of thousands of rows in one transaction and look hung at exactly
    // the moment somebody first turns the feature on.
    for (let i = 0; i < 12; i += 1) await artifact()

    const out = await sweepCapabilityData({ db, now: () => NOW, batchLimit: 5 })
    expect(out.artifactsReclaimed).toBe(5)
    expect(await db.select().from(codeArtifacts)).toHaveLength(7)
  })

  test('repeated sweeps converge', async () => {
    // The other half of bounding: it only has to keep up with the inflow, and a
    // neglected database catches up over ticks rather than in one pass.
    for (let i = 0; i < 12; i += 1) await artifact()
    for (let i = 0; i < 3; i += 1) await sweepCapabilityData({ db, now: () => NOW, batchLimit: 5 })
    expect(await db.select().from(codeArtifacts)).toHaveLength(0)
  })

  test('an empty database sweeps to zero without erroring', async () => {
    // The overwhelming majority of ticks. A sweep that threw on nothing-to-do
    // would fill the log with warnings that mean the system is healthy.
    await expect(sweepCapabilityData({ db, now: () => NOW })).resolves.toEqual({
      attemptsSwept: 0,
      artifactsReclaimed: 0,
      roundsSummarised: 0,
    })
  })
})
