// RFC-319 B30 —— WF-19：连线弹窗决定的是「数据实际流向哪个端口」。
//
// 画布上一条线看起来只是一条线，但它落进定义里的形态由弹窗里的几个选择决定，
// 而这些选择**在画布上事后看不出区别**：
//
//   * 「新建输入」与「复用已有输入」画出来是同一条线——区别在于后者会**顶掉**
//     原来接在那个端口上的边。选错方向的后果是安静的：要么多出一个没人喂的
//     端口（提示词里的 `{{port}}` 永远是空的），要么把别人接好的上游悄悄挤掉；
//   * 分片扇出边界上的「分片 / 广播」决定每个分片拿到的是**一项**还是**整份**。
//     接错时任务照样跑完，只是每个分片都处理了全量数据——没有任何报错。
//
// 判据因此一律落在**保存后的定义**上（读回 `/api/workflows/:id`），不看画布上的
// 提示语；弹窗里的提示（替换预告、兼容性）只作为「用户按下确认前被告知过」的补充。
//
// 判据取自源码单一事实源：
//   components/workflow-editor/ConnectionDialog.tsx:455-495  new / reuse 两支
//   components/workflow-editor/ConnectionDialog.tsx:525-552  fanoutKind + shard/broadcast
//   shared/schemas/workflow.ts:841                            wrapper 输入口的 isShardSource

import { expect, test, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let producerId: string
let listerId: string
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

interface Edge {
  id: string
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
  boundary?: string
}
interface Definition {
  nodes: Array<Record<string, unknown>>
  edges: Edge[]
}

const readDefinition = async (id: string): Promise<Definition> =>
  (await api<{ definition: Definition }>(`/api/workflows/${encodeURIComponent(id)}`)).definition

test.beforeAll(async () => {
  daemon = await startDaemon()
  producerId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wf19-agent',
        description: 'RFC-319 WF-19 fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    })
  ).id
  // 分片源必须由一个真的产出 list<T> 的上游来喂——拿 markdown 去接 list<string>
  // 的分片口，弹窗会判 Incompatible 并禁用提交（实测）。
  listerId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wf19-lister',
        description: 'RFC-319 WF-19 list producer',
        outputs: ['items'],
        outputKinds: { items: 'list<string>' },
        readonly: true,
        bodyMd: '',
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

function agentNode(id: string, x: number): Record<string, unknown> {
  return {
    id,
    kind: 'agent-single',
    agentId: producerId,
    agentName: 'rfc319-wf19-agent',
    promptTemplate: 'Work on it.',
    position: { x, y: 0 },
  }
}

async function seedWorkflow(nodes: Array<Record<string, unknown>>, edges: Edge[]): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-wf19-${++sequence}`,
      description: 'RFC-319 WF-19 fixture',
      definition: { $schema_version: 3, inputs: [], nodes, edges },
    }),
  })
  return created.id
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
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
  // 画布是 transform 视口：视口外的节点在 DOM 里存在却点不到，而
  // `scrollIntoView` 对 transform 无效。先取全图视角，让所有节点都可点。
  await clickCanvasControl(page, 'workflow-camera-overview')
}

/**
 * 从节点右键菜单打开连线弹窗。
 *
 * 走右键菜单而不是检查器上的 `inspector-connect-next`：那个按钮只在
 * `chrome === 'content'` 的紧凑检查器里渲染，宽视口下检查器是常驻侧栏、
 * 根本没有它（实测 15s 超时才发现）。右键菜单是两个视口下都存在的入口。
 */
async function openConnectionDialog(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node`)
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Connect next step', exact: true }).click()
  await expect(page.getByTestId('connection-submit')).toBeVisible()
}

/** 目标节点选项的标签是 `<agentName> (<nodeId>)`（ConnectionDialog.tsx:50 nodeLabel）。 */
async function pickTargetNode(page: Page, nodeId: string): Promise<void> {
  await page.getByTestId('connection-target-node').click()
  await page.getByRole('option', { name: `rfc319-wf19-agent (${nodeId})`, exact: true }).click()
}

test('「新建输入」把线接到一个此前不存在的端口上，并原样落进定义', async ({ page }) => {
  const workflowId = await seedWorkflow([agentNode('producer', 0), agentNode('consumer', 360)], [])
  await openEditor(page, workflowId)
  await openConnectionDialog(page, 'producer')

  await pickTargetNode(page, 'consumer')
  await page.getByTestId('connection-mode-new').click()
  await page.getByTestId('connection-target-port').getByRole('textbox').fill('brief')
  await expect(
    page.getByTestId('connection-preview'),
    '预览是用户按下确认前唯一能看见的「这条线到底接到哪」',
  ).toContainText('producer.answer → consumer.brief')

  await page.getByTestId('connection-submit').click()
  await expect(page.getByTestId('connection-submit')).toBeHidden()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const edges = (await readDefinition(workflowId)).edges
  expect(
    edges.map(
      (edge) =>
        `${edge.source.nodeId}.${edge.source.portName}→${edge.target.nodeId}.${edge.target.portName}`,
    ),
    '弹窗里选的端口没有原样落进定义 ⇒ 画布上看着接对了，运行时喂的是另一个口',
  ).toEqual(['producer.answer→consumer.brief'])
})

