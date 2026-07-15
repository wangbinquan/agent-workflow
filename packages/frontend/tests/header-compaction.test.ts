// 2026-06-24: shrink the review (single + multi-doc) and clarify detail
// headers so the body (doc / question form) claims the viewport. The headers
// stacked an <h1> + breadcrumbs + optional hint rows, each carrying the
// UA-default <h1>/<p> margins (~16–21px) with the heading at the UA-default
// ~32px. The compaction CSS collapses those margins to a --space token rhythm
// and drops the heading to a --font-* token (currently --font-lg, 16px),
// WITHOUT removing any row and WITHOUT
// touching the locked layout invariants (full-height flex column + internally
// scrolling body — see reviews-detail-layout / reviews-multidoc-viewport-fit).
//
// Source-level scans (styles.css text + the clarify root className), the same
// pattern reviews-detail-layout.test.ts uses for CSS rules. Locks that the
// compaction rules exist so a refactor that drops them — re-ballooning the
// header — fails here.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', 'src', p), 'utf8')
const CSS = read('styles.css')
const CLARIFY = read('routes/clarify.detail.tsx')

describe('review-detail header compaction', () => {
  test('PageHeader heading rows collapse their default block margins', () => {
    expect(CSS).toMatch(/\.review-detail__page-header \.page__heading > \*[^{]*\{[^}]*margin:\s*0/)
    expect(CSS).toMatch(/\.page__heading\s*\{[^}]*gap:\s*var\(--space/)
  })
  test('the heading is shrunk to a token font-size (not the UA-default ~32px)', () => {
    expect(CSS).toMatch(
      /\.review-detail__page-header \.page__title[^{]*\{[^}]*font-size:\s*var\(--font-[a-z]+\)/,
    )
  })
})

describe('multi-doc review header compaction', () => {
  test('the page__title heading is shrunk to a token font-size', () => {
    expect(CSS).toMatch(
      /\.review-multidoc > \.page__header \.page__title[^{]*\{[^}]*font-size:\s*var\(--font-[a-z]+\)/,
    )
  })
})

describe('clarify header compaction', () => {
  test('clarify page root opts into the compaction scope class', () => {
    expect(CLARIFY).toMatch(/className="page page--clarify-detail"/)
  })
  test('clarify header drops the default 24px bottom margin', () => {
    expect(CSS).toMatch(
      /\.page--clarify-detail > \.page__header\s*\{[^}]*margin-bottom:\s*var\(--space/,
    )
  })
  test('clarify header rows collapse margins + shrink the heading', () => {
    expect(CSS).toMatch(/\.page--clarify-detail > \.page__header > \*[^{]*\{[^}]*margin:\s*0/)
    expect(CSS).toMatch(
      /\.page--clarify-detail > \.page__header h1[^{]*\{[^}]*font-size:\s*var\(--font-[a-z]+\)/,
    )
  })
  test('clarify header no longer carries the back-to-/clarify-list link', () => {
    // User ask (2026-06-24): drop the "返回" back-to-list row entirely so the
    // header is even shorter — global nav + the task-name link cover navigation.
    expect(CLARIFY).not.toContain('clarify.detail.back')
  })
})

describe('compaction does not disturb the locked layout invariants', () => {
  test('review-detail stays a full-height, overflow-hidden flex column', () => {
    // (reviews-detail-layout.test.ts owns the full set; re-assert the two that
    // a careless gap/padding edit could regress.)
    expect(CSS).toMatch(/\.page--review-detail\s*\{[^}]*height:\s*100%/)
    expect(CSS).toMatch(/\.page--review-detail\s*\{[^}]*overflow:\s*hidden/)
  })
  test('multi-doc keeps its 12px content padding (viewport-fit lock)', () => {
    expect(CSS).toMatch(/\.content:has\(\.review-multidoc\)\s*\{[^}]*padding-top:\s*12px/)
  })
})
