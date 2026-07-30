// RFC-088 — structural-diff semantics (pure). Locks the breaking-risk
// classification matrix, the plain-language explanation keys, ordering/filtering,
// and the walkthrough top-N. These back the "look at the dangerous ones first"
// review affordance for AI-authored changes.

import { describe, expect, test } from 'bun:test'
import type { SymbolChange, SymbolNode } from '@agent-workflow/shared'
import {
  classifyBreaking,
  explainChange,
  orderAndFilterChanges,
  walkthroughItems,
  severityCounts,
} from '../src/structureSemantics'

function node(
  qn: string,
  opts: { visibility?: SymbolNode['visibility']; signature?: string } = {},
): SymbolNode {
  return {
    id: `f#${qn}:method`,
    kind: 'method',
    name: qn.split('.').pop() ?? qn,
    qualifiedName: qn,
    lang: 'typescript',
    filePath: 'f.ts',
    confidence: 'extracted',
    visibility: opts.visibility,
    signature: opts.signature,
  }
}

function change(c: Partial<SymbolChange> & Pick<SymbolChange, 'changeType'>): SymbolChange {
  return { kind: 'method', ...c }
}

describe('classifyBreaking', () => {
  test('removed public symbol → breaking', () => {
    const v = classifyBreaking(
      change({ changeType: 'removed', before: node('A.m', { visibility: 'public' }) }),
    )
    expect(v).toEqual({ severity: 'breaking', reason: 'removed-public', uncertain: false })
  })

  test('removed private symbol → safe', () => {
    expect(
      classifyBreaking(
        change({ changeType: 'removed', before: node('A.m', { visibility: 'private' }) }),
      ).severity,
    ).toBe('safe')
  })

  test('removed symbol with UNKNOWN visibility → risky + uncertain (not silently safe)', () => {
    const v = classifyBreaking(change({ changeType: 'removed', before: node('A.m') }))
    expect(v.severity).toBe('risky')
    expect(v.reason).toBe('unknown-visibility')
    expect(v.uncertain).toBe(true)
  })

  test('modified public method that DROPS a param → breaking', () => {
    const v = classifyBreaking(
      change({
        changeType: 'modified',
        signatureChanged: true,
        before: node('A.m', { visibility: 'public', signature: '(a: number, b: string): void' }),
        after: node('A.m', { visibility: 'public', signature: '(a: number): void' }),
      }),
    )
    expect(v).toEqual({ severity: 'breaking', reason: 'signature-param-change', uncertain: false })
  })

  test('modified public method with ADDITIVE signature change → risky (not a proven break)', () => {
    const v = classifyBreaking(
      change({
        changeType: 'modified',
        signatureChanged: true,
        before: node('A.m', { visibility: 'public', signature: '(a: number): void' }),
        after: node('A.m', { visibility: 'public', signature: '(a: number, b: string): void' }),
      }),
    )
    expect(v.severity).toBe('risky')
    expect(v.reason).toBe('signature-param-change')
  })

  test('visibility narrowed public→private → breaking', () => {
    const v = classifyBreaking(
      change({
        changeType: 'modified',
        before: node('A.m', { visibility: 'public' }),
        after: node('A.m', { visibility: 'private' }),
      }),
    )
    expect(v).toEqual({ severity: 'breaking', reason: 'visibility-narrowed', uncertain: false })
  })

  test('renamed public symbol → risky', () => {
    const v = classifyBreaking(
      change({
        changeType: 'renamed',
        renamedFrom: 'A.old',
        after: node('A.m', { visibility: 'public' }),
      }),
    )
    expect(v.severity).toBe('risky')
    expect(v.reason).toBe('renamed-public')
  })

  test('added symbol → safe', () => {
    expect(
      classifyBreaking(
        change({ changeType: 'added', after: node('A.m', { visibility: 'public' }) }),
      ).severity,
    ).toBe('safe')
  })

  test('body-only modification (signature intact) → safe', () => {
    const v = classifyBreaking(
      change({
        changeType: 'modified',
        bodyChanged: true,
        before: node('A.m', { visibility: 'public' }),
        after: node('A.m', { visibility: 'public' }),
      }),
    )
    expect(v).toEqual({ severity: 'safe', reason: 'body-only', uncertain: false })
  })

  test('signature change on a PRIVATE method → not breaking', () => {
    const v = classifyBreaking(
      change({
        changeType: 'modified',
        signatureChanged: true,
        before: node('A.m', { visibility: 'private', signature: '(a): void' }),
        after: node('A.m', { visibility: 'private', signature: '(): void' }),
      }),
    )
    expect(v.severity).not.toBe('breaking')
  })
})

