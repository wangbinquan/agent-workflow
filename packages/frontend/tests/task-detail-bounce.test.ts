// 2026-06-24: make the review decision flow match clarify (RFC-023 bugfix
// #8). After approve / iterate / reject the reviewer is bounced back to the
// owning task's detail page so they see the agent resume / rerun, instead of
// being stranded on the review page wondering whether anything happened —
// exactly the gap clarify already closed for its answer flow.
//
// These are source-level assertions (same pattern as
// reviews-detail-reject-rerun-fallback.test.ts) because all three surfaces
// are too heavy to mount under JSDOM. They lock that the three call sites all
// route through the shared goToTaskDetail helper (no fork / re-inline that
// could drift), so a refactor that drops the bounce — or re-hand-rolls it —
// goes red here. The helper's own behavior is covered by task-nav-helper.test.ts.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', 'src')
const CLARIFY = resolve(ROOT, 'routes', 'clarify.detail.tsx')
const REVIEW_SINGLE = resolve(ROOT, 'routes', 'reviews.detail.tsx')
const REVIEW_MULTI = resolve(ROOT, 'components', 'review', 'MultiDocReviewView.tsx')

function src(p: string): string {
  return readFileSync(p, 'utf8')
}

const IMPORT_RE = /import\s*\{\s*goToTaskDetail\s*\}\s*from\s*'@\/lib\/nav\/taskNav'/
const CALL_RE = /goToTaskDetail\(\s*qc\s*,\s*navigate\s*,\s*taskId\s*\)/

describe('task-detail bounce after clarify answer / review decision', () => {
  test('all three surfaces import the shared goToTaskDetail helper', () => {
    expect(src(CLARIFY)).toMatch(IMPORT_RE)
    expect(src(REVIEW_SINGLE)).toMatch(IMPORT_RE)
    expect(src(REVIEW_MULTI)).toMatch(IMPORT_RE)
  })

  test('all three surfaces call goToTaskDetail(qc, navigate, taskId)', () => {
    expect(src(CLARIFY)).toMatch(CALL_RE)
    expect(src(REVIEW_SINGLE)).toMatch(CALL_RE)
    expect(src(REVIEW_MULTI)).toMatch(CALL_RE)
  })

  test('both review decision handlers derive taskId from summary.taskId', () => {
    expect(src(REVIEW_SINGLE)).toMatch(/const\s+taskId\s*=\s*detail\.data\?\.summary\.taskId/)
    expect(src(REVIEW_MULTI)).toMatch(/const\s+taskId\s*=\s*detail\.data\?\.summary\.taskId/)
  })

  test('multi-doc review wires useNavigate (previously had no router import)', () => {
    const s = src(REVIEW_MULTI)
    // Allow other named imports alongside useNavigate — the header task-name
    // link later added `Link` to this same react-router import.
    expect(s).toMatch(/import\s*\{[^}]*\buseNavigate\b[^}]*\}\s*from\s*'@tanstack\/react-router'/)
    expect(s).toMatch(/const\s+navigate\s*=\s*useNavigate\(\)/)
  })

  test('clarify keeps its no-taskId fallback to the /clarify list', () => {
    // The bounce only fires when taskId is known; the cross-clarify
    // "designer-waiting" early-return and the /clarify fallback must survive
    // the migration to the shared helper.
    expect(src(CLARIFY)).toMatch(/void navigate\(\{\s*to:\s*'\/clarify'\s*\}\)/)
  })

  test('review decision handlers no longer re-inline the task query invalidation', () => {
    // The two ['tasks', id] / node-runs invalidations now live ONLY inside
    // goToTaskDetail; the review files must not hand-roll them again (that
    // re-fork is the drift this whole change removes).
    expect(src(REVIEW_SINGLE)).not.toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\['tasks',\s*taskId\]/,
    )
    expect(src(REVIEW_MULTI)).not.toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*\['tasks',\s*taskId\]/,
    )
  })
})
