// RFC-025 T1 — useApplyLanguage hook behavior.
//
// Locks:
//   1. token = null → no /api/config fetch fires.
//   2. config.language matches i18n.language → no setLanguage call.
//   3. config.language differs → setLanguage gets called with the target.
//   4. config.language is an unsupported string → no setLanguage call.
//   5. <html lang> mirrors the resolved target.
//   6. Stable target across re-renders does not retrigger setLanguage.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { useApplyLanguage, isSupportedLanguage } from '../src/hooks/useLanguage'
import i18n, { setLanguage } from '../src/i18n'
import { clearToken, setBaseUrl, setToken } from '../src/stores/auth'

function HookHost() {
  useApplyLanguage()
  return null
}

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mockConfigOnce(language: unknown) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const s = typeof url === 'string' ? url : url.toString()
      calls.push(s)
      return new Response(JSON.stringify({ ...DEFAULT_CONFIG, language }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  // Reset i18next to a known start so cross-test ordering doesn't bleed.
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('lang')
  clearToken()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isSupportedLanguage', () => {
  test('accepts zh-CN and en-US, rejects anything else', () => {
    expect(isSupportedLanguage('zh-CN')).toBe(true)
    expect(isSupportedLanguage('en-US')).toBe(true)
    expect(isSupportedLanguage(null)).toBe(false)
    expect(isSupportedLanguage(undefined)).toBe(false)
    expect(isSupportedLanguage('ja-JP')).toBe(false)
  })
})

describe('useApplyLanguage', () => {
  test('skips the /api/config fetch when no auth token is set', async () => {
    clearToken()
    const calls = mockConfigOnce('en-US')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<HookHost />, { wrapper: wrap(qc) })
    // Wait one microtask + macrotask; the hook should not have triggered a fetch.
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(0)
    expect(i18n.language).toBe('zh-CN')
  })

  test('config.language matches current i18n.language → no setLanguage churn', async () => {
    setToken('tok')
    void i18n.changeLanguage('zh-CN')
    mockConfigOnce('zh-CN')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<HookHost />, { wrapper: wrap(qc) })
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('zh-CN')
    })
    expect(i18n.language).toBe('zh-CN')
  })

  test('config.language differs from i18n.language → setLanguage flips it', async () => {
    setToken('tok')
    void i18n.changeLanguage('zh-CN')
    mockConfigOnce('en-US')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<HookHost />, { wrapper: wrap(qc) })
    await waitFor(() => {
      expect(i18n.language).toBe('en-US')
    })
    expect(document.documentElement.lang).toBe('en-US')
  })

  test('unsupported config.language → no change to i18n or <html lang>', async () => {
    setToken('tok')
    void i18n.changeLanguage('zh-CN')
    mockConfigOnce('ja-JP')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<HookHost />, { wrapper: wrap(qc) })
    await new Promise((r) => setTimeout(r, 20))
    expect(i18n.language).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('')
  })

  test('stable target across re-renders does not retrigger setLanguage', async () => {
    setToken('tok')
    void i18n.changeLanguage('zh-CN')
    mockConfigOnce('en-US')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(<HookHost />, { wrapper: wrap(qc) })
    await waitFor(() => expect(i18n.language).toBe('en-US'))
    const spy = vi.spyOn(i18n, 'changeLanguage')
    rerender(<HookHost />)
    rerender(<HookHost />)
    expect(spy).not.toHaveBeenCalled()
  })

  test('setLanguage helper writes the value into i18n (sanity)', async () => {
    setLanguage('en-US')
    expect(i18n.language).toBe('en-US')
    setLanguage('zh-CN')
    expect(i18n.language).toBe('zh-CN')
  })
})