describe('explainChange', () => {
  test('keys vary by changeType + visibility; vars carry name/kind/from', () => {
    expect(explainChange(change({ changeType: 'added', after: node('A.m') })).key).toBe(
      'tasks.structExplainAdded',
    )
    expect(
      explainChange(
        change({ changeType: 'removed', before: node('A.m', { visibility: 'public' }) }),
      ).key,
    ).toBe('tasks.structExplainRemovedPublic')
    expect(
      explainChange(
        change({ changeType: 'removed', before: node('A.m', { visibility: 'private' }) }),
      ).key,
    ).toBe('tasks.structExplainRemovedPrivate')
    const renamed = explainChange(
      change({ changeType: 'renamed', renamedFrom: 'A.old', after: node('A.m') }),
    )
    expect(renamed.key).toBe('tasks.structExplainRenamed')
    expect(renamed.vars.from).toBe('A.old')
    expect(
      explainChange(change({ changeType: 'modified', signatureChanged: true, after: node('A.m') }))
        .key,
    ).toBe('tasks.structExplainSig')
    expect(explainChange(change({ changeType: 'modified', after: node('A.m') })).key).toBe(
      'tasks.structExplainBody',
    )
  })

  test('vars.name falls back to qualifiedName, kind echoes the change kind', () => {
    const e = explainChange(
      change({ changeType: 'added', kind: 'function', after: node('mod.helper') }),
    )
    expect(e.vars.kind).toBe('function')
    expect(e.vars.name).toBe('helper')
  })
})

describe('orderAndFilterChanges', () => {
  const breaking = change({
    changeType: 'removed',
    before: node('Z.gone', { visibility: 'public' }),
  })
  const safe = change({ changeType: 'added', after: node('A.added', { visibility: 'public' }) })
  const risky = change({
    changeType: 'renamed',
    renamedFrom: 'M.old',
    after: node('M.ren', { visibility: 'public' }),
  })

  test('severity sort puts breaking first, then risky, then safe', () => {
    const out = orderAndFilterChanges([safe, risky, breaking], 'severity')
    expect(out.map((c) => classifyBreaking(c).severity)).toEqual(['breaking', 'risky', 'safe'])
  })

  test('name sort is dictionary order', () => {
    const out = orderAndFilterChanges([breaking, safe, risky], 'name')
    expect(out[0]).toBe(safe) // A.added < M.ren < Z.gone
    expect(out[2]).toBe(breaking)
  })

  test('filter by changeType / severity narrows; empty filter keeps all (sorted)', () => {
    expect(
      orderAndFilterChanges([safe, risky, breaking], 'name', { changeTypes: new Set(['removed']) }),
    ).toEqual([breaking])
    expect(
      orderAndFilterChanges([safe, risky, breaking], 'name', { severities: new Set(['breaking']) }),
    ).toEqual([breaking])
    expect(orderAndFilterChanges([safe, risky, breaking], 'name', {})).toHaveLength(3)
  })
})

describe('walkthroughItems + severityCounts', () => {
  const files = [
    {
      filePath: 'a.ts',
      changes: [
        change({ changeType: 'removed', before: node('A.gone', { visibility: 'public' }) }), // breaking
        change({ changeType: 'added', after: node('A.new', { visibility: 'public' }) }), // safe
      ],
    },
    {
      filePath: 'b.ts',
      changes: [
        change({
          changeType: 'renamed',
          renamedFrom: 'B.old',
          after: node('B.ren', { visibility: 'public' }),
        }),
      ], // risky
    },
  ]

  test('excludes safe, sorts breaking before risky, respects limit', () => {
    const items = walkthroughItems(files, 8)
    expect(items.map((i) => i.severity)).toEqual(['breaking', 'risky'])
    expect(items.every((i) => i.severity !== 'safe')).toBe(true)
    expect(walkthroughItems(files, 1)).toHaveLength(1)
  })

  test('severityCounts tallies every severity', () => {
    expect(severityCounts(files)).toEqual({ breaking: 1, risky: 1, safe: 1 })
  })
})

// RFC-239 (design gate 3rd-round P1-N2) — the shared zero-dependency
// signatureTokensRemoved must stay ORDER-SENSITIVE, equivalent to the old
// diffWordsWithSpace-based "before row has removed tokens" predicate. A
// multiset-difference implementation would return false for parameter
// reorders / duplicate-token swaps and silently downgrade breaking verdicts.
import { signatureTokensRemoved } from '../src/structureSemantics'

describe('RFC-239 signatureTokensRemoved (order-sensitive LCS)', () => {
  test('dropped parameter → true', () => {
    expect(signatureTokensRemoved('(a: number, b: string): void', '(a: number): void')).toBe(true)
  })
  test('purely additive parameter → false (nothing removed)', () => {
    expect(signatureTokensRemoved('(a: number): void', '(a: number, b?: string): void')).toBe(false)
  })
  test('parameter REORDER keeps the multiset but is still a removal', () => {
    expect(
      signatureTokensRemoved('(a: number, b: string): void', '(b: string, a: number): void'),
    ).toBe(true)
  })
  test('duplicate-token swap keeps the multiset but is still a removal', () => {
    expect(signatureTokensRemoved('f(x, y, x)', 'f(y, x, x)')).toBe(true)
  })
  test('identical / empty sides → false (mirrors diffSignatureTokens null)', () => {
    expect(signatureTokensRemoved('(a: T): void', '(a: T): void')).toBe(false)
    expect(signatureTokensRemoved(undefined, '(a: T): void')).toBe(false)
    expect(signatureTokensRemoved('(a: T): void', '')).toBe(false)
  })
  test('type change on an existing param → true (old type token removed)', () => {
    expect(signatureTokensRemoved('(a: number): void', '(a: string): void')).toBe(true)
  })
})
