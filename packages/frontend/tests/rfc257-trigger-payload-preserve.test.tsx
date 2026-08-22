// RFC-268 实现门 P1（2026-08-09）翻出的 RFC-257 存量数据丢失，这里锁住修复：
//
// 触发器向导只渲染 launch payload 的一小部分（workflow=inputs / agent=description /
// workgroup=goal + 执行空间），但 payload schema 允许更多合法键——agent 的端口
// `inputs` 与 `allowClarify`、三种 kind 共有的 `maxDurationMs` / `maxTotalTokens`、
// 事件仓的 `workingBranch` / `autoCommitPush`。早期 `payloadOf` 是「按 kind 重新拼
// 一个 payload」，于是只要有人在界面上改一下名字保存，这些只能经 API 设置的字段
// 就被后端整体覆盖掉：带端口模板的 agent 触发器会**丢掉全部端口值**，资源上限会
// 无声消失。修复后 UI 只覆盖它真正拥有的键，其余从行里原样带回。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const ENDPOINT = {
  id: 'ep1',
  name: 'Internal GitLab',
  provider: 'gitlab',
  urlToken: 'aw_whk_tok1',
  enabled: true,
  preferredCloneProtocol: 'http',
  hasSecret: true,
  secretHint: 'ab12',
  lastDeliveryAt: null,
  createdAt: 1,
  updatedAt: 1,
  ingressUrl: 'https://aw.example.com/webhooks/gitlab/aw_whk_tok1',
}

function triggerRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'tr1',
    ownerUserId: 'u1',
    endpointId: 'ep1',
    name: '修到绿',
    enabled: true,
    repoScope: { kind: 'prefix', prefix: 'platform/' },
    eventTypes: ['mr_opened'],
    branchFilter: null,
    commandPrefix: null,
    ignoreUsernames: [],
    launchKind: 'workflow',
    launchRefId: 'wf1',
    launchPayload: { inputs: {} },
    migrationError: null,
    maxConsecutiveFires: 3,
    autoRegisterRepos: true,
    lastFiredAt: null,
    lastStatus: null,
    lastError: null,
    lastTaskId: null,
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

let rows: Array<Record<string, unknown>> = []
let writes: Array<Record<string, unknown>> = []

