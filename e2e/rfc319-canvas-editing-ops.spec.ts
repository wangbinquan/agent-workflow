// RFC-319 —— WF-13 / 14 / 17 / 20 / 21 / 22 / 24 / 38 / 46 / X1：
// 工作流画布的**编辑操作**（撤销、剪贴板、内联插入、自动布局、空画布引导、
// 连线检查器、离开拦截、悬浮工具条）。
//
// 这些操作有一个共同的失效形态：**画布上看起来发生了，定义里没发生**。
// 撤销把节点画回来了但没存回去、粘贴出来的副本没带上内部连线、「在里面添加」
// 的节点压在 wrapper 上面却不在它的成员表里、「整理所选」顺手把没选的也挪了、
// 确认框点了取消却已经删掉了——静止的画布对这几种情况全都给出同一张图。
// 所以本文件的判据一律落在**服务端定义**（回读 `GET /api/workflows/:id`）与
// **不可伪造的界面信号**（按钮 disabled、确认框文案、拦截弹窗）上，不看画布层叠。
//
// 失效形态（这些用例红了，用户会遭遇什么）：
//   * 撤销只改了本地画布没落库 ⇒ 刷新一下删掉的节点又回来了 / 撤销白撤；
//   * 撤销后不还原选择 ⇒ 用户得自己在图里重新找回刚被撤销的那个节点；
//   * 复制粘贴丢掉切片内部的边 ⇒ 粘出来一堆彼此不相连的孤儿节点，得手工重接；
//     （Ctrl+A / 「Select all」目前是空操作，属实测出的产品缺陷，见 WF-14 上方注释）
//   * 复制 wrapper 时不展开成员闭包 / 粘出的副本成员表指回原件 ⇒ 两组共用同一批内层节点；
//   * 删 wrapper 的确认框点「取消」仍然删了 ⇒ 用户一次误点就丢掉整组节点；
//   * 连线中点插入后旧边没被顶掉 ⇒ 上游同时接到新节点和旧下游，跑起来是两条路；
//   * 「在里面添加」的节点没进 wrapper 成员表 ⇒ 它在 git wrapper 里的改动不算进 diff、
//     在 loop 里一轮都不重跑，而画布上它明明画在框里；
//   * 「整理所选」动了没选中的节点 ⇒ 用户精心摆好的那部分布局被悄悄推翻；
//   * 空画布不给入口 ⇒ 新建工作流的人对着一张白纸不知道从哪儿开始；
//   * 模板套用后没落库 / 撤销不回去 ⇒ 试一下模板就把画布弄脏且退不回来；
//   * 连线检查器允许撞名的目标端口 ⇒ 两条边并到同一个 (源, 目标端口) 上，调度器判重；
//   * 未保存草稿不拦导航 ⇒ 保存失败时点一下侧栏，这次编辑无声蒸发；
//   * 悬浮工具条的「连接下一步」在没有输出端口的节点上仍可点 ⇒ 打开一个必然接不成的弹窗。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链）：
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1929-1965   画布级快捷键注册在 `.workflow-canvas` 这个 wrapper 上（不是 document）
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1868-1917   copySelection / pasteFromClipboard（粘贴落在可视区中心）
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1921-1927   selectAll 只写 React 选择态
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2241-2257   deleteWrapperWithInner 走一次普通的可撤销事务
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:3419-3439   删 wrapper 的 ConfirmDialog（文案带内层节点数）
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2472-2545   pickNode 的四种 intent：free / after-node / inside-wrapper / insert-edge
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:3204-3221   workflow-layout-all / workflow-layout-selection 的 disabled 判据
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:3226-3255   选中节点的悬浮工具条四个按钮
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:3274-3302   空画布引导的两个入口
//   packages/frontend/src/components/canvas/WorkflowCanvasEdge.tsx:36-55   连线中点的「+」内联按钮
//   packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx:117-129 wrapper 的「在里面添加」内联按钮
//   packages/frontend/src/components/canvas/canvasCamera.ts:49-56          内联动作的可见性只由缩放决定（26px * zoom ≥ 24px）
//   packages/frontend/src/components/canvas/canvasClipboard.ts:85-145      buildSlice：只收两端都在切片内的边
//   packages/frontend/src/components/canvas/EdgeInspector.tsx:88-121       目标端口撞名拒绝提交 / 删除连线
//   packages/frontend/src/components/canvas/EdgeInspector.tsx:237-247      hasConflict 的判定（同源同目标端口才算撞）
//   packages/frontend/src/lib/workflow-connection-plan.ts:1151-1186        planWorkflowEdgeInsertion：插入必然顶掉原来那条边
//   packages/frontend/src/lib/workflow-editor-history.ts:237-277           undo / redo 各自发布一个选择还原提示
//   packages/frontend/src/lib/workflow-editor-draft.ts:427-429             `phase !== 'clean'` 即「离开不安全」
//   packages/frontend/src/components/split/UnsavedChangesGuard.tsx:159-206 留在本页 / 放弃更改两个出口
//   packages/frontend/src/routes/workflows.edit.tsx:891-946                头部撤销 / 重做按钮与它们的意图文案
//   packages/frontend/src/lib/workflow-starters.ts:131-183                 audit-only 模板固定 3 节点 2 边
//   packages/shared/src/workflowLayout.ts:412-444                          selection 模式只写选中节点，且避开未选中的矩形
//
// 与既有覆盖的边界（避免重复）：
//   * `e2e/workflow-editor.spec.ts` 的 `Ctrl+Z undoes the deletion (RFC-016 undo
//     invariant)` 已经锁了 Ctrl+Z / Ctrl+Shift+Z 这条**键盘**路径，但它只数
//     `.react-flow__node` 的个数——既没读过服务端定义（撤销有没有真的存回去），
//     也没验过头部按钮那条路径与「撤销到底把选择还给了哪个节点」。本文件补的是这三样；
//   * `e2e/rfc250-workflow-camera.spec.ts` 已锁两个内联动作的**可见性与命中面积**
//     （缩放到 overview 时它们必须离开 DOM）——但从没点过它们。本文件补的是「点下去
//     之后定义里发生了什么」；
//   * `e2e/canvas-connection-dialog.spec.ts` 锁连线弹窗内部（新建 / 复用 / 分片边界），
//     本文件只验「重新接线 / 连接下一步」这两个**入口**能把它交出来，不重复弹窗内容；
//   * `e2e/canvas-wrapper-membership.spec.ts` 锁**拖拽**建立 wrapper 归属；本文件锁的是
//     「在里面添加」这条零拖拽路径；
//   * `e2e/rfc319-canvas-inspectors.spec.ts`（并行落地）锁各类**节点**检查器的字段；
//     本文件只碰**连线**检查器，两边不相交；
//   * `unsaved-guard-dialog` 在 clarify / 任务向导 / 工作组 / 设置 / 仓库组各页都已有覆盖，
//     唯独**工作流编辑器**没有——而它是全仓唯一一个「自动保存 + 拦截」并存的页面。

