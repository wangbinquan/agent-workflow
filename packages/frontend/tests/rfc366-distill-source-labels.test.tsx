// RFC-366 —— 蒸馏队列的来源列与来源筛选。
//
// 两件只有界面能证的事：
//   1. 两类新来源在表里渲染成**人话**而不是原始字面值。表格用的是
//      `t(\`memory.sourceKind.${job.sourceKind}\`)`——i18n 缺键时 i18next 原样回吐
//      key，于是格子里会出现 "memory.sourceKind.agent-run"，而这既不报错也不红。
//   2. 筛选真的过滤。它是纯客户端过滤（这张表一次拉全量），所以没有后端用例兜底。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DISTILL_SOURCE_KINDS, type MemoryDistillJob } from '@agent-workflow/shared'
import { MemoryDistillJobsTable } from '../src/components/memory/MemoryDistillJobsTable'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function job(overrides: Partial<MemoryDistillJob> = {}): MemoryDistillJob {
  return {
    id: `job-${overrides.sourceKind ?? 'x'}`,
    debounceKey: 'k',
    sourceKind: 'clarify',
    sourceEventId: 'evt',
    taskId: 't-1',
    scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
    status: 'done',
    attempts: 0,
    nextRunAt: 0,
    lastError: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as MemoryDistillJob
}

const ROWS = DISTILL_SOURCE_KINDS.map((kind) => job({ sourceKind: kind }))

function mockList(items: MemoryDistillJob[] = ROWS) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes('/api/memory-distill-jobs')) {
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

/** 打开筛选下拉并点中一个选项（Select 是自带 popover 的公共组件，非原生 select）。 */
async function pick(optionLabel: string): Promise<void> {
  act(() => {
    fireEvent.click(screen.getByTestId('memory-distill-source-filter'))
  })
  const option = await screen.findByRole('option', { name: optionLabel })
  // Select 的选项提交走 mousedown（组件刻意如此：click 会先让焦点离开触发器）。
  act(() => {
    fireEvent.mouseDown(option)
  })
}

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryDistillJobsTable />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl(`http://rfc366-distill-labels-${crypto.randomUUID()}.test`)
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-366 蒸馏队列 — 来源标签', () => {
  test('五类来源都渲染成译文，没有裸 key 漏出来', async () => {
    mockList()
    renderTable()
    await waitFor(() => {
      expect(screen.getByTestId('memory-distill-jobs')).toBeTruthy()
    })
    const text = screen.getByTestId('memory-distill-jobs').textContent ?? ''
    for (const kind of DISTILL_SOURCE_KINDS) {
      expect(text).toContain(i18n.t(`memory.sourceKind.${kind}`))
      // i18next 缺键会原样回吐 key —— 直接断言它没出现在页面上。
      expect(text).not.toContain(`memory.sourceKind.${kind}`)
    }
  })

  test('两类新来源在中英文下都有真正的译文', async () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(lang)
      for (const kind of ['agent-run', 'task-run'] as const) {
        expect(i18n.t(`memory.sourceKind.${kind}`)).not.toBe(`memory.sourceKind.${kind}`)
        expect(i18n.t(`memory.candidate.source.${kind}`)).not.toBe(
          `memory.candidate.source.${kind}`,
        )
      }
      expect(i18n.t('memory.distillJobs.sourceFilterAll')).not.toBe(
        'memory.distillJobs.sourceFilterAll',
      )
    }
    await i18n.changeLanguage('zh-CN')
  })
})

describe('RFC-366 蒸馏队列 — 来源筛选', () => {
  test('默认显示全部来源的行', async () => {
    mockList()
    renderTable()
    await waitFor(() => {
      expect(screen.getByTestId('distill-job-row-job-agent-run')).toBeTruthy()
    })
    for (const kind of DISTILL_SOURCE_KINDS) {
      expect(screen.getByTestId(`distill-job-row-job-${kind}`)).toBeTruthy()
    }
  })

  test('选中 agent 结束后只剩那一行', async () => {
    mockList()
    renderTable()
    await waitFor(() => {
      expect(screen.getByTestId('memory-distill-source-filter')).toBeTruthy()
    })
    await pick(i18n.t('memory.sourceKind.agent-run'))
    await waitFor(() => {
      expect(screen.queryByTestId('distill-job-row-job-clarify')).toBeNull()
    })
    expect(screen.getByTestId('distill-job-row-job-agent-run')).toBeTruthy()
  })

  test('筛到空集时给空状态，而不是一张只有表头的空表', async () => {
    mockList([job({ sourceKind: 'clarify' })])
    renderTable()
    await waitFor(() => {
      expect(screen.getByTestId('memory-distill-source-filter')).toBeTruthy()
    })
    await pick(i18n.t('memory.sourceKind.task-run'))
    await waitFor(() => {
      expect(screen.getByText(i18n.t('memory.distillJobs.empty'))).toBeTruthy()
    })
  })
})
