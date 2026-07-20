// Locks the ROOT fix for the recurring "选中输入框时边框被切掉" bug family.
//
// Root cause: `outline` (and a non-inset spread `box-shadow`) always paints
// OUTSIDE the border box, and `overflow` clips descendants at the clipping
// ancestor's PADDING box. A `.form-input` is `width: 100%` by design, so it is
// flush against its scroll container BY CONSTRUCTION — every such container
// therefore ate the ring on whichever edge was flush. Worse, per the CSS
// overflow spec the two axes cannot be visible/non-visible independently, so
// any `overflow-y: auto` scroll region clips horizontally too.
//
// This was patched FOUR separate times, each covering only the axis that
// happened to be reported:
//   .dialog__body                    inline only  (styles.css, negative-margin trick)
//   .fuse-dialog .dialog__body       inline only  (RFC-101, redundant with the above)
//   .task-detail__pane>.workgroup-room  all 4     (workgroup composer)
//   .page--editor > .form-grid       inline only, and only 2px
// ...and it kept coming back on the unpatched axis: /repos → 批量导入 lost the
// TOP 2px (dialog body has padding-left/right but padding-top: 0), and
// /agents → 高级 lost LEFT + RIGHT (.split__detail-body has no padding at all).
//
// The fix inverts the mechanism instead of chasing containers: full-bleed form
// controls draw their ring INSIDE their own border box, which is structurally
// unclippable — any container, any axis, forever. Intrinsically-sized chrome
// (.btn, tabs, nav items) is NOT flush by construction and keeps the outset
// --focus-ring-offset, so containers that hold it still need a few px of room;
// that is why the patches above are kept rather than reverted.
//
// jsdom does no layout, so these are source-level assertions against styles.css
// (same ruleBody() idiom as dialog-body-focus-outline-clip.test.ts).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const rawCss = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

// Comments are stripped BEFORE any matching. Two reasons: prose must never be
// able to satisfy a "no outset ring" assertion, and several comments in this
// sheet quote CSS containing braces (`:root`'s --accent note quotes
// `.tabs__tab--active { … }`), which would otherwise terminate ruleBody()'s
// brace scan early and silently truncate the block under test.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the first rule whose selector contains `selector`. */
function ruleBody(selector: string): string {
  const idx = css.indexOf(selector)
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('focus ring — inset for full-bleed form controls', () => {
  it('declares --focus-ring-offset-inset as the negative of the ring width', () => {
    const root = ruleBody(':root {')
    expect(root).toMatch(/--focus-ring-offset-inset:\s*calc\(-1\s*\*\s*var\(--focus-ring-width\)\)/)
    // The outset token must survive — .btn and friends still use it.
    expect(root).toMatch(/--focus-ring-offset:\s*2px/)
  })

  it('.form-input:focus draws its ring inside its own border box', () => {
    const body = ruleBody('.form-input:focus {')
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
    // The old value is what let .dialog__body / .split__detail-body clip it.
    expect(body).not.toMatch(/outline-offset:\s*0/)
  })

  it('.user-picker chips row mirrors the standard input ring, inset included', () => {
    const body = ruleBody('.user-picker .chips-input__row:focus-within {')
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
  })

  // The box-shadow idiom is the same bug with a different property: a spread
  // shadow without `inset` paints outside the border box exactly like outline.
  it.each([
    ['.select__trigger:focus-visible', '.select__trigger:focus-visible,'],
    ['.clarify-custom-input:focus', '.clarify-custom-input:focus {'],
  ])('%s uses an inset box-shadow ring', (_label, selector) => {
    const body = ruleBody(selector)
    expect(body).toMatch(/box-shadow:\s*inset\s+0\s+0\s+0\s+2px/)
  })

  it('.split__detail-body — the scroll box itself — carries a gutter for OUTSET rings', () => {
    // This element IS the scroll box, so its padding is the only room its
    // children get. The .form-switch checkbox is flush at x=0 with a 4px outset
    // ring. The gutter lives here rather than on .agent-form__panel so the bare
    // consumers (/skills/new, /mcps/new, /plugins/new) get it too — they were
    // clipping precisely because the earlier fix was scoped to the agent form.
    const body = ruleBody('.split__detail-body {')
    expect(body).toMatch(/padding-inline:\s*var\(--focus-ring-gutter\)/)
    expect(body).toMatch(/padding-block-end:\s*var\(--focus-ring-gutter\)/)
  })

  it('declares --focus-ring-gutter >= the widest outset ring', () => {
    expect(ruleBody(':root {')).toMatch(/--focus-ring-gutter:\s*4px/)
  })

  it('tab strips and segmented bars use the inset ring (scroll-flush by construction)', () => {
    // .tabs and .page-filter are deliberately overflow-x:auto so long strips
    // can scroll, which puts their children exactly on the clip edge.
    const body = ruleBody(':where(.tabs__tab, .segmented__option):focus-visible {')
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
  })

  it('the workgroup member card stretch-overlay ring is inset', () => {
    // position:absolute; inset:0 inside an overflow:hidden .split-card — an
    // outset offset put the whole ring outside the clip box, i.e. NO visible
    // focus indicator at all for keyboard users.
    const body = ruleBody('.workgroup-card__open:focus-visible::after {')
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset-inset\)/)
  })
})

