// LOCKS: RFC-096 (audit S-13 / WP-3) — freshness.ts picker primitives.
//
// `pickFreshestRun` is THE one sanctioned way to pick "the freshest run" out
// of a row set: ordering is always pure ULID id (`isFresherNodeRun`); the only
// knobs are explicit filter predicates (`topLevelOnly`, `statusIn`). It
// replaced every `desc(startedAt)` / `desc(retryIndex)` / in-memory retryIndex
// reduce fork in src. This file locks:
//
//   1. the predicate matrix — topLevelOnly default true / explicit false ×
//      statusIn 缺省 / single / multi × empty rows / all-filtered → undefined;
//   2. baseline consistency with isFresherNodeRun — the max-id eligible row
//      wins, independent of array order (no startedAt / retryIndex drift can
//      sneak back in);
//   3. the RFC-096 generic widening — isFresherNodeRun accepts bare
//      `{ id }` (lifecycleRepair's projected RepairNodeRunRow has no
//      parentNodeRunId column) and pickFreshestRun accepts the minimal
//      `{ id, parentNodeRunId, status }` projection;
//   4. buildFreshestSettledPerNode post-migration smoke — the four filters
//      (scope / iteration / parent / done) moved verbatim from scheduler.ts;
//   5. scheduler.ts's compatibility re-export of isFresherNodeRun is the SAME
//      function object as freshness.ts's export (6 historical test files keep
//      importing from '../src/services/scheduler' unchanged).
//
// If any case here goes red, a freshness-ordering fork is being reintroduced —
// see design/RFC-096-freshest-picker-convergence/design.md before relaxing.

import { describe, expect, test } from 'bun:test'

import type { nodeRuns } from '../src/db/schema'
import {
  buildFreshestSettledPerNode,
  isFresherNodeRun,
  pickFreshestRun,
} from '../src/services/freshness'
import { isFresherNodeRun as isFresherNodeRunFromScheduler } from '../src/services/scheduler'

type FullRow = typeof nodeRuns.$inferSelect

// Minimal projection pickFreshestRun's generic bound requires — using it as
// the test row type IS part of the lock (see header point 3).
interface PickRow {
  id: string
  parentNodeRunId: string | null
  status: string
}

// Explicit monotonic ids: seeding order = id order = causal mint order, the
// exact invariant production ULIDs provide (derive-frontier.test.ts pattern).
let seq = 0
function row(over: Partial<PickRow> = {}): PickRow {
  seq += 1
  return {
    id: `01PF${String(seq).padStart(4, '0')}`,
    parentNodeRunId: null,
    status: 'done',
    ...over,
  }
}

