// RFC-086 — anonymous classes become first-class symbols (not phantom "classes"
// named after the enclosing method). Source incident: task
// 01KTDNGTHM975PF4WTG1Q3PV3Q — `new java.util.TimerTask(){ run(){} }` inside
// GameFrame.setupGameTimer() previously surfaced only as a `run` method whose
// qualifiedName re-parented onto the method, drawing a bogus class card titled
// `GameFrame.setupGameTimer`. Now the anonymous class is captured with its base
// type name (`TimerTask`), `anonymous: true`, and a "created by" edge from the
// enclosing method.

import { describe, expect, test } from 'bun:test'
import { analyzeFile } from '../src/services/structuralDiff/baseline'
import { computeAnonCreationEdges } from '../src/services/structuralDiff/classGraph'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const JAVA = `class GameFrame {
  private void setupGameTimer() {
    new java.util.Timer("T", true).scheduleAtFixedRate(new java.util.TimerTask() {
      @Override
      public void run() { tick(); }
    }, 0, 16);
  }
}
`

async function symbolsOf(file: FileStructuralDiff): Promise<SymbolNode[]> {
  return file.changes.map((c) => c.after).filter((s): s is SymbolNode => s !== undefined)
}

describe('RFC-086 — Java anonymous class extraction', () => {
  test('anonymous TimerTask is captured with base type name + anonymous flag', async () => {
    const file = await analyzeFile({ filePath: 'GameFrame.java', oldText: '', newText: JAVA })
    expect(file.status).toBe('ok')
    const syms = await symbolsOf(file)

    const anon = syms.find((s) => s.anonymous === true)
    expect(anon).toBeDefined()
    expect(anon?.kind).toBe('class')
    expect(anon?.name).toBe('TimerTask')
    // synthetic, unique qualifiedName under the enclosing METHOD (not a class)
    expect(anon?.qualifiedName).toMatch(/^GameFrame\.setupGameTimer\.\$anon\d+_\d+$/)

    // the override re-parents onto the anonymous class, NOT onto the method
    const run = syms.find((s) => s.name === 'run' && s.kind === 'method')
    expect(run?.qualifiedName).toBe(`${anon?.qualifiedName}.run`)
    expect(run?.parentId).toBe(anon?.id)

    // and there is NO class symbol named after the method
    expect(
      syms.some((s) => s.kind === 'class' && s.qualifiedName === 'GameFrame.setupGameTimer'),
    ).toBe(false)
  })

  test('a normal `new Foo()` (no class body) is NOT captured as anonymous', async () => {
    const file = await analyzeFile({
      filePath: 'A.java',
      oldText: '',
      newText: `class A { void m() { Foo f = new Foo(); f.go(); } }\n`,
    })
    const syms = await symbolsOf(file)
    expect(syms.some((s) => s.anonymous === true)).toBe(false)
  })

  test('creation edge: enclosing method → anonymous class', async () => {
    const file = await analyzeFile({ filePath: 'GameFrame.java', oldText: '', newText: JAVA })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    const setup = syms.find(
      (s) => s.qualifiedName === 'GameFrame.setupGameTimer' && s.kind === 'method',
    )

    const edges = computeAnonCreationEdges([file])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      from: 'GameFrame.java::GameFrame',
      to: `GameFrame.java::${anon?.qualifiedName}`,
      kind: 'references',
      fromMembers: [setup?.id ?? '?'],
    })
  })
})

describe('RFC-086 — TS/JS anonymous class expression', () => {
  test('anonymous class expression captured with extends base type + creation edge', async () => {
    const TS = `class Widget {
  build() {
    return register(class extends BasePanel { render() {} });
  }
}
`
    const file = await analyzeFile({ filePath: 'Widget.ts', oldText: '', newText: TS })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    expect(anon?.kind).toBe('class')
    expect(anon?.name).toBe('BasePanel')
    expect(anon?.qualifiedName).toMatch(/^Widget\.build\.\$anon\d+_\d+$/)

    const render = syms.find((s) => s.name === 'render' && s.kind === 'method')
    expect(render?.parentId).toBe(anon?.id)

    const build = syms.find((s) => s.qualifiedName === 'Widget.build')
    const edges = computeAnonCreationEdges([file])
    expect(edges).toContainEqual({
      from: 'Widget.ts::Widget',
      to: `Widget.ts::${anon?.qualifiedName}`,
      kind: 'references',
      fromMembers: [build?.id ?? '?'],
    })
  })

  test('anonymous class with no extends → empty base name (UI shows «anonymous»)', async () => {
    const file = await analyzeFile({
      filePath: 'a.js',
      oldText: '',
      newText: `function make() { return emit(class { go() {} }); }\n`,
    })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    expect(anon).toBeDefined()
    expect(anon?.name).toBe('')
  })
})