// 分档（`@nightly` 标记 = 账本里的 tier，只跟着**实测墙钟与稳定性**走）：
//   * 不带标记 ⇒ PR 腿：WF-13 / WF-14 / WF-17 / WF-24 / WF-46。实测 2.9–8.6s，
//     判据全部落在 testid、对话框与服务端定义上；唯一碰画布几何的地方是
//     `selectNode`，而它先做一次 fitView，每个节点都必然进可视区——与字体度量、
//     DPI 无关，和既有的 `canvas-connection-dialog` / `canvas-wrapper-membership`
//     同一档风险。
//   * 带 `@nightly` ⇒ 夜跑腿：WF-20 / WF-21 / WF-22 / WF-38 / WF-X1。实测同样只有
//     2.6–6.3s，**不是因为慢**，而是它们的前置条件依赖**渲染出来的几何**：
//     WF-20 / WF-21 要求初始相机落在可读缩放档（由测量出的卡片尺寸决定）、
//     WF-22 要在相机对焦第一个节点后仍点得到第二个、WF-38 沿 SVG 路径取点、
//     WF-X1 在画布空白处按固定偏移右键。Linux 的字体度量与 macOS 不同，本机
//     无法证伪（`e2e/canvas-controls.ts` 记的就是这类「只在 Linux 红」的旧账），
//     所以先在夜跑腿上过一轮跨平台再谈提级。

import { expect, test, type Locator, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

interface Edge {
  id: string
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
  boundary?: string
}
type Node = Record<string, unknown> & { id: string; kind: string }
interface Definition {
  inputs: Array<Record<string, unknown> & { key: string; kind: string }>
  nodes: Node[]
  edges: Edge[]
}

let daemon: DaemonHandle
let sequence = 0
const agentIds = new Map<string, string>()

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

async function seedAgent(name: string, outputs: string[], kind = 'markdown'): Promise<void> {
  const created = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 canvas editing fixture',
      outputs,
      outputKinds: Object.fromEntries(outputs.map((port) => [port, kind])),
      readonly: true,
      bodyMd: '',
    }),
  })
  agentIds.set(name, created.id)
}

function agentId(name: string): string {
  const id = agentIds.get(name)
  if (id === undefined) throw new Error(`fixture agent '${name}' was never seeded`)
  return id
}

function agentNode(id: string, name: string, x: number, y: number): Node {
  return {
    id,
    kind: 'agent-single',
    agentId: agentId(name),
    agentName: name,
    promptTemplate: 'Do the work.',
    position: { x, y },
  }
}

async function seedWorkflow(definition: {
  inputs?: Definition['inputs']
  nodes: Node[]
  edges?: Edge[]
}): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-editing-${++sequence}`,
      description: 'RFC-319 canvas editing fixture',
      definition: {
        $schema_version: 5,
        inputs: definition.inputs ?? [],
        nodes: definition.nodes,
        edges: definition.edges ?? [],
      },
    }),
  })
  return created.id
}

const readDefinition = async (id: string): Promise<Definition> =>
  (await api<{ definition: Definition }>(`/api/workflows/${encodeURIComponent(id)}`)).definition

/**
 * 判据的落点：**服务端定义**，不是画布上画成什么。
 *
 * 编辑器是 1s 去抖自动保存（`hooks/useWorkflowEditorDraft.ts:520-525` 的
 * `debounceMs ?? 1_000`），所以这里 poll 等它落库；poll 的语义天然是「等到变成
 * 这样」，因此**只能**用于正向断言。凡是「这一笔不许落库」的负向断言，一律先做
 * 一次紧随其后的**合法**改动、等它落库当栅栏，再回头断言非法那笔没混进去
 * （见各处「栅栏」注释）——否则一次迟到的写入会从断言底下溜过去。
 */
async function expectPersisted<T>(
  workflowId: string,
  project: (definition: Definition) => T,
  expected: T,
  because: string,
): Promise<void> {
  await expect
    .poll(async () => project(await readDefinition(workflowId)), { message: because })
    .toEqual(expected)
}

const nodeIds = (definition: Definition): string[] => definition.nodes.map((node) => node.id).sort()

function edgeSignatures(definition: Definition): string[] {
  return definition.edges
    .map(
      (edge) =>
        `${edge.source.nodeId}.${edge.source.portName}→${edge.target.nodeId}.${edge.target.portName}`,
    )
    .sort()
}

function node(definition: Definition, nodeId: string): Node {
  const found = definition.nodes.find((candidate) => candidate.id === nodeId)
  if (found === undefined) throw new Error(`node '${nodeId}' vanished from the definition`)
  return found
}

function position(definition: Definition, nodeId: string): { x: number; y: number } {
  return node(definition, nodeId).position as { x: number; y: number }
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
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
}

/**
 * 等相机动画停下来。
 *
 * 相机是 180ms 的 `setCenter` 动画（`WorkflowCanvas.tsx:358-363`），动画途中
 * 拿到的 boundingBox 会在 click 落下之前失效。这里不睡固定时长，而是轮询
 * `.react-flow__viewport` 的 transform，直到**连续两次采样一模一样**——那才是
 * 「相机真的停了」的信号；机器慢就多等几轮，机器快就立刻通过。
 */
async function waitForCameraSettled(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport')
  let previous: string | null = null
  await expect
    .poll(
      async () => {
        const current = await viewport.getAttribute('style')
        const stable = current !== null && current === previous
        previous = current
        return stable
      },
      {
        message: '相机动画一直没停：后续所有 boundingBox 都会是过期坐标',
        intervals: [120, 120, 120, 120, 120, 120, 120, 120],
      },
    )
    .toBe(true)
}

/**
 * 取全图视角，让每个节点都进入可点区域。
 *
 * 画布是 transform 视口——视口外的节点在 DOM 里存在却点不到，而 `scrollIntoView`
 * 对 transform 无效。「查看全图」按钮只在当前不是 overview 时渲染
 * （`WorkflowCanvas.tsx:3171-3190` 按 cameraMode 二选一），所以先读属性再决定点不点。
 */
async function showFullGraph(page: Page): Promise<void> {
  const canvas = page.locator('.workflow-canvas')
  if ((await canvas.getAttribute('data-camera-mode')) !== 'overview') {
    await clickCanvasControl(page, 'workflow-camera-overview')
  }
  await expect(canvas).toHaveAttribute('data-camera-mode', 'overview')
  await waitForCameraSettled(page)
}

/**
 * 选中一个节点：先取全图视角保证点得到，再点它的卡片头部。
 *
 * 先取全图视角这一步不是装饰：`planInitialCanvasCamera`（canvasCamera.ts:110-131）
 * 在整图放不下时会改为只对焦一个节点，其余节点留在可视区外——那时候直接点会
 * 拿到「元素在视口外」。fitView 之后每个节点都在画布里，与字体度量无关。
 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await showFullGraph(page)
  const header = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__header`)
  await expect(header).toBeInViewport()
  await header.click()
  await expect(page.locator(`[id="workflow-inspector-field-${nodeId}-title"]`)).toBeVisible()
  await waitForCameraSettled(page)
}

