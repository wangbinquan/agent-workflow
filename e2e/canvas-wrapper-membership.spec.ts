// RFC-319 B33 —— WF-16：把节点拖进 / 拖出 wrapper 建立归属。
//
// wrapper 的归属不是装饰：它决定这个节点**跑几次、在谁的工作树里跑**。
// 拖进 loop 的节点每一轮都重跑；拖进 git wrapper 的节点，它的改动才被算进那次
// diff。而归属只由**落点落在谁的矩形里**决定——画布上一个像素的差别就是两种
// 完全不同的执行语义，而且事后从静止的画布上看不出「它到底进组了没有」：
// 节点压在 wrapper 上面和真的属于它，长得一模一样。
//
// 判据因此落在**保存后的定义**上（读回 `/api/workflows/:id` 看 `wrapper.nodeIds`），
// 不看画布上的层叠。两个方向都测：只测「拖进去」的话，一个「只增不减」的实现
// 同样能过——而那意味着节点一旦沾过 wrapper 就再也出不来。
//
// 判据取自源码单一事实源：
//   components/canvas/WorkflowCanvas.tsx:2966-3020  onNodeDragStop 里的矩形命中 + 归属补丁

import { expect, test, type Locator, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

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

async function wrapperMembers(workflowId: string): Promise<string[]> {
  const detail = await api<{ definition: { nodes: Array<{ id: string; nodeIds?: string[] }> } }>(
    `/api/workflows/${encodeURIComponent(workflowId)}`,
  )
  const loop = detail.definition.nodes.find((node) => node.id === 'loop')
  expect(loop, '定义里找不到 loop wrapper').toBeTruthy()
  return [...(loop?.nodeIds ?? [])].sort()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  agentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wf16-agent',
        description: 'RFC-319 WF-16 fixture',
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

function agentNode(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    kind: 'agent-single',
    agentId,
    agentName: 'rfc319-wf16-agent',
    promptTemplate: 'Work on it.',
    position: { x, y },
  }
}

async function seedWorkflow(members: string[]): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-wf16-${++sequence}`,
      description: 'RFC-319 WF-16 fixture',
      definition: {
        $schema_version: 3,
        inputs: [],
        nodes: [
          agentNode('seed', 0, 0),
          agentNode('mover', 0, 600),
          {
            id: 'loop',
            kind: 'wrapper-loop',
            nodeIds: members,
            maxIterations: 3,
            exitCondition: { kind: 'port-not-empty', nodeId: 'seed', portName: 'answer' },
            outputBindings: [{ name: 'looped', bind: { nodeId: 'seed', portName: 'answer' } }],
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      },
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
  await clickCanvasControl(page, 'workflow-camera-overview')
  // 相机动画结束前抓到的坐标会在 mouse.down 之前失效，拖拽就不会开始。
  await page.waitForTimeout(400)
}

/** 把一个节点拖到某个绝对坐标（视口内），并等落点提交。 */
async function dragNodeTo(page: Page, nodeId: string, to: { x: number; y: number }): Promise<void> {
  const card = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node`)
  const box = await card.boundingBox()
  if (box === null) throw new Error(`node ${nodeId} has no geometry`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 25 })
  await page.mouse.up()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
}

