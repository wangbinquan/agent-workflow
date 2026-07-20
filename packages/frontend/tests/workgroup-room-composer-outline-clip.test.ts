// Locks the fix for the workgroup task execution page's "选中时左框线 + 下框线被
// 切掉" bug — the chatroom composer's <textarea class="form-input"> :focus
// outline (2px, outline-offset:0, painted on the border edge; styles.css ~3090)
// being clipped on its LEFT and BOTTOM edges.
//
// Root cause: the composer textarea is the left grid column's control and the
// last child of .workgroup-room__main, so it sits flush against the left and
// bottom edges of its scroll container .task-detail__pane — which is
// `overflow: auto` with NO padding of its own (styles.css ~7260). overflow:auto
// clips at the padding box, so those two outline edges get cut. Right/top are
// fine (the send button and the message log provide gaps there), which is why
// only left + bottom show the clip.
//
// This is the same bug class as .dialog__body (dialog-body-focus-outline-clip
// .test.ts), but the dialog's negative-margin trick relies on the parent panel
// carrying horizontal padding for the margin to borrow from. The pane has no
// padding, so the fix plainly insets the whole room a few px via padding on the
// room root; box-sizing:border-box keeps the grid flush to the pane while the
// composer's outline now paints inside the clip box.
//
// jsdom does no layout, so — like the dialog test — these are source-level
// assertions against styles.css: we lock the declarations that make the fix
// work, plus the preconditions (pane overflow, form-input outline) that make
// the bug possible in the first place, so a refactor that removes the inset or
// re-flushes the composer turns this red with a legible reason.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// fileURLToPath(import.meta.url) + path.resolve is the repo idiom (see
// dialog-body-focus-outline-clip.test.ts); `new URL('../…', import.meta.url)`
// then fileURLToPath() throws "URL must be of scheme file" under this setup.
const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

function ruleBody(selector: string): string {
  const idx = css.indexOf(selector)
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('workgroup room composer focus-outline clip', () => {
  it('insets the room so the composer input :focus outline is not clipped by the pane', () => {
    // The whole fix: give the room padding so the flush composer textarea (and
    // its left/bottom outline) no longer touches the pane's clip edge. Must be
    // >= the 2px outline; 4px matches the .dialog__body precedent.
    expect(ruleBody('.task-detail__pane > .workgroup-room {')).toMatch(/padding:\s*4px/)
  })

  it('keeps the room bounded to the pane (height + min-height) so the inset stays flush', () => {
    const body = ruleBody('.task-detail__pane > .workgroup-room {')
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  it('documents the precondition: the pane is an overflow scroll box (what does the clipping)', () => {
    expect(ruleBody('.task-detail__pane {')).toMatch(/overflow:\s*auto/)
  })

  // Superseded: this used to assert `outline-offset: 0` as "the precondition
  // that makes the bug possible". That precondition is now gone — .form-input's
  // ring moved INSIDE the border box (--focus-ring-offset-inset), so no overflow
  // ancestor can clip it on any axis. See focus-ring-inset.test.ts for the root
  // fix. The inset above is deliberately KEPT rather than reverted: controls
  // that still use an OUTSET ring (.btn and friends, 2px width + 2px offset =
  // 4px outside) can also sit flush in this pane, and the 4px inset is exactly
  // what keeps their ring paintable.
  it('documents that .form-input:focus now paints its ring INSIDE the border box', () => {
    const body = ruleBody('.form-input:focus {')
    expect(body).toMatch(/outline:\s*2px\s+solid/)
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
    expect(body).not.toMatch(/outline-offset:\s*0/)
  })
})