/**
 * 选中一条连线，并**当场核对选中的就是它**。
 *
 * 不能用 `locator.click()`：连线是 SVG 路径，Playwright 取的是它包围盒的中心，
 * 而同一对节点之间的几条边包围盒几乎重合——点下去命中的是 DOM 里画在最上面的
 * 那条（渲染顺序 = `definition.edges` 顺序），于是「我以为在测 A，其实一直在测 B」，
 * 而且完全静默。这里改成沿**这条路径自己的几何**取一个靠近目标端的点
 * （`getPointAtLength` + `getScreenCTM`，都是浏览器自己的换算，与缩放无关），
 * 再用鼠标点该坐标；最后拿检查器里的技术 id 兜底核对。
 */
async function selectEdge(page: Page, edgeId: string): Promise<void> {
  await showFullGraph(page)
  const point = await page.evaluate((id: string) => {
    const path = document.querySelector<SVGPathElement>(
      `.react-flow__edge[data-id="${id}"] .react-flow__edge-interaction`,
    )
    if (path === null) return null
    const matrix = path.getScreenCTM()
    if (matrix === null) return null
    // 92%：两条同源边只在末端才彻底分开到各自的目标端口行上。
    const local = path.getPointAtLength(path.getTotalLength() * 0.92)
    const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  }, edgeId)
  expect(point, `连线 '${edgeId}' 在画布上没有可点的路径`).not.toBeNull()
  await page.mouse.click(point!.x, point!.y)

  const inspector = page.locator('[data-inspector-content="edge"]')
  await expect(inspector, '点中连线必须打开连线检查器').toBeVisible()
  await expect
    .poll(async () => inspector.locator('.inspector__technical-id code').textContent(), {
      message: `点击命中的不是 '${edgeId}'：几条边在画布上叠在一起，后续断言会作用在错误的边上`,
    })
    .toBe(edgeId)
  await waitForCameraSettled(page)
}

/** 节点选择器：先用唯一的代理名过滤，再点它自己的 testid，避免大目录下的翻页/滚动。 */
async function pickFromNodePicker(page: Page, agentName: string): Promise<void> {
  const dialog = page.getByTestId('workflow-node-picker-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('workflow-node-picker-search').fill(agentName)
  await page.getByTestId(`workflow-node-picker-item-agent-${agentId(agentName)}`).click()
  await expect(dialog).toBeHidden()
}

/** 共享 <Select>（Select.tsx）：trigger 是 role=combobox，列表 portal 出去。 */
async function pickSelectOption(page: Page, trigger: Locator, optionText: string): Promise<void> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const search = listbox.locator('input.select__search-input')
  if ((await search.count()) > 0) await search.fill(optionText)
  await listbox.getByRole('option', { name: optionText, exact: true }).first().click()
  await expect(listbox).toBeHidden()
}

/** 悬浮工具条（`WorkflowCanvas.tsx:3226-3255`）。 */
function nodeToolbar(page: Page): Locator {
  return page.locator('.workflow-canvas__node-actions')
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  await seedAgent('rfc319-edit-alpha', ['answer'])
  await seedAgent('rfc319-edit-beta', ['notes'])
  await seedAgent('rfc319-edit-gamma', ['done'])
  await seedAgent('rfc319-edit-inserted', ['answer'])
  await seedAgent('rfc319-edit-added', ['answer'])
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// WF-13 —— 撤销 / 重做
// ---------------------------------------------------------------------------

test('WF-13 撤销 / 重做：头部按钮与快捷键走同一条历史，撤销后落库、并把选择还回被撤销的那个节点', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('keeper', 'rfc319-edit-alpha', 80, 80),
      agentNode('victim', 'rfc319-edit-beta', 520, 80),
    ],
  })
  await openEditor(page, workflowId)

  const undo = page.getByTestId('workflow-undo')
  const redo = page.getByTestId('workflow-redo')

  // 刚打开、还没编辑过：撤销 / 重做都必须是灰的。否则用户一进来就能「撤销」，
  // 撤到的是加载期的兼容修补而不是自己的改动——那是把别人的历史交到他手里。
  await expect(undo, '刚打开、零改动时「撤销」不该可点：那会撤掉不属于用户的东西').toBeDisabled()
  await expect(redo, '刚打开、零改动时「重做」不该可点').toBeDisabled()

  await selectNode(page, 'victim')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  // 删除必须真的落库——只改画布不落库的话，刷新一下节点又回来了。
  await expectPersisted(
    workflowId,
    nodeIds,
    ['keeper'],
    '删掉的节点没有落库：用户刷新后会发现自己白删了一次',
  )

  // 按钮上写的是**这一步到底是什么**（editor.history.delete = 'Delete selection'）。
  // 只写「撤销」两个字的话，连删了三次之后用户根本不知道自己要撤回哪一次。
  await expect(undo, '「撤销」在刚删完之后必须可点').toBeEnabled()
  // 按钮里还挂着一个 ↶ 图标 span，所以判据取 `title`——它就是鼠标悬停时用户读到的那句。
  await expect(undo, '撤销按钮必须说清撤的是哪一步，否则多步之后无从判断').toHaveAttribute(
    'title',
    'Undo: Delete selection',
  )

  // ① 头部按钮这条路径。
  await undo.click()
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await expectPersisted(
    workflowId,
    nodeIds,
    ['keeper', 'victim'],
    '撤销只改了本地画布、没有存回去：刷新之后节点又不见了，撤销等于白撤',
  )
  // 撤销把选择还给刚被恢复的节点——否则用户得自己在图里重新找回它。
  await expect(
    page.locator('[id="workflow-inspector-field-victim-title"]'),
    '撤销之后没有把选择还给被恢复的节点：用户得自己在图里重新找它',
  ).toBeVisible()
  await expect(redo, '撤销之后「重做」必须可点并说清重做的是哪一步').toHaveAttribute(
    'title',
    'Redo: Delete selection',
  )

  // ② 快捷键这条路径。快捷键注册在 `.workflow-canvas` 这个 wrapper 上
  //    （WorkflowCanvas.tsx:1963），不是 document——点过头部按钮之后焦点在按钮上，
  //    必须先把焦点交回画布，否则按键根本到不了处理器。
  await page.locator('.workflow-canvas').focus()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expectPersisted(
    workflowId,
    nodeIds,
    ['keeper'],
    'Ctrl+Shift+Z 重做没有落库：重做出来的状态只活在这一个标签页里',
  )

  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  await expectPersisted(
    workflowId,
    nodeIds,
    ['keeper', 'victim'],
    'Ctrl+Z 撤销没有落库：与头部按钮不是同一条历史，两个入口会给出不同结果',
  )

  // 回到起点：整条历史只有一步，撤到底之后「撤销」必须重新变灰。
  await expect(undo, '撤到历史起点后「撤销」仍可点：说明历史指针没有归零').toBeDisabled()
})

