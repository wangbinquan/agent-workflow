// RFC-025 T2 — LanguageSwitch segmented control behavior.
//
// Locks:
//   1. Renders two role=radio options (zh-CN, en-US).
//   2. aria-checked tracks config.language.
//   3. Click on inactive option fires PUT /api/config + optimistic setLanguage.
//   4. PUT success caches the returned config into ['config'].
//   5. PUT failure rolls back to the previous language + renders an error line.
//   6. Click on the already-active option does NOT fire a PUT.
//   7. While mutation.isPending both buttons are disabled.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LanguageSwitch } from '../src/components/LanguageSwitch'
import i18n from '../src/i18n'
import { getConfigQueryKey } from '../src/lib/config-resource'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

interface MockOptions {
  getLanguage: 'zh-CN' | 'en-US'
  putFails?: boolean
  putDelayMs?: number
}

function mockFetch(opts: MockOptions): { calls: Array<{ method: string; body: unknown }> } {
  const calls: Array<{ method: string; body: unknown }> = []
  let persistedLanguage = opts.getLanguage
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (s.includes('/api/config') && method === 'GET') {
        return new Response(JSON.stringify({ ...DEFAULT_CONFIG, language: persistedLanguage }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (s.includes('/api/config') && method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, body })
        if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs))
        if (opts.putFails) {
          return new Response(JSON.stringify({ code: 'bad', message: 'boom' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        persistedLanguage = body.language
        return new Response(JSON.stringify({ ...DEFAULT_CONFIG, language: body.language }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
  return { calls }
}

beforeEach(() => {
  setBaseUrl(`http://language-switch-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  // Unsubscribe the live Config observer before rotating credentials and
  // restoring fetch, otherwise its invalidation can escape into real DNS.
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('LanguageSwitch', () => {
  test('renders two role=radio buttons keyed by language', async () => {
    mockFetch({ getLanguage: 'zh-CN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    await waitFor(() => {
      expect(screen.getAllByRole('radio')).toHaveLength(2)
    })
    const zh = screen.getByRole('radio', { name: '中' })
    const en = screen.getByRole('radio', { name: 'EN' })
    expect(zh.getAttribute('data-lang')).toBe('zh-CN')
    expect(en.getAttribute('data-lang')).toBe('en-US')
  })

  test('aria-checked reflects config.language (zh-CN active)', async () => {
    mockFetch({ getLanguage: 'zh-CN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const zh = await screen.findByRole('radio', { name: '中' })
    await waitFor(() => {
      expect(zh.getAttribute('aria-checked')).toBe('true')
    })
    const en = screen.getByRole('radio', { name: 'EN' })
    expect(en.getAttribute('aria-checked')).toBe('false')
  })

  test('aria-checked reflects config.language (en-US active)', async () => {
    mockFetch({ getLanguage: 'en-US' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    await waitFor(() => {
      const en = screen.getByRole('radio', { name: 'EN' })
      expect(en.getAttribute('aria-checked')).toBe('true')
    })
  })

  test('clicking inactive option fires PUT with only language + flips i18n optimistically', async () => {
    const { calls } = mockFetch({ getLanguage: 'zh-CN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const en = await screen.findByRole('radio', { name: 'EN' })
    await waitFor(() => expect(en.getAttribute('aria-checked')).toBe('false'))
    act(() => {
      fireEvent.click(en)
    })
    // Optimistic flip is synchronous (onMutate runs before fetch resolves).
    expect(i18n.language).toBe('en-US')
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.body).toEqual({ language: 'en-US' })
  })

  test('PUT success caches returned config — aria-checked moves to the new value', async () => {
    mockFetch({ getLanguage: 'zh-CN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const en = await screen.findByRole('radio', { name: 'EN' })
    await waitFor(() => expect(en.getAttribute('aria-checked')).toBe('false'))
    act(() => {
      fireEvent.click(en)
    })
    await waitFor(() => {
      expect(en.getAttribute('aria-checked')).toBe('true')
    })
    expect(qc.getQueryData(getConfigQueryKey())).toMatchObject({ language: 'en-US' })
  })

  test('PUT failure rolls back i18n + renders error line', async () => {
    mockFetch({ getLanguage: 'zh-CN', putFails: true })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const en = await screen.findByRole('radio', { name: 'EN' })
    await waitFor(() => expect(en.getAttribute('aria-checked')).toBe('false'))
    act(() => {
      fireEvent.click(en)
    })
    // Optimistic flip happens first.
    expect(i18n.language).toBe('en-US')
    // Wait for rollback after PUT error resolves.
    await waitFor(() => {
      expect(i18n.language).toBe('zh-CN')
    })
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  test('click on active option is a no-op (no PUT, no flip)', async () => {
    const { calls } = mockFetch({ getLanguage: 'zh-CN' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const zh = await screen.findByRole('radio', { name: '中' })
    await waitFor(() => expect(zh.getAttribute('aria-checked')).toBe('true'))
    act(() => {
      fireEvent.click(zh)
    })
    // Microtask drain — no PUT call should have been recorded.
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toHaveLength(0)
    expect(i18n.language).toBe('zh-CN')
  })

  test('both buttons disabled while mutation is pending', async () => {
    mockFetch({ getLanguage: 'zh-CN', putDelayMs: 50 })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<LanguageSwitch />, { wrapper: wrap(qc) })
    const en = await screen.findByRole('radio', { name: 'EN' })
    const zh = screen.getByRole('radio', { name: '中' })
    await waitFor(() => expect(en.getAttribute('aria-checked')).toBe('false'))
    act(() => {
      fireEvent.click(en)
    })
    // Right after click, mutation is pending and both buttons should be disabled.
    expect((en as HTMLButtonElement).disabled).toBe(true)
    expect((zh as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => {
      expect((en as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
