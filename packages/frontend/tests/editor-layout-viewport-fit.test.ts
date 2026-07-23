// Regression guard for the workflow editor "no overall page scrollbar"
// invariant. Two bugs collide here:
//
//   1. EditorSidebar renders each agent's description verbatim. A long
//      description used to grow the palette item indefinitely, dragging
//      the whole .editor-layout row taller than the viewport and pushing
//      a document-level scrollbar onto the user.
//   2. .app-shell historically used `min-height: 100vh` (not fixed), so
//      tall content scrolled at the window level instead of inside
//      .content. On the editor that meant the palette / canvas /
//      inspector all scrolled together as one giant page.
//
// JSDOM doesn't compute layout, so we pin the CSS contract at source so
// any future "let's reset these styles" cleanup keeps the page fitting
// the viewport. If you intentionally break one of these rules, update
// the assertion AND verify in a real browser that the editor still has
// per-panel scrollbars and no document-level one.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function ruleBody(selector: string): string {
  // Escape every regex metachar in the selector so we can match selectors
  // that include `:`, `(`, `)`, `.`, `-`, etc. — e.g. `.content:has(.page--editor)`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  const m = STYLES.match(re)
  if (m === null) throw new Error(`rule ${selector} not found in styles.css`)
  return m[1] ?? ''
}

describe('editor fits the viewport without a document scrollbar', () => {
  test('.app-shell is locked to viewport height with its own overflow:hidden', () => {
    const body = ruleBody('.app-shell')
    expect(body).toMatch(/height:\s*100vh/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('.content gets a bounded height so its overflow:auto can scroll', () => {
    const body = ruleBody('.content')
    expect(body).toMatch(/overflow:\s*auto/)
    expect(body).toMatch(/height:\s*100%/)
  })

  test('.page--editor fills the content area and hides its own overflow', () => {
    const body = ruleBody('.page--editor')
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('.editor-layout grid row can shrink (no 520px floor)', () => {
    const body = ruleBody('.editor-layout')
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).not.toMatch(/min-height:\s*520px/)
  })

  test('.canvas-frame default rule no longer pins a 520px floor', () => {
    const body = ruleBody('.canvas-frame')
    expect(body).not.toMatch(/min-height:\s*520px/)
  })

  test('.inspector default rule no longer pins a 520px floor', () => {
    const body = ruleBody('.inspector')
    expect(body).not.toMatch(/min-height:\s*520px/)
  })
})

describe('editor header is trimmed so the canvas owns the viewport', () => {
  // Browser defaults give h1 ~21px top+bottom margins and p ~14px. With the
  // page header + form-grid + .content padding stacked, the canvas used to
  // get only ~551px of an 817px viewport. These rules push it back to ~688px.
  test('.content padding shrinks on editor pages via :has()', () => {
    const body = ruleBody('.content:has(.page--editor)')
    expect(body).toMatch(/padding-top:\s*12px/)
    expect(body).toMatch(/padding-bottom:\s*12px/)
  })

  test('page header drops its 24px bottom margin inside the editor', () => {
    const body = ruleBody('.editor-page-header')
    expect(body).toMatch(/margin-bottom:\s*0/)
  })

  test('editor h1 strips browser default ~21px margins and shrinks to 18px', () => {
    const body = ruleBody('.editor-page-header h1')
    expect(body).toMatch(/font-size:\s*18px/)
    expect(body).toMatch(/margin:\s*0/)
  })

  test('editor .page__hint shrinks to 12px and drops the 14px default margin', () => {
    const body = ruleBody('.page--editor .page__hint')
    expect(body).toMatch(/font-size:\s*12px/)
    expect(body).toMatch(/margin:\s*2px 0 0/)
  })

  test('editor form-grid inputs use compact 4px/8px padding', () => {
    const body = ruleBody('.page--editor .form-grid .form-input')
    expect(body).toMatch(/padding:\s*4px 8px/)
  })

  // Locks in the fix for "name/description boxes look cut off at the page
  // edges": .page--editor has overflow:hidden, and the form inputs use
  // width:100%, so without an inline gutter on the row, the inputs sit
  // flush against the clip boundary. The 1px border crowds the edge and
  // the :focus 2px outline gets clipped on the outer side. A small
  // padding-inline on the top-level form-grid restores breathing room.
  test('editor top-level form-grid carries an inline gutter for focus outlines', () => {
    const body = ruleBody('.page--editor > .form-grid')
    expect(body).toMatch(/padding-inline:\s*2px/)
  })
})

describe('palette item description is clamped to 2 lines', () => {
  test('.editor-sidebar__item-hint declares the line-clamp box', () => {
    const body = ruleBody('.editor-sidebar__item-hint')
    expect(body).toMatch(/-webkit-line-clamp:\s*2/)
    expect(body).toMatch(/display:\s*-webkit-box/)
    expect(body).toMatch(/-webkit-box-orient:\s*vertical/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })
})

describe('RFC-219 categorized picker remains bounded inside the 240px rail', () => {
  test('picker and active tab panel may shrink while keeping their own scroll surface', () => {
    const picker = ruleBody('.workflow-node-picker')
    const panel = ruleBody('.workflow-node-picker__panel')
    const groups = ruleBody('.workflow-node-picker__groups')
    expect(picker).toMatch(/min-width:\s*0/)
    expect(picker).toMatch(/width:\s*100%/)
    expect(panel).toMatch(/min-width:\s*0/)
    expect(panel).toMatch(/min-height:\s*0/)
    expect(groups).toMatch(/overflow:\s*auto/)
  })

  test('long names ellipsize before the type chip or drag grip can overlap them', () => {
    const heading = ruleBody('.workflow-node-picker__item-heading .editor-sidebar__item-label')
    const chip = ruleBody('.workflow-node-picker__type-chip.chip--tight')
    expect(heading).toMatch(/min-width:\s*0/)
    expect(heading).toMatch(/overflow:\s*hidden/)
    expect(heading).toMatch(/text-overflow:\s*ellipsis/)
    expect(heading).toMatch(/white-space:\s*nowrap/)
    expect(chip).toMatch(/flex:\s*0 0 auto/)
  })

  test('every category has a non-default visual accent in addition to its text chip', () => {
    for (const category of ['agents', 'wrappers', 'io', 'human']) {
      const row = ruleBody(`.workflow-node-picker__item[data-category='${category}']`)
      const chip = ruleBody(`.workflow-node-picker__type-chip[data-category='${category}']`)
      expect(row).toMatch(/border-inline-start-width:\s*3px/)
      expect(row).toMatch(/border-inline-start-color:/)
      expect(chip).toMatch(/background:/)
      expect(chip).toMatch(/color:/)
    }
  })
})
