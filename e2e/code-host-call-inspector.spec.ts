// RFC-319 B31 —— WF-36：code-host-call 节点检查器。
//
// 这个节点是平台里**唯一一个由框架自己直接调用外部代码平台写接口**的东西：
// 没有 agent、没有模型、没有子进程，凭据也不进任何 prompt。它检查器里的每一格
// 都直接决定「平台会用管理员配好的令牌，去真实的 GitLab / GitHub 上做什么」。
//
// 两条最危险的形态：
//   * 破坏性方法（DELETE）如果不需要显式授权就能选中，一次手滑就能删掉真实分支 /
//     评论 / 流水线，而这类操作**没有撤销**；
//   * 参数绑定（`{{port}}`）如果没原样落进定义，节点看着配好了，跑起来打的是
//     另一个项目 / 另一条 MR——外部平台上的副作用是真的。
//
// 判据一律落在**保存后的定义**上（读回 `/api/workflows/:id`），并且**两层都验**：
// 界面层（不授权时 DELETE 根本不在下拉里）与状态层（取消授权会把已经选好的
// DELETE 改回 GET——只把开关关掉、把 DELETE 留在定义里是最坏的一种，因为界面
// 显示「未授权」而定义里躺着一条破坏性调用）。服务端那层已有单测覆盖
// （`rfc269-code-host-authoring.test.ts` 的 `code-host-method-forbidden`），
// 这里不重复，只补检查器这一段——它此前零 e2e。
//
// 判据取自源码单一事实源：
//   components/canvas/inspector/CodeHostCallEdit.tsx:603-608  method 选项按 allowDestructive 过滤
//   components/canvas/inspector/CodeHostCallEdit.tsx:846-861  关开关时把 DELETE 改回 GET
//   services/workflow.validator.ts:1646-1657                  服务端第二层（已有单测）

import { expect, test, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let agentId: string
let sequence = 0

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface CallNode {
  id: string
  provider: string
  action: string
  params: Record<string, string>
  request?: { method: string; path: string; query: Record<string, string>; body?: string }
  allowDestructive?: boolean
}

async function readCallNode(workflowId: string): Promise<CallNode> {
  const detail = await api<{ definition: { nodes: CallNode[] } }>(
    `/api/workflows/${encodeURIComponent(workflowId)}`,
  )
  const node = detail.definition.nodes.find((candidate) => candidate.id === 'call')
  expect(node, '定义里找不到 code-host-call 节点').toBeTruthy()
  return node as CallNode
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  agentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wf36-agent',
        description: 'RFC-319 WF-36 fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function seedWorkflow(call: Partial<CallNode>): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-wf36-${++sequence}`,
      description: 'RFC-319 WF-36 fixture',
      definition: {
        $schema_version: 3,
        inputs: [],
        nodes: [
          {
            id: 'producer',
            kind: 'agent-single',
            agentId,
            agentName: 'rfc319-wf36-agent',
            promptTemplate: 'Draft the reply.',
            position: { x: 0, y: 0 },
          },
          {
            id: 'call',
            kind: 'code-host-call',
            provider: 'gitlab',
            action: 'comment.reply-thread',
            params: {},
            position: { x: 360, y: 0 },
            ...call,
          },
        ],
        edges: [],
      },
    }),
  })
  return created.id
}

async function openInspector(page: Page, workflowId: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await page.waitForSelector('.react-flow__node', { state: 'visible' })
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await clickCanvasControl(page, 'workflow-camera-overview')
  await page.locator('.react-flow__node[data-id="call"] .canvas-node').click()
  await expect(page.getByTestId('code-host-action')).toBeVisible()
}

test('provider / action / 入参绑定原样落进定义', async ({ page }) => {
  const workflowId = await seedWorkflow({})
  await openInspector(page, workflowId)

  await page.getByTestId('code-host-provider-github').click()
  await page.getByTestId('code-host-field-mr').fill('42')
  // 参数值是模板：`{{answer}}` 在运行时读上游端口。这一格接错，节点看着配好了，
  // 跑起来打的是另一条 MR——而外部平台上的副作用是真的。
  await page.getByTestId('code-host-field-body').fill('{{answer}}')
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const node = await readCallNode(workflowId)
  expect(node.provider).toBe('github')
  expect(node.action).toBe('comment.reply-thread')
  expect(node.params.mr).toBe('42')
  expect(
    node.params.body,
    '模板没有原样落库 ⇒ 运行时渲染出来的是另一段内容，而它会被真的发到代码平台上',
  ).toBe('{{answer}}')
})

test('破坏性开关：不授权时 DELETE 根本不在方法列表里', async ({ page }) => {
  const workflowId = await seedWorkflow({ action: 'custom' })
  await openInspector(page, workflowId)

  await page.getByTestId('code-host-method').click()
  await expect(
    page.getByRole('option', { name: 'GET', exact: true }),
    '列表本身没渲染出来 ⇒ 下面「DELETE 不在里面」会平凡成立',
  ).toBeVisible()
  await expect(
    page.getByRole('option', { name: 'DELETE', exact: true }),
    '未授权就能选中 DELETE ⇒ 一次手滑删掉真实分支 / 评论，而这类操作没有撤销',
  ).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByTestId('code-host-allow-destructive').click()
  await page.getByTestId('code-host-method').click()
  await page.getByRole('option', { name: 'DELETE', exact: true }).click()
  await page.getByTestId('code-host-path').fill('/projects/demo/issues/1')
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const node = await readCallNode(workflowId)
  expect(node.allowDestructive).toBe(true)
  expect(node.request?.method).toBe('DELETE')
  expect(node.request?.path).toBe('/projects/demo/issues/1')
})

test('取消授权时，已经选好的 DELETE 会被改回 GET 而不是留在定义里', async ({ page }) => {
  const workflowId = await seedWorkflow({
    action: 'custom',
    allowDestructive: true,
    request: { method: 'DELETE', path: '/projects/demo/issues/1', query: {} },
  })
  await openInspector(page, workflowId)
  expect((await readCallNode(workflowId)).request?.method, '前置：定义里确实是 DELETE').toBe(
    'DELETE',
  )

  await page.getByTestId('code-host-allow-destructive').click()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const node = await readCallNode(workflowId)
  expect(node.allowDestructive ?? false).toBe(false)
  expect(
    node.request?.method,
    '只把开关关掉、把 DELETE 留在定义里是最坏的一种：界面显示「未授权」，' +
      '而定义里躺着一条破坏性调用，下一个人读界面读不出来',
  ).toBe('GET')
})
