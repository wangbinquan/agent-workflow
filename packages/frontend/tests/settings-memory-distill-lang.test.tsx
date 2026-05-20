// RFC-050 — MemoryTab carries a distill-output-language <select> that PATCHes
// `memoryDistillLang` on save. Locks:
//   1. The tab renders the select with the right testid + three options
//      (Default / English / 简体中文) and reflects config.memoryDistillLang.
//   2. Picking 'Default' (empty value) sends `memoryDistillLang: undefined`
//      so the backend serialises it back to JSON omitted == null.
//   3. Picking 'zh-CN' fires PUT /api/config with the new value.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Config } from '@agent-workflow/shared'
import { MemoryTab } from '../src/routes/settings'
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
  document.body.innerHTML = ''
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-050 MemoryTab — distill output language select', () => {
  test('renders three options and reflects current config value', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig({ memoryDistillLang: 'zh-CN' })} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-memory-distill-lang-select') as HTMLSelectElement
    expect(sel.value).toBe('zh-CN')
    const opts = Array.from(sel.options).map((o) => o.value)
    expect(opts).toEqual(['', 'en-US', 'zh-CN'])
  })

  test('unset config (undefined) defaults the select to empty (Default)', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-memory-distill-lang-select') as HTMLSelectElement
    expect(sel.value).toBe('')
  })

  test('picking zh-CN and saving fires PUT /api/config with the new value', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-memory-distill-lang-select') as HTMLSelectElement
    act(() => {
      fireEvent.change(sel, { target: { value: 'zh-CN' } })
    })
    expect(sel.value).toBe('zh-CN')
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
    render(<MemoryTab config={mkConfig({ memoryDistillLang: 'zh-CN' })} />, { wrapper: wrap(qc) })
    const sel = screen.getByTestId('settings-memory-distill-lang-select') as HTMLSelectElement
    act(() => {
      fireEvent.change(sel, { target: { value: '' } })
    })
    expect(sel.value).toBe('')
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
