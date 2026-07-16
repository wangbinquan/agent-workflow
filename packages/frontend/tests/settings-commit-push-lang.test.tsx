// RFC-157 — the commit-message output-language <select> in the "System agents"
// tab's commit-push card PATCHes `commitPushLang` on save. Mirrors
// settings-memory-distill-lang.test.tsx. Locks:
//   1. The card renders the select with the right testid + three options
//      (Default / English / 简体中文) and reflects config.commitPushLang.
//   2. Picking 'zh-CN' fires PUT /api/config with commitPushLang: 'zh-CN'.
//   3. Picking 'Default' sends commitPushLang: null (NOT undefined) so
//      mergePatch actually CLEARS a saved value — undefined would be dropped by
//      JSON.stringify and treated as "no change" (Codex design-gate P2-1). This
//      is the load-bearing difference from the pre-RFC-157 memoryDistillLang
//      select, which had the latent "Default can't clear zh-CN" bug.
// The other SystemAgentsTab slice keys are unset here → JSON.stringify drops
// them, so the PUT body carries only commitPushLang.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { SystemAgentsTab } from '../src/routes/settings'
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

function mockPut() {
  const calls: Array<{ method: string; body: unknown }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (s.includes('/api/config') && method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, body })
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
  setBaseUrl(`http://settings-commit-push-${crypto.randomUUID()}.test`)
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

// The lang picker is the shared <Select> (RFC-036): a role=combobox trigger
// (carrying the testid) + a portaled role=listbox. Open it and click the option
// whose rendered label matches the given i18n key.
function pickLang(labelKey: string) {
  act(() => {
    fireEvent.click(screen.getByTestId('settings-commit-push-lang-select'))
  })
  const listbox = screen.getByRole('listbox')
  act(() => {
    fireEvent.mouseDown(within(listbox).getByText(i18n.t(labelKey)))
  })
}

function clickSave() {
  const saveBtn = screen
    .getAllByRole('button')
    .find((b) => b.textContent && /保存|Save/.test(b.textContent))
  expect(saveBtn).toBeTruthy()
  act(() => {
    fireEvent.click(saveBtn!)
  })
}

describe('RFC-157 SystemAgentsTab — commit-push output language select', () => {
  test('renders three options and reflects current config value', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ commitPushLang: 'zh-CN' })} />, {
      wrapper: wrap(qc),
    })
    const sel = screen.getByTestId('settings-commit-push-lang-select')
    expect(sel.textContent).toContain(i18n.t('settings.commitPushLangZhCN'))
    act(() => {
      fireEvent.click(sel)
    })
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    expect(within(listbox).getByText(i18n.t('settings.commitPushLangDefault'))).toBeTruthy()
    expect(within(listbox).getByText(i18n.t('settings.commitPushLangEnUS'))).toBeTruthy()
    expect(within(listbox).getByText(i18n.t('settings.commitPushLangZhCN'))).toBeTruthy()
  })

  test('unset config (undefined) defaults the select to empty (Default)', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-commit-push-lang-select')
    expect(sel.textContent).toContain(i18n.t('settings.commitPushLangDefault'))
  })

  test('picking zh-CN and saving fires PUT /api/config with the new value', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    pickLang('settings.commitPushLangZhCN')
    expect(screen.getByTestId('settings-commit-push-lang-select').textContent).toContain(
      i18n.t('settings.commitPushLangZhCN'),
    )
    clickSave()
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    const body = calls[0]?.body as { commitPushLang?: string }
    expect(body.commitPushLang).toBe('zh-CN')
  })

  test('picking Default sends commitPushLang: null (clears a saved language)', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ commitPushLang: 'zh-CN' })} />, {
      wrapper: wrap(qc),
    })
    pickLang('settings.commitPushLangDefault')
    clickSave()
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    // STRICT: must be null on the wire (not undefined/absent). mergePatch only
    // DELETES on null; undefined is treated as "no change" and would leave the
    // stored zh-CN in place — the exact bug RFC-157 fixes (P2-1).
    const body = calls[0]?.body as Record<string, unknown>
    expect(body.commitPushLang).toBeNull()
  })

  test('i18n keys for commitPushLang label / options reachable in both locales', () => {
    void i18n.changeLanguage('zh-CN')
    expect(i18n.t('settings.commitPushLangLabel')).toBe('提交信息输出语言')
    expect(i18n.t('settings.commitPushLangDefault')).toContain('English')
    void i18n.changeLanguage('en-US')
    expect(i18n.t('settings.commitPushLangLabel')).toBe('Commit message output language')
    expect(i18n.t('settings.commitPushLangDefault')).toBe('Default (English)')
  })
})
