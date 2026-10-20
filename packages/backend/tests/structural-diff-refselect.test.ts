// RFC-083 — per-node scope ref selection. "What did node N change" = the diff
// between N's pre_snapshot and the next write node's pre_snapshot (or worktree
// for the last writer); readonly nodes (no snapshot) contribute nothing.

import { describe, expect, test } from 'bun:test'
import {
  resolveNodeScope,
  perRepoNodeRuns,
  type NodeRunRef,
} from '../src/services/structuralDiff/refSelect'

const runs: NodeRunRef[] = [
  { seq: null, id: 'a', preSnapshot: 'snapA', startedAt: 1 },
  { seq: null, id: 'r', preSnapshot: null, startedAt: 2 }, // readonly node (no snapshot)
  { seq: null, id: 'b', preSnapshot: 'snapB', startedAt: 3 },
  { seq: null, id: 'c', preSnapshot: 'snapC', startedAt: 4 }, // last writer
]

describe('resolveNodeScope', () => {
  test('middle write node → between its snapshot and the next write snapshot', () => {
    expect(resolveNodeScope(runs, 'a')).toEqual({
      kind: 'between',
      fromRef: 'snapA',
      toRef: 'snapB',
    })
    expect(resolveNodeScope(runs, 'b')).toEqual({
      kind: 'between',
      fromRef: 'snapB',
      toRef: 'snapC',
    })
  })

  test('last write node → diff against the worktree', () => {
    expect(resolveNodeScope(runs, 'c')).toEqual({ kind: 'to-worktree', fromRef: 'snapC' })
  })

  test('readonly node (no snapshot) → readonly', () => {
    expect(resolveNodeScope(runs, 'r')).toEqual({ kind: 'readonly' })
  })

  test('unknown node run → not-found', () => {
    expect(resolveNodeScope(runs, 'zzz')).toEqual({ kind: 'not-found' })
  })

  test('next-write selection ignores intervening readonly rows + respects start order', () => {
    // 'a' at t=1, then a readonly 'r' at t=2, then 'b' at t=3 → a pairs with b.
    const out = resolveNodeScope(runs, 'a')
    expect(out).toMatchObject({ kind: 'between', toRef: 'snapB' })
  })
})

// RFC-089 P3 — multi-repo node scope projects each run's per-repo snapshot map
// (`pre_snapshot_repos_json`) onto a single repo, then reuses resolveNodeScope.
describe('perRepoNodeRuns', () => {
  const mrows = [
    {
      seq: null,
      id: 'a',
      startedAt: 1,
      preSnapshotReposJson: JSON.stringify({ 'repo-x': 'xA', 'repo-y': 'yA' }),
    },
    { seq: null, id: 'b', startedAt: 2, preSnapshotReposJson: JSON.stringify({ 'repo-x': 'xB' }) }, // wrote repo-x only
    { seq: null, id: 'c', startedAt: 3, preSnapshotReposJson: null }, // no map at all
    { seq: null, id: 'd', startedAt: 4, preSnapshotReposJson: '{not json' }, // malformed → null
  ]

  test('projects the per-repo sha; missing/null/malformed → null preSnapshot', () => {
    expect(perRepoNodeRuns(mrows, 'repo-x')).toEqual([
      { seq: null, id: 'a', preSnapshot: 'xA', startedAt: 1 },
      { seq: null, id: 'b', preSnapshot: 'xB', startedAt: 2 },
      { seq: null, id: 'c', preSnapshot: null, startedAt: 3 },
      { seq: null, id: 'd', preSnapshot: null, startedAt: 4 },
    ])
    expect(perRepoNodeRuns(mrows, 'repo-y').map((r) => r.preSnapshot)).toEqual([
      'yA',
      null,
      null,
      null,
    ])
  })

  test('composes with resolveNodeScope per repo (different from/to per repo)', () => {
    // repo-x: a and b both wrote it → a pairs with b.
    expect(resolveNodeScope(perRepoNodeRuns(mrows, 'repo-x'), 'a')).toEqual({
      kind: 'between',
      fromRef: 'xA',
      toRef: 'xB',
    })
    // repo-y: only a wrote it → a is the last writer → diff against worktree.
    expect(resolveNodeScope(perRepoNodeRuns(mrows, 'repo-y'), 'a')).toEqual({
      kind: 'to-worktree',
      fromRef: 'yA',
    })
    // a node that wrote neither repo (here: 'c') → readonly for each repo.
    expect(resolveNodeScope(perRepoNodeRuns(mrows, 'repo-x'), 'c')).toEqual({ kind: 'readonly' })
  })
})
