// RFC-083 PR-A — grammar/runtime asset resolution + extension→language mapping.
//
// Baseline engine = web-tree-sitter (WASM). Grammar capabilities live in the
// grammar `.wasm` (architecture-independent), so the single-binary distribution
// is preserved (PR-C embeds these via the `embed.generated.ts` table). This
// module is the ONLY place that knows where the wasm assets live; in dev it
// resolves them out of node_modules, PR-C swaps in the embedded `/$bunfs` path.
//
// Grammar provenance note: `tree-sitter-wasms` ships grammars built with
// tree-sitter-cli ~0.20, so they pair with `web-tree-sitter@0.22.x` (newer 0.25+
// runtimes reject the older emscripten side-module dylink format). The grammar
// source is swappable behind this registry without touching extraction logic,
// so modernizing grammars later (e.g. building 0.25-aligned wasms in CI) is a
// drop-in change. See design §0 / OQ-1.
//
// RFC-453: the extension→language table moved to `domain/lang/languages.ts`.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { GRAMMAR_FILES, IS_EMBEDDED } from '@/embed.generated'

const require = createRequire(import.meta.url)

let _grammarsDir: string | null = null
let _runtimeWasm: string | null = null

/** Directory holding the per-language `tree-sitter-<lang>.wasm` files (dev). */
export function grammarsDir(): string {
  if (_grammarsDir === null) {
    _grammarsDir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out')
  }
  return _grammarsDir
}

/** The web-tree-sitter runtime `.wasm` (loaded by `Parser.init`). In the
 *  compiled binary it comes from the embed table; in dev from node_modules. */
export function runtimeWasmPath(): string {
  if (IS_EMBEDDED) {
    const embedded = GRAMMAR_FILES['tree-sitter.wasm']
    if (embedded !== undefined) return embedded
  }
  if (_runtimeWasm === null) {
    _runtimeWasm = join(
      dirname(require.resolve('web-tree-sitter/package.json')),
      'tree-sitter.wasm',
    )
  }
  return _runtimeWasm
}

/** Absolute path to a grammar wasm file by its bare filename. Embedded
 *  `/$bunfs/...` path in the binary; node_modules path in dev. */
export function grammarFilePath(grammarFile: string): string {
  if (IS_EMBEDDED) {
    const embedded = GRAMMAR_FILES[grammarFile]
    if (embedded !== undefined) return embedded
  }
  return join(grammarsDir(), grammarFile)
}
