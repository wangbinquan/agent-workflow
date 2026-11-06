// RFC-087 — multi-language parity for the structural-diff symbol extractor.
// Locks the audit-found gaps where RFC-083's follow-ups were Java/TS-tuned and
// silently wrong for other languages (see design/RFC-087-…/design.md):
//   - structural visibility (Rust `pub`, C++ access sections, JS/TS `#private`)
//   - constructor reclassification (TS/JS/Python/Scala)
//   - heritage for Go (embedding) + Rust (impl-for / supertrait)
//   - extraction gaps: JS/TS `#private`, C++ member methods, Rust trait sigs
// Each assertion parses a real snippet through the actual tree-sitter grammar.
import { describe, expect, test } from 'bun:test'
import { extractSymbols } from '../src/modules/workspace-insight/engine/lang/extract'
import type { LangId, SymbolNode } from '@agent-workflow/shared'

const GRAMMAR: Record<string, string> = {
  rust: 'tree-sitter-rust.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  go: 'tree-sitter-go.wasm',
  python: 'tree-sitter-python.wasm',
  scala: 'tree-sitter-scala.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  java: 'tree-sitter-java.wasm',
}

async function syms(lang: LangId, source: string): Promise<SymbolNode[]> {
  const r = await extractSymbols({
    lang,
    grammarFile: GRAMMAR[lang] ?? '',
    filePath: `x.${lang}`,
    source,
  })
  return r.symbols
}
const byName = (s: SymbolNode[], name: string): SymbolNode | undefined =>
  s.find((x) => x.name === name)

describe('RFC-087 visibility (structural)', () => {
  test('rust: pub vs private vs pub(crate)', async () => {
    const s = await syms(
      'rust',
      `pub struct S { pub x: i32, y: String }
impl S { pub fn pub_m(&self) {} fn priv_m(&self) {} pub(crate) fn crate_m(&self) {} }`,
    )
    expect(byName(s, 'x')?.visibility).toBe('public')
    expect(byName(s, 'y')?.visibility).toBe('private')
    expect(byName(s, 'pub_m')?.visibility).toBe('public')
    expect(byName(s, 'priv_m')?.visibility).toBe('private')
    expect(byName(s, 'crate_m')?.visibility).toBe('package')
  })

  test('cpp: access-specifier sections drive member visibility', async () => {
    const s = await syms(
      'cpp',
      `class C {
public:
  int getX();
private:
  void p();
  int x_;
};`,
    )
    expect(byName(s, 'getX')?.visibility).toBe('public')
    expect(byName(s, 'p')?.visibility).toBe('private')
    expect(byName(s, 'x_')?.visibility).toBe('private')
  })

  test('js/ts: #private members are private', async () => {
    const js = await syms('javascript', `class C { #s = 1; #p() {} pub() {} }`)
    expect(byName(js, '#s')?.visibility).toBe('private')
    expect(byName(js, '#p')?.visibility).toBe('private')
    const ts = await syms('typescript', `class C { #s = 1; pub(): void {} }`)
    expect(byName(ts, '#s')?.visibility).toBe('private')
  })

  test('langs handled by the frontend heuristic carry no backend visibility', async () => {
    // Python/Go/Java visibility stays a frontend concern (name/keyword) — backend
    // must NOT set it, so the heuristic still runs.
    const py = await syms('python', `class C:\n    def _prot(self): pass\n`)
    expect(byName(py, '_prot')?.visibility).toBeUndefined()
  })
})

describe('RFC-087 constructor reclassification', () => {
  test('ts/js constructor', async () => {
    const ts = await syms('typescript', `class C { constructor(n: number) {} m() {} }`)
    expect(byName(ts, 'constructor')?.kind).toBe('constructor')
    const js = await syms('javascript', `class C { constructor(n) {} }`)
    expect(byName(js, 'constructor')?.kind).toBe('constructor')
  })
  test('python __init__', async () => {
    const py = await syms(
      'python',
      `class Dog:\n    def __init__(self): pass\n    def speak(self): pass\n`,
    )
    expect(byName(py, '__init__')?.kind).toBe('constructor')
    expect(byName(py, 'speak')?.kind).toBe('method')
  })
  test('scala def this (auxiliary ctor)', async () => {
    const sc = await syms('scala', `class C(x: Int) {\n  def this() = this(0)\n}`)
    expect(byName(sc, 'this')?.kind).toBe('constructor')
  })
  test('a free function named constructor is NOT a constructor', async () => {
    const js = await syms('javascript', `function constructor() {}`)
    expect(byName(js, 'constructor')?.kind).toBe('function')
  })
})

describe('RFC-087 heritage (Go / Rust)', () => {
  test('go struct + interface embedding', async () => {
    const s = await syms(
      'go',
      `type Base struct { Name string }
type Dog struct {
\tBase
\t*Embedded
\tlegs int
}
type Speaker interface { Animal; Speak() string }`,
    )
    expect(byName(s, 'Dog')?.heritage).toEqual(expect.arrayContaining(['Base', 'Embedded']))
    expect(byName(s, 'Speaker')?.heritage).toEqual(expect.arrayContaining(['Animal']))
  })
  test('rust impl-for + supertrait', async () => {
    const s = await syms(
      'rust',
      `struct S {}
trait Sub: Super {}
impl Display for S {}`,
    )
    expect(byName(s, 'S')?.heritage).toEqual(expect.arrayContaining(['Display']))
    expect(byName(s, 'Sub')?.heritage).toEqual(expect.arrayContaining(['Super']))
  })
})

describe('RFC-087 extraction gaps', () => {
  test('rust trait method signatures are extracted (function_signature_item)', async () => {
    const s = await syms('rust', `trait T { fn speak(&self) -> String; }`)
    const m = s.find((x) => x.name === 'speak')
    expect(m?.kind).toBe('method')
    expect(m?.qualifiedName).toBe('T.speak')
  })
  test('cpp in-class member methods are extracted (was missed)', async () => {
    const s = await syms('cpp', `class C { public: int getX(); void setX(int v) { } };`)
    expect(byName(s, 'getX')?.kind).toBe('method')
    expect(byName(s, 'setX')?.kind).toBe('method')
  })
  test('js #private fields/methods are extracted (were dropped)', async () => {
    const s = await syms('javascript', `class C { #s = 1; #p() {} }`)
    expect(byName(s, '#s')).toBeDefined()
    expect(byName(s, '#p')).toBeDefined()
  })
})
