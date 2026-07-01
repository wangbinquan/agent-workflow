// RFC-079 — pure helpers for the review node's multi-document mode.
//
// A review node enters multi-document mode when its inputSource upstream port
// is a `list<path<md>>` (or `list<markdown>`): each list item becomes one
// doc_version row carrying its own item_index / item_path / selection, and the
// user reviews + curates them as a batch. These helpers are the user-level
// oracles for that behavior — no Bun / Node / DB imports, so they test in
// either runtime and back the source-level regression locks (RFC-079 C2/C3).

import { tryParseKind, isReviewableBodyKind, type ParsedKind } from './kindParser'

/**
 * RFC-103 T4 (05-PORT-06/07): the single predicate for "this list item is an
 * INLINE markdown body" — i.e. its wire form frames documents with
 * MARKDOWN_DOC_BOUNDARY (splitMarkdownDocs) rather than one-per-line
 * (splitListItems). Shared by review (multi-doc) AND fanout shard splitting so
 * the two can't drift; fanout was hand-rolling `.split('\n')` and shredding
 * `list<markdown>` documents per line.
 */
export function isInlineMarkdownItemKind(item: ParsedKind): boolean {
  return item.kind === 'base' && item.name === 'markdown'
}

// -----------------------------------------------------------------------------
// Mode detection: which review inputs trigger multi-document mode.
//
// RFC-081: the "markdownish item" decision is delegated to the single
// `isReviewableBodyKind` predicate (kindParser) rather than re-implemented here.
// -----------------------------------------------------------------------------

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
  return isReviewableBodyKind(parsed.item)
}

/**
 * True when a `list<...>` input is grammatically a list but its inner item is
 * NOT markdownish — the case the validator must reject with
 * `review-input-list-item-not-markdown` (distinct from "not a list at all").
 */
export function isNonMarkdownListReviewInput(kind: string): boolean {
  const parsed = tryParseKind(kind)
  if (parsed === null || parsed.kind !== 'list') return false
  return !isReviewableBodyKind(parsed.item)
}

/**
 * RFC-081: a multi-document review's items are INLINE markdown bodies
 * (`list<markdown>`) rather than worktree file PATHS (`list<path<md>>`). Inline
 * items are framed by MARKDOWN_DOC_BOUNDARY in the port wire content and
 * archived with `item_path = NULL` (the body lives at the doc_version's
 * bodyPath); path items are newline-separated and carry an `item_path`.
 */
export function isInlineMarkdownListReviewInput(kind: string): boolean {
  const parsed = tryParseKind(kind)
  return parsed !== null && parsed.kind === 'list' && isInlineMarkdownItemKind(parsed.item)
}

/**
 * RFC-079/081: the downstream output port name a review node publishes for the
 * curated/approved document(s). Multi-document review (inputSource is a
 * `list<markdownish>` port) publishes `accepted` (the curated subset, kind
 * `list<path<md>>`); single-document review publishes `approved_doc` (the source
 * doc passes through). Both review nodes additionally publish `approval_meta`.
 *
 * `inputKind` is the upstream port's output kind string (the source agent's
 * `outputKinds[portName]`), or `undefined` when it can't be resolved — no
 * inputSource, a non-agent source, or the port absent from the agent's
 * `outputKinds`. Unresolvable → single-document `approved_doc`.
 *
 * Centralizing this stops the validator (`workflow.validator.ts`), the canvas
 * port inventory (`WorkflowCanvas.computePorts`), and the runtime from drifting
 * on the port name — the exact drift that produced stale `approved_doc` edges
 * against a multi-doc review node.
 */
