// RFC-083 PR-A — web-tree-sitter init + grammar load cache.
//
// `Parser.init` is one-shot (loads the runtime wasm); grammars are loaded once
// and cached by filename. Callers get a fresh Parser per parse (cheap) bound to
// the cached Language. Trees/queries are wasm-heap objects — callers MUST
// `.delete()` them when done (extract.ts handles this).

import Parser from 'web-tree-sitter'
import { grammarFilePath, runtimeWasmPath } from './grammars'

let _initPromise: Promise<void> | null = null
const _languages = new Map<string, Parser.Language>()

function init(): Promise<void> {
  if (_initPromise === null) {
    _initPromise = Parser.init({ locateFile: () => runtimeWasmPath() })
  }
  return _initPromise
}

/** Load (and cache) a grammar Language by its wasm filename. */
export async function loadLanguage(grammarFile: string): Promise<Parser.Language> {
  await init()
  const cached = _languages.get(grammarFile)
  if (cached !== undefined) return cached
  const lang = await Parser.Language.load(grammarFilePath(grammarFile))
  _languages.set(grammarFile, lang)
  return lang
}

/** Parse `source` with the given grammar. Returns the tree + its Language (for
 *  building queries). The caller owns `tree` and must call `tree.delete()`. */
export async function parseSource(
  grammarFile: string,
  source: string,
): Promise<{ tree: Parser.Tree; language: Parser.Language }> {
  const language = await loadLanguage(grammarFile)
  const parser = new Parser()
  parser.setLanguage(language)
  const tree = parser.parse(source)
  return { tree, language }
}
