// RFC-304 §2.3 — the three rows of the lease protocol table nothing executed.
//
// design.md §2.2「lease 的完整协议」spells the contract out as a table. Three of
// its rows were built and then never joined to anything:
//
//   续租     轮次心跳续租；超时未续 ⇒ 视为失效可被抢
//   崩溃恢复 token 带 daemon 代际；重启后旧 token 一律失效，由恢复流程重新认领
//
// `renewLease` existed in the store with no caller, so a round simply stopped
// holding its merge request after `ROUND_LEASE_MS` — fifteen minutes, which an
// AI code round exceeds routinely. Past that point `acquireLease` grants on the
// expiry branch and a SECOND round starts on the same merge request: exactly
// the interleaving §2.3 exists to prevent (the monitor pushes a CI fix while
// the review, still on the old sha, comments on lines that no longer exist).
//
// `daemonGeneration` was worse, because it looked wired: it is a `RunTaskOptions`
// field, it is registered in `INHERITABLE_RUN_CONFIG_KEYS` so children carry it,
// and the scheduler reads it. Nothing ever SET it, so every daemon that has ever
// run used the literal fallback `'dev'` — the same generation before and after a
// restart, which makes the crash fence in `decideLeaseAcquisition` a no-op. A
// daemon killed holding leases blocked each of those merge requests for the full
// expiry instead of having its tokens voided at boot.
//
// `reclaimStaleLeases` documented itself as "Run at boot" and had no caller.
//
// These cases pin all three, and each is written so that removing the fix turns
// it red rather than merely making it less tidy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { DAEMON_GENERATION, resolveDaemonGeneration } from '../src/services/daemonGeneration'
import {
  acquireRoundLease,
  reclaimCodeLeasesOnBoot,
  withRoundLease,
  type LeaseTicker,
} from '../src/services/codeRoundLease'
import { readLease } from '../src/modules/code-capability/infrastructure/sqliteMrLeaseStore'
import {
  leaseKeyOf,
  mintLeaseToken,
  type MrLeaseKey,
} from '../src/modules/code-capability/domain/mrLease'
import { codeMrLeases } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

const key: MrLeaseKey = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

/** A ticker the test drives by hand, so no case depends on wall-clock timing. */
function manualTicker(): LeaseTicker & {
  fire: () => Promise<void>
  stopped: () => boolean
  everyMs: () => number | null
} {
  let tick: (() => Promise<void>) | null = null
  let stops = 0
  let every: number | null = null
  return {
    start(everyMs, fn) {
      every = everyMs
      tick = fn
      return () => {
        stops += 1
      }
    },
    fire: async () => {
      if (tick === null) throw new Error('the heartbeat was never started')
      await tick()
    },
    stopped: () => stops > 0,
    everyMs: () => every,
  }
}

describe('RFC-304 §2.3 — a round longer than the lease keeps its merge request', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('the heartbeat renews, so a competing round is still refused past the original expiry', async () => {
    // The bug in one case. `leaseMs` is small and the clock jumps past it while
    // the body is still running — the shape of a code round that takes longer
    // than fifteen minutes, which is an ordinary one.
    let clock = 1_000
    const ticker = manualTicker()

    const ran = await withRoundLease(
      {
        db,
        daemonGeneration: 'g1',
        key,
        roundId: 'round-1',
        leaseMs: 300,
        now: () => clock,
        ticker,
      },
      async () => {
        clock = 5_000 // well past 1_000 + 300

        // Without a heartbeat the lease has expired here and the next line
        // hands this merge request to a second round while the first is still
        // writing to it.
        await ticker.fire()

        const other = await acquireRoundLease({
          db,
          daemonGeneration: 'g1',
          key,
          roundId: 'round-2',
          leaseMs: 300,
          now: () => clock,
        })
        return other.ok
      },
    )

    expect(ran.ok).toBe(true)
    expect(ran.ok === true && ran.value).toBe(false)
  })

  test('the renewal actually moves the expiry, rather than being a no-op that returns true', async () => {
    let clock = 1_000
    const ticker = manualTicker()
    await withRoundLease(
      {
        db,
        daemonGeneration: 'g1',
        key,
        roundId: 'round-1',
        leaseMs: 300,
        now: () => clock,
        ticker,
      },
      async () => {
        const before = await readLease(db, key)
        clock = 1_200
        await ticker.fire()
        const after = await readLease(db, key)
        expect(after?.expiresAt).toBeGreaterThan(before?.expiresAt ?? 0)
        expect(after?.expiresAt).toBe(1_500)
      },
    )
  })

  test('the heartbeat beats several times faster than the lease expires', async () => {
    // A heartbeat at exactly the expiry renews only as the lease dies: one
    // slow database write and it is gone. The interval has to leave room for a
    // missed beat, which is why it is a fraction of the lease rather than
    // equal to it.
    const ticker = manualTicker()
    await withRoundLease(
      { db, daemonGeneration: 'g1', key, roundId: 'round-1', leaseMs: 900, ticker },
      async () => {
        expect(ticker.everyMs()).toBeLessThan(900)
      },
    )
  })

  test('the heartbeat is stopped when the round ends — a live timer per finished round is a leak', async () => {
    const ticker = manualTicker()
    await withRoundLease(
      { db, daemonGeneration: 'g1', key, roundId: 'round-1', leaseMs: 300, ticker },
      async () => 'done',
    )
    expect(ticker.stopped()).toBe(true)
  })

  test('a heartbeat is stopped even when the round THROWS', async () => {
    // The `finally` matters more here than on the happy path: a failed round
    // that left a renewing timer behind would hold its merge request forever,
    // which is strictly worse than the missing renewal this fixes.
    const ticker = manualTicker()
    await expect(
      withRoundLease(
        { db, daemonGeneration: 'g1', key, roundId: 'round-1', leaseMs: 300, ticker },
        async () => {
          throw new Error('the round failed')
        },
      ),
    ).rejects.toThrow('the round failed')
    expect(ticker.stopped()).toBe(true)
    // …and the lease itself is released, not merely un-renewed.
    expect(await readLease(db, key)).toBeNull()
  })

  test('a heartbeat that finds the lease GONE does not throw and does not steal it back', async () => {
    // `renewLease` is token-checked, so a round whose lease was taken over
    // cannot renew its way back in. The beat has to absorb that quietly: it
    // runs on a timer with no caller to catch it, and an unhandled rejection
    // there would take the daemon down over a lease it already lost.
    const ticker = manualTicker()
    await withRoundLease(
      { db, daemonGeneration: 'g1', key, roundId: 'round-1', leaseMs: 300, ticker },
      async () => {
        await db.delete(codeMrLeases)
        await db.insert(codeMrLeases).values({
          leaseKey: leaseKeyOf(key),
          holderRoundId: 'round-2',
          token: mintLeaseToken('g1', 'someone-else'),
          acquiredAt: 1,
          expiresAt: 9_999_999,
        })

        await ticker.fire()

        const held = await readLease(db, key)
        expect(held?.roundId).toBe('round-2')
      },
    )
  })
})

