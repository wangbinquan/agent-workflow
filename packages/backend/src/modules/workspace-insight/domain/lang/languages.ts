// RFC-083 PR-A — extension→language mapping of the baseline engine. RFC-453: moved out of the grammar asset
// module (`engine/lang/grammars.ts` keeps where the wasm assets live) so the table is plain domain data.

import type { LangId } from '@agent-workflow/shared'

export interface LangResolution {
  lang: LangId
  /** Grammar wasm filename (e.g. `tree-sitter-python.wasm`). */
  grammarFile: string
}

// Extension → (langId, grammar wasm). Several languages need a dialect grammar
// (tsx vs typescript); the langId stays the canonical one so downstream
// schema/UI group by language, not by file dialect.
export const EXT_RESOLUTION: Record<string, LangResolution> = {
  '.py': { lang: 'python', grammarFile: 'tree-sitter-python.wasm' },
  '.pyi': { lang: 'python', grammarFile: 'tree-sitter-python.wasm' },
  '.go': { lang: 'go', grammarFile: 'tree-sitter-go.wasm' },
  '.ts': { lang: 'typescript', grammarFile: 'tree-sitter-typescript.wasm' },
  '.mts': { lang: 'typescript', grammarFile: 'tree-sitter-typescript.wasm' },
  '.cts': { lang: 'typescript', grammarFile: 'tree-sitter-typescript.wasm' },
  '.tsx': { lang: 'typescript', grammarFile: 'tree-sitter-tsx.wasm' },
  '.js': { lang: 'javascript', grammarFile: 'tree-sitter-javascript.wasm' },
  '.jsx': { lang: 'javascript', grammarFile: 'tree-sitter-javascript.wasm' },
  '.mjs': { lang: 'javascript', grammarFile: 'tree-sitter-javascript.wasm' },
  '.cjs': { lang: 'javascript', grammarFile: 'tree-sitter-javascript.wasm' },
  // Grammars present in tree-sitter-wasms; extraction queries land in PR-B.
  '.java': { lang: 'java', grammarFile: 'tree-sitter-java.wasm' },
  '.rs': { lang: 'rust', grammarFile: 'tree-sitter-rust.wasm' },
  '.cpp': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.cc': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.cxx': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.hpp': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.hh': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.hxx': { lang: 'cpp', grammarFile: 'tree-sitter-cpp.wasm' },
  '.scala': { lang: 'scala', grammarFile: 'tree-sitter-scala.wasm' },
  '.sc': { lang: 'scala', grammarFile: 'tree-sitter-scala.wasm' },
}

/**
 * The extension `node:path`'s posix `extname` gives, computed without the host path module (domain stays
 * host-free; every caller passes a portable `/`-separated repository path): the last `.`-suffix of the last
 * segment, ignoring trailing separators; empty for no dot, a leading-dot name (`.ts`) and `..`.
 */
function extensionOf(filePath: string): string {
  let end = filePath.length
  while (end > 0 && filePath[end - 1] === '/') end--
  const segment = filePath.slice(filePath.lastIndexOf('/', end - 1) + 1, end)
  const dot = segment.lastIndexOf('.')
  return dot <= 0 || segment === '..' ? '' : segment.slice(dot)
}

/** Resolve a file path to its language + grammar, or null when unsupported. */
export function resolveLang(filePath: string): LangResolution | null {
  return EXT_RESOLUTION[extensionOf(filePath).toLowerCase()] ?? null
}
