// RFC-021 (Q5) — "viewed" review-progress helpers for the worktree diff.
// Pure logic (toggle / progress) + the localStorage round-trip, kept out of the
// component so they get direct coverage. Reviewing AI-authored diffs means
// walking dozens of files; these back the "seen it / N of M" affordance.

import { describe, expect, test, beforeEach } from 'vitest'
import {
  loadViewed,
  saveViewed,
  toggleViewed,
  viewedProgress,
  viewedStorageKey,
} from '../src/lib/diffViewed'

beforeEach(() => localStorage.clear())

describe('toggleViewed', () => {
  test('adds then removes a key, returning a NEW set each call (immutable)', () => {
    const a = toggleViewed(new Set<string>(), 'f.ts')
    expect(a.has('f.ts')).toBe(true)
    const b = toggleViewed(a, 'f.ts')
    expect(b.has('f.ts')).toBe(false)
    expect(a).not.toBe(b)
  })
})

describe('viewedProgress', () => {
  test('counts only file keys still present in the diff', () => {
    const viewed = new Set(['a', 'b', 'gone'])
    expect(viewedProgress(['a', 'b', 'c'], viewed)).toEqual({ viewed: 2, total: 3 })
    // a stale viewed key no longer in the diff must not inflate either side
    expect(viewedProgress(['a'], viewed)).toEqual({ viewed: 1, total: 1 })
    expect(viewedProgress([], viewed)).toEqual({ viewed: 0, total: 0 })
  })
})

describe('load / save round-trip', () => {
  test('a saved set is reloaded for the same scope', () => {
    saveViewed('task1', new Set(['x', 'y']))
    expect(loadViewed('task1')).toEqual(new Set(['x', 'y']))
    expect(localStorage.getItem(viewedStorageKey('task1'))).toContain('x')
  })

  test('scopes are isolated; an undefined scope is a no-op empty set', () => {
    saveViewed('task1', new Set(['x']))
    expect(loadViewed('task2')).toEqual(new Set())
    expect(loadViewed(undefined)).toEqual(new Set())
    saveViewed(undefined, new Set(['z'])) // no-op, must not throw or persist
    expect(localStorage.length).toBe(1) // only task1 was written
  })

  test('malformed stored value degrades to an empty set (never throws)', () => {
    localStorage.setItem(viewedStorageKey('bad'), '{not json')
    expect(loadViewed('bad')).toEqual(new Set())
    localStorage.setItem(viewedStorageKey('obj'), '{"a":1}')
    expect(loadViewed('obj')).toEqual(new Set())
  })
})
