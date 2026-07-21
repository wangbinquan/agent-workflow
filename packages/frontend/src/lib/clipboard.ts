// RFC-072 — copy text to the clipboard with a fallback for non-secure
// contexts. The daemon is commonly reached over plain http on a LAN IP, where
// `navigator.clipboard` is undefined; the old TaskOutputPanel called
// `navigator.clipboard.writeText(...)` unconditionally and threw a TypeError
// that was swallowed, so the Copy button silently did nothing. This helper
// tries the async Clipboard API first, then falls back to a hidden <textarea>
// + document.execCommand('copy').

/** Copy `text` to the clipboard. Returns whether the copy succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Async API present but rejected (permissions / non-secure) — fall back.
  }
  return execCommandCopy(text)
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  // Caution (2026-07-21 review): `ta.focus()` below synchronously triggers
  // Dialog.tsx's focus-trap focusin yank. Every current copyText caller sits
  // OUTSIDE dialogs; if you add one inside a Dialog, the trap steals focus
  // back before select() and this fallback likely copies nothing — verify on
  // an insecure http:// host (where the async Clipboard API is absent).
  const ta = document.createElement('textarea')
  ta.value = text
  // Keep it out of view and out of layout flow while still selectable.
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
