// RFC-192 (T1) — shouldRowNavigate branch table (design §4).
//
// The guard is the single mechanism separating whole-row navigation from
// inner interactions: modifier clicks (Cmd-click a link = new tab, the
// current tab must NOT also navigate), non-left buttons, handled events and
// anything inside a/button/input/label/[role=button].

import { describe, expect, test } from 'vitest'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { shouldRowNavigate } from '../src/lib/row-nav'

function evt(overrides: Partial<ReactMouseEvent> & { targetHtml?: string } = {}): ReactMouseEvent {
  const host = document.createElement('tr')
  host.innerHTML = overrides.targetHtml ?? '<td><span data-t>plain</span></td>'
  const target = host.querySelector('[data-t]') ?? host
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
    target,
  } as unknown as ReactMouseEvent
}

describe('shouldRowNavigate', () => {
  test('plain left-click on non-interactive content → navigate', () => {
    expect(shouldRowNavigate(evt())).toBe(true)
  })

  test('modifier keys / non-left button / defaultPrevented → no navigation', () => {
    expect(shouldRowNavigate(evt({ metaKey: true }))).toBe(false)
    expect(shouldRowNavigate(evt({ ctrlKey: true }))).toBe(false)
    expect(shouldRowNavigate(evt({ shiftKey: true }))).toBe(false)
    expect(shouldRowNavigate(evt({ altKey: true }))).toBe(false)
    expect(shouldRowNavigate(evt({ button: 1 }))).toBe(false)
    expect(shouldRowNavigate(evt({ button: 2 }))).toBe(false)
    expect(shouldRowNavigate(evt({ defaultPrevented: true }))).toBe(false)
  })

  test('clicks inside interactive elements are exempt (closest whitelist)', () => {
    const cases = [
      '<td><a href="#"><span data-t>link text</span></a></td>',
      '<td><button type="button"><span data-t>btn</span></button></td>',
      '<td><label><input type="checkbox"><span data-t>switch</span></label></td>',
      '<td><div role="button"><span data-t>rb</span></div></td>',
    ]
    for (const html of cases) {
      expect(shouldRowNavigate(evt({ targetHtml: html })), html).toBe(false)
    }
  })
})
