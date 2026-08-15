// RFC-304 §2.4 / §6 — the findings ledger, against a real database.
//
// The ledger is what makes a review CONTINUOUS. Without it round two reposts
// everything round one said, and an MR that saw ten pushes carries ten copies
// of each remark — which is how a review bot gets muted.
//
// `domain/findingReconcile.ts` already tests the decisions. What is tested here
// is that the storage keeps the two properties those decisions depend on:
//
//   1. a finding still present is REFRESHED, never reposted and never resolved
//      — the problem is still there, so the comment should stay untouched;
//   2. the active→disappeared transition happens exactly ONCE, because the
//      provider action rides that edge. Repeating it is what produced 78
//      identical "no longer present" replies on one long-lived MR.
//
// And the identity rule: the key excludes the work item, so rebuilding a work
// item cannot detach an MR's history and republish every open finding as new.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { codeFindings } from '../src/db/schema'
import {
  highestGeneration,
  markFindingDisappeared,
  readLedgerForAnchor,
  recordPublishedFinding,
  refreshSeenFinding,
  type LedgerAnchor,
} from '../src/modules/code-capability/infrastructure/sqliteFindingLedger'
import { reconcileFindings } from '../src/modules/code-capability/domain/findingReconcile'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

const anchor: LedgerAnchor = {
  codeHostEndpointId: 'ep-1',
  stableProjectId: '41823',
  anchorKind: 'mr',
  anchorId: '412',
}

describe('RFC-304 — a published finding is remembered', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const publish = (over: Record<string, unknown> = {}) =>
    recordPublishedFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      generation: 1,
      roundId: 'round-1',
      now: NOW,
      severity: 'major',
      title: 'unchecked index',
      filePath: 'src/a.ts',
      anchorLine: 11,
      externalId: 'thread-1',
      ...over,
    } as never)

  test('it lands as active, with its thread id', async () => {
    await publish()
    const ledger = await readLedgerForAnchor(db, anchor, 'mr-review')
    expect(ledger).toEqual([
      { fingerprint: 'fp-1', lifecycle: 'active', generation: 1, externalId: 'thread-1' },
    ])
  })

  test('publishing the same finding twice does NOT create a second row', async () => {
    // A retried round says the same thing once. Two rows would make the next
    // round see a duplicate that never existed.
    await publish()
    await publish({ now: NOW + 1000 })
    expect(await db.select().from(codeFindings)).toHaveLength(1)
  })

  test('another capability on the same MR keeps its own ledger', async () => {
    // `mr-review` and `mr-monitor` are separate work items; sharing a ledger
    // would let one settle the other's findings.
    await publish()
    await publish({ capability: 'mr-monitor', fingerprint: 'fp-2' })
    expect(await readLedgerForAnchor(db, anchor, 'mr-review')).toHaveLength(1)
    expect(await readLedgerForAnchor(db, anchor, 'mr-monitor')).toHaveLength(1)
  })

  test('a different MR is a different ledger', async () => {
    await publish()
    expect(await readLedgerForAnchor(db, { ...anchor, anchorId: '999' }, 'mr-review')).toEqual([])
  })
})

describe('RFC-304 — a finding that is still there stays untouched', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await recordPublishedFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      generation: 1,
      roundId: 'round-1',
      now: NOW,
      anchorLine: 11,
      externalId: 'thread-1',
    } as never)
  })
  afterEach(() => db.$client.close())

  test('a drifted line is updated without disturbing the thread', async () => {
    // A rebase moves the line; the comment must not be reposted and must not be
    // resolved. Only the anchor moves.
    await refreshSeenFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      anchorLine: 40,
      now: NOW + 5000,
    })
    const [row] = await db.select().from(codeFindings)
    expect(row?.anchorLine).toBe(40)
    expect(row?.lifecycle).toBe('active')
    expect(row?.externalId).toBe('thread-1')
    expect(row?.closedAt).toBeNull()
    expect(row?.lastSeenAt).toBe(NOW + 5000)
  })

  test('refreshing does not touch a finding that already disappeared', async () => {
    // Otherwise a stale round could quietly resurrect something that was
    // already settled, without going through the reappear path.
    await markFindingDisappeared({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      roundId: 'round-2',
      now: NOW + 1000,
    })
    await refreshSeenFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      anchorLine: 99,
      now: NOW + 2000,
    })
    const [row] = await db.select().from(codeFindings)
    expect(row?.lifecycle).toBe('disappeared')
    expect(row?.anchorLine).not.toBe(99)
  })
})

