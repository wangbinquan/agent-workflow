// RFC-074 PR-C / RFC-374 — legacy NULL-seq ID fallback, locked case-by-case.
// The historical rationale below is retained as context; allocated rows now use mint seq.
//
// WHY THIS FILE EXISTS (regression intent):
//   This file began life as the PR-A EQUIVALENCE BASELINE for the retirement
//   of the scalar `clarifyIteration` (cci) watermark. PR-A locked the old
//   3-level `(cci desc, retryIndex desc, id desc)` comparator so PR-C could
//   prove the switch to pure `id` ordering picks the SAME row on every
//   causally-minted set (plan T-C1 / AC §11.3 C1-C4).
//
//   PR-C has now landed: `isFresherNodeRun` is pure `candidate.id > incumbent.id`
//   (design §6.1). This file is migrated to lock that production behavior and to
//   document — on the very sets PR-A flagged — WHY pure-id is equivalent in the
//   field: under causal minting every rerun (clarify / cross-clarify / process
//   retry) is inserted AFTER the rows it supersedes, so it carries the largest
//   ULID. The cci layer was redundant with that invariant.
//
//   A6 keeps the load-bearing equivalence anchor: on causal-order ids the three
//   candidate pickers (old comparator, pure-id, retry-then-id) agree. A6b keeps
//   the adversarial boundary — the ONLY shape where pure-id would diverge from
//   the retired comparator (a stale low-cci row minted with a LARGER id) — and
//   records why that shape is unreachable in production: reruns are always
//   minted later, and freshness is now ultimately decided by provenance
//   (`isNodeRunFresh` consumed-run id), not by this comparator alone.
//
//   If this file goes RED again, that is a SIGNAL to re-audit §6.1, not a
//   licence to edit the expectations.

import { type PersistenceTables } from '@/platform/persistence/sessionTables'
import { describe, expect, test } from 'bun:test'
import { isFresherNodeRun } from '../src/services/scheduler'
// `isFresherNodeRun` now reads only `id` (the clarifyIteration column was
// dropped in PR-C). The equivalence pickers below still simulate the RETIRED
// comparator, so the synthetic row carries a local `clarifyIteration` field
// that no longer exists on the real schema type — hence a test-local Row that
// augments $inferSelect with it.
type Row = PersistenceTables['nodeRuns']['$inferSelect'] & { clarifyIteration: number }

// We build a minimal row and cast — deliberately NOT mirroring the whole schema
// so this baseline does not drift when unrelated node_runs columns are added.
function row(id: string, cci = 0, retryIndex = 0): Row {
  return { id, seq: null, clarifyIteration: cci, retryIndex } as unknown as Row
}

// The comparator induces a strict weak order; the "freshest" of a set is the
// element that is fresher-than every other (or, equivalently, the max under a
// left-fold with isFresherNodeRun as ">").
function freshestByComparator(rows: Row[]): Row {
  let winner: Row | undefined
  for (const r of rows) if (isFresherNodeRun(r, winner)) winner = r
  return winner!
}
function freshestByPureId(rows: Row[]): Row {
  return [...rows].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]!
}
// The retired 3-level comparator, kept here ONLY to prove equivalence on
// causal-order sets (A6a) and to expose the divergence boundary (A6b).
function freshestByRetiredTriple(rows: Row[]): Row {
  return [...rows].sort((a, b) =>
    b.clarifyIteration !== a.clarifyIteration
      ? b.clarifyIteration - a.clarifyIteration
      : b.retryIndex !== a.retryIndex
        ? b.retryIndex - a.retryIndex
        : a.id < b.id
          ? 1
          : -1,
  )[0]!
}