// ---------------------------------------------------------------------------
// WF-14 —— 画布剪贴板（复制 / 粘贴切片）
// ---------------------------------------------------------------------------
//
// 【为什么这条用例里没有 Ctrl+A 的断言】实测（2026-08-25，pinned-w6b）：Ctrl+A
// 与右键菜单里的「Select all」**都是空操作**——`selectAll`（WorkflowCanvas.tsx:1921-1927）
// 只写 React 的 `selection` 状态，不去动 xyflow 自己的选中标记；而 xyflow 在下一次
// store 更新时又会通过 `onSelectionChange`（同文件 :2903-2921）用它自己那份**空**的
// 选择集把 `selection` 覆盖回去。外部读数（「整理所选」的 disabled）连续采样 8 次 / 6 次
// 全是 disabled，Shift 多选这条 xyflow 原生路径同一时刻是 enabled。这是**产品缺陷**，
// 已单独报出登记 backlog；这里**故意不写断言**，免得把错误行为锁成契约。
// 修好之后请在此补一条：Ctrl+A ⇒「整理所选」可点 + Ctrl+C 能把整图放进剪贴板。

test('WF-14 画布剪贴板：复制一个 wrapper 会连内层节点与内部连线整片复制，粘贴出的副本自成一组，一次撤销全收回', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      {
        id: 'wrap',
        kind: 'wrapper-git',
        nodeIds: ['producer', 'consumer'],
        position: { x: 80, y: 60 },
        size: { width: 700, height: 300 },
      },
      agentNode('producer', 'rfc319-edit-alpha', 120, 140),
      agentNode('consumer', 'rfc319-edit-beta', 460, 140),
    ],
    edges: [
      {
        id: 'e_wire',
        source: { nodeId: 'producer', portName: 'answer' },
        target: { nodeId: 'consumer', portName: 'answer' },
      },
    ],
  })
  await openEditor(page, workflowId)

  // 只选中 wrapper 这**一个**节点：切片按设计要递归展开它的成员闭包
  // （canvasClipboard.ts:85-145），所以单选也应当复制出「wrapper + 两个内层 + 内部边」。
  // 这条路径顺带绕开了 Shift 多选在 webkit 上的不稳定，两个浏览器腿都能跑。
  await selectNode(page, 'wrap')
  await page.locator('.workflow-canvas').focus()
  await expect(page.locator('.workflow-canvas')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+c')
  await page.keyboard.press('ControlOrMeta+v')

  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await expectPersisted(
    workflowId,
    (definition) => definition.nodes.length,
    6,
    '粘贴出来的节点没落库：刷新之后副本消失，用户以为自己复制成功了',
  )

  const pasted = await readDefinition(workflowId)
  const original = new Set(['wrap', 'producer', 'consumer'])
  const fresh = pasted.nodes.filter((candidate) => !original.has(candidate.id))
  expect(
    fresh.map((candidate) => candidate.kind).sort(),
    '复制一个 wrapper 必须把它的内层一起搬走：只复制外框会粘出一个空 wrapper',
  ).toEqual(['agent-single', 'agent-single', 'wrapper-git'])

  // 副本必须**自成一组**：新 wrapper 的成员表若还指着老节点，两组会共用同一批内层，
  // 改一处两处一起变，而画布上完全看不出来。
  const freshWrapper = fresh.find((candidate) => candidate.kind === 'wrapper-git')!
  const freshAgents = fresh
    .filter((candidate) => candidate.kind === 'agent-single')
    .map((candidate) => candidate.id)
  expect(
    (freshWrapper.nodeIds as string[]).slice().sort(),
    '粘出来的 wrapper 成员表指回了原件的节点：两个 wrapper 共用同一批内层，改一处两处一起变',
  ).toEqual(freshAgents.slice().sort())

  // 切片的价值全在**内部的边**：只搬节点不搬边的实现，粘出来是两张互不相连的
  // 孤儿卡片，用户得手工把线重新接一遍——而它在画布上和接好了长得一模一样。
  const signatures = edgeSignatures(pasted)
  expect(signatures, '粘贴出来的子图丢了内部连线：用户拿到的是两张互不相连的孤儿卡片').toHaveLength(
    2,
  )
  expect(
    signatures.filter((signature) => signature === 'producer.answer→consumer.answer'),
    '原来那条边不该在粘贴中被改动',
  ).toHaveLength(1)
  const [first, second] = freshAgents as [string, string]
  const copied = signatures.filter(
    (signature) => signature !== 'producer.answer→consumer.answer',
  )[0]
  expect(
    [`${first}.answer→${second}.answer`, `${second}.answer→${first}.answer`],
    '复制出来的那条边必须连在两个新节点之间；连回旧节点意味着副本和原件共用了上游',
  ).toContain(copied)

  // 粘贴是**一次**可撤销事务：如果它被拆成「加节点 / 加边」多笔，用户按一次
  // Ctrl+Z 只能撤回一半，画布会停在一个半截状态。
  await page.locator('.workflow-canvas').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expectPersisted(
    workflowId,
    (definition) => [definition.nodes.length, definition.edges.length],
    [3, 1],
    '一次撤销没有把整片粘贴收回去：用户会停在一个半截的画布上',
  )
})

// ---------------------------------------------------------------------------
// WF-17 —— 删除含内层节点的 wrapper
// ---------------------------------------------------------------------------

