// RFC-050 — the distill-output-language <select> PATCHes `memoryDistillLang` on
// save. RFC-156 relocated it from the (removed) Memory tab into the memory
// distiller card of the "System agents" tab (SystemAgentsTab); this test now
// mounts that tab. Locks:
//   1. The tab renders the select with the right testid + three options
//      (Default / English / 简体中文) and reflects config.memoryDistillLang.
//   2. Picking 'Default' (empty value) sends `memoryDistillLang: undefined`
//      so the backend serialises it back to JSON omitted == null.
//   3. Picking 'zh-CN' fires PUT /api/config with the new value.
// The other SystemAgentsTab slice keys are unset here → JSON.stringify drops
// them, so the PUT body still carries only memoryDistillLang.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Config } from '@agent-workflow/shared'
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
    $schema_version: 1,
    maxConcurrentNodes: 4,
    multiProcessSubprocessConcurrency: 4,
    defaultPerTaskMaxDurationMs: 3_600_000,
    defaultPerTaskMaxTotalTokens: 0,
    defaultPerNodeTimeoutMs: 1_800_000,
    worktreeAutoGc: { enabled: false },
    eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
    largeOutputThresholdBytes: 1_048_576,
    bindHost: '127.0.0.1',
    language: 'zh-CN',
    theme: 'system',
    logLevel: 'info',
    ...overrides,
  } as Config
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
  setBaseUrl('http://daemon.test')
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

// The distill-language picker is now the shared <Select> (RFC-036): a
// role=combobox trigger (carrying the testid) + a portaled role=listbox. Open
// it and click the option whose rendered label matches the given i18n key.
function pickLang(labelKey: string) {
  act(() => {
    fireEvent.click(screen.getByTestId('settings-memory-distill-lang-select'))
  })
  const listbox = screen.getByRole('listbox')
  act(() => {
    fireEvent.mouseDown(within(listbox).getByText(i18n.t(labelKey)))
  })
}

describe('RFC-050/156 SystemAgentsTab — distill output language select', () => {
  test('renders three options and reflects current config value', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ memoryDistillLang: 'zh-CN' })} />, {
      wrapper: wrap(qc),
    })
    const sel = screen.getByTestId('settings-memory-distill-lang-select')
    // Trigger reflects the current value's label (was <select>.value).
    expect(sel.textContent).toContain(i18n.t('settings.memoryDistillLangZhCN'))
    // Open and verify the three options (Default / English / 简体中文).
    act(() => {
      fireEvent.click(sel)
    })
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
    expect(within(listbox).getByText(i18n.t('settings.memoryDistillLangDefault'))).toBeTruthy()
    expect(within(listbox).getByText(i18n.t('settings.memoryDistillLangEnUS'))).toBeTruthy()
    expect(within(listbox).getByText(i18n.t('settings.memoryDistillLangZhCN'))).toBeTruthy()
  })

  test('unset config (undefined) defaults the select to empty (Default)', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-memory-distill-lang-select')
    expect(sel.textContent).toContain(i18n.t('settings.memoryDistillLangDefault'))
  })

  test('picking zh-CN and saving fires PUT /api/config with the new value', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    pickLang('settings.memoryDistillLangZhCN')
    expect(screen.getByTestId('settings-memory-distill-lang-select').textContent).toContain(
      i18n.t('settings.memoryDistillLangZhCN'),
    )
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
    const body = calls[0]?.body as { memoryDistillLang?: string }
    expect(body.memoryDistillLang).toBe('zh-CN')
  })

  test('picking Default (empty) saves with undefined → backend stores NULL', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ memoryDistillLang: 'zh-CN' })} />, {
      wrapper: wrap(qc),
    })
    pickLang('settings.memoryDistillLangDefault')
    const saveBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent && /保存|Save/.test(b.textContent))
    act(() => {
      fireEvent.click(saveBtn!)
    })
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    const body = calls[0]?.body as Record<string, unknown>
    // JSON.stringify omits undefined-valued keys → the PUT body either lacks
    // the key entirely or sends it explicitly as null. Either way the
    // backend lands the column as NULL (RFC-041 baseline preserved).
    if ('memoryDistillLang' in body) {
      expect(body.memoryDistillLang).toBeNull()
    } else {
      expect(body.memoryDistillLang).toBeUndefined()
    }
  })

  test('i18n keys for memoryDistillLang label / options reachable in both locales', () => {
    void i18n.changeLanguage('zh-CN')
    expect(i18n.t('settings.memoryDistillLangLabel')).toBe('记忆提炼输出语言')
    expect(i18n.t('settings.memoryDistillLangDefault')).toContain('English')
    void i18n.changeLanguage('en-US')
    expect(i18n.t('settings.memoryDistillLangLabel')).toBe('Memory distill output language')
    expect(i18n.t('settings.memoryDistillLangDefault')).toBe('Default (English)')
  })
})
