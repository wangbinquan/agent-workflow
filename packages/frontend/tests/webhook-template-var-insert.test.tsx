// webhook 触发器向导 · 模板变量插入的三注入面集成锁：
//   - workflow 输入映射此前完全没有变量提示（只有 placeholder），本套件锁
//     「三种 launch kind 的注入面都渲染同一条 TemplateVarChips 行」；
//   - 点击 chip 把 {{var}} 插入光标处：workflow 面插入「最近聚焦」的 text
//     输入（未聚焦过则落第一个）、agent description / workgroup goal 面直接
//     插入各自 textarea；
//   - 变量集按所选事件类型交集过滤（与保存期校验同源），event_json 置顶。
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

let triggerWrites: Array<Record<string, unknown>> = []

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

beforeEach(async () => {
  triggerWrites = []
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
  test('RFC-268: scratch choice serializes true + autoRegister=false and review hides clone control', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-target'))
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fix WF' }))
    fireEvent.change(await screen.findByTestId('wt-map-instruction'), {
      target: { value: 'repair {{repo_path}}' },
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
        instruction: { kind: 'template', template: 'repair {{repo_path}}' },
      },
      scratch: true,
    })
  })

  test('workflow mappings: chips render (event_json first), insert into the focused input', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-target'))
    // Select 的 option 在 mousedown 上完成选择（见 Select.tsx 内注释）。
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Fix WF' }))
    const instruction = (await screen.findByTestId('wt-map-instruction')) as HTMLInputElement

    // 变量行渲染在映射网格里；event_json 置顶，默认事件（mr_opened+mr_updated）
    // 的交集含 mr_title、不含 comment_text / pipeline_status。
    const chips = await screen.findAllByTestId(/^wt-var-/)
    expect(chips[0]!.getAttribute('data-testid')).toBe('wt-var-event_json')
    expect(screen.getByTestId('wt-var-mr_title')).toBeTruthy()
    expect(screen.queryByTestId('wt-var-comment_text')).toBeNull()
    expect(screen.queryByTestId('wt-var-pipeline_status')).toBeNull()

    // 未聚焦过任何输入：落到第一个 text 输入（instruction）。
    fireEvent.click(screen.getByTestId('wt-var-repo_path'))
    await waitFor(() => expect(instruction.value).toBe('{{repo_path}}'))

    // 聚焦第二个输入并把光标放在中间：插入发生在光标处、目标是聚焦的那个。
    // extra.focus() 更新 activeElement（焦点让位守卫的依据）；happy-dom 的
    // focus() 不派发 React 委托所依赖的事件，onFocus 由 fireEvent.focus 补齐。
    const extra = screen.getByTestId('wt-map-extra') as HTMLInputElement
    fireEvent.change(extra, { target: { value: 'fix bug' } })
    extra.focus()
    fireEvent.focus(extra)
    extra.setSelectionRange(3, 3)
    fireEvent.click(screen.getByTestId('wt-var-event_json'))
    await waitFor(() => expect(extra.value).toBe('fix{{event_json}} bug'))
    expect(instruction.value).toBe('{{repo_path}}')
    await waitFor(() => expect(extra.selectionStart).toBe('fix{{event_json}}'.length))
  })

  test('agent description: chips render and insert at the textarea caret', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-launch-kind-agent'))
    const description = (await screen.findByTestId('wt-description')) as HTMLTextAreaElement
    fireEvent.change(description, { target: { value: 'Hello world' } })
    description.focus()
    description.setSelectionRange(5, 5)
    fireEvent.click(screen.getByTestId('wt-var-event_json'))
    await waitFor(() => expect(description.value).toBe('Hello{{event_json}} world'))
    await waitFor(() => expect(description.selectionStart).toBe('Hello{{event_json}}'.length))
  })

  test('workgroup goal: a selection range is replaced by the token', async () => {
    await renderWebhooks()
    await openWizardAtTargetStep()

    fireEvent.click(screen.getByTestId('wt-launch-kind-workgroup'))
    const goal = (await screen.findByTestId('wt-goal')) as HTMLTextAreaElement
    fireEvent.change(goal, { target: { value: 'Goal text' } })
    goal.focus()
    goal.setSelectionRange(0, 4)
    fireEvent.click(screen.getByTestId('wt-var-branch'))
    await waitFor(() => expect(goal.value).toBe('{{branch}} text'))
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
    const chips = await screen.findAllByTestId(/^wt-var-/)
    // RFC-263 改判：push = COMMON(14) + commit_sha + commit_before（原为 COMMON(6)
    // + commit_sha = 7）—— 补齐的 8 个 API 定位变量对每类事件都可用。
    expect(chips).toHaveLength(16)
    expect(chips[0]!.getAttribute('data-testid')).toBe('wt-var-event_json')
    expect(screen.getByTestId('wt-var-repo_http_url')).toBeTruthy()
    expect(screen.getByTestId('wt-var-repo_ssh_url')).toBeTruthy()
    expect(screen.getByTestId('wt-var-commit_sha')).toBeTruthy()
    // RFC-263：API 定位组在 push 事件下同样可用（设 commit status / 建 MR 要用）
    expect(screen.getByTestId('wt-var-project_id')).toBeTruthy()
    expect(screen.getByTestId('wt-var-api_base_url')).toBeTruthy()
    expect(screen.getByTestId('wt-var-commit_before')).toBeTruthy()
    expect(screen.queryByTestId('wt-var-mr_iid')).toBeNull()
    expect(screen.queryByTestId('wt-var-mr_title')).toBeNull()
    // 评论专属变量在 push 事件下不出现
    expect(screen.queryByTestId('wt-var-comment_thread_id')).toBeNull()
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
    await screen.findAllByTestId(/^wt-var-/)
    expect(screen.getByTestId('wt-var-comment_thread_id')).toBeTruthy()
    expect(screen.getByTestId('wt-var-comment_id')).toBeTruthy()
    expect(screen.getByTestId('wt-var-comment_position_json')).toBeTruthy()
    expect(screen.getByTestId('wt-var-project_id')).toBeTruthy()
    // 变量说明挂在 chip 的 title 上（30 个变量光看名字认不全）
    expect(screen.getByTestId('wt-var-comment_thread_id').getAttribute('title')).toBeTruthy()
  })
})