test('WF-17 删除含内层节点的 wrapper：确认框如实报出内层数量，取消什么都不发生，确认才连内层一起删', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      {
        id: 'wrap',
        kind: 'wrapper-git',
        nodeIds: ['inner_one', 'inner_two'],
        position: { x: 80, y: 60 },
      },
      agentNode('inner_one', 'rfc319-edit-alpha', 140, 140),
      agentNode('inner_two', 'rfc319-edit-beta', 140, 380),
    ],
  })
  await openEditor(page, workflowId)

  const undo = page.getByTestId('workflow-undo')
  await expect(undo, '刚打开时不该有可撤销的历史').toBeDisabled()

  await selectNode(page, 'wrap')
  await nodeToolbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete wrapper and inner nodes' }).click()

  const confirm = page.getByRole('dialog', { name: 'Delete wrapper and inner nodes' })
  await expect(
    confirm,
    '删 wrapper 必须先问一句：这一下会连内层节点一起没，静默执行等于一次误点丢掉整组工作',
  ).toBeVisible()
  await expect(
    confirm,
    '确认框必须说清会连带删掉几个内层节点，只说「删除 wrapper」会让人以为内层留得下来',
  ).toContainText('all 2 inner node(s)')

  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()

  // 「取消了什么都没发生」的判据不能只看画布还画着三个框——**历史指针**才是
  // 不可伪造的读数：真删过就必然记下一笔可撤销事务，撤销按钮就会亮。
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await expect(
    undo,
    '点了「取消」，撤销按钮却亮了：说明删除其实已经执行过一次，确认框形同虚设',
  ).toBeDisabled()

  await nodeToolbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete wrapper and inner nodes' }).click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()

  await expect(page.getByTestId('workflow-canvas-empty')).toBeVisible()
  await expectPersisted(
    workflowId,
    nodeIds,
    [],
    '确认删除后 wrapper 或它的内层节点还留在定义里：用户看着画布空了，实际留下了跑不到的孤儿节点',
  )
  await expect(undo, '删 wrapper 必须是一次可撤销事务，否则误删就只能重建').toHaveAttribute(
    'title',
    'Undo: Delete selection',
  )
})

// ---------------------------------------------------------------------------
// WF-20 —— 连线中点「插入节点」
// ---------------------------------------------------------------------------

test('WF-20 连线中点「插入节点」：新节点接在中间，原来那条边被顶掉而不是并存 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      // 图故意摆得紧凑：`planInitialCanvasCamera`（canvasCamera.ts:110-131）在
      // 整图能以 ≥1.1 的缩放放下时才 fit-all，否则改为对焦单个节点、其余节点
      // 落到可视区外。紧凑布局保证初始视角就是「全都看得见且是可读档」，
      // 中点的「+」因此天然达到可点尺寸，无需先绕一圈相机。
      agentNode('upstream', 'rfc319-edit-alpha', 80, 120),
      agentNode('downstream', 'rfc319-edit-gamma', 420, 120),
    ],
    edges: [
      {
        id: 'e_direct',
        source: { nodeId: 'upstream', portName: 'answer' },
        target: { nodeId: 'downstream', portName: 'answer' },
      },
    ],
  })
  await openEditor(page, workflowId)

  // 「+」不需要先选中这条边——它对每条可插入的边常驻渲染，只被缩放挡住
  //（canvasCamera.ts:49-56：26px × zoom ≥ 24px）。
  const insert = page.getByRole('button', { name: 'Insert a step on this connection' })
  await expect(
    insert,
    '可读档下连线中点必须给出「插入一步」的入口——没有它，用户只能删边、加节点、再手工接两次',
  ).toBeVisible()
  await insert.click()

  await pickFromNodePicker(page, 'rfc319-edit-inserted')

  await expectPersisted(
    workflowId,
    (definition) => definition.nodes.length,
    3,
    '中点插入没有真的加进一个节点',
  )

  const after = await readDefinition(workflowId)
  const inserted = after.nodes.find(
    (candidate) => candidate.id !== 'upstream' && candidate.id !== 'downstream',
  )
  expect(inserted, '插入的节点不在定义里').toBeTruthy()

  // 「顶掉旧边」是这个动作的全部意义：旧边若并存，上游会同时喂给新节点和旧下游，
  // 跑起来是两条路——而画布上多出来的那条线细得根本注意不到。
  expect(
    edgeSignatures(after),
    '插入之后旧的直连边没被顶掉：上游同时接到新节点和旧下游，任务会沿两条路各跑一次',
  ).toEqual(
    [`upstream.answer→${inserted!.id}.answer`, `${inserted!.id}.answer→downstream.answer`].sort(),
  )
  expect(
    after.edges.some((edge) => edge.id === 'e_direct'),
    '被替换掉的边 id 仍然留在定义里',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// WF-21 —— wrapper 内联「在里面添加」
// ---------------------------------------------------------------------------

test('WF-21 wrapper 内联「在里面添加」：新节点真的进了成员表，而不是压在 wrapper 上面 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      {
        id: 'wrap',
        kind: 'wrapper-git',
        nodeIds: ['seeded_inner'],
        position: { x: 120, y: 80 },
        // 显式尺寸：没有 `size` 时 wrapper 的渲染矩形由内层 bbox 反推
        // （coordProjection.ts:111-118 的 computeFitBounds），内层节点会被贴到
        // 紧挨头部的位置、正好压住「在里面添加」按钮（实测：按钮 y 334-367，
        // 内层卡片 icon y 342-384，按钮中心命中的是内层卡片）。给一个够大的
        // 显式尺寸，wrapper 才按作者摆的坐标渲染，内层也才留在下方。
        size: { width: 520, height: 460 },
      },
      agentNode('seeded_inner', 'rfc319-edit-alpha', 160, 380),
    ],
  })
  await openEditor(page, workflowId)

  // 内联动作不需要先选中 wrapper——它只被缩放挡住（canvasCamera.ts:49-56），
  // 而小图的初始相机必然停在可读档。`clickCanvasControl` 在点击前做一次
  // elementFromPoint 命中测试：真被别的浮层盖住时当场报出双方矩形，
  // 而不是丢一个没有线索的 15s 超时。
  await expect(
    page.getByTestId('wrapper-add-inside-wrap'),
    'wrapper 上必须有「在里面添加」的零拖拽入口：否则想往 wrapper 里加一步只能靠像素级拖拽命中它的矩形',
  ).toBeVisible()
  await clickCanvasControl(page, 'wrapper-add-inside-wrap')

  await pickFromNodePicker(page, 'rfc319-edit-added')

  await expectPersisted(
    workflowId,
    (definition) => definition.nodes.length,
    3,
    '「在里面添加」没有真的加进一个节点',
  )

  const after = await readDefinition(workflowId)
  const added = after.nodes.find(
    (candidate) => candidate.id !== 'wrap' && candidate.id !== 'seeded_inner',
  )
  expect(added, '新加的节点不在定义里').toBeTruthy()

  // wrapper 的归属只由 `nodeIds` 说了算。画布上画在框里、成员表里没有它，
  // 就意味着它在 git wrapper 里的改动不算进 diff、在 loop 里一轮都不重跑——
  // 而这件事从静止的画布上一点都看不出来。
  expect(
    (node(after, 'wrap').nodeIds as string[]).slice().sort(),
    '新节点没进 wrapper 的成员表：它画在框里却不属于这个 wrapper，执行语义完全不同',
  ).toEqual(['seeded_inner', added!.id].sort())

  // 落点必须在 wrapper 的内容区（WorkflowCanvas.tsx:2500-2508 的 +40 / +64），
  // 否则新节点会盖在 wrapper 头部或直接落到框外，看着像没加进去。
  expect(
    position(after, added!.id),
    '新节点没落在 wrapper 的内容区里：视觉上会盖住 wrapper 头部或干脆落在框外',
  ).toEqual({ x: 160, y: 144 })
})

