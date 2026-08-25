// RFC-326 — the simplified-anchor resolver: `{ quote, occurrence?, section? }` → the
// RFC-005 composite `ReviewCommentAnchor`, computed from the markdown SOURCE.
//
// This is the first slice of the `collaboration` bounded context (RFC-294 design
// §… owner of SubmitReviewDecision / GetGateView). It is a pure domain module: no
// DB, no fs, no HTTP — only `@agent-workflow/shared` primitives. The application
// service (`services/review.ts`, still legacy) reaches it through
// `modules/collaboration/public/queries`.
//
// ## What the web page needs from this
//
// The highlighter (RFC-326 §9) locates a comment by `offsetStart / offsetEnd`
// (source offsets) and falls back to `selectedText + occurrenceIndex`. Those four
// fields are therefore exact here. `sectionPath` and `paragraphIdx` only feed the
// re-run prompt (`renderCommentsForPrompt`) and the sidebar ordering, so the block
// model below is a deliberately small CommonMark subset that mirrors the frontend
// DOM heuristics (`lib/review/anchor.ts`) closely enough, and is documented where it
// does not (design §2.5).
//
// ## Never guess
//
// The resolver returns a result object, not a best effort: an ambiguous quote is an
// error that lists the candidates (global occurrence numbers — the same numbers the
// database stores and the page uses), a missing quote is an error that lists near
// misses, and nothing is ever "clamped" to the first occurrence.

import {
  forEachOccurrence,
  type ReviewAnchorWarning,
  type ReviewCommentAnchor,
} from '@agent-workflow/shared'

// -----------------------------------------------------------------------------
// Public contract (re-exported by public/types.ts — literal objects, unions and
// arrays only; no Record / unknown / function types cross the module boundary)
// -----------------------------------------------------------------------------

/** What a caller supplies. All optional; everything empty = document-level comment. */
export interface ReviewAnchorRequest {
  /** Verbatim text from the document body (trimmed before matching; no case / whitespace folding). */
  quote?: string
  /** 1-based GLOBAL occurrence number — the number stored as `occurrenceIndex` and listed in candidates. */
  occurrence?: number
  /** Heading text (without `#`), one breadcrumb segment (`### Auth`) or the full breadcrumb `## A > ### B`. */
  section?: string
}

export interface ReviewAnchorCandidate {
  /** Global occurrence number. */
  occurrence: number
  sectionPath: string
  offsetStart: number
  /** ≤ 30 chars, hint only (may be redacted on the MCP channel). */
  contextBefore: string
  contextAfter: string
}

/** A near miss offered on `review-anchor-not-found`; `sourceText` is a verbatim slice to copy. */
export interface ReviewAnchorSuggestion {
  sourceText: string
  offsetStart: number
  sectionPath: string
}

export type ReviewAnchorErrorCode =
  | 'review-anchor-empty-document'
  | 'review-anchor-not-found'
  | 'review-anchor-ambiguous'
  | 'review-anchor-occurrence-out-of-range'
  | 'review-anchor-section-not-found'
  | 'review-anchor-occurrence-not-in-section'
  | 'review-anchor-crosses-heading'
  | 'review-anchor-budget-exceeded'

/** Re-exported so consumers of the module's public types need not reach for shared. */
export type { ReviewAnchorWarning }

export interface ReviewAnchorSuccess {
  ok: true
  anchor: ReviewCommentAnchor
  warnings: ReviewAnchorWarning[]
}

export interface ReviewAnchorFailure {
  ok: false
  code: ReviewAnchorErrorCode
  /** Human-readable, candidate KEYS first (occurrence · section · @offset), contexts last. */
  message: string
  /** At most REVIEW_ANCHOR_CANDIDATE_LIMIT entries. */
  candidates: ReviewAnchorCandidate[]
  /** Exact size of the candidate set (may exceed candidates.length). */
  total: number
  truncated: boolean
  /** Near misses on not-found; empty otherwise. */
  suggestions: ReviewAnchorSuggestion[]
}

export type ReviewAnchorResolution = ReviewAnchorSuccess | ReviewAnchorFailure

export type ReviewAnchorBlockKind =
  | 'paragraph'
  | 'code'
  | 'blockquote'
  | 'list'
  | 'table'
  | 'hr'
  | 'html'
  | 'heading'

