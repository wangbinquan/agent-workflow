// RFC-025 T3 — AppearanceTab carries a language <select> and calls
// setLanguage after a successful save.
//
// Locks:
//   1. The tab renders both a theme select and a language select.
//   2. The language select reflects config.language.
//   3. Changing + saving fires PUT /api/config with the new language.
//   4. On successful save, i18n flips to the saved value.
//   5. On a failed save, i18n does NOT flip.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { AppearanceTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    language: 'zh-CN',
    theme: 'system',
    ...overrides,
  }
}

function mockPutOnce(opts: { fails?: boolean }) {
  const calls: Array<{ method: string; body: unknown }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (s.includes('/api/config') && method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, body })
        if (opts.fails) {
          return new Response(JSON.stringify({ code: 'boom', message: 'no' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify(mkConfig({ ...body })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return calls
}

beforeEach(() => {
  setBaseUrl(`http://settings-appearance-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

// The language picker is now the shared <Select> (RFC-036): a role=combobox
// trigger (carrying the testid) + a portaled role=listbox. Open it and click
// the option whose rendered label matches the given i18n key.
function pickLanguage(langLabelKey: string) {
  act(() => {
    fireEvent.click(screen.getByTestId('settings-language-select'))
  })
  const listbox = screen.getByRole('listbox')
  act(() => {
    fireEvent.mouseDown(within(listbox).getByText(i18n.t(langLabelKey)))
  })
}

describe('AppearanceTab language select', () => {
  test('renders both theme and language selects + reflects current language', () => {
    mockPutOnce({})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<AppearanceTab config={mkConfig({ language: 'en-US' })} />, { wrapper: wrap(qc) })
    const langSel = screen.getByTestId('settings-language-select')
    // Trigger shows the current language's label (was <select>.value).
    expect(langSel.textContent).toContain(i18n.t('settings.languageEnUS'))
    // theme select still present (sanity) — both are role=combobox triggers.
    const themes = screen.getAllByRole('combobox').filter((el) => el !== langSel)
    expect(themes.length).toBeGreaterThan(0)
  })

  test('changing the select updates local state', () => {
    mockPutOnce({})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<AppearanceTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const langSel = screen.getByTestId('settings-language-select')
    expect(langSel.textContent).toContain(i18n.t('settings.languageZhCN'))
    pickLanguage('settings.languageEnUS')
    expect(langSel.textContent).toContain(i18n.t('settings.languageEnUS'))
  })

  test('successful save fires PUT with language=en-US and flips i18n', async () => {
    const calls = mockPutOnce({})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<AppearanceTab config={mkConfig()} />, { wrapper: wrap(qc) })
    pickLanguage('settings.languageEnUS')
    const saveBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent && /保存|Save/.test(b.textContent))
    expect(saveBtn).toBeTruthy()
    act(() => {
      fireEvent.click(saveBtn!)
    })
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect((calls[0]?.body as { language?: string }).language).toBe('en-US')
    await waitFor(() => {
      expect(i18n.language).toBe('en-US')
    })
  })

  test('failed save does NOT flip i18n', async () => {
    mockPutOnce({ fails: true })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<AppearanceTab config={mkConfig()} />, { wrapper: wrap(qc) })
    pickLanguage('settings.languageEnUS')
    const saveBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent && /保存|Save/.test(b.textContent))
    act(() => {
      fireEvent.click(saveBtn!)
    })
    // Wait long enough for the failed PUT to settle.
    await new Promise((r) => setTimeout(r, 50))
    expect(i18n.language).toBe('zh-CN')
  })

  test('i18n keys for language label/hint are reachable in both locales', () => {
    void i18n.changeLanguage('zh-CN')
    expect(i18n.t('settings.languageLabel')).toBe('界面语言')
    void i18n.changeLanguage('en-US')
    expect(i18n.t('settings.languageLabel')).toBe('UI language')
  })
})
