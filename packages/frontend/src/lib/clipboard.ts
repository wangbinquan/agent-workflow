// RFC-072 — copy text to the clipboard with a fallback for non-secure
// contexts. The daemon is commonly reached over plain http on a LAN IP, where
// `navigator.clipboard` is undefined; the old TaskOutputPanel called
// `navigator.clipboard.writeText(...)` unconditionally and threw a TypeError
// that was swallowed, so the Copy button silently did nothing. This helper
// tries the async Clipboard API first, then falls back to a hidden <textarea>
// + document.execCommand('copy'). The fallback is mounted inside the active
// modal dialog so its focus trap cannot steal the selection before copy runs.

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
  const focusBeforeCopy =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  const focusedDialog = focusBeforeCopy?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
  const openDialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  // Mouse clicks do not focus buttons on every browser (notably WebKit). If
  // activeElement is <body>, use the topmost modal: an outside action cannot be
  // interacted with while a modal is open, and keeping the textarea in that
  // panel prevents Dialog.tsx's focusin trap from yanking focus away.
  const mount = focusedDialog ?? openDialogs.item(openDialogs.length - 1) ?? document.body
  const ta = document.createElement('textarea')
  ta.value = text
  ta.readOnly = true
  ta.tabIndex = -1
  // Keep it out of view and out of layout flow while still selectable.
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  mount.appendChild(ta)
  let ok = false
  try {
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    // Restore the user's control before removing the focused textarea. This
    // avoids a transient focus escape to <body>, which would make the dialog
    // trap choose a different control and surprise keyboard users.
    if (focusBeforeCopy?.isConnected) {
      try {
        focusBeforeCopy.focus({ preventScroll: true })
      } catch {
        // Copy success must not be turned into failure by focus restoration.
      }
    }
    ta.remove()
  }
  return ok
}
