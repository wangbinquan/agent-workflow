// RFC-085 — extractCalls across ALL 8 languages (the queries were originally only
// proven for Java/Python; this pins what each language actually captures and
// guards the C++ receiver (#5), Rust scoped path (#6) and Scala `new` (#7) fixes).
// Asserts on names/kinds/recv; runs real tree-sitter parses.

import { describe, expect, test } from 'bun:test'
import { parseSource } from '../src/services/structuralDiff/lang/parser'
import { resolveLang } from '../src/services/structuralDiff/lang/grammars'
import { extractCalls, type RawCall } from '../src/services/structuralDiff/callGraph/extractCalls'

async function calls(file: string, src: string): Promise<RawCall[]> {
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

describe('extractCalls — every language captures method + bare + construction', () => {
  test('java', async () => {
    const s = sig(await calls('A.java', 'class A { void run(){ x.foo(); bar(); new Baz(); } }'))
    expect(s).toContain('x.foo:method')
    expect(s).toContain('_.bar:method')
    expect(s).toContain('_.Baz:constructor')
  })

  test('typescript', async () => {
    const s = sig(await calls('a.ts', 'class A { run(){ this.foo(); bar(); new Baz(); } }'))
    expect(s).toContain('this.foo:method')
    expect(s).toContain('_.bar:method')
    expect(s).toContain('_.Baz:constructor')
  })

  test('javascript', async () => {
    const s = sig(await calls('a.js', 'class A { run(){ this.foo(); new Baz(); } }'))
    expect(s).toContain('this.foo:method')
    expect(s).toContain('_.Baz:constructor')
  })

  test('python', async () => {
    const s = sig(
      await calls('a.py', 'class A:\n  def run(self):\n    x.foo()\n    bar()\n    Baz()\n'),
    )
    expect(s).toContain('x.foo:method')
    expect(s).toContain('_.bar:method')
    expect(s).toContain('_.Baz:constructor') // dynamic: bare Capitalised = construction
  })

  test('go', async () => {
    const s = sig(await calls('a.go', 'package p\nfunc run(){ x.Foo(); bar() }\n'))
    expect(s).toContain('x.Foo:method')
    expect(s).toContain('_.bar:method')
  })

  test('rust — scoped Bar::new keeps the path head as receiver (#6)', async () => {
    const s = sig(await calls('a.rs', 'fn run(){ x.foo(); Bar::new(); bar(); }\n'))
    expect(s).toContain('x.foo:method')
    expect(s).toContain('Bar.new:method') // path head retained, not just "new"
    expect(s).toContain('_.bar:method')
  })

  test('cpp — method receiver is captured, not dropped (#5)', async () => {
    const s = sig(await calls('a.cpp', 'void run(){ x.foo(); bar(); }\n'))
    expect(s).toContain('x.foo:method') // recv was null before the argument: fix
    expect(s).toContain('_.bar:method')
  })

  test('scala — new Bar() is a constructor, not a method (#7)', async () => {
    const s = sig(await calls('a.scala', 'class A { def run() = { x.foo(); new Bar() } }\n'))
    expect(s).toContain('x.foo:method')
    expect(s.some((x) => x.endsWith('Bar:constructor'))).toBe(true)
  })
})
