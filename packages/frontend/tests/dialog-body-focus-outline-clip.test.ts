// Locks the SHARED root fix for the recurring "弹窗输入框选中时左右被盖住 / 黑边"
// bug — a full-width .form-input's 2px :focus outline (outline-offset:0) being
// clipped on its left/right edges by .dialog__body.
//
// Root cause: .dialog__body sets overflow-y:auto to be the scroll region; per
// the CSS overflow spec the two axes can't be visible/non-visible
// independently, so overflow-x computes to `auto` too and clips the outline
// horizontally. First reported on the runtime add/edit dialog (RuntimeFormDialog
// in RuntimeList.tsx) — which, like most dialogs, uses the bare .dialog__panel
// with NO panelClassName, so it never inherited RFC-101's `.fuse-dialog`-scoped
// patch (styles.css ~8992). That scoped-only fix is exactly why the bug kept
// reappearing on every new dialog.
//
// The fix lifts the horizontal inset onto the shared .dialog__body so EVERY
// dialog (current and future) gets outline room without a per-dialog patch. The
// negative margin cancels the padding so content edges don't visibly indent.
// These are source-level assertions against styles.css — jsdom does no layout,
// so we lock the declarations that make the fix work. Same ruleBody() shape as
// dialog-scroll-layout.test.ts.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Resolve via fileURLToPath(import.meta.url) + path.resolve — the repo's working
// idiom (see dialog-scroll-layout.test.ts). Building `new URL('../…', import.meta.url)`
// then fileURLToPath() throws "URL must be of scheme file" under this vitest setup.
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

// Match the standalone shared rule at the start of a line. Scoped rules such
// as `.inbox-dialog .dialog__body {` may appear earlier in the stylesheet.
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idx = css.search(new RegExp(`^${escaped}\\s*$`, 'm'))
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('dialog body focus-outline clip — shared root fix', () => {
  it('keeps overflow-y:auto (the precondition that makes overflow-x clip)', () => {
    expect(ruleBody('.dialog__body {')).toMatch(/overflow-y:\s*auto/)
  })

  it('insets the scroll box horizontally so a full-width input :focus outline is not clipped', () => {
    const body = ruleBody('.dialog__body {')
    // Padding gives the 2px outline room inside the scroll box...
    expect(body).toMatch(/padding-left:\s*4px/)
    expect(body).toMatch(/padding-right:\s*4px/)
    // ...and the negative margin gives that 4px back, so content edges stay
    // aligned with the pinned header/footer (no 4px indent regression).
    expect(body).toMatch(/margin-left:\s*-4px/)
    expect(body).toMatch(/margin-right:\s*-4px/)
  })

  it('can shrink (min-width:0) so a wide child cannot push it past the fixed-width panel', () => {
    expect(ruleBody('.dialog__body {')).toMatch(/min-width:\s*0/)
  })
})