async function renderWebhooks() {
  const mod = await import('../src/routes/webhooks')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const hosted = createRoute({
    getParentRoute: () => rootRoute,
    path: '/webhooks',
    validateSearch: mod.validateWebhooksSearch,
    component: mod.Route.options.component!,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([hosted]),
    history: createMemoryHistory({ initialEntries: ['/webhooks?tab=triggers'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

/** 打开既有触发器的编辑向导，改名后停在原地。 */
async function editAndRename(name: string) {
  fireEvent.click(await screen.findByTestId('webhook-trigger-edit-tr1'))
  await screen.findByTestId('webhook-trigger-step-scope')
  fireEvent.change(screen.getByTestId('wt-name'), { target: { value: name } })
}

async function saveFromReview() {
  fireEvent.click(screen.getByTestId('stepper-step-review'))
  await screen.findByTestId('webhook-trigger-step-review')
  fireEvent.click(screen.getByTestId('webhook-trigger-save'))
  await waitFor(() => expect(writes).toHaveLength(1))
}

beforeEach(async () => {
  rows = []
  writes = []
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhook-payload-preserve-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        user: { id: 'u1', username: 'root', displayName: 'root', role: 'user', status: 'active' },
        source: 'session',
        permissions: ['event-automation-rules:update'],
        linkedIdentities: [],
        pats: [],
      })
    }
    if (url.includes('/api/webhook-triggers')) {
      if (init?.method === 'PUT' || init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({})
      }
      return jsonResponse(rows)
    }
    if (url.includes('/api/webhook-endpoints')) return jsonResponse([ENDPOINT])
    if (url.includes('/api/workflows/wf1')) {
      return jsonResponse({
        id: 'wf1',
        definition: { inputs: [{ key: 'instruction', kind: 'text', required: true }] },
      })
    }
    if (url.includes('/api/workflows')) return jsonResponse([{ id: 'wf1', name: 'Fix WF' }])
    if (url.includes('/api/agents/ag1')) {
      return jsonResponse({
        id: 'ag1',
        name: 'Fixer',
        inputs: [
          { name: 'spec', kind: 'string', required: false },
          { name: 'budget', kind: 'string', required: false },
        ],
        updatedAt: 1,
      })
    }
    if (url.includes('/api/agents')) return jsonResponse([{ id: 'ag1', name: 'Fixer' }])
    if (url.includes('/api/workgroups')) return jsonResponse([{ id: 'wg1', name: 'Crew' }])
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-257 · 编辑触发器不得丢弃 UI 不渲染的 payload 字段', () => {
  test('agent 触发器：端口 inputs / allowClarify / 资源上限在改名保存后原样保留', async () => {
    rows = [
      triggerRow({
        launchKind: 'agent',
        launchRefId: 'ag1',
        launchPayload: {
          description: '修一下 {{repo_path}}',
          inputs: { spec: '{{mr_title}}', budget: '3' },
          allowClarify: true,
          maxDurationMs: 60000,
          maxTotalTokens: 2000,
        },
      }),
    ]
    await renderWebhooks()
    await editAndRename('修到绿 v2')
    fireEvent.click(screen.getByTestId('stepper-step-target'))
    await screen.findByTestId('wt-agent-repairs')
    fireEvent.click(screen.getByTestId('wt-agent-repair'))
    await saveFromReview()

    expect(writes[0]?.['name']).toBe('修到绿 v2')
    expect(writes[0]?.['launchPayload']).toEqual({
      inputs: { spec: '{{mr_title}}', budget: '3' },
      allowClarify: true,
      maxDurationMs: 60000,
      maxTotalTokens: 2000,
    })
  })

  test('切换到临时空间：只删远端专属字段，资源上限继续保留', async () => {
    rows = [
      triggerRow({
        launchPayload: {
          inputs: { instruction: { kind: 'template', template: 'fix {{repo_path}}' } },
          workingBranch: 'aw/webhook',
          autoCommitPush: true,
          maxTotalTokens: 2000,
        },
      }),
    ]
    await renderWebhooks()
    await editAndRename('切到临时空间')
    fireEvent.click(screen.getByTestId('stepper-step-target'))
    await screen.findByTestId('webhook-trigger-step-target')
    fireEvent.click(screen.getByTestId('wt-space-scratch'))
    await saveFromReview()

    expect(writes[0]?.['autoRegisterRepos']).toBe(false)
    expect(writes[0]?.['launchPayload']).toEqual({
      inputs: { instruction: { kind: 'template', template: 'fix {{repo_path}}' } },
      maxTotalTokens: 2000,
      scratch: true,
    })
  })

  test('从临时空间切回事件仓：scratch 键被删除而不是留成 false', async () => {
    rows = [
      triggerRow({
        autoRegisterRepos: false,
        launchPayload: {
          inputs: { instruction: { kind: 'template', template: 'fix {{repo_path}}' } },
          scratch: true,
          maxDurationMs: 60000,
        },
      }),
    ]
    await renderWebhooks()
    await editAndRename('切回事件仓')
    fireEvent.click(screen.getByTestId('stepper-step-target'))
    await screen.findByTestId('webhook-trigger-step-target')
    fireEvent.click(screen.getByTestId('wt-space-event-repo'))
    await saveFromReview()

    const payload = writes[0]?.['launchPayload'] as Record<string, unknown>
    expect('scratch' in payload).toBe(false)
    expect(payload).toEqual({
      inputs: { instruction: { kind: 'template', template: 'fix {{repo_path}}' } },
      maxDurationMs: 60000,
    })
  })
})