// Regression locks for the gaps the RFC-086 completeness audit surfaced.
describe('RFC-086 — anonymous-class edge cases (audit regressions)', () => {
  test('two anonymous classes on the SAME line stay distinct (no id/qn collision)', async () => {
    // `$anon<line>` alone collided → the 2nd anon (and its run()) was silently
    // lost; the synthetic leaf now carries the start COLUMN too.
    const file = await analyzeFile({
      filePath: 'P.java',
      oldText: '',
      newText: `class P { void m() { reg(new A(){ public void run(){} }, new B(){ public void run(){} }); } }\n`,
    })
    const syms = await symbolsOf(file)
    const anon = syms.filter((s) => s.anonymous === true)
    expect(anon.map((a) => a.name).sort()).toEqual(['A', 'B'])
    expect(new Set(anon.map((a) => a.qualifiedName)).size).toBe(2) // distinct qns
    expect(new Set(anon.map((a) => a.id)).size).toBe(2) // distinct ids
    const runs = syms.filter((s) => s.name === 'run' && s.kind === 'method')
    expect(new Set(runs.map((r) => r.id)).size).toBe(2) // both run() survive, distinct
    expect(computeAnonCreationEdges([file])).toHaveLength(2) // one edge per anon
  })

  // The phantom-class trigger lives in extraction qns: a nested NAMED function must
  // stay a 'function' qualified `outer.inner` (NOT promoted to a class), so the
  // frontend folds it. Locks the trigger per-language (memberContainer is lang-inert).
  for (const [lang, filePath, src] of [
    ['python', 'm.py', 'def outer():\n    def inner():\n        return 1\n    return inner\n'],
    ['rust', 'm.rs', 'fn outer() {\n    fn inner() -> i32 { 1 }\n    inner();\n}\n'],
    ['ts', 'm.ts', 'function outer() {\n  function inner() { return 1 }\n  return inner\n}\n'],
  ] as const) {
    test(`${lang}: nested function is qn 'outer.inner' kind function, no 'outer' class`, async () => {
      const file = await analyzeFile({ filePath, oldText: '', newText: src })
      const syms = await symbolsOf(file)
      const inner = syms.find((s) => s.name === 'inner')
      expect(inner?.kind).toBe('function')
      expect(inner?.qualifiedName).toBe('outer.inner')
      expect(syms.some((s) => s.kind === 'class' && s.qualifiedName === 'outer')).toBe(false)
    })
  }

  test('field-initializer anonymous class: creation edge fromMembers = the FIELD', async () => {
    const file = await analyzeFile({
      filePath: 'H.java',
      oldText: '',
      newText: `class H { private Runnable r = new Runnable(){ public void run(){} }; }\n`,
    })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    const field = syms.find((s) => s.kind === 'field' && s.qualifiedName === 'H.r')
    expect(anon?.name).toBe('Runnable')
    expect(field).toBeDefined()
    const edges = computeAnonCreationEdges([file])
    expect(edges).toEqual([
      {
        from: 'H.java::H',
        to: `H.java::${anon?.qualifiedName}`,
        kind: 'references',
        fromMembers: [field?.id ?? '?'],
      },
    ])
  })

  test('anonymous-in-anonymous: inner edge anchors on the OUTER anon class', async () => {
    const file = await analyzeFile({
      filePath: 'N.java',
      oldText: '',
      newText: `class N {
  void m() {
    outer(new Runnable(){
      public void run() {
        inner(new Callable(){ public Object call(){ return null; } });
      }
    });
  }
}
`,
    })
    const syms = await symbolsOf(file)
    const outerAnon = syms.find((s) => s.anonymous === true && s.name === 'Runnable')
    const innerAnon = syms.find((s) => s.anonymous === true && s.name === 'Callable')
    const runMethod = syms.find((s) => s.name === 'run' && s.kind === 'method')
    expect(outerAnon).toBeDefined()
    expect(innerAnon).toBeDefined()
    const edges = computeAnonCreationEdges([file])
    // outer anon created by N.m; inner anon created by the outer anon's run()
    expect(edges).toContainEqual(
      expect.objectContaining({ from: 'N.java::N', to: `N.java::${outerAnon?.qualifiedName}` }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: `N.java::${outerAnon?.qualifiedName}`,
        to: `N.java::${innerAnon?.qualifiedName}`,
        fromMembers: [runMethod?.id ?? '?'],
      }),
    )
  })
})
