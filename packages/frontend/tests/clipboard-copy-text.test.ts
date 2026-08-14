// RFC-072 — copyText: async Clipboard API with an execCommand fallback for
// non-secure contexts (daemon over plain http on a LAN IP, where
// navigator.clipboard is undefined). Regression for the silently-broken Copy
// button on the old Outputs tab.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { copyText } from '../src/lib/clipboard'

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true })
}

// jsdom does not implement document.execCommand, so define it as a mock the
// tests can control (vi.spyOn would throw "execCommand does not exist").
function setExecCommand(fn: (cmd: string) => boolean): ReturnType<typeof vi.fn> {
  const mock = vi.fn(fn)
  Object.defineProperty(document, 'execCommand', {
    value: mock,
    configurable: true,
    writable: true,
  })
  return mock
}

afterEach(() => {
  setClipboard(undefined)
  vi.restoreAllMocks()
})

describe('copyText', () => {
  test('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const ok = await copyText('hello')
    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  test('falls back to execCommand when clipboard is undefined', async () => {
    setClipboard(undefined)
    const exec = setExecCommand(() => true)
    const ok = await copyText('hello')
    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  test('falls back to execCommand when writeText rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const exec = setExecCommand(() => true)
    const ok = await copyText('hello')
    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  // Regression: Webhook/PAT one-time secrets are copied from inside Dialog.
  // On plain-http LAN deployments the execCommand fallback must stay inside
  // that dialog, otherwise its focus trap steals focus before the copy runs.
  test('keeps the insecure-context fallback inside the active dialog focus trap', async () => {
    setClipboard(undefined)
    const panel = document.createElement('div')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    const copyButton = document.createElement('button')
    panel.appendChild(copyButton)
    document.body.appendChild(panel)
    copyButton.focus()

    const keepFocusInside = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) copyButton.focus()
    }
    document.addEventListener('focusin', keepFocusInside)
    let copiedValue: string | null = null
    const exec = setExecCommand(() => {
      const active = document.activeElement
      if (!(active instanceof HTMLTextAreaElement) || !panel.contains(active)) return false
      copiedValue = active.value.slice(active.selectionStart, active.selectionEnd)
      return true
    })

    try {
      expect(await copyText('webhook-one-time-secret')).toBe(true)
      expect(exec).toHaveBeenCalledWith('copy')
      expect(copiedValue).toBe('webhook-one-time-secret')
      expect(document.activeElement).toBe(copyButton)
    } finally {
      document.removeEventListener('focusin', keepFocusInside)
      panel.remove()
    }
  })

  test('returns false when both paths fail', async () => {
    setClipboard(undefined)
    setExecCommand(() => false)
    expect(await copyText('hello')).toBe(false)
  })
})
