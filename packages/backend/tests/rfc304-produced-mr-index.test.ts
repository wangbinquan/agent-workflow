// RFC-304 T50b — closing a requirement when the MR it produced lands.
//
// Design §6.3 defines this index and nothing implemented it, which is a gap
// with a very quiet failure: a `requirement` work item is anchored to the ISSUE
// and finished when its merge request merges, but the terminal event carries
// only the MR. With no lookup, the code ships, the platform never notices, and
// the activity view shows the requirement as in-progress forever.
//
// The exactly-once property is the part worth testing hardest. A merge produces
// several deliveries — the merge itself, the pipeline that follows, a close
// event on some configurations — and each wakes this path. Two of them both
// deciding "not closed yet" would advance the work item twice and post two
// "requirement delivered" notices for one merge.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  claimTerminalMr,
  lookupProducedMr,
  producedMrKey,
  producedMrsOf,
  registerProducedMr,
} from '../src/modules/code-capability/application/producedMrIndex'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MR = { codeHostEndpointId: 'ep-1', stableProjectId: '41823', mrIid: '412' }

describe('RFC-304 T50b — the produced-MR key', () => {
  test('the same merge request always keys the same', () => {
    expect(producedMrKey(MR)).toBe(producedMrKey({ ...MR }))
  })

  test('a separator inside a component cannot forge another key', () => {
    // Without encoding, project `a|b` on endpoint `x` and project `b` on
    // endpoint `x|a` collapse to the same key — and closing one requirement
    // would close another team's.
    const forged = producedMrKey({
      codeHostEndpointId: 'ep-1|41823',
      stableProjectId: '412',
      mrIid: 'x',
    })
    expect(forged).not.toBe(producedMrKey(MR))
  })

  test('different merge requests key differently', () => {
    expect(producedMrKey({ ...MR, mrIid: '413' })).not.toBe(producedMrKey(MR))
    expect(producedMrKey({ ...MR, stableProjectId: '9' })).not.toBe(producedMrKey(MR))
    expect(producedMrKey({ ...MR, codeHostEndpointId: 'ep-2' })).not.toBe(producedMrKey(MR))
  })
})

describe('RFC-304 T50b — registering and claiming', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    db.$client.close()
  })

  test('a registered merge request resolves back to its work item', () => {
    return (async () => {
      await registerProducedMr({ db, ...MR, workItemId: 'wi-1', roundId: 'r-1' })
      const found = await lookupProducedMr(db, MR)
      expect(found?.workItemId).toBe('wi-1')
      expect(found?.roundId).toBe('r-1')
      expect(found?.closedAt).toBeNull()
    })()
  })

  test('registering twice keeps the FIRST registration', async () => {
    // A retried `open-mr` — a round that created the MR then failed before
    // settling — must not fail on the second attempt. And the first is the true
    // one: the MR already exists, so a later round pointing it at a different
    // work item is a bug to keep out rather than overwrite into place.
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })
    await registerProducedMr({ db, ...MR, workItemId: 'wi-OTHER' })

    expect((await lookupProducedMr(db, MR))?.workItemId).toBe('wi-1')
  })

  test('a terminal event claims the work item exactly once', async () => {
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })

    const first = await claimTerminalMr(db, MR)
    const second = await claimTerminalMr(db, MR)

    expect(first).toEqual({ claimed: true, workItemId: 'wi-1' })
    // The second delivery of the same merge. Advancing the work item again
    // would post a second "requirement delivered" for one merge.
    expect(second).toEqual({ claimed: false, reason: 'already-closed' })
  })

  test('concurrent claims produce exactly one winner', async () => {
    // Note what this does and does not prove: `bun:sqlite` is synchronous, so
    // `Promise.all` interleaves nothing at the database level. What it does
    // check is that the claim is a single CAS statement rather than a read
    // followed by a write — the latter would let both callers see "open" and
    // both return `claimed: true`, and this test would then show two winners.
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })

    const results = await Promise.all([
      claimTerminalMr(db, MR),
      claimTerminalMr(db, MR),
      claimTerminalMr(db, MR),
    ])

    expect(results.filter((r) => r.claimed).length).toBe(1)
  })

  test('an ordinary merge request the platform did not produce is not claimed', async () => {
    // The common case by an enormous margin: most merges in a repository have
    // nothing to do with this platform.
    const out = await claimTerminalMr(db, MR)
    expect(out).toEqual({ claimed: false, reason: 'not-produced-here' })
  })

  test('an unrelated merge request does not claim this one', async () => {
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })

    const other = await claimTerminalMr(db, { ...MR, mrIid: '999' })

    expect(other).toEqual({ claimed: false, reason: 'not-produced-here' })
    // …and ours is untouched.
    expect((await lookupProducedMr(db, MR))?.closedAt).toBeNull()
  })

  test('a claimed row is kept, not deleted', async () => {
    // "This requirement produced that MR, and it merged on the 14th" is exactly
    // what someone reading the history wants.
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })
    await claimTerminalMr(db, { ...MR, now: 1_700_000_000_000 })

    const rows = await producedMrsOf(db, 'wi-1')
    expect(rows.length).toBe(1)
    expect(rows[0]?.closedAt).toBe(1_700_000_000_000)
  })

  test('a work item can produce several merge requests', async () => {
    await registerProducedMr({ db, ...MR, workItemId: 'wi-1' })
    await registerProducedMr({ db, ...MR, mrIid: '413', workItemId: 'wi-1' })

    expect((await producedMrsOf(db, 'wi-1')).length).toBe(2)
  })
})