export interface ReviewAnchorSpan {
  start: number
  end: number
}

export interface ReviewAnchorBlock {
  start: number
  end: number
  kind: ReviewAnchorBlockKind
}

export interface ReviewAnchorHeading {
  /** Offset of the heading LINE start (Setext: the text line). */
  offset: number
  /** Offset where the heading text begins (after `#`s / indentation). */
  textStart: number
  /** Source text of the heading (inline markup kept, trailing `#`s and `\r` stripped). */
  text: string
  level: number
  /** Breadcrumb valid from this heading until the next one: `## A > ### B`. */
  sectionPath: string
}

/**
 * The document model: one line scan, reused by every anchor of the same body
 * (a batch resolves 200 quotes against ONE model). Treat as opaque.
 */
export interface ReviewAnchorDocument {
  readonly body: string
  readonly headings: readonly ReviewAnchorHeading[]
  readonly blocks: readonly ReviewAnchorBlock[]
  readonly fences: readonly ReviewAnchorSpan[]
  /** Source ranges that produce no rendered text (link destinations, HTML comments, reference definitions). */
  readonly nonRendered: readonly ReviewAnchorSpan[]
  /** Trimmed first non-empty line, for document-level anchors on heading-less bodies. */
  readonly firstNonEmptyLine: ReviewAnchorSpan | null
}

/** Per-request scan budget: every resolve charges `body.length`; mutable on purpose. */
export interface ReviewAnchorBudget {
  remainingChars: number
}

export const REVIEW_ANCHOR_CANDIDATE_LIMIT = 50
export const REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT = 10
export const REVIEW_ANCHOR_SUGGESTION_LIMIT = 5
export const REVIEW_ANCHOR_CONTEXT_CHARS = 30
/** 64 MiB of scanned characters per request (design §2.3 step 3). */
export const REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS = 64 * 1024 * 1024

export function createReviewAnchorBudget(
  limitChars = REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS,
): ReviewAnchorBudget {
  return { remainingChars: limitChars }
}

// -----------------------------------------------------------------------------
// Document model — one scan
// -----------------------------------------------------------------------------

