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

  test('returns false when both paths fail', async () => {
    setClipboard(undefined)
    setExecCommand(() => false)
    expect(await copyText('hello')).toBe(false)
  })
})
