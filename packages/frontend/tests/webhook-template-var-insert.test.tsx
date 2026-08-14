// RFC-295 webhook 作者面集成锁：每个运行期模板字段都使用同一个、字段相邻的
// RuntimeParameterPicker。字段解释和 canonical token 在按需打开的列表中呈现，
// 事件类型仍按保存期同源目录过滤。
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

const WF_DETAIL = {
  id: 'wf1',
  definition: {
    inputs: [
      { key: 'instruction', kind: 'text', required: true },
      { key: 'extra', kind: 'text' },
      { key: 'repo', kind: 'git' },
    ],
  },
}

const AGENT_DETAIL = {
  id: 'ag1',
  name: 'Fixer',
  inputs: [],
  updatedAt: 1,
}

let triggerWrites: Array<Record<string, unknown>> = []
let agentDetailResponse: {
  id: string
  name: string
  inputs: Array<{ name: string; kind: string; required?: boolean }>
  updatedAt: number
} = AGENT_DETAIL

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
  return { qc }
}

/** 走完向导前两步（scope + events），停在 target 步。 */
async function openWizardAtTargetStep() {
  await screen.findByTestId('webhook-trigger-new')
  await waitFor(() =>
    expect((screen.getByTestId('webhook-trigger-new') as HTMLButtonElement).disabled).toBe(false),
  )
  fireEvent.click(screen.getByTestId('webhook-trigger-new'))
  await screen.findByTestId('webhook-trigger-step-scope')
  fireEvent.change(screen.getByTestId('wt-name'), { target: { value: 'Insert vars' } })
  fireEvent.change(screen.getByTestId('wt-scope-prefix'), { target: { value: 'platform/' } })
  const next = screen.getByTestId('stepper-next') as HTMLButtonElement
  await waitFor(() => expect(next.disabled).toBe(false))
  fireEvent.click(next)
  await screen.findByTestId('webhook-trigger-step-events')
  fireEvent.click(screen.getByTestId('stepper-next'))
  await screen.findByTestId('webhook-trigger-step-target')
}

async function insertParameter(buttonTestId: string, token: string) {
  const button = screen.getByTestId(buttonTestId)
  fireEvent.pointerDown(button, { button: 0 })
  fireEvent.click(button)
  const search = await screen.findByRole('combobox', { name: /Search parameter|搜索参数/ })
  fireEvent.change(search, { target: { value: token } })
  const option = await screen.findByRole('option', {
    name: new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  })
  fireEvent.click(option)
}

