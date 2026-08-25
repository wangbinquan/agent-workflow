// RFC-326 T3 — the simplified-anchor resolver (modules/collaboration/domain/reviewAnchor.ts).
//
// Locks proposal AC-1…AC-8. If this goes red the "never guess" contract of the
// review gate's MCP / REST comment surface drifted: a wrong occurrence here lands
// in `review_comments.occurrence_index`, the re-run prompt cites the wrong place,
// and the web highlighter marks the wrong text.
//
// NOT under tests/architecture/ on purpose — every file there is a registered
// guard (census.ts:406-413); this is a unit test of a pure function.

import { describe, expect, test } from 'bun:test'

import {
  REVIEW_ANCHOR_CANDIDATE_LIMIT,
  REVIEW_ANCHOR_SUGGESTION_LIMIT,
  buildReviewAnchorDocument,
  createReviewAnchorBudget,
  paragraphIdxAt,
  resolveReviewAnchor,
  sectionPathAt,
} from '../src/modules/collaboration/public/queries'
import type {
  ReviewAnchorFailure,
  ReviewAnchorRequest,
  ReviewAnchorSuccess,
} from '../src/modules/collaboration/public/types'

const DOC = `# Order Service Design

Intro paragraph mentioning order_status once.

## Data Model

The \`order_status\` enum should include partially_refunded.

## Interfaces

\`POST /api/v1/orders/cancel\` returns 200 on success.
The \`order_status\` field is updated to canceled.

### POST endpoints

Second paragraph under POST endpoints with order_status again.

## Sequence

Step 3 calls PaymentSvc with the order_status payload.
`