test('「复用已有输入」接到同一个端口上，会顶掉原来那条边而不是并存', async ({ page }) => {
  const workflowId = await seedWorkflow(
    [agentNode('first', 0), agentNode('second', 0), agentNode('consumer', 360)],
    [
      {
        id: 'e_first',
        source: { nodeId: 'first', portName: 'answer' },
        target: { nodeId: 'consumer', portName: 'brief' },
      },
    ],
  )
  await openEditor(page, workflowId)
  await openConnectionDialog(page, 'second')

  await pickTargetNode(page, 'consumer')
  await page.getByTestId('connection-mode-reuse').click()
  await expect(
    page.getByTestId('connection-replacement'),
    '复用会顶掉一条既有的边——按下确认之前必须先告诉用户这件事',
  ).toContainText('e_first')

  await page.getByTestId('connection-submit').click()
  await expect(page.getByTestId('connection-submit')).toBeHidden()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const edges = (await readDefinition(workflowId)).edges
  const intoBrief = edges.filter(
    (edge) => edge.target.nodeId === 'consumer' && edge.target.portName === 'brief',
  )
  expect(
    intoBrief.map((edge) => edge.source.nodeId),
    '一个输入端口上并存两条来源边 ⇒ 运行时到底喂哪一个由顺序决定，是不确定行为',
  ).toEqual(['second'])
})

test('分片扇出边界：选「广播」时每个分片拿整份，选「分片」会把原来的分片口降级', async ({
  page,
}) => {
  const workflowId = await seedWorkflow(
    [
      agentNode('outside', 0),
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        // 分片源必须是 list<T>（shared/schemas/workflow.ts:833 的校验器规则）；
        // 少了 kind，弹窗会以「先选一个 list<T> 作分片源再加广播」拒绝提交。
        inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        position: { x: 320, y: 0 },
      },
      agentNode('inner', 420),
      agentNode('feeder', -320),
      {
        id: 'lister',
        kind: 'agent-single',
        agentId: listerId,
        agentName: 'rfc319-wf19-lister',
        promptTemplate: 'List them.',
        position: { x: 0, y: 240 },
      },
    ],
    [
      {
        id: 'e_feed',
        source: { nodeId: 'feeder', portName: 'answer' },
        target: { nodeId: 'fan', portName: 'items' },
      },
      {
        id: 'e_in',
        source: { nodeId: 'fan', portName: 'items' },
        target: { nodeId: 'inner', portName: 'topic' },
        boundary: 'wrapper-input',
      },
    ],
  )
  await openEditor(page, workflowId)
  await openConnectionDialog(page, 'outside')
  await pickTargetNode(page, 'inner')

  await expect(
    page.getByTestId('connection-fanout-boundary'),
    '一条从扇出外部接进内部节点的线会**穿过分片边界**；不把这件事说出来，' +
      '作者不会意识到自己正在决定每个分片拿到什么',
  ).toBeVisible()

  // 广播：新端口不是分片源，原来的 items 保持分片源不变。
  await page.getByTestId('connection-fanout-role-broadcast').click()
  await page.getByTestId('connection-target-port').getByRole('textbox').fill('context')
  await page.getByTestId('connection-submit').click()
  await expect(page.getByTestId('connection-submit')).toBeHidden()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const afterBroadcast = (await readDefinition(workflowId)).nodes.find(
    (node) => node.id === 'fan',
  ) as { inputs: Array<{ name: string; isShardSource?: boolean }> }
  expect(
    afterBroadcast.inputs.find((port) => port.name === 'items')?.isShardSource,
    '选「广播」却动了原来的分片源 ⇒ 每个分片拿到的东西被悄悄换掉了',
  ).toBe(true)
  expect(
    afterBroadcast.inputs.find((port) => port.name === 'context')?.isShardSource ?? false,
    '广播口被记成分片源 ⇒ 整份数据被切开逐项发，与作者的选择相反',
  ).toBe(false)

  // 分片：一个扇出只能有一个分片源，所以再选一次「分片」必然要**降级**原来那个。
  // 这一步是这条能力里最危险的操作——它悄悄改变了既有那条边上每个分片拿到什么。
  await openConnectionDialog(page, 'lister')
  await pickTargetNode(page, 'inner')
  await page.getByTestId('connection-fanout-role-shard').click()
  await page.getByTestId('connection-fanout-kind').fill('list<string>')
  await page.getByTestId('connection-target-port').getByRole('textbox').fill('slices')
  await expect(
    page.getByTestId('connection-fanout-demotions'),
    '改分片源会把原来那个降级——按下确认之前必须点名说出被降级的是谁',
  ).toContainText('items')

  await page.getByTestId('connection-submit').click()
  await expect(page.getByTestId('connection-submit')).toBeHidden()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')

  const afterShard = (await readDefinition(workflowId)).nodes.find((node) => node.id === 'fan') as {
    inputs: Array<{ name: string; kind: string; isShardSource?: boolean }>
  }
  expect(
    afterShard.inputs.filter((port) => port.isShardSource === true).map((port) => port.name),
    '一个扇出出现两个分片源（或一个都不剩）⇒ 校验器会判 shard-source-duplicate / -missing，' +
      '而作者以为自己只是加了一条线',
  ).toEqual(['slices'])
  expect(afterShard.inputs.find((port) => port.name === 'slices')?.kind).toBe('list<string>')
})
