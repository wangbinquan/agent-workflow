// RFC-374: mint ordering stays total and transitive over allocated sequences.
// RFC-395 D4: epoch-2 rows always carry seq, so the shared order compares seq alone — no NULL-first
// rows, no ID tie-break, no lineage anchor fallback. The epoch-1 rules live in the migration oracle
// (packages/backend/tests/rfc395-d4-legacy-mint-order.test.ts locks them there).
import { describe, expect, test } from 'bun:test'
import * as order from '../src/nodeRunOrder'
import { compareNodeRunMintOrder, isNewerNodeRun, newestNodeRun } from '../src/nodeRunOrder'
import { NodeRunSchema } from '../src/schemas/task'

const older = { id: 'y', seq: 8 }
const newer = { id: 'a', seq: 9 }
const derived = { id: 'z', seq: -3 }

describe('RFC-374 shared mint order', () => {
  test('sequence alone orders rows, including negative legacy-derived seq', () => {
    expect(compareNodeRunMintOrder(older, newer)).toBeLessThan(0)
    expect(compareNodeRunMintOrder(newer, older)).toBeGreaterThan(0)
    expect(compareNodeRunMintOrder(derived, older)).toBeLessThan(0)
    expect(newestNodeRun([newer, derived, older])).toBe(newer)
    expect(newestNodeRun([])).toBeUndefined()
    expect(isNewerNodeRun(newer, undefined)).toBe(true)
    expect(isNewerNodeRun(newer, newer)).toBe(false)
  })
  test('IDs never break a tie: equal seq compares equal whatever the IDs say', () => {
    expect(compareNodeRunMintOrder({ id: 'a', seq: 8 }, older)).toBe(0)
    expect(compareNodeRunMintOrder({ id: 'zz', seq: 8 }, older)).toBe(0)
    expect(isNewerNodeRun({ id: 'zz', seq: 8 }, older)).toBe(false)
  })
  test('the legacy lineage anchor is no longer a shared helper', () => {
    expect(Object.keys(order).sort()).toEqual([
      'compareNodeRunMintOrder',
      'isNewerNodeRun',
      'newestNodeRun',
    ])
  })
  test('deterministic randomized keys are antisymmetric, total and transitive', () => {
    let state = 374
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const rows = Array.from({ length: 128 }, (_, index) => ({
      id: String(index),
      seq: (random() % 31) - 15,
    }))
    for (const a of rows)
      for (const b of rows) {
        const ab = compareNodeRunMintOrder(a, b)
        expect(Math.sign(ab) + Math.sign(compareNodeRunMintOrder(b, a))).toBe(0)
        if (ab === 0) expect(a.seq).toBe(b.seq)
      }
    const sorted = [...rows].sort(compareNodeRunMintOrder)
    for (let a = 0; a < sorted.length; a++)
      for (let b = a; b < sorted.length; b++) {
        expect(compareNodeRunMintOrder(sorted[a]!, sorted[b]!)).toBeLessThanOrEqual(0)
      }
  })
  test('DTO requires integer seq', () => {
    const schema = NodeRunSchema.pick({ id: true, seq: true })
    expect(schema.safeParse({ id: 'legacy' }).success).toBe(false)
    expect(schema.safeParse({ id: 'legacy', seq: null }).success).toBe(false)
    expect(schema.parse(newer)).toEqual(newer)
    for (const seq of [1.5, '1', Infinity])
      expect(schema.safeParse({ id: 'bad', seq }).success).toBe(false)
  })
})
