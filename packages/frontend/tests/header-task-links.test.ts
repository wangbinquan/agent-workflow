// 2026-06-24: the review (single + multi-doc) and clarify detail headers now
// link the task name straight to the owning task detail page (/tasks/$id),
// rendered with the `.link` accent style. Two follow-up constraints from the
// user shaped the final form:
//   1. it must READ as a link (accent colour). `.link` was referenced all over
//      the app (clarify/reviews lists, memory back-links, these headers) but
//      never actually DEFINED in CSS — combined with the global `a { color:
//      inherit; text-decoration: none }` reset, those links rendered as plain
//      inherited text. We define `.link` now, which fixes them app-wide.
//   2. the headers must stay compact (don't eat the body/content space). So the
//      link is the task name ALREADY shown in the H1, NOT an extra row; the
//      single-doc review keeps its leading task name, the multi-doc review
//      gains a leading task name, and clarify's old standalone muted "Task:
//      name" row was REMOVED (its data-testid folded onto the H1 link, still
//      pinned by clarify-baseline-source-locks.test.ts).
//
// Source-level scans (the routed components are awkward to mount in happy-dom);
// CSS rule presence is asserted on the stylesheet text the same way.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', 'src', p), 'utf8')

const CSS = read('styles.css')
const REVIEW_SINGLE = read('routes/reviews.detail.tsx')
const REVIEW_MULTI = read('components/review/MultiDocReviewView.tsx')
const CLARIFY = read('routes/clarify.detail.tsx')

describe('.link finally gets a real link style (was referenced but undefined)', () => {
  test('styles.css defines a .link rule coloured with the accent token', () => {
    expect(CSS).toMatch(/\.link\s*\{[^}]*color:\s*var\(--accent\)/)
  })
  test('.link has a hover affordance (underline) so it reads as clickable', () => {
    expect(CSS).toMatch(/\.link:hover\s*\{[^}]*text-decoration:\s*underline/)
  })
})

describe('review + clarify headers link the task name to /tasks/$id', () => {
  test('single-doc review H1 links the task name with the .link style', () => {
    // The H1 region is everything before the breadcrumbs line that follows it.
    const head = REVIEW_SINGLE.split('review-detail__breadcrumbs')[0] ?? ''
    expect(head).toMatch(/to="\/tasks\/\$id"/)
    expect(head).toMatch(/params=\{\{ id: data\.summary\.taskId \}\}/)
    expect(head).toContain('data-testid="review-detail-task-link"')
    expect(head).toMatch(/className="link"/)
  })

  test('multi-doc review H1 links the task name with the .link style', () => {
    // The header (title + task link) sits before the awaiting-decision actions.
    const head = REVIEW_MULTI.split('page__actions')[0] ?? ''
    expect(head).toMatch(/to="\/tasks\/\$id"/)
    expect(head).toMatch(/params=\{\{ id: detail\.data\.summary\.taskId \}\}/)
    expect(head).toContain('data-testid="review-multidoc-task-link"')
    expect(head).toMatch(/className="link"/)
  })

  test('clarify H1 links the task name with the .link style', () => {
    // The H1 is before the context-card hint paragraph.
    const head = CLARIFY.split('clarify-context-card')[0] ?? ''
    expect(head).toMatch(/to="\/tasks\/\$id"/)
    expect(head).toContain('data-testid="clarify-detail-task-name"')
    expect(head).toMatch(/className="link"/)
  })
})

describe('headers stay compact — the link reuses the H1, no extra row', () => {
  test('clarify dropped the standalone muted "Task: name" row', () => {
    // Old row: <div className="muted">{t('clarify.taskNameLabel')}: {name}</div>.
    // It must be gone (folded into the H1 link) so the header is a row shorter.
    expect(CLARIFY).not.toMatch(/t\('clarify\.taskNameLabel'\)\}: \{taskQuery\.data\.name\}/)
  })

  test('the task link sits inside the H1, not in a new block below it', () => {
    // For single review + clarify the /tasks/$id link appears before the first
    // post-H1 landmark, proving it is part of the heading rather than an added
    // row underneath it.
    expect(REVIEW_SINGLE.indexOf('to="/tasks/$id"')).toBeLessThan(
      REVIEW_SINGLE.indexOf('review-detail__breadcrumbs'),
    )
    expect(CLARIFY.indexOf('to="/tasks/$id"')).toBeLessThan(CLARIFY.indexOf('clarify-context-card'))
  })
})