const ATX_HEADING = /^( {0,3})(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const LINK_REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S/
const HTML_COMMENT = /<!--[\s\S]*?-->/g
/** `](destination "title")` — the destination + title never render. */
const LINK_DESTINATION = /\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g

interface ScannedLine {
  start: number
  /** End of the line text — before `\r?\n`. */
  end: number
  text: string
}

function scanLines(body: string): ScannedLine[] {
  const out: ScannedLine[] = []
  const re = /\r?\n/g
  let start = 0
  for (;;) {
    const m = re.exec(body)
    if (m === null) break
    out.push({ start, end: m.index, text: body.slice(start, m.index) })
    start = m.index + m[0].length
  }
  out.push({ start, end: body.length, text: body.slice(start) })
  return out
}

function stripClosingSequence(raw: string): string {
  // CommonMark: an optional closing sequence of `#`s, preceded by a space, or a
  // line made only of `#`s (`# #`, `## ###`) → empty heading text.
  const trimmed = raw.trim()
  if (/^#+$/.test(trimmed)) return ''
  return trimmed.replace(/[ \t]+#+$/, '').trim()
}

function blockKindForLine(text: string): ReviewAnchorBlockKind {
  if (text.startsWith('>')) return 'blockquote'
  if (LIST_ITEM.test(text)) return 'list'
  if (text.startsWith('|')) return 'table'
  if (text.startsWith('<')) return 'html'
  return 'paragraph'
}

function breadcrumb(levels: ReadonlyArray<string | null>): string {
  const parts: string[] = []
  for (let lvl = 1; lvl <= 6; lvl++) {
    const text = levels[lvl]
    if (text === null || text === undefined) continue
    parts.push(text.length > 0 ? `${'#'.repeat(lvl)} ${text}` : '#'.repeat(lvl))
  }
  return parts.join(' > ')
}

export function buildReviewAnchorDocument(body: string): ReviewAnchorDocument {
  const lines = scanLines(body)
  const headings: ReviewAnchorHeading[] = []
  const blocks: ReviewAnchorBlock[] = []
  const fences: ReviewAnchorSpan[] = []
  const nonRendered: ReviewAnchorSpan[] = []
  let firstNonEmptyLine: ReviewAnchorSpan | null = null

  const levels: Array<string | null> = [null, null, null, null, null, null, null]
  let current: ReviewAnchorBlock | null = null
  const closeBlock = (): void => {
    if (current !== null) blocks.push(current)
    current = null
  }
  const pushHeading = (offset: number, textStart: number, text: string, level: number): void => {
    levels[level] = text
    for (let deeper = level + 1; deeper <= 6; deeper++) levels[deeper] = null
    headings.push({ offset, textStart, text, level, sectionPath: breadcrumb(levels) })
  }

  let fence: { char: string; len: number; start: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const text = line.text
    const isBlank = text.trim().length === 0

    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text)
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fences.push({ start: fence.start, end: line.end })
        blocks.push({ start: fence.start, end: line.end, kind: 'code' })
        fence = null
      }
      continue
    }

    if (!isBlank && firstNonEmptyLine === null) {
      const lead = text.length - text.trimStart().length
      const trail = text.length - text.trimEnd().length
      firstNonEmptyLine = { start: line.start + lead, end: line.end - trail }
    }

    const open = FENCE_OPEN.exec(text)
    if (open !== null && !(open[2]![0] === '`' && open[3]!.includes('`'))) {
      closeBlock()
      fence = { char: open[2]![0]!, len: open[2]!.length, start: line.start }
      continue
    }

    if (isBlank) {
      closeBlock()
      continue
    }

    // A line indented under an open list item continues that item (CommonMark
    // content indent): a `#` there is a heading INSIDE the item, which the page's
    // breadcrumb (previous siblings + ancestors of the selection) never sees from
    // outside the list — so it must not become a document heading here either.
    if (current !== null && current.kind === 'list' && /^ {2,}\S/.test(text)) {
      current.end = line.end
      continue
    }

    const atx = ATX_HEADING.exec(text)
    if (atx !== null) {
      closeBlock()
      const level = atx[2]!.length
      const headingText = stripClosingSequence(atx[3] ?? '')
      const textStart =
        line.start +
        atx[1]!.length +
        level +
        (text.slice(atx[1]!.length + level).length -
          text.slice(atx[1]!.length + level).trimStart().length)
      pushHeading(line.start, textStart, headingText, level)
      blocks.push({ start: line.start, end: line.end, kind: 'heading' })
      continue
    }

    if (LINK_REFERENCE_DEFINITION.test(text)) {
      nonRendered.push({ start: line.start, end: line.end })
    }

    // Setext underline: the previous line is a paragraph line of the current block.
    const underline = SETEXT_UNDERLINE.exec(text)
    if (underline !== null && current !== null && current.kind === 'paragraph') {
      const prev = lines[i - 1]!
      const lead = prev.text.length - prev.text.trimStart().length
      const level = underline[1]![0] === '=' ? 1 : 2
      pushHeading(prev.start, prev.start + lead, prev.text.trim(), level)
      current = { start: current.start, end: line.end, kind: 'heading' }
      closeBlock()
      continue
    }

    if (THEMATIC_BREAK.test(text)) {
      closeBlock()
      blocks.push({ start: line.start, end: line.end, kind: 'hr' })
      continue
    }

    if (current === null) {
      current = { start: line.start, end: line.end, kind: blockKindForLine(text) }
    } else {
      current.end = line.end
    }
  }
  if (fence !== null) {
    // Unclosed fence extends to the end of the document (as rendered).
    fences.push({ start: fence.start, end: body.length })
    blocks.push({ start: fence.start, end: body.length, kind: 'code' })
  }
  closeBlock()

  // Ranges that never render — only outside fences (inside a fence they are code text).
  const insideFence = (offset: number): boolean => spanIndexContaining(fences, offset) !== -1
  for (const m of body.matchAll(HTML_COMMENT)) {
    if (!insideFence(m.index)) nonRendered.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of body.matchAll(LINK_DESTINATION)) {
    const start = m.index + 2 // after `](`
    if (!insideFence(start)) nonRendered.push({ start, end: start + m[1]!.length })
  }
  nonRendered.sort((a, b) => a.start - b.start)

  return { body, headings, blocks, fences, nonRendered, firstNonEmptyLine }
}

// -----------------------------------------------------------------------------
// Lookups (binary search; independent of document length per hit)
// -----------------------------------------------------------------------------