// ---------------------------------------------------------------------------
// WF-22 —— 自动布局（全部 / 仅选中）
// ---------------------------------------------------------------------------

test('WF-22 自动布局：「整理所选」一个像素都不碰没选中的节点，「整理全图」把整条链按拓扑排开 @nightly', async ({
  page,
  browserName,
}) => {
  // Shift 多选在 Playwright 的 webkit 构建上不稳（xyflow 的第二次点击会顶掉
  // 第一次的选择，与 `workflow-editor.spec.ts:358` 记录的是同一个上游问题）。
  // 「仅选中」这一档必须先精确选出两个节点，所以整条用例在 webkit 上不成立。
  test.skip(
    browserName === 'webkit',
    'xyflow Shift+click multi-select not stable on Playwright webkit',
  )

  // 故意把拓扑顺序和横坐标摆反：a → b → c 三个节点从右往左排。
  // 布局若什么都没做，下面按 x 递增的断言就会红。
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('chain_a', 'rfc319-edit-alpha', 520, 40),
      agentNode('chain_b', 'rfc319-edit-beta', 280, 180),
      agentNode('chain_c', 'rfc319-edit-gamma', 40, 320),
    ],
    edges: [
      {
        id: 'e_ab',
        source: { nodeId: 'chain_a', portName: 'answer' },
        target: { nodeId: 'chain_b', portName: 'answer' },
      },
      {
        id: 'e_bc',
        source: { nodeId: 'chain_b', portName: 'notes' },
        target: { nodeId: 'chain_c', portName: 'notes' },
      },
    ],
  })
  await openEditor(page, workflowId)

  const layoutAll = page.getByTestId('workflow-layout-all')
  const layoutSelection = page.getByTestId('workflow-layout-selection')
  await expect(layoutAll, '有两个以上节点时「整理全图」必须可点').toBeEnabled()
  await expect(layoutSelection, '没选中任何节点时「整理所选」不该可点').toBeDisabled()

  const seeded = await readDefinition(workflowId)
  const untouchedBefore = position(seeded, 'chain_c')

  // 两次点击都停在 readable-focus 档：overview 档下的节点点击走的是
  // `activateOverviewSelection`（WorkflowCanvas.tsx:2925-2928），它按设计**替换**
  // 选择而不是扩展，Shift 在那条路径上没有意义。第一次点击会把相机移到 chain_a，
  // 所以先等它停稳再点第二个，否则拿到的是过期坐标。
  await page.locator('.react-flow__node[data-id="chain_a"] .canvas-node__header').click()
  await waitForCameraSettled(page)
  await page
    .locator('.react-flow__node[data-id="chain_b"] .canvas-node__header')
    .click({ modifiers: ['Shift'] })
  await expect(page.locator('.react-flow__node[data-id="chain_a"]')).toHaveClass(/selected/)
  await expect(page.locator('.react-flow__node[data-id="chain_b"]')).toHaveClass(/selected/)
  await expect(layoutSelection, '选中两个节点后「整理所选」必须可点').toBeEnabled()

  await clickCanvasControl(page, 'workflow-layout-selection')

  await expect
    .poll(
      async () => {
        const current = await readDefinition(workflowId)
        return position(current, 'chain_a').x < position(current, 'chain_b').x
      },
      { message: '「整理所选」没有把选中的两个节点按依赖方向排开' },
    )
    .toBe(true)

  const afterSelection = await readDefinition(workflowId)
  // 「仅选中」的全部承诺就在这一行：没选中的那个必须**一个像素都不动**。
  // 动了它，用户精心摆好的其余部分会被一次「整理所选」悄悄推翻。
  expect(
    position(afterSelection, 'chain_c'),
    '「整理所选」把没选中的节点也挪了：用户摆好的其余布局被无声推翻',
  ).toEqual(untouchedBefore)

  await clickCanvasControl(page, 'workflow-layout-all')
  await expect
    .poll(
      async () => {
        const current = await readDefinition(workflowId)
        const a = position(current, 'chain_a').x
        const b = position(current, 'chain_b').x
        const c = position(current, 'chain_c').x
        return a < b && b < c
      },
      {
        message:
          '「整理全图」没有按 a → b → c 的依赖方向从左往右排开：自动布局对乱掉的画布毫无帮助',
      },
    )
    .toBe(true)

  await expect(page.getByTestId('workflow-undo'), '自动布局必须可撤销').toHaveAttribute(
    'title',
    'Undo: Auto-layout workflow',
  )
})

// ---------------------------------------------------------------------------
// WF-24 —— 空画布引导
// ---------------------------------------------------------------------------