function ok(body: string, request: ReviewAnchorRequest): ReviewAnchorSuccess {
  const result = resolveReviewAnchor(buildReviewAnchorDocument(body), request)
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

function bad(body: string, request: ReviewAnchorRequest): ReviewAnchorFailure {
  const result = resolveReviewAnchor(buildReviewAnchorDocument(body), request)
  if (result.ok) throw new Error(`expected failure, got anchor ${JSON.stringify(result.anchor)}`)
  return result
}

describe('AC-1 — a unique quote resolves to a complete composite anchor', () => {
  test('offsets are absolute source offsets and the contexts are 30 chars each side', () => {
    const { anchor, warnings } = ok(DOC, { quote: 'partially_refunded' })
    const start = DOC.indexOf('partially_refunded')
    expect(anchor).toEqual({
      sectionPath: '# Order Service Design > ## Data Model',
      paragraphIdx: 0,
      offsetStart: start,
      offsetEnd: start + 'partially_refunded'.length,
      selectedText: 'partially_refunded',
      contextBefore: DOC.slice(start - 30, start),
      contextAfter: DOC.slice(start + 18, start + 48),
      occurrenceIndex: 1,
    })
    expect(DOC.slice(anchor.offsetStart, anchor.offsetEnd)).toBe(anchor.selectedText)
    expect(warnings).toEqual([])
  })

  test('paragraphIdx counts the top-level paragraph / code / blockquote blocks after the nearest heading', () => {
    const { anchor } = ok(DOC, { quote: 'field is updated to canceled' })
    // "## Interfaces" → paragraph 0 holds the quote → idx 0; the second sentence is
    // in the same paragraph (no blank line), still 0.
    expect(anchor.paragraphIdx).toBe(0)
    const second = ok(DOC, { quote: 'Second paragraph under POST endpoints' })
    expect(second.anchor.sectionPath).toBe(
      '# Order Service Design > ## Interfaces > ### POST endpoints',
    )
    expect(second.anchor.paragraphIdx).toBe(0)
  })

  test('the quote is trimmed before matching', () => {
    const { anchor } = ok(DOC, { quote: '  partially_refunded\n' })
    expect(anchor.selectedText).toBe('partially_refunded')
  })
})

describe('AC-2 — ambiguity is an error with GLOBAL occurrence numbers, never a guess', () => {
  test('lists every occurrence with its section, offset and contexts', () => {
    const failure = bad(DOC, { quote: 'order_status' })
    expect(failure.code).toBe('review-anchor-ambiguous')
    expect(failure.total).toBe(5)
    expect(failure.truncated).toBe(false)
    expect(failure.candidates.map((c) => c.occurrence)).toEqual([1, 2, 3, 4, 5])
    expect(failure.candidates.map((c) => c.sectionPath)).toEqual([
      '# Order Service Design',
      '# Order Service Design > ## Data Model',
      '# Order Service Design > ## Interfaces',
      '# Order Service Design > ## Interfaces > ### POST endpoints',
      '# Order Service Design > ## Sequence',
    ])
    for (const c of failure.candidates) {
      expect(DOC.slice(c.offsetStart, c.offsetStart + 'order_status'.length)).toBe('order_status')
    }
    // Keys come first in the message so a redacted context cannot hide the locator.
    expect(failure.message).toContain('occurrence 3 · # Order Service Design > ## Interfaces · @')
    expect(failure.message).toContain('copy the quote verbatim')
  })

  test('`occurrence` selects the N-th global occurrence', () => {
    const { anchor } = ok(DOC, { quote: 'order_status', occurrence: 3 })
    expect(anchor.occurrenceIndex).toBe(3)
    expect(anchor.sectionPath).toBe('# Order Service Design > ## Interfaces')
    expect(anchor.offsetStart).toBe(
      DOC.indexOf('order_status', DOC.indexOf('order_status', DOC.indexOf('order_status') + 1) + 1),
    )
  })

  test('`occurrence` is validated even when the quote is unique', () => {
    const failure = bad(DOC, { quote: 'partially_refunded', occurrence: 2 })
    expect(failure.code).toBe('review-anchor-occurrence-out-of-range')
    expect(failure.total).toBe(1)
    expect(failure.message).toContain('occurs 1 time(s)')
  })

  test('occurrence 0 / negative is out of range too', () => {
    expect(bad(DOC, { quote: 'order_status', occurrence: 0 }).code).toBe(
      'review-anchor-occurrence-out-of-range',
    )
  })
})

describe('AC-3 — `section` filters or validates, in three spellings', () => {
  test('bare heading text narrows an ambiguous quote to one hit', () => {
    const { anchor } = ok(DOC, { quote: 'order_status', section: 'Sequence' })
    expect(anchor.occurrenceIndex).toBe(5)
    expect(anchor.sectionPath).toBe('# Order Service Design > ## Sequence')
  })

  test('a `#`-prefixed segment and the full breadcrumb both match', () => {
    expect(
      ok(DOC, { quote: 'order_status', section: '### POST endpoints' }).anchor.occurrenceIndex,
    ).toBe(4)
    expect(
      ok(DOC, {
        quote: 'order_status',
        section: '# Order Service Design > ## Interfaces > ### POST endpoints',
      }).anchor.occurrenceIndex,
    ).toBe(4)
  })

  test('a parent heading matches occurrences under its sub-sections and stays ambiguous', () => {
    const failure = bad(DOC, { quote: 'order_status', section: 'Interfaces' })
    expect(failure.code).toBe('review-anchor-ambiguous')
    expect(failure.candidates.map((c) => c.occurrence)).toEqual([3, 4])
    expect(failure.total).toBe(2)
  })

  test('no occurrence under the section → error listing the sections the quote lives in', () => {
    const failure = bad(DOC, { quote: 'partially_refunded', section: 'Sequence' })
    expect(failure.code).toBe('review-anchor-section-not-found')
    expect(failure.candidates.map((c) => c.sectionPath)).toEqual([
      '# Order Service Design > ## Data Model',
    ])
    expect(failure.message).toContain('## Data Model')
  })

  test('`occurrence` + `section` disagreeing is a distinct error that lists the in-section numbers', () => {
    const failure = bad(DOC, { quote: 'order_status', section: 'Sequence', occurrence: 2 })
    expect(failure.code).toBe('review-anchor-occurrence-not-in-section')
    expect(failure.candidates.map((c) => c.occurrence)).toEqual([5])
    expect(failure.message).toContain('occurrence 2 is under')
  })
})

describe('AC-4 — not found / crossing / empty', () => {
  test('a quote absent from the body is an error with structured near-miss suggestions', () => {
    // Case differs AND whitespace differs: only the folded search can find it.
    const failure = bad(DOC, { quote: 'ENUM   SHOULD include' })
    expect(failure.code).toBe('review-anchor-not-found')
    expect(failure.total).toBe(0)
    expect(failure.suggestions.length).toBeGreaterThan(0)
    const first = failure.suggestions[0]!
    expect(first).toEqual({
      sourceText: 'enum should include',
      offsetStart: DOC.indexOf('enum should include'),
      sectionPath: '# Order Service Design > ## Data Model',
    })
    expect(failure.message).toContain(`@${first.offsetStart}`)
    expect(failure.suggestions.length).toBeLessThanOrEqual(REVIEW_ANCHOR_SUGGESTION_LIMIT)
  })

  test('suggestions are capped and never auto-selected', () => {
    const failure = bad(DOC, { quote: 'ORDER_STATUS' })
    expect(failure.code).toBe('review-anchor-not-found')
    expect(failure.suggestions).toHaveLength(REVIEW_ANCHOR_SUGGESTION_LIMIT)
    expect(failure.candidates).toEqual([])
  })

  test('a quote that runs into the next heading is refused', () => {
    const failure = bad(DOC, { quote: 'once.\n\n## Data Model' })
    expect(failure.code).toBe('review-anchor-crosses-heading')
  })

  test('starting ON a heading line is fine', () => {
    const { anchor } = ok(DOC, { quote: '## Data Model\n\nThe' })
    expect(anchor.sectionPath).toBe('# Order Service Design > ## Data Model')
    expect(anchor.paragraphIdx).toBe(0)
  })

  test('an empty body is an error', () => {
    expect(bad('  \n\n', { quote: 'x' }).code).toBe('review-anchor-empty-document')
    expect(bad('', {}).code).toBe('review-anchor-empty-document')
  })
})

describe('AC-5 — document-level comments anchor to the title line', () => {
  test('the first ATX heading, with its source text (inline markup kept)', () => {
    const body = '# API `v2` **design**\n\nBody mentions API `v2` **design** again.\n'
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('API `v2` **design**')
    expect(anchor.offsetStart).toBe(2)
    expect(anchor.occurrenceIndex).toBe(1)
    expect(anchor.sectionPath).toBe('# API `v2` **design**')
    expect(anchor.paragraphIdx).toBe(0)
  })

  test('the occurrence number points at the heading even when the same text appears earlier', () => {
    const body = 'Preface says Design Doc first.\n\n# Design Doc\n\nBody.\n'
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('Design Doc')
    expect(anchor.occurrenceIndex).toBe(2)
    expect(anchor.offsetStart).toBe(body.indexOf('# Design Doc') + 2)
  })

  test('a Setext title counts as the first heading', () => {
    const body = 'Design Doc\n==========\n\n## Interfaces\n\ntext\n'
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('Design Doc')
    expect(anchor.offsetStart).toBe(0)
    expect(anchor.sectionPath).toBe('# Design Doc')
  })

  test('an empty ATX heading (`# #`) is skipped as the title but stays a section boundary', () => {
    const body = '# #\n\ntext\n\n## Real\n\nmore\n'
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('Real')
    expect(sectionPathAt(buildReviewAnchorDocument(body), body.indexOf('text'))).toBe('#')
  })

  test('with no heading at all, the first non-empty line is the title', () => {
    const body = '\n\n   plain first line   \nsecond line\n'
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('plain first line')
    expect(anchor.offsetStart).toBe(body.indexOf('plain'))
    expect(anchor.sectionPath).toBe('')
  })
})

describe('AC-6 — CommonMark subset: fences, ATX forms, blockquotes', () => {
  test('four-backtick fence wrapping a three-backtick example: the `#` inside is not a heading', () => {
    const body = [
      '````md',
      '```',
      '# Fake heading',
      '```',
      '````',
      '## Real heading',
      'text',
      '',
    ].join('\n')
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings.map((h) => h.text)).toEqual(['Real heading'])
    const { anchor, warnings } = ok(body, { quote: '# Fake heading' })
    expect(anchor.sectionPath).toBe('')
    expect(warnings).toEqual(['quote-in-code-block'])
    // Crossing the fake heading is NOT a heading crossing.
    expect(ok(body, { quote: '```\n# Fake heading\n```' }).warnings).toContain(
      'quote-in-code-block',
    )
  })

  test('`~~~` fences and unclosed fences extend to the end of the document', () => {
    const body = 'intro\n\n~~~\n# not a heading\n'
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings).toEqual([])
    expect(doc.fences).toEqual([{ start: body.indexOf('~~~'), end: body.length }])
  })

  test('ATX opening run must be 1–6 `#` followed by whitespace or EOL', () => {
    const body = 'before\n#######\nafter\n####### title\n###### six\n'
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings.map((h) => [h.level, h.text])).toEqual([[6, 'six']])
    // Seven hashes are paragraph text: quoting across them does not cross a heading.
    expect(ok(body, { quote: 'before\n#######\nafter' }).anchor.occurrenceIndex).toBe(1)
  })

  test('indentation ≤ 3, tab separator and trailing `#`s are accepted', () => {
    const body = '   ##\tSecurity ###\n\ntext\n'
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings.map((h) => [h.level, h.text])).toEqual([[2, 'Security']])
    expect(ok(body, { quote: 'text', section: 'Security' }).anchor.sectionPath).toBe('## Security')
  })

  test('a `#` line inside a blockquote is not a section heading (documented approximation)', () => {
    const body = '> ## Quoted\n> token\n\ntoken\n'
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings).toEqual([])
    expect(bad(body, { quote: 'token', section: 'Quoted' }).code).toBe(
      'review-anchor-section-not-found',
    )
  })

  test('heading detection and crossing detection share one scan: an indented heading is crossed', () => {
    const body = 'tail text\n  ## Next\nafter\n'
    expect(bad(body, { quote: 'tail text\n  ## Next' }).code).toBe('review-anchor-crosses-heading')
  })

  test('breadcrumb clears deeper levels when a shallower heading appears', () => {
    const body = '## A\n\n### A1\n\n## B\n\nunder b\n'
    expect(ok(body, { quote: 'under b' }).anchor.sectionPath).toBe('## B')
  })
})

