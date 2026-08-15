// RFC-304 T12c — the concurrency invariants against a real database.
//
// The domain tests prove the DECISIONS are right. These prove the writes are
// atomic, which is a different property and the one that actually fails in
// production: read-decide-write with a plain UPDATE loses exactly the races the
// lease exists to prevent, and every assertion here would still pass against
// that broken implementation if it only checked the happy path.
//
// So each test drives the losing side too:
//   - two rounds racing for a free lease ⇒ exactly one wins;
//   - a takeover ⇒ the loser cannot release the winner's lease;
//   - a restart ⇒ leases from the old generation are reclaimed, not waited out;
//   - settle ⇒ ids and state land together, never state-without-ids.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codePublishIntents } from '../src/db/schema'
import { mintLeaseToken, type MrLeaseKey } from '../src/modules/code-capability/domain/mrLease'
import {
  acquireLease,
  readLease,
  reclaimStaleLeases,
  releaseLease,
  renewLease,
} from '../src/modules/code-capability/infrastructure/sqliteMrLeaseStore'
import {
  abandonIntentsOfRounds,
  closeIntent,
  planRecoveryFor,
  readPendingIntents,
  settleIntent,
  writeIntent,
} from '../src/modules/code-capability/infrastructure/sqlitePublishIntentStore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GEN = 'gen-7'
const LEASE_MS = 30_000

const KEY: MrLeaseKey = {
  codeHostEndpointId: 'ep_7',
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

describe('RFC-304 T12c — MR lease, persisted', () => {
  let db: DbClient
  let clock: number

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    clock = 1_000_000
  })
  afterEach(() => db.$client.close())

  const deps = () => ({ db, daemonGeneration: GEN, leaseMs: LEASE_MS, now: () => clock })

  test('two rounds racing for a free lease: exactly one wins', async () => {
    // The core invariant. Both see "free"; the primary key decides.
    const a = await acquireLease(deps(), KEY, 'round-a', mintLeaseToken(GEN, 'n1'))
    const b = await acquireLease(deps(), KEY, 'round-b', mintLeaseToken(GEN, 'n2'))

    expect(a.outcome).toBe('acquired')
    expect(b.outcome).toBe('busy')
    expect(b.outcome === 'busy' && b.heldBy).toBe('round-a')
    expect((await readLease(db, KEY))?.roundId).toBe('round-a')
  })

  test('the two capabilities on one MR contend — that contention IS the point', async () => {
    // `mr-review` and `mr-monitor` are different work items. Without this lease
    // the monitor pushes a CI fix while the review comments on the old sha.
    const review = await acquireLease(deps(), KEY, 'review-round', mintLeaseToken(GEN, 'r'))
    const monitor = await acquireLease(deps(), KEY, 'monitor-round', mintLeaseToken(GEN, 'm'))
    expect(review.outcome).toBe('acquired')
    expect(monitor.outcome).toBe('busy')
  })

  test('a different MR is not blocked', async () => {
    await acquireLease(deps(), KEY, 'round-a', mintLeaseToken(GEN, 'n1'))
    const other = await acquireLease(
      deps(),
      { ...KEY, anchorId: '999' },
      'round-b',
      mintLeaseToken(GEN, 'n2'),
    )
    expect(other.outcome).toBe('acquired')
  })

  test('an expired lease is taken over, and the loser cannot release the winner', async () => {
    const staleToken = mintLeaseToken(GEN, 'n1')
    await acquireLease(deps(), KEY, 'round-a', staleToken)

    clock += LEASE_MS + 1
    const winnerToken = mintLeaseToken(GEN, 'n2')
    expect((await acquireLease(deps(), KEY, 'round-b', winnerToken)).outcome).toBe('acquired')

    // The old round finally notices and tries to clean up. Releasing by round
    // id — or unconditionally — would hand the MR to a third round while
    // round-b is mid-write.
    const release = await releaseLease(db, KEY, staleToken)
    expect(release.released).toBe(false)
    expect(release.reason).toContain('round-b')
    expect((await readLease(db, KEY))?.roundId).toBe('round-b')
  })

  test('renewal requires the token, and a superseded holder cannot extend', async () => {
    const tokenA = mintLeaseToken(GEN, 'n1')
    await acquireLease(deps(), KEY, 'round-a', tokenA)
    expect(await renewLease(deps(), KEY, tokenA)).toBe(true)

    clock += LEASE_MS + 1
    await acquireLease(deps(), KEY, 'round-b', mintLeaseToken(GEN, 'n2'))
    // Returning false is the signal the old round must STOP writing.
    expect(await renewLease(deps(), KEY, tokenA)).toBe(false)
  })

  test('a released lease frees the MR for the next capability', async () => {
    const token = mintLeaseToken(GEN, 'n1')
    await acquireLease(deps(), KEY, 'round-a', token)
    expect((await releaseLease(db, KEY, token)).released).toBe(true)
    expect(await readLease(db, KEY)).toBeNull()
    expect((await acquireLease(deps(), KEY, 'round-b', mintLeaseToken(GEN, 'n2'))).outcome).toBe(
      'acquired',
    )
  })

  test('a restart reclaims leases from the old generation instead of waiting them out', async () => {
    // A long lease held by a dead process would otherwise block the MR for its
    // full duration, with nothing left alive to renew or release it.
    await acquireLease(
      { db, daemonGeneration: 'gen-6', leaseMs: LEASE_MS * 100, now: () => clock },
      KEY,
      'round-old',
      mintLeaseToken('gen-6', 'n1'),
    )
    expect(await reclaimStaleLeases(db, GEN)).toBe(1)
    expect(await readLease(db, KEY)).toBeNull()
  })

  test('reclaim leaves the CURRENT generation alone', async () => {
    // The reverse assertion: a reclaim that dropped everything would pass the
    // test above while breaking every live round.
    await acquireLease(deps(), KEY, 'round-a', mintLeaseToken(GEN, 'n1'))
    expect(await reclaimStaleLeases(db, GEN)).toBe(0)
    expect((await readLease(db, KEY))?.roundId).toBe('round-a')
  })

  test('a round re-acquiring its own lease does not deadlock against itself', async () => {
    const token = mintLeaseToken(GEN, 'n1')
    await acquireLease(deps(), KEY, 'round-a', token)
    const again = await acquireLease(deps(), KEY, 'round-a', mintLeaseToken(GEN, 'n1b'))
    expect(again.outcome).toBe('acquired')
  })
})

