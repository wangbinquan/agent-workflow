// RFC-083 PR-A — single-file baseline analysis: extract old + new symbol sets
// and graphDiff them into a FileStructuralDiff.
//
// This is the per-file unit the task/node/wrapper drivers (PR-C) call once per
// changed file. It is intentionally I/O-free beyond tree-sitter: callers supply
// the old/new blob text (PR-C fetches them via `git show <ref>:<path>` / the
// worktree). Edges (call/import graph) land in PR-B; `edges` is [] here.

import { graphDiff, type FileStructuralDiff, type SymbolChange } from '@agent-workflow/shared'
import { resolveLang } from './lang/grammars'
import { extractSymbols } from './lang/extract'
import { hasExtraction, DEGRADED_LANGS } from './lang/queries'
import { computeWithinFileImpact } from './impact'
import { bodyDeltaFor } from './bodyDelta'

/** Files larger than this are skipped (consistent with diff sharding caps). */
export const MAX_ANALYZE_BYTES = 1_500_000

const NUL = '\u0000'

/** RFC-370 §10 V16 — a side the content source answered with a reason instead
 *  of text (it is larger than the read bound, or binary). It classifies the
 *  file exactly as the text itself would have. */
export interface UnreadableBlob {
  readonly unreadable: 'oversized' | 'binary'
}

/** One side of a changed file: its text, null when the side does not exist, or
 *  the reason the source gave instead of the text. */
export type AnalysisBlob = string | null | UnreadableBlob

export function isUnreadableBlob(blob: AnalysisBlob): blob is UnreadableBlob {
  return typeof blob === 'object' && blob !== null
}

/** The text of a side, null when it is missing or unreadable. */
export function blobText(blob: AnalysisBlob): string | null {
  return typeof blob === 'string' ? blob : null
}

function looksBinary(text: string): boolean {
  // A NUL in the first 8KB is the cheap, reliable binary signal git itself uses.
  const slice = text.length > 8192 ? text.slice(0, 8192) : text
  return slice.includes(NUL)
}

function anchorFor(change: SymbolChange, filePath: string) {
  const node = change.after ?? change.before
  const range = node?.range
  if (range === undefined) return undefined
  return { filePath, startLine: range.startLine, endLine: range.endLine }
}

/**
 * Analyze one changed file. `oldText`/`newText` are the before/after blob
 * contents; pass null for the missing side (added file → oldText null, removed
 * file → newText null). Never throws — a parse failure degrades to
 * `status: 'parse-error'` for that file alone.
 */
export async function analyzeFile(opts: {
  filePath: string
  oldText: AnalysisBlob
  newText: AnalysisBlob
}): Promise<FileStructuralDiff> {
  const { filePath } = opts
  const resolution = resolveLang(filePath)
  if (resolution === null) {
    return { filePath, lang: 'unknown', status: 'unsupported', changes: [], edges: [], impact: [] }
  }
  const { lang, grammarFile } = resolution
  if (!hasExtraction(lang)) {
    // Grammar exists but extraction queries not authored yet (PR-B langs).
    return { filePath, lang, status: 'unsupported', changes: [], edges: [], impact: [] }
  }

  const present = [opts.oldText, opts.newText].filter(
    (t): t is string | UnreadableBlob => t !== null,
  )
  if (present.some((t) => (isUnreadableBlob(t) ? t.unreadable === 'binary' : looksBinary(t)))) {
    return { filePath, lang, status: 'skipped-binary', changes: [], edges: [], impact: [] }
  }
  if (
    present.some((t) =>
      isUnreadableBlob(t) ? t.unreadable === 'oversized' : t.length > MAX_ANALYZE_BYTES,
    )
  ) {
    return { filePath, lang, status: 'skipped-oversized', changes: [], edges: [], impact: [] }
  }
  // Every present side is text from here on.
  const oldText = blobText(opts.oldText)
  const newText = blobText(opts.newText)

  try {
    const oldRes =
      oldText !== null
        ? await extractSymbols({ lang, grammarFile, filePath, source: oldText })
        : { symbols: [], hadError: false }
    const newRes =
      newText !== null
        ? await extractSymbols({ lang, grammarFile, filePath, source: newText })
        : { symbols: [], hadError: false }
    const changes = graphDiff(oldRes.symbols, newRes.symbols).map((c) => ({
      ...c,
      hunkAnchor: anchorFor(c, filePath),
      bodyDelta: bodyDeltaFor(c, oldText, newText),
    }))
    // best-effort language → degraded; otherwise a recovered parse error also
    // downgrades to degraded so the UI flags "analysis may be incomplete".
    const status: FileStructuralDiff['status'] =
      DEGRADED_LANGS.has(lang) || oldRes.hadError || newRes.hadError ? 'degraded' : 'ok'
    const impact = computeWithinFileImpact(changes, newRes.symbols, newText, filePath)
    return { filePath, lang, status, changes, edges: [], impact }
  } catch {
    return { filePath, lang, status: 'parse-error', changes: [], edges: [], impact: [] }
  }
}
