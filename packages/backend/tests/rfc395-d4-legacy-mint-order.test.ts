// RFC-395 D4: the epoch-1 mint order (rows minted before RFC-374 have no seq: they precede allocated
// rows and only their IDs order them; a missing lineage anchor falls back to an ID-only key) used to
// be the shared `compareNodeRunMintOrder` / `nodeRunOrderAnchor`. D4 keeps it only in the conversion
// oracle; these cases moved here from packages/shared/tests/rfc374-node-run-order.test.ts.
import { describe, expect, test } from 'bun:test'
import {
  compareLegacyNodeRunMintOrder,
  isNewerLegacyNodeRun,
  legacyNodeRunOrderAnchor,
  type LegacyNodeRunOrderKey,
} from '@/modules/task-execution/infrastructure/migration/oracle/legacyOrder'

const legacy: LegacyNodeRunOrderKey = { id: 'z', seq: null }
const older: LegacyNodeRunOrderKey = { id: 'y', seq: 8 }
const newer: LegacyNodeRunOrderKey = { id: 'a', seq: 9 }

describe('RFC-395 D4 epoch-1 mint order (oracle only)', () => {
  test('sequence, legacy and theoretical tie boundaries', () => {
    expect(compareLegacyNodeRunMintOrder(older, newer)).toBeLessThan(0)
    expect(compareLegacyNodeRunMintOrder(legacy, older)).toBeLessThan(0)
    expect(compareLegacyNodeRunMintOrder({ id: 'a', seq: null }, legacy)).toBeLessThan(0)
    expect(compareLegacyNodeRunMintOrder({ id: 'a', seq: 8 }, older)).toBeLessThan(0)
    expect(isNewerLegacyNodeRun(newer, undefined)).toBe(true)
    expect(isNewerLegacyNodeRun(newer, newer)).toBe(false)
    expect(isNewerLegacyNodeRun(older, legacy)).toBe(true)
  })
  test('deterministic randomized mixed keys are antisymmetric, total and transitive', () => {
    let state = 374
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const rows = Array.from({ length: 128 }, (_, index) => ({
      id: String(random()),
      seq: index % 3 ? (random() % 31) - 15 : null,
    }))
    for (const a of rows)
      for (const b of rows) {
        const ab = compareLegacyNodeRunMintOrder(a, b)
        expect(Math.sign(ab) + Math.sign(compareLegacyNodeRunMintOrder(b, a))).toBe(0)
        if (ab === 0) expect(a).toEqual(b)
      }
    const sorted = [...rows].sort(compareLegacyNodeRunMintOrder)
    for (let a = 0; a < sorted.length; a++)
      for (let b = a; b < sorted.length; b++) {
        expect(compareLegacyNodeRunMintOrder(sorted[a]!, sorted[b]!)).toBeLessThanOrEqual(0)
      }
  })
  test('anchors resolve the row and use legacy keys only when absent', () => {
    expect(legacyNodeRunOrderAnchor([newer, legacy], newer.id)).toBe(newer)
    expect(legacyNodeRunOrderAnchor([newer], 'missing')).toEqual({ id: 'missing', seq: null })
  })
})