describe('AC-7 — CRLF bodies', () => {
  test('offsets are computed on the original text and heading text carries no `\\r`', () => {
    const body = '# Title\r\n\r\nBody line one\r\ncontinues here\r\n'
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings[0]!.text).toBe('Title')
    const { anchor } = ok(body, {})
    expect(anchor.selectedText).toBe('Title')
    const quoted = ok(body, { quote: 'line one\r\ncontinues', section: 'Title' })
    expect(body.slice(quoted.anchor.offsetStart, quoted.anchor.offsetEnd)).toBe(
      'line one\r\ncontinues',
    )
    expect(quoted.anchor.sectionPath).toBe('# Title')
  })
})

describe('AC-8 — bounded: candidate caps never change resolution semantics', () => {
  const MANY = 'x '.repeat(1500) + '\n\n## Later\n\nx\n'

  test('a single-character quote on a large body: candidates capped, total exact, truncated', () => {
    const failure = bad(MANY, { quote: 'x' })
    expect(failure.code).toBe('review-anchor-ambiguous')
    expect(failure.total).toBe(1501)
    expect(failure.truncated).toBe(true)
    expect(failure.candidates).toHaveLength(REVIEW_ANCHOR_CANDIDATE_LIMIT)
    expect(failure.message).toContain('showing the first 50')
  })

  test('occurrence 1001 resolves although it lies beyond the candidate cap', () => {
    const { anchor } = ok(MANY, { quote: 'x', occurrence: 1001 })
    expect(anchor.occurrenceIndex).toBe(1001)
    expect(anchor.offsetStart).toBe(1000 * 2)
  })

  test('the unique in-section hit after 1500 earlier hits is found via `section`', () => {
    const { anchor } = ok(MANY, { quote: 'x', section: 'Later' })
    expect(anchor.occurrenceIndex).toBe(1501)
    expect(anchor.sectionPath).toBe('## Later')
  })

  test('one document model serves a whole batch; the budget charges body.length per resolve', () => {
    const doc = buildReviewAnchorDocument(DOC)
    const budget = createReviewAnchorBudget(DOC.length * 2 + 1)
    expect(resolveReviewAnchor(doc, { quote: 'partially_refunded' }, budget).ok).toBe(true)
    expect(resolveReviewAnchor(doc, { quote: 'PaymentSvc' }, budget).ok).toBe(true)
    const third = resolveReviewAnchor(doc, { quote: 'Intro' }, budget)
    expect(third.ok).toBe(false)
    expect((third as ReviewAnchorFailure).code).toBe('review-anchor-budget-exceeded')
  })

  test('a 1 MB body with a one-character quote resolves in one pass (mechanism, not wall clock)', () => {
    const big = 'a'.repeat(1024 * 1024)
    const failure = bad(big, { quote: 'a' })
    expect(failure.total).toBe(1024 * 1024)
    expect(failure.candidates).toHaveLength(REVIEW_ANCHOR_CANDIDATE_LIMIT)
    expect(ok(big, { quote: 'a', occurrence: 1024 * 1024 }).anchor.offsetStart).toBe(
      1024 * 1024 - 1,
    )
  })

  test('quotes with newlines, tabs and CJK inside tables, lists and blockquotes resolve', () => {
    const body = [
      '## 表格',
      '',
      '| 字段\t| 说明 |',
      '|---|---|',
      '| token | 待定 |',
      '',
      '- 列表项 一',
      '- 列表项 二',
      '',
      '> 引用 第一行',
      '> 引用 第二行',
      '',
    ].join('\n')
    expect(ok(body, { quote: '字段\t| 说明' }).anchor.sectionPath).toBe('## 表格')
    expect(ok(body, { quote: '列表项 一\n- 列表项 二' }).anchor.paragraphIdx).toBe(0)
    expect(ok(body, { quote: '第一行\n> 引用 第二行' }).anchor.paragraphIdx).toBe(0)
  })
})

