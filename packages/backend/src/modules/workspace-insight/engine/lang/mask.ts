// RFC-087 — AST-based comment/string masking. Replaces the C-family hand lexer
// (`stripCommentsAndStrings` in classGraph.ts) that mis-handled Python `#`,
// multi-line strings (Go raw / JS templates / Scala triple / Rust·C++ raw), etc.
//
// We re-parse the file and blank the SOURCE RANGE of every comment + string
// literal node (replace with spaces, keep newlines so line/column offsets stay
// valid), so a class/method name appearing only inside a comment or string is
// never matched as a real reference by the classGraph name scan. The mask node
// types per language come from real grammar probes (tree-sitter-wasms ~0.20).
//
// web-tree-sitter `node.startIndex/endIndex` are JS-string (UTF-16 code unit)
// offsets — the same indices extract.ts already slices `source` with — so we can
// blank `source` by those indices directly.

import type { LangId } from '@agent-workflow/shared'
import { parseSource } from './parser'

/** Tree-sitter query capturing every comment + string-literal node, per language.
 *  A query referencing a node type the grammar lacks fails to COMPILE, so these
 *  are kept exact to each (0.20-era) grammar — validated by mask.test.ts. */
const MASK_QUERIES: Partial<Record<LangId, string>> = {
  python: '(comment) @b (string) @b',
  go: '[(comment) (interpreted_string_literal) (raw_string_literal) (rune_literal)] @b',
  rust: '(line_comment) @b (block_comment) @b (string_literal) @b (raw_string_literal) @b (char_literal) @b',
  cpp: '[(comment) (string_literal) (char_literal) (raw_string_literal) (system_lib_string)] @b',
  javascript: '[(comment) (string) (template_string) (regex)] @b',
  typescript: '[(comment) (string) (template_string) (regex)] @b',
  java: '[(line_comment) (block_comment) (string_literal) (character_literal)] @b',
  scala: '(comment) @b (string) @b',
}

/** Languages with an exact AST mask query. */
export function hasMaskQuery(lang: LangId): boolean {
  return MASK_QUERIES[lang] !== undefined
}

/**
 * Blank comment + string content in `source` (spaces, newlines preserved).
 * Best-effort: returns `source` unchanged when the lang has no mask query or
 * parsing/query fails — callers then fall back to the regex stripper.
 */
export async function maskCommentsAndStrings(
  lang: LangId,
  grammarFile: string,
  source: string,
): Promise<string> {
  const q = MASK_QUERIES[lang]
  if (q === undefined || source === '') return source
  let parsed
  try {
    parsed = await parseSource(grammarFile, source)
  } catch {
    return source
  }
  const { tree, language } = parsed
  let query
  try {
    query = language.query(q)
  } catch {
    tree.delete()
    return source
  }
  try {
    const ranges: Array<[number, number]> = []
    for (const m of query.matches(tree.rootNode)) {
      for (const c of m.captures) ranges.push([c.node.startIndex, c.node.endIndex])
    }
    if (ranges.length === 0) return source
    const arr = source.split('')
    for (const [s, e] of ranges) {
      for (let i = s; i < e && i < arr.length; i += 1) {
        if (arr[i] !== '\n') arr[i] = ' '
      }
    }
    return arr.join('')
  } finally {
    query.delete()
    tree.delete()
  }
}