beforeEach(async () => {
  triggerWrites = []
  agentDetailResponse = AGENT_DETAIL
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://webhook-var-insert-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        user: { id: 'u1', username: 'root', displayName: 'root', role: 'admin', status: 'active' },
        source: 'session',
        permissions: [],
        linkedIdentities: [],
        pats: [],
      })
    }
    if (url.includes('/api/webhook-triggers')) {
      if (init?.method === 'POST') {
        triggerWrites.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({})
      }
      return jsonResponse([])
    }
    if (url.includes('/api/webhook-endpoints')) return jsonResponse([ENDPOINT])
    if (url.includes('/api/workflows/wf1')) return jsonResponse(WF_DETAIL)
    if (url.includes('/api/workflows')) return jsonResponse([{ id: 'wf1', name: 'Fix WF' }])
    if (url.includes('/api/agents/ag1')) return jsonResponse(agentDetailResponse)
    if (url.includes('/api/agents')) return jsonResponse([{ id: 'ag1', name: 'Fixer' }])
    if (url.includes('/api/workgroups')) return jsonResponse([{ id: 'wg1', name: 'Crew' }])
    return jsonResponse([])
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('webhook trigger wizard · template var insertion', () => {
  test('RFC-303 terminal protection is draft-owned, validates event combinations, and serializes', async () => {
    await renderWebhooks()
    await screen.findByTestId('webhook-trigger-new')
    await waitFor(() =>
      expect((screen.getByTestId('webhook-trigger-new') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('webhook-trigger-new'))
    fireEvent.change(await screen.findByTestId('wt-name'), { target: { value: 'Terminal guard' } })
    fireEvent.change(screen.getByTestId('wt-scope-prefix'), { target: { value: 'platform/' } })
    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-events')

    fireEvent.click(screen.getByTestId('wt-cancel-on-mr-terminal'))
    expect((screen.getByTestId('wt-cancel-on-mr-terminal') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('wt-event-mr_closed'))
    expect(screen.getByTestId('wt-terminal-policy-error')).toBeTruthy()
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('wt-event-mr_closed'))
    expect(screen.queryByTestId('wt-terminal-policy-error')).toBeNull()

    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-target')
    fireEvent.click(screen.getByTestId('wt-target'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fix WF' }))
    fireEvent.change(await screen.findByTestId('wt-map-instruction'), {
      target: { value: 'review this MR' },
    })
    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-review')
    expect(screen.getByText('Stop running tasks when the MR / PR is closed or merged')).toBeTruthy()
    fireEvent.click(screen.getByTestId('webhook-trigger-save'))
    await waitFor(() => expect(triggerWrites).toHaveLength(1))
    expect(triggerWrites[0]?.['cancelOnMrTerminal']).toBe(true)
  })

  test('整个 Webhook draft 共用一套可见历史，连续文字输入只撤销一次', async () => {
    await renderWebhooks()
    await screen.findByTestId('webhook-trigger-new')
    await waitFor(() =>
      expect((screen.getByTestId('webhook-trigger-new') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId('webhook-trigger-new'))
    const name = (await screen.findByTestId('wt-name')) as HTMLInputElement

    fireEvent.change(name, { target: { value: 'A' } })
    fireEvent.change(name, { target: { value: 'AB' } })
    fireEvent.change(name, { target: { value: 'ABC' } })
    fireEvent.blur(name)

    const undo = screen.getByTestId('webhook-trigger-undo') as HTMLButtonElement
    const redo = screen.getByTestId('webhook-trigger-redo') as HTMLButtonElement
    expect(undo.disabled).toBe(false)
    fireEvent.click(undo)
    expect(name.value).toBe('')
    expect(redo.disabled).toBe(false)
    fireEvent.click(redo)
    expect(name.value).toBe('ABC')
  })

  test('picker 搜索的 Undo 不穿透草稿，关闭后外层快捷键才撤销字段', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()
    fireEvent.click(screen.getByTestId('wt-launch-kind-workgroup'))
    const goal = (await screen.findByTestId('wt-goal')) as HTMLTextAreaElement
    fireEvent.change(goal, { target: { value: 'draft goal' } })

    fireEvent.click(screen.getByTestId('wt-goal-parameter'))
    const search = await screen.findByRole('combobox', { name: /Search parameter|搜索参数/ })
    fireEvent.change(search, { target: { value: 'event' } })
    fireEvent.keyDown(search, { key: 'z', ctrlKey: true })
    expect(goal.value).toBe('draft goal')

    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.keyDown(screen.getByTestId('wt-goal-parameter'), { key: 'z', ctrlKey: true })
    expect(goal.value).toBe('')
  })

  test('RFC-268: scratch choice serializes true + autoRegister=false and review hides clone control', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-target'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fix WF' }))
    fireEvent.change(await screen.findByTestId('wt-map-instruction'), {
      target: { value: 'repair {{trigger.webhook.repo_path}}' },
    })

    expect(screen.getByTestId('wt-space-event-repo').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('wt-space-scratch'))
    expect(screen.getByTestId('wt-space-scratch').getAttribute('aria-checked')).toBe('true')
    expect(
      screen.getByText(
        'Pass event data into the workflow. Git inputs still carry the event branch value, but do not check out the event repository.',
      ),
    ).toBeTruthy()

    // 切回事件仓不会偷偷恢复 clone；该开关保持 false。再选 scratch 完成保存。
    fireEvent.click(screen.getByTestId('wt-space-event-repo'))
    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-review')
    expect((screen.getByTestId('wt-auto-register') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId('stepper-step-target'))
    fireEvent.click(screen.getByTestId('wt-space-scratch'))
    fireEvent.click(screen.getByTestId('stepper-next'))

    await screen.findByTestId('webhook-trigger-step-review')
    expect(screen.getByText('Temporary workspace')).toBeTruthy()
    expect(screen.queryByTestId('wt-auto-register')).toBeNull()
    expect(screen.getByTestId('wt-scratch-notice').textContent).toContain(
      'fresh empty Git repository',
    )
    fireEvent.click(screen.getByTestId('webhook-trigger-save'))
    await waitFor(() => expect(triggerWrites).toHaveLength(1))
    expect(triggerWrites[0]?.['autoRegisterRepos']).toBe(false)
    expect(triggerWrites[0]?.['launchPayload']).toEqual({
      inputs: {
        instruction: {
          kind: 'template',
          template: 'repair {{trigger.webhook.repo_path}}',
        },
      },
      scratch: true,
    })
  })

  test('workflow mappings: each text field owns one picker and inserts at its own caret', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-target'))
    // Select 的 option 在 mousedown 上完成选择（见 Select.tsx 内注释）。
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fix WF' }))
    const instruction = (await screen.findByTestId('wt-map-instruction')) as HTMLInputElement

    expect(screen.getByTestId('wt-map-instruction-parameter')).toBeTruthy()
    expect(screen.getByTestId('wt-map-extra-parameter')).toBeTruthy()
    await insertParameter('wt-map-instruction-parameter', '{{trigger.webhook.repo_path}}')
    await waitFor(() => expect(instruction.value).toBe('{{trigger.webhook.repo_path}}'))

    // 第二个字段的按钮只写第二个字段；没有“最近聚焦/第一个”的隐式目标猜测。
    const extra = screen.getByTestId('wt-map-extra') as HTMLInputElement
    fireEvent.change(extra, { target: { value: 'fix bug' } })
    extra.focus()
    extra.setSelectionRange(3, 3)
    await insertParameter('wt-map-extra-parameter', '{{trigger.webhook.event_json}}')
    await waitFor(() => expect(extra.value).toBe('fix{{trigger.webhook.event_json}} bug'))
    expect(instruction.value).toBe('{{trigger.webhook.repo_path}}')
    await waitFor(() =>
      expect(extra.selectionStart).toBe('fix{{trigger.webhook.event_json}}'.length),
    )
  })

  test('agent description: zero-port detail exposes one picker and inserts at the caret', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-launch-kind-agent'))
    fireEvent.click(screen.getByTestId('wt-target'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fixer' }))
    const description = (await screen.findByTestId('wt-description')) as HTMLTextAreaElement
    fireEvent.change(description, { target: { value: 'Hello world' } })
    description.focus()
    description.setSelectionRange(5, 5)
    await insertParameter('wt-description-parameter', '{{trigger.webhook.event_json}}')
    await waitFor(() => expect(description.value).toBe('Hello{{trigger.webhook.event_json}} world'))
    await waitFor(() =>
      expect(description.selectionStart).toBe('Hello{{trigger.webhook.event_json}}'.length),
    )
  })

  test('Agent 结构刷新在输入聚焦时延迟 reconcile，显式应用后才切换表单', async () => {
    const { qc } = await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-launch-kind-agent'))
    fireEvent.click(screen.getByTestId('wt-target'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fixer' }))
    const description = (await screen.findByTestId('wt-description')) as HTMLTextAreaElement
    description.focus()
    fireEvent.change(description, { target: { value: 'keep this draft' } })
    agentDetailResponse = {
      ...AGENT_DETAIL,
      updatedAt: 2,
      inputs: [{ name: 'spec', kind: 'string', required: false }],
    }

    await qc.invalidateQueries({ queryKey: ['agents', 'detail', 'ag1'] })
    await screen.findByTestId('wt-agent-pending-reconcile')
    expect(screen.getByTestId('wt-description')).toBe(description)
    expect(description.value).toBe('keep this draft')
    expect((screen.getByTestId('stepper-next') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('wt-agent-apply-definition'))
    await screen.findByTestId('wt-agent-input-spec')
    expect(screen.queryByTestId('wt-description')).toBeNull()
    expect(screen.getByTestId('wt-agent-repairs')).toBeTruthy()
  })

  test('workgroup goal: a selection range is replaced by the token', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-launch-kind-workgroup'))
    const goal = (await screen.findByTestId('wt-goal')) as HTMLTextAreaElement
    fireEvent.change(goal, { target: { value: 'Goal text' } })
    goal.focus()
    goal.setSelectionRange(0, 4)
    await insertParameter('wt-goal-parameter', '{{trigger.webhook.branch}}')
    await waitFor(() => expect(goal.value).toBe('{{trigger.webhook.branch}} text'))
  })

  test('chips follow the selected event types (push-only hides MR vars, keeps URL vars)', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    // 回到 events 步，把默认 MR 事件换成 push。
    fireEvent.click(screen.getByTestId('stepper-step-events'))
    await screen.findByTestId('webhook-trigger-step-events')
    fireEvent.click(screen.getByTestId('wt-event-mr_opened'))
    fireEvent.click(screen.getByTestId('wt-event-mr_updated'))
    fireEvent.click(screen.getByTestId('wt-event-push'))
    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-target')

    fireEvent.click(screen.getByTestId('wt-launch-kind-workgroup'))
    await screen.findByTestId('wt-goal')
    fireEvent.click(screen.getByTestId('wt-goal-parameter'))
    const search = await screen.findByRole('combobox', { name: /Search parameter|搜索参数/ })
    fireEvent.change(search, { target: { value: 'trigger.webhook.' } })
    const options = await screen.findAllByRole('option', {
      name: /\{\{trigger\.webhook\./,
    })
    // RFC-263 改判：push = COMMON(14) + commit_sha + commit_before（原为 COMMON(6)
    // + commit_sha = 7）—— 补齐的 8 个 API 定位变量对每类事件都可用。
    expect(options).toHaveLength(16)
    expect(screen.getByRole('option', { name: /repo_http_url/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /repo_ssh_url/ })).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /\{\{trigger\.webhook\.commit_sha\}\}\./ }),
    ).toBeTruthy()
    // RFC-263：API 定位组在 push 事件下同样可用（设 commit status / 建 MR 要用）
    expect(screen.getByRole('option', { name: /project_id/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /api_base_url/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /commit_before/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /mr_iid/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /mr_title/ })).toBeNull()
    // 评论专属变量在 push 事件下不出现
    expect(screen.queryByRole('option', { name: /comment_thread_id/ })).toBeNull()
  })

  // RFC-263：note 事件下「回复到同一线程」的三件套必须都能点进提示词。
  test('note events expose the reply-to-thread variables', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('stepper-step-events'))
    await screen.findByTestId('webhook-trigger-step-events')
    fireEvent.click(screen.getByTestId('wt-event-mr_opened'))
    fireEvent.click(screen.getByTestId('wt-event-mr_updated'))
    fireEvent.click(screen.getByTestId('wt-event-note'))
    fireEvent.click(screen.getByTestId('stepper-next'))
    await screen.findByTestId('webhook-trigger-step-target')

    fireEvent.click(screen.getByTestId('wt-launch-kind-workgroup'))
    await screen.findByTestId('wt-goal')
    fireEvent.click(screen.getByTestId('wt-goal-parameter'))
    const search = await screen.findByRole('combobox', { name: /Search parameter|搜索参数/ })
    fireEvent.change(search, { target: { value: 'trigger.webhook.' } })
    expect(await screen.findByRole('option', { name: /comment_thread_id/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /comment_id/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /comment_position_json/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /project_id/ })).toBeTruthy()
    // 每一行同时给出可读名、canonical token 和常显文字解释。
    expect(screen.getByRole('option', { name: /comment_thread_id/ }).textContent).toContain(
      '{{trigger.webhook.comment_thread_id}}',
    )
  })
})