test('WF-24 空画布引导：「添加第一个节点」落下第一步，「从模板开始」把整套审计模板一次接好且一次撤销退得回来', async ({
  page,
}) => {
  const blankId = await seedWorkflow({ nodes: [] })
  await openEditor(page, blankId)

  const empty = page.getByTestId('workflow-canvas-empty')
  await expect(
    empty,
    '空工作流必须给出引导：否则新建之后是一张白纸，用户不知道从哪儿开始',
  ).toBeVisible()
  await expect(empty).toContainText('Build your workflow')

  await page.getByTestId('workflow-empty-add-first').click()
  await pickFromNodePicker(page, 'rfc319-edit-alpha')
  await expect(empty, '加进第一个节点之后空画布引导还挂着：它会盖住刚加进来的那张卡片').toBeHidden()
  await expectPersisted(
    blankId,
    (definition) => definition.nodes.length,
    1,
    '「添加第一个节点」加出来的节点没落库',
  )

  // 模板这一档要在**真正空**的画布上验：非空画布会先要一次「替换」二次确认
  //（WorkflowStarterDialog.tsx:221-225），那是另一条分支。
  const templateId = await seedWorkflow({ nodes: [] })
  await openEditor(page, templateId)
  await page.getByTestId('workflow-empty-start-template').click()

  const starter = page.getByTestId('workflow-starter-dialog')
  await expect(starter, '「从模板开始」必须交出模板选择框').toBeVisible()
  await page.getByTestId('workflow-starter-audit-only').click()
  await expect(
    page.getByTestId('workflow-starter-preview'),
    '模板必须先说清它会造出多少节点和连线，否则用户是在盲点「应用」',
  ).toHaveText('Creates 3 nodes and 2 connections.')
  await expect(
    page.getByTestId('workflow-starter-valid'),
    '模板必须先拿当前资源校验过再让人应用，否则应用完当场是一张跑不起来的图',
  ).toBeVisible()

  await page.getByTestId('workflow-starter-apply').click()
  await expect(starter).toBeHidden()

  await expectPersisted(
    templateId,
    nodeIds,
    ['starter_auditor', 'starter_input', 'starter_output'],
    '模板套用后没落库：用户以为一键搭好了，刷新回来还是白纸',
  )
  const applied = await readDefinition(templateId)
  expect(
    edgeSignatures(applied),
    '模板只造了节点没接线：用户拿到三张互不相连的卡片，等于什么都没省',
  ).toEqual(
    [
      'starter_input.artifact→starter_auditor.artifact',
      'starter_auditor.answer→starter_output.audit_report',
    ].sort(),
  )
  expect(
    applied.inputs.map((input) => input.key),
    '模板没带上启动器输入字段：任务启动时没有地方填待审物',
  ).toEqual(['artifact'])

  // 试一下模板必须退得回来——一次撤销回到空画布，否则「试试看」等于把画布弄脏。
  await expect(page.getByTestId('workflow-undo')).toHaveAttribute(
    'title',
    'Undo: Apply workflow starter',
  )
  await page.getByTestId('workflow-undo').click()
  await expectPersisted(
    templateId,
    (definition) => [definition.nodes.length, definition.edges.length, definition.inputs.length],
    [0, 0, 0],
    '一次撤销退不回空画布：用户只是想试一下模板，结果画布被永久弄脏',
  )
})

// ---------------------------------------------------------------------------
// WF-38 —— 连线检查器
// ---------------------------------------------------------------------------

test('WF-38 连线检查器：撞名的目标端口被当场拒绝、删除连线真的删掉、重新接线交回连线弹窗 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('src_a', 'rfc319-edit-alpha', 60, 40),
      agentNode('src_b', 'rfc319-edit-beta', 60, 300),
      agentNode('sink', 'rfc319-edit-gamma', 460, 160),
    ],
    edges: [
      {
        id: 'e_brief',
        source: { nodeId: 'src_a', portName: 'answer' },
        target: { nodeId: 'sink', portName: 'brief' },
      },
      {
        id: 'e_context',
        source: { nodeId: 'src_b', portName: 'notes' },
        target: { nodeId: 'sink', portName: 'context' },
      },
      {
        id: 'e_clash',
        source: { nodeId: 'src_a', portName: 'answer' },
        target: { nodeId: 'sink', portName: 'context' },
      },
    ],
  })
  await openEditor(page, workflowId)

  // 先挑 `e_clash`：它和 `e_brief` 同源（src_a.answer），把它改名成 brief 就会
  // 撞上 `e_brief`——与反过来改是同一条不变量，但 `e_clash` 是定义里最后一条边、
  // 在画布上画在最上层，选中它不依赖任何叠放运气。
  await selectEdge(page, 'e_clash')
  const inspector = page.locator('[data-inspector-content="edge"]')
  await expect(
    inspector,
    '点中一条连线必须打开连线检查器：否则改目标端口只能靠删边重连或改 YAML',
  ).toBeVisible()
  await expect(
    inspector,
    '检查器必须点名这条边的来源端口，否则同一目标的几条入边根本分不清谁是谁',
  ).toContainText('answer')

  // ① 撞名：`e_brief` 已经是 src_a.answer → sink.brief，把 `e_clash` 也改成
  //    brief 会造出两条同源同目标端口的边——放过去的话调度器判重，
  //    而用户只是在下拉框里选了一项。
  await pickSelectOption(page, inspector.getByRole('combobox').first(), 'brief')
  await expect(
    inspector.locator('.error-box').first(),
    '撞名的目标端口没有当场拒绝：两条同源同端口的边会一起落库，任务启动时才炸',
  ).toContainText('already exists')

  // ② 删除：这一步同时是上面那条负向断言的**栅栏**——删除是一次确定会落库的
  //    写入，它落库之后 `e_clash` 若真的改过名，改名早就一并落库了；
  //    此时仍看得到 `e_brief` 停在 brief、只有两条边，才能证明撞名那笔没混进去。
  await page.getByRole('button', { name: 'Delete edge' }).click()
  await expectPersisted(
    workflowId,
    (definition) => definition.edges.map((edge) => edge.id).sort(),
    ['e_brief', 'e_context'],
    '「删除连线」没有真的把边删掉：画布上线没了，定义里还连着',
  )
  const afterDelete = await readDefinition(workflowId)
  expect(
    afterDelete.edges.find((edge) => edge.id === 'e_brief')?.target.portName,
    '被拒绝的撞名改名其实还是落库了：拒绝只停在界面上，数据已经脏了',
  ).toBe('brief')

  // ③ 撞名的对手没了之后，同一个方向的改名必须能成功——否则拒绝的是「这个名字」
  //    而不是「这次冲突」，用户会以为端口名被永久占用。
  await selectEdge(page, 'e_brief')
  await pickSelectOption(page, inspector.getByRole('combobox').first(), 'context')
  await expectPersisted(
    workflowId,
    (definition) => definition.edges.find((edge) => edge.id === 'e_brief')?.target.portName,
    'context',
    '冲突解除后改名仍不生效：用户会以为这个端口名被永久占用了',
  )

  // ④ 重新接线：本文件只验这个**入口**把连线弹窗交了出来；弹窗内部由
  //    `canvas-connection-dialog.spec.ts` 负责，不在这里重复。
  await page.getByRole('button', { name: 'Reconnect endpoints' }).click()
  await expect(
    page.getByTestId('connection-submit'),
    '「重新接线」点了没反应：想换端点只能删掉重连，途中会丢掉这条边上的配置',
  ).toBeVisible()
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// WF-46 —— 离开未保存草稿的导航拦截
// ---------------------------------------------------------------------------