async function centerOf(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox()
  if (box === null) throw new Error(`node ${nodeId} has no geometry`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('拖拽成员关系（串行：两幕共用同一套相机 / 拖拽姿势）', () => {
  test.describe.configure({ mode: 'serial' })

  test('拖进 wrapper 的矩形 ⇒ 真的入组，并落进定义', async ({ page }) => {
    const workflowId = await seedWorkflow(['seed'])
    expect(await wrapperMembers(workflowId), '前置：mover 一开始不在组里').toEqual(['seed'])

    await openEditor(page, workflowId)
    await dragNodeTo(page, 'mover', await centerOf(page, 'loop'))

    expect(
      await wrapperMembers(workflowId),
      '落在 wrapper 矩形里却没入组 ⇒ 画布上看着在里面、运行时它只跑一次而不是每轮重跑',
    ).toEqual(['mover', 'seed'])
  })

  test('拖出 wrapper ⇒ 真的出组（只增不减的实现会在这里露馅）', async ({ page }) => {
    const workflowId = await seedWorkflow(['seed', 'mover'])
    expect(await wrapperMembers(workflowId), '前置：mover 一开始在组里').toEqual(['mover', 'seed'])

    await openEditor(page, workflowId)
    const canvas = await page.locator('.workflow-canvas').boundingBox()
    if (canvas === null) throw new Error('canvas has no geometry')
    const loop = await page.locator('.react-flow__node[data-id="loop"]').boundingBox()
    if (loop === null) throw new Error('loop has no geometry')
    // 拖到 wrapper 矩形之外、但仍在画布视口内的位置。
    await dragNodeTo(page, 'mover', {
      x: Math.min(loop.x + loop.width + 120, canvas.x + canvas.width - 40),
      y: Math.min(canvas.y + canvas.height - 60, loop.y + loop.height + 80),
    })

    expect(
      await wrapperMembers(workflowId),
      '拖出去了却还在组里 ⇒ 节点一旦沾过 wrapper 就再也出不来，而画布上它明明在外面',
    ).toEqual(['seed'])
  })
})

// ---------------------------------------------------------------------------
// RFC-354 T19 — the three edge roles of a wrapper, each created the way an
// author creates it (Connection Dialog) and each read back from the definition
// the runtime executes:
//   • PARAMETER — an outside producer wired to the loop itself: an ordinary
//     inbound edge whose target port name IS the parameter (no boundary tag);
//   • CLOSURE — an outside producer wired straight to a body member: a plain
//     crossing edge the environment chain resolves at run time; it is NOT a
//     parameter of the loop, so the loop's parameter list must not grow;
//   • RETURN — a body member wired to its own loop: the planner tags it
//     `boundary: 'wrapper-output'`, it shows up as a return value and becomes
//     an exit-condition candidate.
// A drag would also do, but the dialog is the zero-ambiguity path and what a
// keyboard / phone author actually uses.
// ---------------------------------------------------------------------------

interface DefinitionEdge {
  id: string
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
  boundary?: string
}

async function readEdges(workflowId: string): Promise<DefinitionEdge[]> {
  const detail = await api<{ definition: { edges: DefinitionEdge[] } }>(
    `/api/workflows/${encodeURIComponent(workflowId)}`,
  )
  return detail.definition.edges
}

function triple(edge: DefinitionEdge): string {
  return `${edge.source.nodeId}.${edge.source.portName}→${edge.target.nodeId}.${edge.target.portName}${
    edge.boundary === undefined ? '' : `[${edge.boundary}]`
  }`
}

/** v6 seed: `inner` inside the loop (already returning `looped`), `outside` beside it. */
async function seedFramedWorkflow(): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc354-t19-${++sequence}`,
      description: 'RFC-354 T19 fixture',
      definition: {
        $schema_version: 6,
        inputs: [],
        nodes: [
          agentNode('inner', 0, 0),
          agentNode('outside', 0, 600),
          {
            id: 'loop',
            kind: 'wrapper-loop',
            nodeIds: ['inner'],
            maxIterations: 3,
            exitCondition: { kind: 'port-not-empty', portName: 'looped' },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_ret',
            source: { nodeId: 'inner', portName: 'answer' },
            target: { nodeId: 'loop', portName: 'looped' },
            boundary: 'wrapper-output',
          },
        ],
      },
    }),
  })
  return created.id
}

async function openConnectionDialog(page: Page, sourceNodeId: string): Promise<void> {
  await page
    .locator(`.react-flow__node[data-id="${sourceNodeId}"] .canvas-node`)
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Connect next step', exact: true }).click()
  await expect(page.getByTestId('connection-submit')).toBeVisible()
}

/** Wire `source.answer → target.<port>` through the dialog and wait for the save. */
async function connectNew(
  page: Page,
  source: string,
  targetOptionLabel: string,
  portName: string,
  expectedPreview: string,
): Promise<void> {
  await openConnectionDialog(page, source)
  await page.getByTestId('connection-target-node').click()
  await page.getByRole('option', { name: targetOptionLabel, exact: true }).click()
  await page.getByTestId('connection-mode-new').click()
  await page.getByTestId('connection-target-port').getByRole('textbox').fill(portName)
  await expect(page.getByTestId('connection-preview')).toContainText(expectedPreview)
  await page.getByTestId('connection-submit').click()
  await expect(page.getByTestId('connection-submit')).toBeHidden()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
}

function inspector(page: Page): Locator {
  return page.locator('[data-inspector-content="node"]')
}

/**
 * Select a node from the overview camera (same recipe as
 * rfc319-canvas-inspectors). `openEditor` above already switched to overview,
 * and the canvas renders only ONE camera button per mode (overview ⇄ readable),
 * so the switch is conditional here.
 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  if ((await page.getByTestId('workflow-camera-overview').count()) > 0) {
    await clickCanvasControl(page, 'workflow-camera-overview')
  }
  // No fixed wait for the camera animation: selection is delivered as an
  // event below (no hit-test), and `toBeInViewport` polls until it holds.
  const header = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__header`)
  await expect(header).toBeInViewport()
  // The node just wired keeps its floating toolbar ("Connect next step") open,
  // and inside a wrapper that toolbar sits right over the wrapper's header —
  // a pointer click would be intercepted, so deliver the click as the event.
  await header.dispatchEvent('click')
  await expect(page.locator(`[id="workflow-inspector-field-${nodeId}-title"]`)).toBeVisible()
}