describe('RFC-074 PR-C — isFresherNodeRun pure-id order', () => {
  // A1 — base case: undefined incumbent means "first row seen always wins".
  test('A1: incumbent undefined → candidate is fresher', () => {
    expect(isFresherNodeRun(row('01AAA', 0, 0), undefined)).toBe(true)
  })

  // A2 — clarify rerun: a self-clarify rerun is minted AFTER the retry-storm
  // done row it supersedes, so it carries the larger id and wins. (PR-A seeded
  // this with a smaller id to lock the cci-dominance; PR-C migrates it to the
  // causal id order the scheduler actually produces.)
  test('A2: clarify rerun minted later → larger id wins over retry storm', () => {
    const retryStorm = row('01RETRY', 0, 9) // earlier generation, smaller id
    const clarifyRerun = row('01ZCLARIFY', 1, 0) // minted later → larger id
    expect(isFresherNodeRun(clarifyRerun, retryStorm)).toBe(true)
    expect(isFresherNodeRun(retryStorm, clarifyRerun)).toBe(false)
  })

  // A3 — cross-clarify rerun: same structural rule. The cross-clarify designer
  // rerun is the latest insert, so it has the largest id.
  test('A3: cross-clarify rerun minted later → larger id wins', () => {
    const olderDone = row('01OLD', 1, 3)
    const crossRerun = row('01ZCROSS', 2, 0) // minted later → larger id
    expect(isFresherNodeRun(crossRerun, olderDone)).toBe(true)
    expect(isFresherNodeRun(olderDone, crossRerun)).toBe(false)
  })

  // A4 — single-node retry / process-retry: the newer attempt is minted later,
  // so its id is larger and it wins.
  test('A4: newer process retry minted later → larger id wins', () => {
    const olderAttempt = row('01R1', 2, 1)
    const newerAttempt = row('01R2', 2, 2) // minted later → larger id
    expect(isFresherNodeRun(newerAttempt, olderAttempt)).toBe(true)
    expect(isFresherNodeRun(olderAttempt, newerAttempt)).toBe(false)
  })

  // A5 — tie-break / irreflexivity: larger id wins; equal id → NOT strictly
  // fresher (so the fold is stable and the comparator is irreflexive).
  test('A5: larger id wins; equal id is not fresher', () => {
    expect(isFresherNodeRun(row('01BBB', 0, 0), row('01AAA', 0, 0))).toBe(true)
    expect(isFresherNodeRun(row('01AAA', 0, 0), row('01BBB', 0, 0))).toBe(false)
    expect(isFresherNodeRun(row('01AAA', 0, 0), row('01AAA', 0, 0))).toBe(false)
  })

  // A6 — EQUIVALENCE ANCHOR (design §6.1).
  //
  // A6a: the realistic invariant. cci only ever bumps FORWARD in wall-clock
  // time, retries are created in time order, and ULIDs are monotonic with
  // creation time. Therefore the row the RETIRED comparator called freshest is
  // ALSO the max-ULID row. This is what makes PR-C's switch to id-ordering safe
  // in the field — all pickers agree.
  test('A6a: monotonic-ULID set — pure-id == retired comparator', () => {
    // ids ASSIGNED in causal order: each fresher generation gets a larger ULID.
    const set: Row[] = [
      row('01000', 0, 0), // gen0 first attempt
      row('01001', 0, 1), // gen0 retry
      row('01002', 1, 0), // gen1 (clarify rerun) — later in time, larger id
      row('01003', 1, 1), // gen1 retry — latest, largest id
    ]
    const byPureId = freshestByPureId(set)
    expect(byPureId.id).toBe('01003')
    // The whole point: production comparator (pure-id) and the retired triple
    // pick the SAME row on causal-order ids.
    expect(freshestByComparator(set).id).toBe('01003')
    expect(freshestByRetiredTriple(set).id).toBe('01003')
  })

  // A6b: the adversarial boundary, kept as documentation. If a STALE low-cci
  // row were ever assigned a LARGER id than a fresh high-cci row (an id minted
  // out of causal order, OR a cci raised in-place by UPDATE on an older row
  // without a new insert — cf. the RFC-074 incident with reused review rows),
  // then pure-id would pick the STALE row while the retired comparator picked by
  // cci. PR-C is safe BECAUSE this shape is unreachable: every rerun is a fresh
  // INSERT minted later (larger id), and freshness is ultimately decided by
  // provenance (`isNodeRunFresh` consumed-run id), which sidesteps id-order
  // entirely. This test pins that pure-id and the retired triple DO diverge on
  // the impossible set — a tripwire if anything ever produces it.
  test('A6b: out-of-causal-order ids — pure-id diverges from retired triple (unreachable)', () => {
    const freshGen = row('01EARLY', 1, 0) // fresher (cci=1) but SMALLER id
    const staleGen = row('01LATER', 0, 0) // stale (cci=0) but LARGER id
    const set = [freshGen, staleGen]
    // Retired comparator: cci wins → the fresh row, regardless of id.
    expect(freshestByRetiredTriple(set).id).toBe('01EARLY')
    // Production (pure-id): larger id wins → the STALE row. Divergence is real
    // ONLY on this causally-impossible shape.
    expect(freshestByComparator(set).id).toBe('01LATER')
    expect(freshestByPureId(set).id).toBe('01LATER')
    // => PR-C equivalence is contingent on causal-order ids. Provenance
    //    (consumed-run id) is what actually guarantees correctness in the field.
  })
})