// Table-level guard (not file-level): the point is that NO scroll-flush control
// may reintroduce an outset ring, not that these specific rules are right. A new
// rule in this family with `outline-offset: 0` or a bare spread box-shadow reds
// this immediately.
describe('focus ring — no scroll-flush control may reintroduce an outset ring', () => {
  // Controls that sit on a clip edge BY CONSTRUCTION, so an outset ring is
  // always cut no matter which container they land in:
  //   * width:100% form controls inside a .form-field;
  //   * tab strips / segmented bars, whose rails (.tabs, .page-filter) are
  //     deliberately overflow-x:auto so long strips can scroll (RFC-206 T3).
  const SCROLL_FLUSH = [
    '.form-input',
    '.chips-input__row',
    '.multi-select__field',
    '.select__trigger',
    '.clarify-custom-input',
    '.select__search-input',
    '.tabs__tab',
    '.segmented__option',
  ]

  /**
   * Every rule in the sheet, MERGED BY SELECTOR. Merging is load-bearing:
   * `.form-input:focus` is authored twice (the base rule carries
   * outline-offset, a later token rule re-states `outline:`), and the cascade
   * unions them. Judging each block in isolation would flag the later one for
   * "outline without an inset offset" even though the effective value is inset.
   */
  function rulesBySelector(): Map<string, string> {
    const out = new Map<string, string>()
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(css))) {
      const sel = (m[1] ?? '').trim()
      out.set(sel, (out.get(sel) ?? '') + (m[2] ?? ''))
    }
    return out
  }

  const focusRules = [...rulesBySelector()].filter(
    ([sel]) => /:focus(-visible|-within)?\b/.test(sel) && SCROLL_FLUSH.some((c) => sel.includes(c)),
  )

  it('finds the form-control focus rules it is meant to police', () => {
    // Guard against the parser silently matching nothing and vacuously passing.
    expect(focusRules.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * LAST declaration of `prop`, i.e. the cascade winner.
   *
   * Load-bearing: `rulesBySelector` concatenates duplicate rule bodies in
   * document order, and `.form-input:focus` really is authored twice. Reading
   * the FIRST match would let someone append `outline-offset: 0` to the later
   * block — which is what the browser actually uses — while this guard stayed
   * green on the earlier inset value. (Codex design gate, P2.)
   */
  /**
   * Split a comma-separated CSS value into top-level layers, ignoring commas
   * nested inside function calls. A naive `/,(?![^(]*\))/` splits
   * `color-mix(in srgb, var(--accent) 20%, transparent)` into fragments —
   * the lookahead can't see past a nested `(`. Depth counting is the only
   * correct way.
   */
  function splitLayers(value: string): string[] {
    const out: string[] = []
    let depth = 0
    let cur = ''
    for (const ch of value) {
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
    if (cur.trim() !== '') out.push(cur)
    return out
  }

  function lastDecl(body: string, prop: string): string | undefined {
    const re = new RegExp(`${prop}:\\s*([^;]+)`, 'g')
    let last: string | undefined
    for (const m of body.matchAll(re)) last = m[1]?.trim()
    return last
  }

  it.each(focusRules)('%s paints no ring outside the border box', (_sel, body) => {
    const offset = lastDecl(body, 'outline-offset')
    const outline = lastDecl(body, 'outline')
    // A visible outline must be pulled inside; `outline: none` needs nothing.
    if (outline !== undefined && !/^none\b/.test(outline)) {
      expect(offset, `${_sel}: draws an outline but has no inset outline-offset`).toBeDefined()
      // The shared token is always correct. A literal negative is only
      // sufficient if it swallows the WHOLE outline — `outline: 2px` with
      // `outline-offset: -1px` still paints 1px outside and stays clippable.
      // (Codex design gate, P2.)
      if (offset !== undefined && !offset.includes('--focus-ring-offset-inset')) {
        const width = parseFloat(outline.match(/(-?[\d.]+)px/)?.[1] ?? 'NaN')
        const off = parseFloat(offset.match(/(-?[\d.]+)px/)?.[1] ?? 'NaN')
        expect(
          Number.isFinite(width) && Number.isFinite(off) && off <= -width,
          `${_sel}: outline-offset ${offset} does not fully inset a ${outline} ring — ` +
            `use var(--focus-ring-offset-inset) or an offset <= -${width}px`,
        ).toBe(true)
      }
    }
    // ANY non-inset box-shadow layer paints outside the border box and is
    // therefore clippable. Note this is NOT limited to 4-length "spread rings":
    // `box-shadow: 0 0 4px <color>` has three lengths but its BLUR still bleeds
    // outward. Rather than re-derive per-side extents here, we require every
    // layer on a full-bleed control's focus state to be `inset` — these
    // controls have no legitimate drop shadow. (Codex design gate, P2.)
    const shadow = lastDecl(body, 'box-shadow')
    if (shadow && shadow !== 'none') {
      for (const layer of splitLayers(shadow)) {
        expect(
          layer,
          `${_sel}: box-shadow layer "${layer.trim()}" is not inset — any outward ` +
            `offset/blur/spread paints outside the border box and can be clipped`,
        ).toMatch(/\binset\b/)
      }
    }
  })
})
