// RFC-074 PR-B — isNodeRunFresh + parseConsumedJson pure-function locks (B1-B4).
//
// The freshness predicate is the heart of the provenance rewrite: it decides
// whether a done node_run's recorded upstream consumption is still current, in
// place of the cci-watermark comparison. Locked here exhaustively because the
// scheduler's completed-set gating (T-B5) and per-batch demote (T-B6) both
// depend on these exact semantics — including the defensive "upstream with no
// current done row is NOT a staleness signal" and the "null/garbage consumed =
// fresh" hard-cut rule (design §9.1 / D4).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  consumedMapsEqual,
  isNodeRunFresh,
  parseConsumedJson,
  pickReusableShardRun,
  pickUpstreamSourceRun,
  pickVisibleUpstreamRun,
} from '../src/services/freshness'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

function run(id: string, consumed: Record<string, string> | null): Row {
  return {
    id,
    consumedUpstreamRunsJson: consumed === null ? null : JSON.stringify(consumed),
  } as unknown as Row
}
function doneRow(id: string): Row {
  return { id, status: 'done' } as unknown as Row
}
function fresnel(entries: Record<string, string>): Map<string, Row> {
  return new Map(Object.entries(entries).map(([up, id]) => [up, doneRow(id)]))
}

describe('RFC-074 PR-B — isNodeRunFresh (B1-B4)', () => {
  // B1 — empty consumed (input node / no upstream / legacy NULL row) → fresh.
  test('B1: empty consumed map → fresh', () => {
    expect(isNodeRunFresh(run('r', {}), fresnel({ designer: '01A' }))).toBe(true)
    expect(isNodeRunFresh(run('r', null), fresnel({ designer: '01A' }))).toBe(true)
  })

  // B2 — every consumed upstream run is still the freshest done → fresh.
  test('B2: all consumed == freshestDone → fresh', () => {
    const r = run('r', { designer: '01A', spec: '01B' })
    expect(isNodeRunFresh(r, fresnel({ designer: '01A', spec: '01B' }))).toBe(true)
  })

  // B3 — one upstream produced a newer done row (id differs) → stale.
  test('B3: one upstream advanced (id mismatch) → stale', () => {
    const r = run('r', { designer: '01A', spec: '01B' })
    // designer still matches, but spec advanced from 01B → 01B2.
    expect(isNodeRunFresh(r, fresnel({ designer: '01A', spec: '01B2' }))).toBe(false)
  })

  // B4 — defensive: a consumed upstream that has NO current-scope done row
  // (absent from the map, e.g. a settled cross-loop boundary input) is NOT a
  // staleness signal.
  test('B4: consumed upstream absent from freshestDone map → not stale (fresh)', () => {
    const r = run('r', { gitwrapper: '01OLD', designer: '01A' })
    // gitwrapper not in the current-scope freshest map; designer matches.
    expect(isNodeRunFresh(r, fresnel({ designer: '01A' }))).toBe(true)
  })
})

describe('RFC-074 §8 / D3 — fan-out wrapper provenance is atomic (B5)', () => {
  // The wrapper run carries the provenance of what IT consumed; inner shard
  // children + the aggregator deliberately record NO provenance (null consumed
  // = fresh). So when an upstream advances, freshness re-runs the WHOLE wrapper
  // atomically instead of demoting individual shards.
  test('B5: wrapper carries consumed and goes stale on upstream advance; inner shard (null) stays fresh', () => {
    const wrapper = run('wrap', { producer: '01UPA' })
    const innerShard = run('wrap#shardA', null) // parentNodeRunId set in prod; consumed deliberately null

    // Upstream unchanged → wrapper fresh; inner always fresh.
    expect(isNodeRunFresh(wrapper, fresnel({ producer: '01UPA' }))).toBe(true)
    expect(isNodeRunFresh(innerShard, fresnel({ producer: '01UPA' }))).toBe(true)

    // Upstream advances 01UPA → 01UPB: the WHOLE wrapper is stale (atomic
    // re-run); the inner shard, carrying no provenance, is never independently
    // demoted.
    expect(isNodeRunFresh(wrapper, fresnel({ producer: '01UPB' }))).toBe(false)
    expect(isNodeRunFresh(innerShard, fresnel({ producer: '01UPB' }))).toBe(true)
  })

  // Source-level lock for the recording half (the genuinely uncovered branch):
  // the scheduler stamps consumed on the WRAPPER run id, and inner shard inserts
  // do not. Keeps the D3 convention from silently drifting to per-shard
  // provenance, which would make freshness demote individual shards.
  test('scheduler records consumed on the wrapper run id, provenance-atomic (D3)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf-8',
    )
    expect(src).toContain('JSON.stringify(wrapperConsumed)')
    expect(src).toContain('.where(eq(nodeRuns.id, wrapperRunId))')
    expect(src).toContain('fan-out wrapper is provenance-atomic')
  })
})