describe('RFC-304 — the disappeared edge fires exactly once', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await recordPublishedFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      generation: 1,
      roundId: 'round-1',
      now: NOW,
      externalId: 'thread-1',
    } as never)
  })
  afterEach(() => db.$client.close())

  test('the first round that misses it transitions and reports true', async () => {
    const fired = await markFindingDisappeared({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      roundId: 'round-2',
      now: NOW + 1000,
    })
    expect(fired).toBe(true)
    const [row] = await db.select().from(codeFindings)
    expect(row?.lifecycle).toBe('disappeared')
    expect(row?.closedAt).toBe(NOW + 1000)
    expect(row?.disappearedRoundId).toBe('round-2')
  })

  test('every later round reports FALSE, so the provider action never repeats', async () => {
    // The 78-identical-replies bug, prevented in the data rather than in a
    // caller's memory: only an `active` row can transition, so a second attempt
    // finds nothing to update.
    await markFindingDisappeared({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      roundId: 'round-2',
      now: NOW + 1000,
    })
    for (const round of ['round-3', 'round-4', 'round-5']) {
      const again = await markFindingDisappeared({
        db,
        anchor,
        capability: 'mr-review',
        fingerprint: 'fp-1',
        roundId: round,
        now: NOW + 2000,
      })
      expect(again).toBe(false)
    }
    const [row] = await db.select().from(codeFindings)
    expect(row?.disappearedRoundId).toBe('round-2')
  })

  test('a fingerprint that was never published transitions nothing', async () => {
    expect(
      await markFindingDisappeared({
        db,
        anchor,
        capability: 'mr-review',
        fingerprint: 'never-seen',
        roundId: 'round-2',
        now: NOW,
      }),
    ).toBe(false)
  })
})

describe('RFC-304 — a finding that comes back gets a new generation', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('the old row survives as history and the new one publishes separately', async () => {
    // Reusing the old thread would read as a reopened-then-forgotten remark: it
    // was already resolved or annotated. And keeping the old row is what makes
    // "this keeps coming back" answerable at all.
    const base = {
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      roundId: 'round-1',
      now: NOW,
    }
    await recordPublishedFinding({ ...base, generation: 1, externalId: 'thread-1' } as never)
    await markFindingDisappeared({ ...base, roundId: 'round-2', now: NOW + 1000 })

    expect(await highestGeneration(db, anchor, 'mr-review', 'fp-1')).toBe(1)
    await recordPublishedFinding({
      ...base,
      generation: 2,
      roundId: 'round-3',
      now: NOW + 2000,
      externalId: 'thread-2',
    } as never)

    const rows = await db.select().from(codeFindings)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.generation).sort()).toEqual([1, 2])
    expect(rows.find((r) => r.generation === 1)?.lifecycle).toBe('disappeared')
    expect(rows.find((r) => r.generation === 2)?.lifecycle).toBe('active')
  })

  test('reconcile sees the stored state and asks for a republish, not a keep', async () => {
    // The join between the domain rule and the storage: a `disappeared` row
    // must NOT count as "still present", or the return is silently suppressed
    // and the live problem has no active thread at all.
    await recordPublishedFinding({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      generation: 1,
      roundId: 'round-1',
      now: NOW,
    } as never)
    await markFindingDisappeared({
      db,
      anchor,
      capability: 'mr-review',
      fingerprint: 'fp-1',
      roundId: 'round-2',
      now: NOW + 1000,
    })

    const ledger = await readLedgerForAnchor(db, anchor, 'mr-review')
    const result = reconcileFindings([{ fingerprint: 'fp-1', anchorLine: 11 }], ledger)
    expect(result.actions.map((a) => a.kind)).toEqual(['republish'])
  })

  test('highestGeneration is 0 for a fingerprint with no history', async () => {
    expect(await highestGeneration(db, anchor, 'mr-review', 'nothing')).toBe(0)
  })
})
