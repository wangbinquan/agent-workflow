import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ObservationSpanDetail, ObservationTaskSpans } from '@agent-workflow/shared'
import ObservationTrace from '../src/components/observability/ObservationTrace'
import { validateObservationSearch } from '../src/routes/observability'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

beforeEach(async () => {
  setBaseUrl('http://localhost')
  setToken('fixture')
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setToken('')
})
const span = (key: string, complete = true): ObservationSpanDetail => ({
  fact: {
    schemaVersion: 1,
    invocationId: 'invocation',
    spanKey: key,
    scope: {
      sourceNamespace: 'source',
      rootSessionId: 'root',
      nativeSessionId: 'root',
      parentNativeSessionId: null,
      ancestors: [],
      callId: key,
      kind: 'model',
    },
    label: '实际模型',
    parentCallId: null,
    model: { provider: '供应商', id: '实际模型' },
    measurementRecordId: 'measurement',
    state: {
      startedAt: complete ? 1000 : null,
      endedAt: complete ? 2000 : null,
      nativeObservedAt: 2000,
      status: complete ? 'success' : 'unknown',
    },
    capturedAt: 2100,
  },
  durationMs: complete ? 1000 : null,
  quality: complete ? 'complete' : 'partial',
  reasons: complete ? [] : ['span-time-unknown'],
  usage: { input: '10', cacheRead: '20', cacheWrite: '3', output: '4' },
  cost: { currency: 'CNY', amountDecimal: '0.000123', completeness: 'complete' },
})
function fixture(initial?: string) {
  const paths: URL[] = [],
    changes: (string | undefined)[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input))
    paths.push(url)
    const page: ObservationTaskSpans = {
      taskId: 'task',
      nodeRunId: 'run',
      invocationId: null,
      spans: [span(url.searchParams.has('after') ? 'second' : 'first', false)],
      captures: [],
      priorRepairCount: 1,
      partial: true,
      reasons: ['span-capture-partial'],
      watermark: 2,
      nextCursor: url.searchParams.has('after') ? null : 'next-frame',
    }
    return Response.json(page)
  })
  function Page() {
    const [selected, change] = useState(initial)
    return (
      <ObservationTrace
        taskId="task"
        nodeRunId="run"
        selectedSpan={selected}
        onSelectSpan={(value) => {
          changes.push(value)
          change(value)
        }}
      />
    )
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  )
  return { paths, changes }
}
test('unknown native times show no full-attempt bar, while model details show four buckets and exact CNY', async () => {
  const f = fixture()
  const select = await screen.findByRole('button', { name: '模型 · 实际模型' })
  expect(select.querySelector('.execution-swimlane__bar')).toBeNull()
  fireEvent.click(select)
  const heading = await screen.findByRole('heading', { name: '模型 · 实际模型' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(screen.getByText('¥0.000123')).not.toBeNull()
  for (const name of ['非缓存输入', '缓存读取', '缓存写入', '输出'])
    expect(screen.getByText(name)).not.toBeNull()
  expect(f.changes).toEqual(['first'])
  fireEvent.click(screen.getByRole('button', { name: /返回片段/ }))
  expect(document.activeElement).toBe(select)
  expect(f.changes).toEqual(['first', undefined])
})
test('a restored span URL loads continuation in its original attempt scope and never adds export or extra filters', async () => {
  const f = fixture('second')
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '模型 · 实际模型' })),
  )
  expect(f.paths).toHaveLength(2)
  expect(f.paths.every((url) => url.searchParams.get('nodeRunId') === 'run')).toBe(true)
  expect(f.paths[1]!.searchParams.get('after')).toBe('next-frame')
  expect(screen.queryByText(/CSV|更多筛选/)).toBeNull()
  const originalRow = screen
    .getAllByRole('button', { name: '模型 · 实际模型' })
    .find((button) => button.dataset.executionId === 'second')!
  fireEvent.click(screen.getByRole('button', { name: /返回片段/ }))
  expect(document.activeElement).toBe(originalRow)
  expect(f.changes).toEqual([undefined])
  expect(validateObservationSearch({ task: 'task', attempt: 'run', span: 'second' })).toMatchObject(
    { task: 'task', attempt: 'run', span: 'second' },
  )
})
