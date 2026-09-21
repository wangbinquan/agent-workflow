// RFC-366 —— 执行结束记忆提炼的三组旋钮（设置 → 系统代理 → 记忆蒸馏）。
//
// 这里锁**用户真正摸得到的那一面**，判据与隔壁 `settings-memory-distill-timeout`
// 同款，因为踩的是同一个坑：新旋钮漏登记 `SETTINGS_CONFIG_SCOPE_KEYS` 时，界面能
// 改、点保存**不报错**、值却在 PUT 前被草稿层剔掉（docs/dev-gotchas.md §前端，
// RFC-287/311 连踩 5 次）。只断言「控件渲染出来了」完全看不见这种坏，所以每组旋钮
// 都断言到 PUT body。
//
// 另一条只有界面能证的：**白名单默认只勾 manual**。后端默认值有自己的单测，但
// 「用户打开设置页看到的是什么」是另一回事——回显读错键（比如把 undefined 当成
// 全不勾）会让人以为提炼被整个关掉了。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  DEFAULT_CONFIG,
  SETTINGS_NUMERIC_BOUNDS,
  TASK_LAUNCH_ORIGINS,
  type Config,
} from '@agent-workflow/shared'
import { SystemAgentsTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

const DEBOUNCE_TESTID = 'settings-memory-distill-agent-debounce-input'
const originTestid = (origin: string) => `settings-memory-distill-origin-${origin}`
const sourceTestid = (kind: string) => `settings-memory-distill-source-${kind}`

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, language: 'zh-CN', theme: 'system', ...overrides }
}

function mockPut() {
  const calls: Array<{ body: unknown }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      if (s.includes('/api/config') && (init?.method ?? 'GET') === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ body })
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

function renderTab(config: Config = mkConfig()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<SystemAgentsTab config={config} />, { wrapper: wrap(qc) })
}

beforeEach(() => {
  setBaseUrl(`http://rfc366-distill-policy-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-366 设置页 — 任务来源白名单', () => {
  test('五个来源各有一个开关，默认只勾 manual', () => {
    mockPut()
    renderTab()
    for (const origin of TASK_LAUNCH_ORIGINS) {
      const box = screen.getByTestId(originTestid(origin)) as HTMLInputElement
      expect(box.checked).toBe(origin === 'manual')
    }
  })

  test('回显已保存的白名单', () => {
    mockPut()
    renderTab(mkConfig({ memoryDistillLaunchOrigins: ['manual', 'scheduled'] }))
    expect((screen.getByTestId(originTestid('scheduled')) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId(originTestid('event')) as HTMLInputElement).checked).toBe(false)
  })

  test('勾上 scheduled 后保存，PUT body 带上完整白名单', async () => {
    const calls = mockPut()
    renderTab()
    act(() => {
      fireEvent.click(screen.getByTestId(originTestid('scheduled')))
    })
    save()
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = calls[0]?.body as { memoryDistillLaunchOrigins?: string[] }
    // 顺序跟着值域走，不跟着点击顺序走——否则两次等价的勾选会产生两份不同的配置。
    expect(body.memoryDistillLaunchOrigins).toEqual(['manual', 'scheduled'])
  })

  test('取消勾选 manual 后保存，PUT 的是空白名单而不是「没改」', async () => {
    const calls = mockPut()
    renderTab()
    act(() => {
      fireEvent.click(screen.getByTestId(originTestid('manual')))
    })
    save()
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = calls[0]?.body as { memoryDistillLaunchOrigins?: string[] }
    expect(body.memoryDistillLaunchOrigins).toEqual([])
  })
})

describe('RFC-366 设置页 — 逐源开关', () => {
  test('五类源各有一个开关，默认全开', () => {
    mockPut()
    renderTab()
    for (const kind of ['clarify', 'review', 'feedback', 'agent-run', 'task-run']) {
      expect((screen.getByTestId(sourceTestid(kind)) as HTMLInputElement).checked).toBe(true)
    }
  })

  test('关掉 agent-run 后保存，PUT body 用的是 camelCase 配置键', async () => {
    const calls = mockPut()
    renderTab()
    act(() => {
      fireEvent.click(screen.getByTestId(sourceTestid('agent-run')))
    })
    save()
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = calls[0]?.body as { memoryDistillSources?: Record<string, boolean> }
    // DB/wire 是 kebab、配置是 camelCase；映射写错就等于这个开关永远读不到。
    expect(body.memoryDistillSources?.agentRun).toBe(false)
  })

  test('回显已保存的开关（省略的键仍显示为开）', () => {
    mockPut()
    renderTab(mkConfig({ memoryDistillSources: { taskRun: false } }))
    expect((screen.getByTestId(sourceTestid('task-run')) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId(sourceTestid('clarify')) as HTMLInputElement).checked).toBe(true)
  })
})

describe('RFC-366 设置页 — agent 去抖窗口', () => {
  test('按公共适配器渲染，并带上共享的上下界', () => {
    mockPut()
    renderTab(mkConfig({ memoryDistillAgentRunDebounceMs: 60_000 }))
    const input = screen.getByTestId(DEBOUNCE_TESTID) as HTMLInputElement
    expect(input.value).toBe('60000')
    const bound = SETTINGS_NUMERIC_BOUNDS.memoryDistillAgentRunDebounceMs
    expect(input.getAttribute('min')).toBe(String(bound.min))
    expect(input.getAttribute('max')).toBe(String(bound.max))
  })

  test('改值保存后进 PUT body', async () => {
    const calls = mockPut()
    renderTab()
    act(() => {
      fireEvent.change(screen.getByTestId(DEBOUNCE_TESTID), { target: { value: '120000' } })
    })
    save()
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(
      (calls[0]?.body as { memoryDistillAgentRunDebounceMs?: number })
        .memoryDistillAgentRunDebounceMs,
    ).toBe(120_000)
  })

  test('超过 10 分钟上限的值被标记为非法', () => {
    mockPut()
    renderTab()
    act(() => {
      fireEvent.change(screen.getByTestId(DEBOUNCE_TESTID), { target: { value: '600001' } })
    })
    expect(screen.getByTestId(DEBOUNCE_TESTID).getAttribute('aria-invalid')).toBe('true')
  })
})

describe('RFC-366 设置页 — 文案双语可解析', () => {
  test('三组旋钮的 label / hint 在中英文下都有真正的译文', async () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(lang)
      for (const key of [
        'settingsForm.memoryDistillOriginsLabel',
        'settingsForm.memoryDistillOriginsHint',
        'settingsForm.memoryDistillSourcesLabel',
        'settingsForm.memoryDistillSourcesHint',
        'settingsForm.memoryDistillAgentRunDebounceMs',
        'settingsForm.memoryDistillAgentRunDebounceMsHint',
        'memory.sourceKind.agent-run',
        'memory.sourceKind.task-run',
      ]) {
        // i18next 缺键时原样回吐 key —— 不比一下就看不出来。
        expect(i18n.t(key)).not.toBe(key)
      }
      for (const origin of TASK_LAUNCH_ORIGINS) {
        expect(i18n.t(`settingsForm.memoryDistillOrigin.${origin}`)).not.toBe(
          `settingsForm.memoryDistillOrigin.${origin}`,
        )
      }
    }
    await i18n.changeLanguage('zh-CN')
  })
})
