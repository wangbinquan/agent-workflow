// RFC-087 — AST comment/string masking (lang/mask.ts) replaces the C-family hand
// lexer that mis-handled Python `#`, multi-line strings (Go raw / JS template /
// Scala triple / Rust·C++ raw), so a class name appearing ONLY in a comment or
// string is never matched as a real reference. Locks each per-language gap from
// the RFC-087 audit. Asserts the masked output blanks the identifier while
// preserving line structure (newline count).
import { describe, expect, test } from 'bun:test'
import { maskCommentsAndStrings } from '../src/modules/workspace-insight/engine/lang/mask'
import type { LangId } from '@agent-workflow/shared'

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
const mask = (lang: LangId, src: string): Promise<string> =>
  maskCommentsAndStrings(lang, GRAMMAR[lang] ?? '', src)

describe('RFC-087 mask: query compiles + masks for all 8 languages', () => {
  const cases: Array<{ lang: LangId; src: string; secret: string }> = [
    { lang: 'python', src: `# Animal here\ns = "Animal too"\nx = 1`, secret: 'Animal' },
    { lang: 'go', src: 'var x = `Animal\nmulti`\n// Animal', secret: 'Animal' },
    { lang: 'rust', src: 'let s = r#"Animal"#;\n// Animal\nlet c = 1;', secret: 'Animal' },
    { lang: 'cpp', src: 'const char* s = R"(Animal)";\n// Animal\nint x;', secret: 'Animal' },
    {
      lang: 'javascript',
      src: 'const t = `Animal\nline2`;\n// Animal\nlet x = 1',
      secret: 'Animal',
    },
    {
      lang: 'typescript',
      src: 'const t = `Animal`;\n// Animal\nlet x: number = 1',
      secret: 'Animal',
    },
    { lang: 'java', src: 'class C { String s = "Animal"; /* Animal */ }', secret: 'Animal' },
    { lang: 'scala', src: 'val s = """Animal\nmore"""\n// Animal', secret: 'Animal' },
  ]
  for (const c of cases) {
    test(`${c.lang}: blanks ${c.secret} in comments/strings, keeps line count`, async () => {
      const out = await mask(c.lang, c.src)
      expect(out).not.toContain(c.secret) // identifier removed from comments/strings
      expect(out.split('\n').length).toBe(c.src.split('\n').length) // newlines preserved
      expect(out.length).toBe(c.src.length) // length preserved (range-blanked with spaces)
    })
  }
})

describe('RFC-087 mask: real code identifiers survive', () => {
  test('python multi-line docstring blanked but class/def kept', async () => {
    const src = `class Dog(Animal):\n    """mentions Sneaky here"""\n    def speak(self): pass\n`
    const out = await mask('python', src)
    expect(out).toContain('class Dog')
    expect(out).toContain('def speak')
    expect(out).not.toContain('Sneaky') // docstring content gone (the regex lexer missed this)
  })
  test('go multi-line raw string fully blanked (not just first line)', async () => {
    const src = 'var q = `line1 Sneaky\nline2 Sneaky`\ntype T struct{}'
    const out = await mask('go', src)
    expect(out).not.toContain('Sneaky') // BOTH lines — the hand lexer leaked after line 1
    expect(out).toContain('type T struct')
  })
})