describe('RFC-304 §2.3 — the daemon generation is a real one', () => {
  test('an absent option resolves to THIS process, not to the literal "dev"', () => {
    // The whole crash fence turns on this value differing across restarts.
    // With `'dev'` on both sides of a restart, `decideLeaseAcquisition` never
    // reaches its generation branch and a dead daemon's leases stand.
    expect(resolveDaemonGeneration(undefined)).toBe(DAEMON_GENERATION)
    expect(DAEMON_GENERATION).not.toBe('dev')
    expect(DAEMON_GENERATION.length).toBeGreaterThan(0)
  })

  test('an explicit generation wins — a child task must run under its parent’s', () => {
    // `daemonGeneration` is in INHERITABLE_RUN_CONFIG_KEYS for this reason: a
    // child that minted its own would treat its parent's live leases as void
    // and take a merge request out from under a running round.
    expect(resolveDaemonGeneration('parent-generation')).toBe('parent-generation')
    expect(resolveDaemonGeneration('')).toBe(DAEMON_GENERATION)
  })

  test('the scheduler resolves it through this funnel and no longer falls back to "dev"', () => {
    // Source-level, because the value only differs across process lifetimes and
    // a behavioural assertion inside one process cannot see the difference.
    const src = readFileSync(join(SRC, 'services', 'scheduler.ts'), 'utf8')
    expect(src).toContain('resolveDaemonGeneration(opts.daemonGeneration)')
    expect(src).not.toContain("opts.daemonGeneration ?? 'dev'")
  })
})

describe('RFC-304 §2.3 — boot reclaims what a dead daemon left behind', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const seedLease = async (generation: string, roundId: string, anchorId: string) => {
    await db.insert(codeMrLeases).values({
      leaseKey: leaseKeyOf({ ...key, anchorId }),
      holderRoundId: roundId,
      token: mintLeaseToken(generation, roundId),
      acquiredAt: 1,
      expiresAt: 9_999_999,
    })
  }

  test('leases minted by a previous daemon are dropped; this daemon’s are left alone', async () => {
    await seedLease('old-generation', 'round-1', '1')
    await seedLease('old-generation', 'round-2', '2')
    await seedLease('this-generation', 'round-3', '3')

    const reclaimed = await reclaimCodeLeasesOnBoot(db, 'this-generation')

    expect(reclaimed).toBe(2)
    const rows = await db.select().from(codeMrLeases)
    expect(rows.map((r) => r.holderRoundId)).toEqual(['round-3'])
  })

  test('a first boot with nothing to reclaim is not an error', async () => {
    expect(await reclaimCodeLeasesOnBoot(db, 'this-generation')).toBe(0)
  })

  test('the daemon calls it at boot — otherwise it is a function with a docstring', async () => {
    const src = readFileSync(join(SRC, 'cli', 'start.ts'), 'utf8')
    expect(src).toContain('reclaimCodeLeasesOnBoot')
  })
})
