// RFC-083 PR-E — precise reverse-reference impact from a SCIP graph. Locks the
// def-excluded reverse join, deterministic ordering, the 'extracted' confidence,
// and the PRECISION WIN over the baseline heuristic (two same-named methods are
// disambiguated by resolved symbol, which a `name(` text match cannot do).

import { describe, expect, test } from 'bun:test'
import {
  parseScip,
  encodeScipFixture,
  type ScipDocument,
} from '../src/services/structuralDiff/deep/scip'
import {
  computePreciseImpact,
  resolveChangedScipSymbol,
  preciseImpactFromBaseline,
} from '../src/services/structuralDiff/deep/deepImpact'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const SYM_A = 'scip ts . . `a.ts`/A#foo().'

function graphFromDocs(docs: ScipDocument[]) {
  return parseScip(encodeScipFixture(docs))
}

describe('computePreciseImpact', () => {
  const graph = graphFromDocs([
    {
      relativePath: 'src/a.ts',
      occurrences: [{ symbol: SYM_A, range: [3, 2, 8], isDefinition: true }],
    },
    {
      relativePath: 'src/c.ts',
      occurrences: [{ symbol: SYM_A, range: [20, 6, 9], isDefinition: false }],
    },
    {
      relativePath: 'src/b.ts',
      occurrences: [{ symbol: SYM_A, range: [12, 4, 7], isDefinition: false }],
    },
  ])

  test('callers = all non-def occurrences, def excluded, extracted confidence', () => {
    const out = computePreciseImpact(graph, [{ changedSymbolId: 'A.foo', scipSymbol: SYM_A, ownerFile: 'src/a.ts' }])
    expect(out).toHaveLength(1)
    expect(out[0]?.confidence).toBe('extracted')
    expect(out[0]?.callers.map((c) => c.filePath)).toEqual(['src/b.ts', 'src/c.ts']) // dictionary order
    expect(out[0]?.callers.some((c) => c.filePath === 'src/a.ts')).toBe(false) // def excluded
    // 0-based SCIP line 12 → 1-based 13
    expect(out[0]?.callers[0]?.range.startLine).toBe(13)
  })

  test('symbol with no references → no ImpactItem', () => {
    const lonely = graphFromDocs([
      {
        relativePath: 'a.ts',
        occurrences: [{ symbol: 'X', range: [1, 0, 3], isDefinition: true }],
      },
    ])
    expect(computePreciseImpact(lonely, [{ changedSymbolId: 'X', scipSymbol: 'X', ownerFile: 'a.ts' }])).toEqual([])
  })

  test('symbol absent from graph → omitted, no throw', () => {
    expect(computePreciseImpact(graph, [{ changedSymbolId: 'Z', scipSymbol: 'no-such', ownerFile: 'a.ts' }])).toEqual(
      [],
    )
  })

  test('PRECISION WIN: two same-named methods disambiguated by resolved symbol', () => {
    // A.run (sym A) called from caller.ts; B.run (sym B) called from other.ts.
    // A heuristic `run(` match would attribute BOTH; precise attributes each correctly.
    const SYM_ARUN = 'scip . . A#run().'
    const SYM_BRUN = 'scip . . B#run().'
    const g = graphFromDocs([
      {
        relativePath: 'a.ts',
        occurrences: [{ symbol: SYM_ARUN, range: [1, 4, 7], isDefinition: true }],
      },
      {
        relativePath: 'b.ts',
        occurrences: [{ symbol: SYM_BRUN, range: [1, 4, 7], isDefinition: true }],
      },
      {
        relativePath: 'caller.ts',
        occurrences: [{ symbol: SYM_ARUN, range: [5, 2, 5], isDefinition: false }],
      },
      {
        relativePath: 'other.ts',
        occurrences: [{ symbol: SYM_BRUN, range: [5, 2, 5], isDefinition: false }],
      },
    ])
    const out = computePreciseImpact(g, [{ changedSymbolId: 'A.run', scipSymbol: SYM_ARUN, ownerFile: 'a.ts' }])
    expect(out).toHaveLength(1)
    expect(out[0]?.callers.map((c) => c.filePath)).toEqual(['caller.ts']) // NOT other.ts
  })
})

describe('resolveChangedScipSymbol', () => {
  const graph = graphFromDocs([
    {
      relativePath: 'a.ts',
      occurrences: [{ symbol: SYM_A, range: [3, 2, 8], isDefinition: true }],
    },
  ])
  test('positional lookup over the def line returns the symbol', () => {
    // SCIP def at 0-based line 3 → 1-based 4; baseline range covers it.
    expect(resolveChangedScipSymbol(graph, 'a.ts', { startLine: 4, endLine: 6 })).toBe(SYM_A)
  })
  test('position outside any def range → null', () => {
    expect(resolveChangedScipSymbol(graph, 'a.ts', { startLine: 99, endLine: 100 })).toBeNull()
  })
  test('unknown file → null', () => {
    expect(resolveChangedScipSymbol(graph, 'nope.ts', { startLine: 4, endLine: 6 })).toBeNull()
  })
})

describe('preciseImpactFromBaseline', () => {
  test('maps a baseline-changed method to its precise cross-file callers', () => {
    const graph = graphFromDocs([
      {
        relativePath: 'svc.ts',
        occurrences: [{ symbol: SYM_A, range: [1, 6, 12], isDefinition: true }],
      },
      {
        relativePath: 'order.ts',
        occurrences: [{ symbol: SYM_A, range: [8, 4, 10], isDefinition: false }],
      },
    ])
    const node: SymbolNode = {
      id: 'svc.ts#Svc.charge:method:2',
      kind: 'method',
      name: 'charge',
      qualifiedName: 'Svc.charge',
      lang: 'typescript',
      filePath: 'svc.ts',
      range: { startLine: 2, endLine: 4 }, // covers SCIP def at 1-based line 2
      confidence: 'extracted',
    }
    const files: FileStructuralDiff[] = [
      {
        filePath: 'svc.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [{ changeType: 'modified', kind: 'method', after: node }],
      },
    ]
    const out = preciseImpactFromBaseline(graph, files)
    expect(out).toHaveLength(1)
    expect(out[0]?.confidence).toBe('extracted')
    expect(out[0]?.callers.map((c) => c.filePath)).toEqual(['order.ts'])
  })
})
