// RFC-079 — pure helpers for the review node's multi-document mode.
//
// A review node enters multi-document mode when its inputSource upstream port
// is a `list<path<md>>` (or `list<markdown>`): each list item becomes one
// doc_version row carrying its own item_index / item_path / selection, and the
// user reviews + curates them as a batch. These helpers are the user-level
// oracles for that behavior — no Bun / Node / DB imports, so they test in
// either runtime and back the source-level regression locks (RFC-079 C2/C3).

import { tryParseKind, type ParsedKind } from './kindParser'

// -----------------------------------------------------------------------------
// Mode detection: which review inputs trigger multi-document mode.
// -----------------------------------------------------------------------------

/** A list item kind is "markdownish" if it renders as a markdown document. */
function isMarkdownishItem(p: ParsedKind): boolean {
  if (p.kind === 'base') return p.name === 'markdown'
  if (p.kind === 'path') return p.ext === 'md' || p.ext === 'markdown'
  return false
}

/**
 * True when a review node's input port kind string should drive multi-document
 * mode: a `list<...>` whose inner item is a markdown body (`path<md>` /
 * `path<markdown>` / base `markdown`). Everything else (single `markdown` /
 * `path<md>`, non-markdown lists, malformed kinds) → false (single-doc or
 * validator-rejected).
 */
export function isMultiDocReviewInput(kind: string): boolean {
  const parsed = tryParseKind(kind)
  if (parsed === null || parsed.kind !== 'list') return false
  return isMarkdownishItem(parsed.item)
}

/**
 * True when a `list<...>` input is grammatically a list but its inner item is
 * NOT markdownish — the case the validator must reject with
 * `review-input-list-item-not-markdown` (distinct from "not a list at all").
 */
export function isNonMarkdownListReviewInput(kind: string): boolean {
  const parsed = tryParseKind(kind)
  if (parsed === null || parsed.kind !== 'list') return false
  return !isMarkdownishItem(parsed.item)
}

// -----------------------------------------------------------------------------
// Title extraction for the left-hand document list.
// -----------------------------------------------------------------------------

function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

/**
 * Derive a display title for one document: the first ATX markdown heading
 * (`# …` through `###### …`), else the first non-empty line, else the file's
 * basename. Used for the multi-doc left rail (RFC-079 A6).
 */
export function extractDocTitle(body: string, path: string): string {
  const lines = body.split('\n')
  for (const line of lines) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (m && m[1] !== undefined && m[1].trim().length > 0) return m[1].trim()
  }
  for (const line of lines) {
    const t = line.trim()
    if (t.length > 0) return t
  }
  return basename(path)
}

// -----------------------------------------------------------------------------
// Selection / accepted-subset computation.
// -----------------------------------------------------------------------------

export type DocumentSelection = 'unselected' | 'accepted' | 'not_accepted'

/**
 * Minimal shape of a multi-doc member row needed to compute the subset.
 * Fields are optional so a full `DocVersion` (whose multi-doc fields are
 * declared optional) is assignable without widening.
 */
export interface SelectableDoc {
  itemIndex?: number | null
  itemPath?: string | null
  selection?: DocumentSelection | null
}

/** True iff the row is a member of a multi-document round (item_index set). */
export function isMultiDocMember(row: { itemIndex: number | null | undefined }): boolean {
  return row.itemIndex !== null && row.itemIndex !== undefined
}

/**
 * Accepted documents' paths, ordered by item_index (stable input order).
 * Excludes not_accepted / unselected and any row missing a path. RFC-079 C2.
 */
export function acceptedSubsetPaths(rows: readonly SelectableDoc[]): string[] {
  return rows
    .filter((r) => r.selection === 'accepted' && r.itemPath != null && r.itemPath !== '')
    .slice()
    .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
    .map((r) => r.itemPath as string)
}

/**
 * Wire form of the `accepted` output port: accepted paths joined by newline
 * (the canonical `list<path<md>>` content). Empty string when nothing is
 * accepted — downstream wrapper-fanout sees an empty list and finishes
 * immediately (RFC-079 A9).
 */
export function computeAcceptedSubset(rows: readonly SelectableDoc[]): string {
  return acceptedSubsetPaths(rows).join('\n')
}

/**
 * True iff every member has an explicit accepted / not_accepted choice — the
 * gate for the round-level approve (RFC-079 A5: "必须全部裁决才能提交"). An
 * `unselected` (or NULL) selection on any member makes this false.
 */
export function allDocumentsDecided(rows: readonly SelectableDoc[]): boolean {
  if (rows.length === 0) return true
  return rows.every((r) => r.selection === 'accepted' || r.selection === 'not_accepted')
}
