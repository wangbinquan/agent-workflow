// RFC-060 PR-C — wrapper-fanout palette + factory tests.
//
// Locks:
//  1. PaletteItem deserialize accepts 'wrapper-fanout'.
//  2. makeNode produces a wrapper-fanout naming its shard source
//     (`shardSourcePort`, RFC-354 — parameters are inbound edges) so the
//     first catch-all drop lands on the shard port.
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

  test('makeNode produces wrapper-fanout with a named shard source and no inputs[] declaration', () => {
    const node = makeNode(
      { kind: 'wrapper-fanout' },
      { x: 100, y: 200 },
      { existingIds: new Set() },
    )
    expect(node.kind).toBe('wrapper-fanout')
    const rec = node as unknown as Record<string, unknown>
    expect(Array.isArray(rec.nodeIds)).toBe(true)
    expect(rec.nodeIds).toEqual([])
    expect(typeof rec.shardSourcePort).toBe('string')
    expect((rec.shardSourcePort as string).length).toBeGreaterThan(0)
    expect('inputs' in rec).toBe(false)
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