test('WF-46 离开未保存草稿：保存失败时导航被拦下，「留在本页」原地不动、「放弃更改」才真的走', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [agentNode('lonely', 'rfc319-edit-alpha', 120, 120)],
  })
  await openEditor(page, workflowId)

  // 编辑器是 1s 去抖自动保存，脏窗口只有一瞬——靠「趁去抖没结束赶紧点导航」
  // 是在赌墙钟。这里把保存这一条路径钉死成失败，草稿就**确定**停在非 clean 相位
  //（workflow-editor-draft.ts:427-429），拦截条件不再依赖时序。
  const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== 'PUT') {
      // 同一路径上的 GET 必须原样回源；这里只用 continue，不用 route.fetch()
      //（docs/dev-gotchas.md：只有 fetch() 会在 page 关掉时抛错）。
      await route.continue()
      return
    }
    // 必须是一个**确定**的 4xx 判决：`workflow-editor-draft.ts:659-663` 把
    // 5xx / 429 / 网络失败一律当作「结果不确定」，那会转进 reconciling 并反复重试，
    // 相位在 Saving / Checking save result 之间来回跳，拿不到稳定读数。
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'rfc319 injected save refusal' }),
    })
  })

  await selectNode(page, 'lonely')
  await page.keyboard.press('Backspace')
  await expect(
    page.getByTestId('workflow-draft-phase'),
    '保存失败必须如实写在页面上，否则用户以为已经保存了',
  ).toHaveText('Save failed')

  const homeLink = page.getByTestId('shell-navigation-desktop').locator('a.nav-item--home')

  await homeLink.click()
  const guard = page.getByTestId('unsaved-guard-dialog')
  await expect(
    guard,
    '保存失败时点侧栏就直接走了：这次编辑无声蒸发，用户到别的页面才发现',
  ).toBeVisible()
  await expect(
    page.getByTestId('unsaved-stay'),
    '拦截弹窗默认焦点必须落在「留在本页」上：默认动作不能是丢工作',
  ).toBeFocused()

  await page.getByTestId('unsaved-stay').click()
  await expect(guard).toBeHidden()
  expect(page.url(), '点了「留在本页」却还是跳走了：拦截弹窗的两个出口接反了').toContain(workflowId)
  await expect(page.locator('.workflow-canvas'), '留在本页之后编辑器必须还在').toBeVisible()

  await homeLink.click()
  await expect(guard).toBeVisible()
  await page.getByTestId('unsaved-discard').click()
  await expect
    .poll(() => new URL(page.url()).pathname, {
      message: '明确选了「放弃更改」却仍被卡在编辑器上：用户没有任何办法离开这一页',
    })
    .toBe('/')

  // 判据不能只看地址栏：路由状态变了而页面没换，用户仍被困在同一个编辑器上。
  await expect(
    page.locator('.workflow-canvas'),
    '地址变了但编辑器还挂着：导航只走了一半，用户看到的仍是那张画布',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// WF-X1 —— 选中节点的悬浮工具条
// ---------------------------------------------------------------------------

test('WF-X1 选中节点的悬浮工具条：+ 加下一步落在右侧、连接下一步在没有输出时禁用、复制填得进剪贴板、⋯ 交出更多动作 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('anchor', 'rfc319-edit-alpha', 120, 160),
      // 输出节点故意摆得远一点：「+ 加下一步」的落点会自动避开已有矩形
      // （WorkflowCanvas.tsx 的 findOpenPlacement），挨着放会让下面那条坐标断言
      // 变成在断言避让算法，而不是断言「放在右侧」这条契约。
      { id: 'terminal', kind: 'output', ports: [], position: { x: 640, y: 620 } },
    ],
  })
  await openEditor(page, workflowId)

  await selectNode(page, 'anchor')
  const toolbar = nodeToolbar(page)
  await expect(
    toolbar,
    '选中节点后没有悬浮工具条：加下一步 / 连线 / 复制都只能翻右键菜单',
  ).toBeVisible()

  // ① 「复制」按钮到底有没有把切片放进剪贴板，唯一的外部读数是画布右键菜单里
  //    「Paste」这一项的 disabled（WorkflowCanvas.tsx:2680-2686）。所以先证明它原本是灰的。
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 40, y: 40 } })
  await expect(
    page.getByRole('menuitem', { name: 'Paste' }),
    '剪贴板还是空的时候「粘贴」不该可点',
  ).toBeDisabled()
  await page.keyboard.press('Escape')

  await toolbar.getByRole('button', { name: 'Copy', exact: true }).click()
  await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 40, y: 40 } })
  await expect(
    page.getByRole('menuitem', { name: 'Paste' }),
    '点了工具条上的「复制」，剪贴板却还是空的：用户接着去粘贴会发现什么都没有',
  ).toBeEnabled()
  await page.keyboard.press('Escape')

  // ② 「连接下一步」必须在没有输出端口的节点上禁用——output 节点接不出任何东西，
  //    放它可点只会打开一个必然接不成的弹窗。
  await selectNode(page, 'anchor')
  await expect(
    toolbar.getByRole('button', { name: 'Connect next step' }),
    '有输出端口的节点上「连接下一步」必须可点',
  ).toBeEnabled()
  await toolbar.getByRole('button', { name: 'Connect next step' }).click()
  await expect(
    page.getByTestId('connection-submit'),
    '「连接下一步」点了不给弹窗：这个按钮等于没有',
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await selectNode(page, 'terminal')
  await expect(
    toolbar.getByRole('button', { name: 'Connect next step' }),
    '输出节点没有任何输出端口，「连接下一步」却可点：打开的是一个必然接不成的弹窗',
  ).toBeDisabled()

  // ③ 「⋯ 更多」交出的是节点级动作菜单。
  await toolbar.getByRole('button', { name: 'More actions' }).click()
  const menu = page.getByRole('menu')
  await expect(menu, '「⋯」点了不给菜单：复制 / 打包 / 删除这些动作全都没有入口').toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Wrap in git wrapper' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // ④ 「+ 加下一步」把新节点放在被选节点的右侧（WorkflowCanvas.tsx:2489-2496：
  //    x + 卡片宽 + 80，y 不变），这样它天然排在数据流的下游位置。
  await selectNode(page, 'anchor')
  await toolbar.getByRole('button', { name: 'Add a step after this one' }).click()
  await pickFromNodePicker(page, 'rfc319-edit-added')

  await expectPersisted(
    workflowId,
    (definition) => definition.nodes.length,
    3,
    '「+ 加下一步」没有真的加进节点',
  )
  const after = await readDefinition(workflowId)
  const added = after.nodes.find(
    (candidate) => candidate.id !== 'anchor' && candidate.id !== 'terminal',
  )
  expect(added, '新加的节点不在定义里').toBeTruthy()
  expect(
    position(after, added!.id),
    '「加下一步」没把新节点放在被选节点右侧：它会落在别处甚至压住原节点，用户还得先去找它',
  ).toEqual({ x: 480, y: 160 })
})

test.afterEach(async ({ page }) => {
  // 先摘掉全部注入，再**趁 page 还活着**把已经在跑的 handler 等完；拆环境时就
  // 不存在「还在飞的 callback」。必须是 'wait'，`ignoreErrors` 只是把错吞掉。
  await page.unrouteAll({ behavior: 'wait' })
})
