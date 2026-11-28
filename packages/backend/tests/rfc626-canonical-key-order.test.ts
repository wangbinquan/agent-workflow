// RFC-626 §4.3 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md, table row
// "规范化 JSON 本身"): the plain path of `canonicalSchemaJson` now takes the sorted key
// list of an object from a table keyed by the keys it enumerates, instead of collating
// every object again. Every digest of the conversion is computed over this text, so the
// only acceptable outcome is byte-identical output. This file pins that against the
// algorithm as it was before the change, written out below as the reference.
import { describe, expect, test } from 'bun:test'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

/** The plain path as it was before RFC-626; do not "simplify" it into the new one. */
function referenceCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceCanonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, referenceCanonicalize(entry)]),
    )
  }
  return value
}
const reference = (value: unknown) => `${JSON.stringify(referenceCanonicalize(value), null, 2)}\n`

describe('RFC-626 canonical JSON key order table', () => {
  test('plain objects, nesting, arrays and scalars are byte-identical to the reference', () => {
    const values: unknown[] = [
      null,
      0,
      -0,
      'text',
      true,
      [],
      {},
      [1, [2, { b: 1, a: 2 }], null],
      { z: 1, a: { y: [3, 2, 1], x: null }, m: 'm' },
      { status: 'done', id: 'a', nested: { id: 'b', status: 'pending' } },
    ]
    for (const value of values) expect(canonicalSchemaJson(value)).toBe(reference(value))
  })

  test('undefined entries are left out without disturbing the order of the rest', () => {
    const value = { c: 1, a: undefined, b: 2, d: undefined, aa: 3 }
    expect(canonicalSchemaJson(value)).toBe(reference(value))
    // Same keys, different entries defined: one cached order has to serve both.
    const other = { c: undefined, a: 1, b: undefined, d: 4, aa: undefined }
    expect(canonicalSchemaJson(other)).toBe(reference(other))
  })

  test('the same key set in different insertion orders gives one text', () => {
    const first = { beta: 1, alpha: 2, gamma: 3 }
    const second = { gamma: 3, alpha: 2, beta: 1 }
    expect(canonicalSchemaJson(first)).toBe(reference(first))
    expect(canonicalSchemaJson(second)).toBe(canonicalSchemaJson(first))
  })

  test('array-index keys keep the engine enumeration order of the reference', () => {
    const value = { 10: 'ten', 2: 'two', b: 'b', a: 'a', '01': 'padded' }
    expect(canonicalSchemaJson(value)).toBe(reference(value))
  })

  test('an own "__proto__" key is written, not swallowed as a prototype', () => {
    const value: unknown = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}')
    const text = canonicalSchemaJson(value)
    expect(text).toBe(reference(value))
    expect(text).toContain('"__proto__"')
  })

  test('collation of non-ASCII and mixed-case keys matches the reference', () => {
    const value = { é: 1, e: 2, E: 3, 中: 4, a: 5, Z: 6, _: 7, 'a-b': 8, a_b: 9, 'a b': 10 }
    expect(canonicalSchemaJson(value)).toBe(reference(value))
  })

  test('repeated serialization of rows sharing a key set stays identical (table hit)', () => {
    for (let index = 0; index < 500; index += 1) {
      const row = { id: `id-${index}`, status: index % 2 ? 'done' : 'pending', seq: index }
      expect(canonicalSchemaJson(row)).toBe(reference(row))
    }
  })

  test('objects with more keys than the table admits are sorted directly', () => {
    const wide: Record<string, number> = {}
    for (let index = 200; index > 0; index -= 1)
      wide[`key-${(index * 7919) % 1009}-${index}`] = index
    expect(canonicalSchemaJson(wide)).toBe(reference(wide))
  })

  test('filling the table past its bound does not change any output', () => {
    // More distinct key sets than the bound: the table is reset on the way.
    for (let index = 0; index < 9000; index += 1) {
      const value = { [`k${index}`]: index, shared: true, [`a${index % 13}`]: 'x' }
      if (index % 257 === 0) expect(canonicalSchemaJson(value)).toBe(reference(value))
      else canonicalSchemaJson(value)
    }
    const after = { shared: true, k1: 1, a1: 'x' }
    expect(canonicalSchemaJson(after)).toBe(reference(after))
  })
})