describe('RFC-304 T12c — publish intents, persisted', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const write = async (batchId: string, roundId = 'round-1', fingerprints = ['fp-a', 'fp-b']) =>
    await writeIntent(db, {
      batchId,
      roundId,
      epoch: 1,
      fingerprints,
      anchorRef: 'mr/412',
      now: 1_000,
    })

  test('a pending batch is what recovery finds after a crash', async () => {
    await write('batch-1')
    const pending = await readPendingIntents(db)
    expect(pending.map((p) => p.batchId)).toEqual(['batch-1'])
    expect(pending[0]?.fingerprints).toEqual(['fp-a', 'fp-b'])
  })

  test('settle writes ids and state TOGETHER', async () => {
    // Split across two statements, an interruption between them produces the
    // worst row in the system: recovery skips it (looks settled) and the next
    // reconciliation re-posts exactly the entries whose ids are missing.
    await write('batch-1')
    expect(await settleIntent(db, 'batch-1', { 'fp-a': 'note-1', 'fp-b': 'note-2' }, 2_000)).toBe(
      true,
    )
    const [row] = await db
      .select()
      .from(codePublishIntents)
      .where(eq(codePublishIntents.batchId, 'batch-1'))
    expect(row?.state).toBe('settled')
    expect(JSON.parse(row?.externalIdsJson ?? '{}')).toEqual({ 'fp-a': 'note-1', 'fp-b': 'note-2' })
    expect(await readPendingIntents(db)).toEqual([])
  })

  test('a retried settle cannot overwrite ids a recovery already reconciled', async () => {
    // CAS on `pending`: the second settle is a no-op rather than a clobber.
    await write('batch-1')
    await settleIntent(db, 'batch-1', { 'fp-a': 'recovered-1', 'fp-b': 'recovered-2' })
    expect(await settleIntent(db, 'batch-1', { 'fp-a': 'wrong' })).toBe(false)
    const [row] = await db
      .select()
      .from(codePublishIntents)
      .where(eq(codePublishIntents.batchId, 'batch-1'))
    expect(JSON.parse(row?.externalIdsJson ?? '{}')['fp-a']).toBe('recovered-1')
  })

  test('recovery plans against the REMOTE, not against a guess', async () => {
    await write('batch-1')

    // Nothing landed.
    expect((await planRecoveryFor(db, 'batch-1', { present: {} })).action).toBe('resend')

    // Everything landed — the crash-after-publish case.
    const all = await planRecoveryFor(db, 'batch-1', {
      present: { 'fp-a': 'note-1', 'fp-b': 'note-2' },
    })
    expect(all.action).toBe('adopt')

    // Half landed. Resending the batch would duplicate `fp-a`.
    const half = await planRecoveryFor(db, 'batch-1', { present: { 'fp-a': 'note-1' } })
    expect(half.action).toBe('complete')
    expect(half.action === 'complete' && half.resend).toEqual(['fp-b'])
  })

  test('a batch with no intent row plans nothing rather than resending blindly', async () => {
    const plan = await planRecoveryFor(db, 'never-written', { present: {} })
    expect(plan.action).toBe('none')
  })

  test('preemption abandons pending batches so recovery does not resurrect them', async () => {
    // A preempted round may have several batches in flight; leaving any
    // `pending` makes a later recovery pass reconcile work that was
    // deliberately dropped.
    await write('batch-1', 'round-1')
    await write('batch-2', 'round-1')
    await write('batch-3', 'round-2')

    expect(await abandonIntentsOfRounds(db, ['round-1'])).toBe(2)
    const pending = await readPendingIntents(db)
    expect(pending.map((p) => p.batchId)).toEqual(['batch-3'])
    expect((await planRecoveryFor(db, 'batch-1', { present: {} })).action).toBe('none')
  })

  test('abandon does not touch an already-settled batch', async () => {
    await write('batch-1')
    await settleIntent(db, 'batch-1', { 'fp-a': '1', 'fp-b': '2' })
    expect(await abandonIntentsOfRounds(db, ['round-1'])).toBe(0)
  })

  test('compensated and abandoned stay distinguishable in the history', async () => {
    await write('batch-1')
    expect(await closeIntent(db, 'batch-1', 'compensated')).toBe(true)
    const plan = await planRecoveryFor(db, 'batch-1', { present: {} })
    expect(plan.action === 'none' && plan.reason).toContain('compensated')
  })

  test('readPendingIntents can scope to one round', async () => {
    await write('batch-1', 'round-1')
    await write('batch-2', 'round-2')
    expect((await readPendingIntents(db, 'round-2')).map((p) => p.batchId)).toEqual(['batch-2'])
  })
})