export function reviewApprovedPortName(inputKind: string | undefined): 'accepted' | 'approved_doc' {
  return inputKind !== undefined && isMultiDocReviewInput(inputKind) ? 'accepted' : 'approved_doc'
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

// -----------------------------------------------------------------------------
// RFC-129: cross-round selection inheritance.
//
// When a multi-document review round re-opens (iterate / reject / refresh /
// US-2 re-review), the framework re-mints one doc_version per list item. Rather
// than resetting every item to `unselected`, RFC-129 carries each document's
// prior accept/not_accept choice forward from the IMMEDIATELY-PREVIOUS round,
// matched item_path-first (unique) then item_index. A carried choice whose
// content changed since the human last judged it is flagged stale ("已变更").
//
// These are the pure oracles for that matching + staleness decision; the
// service (services/review.ts, loadPriorRoundMembers) picks the immediately-
// previous round's members + reads their bodies and feeds them here. No DB / IO
// — exhaustively tested in reviewMultiDoc.inherit.test.ts.
// -----------------------------------------------------------------------------

/**
 * One member of the immediately-previous review round, projected by the service
 * from a doc_versions row + its archived body. `selectionStale` is normalized to
 * a boolean at the service boundary (`row.selectionStale ?? false`), since the
 * column is nullable ({ mode: 'boolean' } → boolean | null).
 */
export interface PriorRoundMember {
  itemIndex: number
  itemPath: string | null
  selection: DocumentSelection
  /** Whether this member's selection was already stale (unresolved) last round. */
  selectionStale: boolean
  /** The archived body the prior round showed (for content-change compare). */
  body: string
}

/** One item of the round being minted now (body in hand at mint time). */
export interface NewRoundItem {
  itemIndex: number
  itemPath: string | null
  body: string
}

export interface InheritedSelection {
  selection: DocumentSelection
  /** True → mint this member with selection_stale = true. */
  stale: boolean
}

export interface PriorSelectionLookup {
  /**
   * Prior members keyed by item_path — ONLY paths that are UNIQUE among the
   * prior members (ambiguous / duplicate paths are excluded so they fall back to
   * item_index matching).
   */
  byPath: Map<string, PriorRoundMember>
  byIndex: Map<number, PriorRoundMember>
}

/**
 * Build the path/index lookup over ONE round's members (the immediately-previous
 * round). A path present on more than one member is NOT indexed by path
 * (ambiguous → index fallback); every member is indexed by item_index.
 */
export function buildPriorSelectionLookup(
  prior: readonly PriorRoundMember[],
): PriorSelectionLookup {
  const pathCounts = new Map<string, number>()
  for (const m of prior) {
    if (m.itemPath != null && m.itemPath !== '') {
      pathCounts.set(m.itemPath, (pathCounts.get(m.itemPath) ?? 0) + 1)
    }
  }
  const byPath = new Map<string, PriorRoundMember>()
  const byIndex = new Map<number, PriorRoundMember>()
  for (const m of prior) {
    if (m.itemPath != null && m.itemPath !== '' && pathCounts.get(m.itemPath) === 1) {
      byPath.set(m.itemPath, m)
    }
    byIndex.set(m.itemIndex, m)
  }
  return { byPath, byIndex }
}

/**
 * Resolve a new item's inherited selection from the immediately-previous round.
 * Match priority (RFC-129 D1): unique item_path → item_index → none (new doc).
 * A matched, non-`unselected` choice is carried; it is flagged stale when the
 * new body differs from the prior member's body OR the prior member was itself
 * stale (propagation until a human re-affirms — RFC-129 D4). No match /
 * `unselected` prior → `unselected`, not stale.
 */
export function inheritSelection(
  item: NewRoundItem,
  lookup: PriorSelectionLookup,
): InheritedSelection {
  const m =
    (item.itemPath != null && item.itemPath !== ''
      ? lookup.byPath.get(item.itemPath)
      : undefined) ?? lookup.byIndex.get(item.itemIndex)
  if (m === undefined || m.selection === 'unselected') {
    return { selection: 'unselected', stale: false }
  }
  const changed = item.body !== m.body
  return { selection: m.selection, stale: changed || m.selectionStale }
}
