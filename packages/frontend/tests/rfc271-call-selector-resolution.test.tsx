// RFC-271 T6e（决策 28）—— 前端 call-workflow 解析器的**解析优先级**。
//
// 这条与后端 `rfc271-call-selector-resolution.test.ts` 是同一条规则的两半：编辑器
// 推端口用的解析器必须和启动冻结（`services/execution/closure.ts`）逐条同构，否则
// 画布上看到的子工作流端口，和任务真正会执行的那个不是同一个。
//
// 改判记录：`useWorkflowRefResolver` 原本写死 **name 优先**，注释理由是
// 「rename + recreate 不得被 stale id 静默重绑」。那个担心是对的，但代价是同名
// 两个 call 节点无论各自 hint 谁都被推成同一份端口。决策 28 用**名字守卫**
// （id 命中且该行仍带这个名字才采信）同时保住理由、修掉代价——③ 就是守卫本身的锁。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import {
  useWorkflowRefResolver,
  WORKFLOWS_QUERY_KEY,
} from '../src/components/canvas/useWorkflowRefResolver'
import { setBaseUrl, setToken } from '../src/stores/auth'

const defWith = (inputKey: string): WorkflowDefinition =>
  ({
    $schema_version: 1,
    inputs: [{ kind: 'text', key: inputKey, label: inputKey }],
    nodes: [],
    edges: [],
  }) as unknown as WorkflowDefinition

const row = (id: string, name: string, inputKey: string): Workflow =>
  ({
    id,
    name,
    description: '',
    definition: defWith(inputKey),
    version: 1,
    schemaVersion: 4,
    createdAt: 0,
    updatedAt: 0,
  }) as Workflow

/** 列表顺序 = 后端顺序；名字回退取首个同名行，所以 W1 排在前面。 */
const W1 = row('01AAAAAAAAAAAAAAAAAAAAAAAA', 'audit', 'topic')
const W2 = row('01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'audit', 'subject')
const RENAMED_W2 = row('01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'renamed-audit', 'subject')

/**
 * 预置 `['workflows']` 缓存而不是等一次网络往返：hook 的初始 state 就同步读
 * `getQueryData`，于是断言不需要任何 `waitFor` 轮询。
 * （`docs/audit-backlog.md` 里那一族 flaky 全是「轮询式 waitFor 等一个跨 turn 的
 * React commit」——能不产生这个等待面就别产生。）
 */
function mountResolver(rows: Workflow[]) {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData([...WORKFLOWS_QUERY_KEY], rows)
  return renderHook(() => useWorkflowRefResolver(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

const firstInputKey = (defn: WorkflowDefinition | 'forbidden' | null): string | null =>
  defn === null || defn === 'forbidden'
    ? null
    : ((defn.inputs[0] as unknown as { key?: string })?.key ?? null)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useWorkflowRefResolver —— 决策 28 的解析优先级', () => {
  test('① 同名双 id：各自的 id hint 各自生效，不塌成一份', async () => {
    const { result } = mountResolver([W1, W2])
    const resolve = result.current.workflowByRef
    expect(firstInputKey(resolve({ name: 'audit', id: W1.id }))).toBe('topic')
    expect(firstInputKey(resolve({ name: 'audit', id: W2.id }))).toBe('subject')
  })

  test('② 无 id hint ⇒ 回退名字规则（列表首个同名行）', async () => {
    const { result } = mountResolver([W1, W2])
    expect(firstInputKey(result.current.workflowByRef({ name: 'audit' }))).toBe('topic')
  })

  test('③ 名字守卫：hint 指向的行已改名 ⇒ hint 作废、回退名字规则', async () => {
    const { result } = mountResolver([W1, RENAMED_W2])
    // 节点里存的 id 是 stale cache（那行现在叫 renamed-audit）——绝不能静默重绑过去。
    expect(firstInputKey(result.current.workflowByRef({ name: 'audit', id: RENAMED_W2.id }))).toBe(
      'topic',
    )
  })

  test('④ 只给 id（选择器没有名字）时按 id 直取——守卫无名可比', async () => {
    const { result } = mountResolver([W1, RENAMED_W2])
    expect(firstInputKey(result.current.workflowByRef({ id: RENAMED_W2.id }))).toBe('subject')
  })

  test('⑤ 空选择器 / 查无此行 ⇒ null（画布退回边推导端口，不猜）', async () => {
    const { result } = mountResolver([W1])
    expect(result.current.workflowByRef({})).toBeNull()
    expect(result.current.workflowByRef({ name: 'ghost' })).toBeNull()
    expect(result.current.workflowByRef({ id: 'nope' })).toBeNull()
  })
})
