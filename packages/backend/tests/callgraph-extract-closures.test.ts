// RFC-086 — extractCalls descends INTO closure / lambda / comprehension subtrees.
//
// RFC-086 is specifically about method-local & anonymous function definitions: calls
// that live inside arrow/lambda closures and inside list comprehensions, not just as
// flat direct children of a method body. The existing call-graph tests
// (call-graph-extract-langs.test.ts et al.) only exercise flat one-line bodies like
// `x.foo(); bar(); new Baz();` — they never bury a call inside an arrow / lambda /
// comprehension. If the tree-sitter query ever regressed to "body direct children
// only", the INNER call (`this.handle` / `self.handle` / `self.go`) would be dropped
// silently while the outer call still passed. This file locks that descent + the
// source-order indices so such a regression turns red.
//
// Expected values below were confirmed by the verifier running these exact scenarios
// through the real WASM tree-sitter parse (ground truth):
//   TS  `items.forEach(i => this.handle(i))` -> items.forEach (order 0), this.handle (order 1)
//   PY  lambda x: self.handle(x) + [self.go(i) for i in xs] -> self.handle, self.go (both method)

import { describe, expect, test } from 'bun:test'
import { parseSource } from '../src/modules/workspace-insight/engine/lang/parser'
import { resolveLang } from '../src/modules/workspace-insight/domain/lang/languages'
import {
  extractCalls,
  type RawCall,
} from '../src/modules/workspace-insight/engine/callGraph/extractCalls'

async function callsIn(file: string, src: string): Promise<RawCall[]> {
  const g = resolveLang(file)
  if (g === null) throw new Error(`no grammar for ${file}`)
  const { tree, language } = await parseSource(g.grammarFile, src)
  try {
    return extractCalls(tree.rootNode, language, g.lang)
  } finally {
    tree.delete()
  }
}

const sig = (cs: RawCall[]): string[] => cs.map((c) => `${c.recv ?? '_'}.${c.name}:${c.kind}`)

describe('extractCalls — descends into closures / lambdas / comprehensions (RFC-086)', () => {
  test('typescript: arrow-closure inner call is captured after the outer forEach, in order', async () => {
    const cs = await callsIn('a.ts', 'class A { run(){ items.forEach(i => this.handle(i)); } }')

    // Both the outer .forEach and the closure-nested this.handle must appear, in
    // source order — query.matches(body) descends into the arrow function subtree.
    expect(cs).toEqual([
      { recv: 'items', name: 'forEach', kind: 'method', order: 0 },
      { recv: 'this', name: 'handle', kind: 'method', order: 1 },
    ])

    // Explicit guard against the "outer call captured, inner dropped" regression.
    expect(sig(cs)).toEqual(['items.forEach:method', 'this.handle:method'])
  })

  test('python: calls inside a lambda and a list comprehension are both captured as method kind', async () => {
    const src =
      'class A:\n' +
      '  def run(self):\n' +
      '    f = lambda x: self.handle(x)\n' +
      '    [self.go(i) for i in xs]\n'
    const cs = await callsIn('a.py', src)

    // self.handle lives inside the lambda body; self.go lives inside the comprehension.
    // Both must be descended into and captured, as method kind, in source order.
    expect(cs).toEqual([
      { recv: 'self', name: 'handle', kind: 'method', order: 0 },
      { recv: 'self', name: 'go', kind: 'method', order: 1 },
    ])

    const s = sig(cs)
    expect(s).toContain('self.handle:method')
    expect(s).toContain('self.go:method')
  })
})