describe('block model — paragraphIdx and warnings', () => {
  test('paragraphs, fences and blockquotes count; lists, tables, rules and html do not', () => {
    const body = [
      '## S',
      '',
      'p0',
      '',
      '- item',
      '',
      '| a |',
      '|---|',
      '',
      '---',
      '',
      '<div>html</div>',
      '',
      '```',
      'code',
      '```',
      '',
      '> quote',
      '',
      'target',
      '',
    ].join('\n')
    const doc = buildReviewAnchorDocument(body)
    // counted before target: p0, code, blockquote = 3
    expect(paragraphIdxAt(doc, body.indexOf('target'))).toBe(3)
    expect(paragraphIdxAt(doc, body.indexOf('item'))).toBe(1)
  })

  test('without any heading the very first block is not counted (frontend parity)', () => {
    const body = 'p1\n\np2\n\ntarget\n'
    expect(paragraphIdxAt(buildReviewAnchorDocument(body), body.indexOf('target'))).toBe(1)
  })

  test('a quote on a heading line has paragraphIdx 0', () => {
    const body = 'p\n\n## Head\n\nafter\n'
    expect(ok(body, { quote: 'Head' }).anchor.paragraphIdx).toBe(0)
  })

  test('warnings: spans blocks; no rendered projection for link destinations and HTML comments', () => {
    const body = 'para1\n\npara2 [visible](secret-dest) <!-- hidden order_status --> tail\n'
    expect(ok(body, { quote: 'para1\n\npara2' }).warnings).toEqual(['quote-spans-blocks'])
    expect(ok(body, { quote: 'secret-dest' }).warnings).toEqual([
      'quote-has-no-rendered-projection',
    ])
    expect(ok(body, { quote: 'hidden order_status' }).warnings).toEqual([
      'quote-has-no-rendered-projection',
    ])
    expect(ok(body, { quote: 'tail' }).warnings).toEqual([])
  })

  test('contexts are truncated at the document boundaries', () => {
    const body = 'short'
    const { anchor } = ok(body, { quote: 'short' })
    expect(anchor.contextBefore).toBe('')
    expect(anchor.contextAfter).toBe('')
  })
})

