// Source-level guard for the shared <Dialog> scroll layout.
//
// Bug (reported 2026-06-06, Settings → Authentication → Add provider): on a
// tall form the Cancel / Save footer rendered BELOW the viewport because the
// whole `.dialog__panel` scrolled (overflow:auto) instead of the body. Users
// couldn't reach Cancel — clicking where they expected it just scrolled the
// panel, never closing the dialog.
//
// Fix: `.dialog__panel` clips (overflow:hidden) and `.dialog__body` is the
// scroll region (flex:1 + min-height:0 + overflow-y:auto), so the header and
// footer stay pinned and the action buttons are always reachable.
//
// happy-dom does no layout/scrolling, so this asserts the CSS contract at the
// source level — a future edit that reverts the panel to overflow:auto or
// drops the body's scroll properties turns this red.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// Strip CSS comments so prose like "(overflow:auto)" in an explanatory
// comment can't satisfy/break a property assertion.
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function rule(selector: string): string {
  const re = new RegExp(
    '^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
    'm',
  )
  const m = css.match(re)
  if (m === null || m[1] === undefined) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

describe('Dialog scroll layout', () => {
  test('.dialog__panel clips instead of scrolling as a whole', () => {
    const body = rule('.dialog__panel')
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).not.toMatch(/overflow:\s*auto/)
    // still a flex column so header/body/footer stack
    expect(body).toMatch(/flex-direction:\s*column/)
  })

  test('.dialog__body is the scroll region (can shrink + scrolls)', () => {
    const body = rule('.dialog__body')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/flex:\s*1/)
  })

  test('header and footer stay pinned (do not shrink/scroll away)', () => {
    expect(rule('.dialog__header')).toMatch(/flex-shrink:\s*0/)
    expect(rule('.dialog__footer')).toMatch(/flex-shrink:\s*0/)
  })
})