function fullRow(nodeId: string, over: Partial<FullRow> = {}): FullRow {
  seq += 1
  return {
    id: `01PF${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status: 'done',
    parentNodeRunId: null,
    ...over,
  } as unknown as FullRow
}

describe('RFC-096 pickFreshestRun — predicate matrix', () => {
  test('default topLevelOnly=true — a NEWER fan-out child row never shadows the freshest top-level row', () => {
    const oldTop = row()
    const freshTop = row()
    const newestChild = row({ parentNodeRunId: 'parent-x' }) // largest id, but a child
    expect(pickFreshestRun([oldTop, freshTop, newestChild])?.id).toBe(freshTop.id)
    // Same with the default spelled explicitly.
    expect(pickFreshestRun([oldTop, freshTop, newestChild], { topLevelOnly: true })?.id).toBe(
      freshTop.id,
    )
  })

  test('explicit topLevelOnly:false — child rows compete and the newest row wins regardless of parent', () => {
    const oldTop = row()
    const freshTop = row()
    const newestChild = row({ parentNodeRunId: 'parent-x' })
    const picked = pickFreshestRun([oldTop, freshTop, newestChild], { topLevelOnly: false })
    expect(picked?.id).toBe(newestChild.id)
    expect(picked?.parentNodeRunId).toBe('parent-x')
  })

  test('statusIn single value — a newer non-done row does not shadow the freshest done row', () => {
    const oldDone = row({ status: 'done' })
    const freshDone = row({ status: 'done' })
    const newestRunning = row({ status: 'running' }) // largest id, wrong status
    expect(pickFreshestRun([oldDone, freshDone, newestRunning], { statusIn: ['done'] })?.id).toBe(
      freshDone.id,
    )
  })

  test('statusIn omitted — no status filter; the newest row wins whatever its status', () => {
    const done = row({ status: 'done' })
    const newestPending = row({ status: 'pending' })
    expect(pickFreshestRun([done, newestPending])?.id).toBe(newestPending.id)
  })

  test('statusIn multi-value — any listed status is eligible; unlisted newest is skipped', () => {
    const done = row({ status: 'done' })
    const failed = row({ status: 'failed' })
    const newestRunning = row({ status: 'running' })
    expect(
      pickFreshestRun([done, failed, newestRunning], { statusIn: ['done', 'failed'] })?.id,
    ).toBe(failed.id)
  })

  test('empty rows → undefined', () => {
    expect(pickFreshestRun([])).toBeUndefined()
    expect(pickFreshestRun([], { topLevelOnly: false, statusIn: ['done'] })).toBeUndefined()
  })

  test('all rows filtered out → undefined (child-only under default; no status match under statusIn)', () => {
    const childA = row({ parentNodeRunId: 'p1' })
    const childB = row({ parentNodeRunId: 'p2' })
    expect(pickFreshestRun([childA, childB])).toBeUndefined()

    const running = row({ status: 'running' })
    const pending = row({ status: 'pending' })
    expect(pickFreshestRun([running, pending], { statusIn: ['done'] })).toBeUndefined()
  })
})

describe('RFC-096 pickFreshestRun — isFresherNodeRun baseline consistency', () => {
  test('max-id eligible row wins, independent of array order', () => {
    const rows = [row(), row(), row(), row(), row()]
    // Oracle: a plain isFresherNodeRun reduce over the same rows.
    const oracle = rows.reduce<PickRow | undefined>(
      (acc, r) => (isFresherNodeRun(r, acc) ? r : acc),
      undefined,
    )
    expect(oracle?.id).toBe(rows[4]!.id) // monotonic mint order → last is max
    const permutations: PickRow[][] = [
      rows,
      [...rows].reverse(),
      [rows[2]!, rows[4]!, rows[0]!, rows[3]!, rows[1]!],
    ]
    for (const perm of permutations) {
      expect(pickFreshestRun(perm)?.id).toBe(oracle!.id)
    }
  })

  test('predicates only shrink the eligible set — the pick equals an isFresherNodeRun reduce over the pre-filtered rows', () => {
    const rows = [
      row({ status: 'done' }),
      row({ status: 'failed', parentNodeRunId: 'p' }),
      row({ status: 'done' }),
      row({ status: 'running' }),
      row({ status: 'done', parentNodeRunId: 'p' }),
    ]
    const eligible = rows.filter((r) => r.parentNodeRunId === null && r.status === 'done')
    const oracle = eligible.reduce<PickRow | undefined>(
      (acc, r) => (isFresherNodeRun(r, acc) ? r : acc),
      undefined,
    )
    expect(pickFreshestRun(rows, { topLevelOnly: true, statusIn: ['done'] })?.id).toBe(oracle!.id)
  })
})

describe('RFC-096 generic widening', () => {
  test('isFresherNodeRun accepts bare { id } (projected RepairNodeRunRow shape) + strict-> tie semantics', () => {
    // Type-level part of the lock: these literals are EXACTLY { id: string } —
    // before RFC-096 the parameter required the full nodeRuns row type and
    // this would not compile.
    const a: { id: string } = { id: 'nr_a' }
    const b: { id: string } = { id: 'nr_b' }
    expect(isFresherNodeRun(b, a)).toBe(true)
    expect(isFresherNodeRun(a, b)).toBe(false)
    // undefined incumbent → candidate always wins.
    expect(isFresherNodeRun(a, undefined)).toBe(true)
    // Tie on id (impossible for real ULIDs, defensive): strict '>' keeps the
    // incumbent — no reduce churn on equal rows.
    expect(isFresherNodeRun(a, { id: 'nr_a' })).toBe(false)
  })

  test('pickFreshestRun accepts the minimal { id, parentNodeRunId, status } projection', () => {
    // The whole file already uses PickRow, but spell the projection inline so
    // the generic bound itself is pinned (no hidden FullRow requirement).
    const rows: Array<{ id: string; parentNodeRunId: string | null; status: string }> = [
      { id: '01ZZ0001', parentNodeRunId: null, status: 'done' },
      { id: '01ZZ0002', parentNodeRunId: null, status: 'failed' },
    ]
    expect(pickFreshestRun(rows)?.id).toBe('01ZZ0002')
    expect(pickFreshestRun(rows, { statusIn: ['done'] })?.id).toBe('01ZZ0001')
  })
})

describe('RFC-096 buildFreshestSettledPerNode — post-migration smoke', () => {
  test('four filters: out-of-scope / wrong-iteration / child / non-done rows are all excluded', () => {
    const scopeIds = new Set(['a'])
    const oldDone = fullRow('a')
    const freshDone = fullRow('a')
    // Every later (larger-id) row trips exactly one filter — none may shadow
    // freshDone, and none may create extra map entries.
    const wrongIteration = fullRow('a', { iteration: 1 })
    const childRow = fullRow('a', { parentNodeRunId: 'parent-x' })
    const nonDone = fullRow('a', { status: 'running' })
    const outOfScope = fullRow('zz')
    const m = buildFreshestSettledPerNode(
      [oldDone, freshDone, wrongIteration, childRow, nonDone, outOfScope],
      scopeIds,
      0,
    )
    expect(m.size).toBe(1)
    expect(m.get('a')?.id).toBe(freshDone.id)
    expect(m.get('zz')).toBeUndefined()
  })

  test('per-node freshest: largest done id wins for EACH node independently', () => {
    const scopeIds = new Set(['a', 'b'])
    const a1 = fullRow('a')
    const b1 = fullRow('b')
    const a2 = fullRow('a')
    const b2 = fullRow('b')
    const m = buildFreshestSettledPerNode([a1, b1, a2, b2], scopeIds, 0)
    expect(m.get('a')?.id).toBe(a2.id)
    expect(m.get('b')?.id).toBe(b2.id)
  })
})

describe('RFC-096 scheduler compatibility re-export', () => {
  test("isFresherNodeRun from '../src/services/scheduler' IS freshness.ts's function (same object)", () => {
    // The re-export keeps 6 historical test files import-stable. Identity (not
    // just behavioral) equality: a fork that re-implements the comparator in
    // scheduler.ts would break this even if byte-equivalent today.
    expect(isFresherNodeRunFromScheduler).toBe(isFresherNodeRun)
  })
})