describe('RFC-326 impl-gate fixes — list-nested headings and the section-count cap', () => {
  test('a heading indented under a list item is NOT a document heading (breadcrumb + crossing)', () => {
    const body = [
      '# Top',
      '',
      '- item one',
      '  # inside the item',
      '  more of item one',
      '',
      'after the list',
      '',
    ].join('\n')
    const doc = buildReviewAnchorDocument(body)
    expect(doc.headings.map((h) => h.text)).toEqual(['Top'])
    expect(sectionPathAt(doc, body.indexOf('after the list'))).toBe('# Top')
    // The whole item (marker line + continuation) is ONE list block.
    const listBlocks = doc.blocks.filter((b) => b.kind === 'list')
    expect(listBlocks.length).toBe(1)
    expect(body.slice(listBlocks[0]!.start, listBlocks[0]!.end)).toBe(
      '- item one\n  # inside the item\n  more of item one',
    )
    // A quote spanning the nested `#` line is not "crossing a heading".
    const r = resolveReviewAnchor(doc, { quote: 'item one\n  # inside the item' })
    expect(r.ok).toBe(true)
    // A `#` at column 0 after a list item still ends the list and starts a heading.
    const lazy = buildReviewAnchorDocument('- item\n# Real heading\n\ntext\n')
    expect(lazy.headings.map((h) => h.text)).toEqual(['Real heading'])
  })

  test('section-not-found past the candidate cap reports the exact section total + truncated', () => {
    const sections = Array.from(
      { length: REVIEW_ANCHOR_CANDIDATE_LIMIT + 7 },
      (_, i) => `## S${i}\n\nneedle here\n`,
    )
    const doc = buildReviewAnchorDocument(`# Doc\n\n${sections.join('\n')}`)
    const r = resolveReviewAnchor(doc, { quote: 'needle', section: 'Nowhere' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('review-anchor-section-not-found')
    expect(r.total).toBe(REVIEW_ANCHOR_CANDIDATE_LIMIT + 7)
    expect(r.truncated).toBe(true)
    expect(r.candidates.length).toBe(REVIEW_ANCHOR_CANDIDATE_LIMIT)
    expect(r.message).toContain(`${REVIEW_ANCHOR_CANDIDATE_LIMIT + 7} section(s)`)
    // Under the cap the list is complete and says so.
    const small = resolveReviewAnchor(
      buildReviewAnchorDocument('# A\n\nneedle\n\n## B\n\nneedle\n'),
      {
        quote: 'needle',
        section: 'Nowhere',
      },
    )
    expect(small.ok).toBe(false)
    if (small.ok) return
    expect(small.total).toBe(2)
    expect(small.truncated).toBe(false)
  })
})

describe('RFC-326 AC-8 (impl gate) — every scan is metered, including the not-found suggestion passes', () => {
  const body = '# Doc\n\n' + 'lorem ipsum dolor sit amet, consectetur. '.repeat(7500) // ≈ 300 KiB

  test('exact scan, folded-index build and suggestion passes each charge the budget; degradation is ordered', () => {
    expect(body.length).toBeGreaterThan(290_000)
    const doc = buildReviewAnchorDocument(body)
    // Exactly: 5× (first miss) + 3× (second) + 1× (third: exact only) + ½× left.
    const limit = Math.floor(9.5 * body.length)
    const budget = createReviewAnchorBudget(limit)

    // First miss: exact scan (1×) + folded index build (2×) + suggestion passes (2×).
    const first = resolveReviewAnchor(doc, { quote: 'zzz-not-here' }, budget)
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.code).toBe('review-anchor-not-found')
    expect(first.message).not.toContain('suggestions omitted')
    expect(limit - budget.remainingChars).toBe(5 * body.length)

    // Second miss on the same document: the index is cached → 1× + 2×.
    resolveReviewAnchor(doc, { quote: 'zzz-not-here-either' }, budget)
    expect(limit - budget.remainingChars).toBe(8 * body.length)

    // Third miss: the exact scan is affordable, the suggestion passes are not →
    // not-found WITHOUT suggestions, and only 1× charged.
    const third = resolveReviewAnchor(doc, { quote: 'zzz-third' }, budget)
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.code).toBe('review-anchor-not-found')
    expect(third.suggestions).toEqual([])
    expect(third.message).toContain('suggestions omitted')
    expect(limit - budget.remainingChars).toBe(9 * body.length)

    // Fourth: not even the exact scan fits → refused, nothing charged.
    const fourth = resolveReviewAnchor(doc, { quote: 'zzz-fourth' }, budget)
    expect(fourth.ok).toBe(false)
    if (fourth.ok) return
    expect(fourth.code).toBe('review-anchor-budget-exceeded')
    expect(limit - budget.remainingChars).toBe(9 * body.length)
    expect(budget.remainingChars).toBeGreaterThanOrEqual(0)
  })

  test('default ceiling: 200 misses on a 300 KiB document stay under 64 MiB of scanning', () => {
    const doc = buildReviewAnchorDocument(body)
    const budget = createReviewAnchorBudget()
    const limit = budget.remainingChars
    let exceeded = 0
    for (let i = 0; i < 200; i++) {
      const r = resolveReviewAnchor(doc, { quote: `zzz-${i}` }, budget)
      expect(budget.remainingChars).toBeGreaterThanOrEqual(0)
      if (!r.ok && r.code === 'review-anchor-budget-exceeded') exceeded += 1
    }
    // Unmetered this would be ≈ 180 MiB of scanning (three passes per miss).
    expect(limit - budget.remainingChars).toBeLessThanOrEqual(limit)
    expect(exceeded).toBeGreaterThan(0)
  })
})