/** Index of the last element whose `start` ≤ offset, or -1. */
function lastStartLE<T extends { start: number }>(items: readonly T[], offset: number): number {
  let lo = 0
  let hi = items.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid]!.start <= offset) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

function spanIndexContaining(spans: readonly ReviewAnchorSpan[], offset: number): number {
  const idx = lastStartLE(spans, offset)
  if (idx === -1) return -1
  return offset < spans[idx]!.end ? idx : -1
}

function headingIndexAt(doc: ReviewAnchorDocument, offset: number): number {
  let lo = 0
  let hi = doc.headings.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (doc.headings[mid]!.offset <= offset) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

export function sectionPathAt(doc: ReviewAnchorDocument, offset: number): string {
  const idx = headingIndexAt(doc, offset)
  return idx === -1 ? '' : doc.headings[idx]!.sectionPath
}

const COUNTED_BLOCKS: ReadonlySet<ReviewAnchorBlockKind> = new Set([
  'paragraph',
  'code',
  'blockquote',
])

export function paragraphIdxAt(doc: ReviewAnchorDocument, offset: number): number {
  const target = lastStartLE(doc.blocks, offset)
  if (target === -1) return 0
  if (doc.blocks[target]!.kind === 'heading') return 0
  const headingIdx = headingIndexAt(doc, offset)
  let from: number
  if (headingIdx === -1) {
    // No heading above: the frontend counts from `rootEl.firstChild.nextSibling`,
    // i.e. the very first block is never counted.
    from = 1
  } else {
    const headingBlock = lastStartLE(doc.blocks, doc.headings[headingIdx]!.offset)
    from = headingBlock + 1
  }
  let count = 0
  for (let i = from; i < target; i++) {
    if (COUNTED_BLOCKS.has(doc.blocks[i]!.kind)) count++
  }
  return count
}

function crossesHeading(doc: ReviewAnchorDocument, start: number, end: number): boolean {
  // A heading LINE START strictly inside (start, end) — starting ON a heading is fine.
  const idx = headingIndexAt(doc, end - 1)
  return idx !== -1 && doc.headings[idx]!.offset > start && doc.headings[idx]!.offset < end
}

function intersectsSpan(spans: readonly ReviewAnchorSpan[], start: number, end: number): boolean {
  const idx = lastStartLE(spans, end - 1)
  return idx !== -1 && spans[idx]!.end > start
}

function fullyInsideSpan(spans: readonly ReviewAnchorSpan[], start: number, end: number): boolean {
  const idx = spanIndexContaining(spans, start)
  return idx !== -1 && end <= spans[idx]!.end
}

// -----------------------------------------------------------------------------
// Section matching
// -----------------------------------------------------------------------------

function sectionMatches(sectionPath: string, section: string): boolean {
  if (sectionPath === section) return true
  if (sectionPath.length === 0) return false
  for (const segment of sectionPath.split(' > ')) {
    if (segment === section) return true
    if (segment.replace(/^#{1,6} ?/, '') === section) return true
  }
  return false
}

// -----------------------------------------------------------------------------
// Near-miss suggestions (not-found only). ASCII case folding and whitespace
// folding keep source offsets recoverable; nothing is ever auto-selected.
// -----------------------------------------------------------------------------

interface FoldedIndex {
  lower: string
  folded: string
  /** folded index → source index of that character. */
  foldedToSource: number[]
}

const FOLDED_CACHE = new WeakMap<ReviewAnchorDocument, FoldedIndex>()

function foldWhitespace(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let inWs = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (/\s/.test(ch)) {
      if (!inWs) {
        folded += ' '
        map.push(i)
        inWs = true
      }
      continue
    }
    inWs = false
    folded += ch
    map.push(i)
  }
  return { folded, map }
}

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function foldedIndexOf(doc: ReviewAnchorDocument): FoldedIndex {
  const cached = FOLDED_CACHE.get(doc)
  if (cached !== undefined) return cached
  const lower = asciiLower(doc.body)
  const { folded, map } = foldWhitespace(lower)
  const built: FoldedIndex = { lower, folded, foldedToSource: map }
  FOLDED_CACHE.set(doc, built)
  return built
}

/**
 * Budget for one suggestion pass: the two folded scans (lower + whitespace-folded,
 * each linear in the body) plus, the first time for this document, building the
 * folded index (two more passes). Returns null when the budget cannot afford it —
 * the caller then reports not-found WITHOUT suggestions instead of scanning
 * anyway (RFC-326 impl-gate P1: the ceiling must bound real work, and the
 * suggestion passes were unmetered).
 */
function chargeSuggestionScan(
  doc: ReviewAnchorDocument,
  budget: ReviewAnchorBudget,
): 'charged' | 'unaffordable' {
  const cost = (FOLDED_CACHE.has(doc) ? 0 : 2 * doc.body.length) + 2 * doc.body.length
  if (budget.remainingChars < cost) return 'unaffordable'
  budget.remainingChars -= cost
  return 'charged'
}

function suggestionsFor(doc: ReviewAnchorDocument, quote: string): ReviewAnchorSuggestion[] {
  const index = foldedIndexOf(doc)
  const out: ReviewAnchorSuggestion[] = []
  const seen = new Set<number>()
  const push = (start: number, end: number): boolean => {
    if (seen.has(start)) return out.length < REVIEW_ANCHOR_SUGGESTION_LIMIT
    seen.add(start)
    out.push({
      sourceText: doc.body.slice(start, end),
      offsetStart: start,
      sectionPath: sectionPathAt(doc, start),
    })
    return out.length < REVIEW_ANCHOR_SUGGESTION_LIMIT
  }
  // 1. ASCII case-insensitive, exact whitespace.
  forEachOccurrence(index.lower, asciiLower(quote), (offset) => push(offset, offset + quote.length))
  if (out.length >= REVIEW_ANCHOR_SUGGESTION_LIMIT) return out
  // 2. Whitespace-folded (also case-insensitive).
  const foldedQuote = foldWhitespace(asciiLower(quote.trim())).folded
  if (foldedQuote.length > 0) {
    forEachOccurrence(index.folded, foldedQuote, (offset) => {
      const start = index.foldedToSource[offset]!
      const lastFolded = offset + foldedQuote.length - 1
      const end = index.foldedToSource[lastFolded]! + 1
      return push(start, end)
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

function contextsAround(
  body: string,
  start: number,
  end: number,
): { before: string; after: string } {
  return {
    before: body.slice(Math.max(0, start - REVIEW_ANCHOR_CONTEXT_CHARS), start),
    after: body.slice(end, end + REVIEW_ANCHOR_CONTEXT_CHARS),
  }
}

function candidateAt(
  doc: ReviewAnchorDocument,
  offset: number,
  index: number,
  quoteLength: number,
  sectionPath: string,
): ReviewAnchorCandidate {
  const ctx = contextsAround(doc.body, offset, offset + quoteLength)
  return {
    occurrence: index,
    sectionPath,
    offsetStart: offset,
    contextBefore: ctx.before,
    contextAfter: ctx.after,
  }
}

function fail(
  code: ReviewAnchorErrorCode,
  message: string,
  extra: Partial<
    Pick<ReviewAnchorFailure, 'candidates' | 'total' | 'truncated' | 'suggestions'>
  > = {},
): ReviewAnchorFailure {
  return {
    ok: false,
    code,
    message,
    candidates: extra.candidates ?? [],
    total: extra.total ?? 0,
    truncated: extra.truncated ?? false,
    suggestions: extra.suggestions ?? [],
  }
}

const REDACTION_NOTE =
  'Contexts and source snippets are hints and may be redacted; copy the quote verbatim from the document body.'

function describeCandidates(
  candidates: ReadonlyArray<ReviewAnchorCandidate>,
  quote: string,
): string {
  return candidates
    .slice(0, REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT)
    .map(
      (c) =>
        `occurrence ${c.occurrence} · ${c.sectionPath.length > 0 ? c.sectionPath : '(top)'} · @${c.offsetStart} · …${c.contextBefore}**${quote}**${c.contextAfter}…`,
    )
    .join('\n')
}

function describeSuggestions(suggestions: ReadonlyArray<ReviewAnchorSuggestion>): string {
  return suggestions
    .map(
      (s) =>
        `suggestion · ${s.sectionPath.length > 0 ? s.sectionPath : '(top)'} · @${s.offsetStart} · "${s.sourceText}"`,
    )
    .join('\n')
}

interface Hit {
  offset: number
  index: number
  sectionPath: string
  inSection: boolean
}

/**
 * Resolve one request against a prepared document. Charges `body.length` to the
 * budget per call (the scan is linear in the body) and refuses when exhausted.
 */
export function resolveReviewAnchor(
  doc: ReviewAnchorDocument,
  request: ReviewAnchorRequest,
  budget: ReviewAnchorBudget = createReviewAnchorBudget(),
): ReviewAnchorResolution {
  const body = doc.body
  if (body.trim().length === 0) {
    return fail(
      'review-anchor-empty-document',
      'the document has no body text to anchor a comment to',
    )
  }

  const section = request.section?.trim()
  const hasSection = section !== undefined && section.length > 0
  let quote = request.quote?.trim() ?? ''
  const occurrence = request.occurrence
  let documentLevelTarget: number | null = null

  if (quote.length === 0) {
    // Document-level comment: anchor to the title line (first heading with text,
    // else the first non-empty line). `occurrence` / `section` are rejected by the
    // wire schema when no quote is given, so they are ignored here by contract.
    const heading = doc.headings.find((h) => h.text.length > 0)
    if (heading !== undefined) {
      quote = heading.text
      documentLevelTarget = heading.textStart
    } else if (doc.firstNonEmptyLine !== null) {
      quote = body.slice(doc.firstNonEmptyLine.start, doc.firstNonEmptyLine.end)
      documentLevelTarget = doc.firstNonEmptyLine.start
    } else {
      return fail(
        'review-anchor-empty-document',
        'the document has no body text to anchor a comment to',
      )
    }
  }

  if (budget.remainingChars < body.length) {
    return fail(
      'review-anchor-budget-exceeded',
      'the scan budget for this request is exhausted; shorten the quotes or submit fewer comments',
    )
  }
  budget.remainingChars -= body.length

  // One scan: exact total, candidate collection (capped), target location.
  let total = 0
  let inFilterTotal = 0
  const candidates: ReviewAnchorCandidate[] = []
  const sectionPathsSeen = new Map<string, ReviewAnchorCandidate>()
  // Exact number of distinct sections the quote occurs under — `sectionPathsSeen`
  // is capped, and a capped list must say so (`total` / `truncated`).
  const sectionPathsAll = new Set<string>()
  // Holder object (not bare `let`s): the hits are assigned inside the scan
  // callback, and TypeScript's control-flow narrowing would otherwise pin the
  // bare locals to `null` after the call.
  const found: { firstInFilter: Hit | null; requested: Hit | null; documentLevelHit: Hit | null } =
    { firstInFilter: null, requested: null, documentLevelHit: null }

  forEachOccurrence(body, quote, (offset, index) => {
    total = index
    const sectionPath = sectionPathAt(doc, offset)
    const inSection = hasSection ? sectionMatches(sectionPath, section) : true
    if (hasSection) {
      sectionPathsAll.add(sectionPath)
      if (
        !sectionPathsSeen.has(sectionPath) &&
        sectionPathsSeen.size < REVIEW_ANCHOR_CANDIDATE_LIMIT
      ) {
        sectionPathsSeen.set(
          sectionPath,
          candidateAt(doc, offset, index, quote.length, sectionPath),
        )
      }
    }
    if (documentLevelTarget !== null) {
      if (offset === documentLevelTarget)
        found.documentLevelHit = { offset, index, sectionPath, inSection }
      return
    }
    if (occurrence !== undefined && index === occurrence) {
      found.requested = { offset, index, sectionPath, inSection }
    }
    if (inSection) {
      inFilterTotal += 1
      if (found.firstInFilter === null)
        found.firstInFilter = { offset, index, sectionPath, inSection }
      if (candidates.length < REVIEW_ANCHOR_CANDIDATE_LIMIT) {
        candidates.push(candidateAt(doc, offset, index, quote.length, sectionPath))
      }
    }
  })

  if (total === 0) {
    const affordable = chargeSuggestionScan(doc, budget) === 'charged'
    const suggestions = affordable ? suggestionsFor(doc, quote) : []
    const lines = [
      `quote not found in the document (matching is exact — copy it verbatim from the body)`,
    ]
    if (suggestions.length > 0) lines.push(describeSuggestions(suggestions), REDACTION_NOTE)
    if (!affordable) {
      lines.push('near-miss suggestions omitted: the scan budget for this request is exhausted')
    }
    return fail('review-anchor-not-found', lines.join('\n'), { suggestions })
  }

  let selected: Hit
  if (documentLevelTarget !== null) {
    const hit = found.documentLevelHit
    if (hit === null) {
      // The non-overlapping scan skipped the title offset because an earlier
      // occurrence overlapped it (only possible for self-overlapping titles);
      // count the non-overlapping occurrences that end at or before the title.
      let before = 0
      forEachOccurrence(body, quote, (offset) => {
        if (offset + quote.length <= documentLevelTarget!) {
          before += 1
          return true
        }
        return false
      })
      selected = {
        offset: documentLevelTarget,
        index: before + 1,
        sectionPath: sectionPathAt(doc, documentLevelTarget),
        inSection: true,
      }
    } else {
      selected = hit
    }
  } else if (occurrence !== undefined) {
    if (occurrence < 1 || occurrence > total) {
      return fail(
        'review-anchor-occurrence-out-of-range',
        `occurrence ${occurrence} is out of range: the quote occurs ${total} time(s) in the document`,
        {
          total,
          candidates: candidates.slice(0, REVIEW_ANCHOR_CANDIDATE_LIMIT),
          truncated: inFilterTotal > candidates.length,
        },
      )
    }
    const hit = found.requested
    if (hit === null) {
      // Unreachable: `total >= occurrence >= 1` means the scan visited that index.
      return fail(
        'review-anchor-occurrence-out-of-range',
        `occurrence ${occurrence} could not be located`,
      )
    }
    if (hasSection && !hit.inSection) {
      return fail(
        'review-anchor-occurrence-not-in-section',
        [
          `occurrence ${occurrence} is under "${hit.sectionPath.length > 0 ? hit.sectionPath : '(top)'}", not "${section}"; occurrences inside that section:`,
          describeCandidates(candidates, quote),
          REDACTION_NOTE,
        ].join('\n'),
        { candidates, total: inFilterTotal, truncated: inFilterTotal > candidates.length },
      )
    }
    selected = hit
  } else if (hasSection && inFilterTotal === 0) {
    const seen = [...sectionPathsSeen.values()]
    const sectionTotal = sectionPathsAll.size
    const truncated = sectionTotal > seen.length
    return fail(
      'review-anchor-section-not-found',
      [
        `no occurrence of the quote lies under section "${section}"; it occurs under ${sectionTotal} section(s)${truncated ? ` (showing the first ${seen.length})` : ''}:`,
        seen.map((c) => (c.sectionPath.length > 0 ? c.sectionPath : '(top)')).join('\n'),
      ].join('\n'),
      { candidates: seen, total: sectionTotal, truncated },
    )
  } else if (inFilterTotal === 1) {
    selected = found.firstInFilter!
  } else {
    return fail(
      'review-anchor-ambiguous',
      [
        `the quote occurs ${inFilterTotal} time(s)${hasSection ? ` under "${section}"` : ''}${inFilterTotal > candidates.length ? ` (showing the first ${candidates.length})` : ''}; pass \`occurrence\` (global number) or narrow with \`section\`:`,
        describeCandidates(candidates, quote),
        REDACTION_NOTE,
      ].join('\n'),
      { candidates, total: inFilterTotal, truncated: inFilterTotal > candidates.length },
    )
  }

  const start = selected.offset
  const end = start + quote.length
  if (crossesHeading(doc, start, end)) {
    return fail(
      'review-anchor-crosses-heading',
      'the quote spans a heading boundary; quote text from one section only',
      { total },
    )
  }

  const warnings: ReviewAnchorWarning[] = []
  if (intersectsSpan(doc.fences, start, end)) warnings.push('quote-in-code-block')
  const startBlock = lastStartLE(doc.blocks, start)
  const endBlock = lastStartLE(doc.blocks, end - 1)
  if (startBlock !== endBlock) warnings.push('quote-spans-blocks')
  if (fullyInsideSpan(doc.nonRendered, start, end))
    warnings.push('quote-has-no-rendered-projection')

  const ctx = contextsAround(body, start, end)
  return {
    ok: true,
    anchor: {
      sectionPath: selected.sectionPath,
      paragraphIdx: paragraphIdxAt(doc, start),
      offsetStart: start,
      offsetEnd: end,
      selectedText: quote,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
      occurrenceIndex: selected.index,
    },
    warnings,
  }
}
