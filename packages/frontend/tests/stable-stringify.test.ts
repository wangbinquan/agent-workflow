// RFC-169 (T1) — locks stableStringify's canonical-fingerprint contract:
// key-order independence, nested sorting, undefined-member drop, array order
// preservation, scalar pass-through. This is the equality oracle behind the
// split page's draft-dirty check, so a regression here silently breaks unsaved
// guards / dirty dots.

import { describe, expect, test } from 'vitest'
import { stableStringify } from '../src/lib/stable-stringify'

describe('stableStringify', () => {
  test('object key order does not affect output', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  test('nested objects are sorted recursively', () => {
    expect(stableStringify({ outer: { z: 1, a: 2 }, first: true })).toBe(
      stableStringify({ first: true, outer: { a: 2, z: 1 } }),
    )
    // and the emitted string is actually in sorted order
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}')
  })

  test('undefined-valued members are dropped (JSON.stringify semantics)', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  test('array order is preserved (arrays are ordered data)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  test('objects inside arrays are still key-sorted', () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  test('scalars pass through', () => {
    expect(stableStringify(42)).toBe('42')
    expect(stableStringify('hi')).toBe('"hi"')
    expect(stableStringify(true)).toBe('true')
    expect(stableStringify(null)).toBe('null')
  })

  test('top-level undefined → distinct sentinel, not colliding with null/empty', () => {
    expect(stableStringify(undefined)).toBe('undefined')
    expect(stableStringify(undefined)).not.toBe(stableStringify(null))
    expect(stableStringify(undefined)).not.toBe(stableStringify({}))
  })

  test('a deep draft-shaped object round-trips to a canonical fingerprint', () => {
    const a = { name: 'x', outputs: ['a', 'b'], permission: { edit: true }, runtime: undefined }
    const b = { permission: { edit: true }, runtime: undefined, name: 'x', outputs: ['a', 'b'] }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })
})
