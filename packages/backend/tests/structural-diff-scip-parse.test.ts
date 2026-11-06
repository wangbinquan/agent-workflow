// RFC-083 PR-E — SCIP index parsing. Decodes a fixture minted in code (no
// committed binary) and locks the load-bearing facts: the Definition role bit
// (0x1) decode, def/ref sharing the same symbol string (so the reverse-join
// works), the symbol index, and graceful failure on malformed bytes.

import { describe, expect, test } from 'bun:test'
import {
  parseScip,
  encodeScipFixture,
  buildSymbolIndex,
  ScipParseError,
  type ScipDocument,
} from '../src/modules/workspace-insight/domain/deep/scip'

const SYM = 'scip-typescript npm . . `a.ts`/A#foo().'

// def in a.ts, refs in b.ts + c.ts (all the SAME symbol string).
const fixtureDocs: ScipDocument[] = [
  {
    relativePath: 'src/a.ts',
    occurrences: [{ symbol: SYM, range: [3, 2, 8], isDefinition: true }],
  },
  {
    relativePath: 'src/b.ts',
    occurrences: [{ symbol: SYM, range: [12, 4, 7], isDefinition: false }],
  },
  {
    relativePath: 'src/c.ts',
    occurrences: [{ symbol: SYM, range: [20, 6, 9], isDefinition: false }],
  },
]

describe('parseScip', () => {
  test('round-trips a fixture: 3 documents with relative paths', () => {
    const graph = parseScip(encodeScipFixture(fixtureDocs))
    expect(graph.documents.map((d) => d.relativePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  test('Definition role bit (0x1) decodes: a.ts is a def, b/c.ts are refs', () => {
    const graph = parseScip(encodeScipFixture(fixtureDocs))
    const a = graph.documents.find((d) => d.relativePath === 'src/a.ts')
    const b = graph.documents.find((d) => d.relativePath === 'src/b.ts')
    expect(a?.occurrences[0]?.isDefinition).toBe(true)
    expect(b?.occurrences[0]?.isDefinition).toBe(false)
  })

  test('def + refs share the same symbol string (reverse-join key)', () => {
    const graph = parseScip(encodeScipFixture(fixtureDocs))
    const symbols = graph.documents.flatMap((d) => d.occurrences.map((o) => o.symbol))
    expect(new Set(symbols).size).toBe(1)
  })

  test('bySymbol maps the symbol to all 3 occurrences across docs', () => {
    const graph = parseScip(encodeScipFixture(fixtureDocs))
    expect(graph.bySymbol.get(SYM)).toHaveLength(3)
  })

  test('malformed / truncated bytes throw ScipParseError (typed, not a raw stack)', () => {
    const good = encodeScipFixture(fixtureDocs)
    // corrupt the wire bytes so the varint/length framing is invalid
    const bad = Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    let threw = false
    try {
      parseScip(bad)
    } catch (e) {
      threw = e instanceof ScipParseError
    }
    expect(threw).toBe(true)
    // a valid index must still parse (guards against over-eager throwing)
    expect(() => parseScip(good)).not.toThrow()
  })

  test('empty index (0 documents) → empty graph, no throw', () => {
    const graph = parseScip(encodeScipFixture([]))
    expect(graph.documents).toEqual([])
    expect(graph.bySymbol.size).toBe(0)
  })

  test('buildSymbolIndex skips empty symbols', () => {
    const idx = buildSymbolIndex([
      { relativePath: 'x', occurrences: [{ symbol: '', range: [0], isDefinition: false }] },
    ])
    expect(idx.size).toBe(0)
  })
})
