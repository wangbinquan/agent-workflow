// RFC-060 PR-C — wrapper-fanout palette + factory tests.
//
// Locks:
//  1. PaletteItem deserialize accepts 'wrapper-fanout'.
//  2. makeNode produces a wrapper-fanout with default inputs that includes
//     ONE shardSource and a non-empty kind grammar string (so the validator
//     doesn't immediately flag a fresh drop).
//  3. PALETTE_MIME round-trip for wrapper-fanout.
//  4. buildPalette emits the wrapper-fanout entry under "Wrappers".

import { describe, expect, test } from 'vitest'
import {
  makeNode,
  deserialize,
  serialize,
  buildPalette,
} from '../src/components/canvas/nodePalette'

describe('PaletteItem — wrapper-fanout', () => {
  test('serialize / deserialize round-trip', () => {
    const raw = serialize({ kind: 'wrapper-fanout' })
    expect(deserialize(raw)).toEqual({ kind: 'wrapper-fanout' })
  })

  test('makeNode produces wrapper-fanout with default inputs + shardSource', () => {
    const node = makeNode(
      { kind: 'wrapper-fanout' },
      { x: 100, y: 200 },
      { existingIds: new Set() },
    )
    expect(node.kind).toBe('wrapper-fanout')
    const rec = node as unknown as Record<string, unknown>
    expect(Array.isArray(rec.nodeIds)).toBe(true)
    expect(rec.nodeIds).toEqual([])
    const inputs = rec.inputs as Array<{ name: string; kind: string; isShardSource?: boolean }>
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    const shardSource = inputs.find((p) => p.isShardSource === true)
    expect(shardSource).not.toBeUndefined()
    expect(shardSource?.kind.startsWith('list<')).toBe(true)
  })

  test("buildPalette includes wrapper-fanout under 'Wrappers' section", () => {
    const sections = buildPalette([], (k) => k)
    const wrappers = sections.find((s) => s.label === 'editor.paletteWrappers')
    expect(wrappers).not.toBeUndefined()
    const fanoutEntry = wrappers!.items.find(
      (entry) => (entry.item as { kind: string }).kind === 'wrapper-fanout',
    )
    expect(fanoutEntry).not.toBeUndefined()
  })
})
