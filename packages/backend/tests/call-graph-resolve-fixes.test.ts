// RFC-085 — regressions for the completeness-audit resolution fixes:
//   #2 constructor follow-into resolves to the language's REAL ctor member
//      (TS `constructor`, Python `__init__`) so `new X()` is expandable, not Java-only
//   #3 Go same-type call via the receiver var (`g.move()`) resolves
//   #13 receiver class located but method absent → `external` (not resolved, not unresolved)

import { describe, expect, test } from 'bun:test'
import { expandMethod, type ExpandCtx } from '../src/services/structuralDiff/callGraph/service'
import {
  buildClassIndex,
  scanClassDecls,
} from '../src/services/structuralDiff/callGraph/classIndex'
import { resolveLang } from '../src/services/structuralDiff/lang/grammars'

function ctxOf(files: Record<string, string>): ExpandCtx {
  const index = buildClassIndex(
    Object.entries(files).map(([file, src]) => ({ file, names: scanClassDecls(file, src) })),
  )
  return { readFile: async (p) => files[p] ?? null, classIndex: index, grammarFor: resolveLang }
}

describe('constructor follow-into (#2)', () => {
  test('TS: new Logger() resolves to Logger.constructor and re-expands its body', async () => {
    const files = {
      'A.ts': 'class A { run(){ new Logger(); } }',
      'Logger.ts': 'class Logger { constructor(){ this.init(); } init(){} }',
    }
    const ctx = ctxOf(files)
    const top = await expandMethod('A.ts#A.run', ctx)
    const ctor = top.find((t) => t.label === 'new Logger()')
    expect(ctor).toMatchObject({
      kind: 'constructor',
      resolution: 'resolved',
      ref: 'Logger.ts#Logger.constructor',
    })
    // the constructor ref must be expandable (Java-only dead-end was the bug)
    const inside = await expandMethod(ctor!.ref!, ctx)
    expect(inside.map((t) => t.label)).toContain('init()')
  })

  test('Python: Baz() resolves to Baz.__init__', async () => {
    const files = {
      'a.py': 'class A:\n  def run(self):\n    Baz()\n',
      'baz.py': 'class Baz:\n  def __init__(self):\n    pass\n',
    }
    const out = await expandMethod('a.py#A.run', ctxOf(files))
    expect(out.find((t) => t.label === 'new Baz()')?.ref).toBe('baz.py#Baz.__init__')
  })
})

describe('Go same-type receiver call (#3)', () => {
  test('g.move() inside a Game method resolves to Game.move', async () => {
    const files = {
      'g.go':
        'package p\ntype Game struct{}\nfunc (g *Game) tick(){ g.move() }\nfunc (g *Game) move(){}\n',
    }
    const out = await expandMethod('g.go#Game.tick', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ label: 'move()', resolution: 'resolved', ref: 'g.go#Game.move' })
  })
})

describe('external resolution (#13)', () => {
  test('receiver class found but method absent → external, no ref', async () => {
    const files = {
      'A.java': 'class A { OrderService svc; void run(){ svc.charge(); } }',
      'OrderService.java': 'class OrderService { void bill(){} }',
    }
    const out = await expandMethod('A.java#A.run', ctxOf(files))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'svc.charge()',
      resolution: 'external',
      ownerClass: 'OrderService.java::OrderService',
    })
    expect(out[0]?.ref).toBeUndefined()
  })
})