describe('RFC-074 PR-B — parseConsumedJson robustness', () => {
  test('null / empty / undefined → {}', () => {
    expect(parseConsumedJson(null)).toEqual({})
    expect(parseConsumedJson(undefined)).toEqual({})
    expect(parseConsumedJson('')).toEqual({})
  })
  test('malformed JSON / non-object / array → {}', () => {
    expect(parseConsumedJson('{not json')).toEqual({})
    expect(parseConsumedJson('"a string"')).toEqual({})
    expect(parseConsumedJson('42')).toEqual({})
    expect(parseConsumedJson('["a","b"]')).toEqual({})
    expect(parseConsumedJson('null')).toEqual({})
  })
  test('valid object keeps only string values', () => {
    expect(parseConsumedJson('{"a":"01X","b":"01Y"}')).toEqual({ a: '01X', b: '01Y' })
    // Non-string values are dropped (never a valid run id).
    expect(parseConsumedJson('{"a":"01X","b":5,"c":null}')).toEqual({ a: '01X' })
  })
})

// RFC-098 B3 (audit S-7) — pickUpstreamSourceRun: the iteration-window
// two-phase source picker extracted VERBATIM from resolveUpstreamInputs
// (scheduler.ts) so computeWrapperConsumed shares its exact口径. These lock
// the extraction against drift: window filter, done-only, top-level-only,
// highest-iteration-first, then pure-ULID-id within the iteration. NOT the
// same contract as pickFreshestRun (no iteration term there) — see the
// function doc.
describe('RFC-098 B3 — pickUpstreamSourceRun (iteration-window two-phase picker)', () => {
  type SrcRow = { id: string; iteration: number; parentNodeRunId: string | null; status: string }
  function src(over: Partial<SrcRow> & { id: string }): SrcRow {
    return { iteration: 0, parentNodeRunId: null, status: 'done', ...over }
  }

  test('window: rows with iteration > window are invisible', () => {
    const rows = [src({ id: '01A', iteration: 0 }), src({ id: '01B', iteration: 2 })]
    expect(pickUpstreamSourceRun(rows, 1)?.id).toBe('01A')
    expect(pickUpstreamSourceRun(rows, 2)?.id).toBe('01B')
  })

  test('done-only + top-level-only: pending/failed and shard child rows never win', () => {
    const rows = [
      src({ id: '01A' }),
      src({ id: '01B', status: 'pending' }),
      src({ id: '01C', status: 'failed' }),
      src({ id: '01D', parentNodeRunId: '01PARENT' }),
    ]
    expect(pickUpstreamSourceRun(rows, 0)?.id).toBe('01A')
    expect(pickUpstreamSourceRun([src({ id: '01B', status: 'pending' })], 0)).toBeUndefined()
  })

  test('highest iteration ≤ window wins over a fresher id at a lower iteration', () => {
    // 01Z minted later (bigger id) at iteration 0; 01A earlier but at
    // iteration 2 — the cross-boundary "latest visible" rule prefers 01A.
    const rows = [src({ id: '01Z', iteration: 0 }), src({ id: '01A', iteration: 2 })]
    expect(pickUpstreamSourceRun(rows, 2)?.id).toBe('01A')
  })

  test('within the same iteration: pure ULID id order (isFresherNodeRun)', () => {
    const rows = [src({ id: '01A' }), src({ id: '01C' }), src({ id: '01B' })]
    expect(pickUpstreamSourceRun(rows, 0)?.id).toBe('01C')
  })

  test('no candidate → undefined', () => {
    expect(pickUpstreamSourceRun([], 0)).toBeUndefined()
    expect(pickUpstreamSourceRun([src({ id: '01A', iteration: 1 })], 0)).toBeUndefined()
  })
})

describe('pickVisibleUpstreamRun (status-preserving iteration window)', () => {
  type SrcRow = {
    id: string
    iteration: number
    parentNodeRunId: string | null
    status: string
  }

  test('a newer visible pending row wins so review dispatch can fail loudly', () => {
    const rows: SrcRow[] = [
      { id: '01DONE', iteration: 0, parentNodeRunId: null, status: 'done' },
      { id: '01PENDING', iteration: 1, parentNodeRunId: null, status: 'pending' },
      { id: '01FUTURE', iteration: 2, parentNodeRunId: null, status: 'done' },
    ]
    expect(pickVisibleUpstreamRun(rows, 1)?.id).toBe('01PENDING')
    expect(pickVisibleUpstreamRun(rows, 2)?.id).toBe('01FUTURE')
  })
})

