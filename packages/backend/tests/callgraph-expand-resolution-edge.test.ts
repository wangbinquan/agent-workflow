// RFC-085 / RFC-086 — supplementary coverage for expandMethod's call-resolution
// edge cases. Locks in resolution behaviour that no existing expand test exercised:
//
//   GAP 1 (RFC-086 end-to-end): a same-class call made INSIDE a closure
//          (`items.forEach(i => this.handle(i))`) still resolves to the caller's
//          class — extractCalls recurses into the arrow body. The outer
//          `items.forEach()` (no static type for `items`) stays unresolved, and
//          source order is preserved (forEach=0 outer, handle=1 inner).
//   GAP 2: a chained call-expression receiver (`factory.get().build()`) is
//          unresolved, with the FULL source-literal label — guards that the
//          receiver regex guard (service.ts:246) is `$`-anchored so a chained
//          literal is NOT mistaken for a static Type call.
//   GAP 3: a Capitalized identifier receiver (`Utils.format()`) is taken as the
//          static-call Type (service.ts:247 fallback) and resolves cross-file;
//          a lowercase unknown var (`utils.format()`) does NOT.
//   GAP 4: ambiguous same-name class across files — locate() hard-picks
//          classIndex.get(name)[0] (insertion order). Resolves against the FIRST
//          indexed file; if that file LACKS the method it goes `external` with the
//          full receiver-literal label and does NOT fall back to the second file.
//
// A regression in extractCalls' closure recursion, the receiver-guard anchoring,
// the Capitalized-static fallback, or the first-file tie-break would turn one of
// these red. Pure in-memory files, no I/O — deterministic.

import { describe, expect, test } from 'bun:test'
import {
  expandMethod,
  type ExpandCtx,
} from '../src/modules/workspace-insight/engine/callGraph/expandMethod'
import {
  buildClassIndex,
  scanClassDecls,
} from '../src/modules/source-control/infrastructure/local/classDeclarationIndex'
import { resolveLang } from '../src/modules/workspace-insight/domain/lang/languages'

function ctxOf(files: Record<string, string>): ExpandCtx {
  const index = buildClassIndex(
    Object.entries(files).map(([file, src]) => ({ file, names: scanClassDecls(file, src) })),
  )
  return {
    readFile: async (p) => files[p] ?? null,
    classIndex: index,
    grammarFor: resolveLang,
  }
}

describe('expandMethod — resolution edge cases (RFC-086)', () => {
  // GAP 1 — same-class call inside a closure resolves; outer closure call unresolved.
  test('same-class call inside a closure resolves to the caller class, order preserved', async () => {
    const files = {
      'A.ts': 'class A { run(){ items.forEach(i => this.handle(i)); } handle(i){} }',
    }
    const out = await expandMethod('A.ts#A.run', ctxOf(files))
    expect(out.map((t) => `${t.order}:${t.label}:${t.resolution}`)).toEqual([
      '0:items.forEach():unresolved',
      '1:handle():resolved',
    ])
    const forEach = out.find((t) => t.label === 'items.forEach()')
    expect(forEach?.ref).toBeUndefined()
    const handle = out.find((t) => t.label === 'handle()')
    expect(handle?.ref).toBe('A.ts#A.handle')
  })

  // GAP 2 — chained call-expression receiver → unresolved with full source literal.
  test('chained receiver factory.get().build() → both targets unresolved with full literals', async () => {
    const files = {
      'A.ts': 'class A { run(){ factory.get().build(); } }',
    }
    const out = await expandMethod('A.ts#A.run', ctxOf(files))
    expect(out.map((t) => t.label)).toEqual(['factory.get()', 'factory.get().build()'])
    for (const t of out) {
      expect(t.resolution).toBe('unresolved')
      expect(t.ref).toBeUndefined()
      expect(t.ownerClass).toBeUndefined()
    }
  })

  // GAP 3 — Capitalized identifier receiver is taken as a static Type and resolves.
  test('static-style Utils.format() resolves via Capitalized-receiver-as-Type fallback', async () => {
    const files = {
      'A.java': 'class A { void run(){ Utils.format(); } }',
      'Utils.java': 'class Utils { void format(){} }',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'format()',
      resolution: 'resolved',
      ref: 'Utils.java#Utils.format',
      ownerClass: 'Utils.java::Utils',
    })
  })

  // GAP 3 (companion) — a lowercase unknown var is NOT taken as a Type → unresolved.
  test('lowercase unknown receiver utils.format() (no field type) stays unresolved', async () => {
    const files = {
      'A.java': 'class A { void run(){ utils.format(); } }',
      'Utils.java': 'class Utils { void format(){} }',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ label: 'utils.format()', resolution: 'unresolved' })
    expect(out[0]?.ref).toBeUndefined()
  })

  // GAP 4 — ambiguous same-name class: first-indexed file wins (resolved).
  test('ambiguous same-name class: locate() picks classIndex[0] → first file resolves', async () => {
    const files = {
      'A.java': 'class A { Helper h; void run(){ h.go(); } }',
      'Helper1.java': 'class Helper { void go(){} }',
      'Helper2.java': 'class Helper { void other(){} }',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'go()',
      resolution: 'resolved',
      ref: 'Helper1.java#Helper.go',
      ownerClass: 'Helper1.java::Helper',
    })
  })

  // GAP 4 (companion) — first-indexed file LACKS the method: external, no fallback.
  test('ambiguous same-name class: first file lacks method → external (no cross-file fallback)', async () => {
    const files = {
      'A.java': 'class A { Helper h; void run(){ h.go(); } }',
      'Helper1.java': 'class Helper { void other(){} }',
      'Helper2.java': 'class Helper { void go(){} }',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    // CORRECTED-SPEC: external label is the FULL receiver literal 'h.go()', not 'go()'.
    expect(out[0]).toMatchObject({
      label: 'h.go()',
      resolution: 'external',
      ownerClass: 'Helper1.java::Helper',
    })
    expect(out[0]?.ref).toBeUndefined()
  })
})
