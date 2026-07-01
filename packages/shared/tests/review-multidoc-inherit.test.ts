// RFC-129 — pure-function oracles for cross-round selection inheritance.
//
// Locks the user-observable contracts of proposal AC-1..AC-6/AC-11 + design §2:
//   - match priority: unique item_path → item_index → none (new doc),
//   - reorder robustness (path match beats index),
//   - inline (no path) falls back to index,
//   - content-change staleness + prior-stale propagation,
//   - inherit `unselected` carries nothing / not stale,
//   - duplicate prior path is excluded from byPath (→ index fallback).
// If these go red the cross-round inheritance semantics drifted.

import { describe, expect, test } from 'bun:test'

import {
  buildPriorSelectionLookup,
  inheritSelection,
  type NewRoundItem,
  type PriorRoundMember,
} from '../src/reviewMultiDoc'

function prior(
  partial: Partial<PriorRoundMember> & Pick<PriorRoundMember, 'itemIndex'>,
): PriorRoundMember {
  return {
    itemPath: null,
    selection: 'unselected',
    selectionStale: false,
    body: '',
    ...partial,
  }
}

function item(partial: Partial<NewRoundItem> & Pick<NewRoundItem, 'itemIndex'>): NewRoundItem {
  return { itemPath: null, body: '', ...partial }
}

describe('buildPriorSelectionLookup', () => {
  test('unique paths collected in byPath; every member in byIndex', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted' }),
      prior({ itemIndex: 1, itemPath: 'b.md', selection: 'not_accepted' }),
    ])
    expect(lookup.byPath.get('a.md')?.selection).toBe('accepted')
    expect(lookup.byPath.get('b.md')?.selection).toBe('not_accepted')
    expect(lookup.byIndex.get(0)?.itemPath).toBe('a.md')
    expect(lookup.byIndex.get(1)?.itemPath).toBe('b.md')
  })

  test('duplicate path is excluded from byPath (ambiguous → index fallback)', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'dup.md', selection: 'accepted' }),
      prior({ itemIndex: 1, itemPath: 'dup.md', selection: 'not_accepted' }),
    ])
    expect(lookup.byPath.has('dup.md')).toBe(false)
    // both still reachable by index
    expect(lookup.byIndex.get(0)?.selection).toBe('accepted')
    expect(lookup.byIndex.get(1)?.selection).toBe('not_accepted')
  })

  test('inline members (path null) never enter byPath', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: null, selection: 'accepted' }),
    ])
    expect(lookup.byPath.size).toBe(0)
    expect(lookup.byIndex.get(0)?.selection).toBe('accepted')
  })
})

describe('inheritSelection — matching', () => {
  test('path-primary hit carries the prior selection', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted', body: 'X' }),
    ])
    expect(inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'X' }), lookup)).toEqual({
      selection: 'accepted',
      stale: false,
    })
  })

  test('reorder robustness: path match beats index', () => {
    // Prior: [a.md@0 accepted, b.md@1 not_accepted]. New round drops a → [b.md@0].
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted', body: 'A' }),
      prior({ itemIndex: 1, itemPath: 'b.md', selection: 'not_accepted', body: 'B' }),
    ])
    // b.md is now index 0 — must inherit b.md's not_accepted (by path), NOT a.md's.
    expect(inheritSelection(item({ itemIndex: 0, itemPath: 'b.md', body: 'B' }), lookup)).toEqual({
      selection: 'not_accepted',
      stale: false,
    })
  })

  test('inline (no path) falls back to item_index', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: null, selection: 'accepted', body: 'A' }),
      prior({ itemIndex: 1, itemPath: null, selection: 'not_accepted', body: 'B' }),
    ])
    expect(inheritSelection(item({ itemIndex: 1, itemPath: null, body: 'B' }), lookup)).toEqual({
      selection: 'not_accepted',
      stale: false,
    })
  })

  test('new document (no path + no index match) → unselected, not stale', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted' }),
    ])
    // index 5 absent, path new → nothing to inherit.
    expect(inheritSelection(item({ itemIndex: 5, itemPath: 'new.md', body: 'Z' }), lookup)).toEqual(
      {
        selection: 'unselected',
        stale: false,
      },
    )
  })

  test('new path but colliding index → falls back to index (退回位置)', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted', body: 'A' }),
    ])
    // path 'c.md' not in prior → fall back to index 0 → inherit a.md's accepted;
    // content differs → stale flag protects the reviewer.
    expect(inheritSelection(item({ itemIndex: 0, itemPath: 'c.md', body: 'C' }), lookup)).toEqual({
      selection: 'accepted',
      stale: true,
    })
  })
})

describe('inheritSelection — staleness', () => {
  test('content changed → stale=true', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted', body: 'OLD' }),
    ])
    expect(
      inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'NEW' }), lookup).stale,
    ).toBe(true)
  })

  test('content byte-identical → stale=false', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'accepted', body: 'SAME' }),
    ])
    expect(
      inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'SAME' }), lookup).stale,
    ).toBe(false)
  })

  test('prior stale propagates even when content unchanged (until human re-affirms)', () => {
    const lookup = buildPriorSelectionLookup([
      prior({
        itemIndex: 0,
        itemPath: 'a.md',
        selection: 'accepted',
        selectionStale: true,
        body: 'SAME',
      }),
    ])
    expect(
      inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'SAME' }), lookup).stale,
    ).toBe(true)
  })

  test('inherit unselected → unselected, not stale (even if content changed)', () => {
    const lookup = buildPriorSelectionLookup([
      prior({ itemIndex: 0, itemPath: 'a.md', selection: 'unselected', body: 'OLD' }),
    ])
    expect(inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'NEW' }), lookup)).toEqual(
      {
        selection: 'unselected',
        stale: false,
      },
    )
  })

  test('empty prior round → everything unselected (first round)', () => {
    const lookup = buildPriorSelectionLookup([])
    expect(inheritSelection(item({ itemIndex: 0, itemPath: 'a.md', body: 'A' }), lookup)).toEqual({
      selection: 'unselected',
      stale: false,
    })
  })
})
