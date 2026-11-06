// RFC-083 PR-C/T13 — source guards for the single-binary grammar embed + the
// WASM-only rule. These lock wiring that the unit tests can't observe (the embed
// only materializes during `bun build --compile`) and that the binary smoke
// can't either (it runs `version`, not a structural diff).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

describe('grammar embed wiring (T13)', () => {
  test('build-binary.ts embeds tree-sitter runtime + grammar wasms into GRAMMAR_FILES', () => {
    const src = read('scripts/build-binary.ts')
    expect(src).toMatch(/GRAMMAR_FILES/)
    expect(src).toMatch(/grammarWasmPaths/)
    expect(src).toMatch(/tree-sitter-wasms/)
    expect(src).toMatch(/web-tree-sitter/)
  })

  test('embed.generated.ts stub exports GRAMMAR_FILES', () => {
    expect(read('packages/backend/src/embed.generated.ts')).toMatch(
      /export const GRAMMAR_FILES: Record<string, string> = \{\}/,
    )
  })

  test('grammars.ts honors IS_EMBEDDED / GRAMMAR_FILES (binary uses bunfs paths)', () => {
    const src = read('packages/backend/src/modules/workspace-insight/engine/lang/grammars.ts')
    expect(src).toMatch(/import \{ GRAMMAR_FILES, IS_EMBEDDED \} from '@\/embed.generated'/)
    expect(src).toMatch(/if \(IS_EMBEDDED\)/)
  })
})

describe('WASM-only rule (no native tree-sitter)', () => {
  test('structuralDiff only imports web-tree-sitter, never native node-tree-sitter', () => {
    // Native bindings would reintroduce the per-arch prebuild matrix that the
    // single-binary distribution exists to avoid (design §0).
    const files = [
      'packages/backend/src/modules/workspace-insight/engine/lang/parser.ts',
      'packages/backend/src/modules/workspace-insight/engine/lang/extract.ts',
      'packages/backend/src/modules/workspace-insight/engine/lang/queries.ts',
    ]
    for (const f of files) {
      const src = read(f)
      // Allow `web-tree-sitter`; forbid a bare `from 'tree-sitter'` / `node-tree-sitter`.
      expect(src).not.toMatch(/from ['"]tree-sitter['"]/)
      expect(src).not.toMatch(/node-tree-sitter/)
    }
  })
})
