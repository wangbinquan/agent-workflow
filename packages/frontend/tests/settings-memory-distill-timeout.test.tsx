// 记忆蒸馏超时旋钮（设置 → 系统代理 → 记忆蒸馏）。
//
// 用户 2026-09-21：「记忆提炼任务默认 120s 超时太短了，改成 1 小时超时，配置内可
// 修改默认值」。后端默认值与全链路接线锁在 backend 的
// memory-distill-timeout-config / -wiring 两个文件；这里锁**用户真正摸得到的那一面**：
//   1. 卡片里渲染出这个数字输入，并回显 config.memoryDistillTimeoutMs；
//   2. 改值 → 保存 → PUT /api/config 的 body 里确实带着这个键。
//      第 2 条不是形式主义：新旋钮漏登记 SETTINGS_CONFIG_SCOPE_KEYS 时，界面能改、
//      点保存**不报错**、值却在 PUT 前被剔掉（docs/dev-gotchas.md §前端，RFC-287/311
//      连踩 5 次）。只断言「控件渲染出来了」完全看不见这种坏。
//   3. 越界值走公共适配器的 aria-invalid + 范围提示（上限 6 小时是用户定的）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, SETTINGS_NUMERIC_BOUNDS, type Config } from '@agent-workflow/shared'
import { SystemAgentsTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

const TESTID = 'settings-memory-distill-timeout-input'
const ONE_HOUR_MS = 3_600_000

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, language: 'zh-CN', theme: 'system', ...overrides }
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
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
  return calls
}

function save() {
  const saveBtn = screen
    .getAllByRole('button')
    .find((b) => b.textContent !== null && /保存|Save/.test(b.textContent))
  expect(saveBtn).toBeTruthy()
  act(() => {
    fireEvent.click(saveBtn!)
  })
}

beforeEach(() => {
  setBaseUrl(`http://settings-distill-timeout-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('SystemAgentsTab — memory distill timeout knob', () => {
  test('renders the control and reflects the configured value', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ memoryDistillTimeoutMs: ONE_HOUR_MS })} />, {
      wrapper: wrap(qc),
    })
    const input = screen.getByTestId(TESTID) as HTMLInputElement
    expect(input.value).toBe(String(ONE_HOUR_MS))
  })

  test('the control advertises the shared bounds (30s – 6h)', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const input = screen.getByTestId(TESTID)
    const bound = SETTINGS_NUMERIC_BOUNDS.memoryDistillTimeoutMs
    expect(bound.max).toBe(21_600_000)
    expect(input.getAttribute('min')).toBe(String(bound.min))
    expect(input.getAttribute('max')).toBe(String(bound.max))
  })

  test('editing the value and saving PUTs memoryDistillTimeoutMs', async () => {
    const calls = mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig()} />, { wrapper: wrap(qc) })
    act(() => {
      fireEvent.change(screen.getByTestId(TESTID), { target: { value: '5400000' } })
    })
    save()
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    const body = calls[0]?.body as { memoryDistillTimeoutMs?: number }
    expect(body.memoryDistillTimeoutMs).toBe(5_400_000)
  })

  test('a value past the 6-hour ceiling is flagged invalid', () => {
    mockPut()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<SystemAgentsTab config={mkConfig({ memoryDistillTimeoutMs: ONE_HOUR_MS })} />, {
      wrapper: wrap(qc),
    })
    act(() => {
      fireEvent.change(screen.getByTestId(TESTID), { target: { value: '21600001' } })
    })
    expect(screen.getByTestId(TESTID).getAttribute('aria-invalid')).toBe('true')
  })

  test('label and hint resolve in both locales', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(i18n.t('settingsForm.memoryDistillTimeoutMs')).toBe('记忆蒸馏超时')
    expect(i18n.t('settingsForm.memoryDistillTimeoutMsHint')).toContain('3600000')
    await i18n.changeLanguage('en-US')
    expect(i18n.t('settingsForm.memoryDistillTimeoutMs')).toBe('Memory distill timeout')
    expect(i18n.t('settingsForm.memoryDistillTimeoutMsHint')).toContain('3600000')
    await i18n.changeLanguage('zh-CN')
  })
})