// RFC-098 B3 (audit S-19/S-20/S-21) — pickReusableShardRun: the ONE shared
// picker for reusable fanout shard rows (dispatchFanoutShard cross-generation
// replay + dispatchFanoutAggregator per-shardKey aggregation input). Locks the
// hash NULL=MATCH legacy policy that the integration suites
// (scheduler-boundary-fanout-resume-duplicate-shards, scheduler-audit-s21
// test 1) depend on — flipping it to null=mismatch turns both red.
describe('RFC-098 B3 — pickReusableShardRun (done-only + freshest + hash null=match)', () => {
  type ShardRow = {
    id: string
    status: string
    shardKey: string | null
    shardValueHash: string | null
  }
  function row(over: Partial<ShardRow> & { id: string }): ShardRow {
    return { status: 'done', shardKey: 'a.md', shardValueHash: null, ...over }
  }

  test('shardKey match is exact ((shardKey ?? null) === wanted); null = shared row', () => {
    const rows = [row({ id: '01A', shardKey: 'a.md' }), row({ id: '01B', shardKey: null })]
    expect(pickReusableShardRun(rows, { shardKey: 'a.md', valueHash: null })?.id).toBe('01A')
    expect(pickReusableShardRun(rows, { shardKey: null, valueHash: null })?.id).toBe('01B')
    expect(pickReusableShardRun(rows, { shardKey: 'b.md', valueHash: null })).toBeUndefined()
  })

  test('done-only: non-done rows are never reusable (caller handles re-run/mint)', () => {
    const rows = [
      row({ id: '01A' }),
      row({ id: '01B', status: 'interrupted' }),
      row({ id: '01C', status: 'failed' }),
      row({ id: '01D', status: 'pending' }),
    ]
    expect(pickReusableShardRun(rows, { shardKey: 'a.md', valueHash: null })?.id).toBe('01A')
    expect(
      pickReusableShardRun([row({ id: '01B', status: 'interrupted' })], {
        shardKey: 'a.md',
        valueHash: null,
      }),
    ).toBeUndefined()
  })

  test('hash NULL=MATCH (legacy, BOTH sides): null row hash and null wanted hash always match', () => {
    // pre-0043 row (NULL hash) is reusable against any wanted hash…
    expect(
      pickReusableShardRun([row({ id: '01A', shardValueHash: null })], {
        shardKey: 'a.md',
        valueHash: 'h1',
      })?.id,
    ).toBe('01A')
    // …and a NULL wanted hash (shared dispatch) matches any stored hash.
    expect(
      pickReusableShardRun([row({ id: '01A', shardValueHash: 'h1' })], {
        shardKey: 'a.md',
        valueHash: null,
      })?.id,
    ).toBe('01A')
  })

  test('hash mismatch (both non-null) excludes the row', () => {
    const rows = [row({ id: '01A', shardValueHash: 'h-old' })]
    expect(pickReusableShardRun(rows, { shardKey: 'a.md', valueHash: 'h-new' })).toBeUndefined()
    expect(pickReusableShardRun(rows, { shardKey: 'a.md', valueHash: 'h-old' })?.id).toBe('01A')
  })

  test('freshest wins among surviving rows (pure ULID order)', () => {
    const rows = [
      row({ id: '01A', shardValueHash: 'h1' }),
      row({ id: '01C', shardValueHash: 'h1' }),
      row({ id: '01B', shardValueHash: 'h1' }),
      row({ id: '01D', shardValueHash: 'h-other' }), // freshest overall but hash-excluded
    ]
    expect(pickReusableShardRun(rows, { shardKey: 'a.md', valueHash: 'h1' })?.id).toBe('01C')
  })
})

// RFC-098 B3 (audit S-20) — consumedMapsEqual: the fanout consumed generation
// gate's comparison primitive. Key SET + every value must match; order must not
// matter (computeWrapperConsumed sorts keys but resolveUpstreamInputs does not).
describe('RFC-098 B3 — consumedMapsEqual (consumed generation gate comparison)', () => {
  test('equal maps (any key order) → true', () => {
    expect(consumedMapsEqual({}, {})).toBe(true)
    expect(consumedMapsEqual({ a: '01X', b: '01Y' }, { b: '01Y', a: '01X' })).toBe(true)
  })
  test('value drift → false (an upstream re-ran)', () => {
    expect(consumedMapsEqual({ a: '01X' }, { a: '01Z' })).toBe(false)
  })
  test('key set drift → false (an upstream appeared/disappeared)', () => {
    expect(consumedMapsEqual({ a: '01X' }, { a: '01X', b: '01Y' })).toBe(false)
    expect(consumedMapsEqual({ a: '01X', b: '01Y' }, { a: '01X' })).toBe(false)
  })
})