async function readSelectOptions(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const labels = await listbox.getByRole('option').allInnerTexts()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  return labels
}

// Three independent acts (each seeds its own workflow): a failure in one must
// not skip the others, and a retry re-runs only the failing act.
test.describe('RFC-354 T19 — 边的三种角色', () => {
  test('参数边：外部产出接到 loop 本身 ⇒ 普通入边，目标口名就是参数名，检查器参数列表列出它', async ({
    page,
  }) => {
    const workflowId = await seedFramedWorkflow()
    await openEditor(page, workflowId)
    await connectNew(page, 'outside', 'loop · wrapper-loop', 'brief', 'outside.answer → loop.brief')
    expect(
      (await readEdges(workflowId)).map(triple).sort(),
      '接到 loop 上的边没有原样落进定义、或被误打成边界边 ⇒ 运行时不知道 brief 是这个循环的参数',
    ).toEqual(['inner.answer→loop.looped[wrapper-output]', 'outside.answer→loop.brief'])
    await selectNode(page, 'loop')
    await expect(
      inspector(page).getByTestId('wrapper-parameter-list'),
      '参数列表没列出 brief ⇒ 作者看不出循环体能拿到什么',
    ).toContainText('brief')
  })

  test('闭包边：外部产出直接接到循环体成员 ⇒ 穿墙的普通边，不是 loop 的参数', async ({ page }) => {
    const workflowId = await seedFramedWorkflow()
    await openEditor(page, workflowId)
    await connectNew(
      page,
      'outside',
      'rfc319-wf16-agent (inner)',
      'context',
      'outside.answer → inner.context',
    )
    expect(
      (await readEdges(workflowId)).map(triple).sort(),
      '穿墙边被改写成别的形状（补了边界标记 / 挂到了 loop 上）⇒ 运行时按参数而不是闭包解析',
    ).toEqual(['inner.answer→loop.looped[wrapper-output]', 'outside.answer→inner.context'])
    await selectNode(page, 'loop')
    await expect(
      inspector(page).getByTestId('wrapper-parameter-list'),
      '闭包边被当成参数列出 ⇒ 两种绑定在界面上分不开',
    ).not.toContainText('context')
  })

  test('返回值边：循环体成员接回自己的 loop ⇒ boundary=wrapper-output，成为返回值与退出条件候选', async ({
    page,
  }) => {
    const workflowId = await seedFramedWorkflow()
    await openEditor(page, workflowId)
    await connectNew(page, 'inner', 'loop · wrapper-loop', 'final', 'inner.answer → loop.final')
    expect(
      (await readEdges(workflowId)).map(triple).sort(),
      '成员 → 自己的 loop 没有打上 wrapper-output ⇒ 它不是返回值，退出条件读不到它',
    ).toEqual([
      'inner.answer→loop.final[wrapper-output]',
      'inner.answer→loop.looped[wrapper-output]',
    ])
    await selectNode(page, 'loop')
    await expect(inspector(page).getByTestId('loop-return-list')).toContainText('final')
    const exitOptions = await readSelectOptions(
      page,
      inspector(page).getByTestId('loop-exit-port-select'),
    )
    expect(
      exitOptions.some((label) => label.includes('final')),
      '新返回口没进退出条件候选 ⇒ 作者接了返回值却选不到它',
    ).toBe(true)
  })
})
