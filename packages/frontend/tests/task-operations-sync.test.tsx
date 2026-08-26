// /tasks 列表的实时同步契约。
//
// 这些用例锁的是 2026-08-26 的「任务列表一直在闪」修复：此前每一轮同步走
// `queryClient.resetQueries`——缓存被清回初始态，于是列表整屏换成 loading、
// VirtualList 连同滚动位置一起重挂、展开着的子分支全塌回 spinner。用户只要
// 有任务在跑就每 15 秒被打断一次。
//
// 现在每一帧都只做**保留数据的失效**（`invalidateQueries`，默认 refetchType
// 'active'）：旧行留在屏幕上，后台重取完成后原子替换。因此本文件的每条断言
// 都盯着同一件事——**没有任何一条路径可以再把缓存清空**。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let captured: ((message: unknown) => void) | null = null
let connection = { connected: true, connectionEpoch: 1 }

vi.mock('../src/hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (message: unknown) => void }) => {
    captured = onMessage
    return connection
  },
}))

import { useTaskOperationsSync } from '../src/hooks/useTaskOperationsSync'

const HOOK_SOURCE = resolve(import.meta.dirname, '..', 'src', 'hooks', 'useTaskOperationsSync.ts')

function wrapper(client: QueryClient): React.FC<{ children: React.ReactNode }> {
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useTaskOperationsSync — 就地同步，绝不清空缓存', () => {
  let client: QueryClient

  beforeEach(() => {
    captured = null
    connection = { connected: true, connectionEpoch: 1 }
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    client.clear()
    vi.useRealTimers()
  })

  test.each([
    ['task.created', { taskId: 't1' }],
    ['task.status', { taskId: 't1', status: 'done' }],
    ['task.deleted', { taskId: 't1' }],
    ['task.members.changed', { taskId: 't1' }],
    ['lifecycle.alert', { taskId: 't1', rule: 'r', severity: 'error', transition: 'new' }],
    ['lifecycle.alert.resolved', { taskId: 't1' }],
  ])('%s 触发保留数据的重取，而不是把列表清空重来', async (type, payload) => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const reset = vi.spyOn(client, 'resetQueries')
    renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })

    await act(async () => captured?.({ type, ...payload }))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task-operations'] })
    // refetchType:'none' 会让这一帧只置脏、不取数——那正是旧实现要靠 15 秒
    // 定时器补一次整表重建的原因。
    expect(
      invalidate.mock.calls.every((call) => call[0]?.refetchType === undefined),
      '失效带上了 refetchType ⇒ 这一帧没有真的去取数，界面要等别的机制补刷',
    ).toBe(true)
    expect(
      reset,
      'resetQueries 把缓存清回初始态 ⇒ 列表整屏 loading、滚动位置回顶、' +
        '展开的子分支全塌——这就是「任务列表一直在闪」的根因',
    ).not.toHaveBeenCalled()
  })

  test('一秒内连来多帧只合并成两次重取（首帧立即 + 尾沿一次）', async () => {
    vi.useFakeTimers()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })

    act(() => {
      captured?.({ type: 'task.status', taskId: 't1', status: 'running' })
      captured?.({ type: 'task.status', taskId: 't2', status: 'running' })
      captured?.({ type: 'task.status', taskId: 't3', status: 'done' })
    })
    expect(invalidate, '首帧没有立即生效 ⇒ 状态变化要等一整个窗口才上屏').toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(
      invalidate,
      '窗口内的后续帧没有被合并 ⇒ 多任务并发时每条状态帧都会拉一遍列表',
    ).toHaveBeenCalledTimes(2)
  })

  test('重连后补一次对账；首次建连不补（列表刚取过，再失效只会把它取消重来）', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    connection = { connected: false, connectionEpoch: 0 }
    const { rerender } = renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })

    connection = { connected: true, connectionEpoch: 1 }
    await act(async () => rerender())
    expect(invalidate, '首次建连就失效一次 ⇒ 每次打开列表页都白取一遍').not.toHaveBeenCalled()

    connection = { connected: false, connectionEpoch: 1 }
    await act(async () => rerender())
    connection = { connected: true, connectionEpoch: 2 }
    await act(async () => rerender())

    expect(
      invalidate,
      '断线期间错过的帧不会补发；重连后不对账 ⇒ 列表停在断线那一刻的旧状态',
    ).toHaveBeenCalledWith({ queryKey: ['task-operations'] })
  })

  test('断线时每 15 秒兜底重取一次，同样不清空缓存', async () => {
    vi.useFakeTimers()
    connection = { connected: false, connectionEpoch: 1 }
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const reset = vi.spyOn(client, 'resetQueries')
    renderHook(() => useTaskOperationsSync(), { wrapper: wrapper(client) })

    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(invalidate, 'WS 断了又不轮询 ⇒ 列表会一直停在旧数据上').toHaveBeenCalledWith({
      queryKey: ['task-operations'],
    })
    expect(reset, '兜底轮询把缓存清空 ⇒ 断线期间每 15 秒闪一次').not.toHaveBeenCalled()
  })

  test('源码层防线：这个 hook 里不许再出现 resetQueries', () => {
    // 上面的行为断言只能证明「当前这些路径」不清缓存；这条文本断言挡的是
    // 以后有人为了「刷得更干净」重新引入 resetQueries（RFC-244 §5.3 的原形态）。
    const source = readFileSync(HOOK_SOURCE, 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('resetQueries')
  })
})
