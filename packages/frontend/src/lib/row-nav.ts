// RFC-192 (T1) — row-click navigation guard, shared by the /tasks and
// /scheduled tables.
//
// A whole-row click handler must NOT navigate when the click really belongs
// to something else: an inner interactive element (link / button / input /
// label), a modifier-key click (Cmd/Ctrl-click on the name link opens a new
// tab — the bubbled <tr> click would ALSO navigate the current tab, Codex
// 设计门 P2), a non-left button, or an event something already handled.
// `closest` white-listing replaces scattered stopPropagation calls — one
// guard, every inner control exempt by construction (design §4).

import type { MouseEvent as ReactMouseEvent } from 'react'

export function shouldRowNavigate(e: ReactMouseEvent): boolean {
  if (e.defaultPrevented || e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  const target = e.target
  if (!(target instanceof Element)) return true
  return target.closest('a, button, input, label, [role="button"]') === null
}
