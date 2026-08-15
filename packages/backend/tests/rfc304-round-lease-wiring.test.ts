// RFC-304 §2.3 — the MR lease, held across a whole round.
//
// The concrete failure it prevents, from the design: an MR update and a
// pipeline failure arrive together, `mr-monitor` starts fixing CI and pushes,
// and `mr-review` — still working from the OLD sha — posts remarks on code the
// machine has already changed. The author reads comments about lines that no
// longer exist.
//
// So the lease is keyed by the MR and NOT by the capability: "review is
// independent of the monitor" means their entry points are independent, not
// that they are independent concurrency domains.
//
// The other half is that a leaked lease is worse than a failed round. A round
// that dies holding one silently blocks every capability on that MR until it
// expires, and nothing on the MR says why nothing is happening — hence the
// release on every exit path, and the daemon-generation fence for a process
// that died without releasing anything at all.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { acquireRoundLease, withRoundLease } from '../src/services/codeRoundLease'
import { readLease } from '../src/modules/code-capability/infrastructure/sqliteMrLeaseStore'
import type { MrLeaseKey } from '../src/modules/code-capability/domain/mrLease'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const key: MrLeaseKey = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

describe('RFC-304 — two capabilities on one MR serialise', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('the first round takes the lease', async () => {
    const got = await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    expect(got.ok).toBe(true)
  })

  test('a second round on the SAME MR is refused while the first holds it', async () => {
    // The whole point: `mr-monitor` must not start while `mr-review` is mid-round
    // on this MR, or one of them publishes against a sha the other just moved.
    await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    const second = await acquireRoundLease({
      db,
      daemonGeneration: 'g1',
      key,
      roundId: 'round-2',
    })
    expect(second.ok).toBe(false)
    expect(!second.ok && second.heldBy).toBe('round-1')
  })

  test('a DIFFERENT MR is not blocked', async () => {
    // The lease serialises one merge request, not the whole platform.
    await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    const other = await acquireRoundLease({
      db,
      daemonGeneration: 'g1',
      key: { ...key, anchorId: '999' },
      roundId: 'round-2',
    })
    expect(other.ok).toBe(true)
  })

  test('a different project with the same MR number is not blocked', async () => {
    // MR numbers are per-project; keying on the number alone would make two
    // unrelated projects contend.
    await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    const other = await acquireRoundLease({
      db,
      daemonGeneration: 'g1',
      key: { ...key, stableProjectId: '99999' },
      roundId: 'round-2',
    })
    expect(other.ok).toBe(true)
  })

  test('releasing lets the next round in', async () => {
    const first = await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    expect(first.ok).toBe(true)
    if (first.ok) await first.lease.release()

    const second = await acquireRoundLease({
      db,
      daemonGeneration: 'g1',
      key,
      roundId: 'round-2',
    })
    expect(second.ok).toBe(true)
  })
})

describe('RFC-304 — the lease is released on every exit path', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('a round that succeeds releases', async () => {
    const out = await withRoundLease(
      { db, daemonGeneration: 'g1', key, roundId: 'round-1' },
      async () => 'done',
    )
    expect(out).toEqual({ ok: true, value: 'done' })
    expect(await readLease(db, key)).toBeNull()
  })

  test('a round that THROWS still releases', async () => {
    // The case that matters. A leaked lease blocks every capability on this MR
    // until it expires, and nothing on the MR explains the silence.
    await expect(
      withRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' }, async () => {
        throw new Error('stage exploded')
      }),
    ).rejects.toThrow('stage exploded')
    expect(await readLease(db, key)).toBeNull()
  })

  test('a refused round does not release someone else’s lease on its way out', async () => {
    // The subtle one: the loser must not run the release path, or it would
    // free the winner's lease and let a third round in mid-flight.
    await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    const refused = await withRoundLease(
      { db, daemonGeneration: 'g1', key, roundId: 'round-2' },
      async () => 'should not run',
    )
    expect(refused.ok).toBe(false)
    expect(await readLease(db, key)).not.toBeNull()
  })

  test('the body does not run when the lease is refused', async () => {
    await acquireRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-1' })
    let ran = false
    await withRoundLease({ db, daemonGeneration: 'g1', key, roundId: 'round-2' }, async () => {
      ran = true
      return 'x'
    })
    expect(ran).toBe(false)
  })
})

describe('RFC-304 — a daemon that died holding leases', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('a lease from an older generation does not block the new daemon', async () => {
    // Without the fence, a crash while holding leases would lock every MR the
    // dead process touched until each one expired — and the operator's only
    // symptom would be a platform that stopped responding to some MRs.
    await acquireRoundLease({ db, daemonGeneration: 'old-gen', key, roundId: 'round-1' })
    const afterRestart = await acquireRoundLease({
      db,
      daemonGeneration: 'new-gen',
      key,
      roundId: 'round-2',
    })
    expect(afterRestart.ok).toBe(true)
  })

  test('the reclaimed lease belongs to the new round, not the dead one', async () => {
    await acquireRoundLease({ db, daemonGeneration: 'old-gen', key, roundId: 'round-1' })
    await acquireRoundLease({ db, daemonGeneration: 'new-gen', key, roundId: 'round-2' })
    expect((await readLease(db, key))?.roundId).toBe('round-2')
  })

  test('a stale round releasing after reclaim does NOT free the new holder', async () => {
    // Token fencing. The old round may still be unwinding; its release must be
    // a no-op rather than handing the MR to whoever asks next.
    const dead = await acquireRoundLease({
      db,
      daemonGeneration: 'old-gen',
      key,
      roundId: 'round-1',
    })
    await acquireRoundLease({ db, daemonGeneration: 'new-gen', key, roundId: 'round-2' })
    if (dead.ok) await dead.lease.release()
    expect((await readLease(db, key))?.roundId).toBe('round-2')
  })
})
