// RFC-319 —— WF-11 / 15 / 33 / 34 / 35 / 37 / 40 / 52 / 56：工作流编辑器里
// **「配置得住、看得见、拦得下」** 的九条能力（节点检查器的三类特殊节点、join
// 模式、特权节点遮蔽、右键菜单、校验回执过期、配置包导出围栏、wrapper 自动适配）。
//
// 这一批的共同失效形态是：**界面上做过了，服务端定义里没做过**，或者反过来——
// **服务端已经变了，界面还在用旧结论**。静止的画布对这两件事都给不出信号：
// 一个 `workflowName` 写下了但 `workflowId` 没写下的 call 节点、一个语言切成
// bash 却还留着 python 正文的 script 节点、一个 joinMode 存了 `'any'` 字面量
// 而不是删字段的节点、一份对着三个版本以前的草稿签发的校验回执——它们在画布上
// 与正确的版本长得一模一样。所以本文件的判据一律落在
//   ① **回读服务端定义**（`GET /api/workflows/:id`），
//   ② **不可伪造的界面信号**（`aria-disabled` / `aria-checked` / 按钮 disabled /
//      过期横幅逐字文案 / 出站请求的 query 参数），
//   ③ **服务端拒绝码**（`package-root-changed`）。
// 不看画布层叠，不看「元素存在」这种对任何已渲染页面都成立的量。
//
// 失效形态（这些用例红了，用户会遭遇什么）：
//   * WF-33 —— call-workflow 只写下名字不写下 id ⇒ 目标工作流改名后这个节点静默
//     绑到另一份同名工作流上（或直接找不到），而作者从没动过它；子工作流端口
//     预览错了 ⇒ 作者按预览接线，启动时才发现端口根本不存在；引用不可见时不给
//     中性占位 ⇒ 要么白屏、要么从错误信息里漏出「这个 id 确实存在」；把正在编辑的
//     这份工作流自己列进候选 ⇒ 一次点击就造出自调用死循环；上限存成 0 / 小数
//     ⇒ 子任务开跑即超时，或 schema 直接拒绝保存。
//   * WF-34 —— 工作组引用同上；`goalTemplate` 是父流程交给子工作组的**唯一**指令，
//     写丢了子任务拿到一句空目标；结果端口说明消失 ⇒ 作者会去找一个并不存在的
//     端口配置入口。
//   * WF-35 —— 脚本节点的五个旋钮各自对应一次真实事故：语言切了正文没跟着切
//     ⇒ 用 bash 解释器跑 python 正文；全屏编辑器写的字不落库 ⇒ 用户写完一屏代码
//     刷新就没了；依赖不强制精确固定 ⇒ 上游发新版当天流水线换了行为；环境变量
//     允许覆盖平台保留键 ⇒ 脚本能改写 `AW_*` 契约；readonly 关掉时留下
//     `readonly:false` 而不是删字段 ⇒ 导出的 YAML 与「从没设置过」不再等价。
//   * WF-37 —— join 模式是 RFC-306 条件分支的收口开关。存不住 ⇒ 分支合流处要么
//     一条腿没到就开跑（数据不全），要么永远等一条被关掉的腿（任务挂死）；
//     单入站节点上还给选择 ⇒ 作者拨了个不起作用的开关并据此推理。
//   * WF-11 —— 无 `scripts:author` / `code-host-calls:author` 的人若能从调色板
//     拖出特权节点，他会写完一整个节点然后在保存时吃拒绝；若能在检查器里读到
//     正文，那条「谁能读 = 谁能写」的判据就破了（服务端此时只会送来 `***`，
//     渲染出来是一排星号，比明说更糟）。
//   * WF-15 —— 右键菜单是画布上最快的一条动作路径。wrapper 专属项在普通节点上
//     不置灰 ⇒ 点下去什么都不发生（用户会以为画布卡死）；同样三项在 wrapper 上
//     也置灰 ⇒ 这三项等于不存在；「复制」/「删除」只关菜单不落库 ⇒ 用户以为做过了；
//     Escape 关不掉 ⇒ 菜单一直盖住画布。（「右键把该节点纳入选择」这一格实测**不
//     成立**，是一条真实缺陷，见该用例上方的注释——本文件不把它写成期望。）
//   * WF-40 —— 校验回执是「这张图能不能跑」的唯一结论。草稿改了、或它依赖的
//     代理 / 技能 / 插件清单变了，回执就已经不作数；若界面继续把它显示成 current，
//     用户会带着一个对旧修订版签发的「通过」去启动，然后在启动校验处才炸。
//   * WF-52 —— 配置包是按**已保存版本**打的。脏草稿时不禁用 ⇒ 导出的包与用户
//     屏幕上那份不一致，而他不会知道；围栏松掉 ⇒ 另一个标签页刚推上去的版本被
//     静默导出，用户以为自己拿到的是刚才看到的那份。
//   * WF-56 —— `wrapper-children-outside-bounds` 是个**警告**，唯一的修复入口就是
//     校验面板里那个「自动适配」。它不真的清掉 `size` ⇒ 这条警告永远消不掉，
//     作者只能手工去 YAML 里删字段（而产品并不提供那条路）。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链——外链会被 CI 的 markdown
// link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/components/canvas/inspector/CallWorkflowEdit.tsx:66-84    自排除候选 + id/name 双写的 selectValue 解析
//   packages/frontend/src/components/canvas/inspector/CallWorkflowEdit.tsx:139-152  选中时同时写 workflowName + workflowId
//   packages/frontend/src/components/canvas/inspector/CallWorkflowEdit.tsx:167-176   引用不可见 ⇒ 中性占位 call-workflow-ref-unavailable
//   packages/frontend/src/components/canvas/inspector/CallWorkflowEdit.tsx:112-121   updateLimit：下钳到 1、取整、清空即删 limits
//   packages/frontend/src/components/canvas/inspector/CallWorkgroupEdit.tsx:159-176  选中时同时写 workgroupName + workgroupId
//   packages/frontend/src/components/canvas/inspector/CallWorkgroupEdit.tsx:227-231  固定 result 端口说明行
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:210-232         切语言时只重写「未改动的 starter 正文」
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:184-196         无 scripts:author ⇒ 整个表单不渲染，只出 EmptyState
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:339-356          依赖 ChipsInput：bash 禁用 + scriptDependencyIssue 校验
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:369-378          env 为空即删字段
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:381-391          readonly 关掉即删字段（不是存 false）
//   packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx:499-520          ScriptEnvTable：保留键当场报错、× 删行、新增取 VAR_n
//   packages/frontend/src/components/canvas/inspector/JoinModeField.tsx:22-32         入站计数 < 2 ⇒ 整个字段不渲染
//   packages/frontend/src/components/canvas/inspector/JoinModeField.tsx:47-52         'any' 是默认值 ⇒ 删字段而不是持久化字面量
//   packages/frontend/src/hooks/usePrivilegedNodes.ts:57-79                           特权节点判定的单一来源（palette 置灰理由 / 受保护 id）
//   packages/frontend/src/components/workflow-editor/WorkflowNodePicker.tsx:252-256   置灰的条目点下去直接 return（连 DRAG 一起关掉）
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2443-2461              nodePickerDisabledReason：权限理由排在放置理由之前
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2649-2662              右键把该节点纳入选择
//   packages/frontend/src/components/canvas/WorkflowCanvas.tsx:2693-2748              节点右键菜单九项与各自的 disabled 判据
//   packages/frontend/src/components/canvas/ContextMenu.tsx:46-62                     Escape / 外部点击关闭
//   packages/frontend/src/routes/workflows.edit.tsx:169-186                           workflowValidationStaleReason：draft 优先于 inventory
//   packages/frontend/src/routes/workflows.edit.tsx:140-167                           inventorySignature 取 agents/skills/plugins 的 (id,name,updatedAt…)
//   packages/frontend/src/routes/workflows.edit.tsx:1239-1247                         导出入口的 fence 与「脏草稿即禁用」
//   packages/frontend/src/routes/workflows.edit.tsx:1161-1166                         onAutoFitWrapper → clearWrapperSize
//   packages/frontend/src/components/workflow-editor/ValidationPanel.tsx:117-125       过期时摘要文案换成「Revalidation required」
//   packages/frontend/src/components/workflow-editor/ValidationPanel.tsx:225-234       两种过期原因各自的横幅文案 + 重新校验按钮
//   packages/frontend/src/components/workflow-editor/ValidationPanel.tsx:330-368       只有 wrapper-children-outside-bounds 才挂「自动适配」
//   packages/frontend/src/components/canvas/wrapperOps.ts:43-61                        clearWrapperSize：删 size 字段
//   packages/backend/src/services/workflow.validator.ts:2127-2161                      wrapper-children-outside-bounds 的判定（warning 档）
//   packages/backend/src/services/tokenRedaction.ts:39-91                               `***` 与 privileged lens 的落点
//   packages/shared/src/privilegedNodeRedaction.ts:87-117                               script 节点被遮的三个字段
//   packages/backend/src/services/resourcePackage/export.ts:246-282                     root fence 不符 ⇒ package-root-changed
//   packages/backend/src/routes/resourcePackages.ts:121-163                              expectedVersion 只接受纯十进制整数
//   packages/shared/src/scriptNode.ts:461-486                                            依赖必须精确固定版本的判据与文案
//   packages/shared/src/scriptNode.ts:631-645                                            保留 env 键 / 前缀的判据与文案
//
// 与既有覆盖的边界（**刻意不重叠**）：
//   * `e2e/rfc319-canvas-inspectors.spec.ts` 锁 WF-26～32 / X3（agent / input /
//     output / review / clarify / wrapper / fanout 检查器）。本文件接着补它没碰的
//     三类：两个 call 节点与 script 节点，加上横跨所有 kind 的 joinMode 字段。
//   * `e2e/rfc243-call-nodes.spec.ts` 只有一条用例，走的是「从调色板 Calls 分类
//     建出一个 call-workflow 节点、选中子工作流、保存干净」——它证明了**建得出来**，
//     没有验过端口预览、不可用降级、自排除候选与上限旋钮，也从没碰过 call-workgroup。
//   * `e2e/rfc253-script-node.spec.ts` 只有一条端到端链路（拖两个脚本节点 → 写
//     bash 正文 → 连线 → 启动 → stdout 落到下游）。它证明了**跑得起来**，检查器
//     那五个旋钮（语言切换的模板交换、全屏、依赖校验、env 表、readonly）一个都
//     没断言过。
//   * `e2e/rfc306-conditional-branching.spec.ts` 三条用例全在**运行期**（关掉一条
//     分支后哪条链跑、任务详情画布怎么置灰），从未打开过 joinMode 这个**编辑期**
//     开关。
//   * `e2e/rfc305-user-permissions.spec.ts` 验的是 guest 在工作流面上的路由级只读
//     （新建按钮不在 / 只读类名 / 画布宽度），没有任何一处打开过调色板去看特权
//     条目，也没打开过特权节点的检查器。全仓 grep `script-inspector-no-view-permission`
//     与 `editor.nodePicker.requiresPermission` 均零命中。
//   * `e2e/rfc319-canvas-editing-ops.spec.ts` 锁画布编辑动作（撤销 / 剪贴板 /
//     内联插入 / 自动布局 / 空画布引导 / 连线检查器 / 离开拦截 / 悬浮工具条）。
//     它从没右键过任何节点；本文件只补右键菜单这一条入口，不重复它已锁的动作语义
//     （复制 / 删除的**落库**判据在这里只做一次最小复核，用来证明菜单项真的接线了）。
//   * `e2e/rfc250-workflow-camera.spec.ts` 已有一条 `RFC-319 WF-23: focus-selection…`
//     覆盖「聚焦选中」相机动作（也就是账本里另立的 WF-X2），本文件不重复。
//   * `e2e/rfc319-resource-management-rest.spec.ts` 走的是配置包的 **REST** 面；
//     本文件只补编辑器里那个入口的两件事：脏草稿禁用，与点下去时真的带上了
//     当前已保存版本这个围栏。
//
// 分档：九条全部带 `@nightly`——账本里 WF-11/15/33/34/35/37/40/52/56 的 tier 都是
// nightly（P2/P3）。它们本身不慢（实测 3–30s），但 WF-40 要等编辑器 15s 一轮的
// 资源清单轮询（`workflows.edit.tsx:355-375` 的 `refetchInterval`），WF-15 / 56
// 依赖渲染出来的画布几何，放在夜跑腿更稳。
//
// 执行模型：全文件共用一个 daemon（不需要 runtime 子进程，全部是编辑期能力）。
// WF-11 另开一个 `user` 角色账号——`shared/schemas/permission.ts:1030-1077` 把
// `scripts:author` / `code-host-calls:author` 放在 manager 预设里，`user` 基线
// 没有它们，正是这条用例要的那个视角。

import { expect, test, type Locator, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319WfInspector!1'

interface Edge {
  id: string
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
}
type Node = Record<string, unknown> & { id: string; kind: string }
interface Definition {
  inputs: Array<Record<string, unknown> & { key: string; kind: string }>
  nodes: Node[]
  edges: Edge[]
}
interface WorkflowRow {
  id: string
  name: string
  version: number
}

let daemon: DaemonHandle
let sequence = 0
const agentIds = new Map<string, string>()

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function raw(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return {
    status: res.status,
    body:
      res.headers.get('content-type')?.includes('application/zip') === true ? '' : await res.text(),
    contentType: res.headers.get('content-type'),
  }
}

async function apiAs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${path}: ${res.status} ${res.body}`).toBe(true)
  return (res.body === '' ? undefined : JSON.parse(res.body)) as T
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return apiAs<T>(daemon.token, path, init)
}

async function seedAgent(name: string, outputs: string[]): Promise<void> {
  const created = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 workflow inspector fixture',
      outputs,
      outputKinds: Object.fromEntries(outputs.map((port) => [port, 'markdown'])),
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

function nextName(prefix: string): string {
  sequence += 1
  return `rfc319-wfi-${prefix}-${sequence}`
}

async function seedWorkflow(
  definition: { inputs?: Definition['inputs']; nodes: Node[]; edges?: Edge[] },
  name = nextName('wf'),
): Promise<WorkflowRow> {
  return api<WorkflowRow>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 workflow inspector fixture',
      definition: {
        $schema_version: 5,
        inputs: definition.inputs ?? [],
        nodes: definition.nodes,
        edges: definition.edges ?? [],
      },
    }),
  })
}

const readDefinition = async (id: string): Promise<Definition> =>
  (await api<{ definition: Definition }>(`/api/workflows/${encodeURIComponent(id)}`)).definition

const readVersion = async (id: string): Promise<number> =>
  (await api<{ version: number }>(`/api/workflows/${encodeURIComponent(id)}`)).version

/**
 * 判据的落点：**服务端定义**，不是表单上显示成什么。
 *
 * 编辑器是 1s 去抖自动保存，所以这里 poll 等它落库。poll 的语义天然是「等到变成
 * 这样」，因此**只能**用于正向断言：凡是「这一笔不许落库」的负向断言，一律先做
 * 一次紧随其后的**合法**改动、等它落库当栅栏，再回头断言非法那笔没混进去。
 */
async function expectPersisted<T>(
  workflowId: string,
  project: (definition: Definition) => T,
  expected: T,
  because: string,
): Promise<void> {
  await expect
    .poll(async () => project(await readDefinition(workflowId)), {
      message: because,
      timeout: 30_000,
    })
    .toEqual(expected)
}

function node(definition: Definition, nodeId: string): Node {
  const found = definition.nodes.find((candidate) => candidate.id === nodeId)
  if (found === undefined) throw new Error(`node '${nodeId}' vanished from the definition`)
  return found
}

/** 一个节点上**实际存在的字段名**——用来区分「存了 false / 'any'」与「删掉了字段」。 */
const nodeKeys = (definition: Definition, nodeId: string): string[] =>
  Object.keys(node(definition, nodeId)).sort()

const nodeIdsOf = (definition: Definition): string[] => definition.nodes.map((n) => n.id)

async function authPage(page: Page, token: string = daemon.token): Promise<void> {
  await page.addInitScript(
    ([baseUrl, tok]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, token] as const,
  )
}

async function openEditor(page: Page, workflowId: string, token?: string): Promise<void> {
  await authPage(page, token)
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })
}

/**
 * 等相机动画停下来：轮询 `.react-flow__viewport` 的 transform，直到**连续两次
 * 采样一模一样**。机器慢就多等几轮，机器快就立刻通过——不睡固定时长。
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
 * The app shell and canvas rail finish their responsive layout on separate
 * frames. Wait until the control's real click point belongs to the control;
 * a persistent overlap still fails with the same product-level contract.
 */
async function waitForCanvasControlReachable(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId)
  await expect(control).toBeAttached()
  await expect
    .poll(
      () =>
        control.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          return hit !== null && (hit === element || element.contains(hit))
        }),
      {
        message: `画布控件 [data-testid=${testId}] 的点击中心一直被其他界面遮挡`,
        intervals: [120, 120, 120, 120, 120, 120, 120, 120],
      },
    )
    .toBe(true)
}

/** 取全图视角，让每个节点都进入可点区域（画布是 transform 视口，视口外点不到）。 */
async function showFullGraph(page: Page): Promise<void> {
  const canvas = page.locator('.workflow-canvas')
  if ((await canvas.getAttribute('data-camera-mode')) !== 'overview') {
    await waitForCanvasControlReachable(page, 'workflow-camera-overview')
    await clickCanvasControl(page, 'workflow-camera-overview')
  }
  await expect(canvas).toHaveAttribute('data-camera-mode', 'overview')
  await waitForCameraSettled(page)
}

/**
 * 点一个节点的卡片头部（先取全图视角保证点得到）。
 *
 * 只做「点到」这一步，不等任何检查器字段——特权节点对无权用户的检查器是一整块
 * EmptyState，一个字段都没有。
 */
async function clickNode(page: Page, nodeId: string): Promise<void> {
  await showFullGraph(page)
  const header = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__header`)
  await expect(header).toBeAttached()
  // This file owns inspector semantics. Physical hit reachability and camera
  // movement are covered in rfc250-workflow-camera.spec.ts; dispatching the
  // real bubbling handler keeps a currently open rail from swallowing this
  // semantic selection event when overview places the node underneath it.
  await header.dispatchEvent('click')
  await waitForCameraSettled(page)
}

async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  await showFullGraph(page)
  const header = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__header`)
  await expect(header).toBeAttached()
  await header.dispatchEvent('contextmenu', { button: 2 })
  await expect(page.getByRole('menu')).toBeVisible()
}

/** 选中一个节点并等它的检查器挂上来（1280px 宽 ⇒ 检查器是 rail，不是弹窗）。 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await clickNode(page, nodeId)
  await expect(page.locator(`[id="workflow-inspector-field-${nodeId}-title"]`)).toBeVisible()
}

/**
 * 一条选项的标签是不是**这个资源**。
 *
 * `buildResourceOptionLabeler`（lib/resource-option-label.ts:1-5）在有归属人时把
 * 标签渲染成 `名字 · 归属人`，撞名时再补 ` · #<id 后 6 位>`。所以判据只能是
 * 「以这个名字打头、且后面要么什么都没有、要么是那个分隔符」——写成逐字相等会得到
 * 一条恒假（或更糟，恒真的否定式）断言。
 */
function isOptionFor(label: string, name: string): boolean {
  return label === name || label.startsWith(`${name} · `)
}

/** 共享 `<Select>`：trigger 是 role=combobox，列表 portal 出去。 */
async function pickSelectOption(page: Page, trigger: Locator, optionText: string): Promise<void> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const search = listbox.locator('input.select__search-input')
  if ((await search.count()) > 0) await search.fill(optionText)
  const options = listbox.getByRole('option')
  await expect
    .poll(async () => (await options.allTextContents()).map((label) => label.trim()), {
      message: `下拉里没有一条属于「${optionText}」的选项`,
    })
    .toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${optionText}( · |$)`))]))
  const labels = (await options.allTextContents()).map((label) => label.trim())
  const index = labels.findIndex((label) => isOptionFor(label, optionText))
  await options.nth(index).click()
  await expect(listbox).toBeHidden()
}

/** 打开某个 `<Select>` 的下拉，读出全部选项文本，再关掉。 */
async function readSelectOptions(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const labels = await listbox.getByRole('option').allTextContents()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  return labels.map((label) => label.trim())
}

/** 画布工具条的「Add step」——它交出的是画布自己的节点选择器。 */
async function openNodePicker(page: Page): Promise<Locator> {
  await clickCanvasControl(page, 'workflow-canvas-add')
  const dialog = page.getByTestId('workflow-node-picker-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** 编辑器右上角 More，返回动作弹窗（已经开着就不再点，overlay 会拦住 More）。 */
async function openWorkflowActions(page: Page): Promise<Locator> {
  const dialog = page.getByTestId('workflow-actions-dialog')
  if ((await dialog.count()) === 0) await page.getByTestId('workflow-more-actions').click()
  await expect(dialog, '编辑器 More 打不开 ⇒ 导出 / 改名 / 权限 / 删除一项都够不着').toBeVisible()
  return dialog
}

async function closeWorkflowActions(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workflow-actions-dialog')).toBeHidden()
}

/** 显式校验一次，并等结果面板真的挂上来。 */
async function runValidation(page: Page): Promise<void> {
  await page.getByTestId('workflow-validate').click()
  await expect(page.getByTestId('workflow-validation-overlay')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  await seedAgent('rfc319-wfi-alpha', ['answer'])
  await seedAgent('rfc319-wfi-beta', ['notes'])
})

// `page.route` 的锁 B：先摘掉全部 handler，再趁 page 还活着把在飞的等完。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// WF-33 —— call-workflow 检查器
// ---------------------------------------------------------------------------

test('RFC-319 WF-33: call-workflow 检查器——引用不可见时给中性占位，选中子工作流同时写下名字与 id 并按真实定义预览端口，自己绝不在候选里，上限清空即删字段 @nightly', async ({
  page,
}) => {
  // 子工作流：一个 text 输入 + 一个带 `report` 端口的 output 节点。端口预览断言
  // 的就是这两样——它必须来自**子工作流的真实定义**，而不是父节点上的任何缓存。
  const childName = nextName('child')
  const child = await seedWorkflow(
    {
      inputs: [{ kind: 'text', key: 'brief', label: 'Brief', required: false }],
      nodes: [
        { id: 'in_brief', kind: 'input', inputKey: 'brief', position: { x: 0, y: 0 } },
        {
          id: 'out_report',
          kind: 'output',
          ports: [{ name: 'report' }],
          position: { x: 320, y: 0 },
        },
      ],
    },
    childName,
  )

  // 父工作流的 call 节点先指着一个**不存在**的名字：不可用降级是这条能力里最
  // 危险的一格（它必须与「无权可见」长得一模一样，否则 id 的存在性会从错误信息
  // 里漏出去），所以把它放在最前面验，而不是等选中之后再制造。
  const ghostName = nextName('ghost')
  const parentName = nextName('parent')
  const parent = await seedWorkflow(
    {
      nodes: [
        {
          id: 'call_child',
          kind: 'call-workflow',
          workflowName: ghostName,
          position: { x: 0, y: 0 },
        },
      ],
    },
    parentName,
  )

  await openEditor(page, parent.id)
  await selectNode(page, 'call_child')

  const refSelect = page.getByTestId('call-workflow-ref-select')
  await expect(
    refSelect,
    '悬空引用被静默清空了 ⇒ 作者看到一个「没选」的节点，永远不知道原来指过谁',
  ).toContainText(`${ghostName} (missing)`)
  await expect(
    page.getByTestId('call-workflow-ref-unavailable'),
    '引用不可用时不给中性占位 ⇒ 要么白屏，要么从错误信息里漏出「这个引用确实存在」',
  ).toHaveText('Reference is not visible or does not exist')
  await expect(
    page.getByTestId('call-workflow-ports-preview'),
    '解析不出子工作流却仍然渲染端口预览 ⇒ 作者会照着一份凭空的端口表接线',
  ).toHaveCount(0)

  // 自排除：正在编辑的这份工作流绝不能出现在候选里，否则一次点击就造出自调用。
  const options = await readSelectOptions(page, refSelect)
  expect(
    options.filter((label) => isOptionFor(label, parentName)),
    '正在编辑的工作流自己出现在候选里 ⇒ 一次点击就能造出一个自调用死循环',
  ).toEqual([])
  // 同时证明上一句不是恒真：同一份候选里必须**确实**找得到那个子工作流。
  expect(
    options.filter((label) => isOptionFor(label, childName)),
    '可见的子工作流不在候选里 ⇒ 这个节点根本没法配置（也说明上一句的自排除断言是恒真的）',
  ).toHaveLength(1)

  await pickSelectOption(page, refSelect, childName)

  // 名字与 id **必须一起**写下：只写名字 ⇒ 目标改名后静默换绑；只写 id ⇒ 跨实例
  // 导入的包里这个引用无从解析。
  await expectPersisted(
    parent.id,
    (definition) => [
      node(definition, 'call_child').workflowName,
      node(definition, 'call_child').workflowId,
    ],
    [childName, child.id],
    '选中子工作流后没有同时写下 workflowName 与 workflowId ⇒ 目标改名 / 跨实例导入时这个引用会悄悄绑错',
  )

  const preview = page.getByTestId('call-workflow-ports-preview')
  await expect(
    preview,
    '子工作流输入端口预览与它的真实定义对不上 ⇒ 作者照着预览接线，启动时才发现端口不存在',
  ).toContainText('Inputs: brief:text')
  await expect(
    preview,
    '子工作流输出端口预览与它的真实定义对不上 ⇒ 下游节点接到一个并不存在的输出上',
  ).toContainText('Outputs: report')

  // Advanced 是个折叠 <details>，展开才能碰到两个上限旋钮。
  await page.getByText('Advanced', { exact: true }).click()

  // 0 会被 `Math.max(1, ...)` 下钳到 1；1500.7 会被 `Math.trunc` 取整。两条都不是
  // 装饰：schema 只收正整数，存进去一个 0 或小数会让整份定义在保存时被拒。
  await page.getByTestId('call-workflow-max-duration').fill('0')
  await page.getByTestId('call-workflow-max-tokens').fill('1500.7')
  await expectPersisted(
    parent.id,
    (definition) => node(definition, 'call_child').limits,
    { maxDurationMs: 1, maxTotalTokens: 1500 },
    '子任务上限没有被下钳到 1 / 取整 ⇒ 存进去的是 0 或小数，整份定义在保存时被 schema 拒掉',
  )

  // 两个都清空 ⇒ `limits` 这个字段本身必须消失，而不是留一个空对象：
  // 「从没设置过」与「设置成空」在导出的配置包里必须字节等价。
  await page.getByTestId('call-workflow-max-duration').fill('')
  await page.getByTestId('call-workflow-max-tokens').fill('')
  await expectPersisted(
    parent.id,
    (definition) => Object.hasOwn(node(definition, 'call_child'), 'limits'),
    false,
    '两个上限都清空后 limits 字段还在 ⇒ 导出的配置包与「从没设置过」不再等价',
  )
})

// ---------------------------------------------------------------------------
// WF-34 —— call-workgroup 检查器
// ---------------------------------------------------------------------------

test('RFC-319 WF-34: call-workgroup 检查器——选中工作组同时写下名字与 id，目标模板落库且缺失的 {{ref}} 被当场点名，结果端口固定为 result 说清楚 @nightly', async ({
  page,
}) => {
  const workgroupName = nextName('wg')
  const workgroup = await api<{ id: string; name: string }>('/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name: workgroupName,
      description: 'RFC-319 call-workgroup fixture',
      instructions: 'base instructions',
      mode: 'leader_worker',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 4,
      completionGate: false,
      clarifyBudget: 0,
      fanOut: false,
      members: [
        {
          memberType: 'agent',
          agentId: agentId('rfc319-wfi-alpha'),
          displayName: 'alpha',
          roleDesc: '',
        },
      ],
    }),
  })

  // 上游接一条边进来，这个节点才有 `brief` 这个可用端口——「模板引用了不存在的
  // 端口」这条诊断只有在有对照的时候才有意义。
  const ghostName = nextName('ghostwg')
  const parent = await seedWorkflow({
    inputs: [{ kind: 'text', key: 'brief', label: 'Brief', required: false }],
    nodes: [
      { id: 'in_brief', kind: 'input', inputKey: 'brief', position: { x: 0, y: 0 } },
      {
        id: 'call_wg',
        kind: 'call-workgroup',
        workgroupName: ghostName,
        goalTemplate: 'Start.',
        position: { x: 320, y: 0 },
      },
    ],
    edges: [
      {
        id: 'e_brief',
        source: { nodeId: 'in_brief', portName: 'value' },
        target: { nodeId: 'call_wg', portName: 'brief' },
      },
    ],
  })

  await openEditor(page, parent.id)
  await selectNode(page, 'call_wg')

  const refSelect = page.getByTestId('call-workgroup-ref-select')
  await expect(
    refSelect,
    '悬空的工作组引用被静默清空 ⇒ 作者看到一个「没选」的节点，不知道原来指过谁',
  ).toContainText(`${ghostName} (missing)`)

  await pickSelectOption(page, refSelect, workgroupName)
  await expectPersisted(
    parent.id,
    (definition) => [
      node(definition, 'call_wg').workgroupName,
      node(definition, 'call_wg').workgroupId,
    ],
    [workgroupName, workgroup.id],
    '选中工作组后没有同时写下 workgroupName 与 workgroupId ⇒ 工作组改名 / 跨实例导入时这个引用会悄悄绑错',
  )

  // 结果端口是**固定**的：这个节点没有「配置输出端口」这回事，面板必须直说，
  // 否则作者会去找一个并不存在的入口。
  await expect(
    page.getByTestId('call-workgroup-result-info'),
    '固定 result 端口的说明没了 ⇒ 作者会去找一个并不存在的输出端口配置入口',
  ).toHaveText('Output port is fixed to result (text): the workgroup child task’s final result.')

  // 先写一个引用了不存在端口的模板：诊断必须当场点名那个端口。
  const goal = page.getByTestId('call-workgroup-goal-template')
  await goal.fill('Summarize {{nope}} for the team.')
  await expect(
    page.locator('.inspector__port-refs--missing'),
    '模板引用了不存在的端口却没有任何提示 ⇒ 作者以为接好了，任务在启动校验才炸',
  ).toContainText('nope')

  // 再改成合法模板，既当上一条的栅栏，也验模板本身真的落库。
  await goal.fill('Summarize {{brief}} for the team.')
  await expectPersisted(
    parent.id,
    (definition) => node(definition, 'call_wg').goalTemplate,
    'Summarize {{brief}} for the team.',
    '目标模板没落库 ⇒ 子工作组任务拿到的是一句旧的（或空的）目标',
  )
  await expect(
    page.locator('.inspector__port-refs--missing'),
    '模板改回合法端口后「缺失引用」提示还挂着 ⇒ 作者被一条永远消不掉的告警拖住',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// WF-35 —— script 检查器
// ---------------------------------------------------------------------------

test('RFC-319 WF-35: script 检查器——切语言只重写没动过的模板正文、全屏编辑器写的字照样落库、依赖必须精确固定版本、env 保留键当场报错、readonly 关掉是删字段 @nightly', async ({
  page,
}) => {
  const pythonStarter = [
    'import os',
    '',
    '# Upstream ports arrive as AW_PORT_<PORT_NAME>; large values spill to',
    '# AW_PORT_FILE_<PORT_NAME> (a path under $AW_INPUT_DIR).',
    "print('hello from python')",
    '',
  ].join('\n')

  const workflow = await seedWorkflow({
    nodes: [
      agentNode('src', 'rfc319-wfi-alpha', 0, 0),
      {
        id: 'run_script',
        kind: 'script',
        language: 'python',
        script: pythonStarter,
        position: { x: 320, y: 0 },
      },
    ],
    edges: [
      {
        id: 'e_diff',
        source: { nodeId: 'src', portName: 'answer' },
        target: { nodeId: 'run_script', portName: 'diff' },
      },
    ],
  })

  await openEditor(page, workflow.id)
  await selectNode(page, 'run_script')

  // 入参提示表：脚本读的是**派生出来的**环境变量名，作者猜不出这套 mangling。
  await expect(
    page.getByTestId('script-input-hints'),
    '入参提示没有把端口名映射成执行器真正会设的环境变量名 ⇒ 作者只能靠猜，脚本读到空串',
  ).toContainText('AW_PORT_DIFF')

  // ① 未改动的 starter 正文 ⇒ 切语言时模板跟着换。
  await page.getByTestId('script-language-bash').click()
  await expect(page.getByTestId('script-body-editor')).toHaveAttribute('data-language', 'bash')
  await expectPersisted(
    workflow.id,
    (definition) => [
      node(definition, 'run_script').language,
      String(node(definition, 'run_script').script).includes('#!/usr/bin/env bash'),
    ],
    ['bash', true],
    '切成 bash 之后正文还是 python 模板 ⇒ 用 bash 解释器去跑 python 代码，第一行就炸',
  )

  // ② 作者自己写过的正文 ⇒ 再切语言绝不能被重写。全屏编辑器与内联编辑器共用同一
  //    个 `updateScript`，所以顺带在全屏里写——「全屏写的字不落库」是这条能力被
  //    点名的那一格。
  await page.getByTestId('script-body-fullscreen-trigger').click()
  const fullscreen = page.getByTestId('script-body-fullscreen-dialog')
  await expect(fullscreen, '全屏编辑入口打不开 ⇒ 长脚本只能在一个八行的小框里写').toBeVisible()
  const fullscreenContent = page.getByTestId('script-body-editor-fullscreen').locator('.cm-content')
  await fullscreenContent.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('echo rfc319-authored-body')
  await expect(fullscreenContent).toContainText('rfc319-authored-body')
  await page.keyboard.press('Escape')
  await expect(fullscreen).toBeHidden()

  await expectPersisted(
    workflow.id,
    (definition) => node(definition, 'run_script').script,
    'echo rfc319-authored-body',
    '全屏编辑器里写的正文没落库 ⇒ 用户写完一屏代码，刷新回来什么都没有',
  )

  await page.getByTestId('script-language-node').click()
  await expectPersisted(
    workflow.id,
    (definition) => [
      node(definition, 'run_script').language,
      node(definition, 'run_script').script,
    ],
    ['node', 'echo rfc319-authored-body'],
    '切语言把作者自己写的正文冲掉了 ⇒ 一次误点抹掉整段代码，且没有任何提示',
  )

  // ③ 依赖必须精确固定版本；bash 根本不许声明依赖。
  await page.getByTestId('script-language-bash').click()
  await expect(
    page.getByTestId('script-deps-input'),
    'bash 下依赖输入框还能敲 ⇒ 作者填了一串永远不会被安装的依赖',
  ).toBeDisabled()

  await page.getByTestId('script-language-node').click()
  const deps = page.getByTestId('script-deps-input')
  await deps.fill('lodash')
  await deps.press('Enter')
  await expect(
    page.locator('.chips-input__error'),
    '未固定版本的依赖被放行 ⇒ 上游发新版当天流水线换了行为，而定义一个字节都没变',
  ).toContainText('exact')
  await deps.fill('lodash@4.17.21')
  await deps.press('Enter')
  await expectPersisted(
    workflow.id,
    (definition) => node(definition, 'run_script').dependencies,
    ['lodash@4.17.21'],
    '精确固定版本的依赖没落库 ⇒ 脚本跑起来时环境里根本没有这个包',
  )

  // ④ env 表：新增一行、改成平台保留键必须当场报错、改成合法键值才落库、删光即删字段。
  await page.getByTestId('script-env-add').click()
  await page.getByTestId('script-env-key-VAR_1').fill('AW_PORT_X')
  await expect(
    page.locator('.script-env-table .form-error'),
    '平台保留的 env 键被放行 ⇒ 脚本能改写 AW_* 契约，执行器读到的是伪造的入参',
  ).toContainText('reserved')

  await page.getByTestId('script-env-key-AW_PORT_X').fill('RFC319_TOKEN')
  await page.getByTestId('script-env-value-RFC319_TOKEN').fill('v1')
  await expectPersisted(
    workflow.id,
    (definition) => node(definition, 'run_script').env,
    { RFC319_TOKEN: 'v1' },
    'env 表里填的键值没落库 ⇒ 脚本跑起来时环境变量是空的',
  )
  await page.getByTestId('script-env-remove-RFC319_TOKEN').click()
  await expectPersisted(
    workflow.id,
    (definition) => Object.hasOwn(node(definition, 'run_script'), 'env'),
    false,
    '删光 env 行之后 env 字段还留着一个空对象 ⇒ 与「从没设置过」不再字节等价',
  )

  // ⑤ readonly：打开存 true，关掉必须**删字段**而不是存 false。
  await page.getByTestId('script-readonly').check()
  await expectPersisted(
    workflow.id,
    (definition) => node(definition, 'run_script').readonly,
    true,
    'readonly 开关没落库 ⇒ 本该只读的脚本仍然拿到可写工作树并会被合并回去',
  )
  await page.getByTestId('script-readonly').uncheck()
  await expectPersisted(
    workflow.id,
    (definition) => nodeKeys(definition, 'run_script').includes('readonly'),
    false,
    '关掉 readonly 之后留下了 readonly:false ⇒ 导出的配置包与「从没设置过」不再等价',
  )
})

// ---------------------------------------------------------------------------
// WF-37 —— join 模式（RFC-306）
// ---------------------------------------------------------------------------

test('RFC-319 WF-37: join 模式只在有两条以上入站时才出现，默认停在 any，选 all 落库、选回 any 是删字段而不是存字面量 @nightly', async ({
  page,
}) => {
  const workflow = await seedWorkflow({
    nodes: [
      agentNode('src_a', 'rfc319-wfi-alpha', 0, 0),
      agentNode('src_b', 'rfc319-wfi-beta', 0, 220),
      agentNode('merge', 'rfc319-wfi-alpha', 360, 110),
      agentNode('solo', 'rfc319-wfi-beta', 720, 110),
    ],
    edges: [
      {
        id: 'e_a',
        source: { nodeId: 'src_a', portName: 'answer' },
        target: { nodeId: 'merge', portName: 'left' },
      },
      {
        id: 'e_b',
        source: { nodeId: 'src_b', portName: 'notes' },
        target: { nodeId: 'merge', portName: 'right' },
      },
      {
        id: 'e_m',
        source: { nodeId: 'merge', portName: 'answer' },
        target: { nodeId: 'solo', portName: 'only' },
      },
    ],
  })

  await openEditor(page, workflow.id)

  // 单入站节点上给出这个选择本身就是错的：两个模式在那里完全等价，作者会据此
  // 推理出一个不存在的行为差异。
  await selectNode(page, 'solo')
  await expect(
    page.getByTestId('node-join-mode'),
    '只有一条入站的节点也给出 join 模式 ⇒ 作者拨了一个不起作用的开关，并据此推理',
  ).toHaveCount(0)

  await selectNode(page, 'merge')
  const any = page.getByTestId('node-join-mode-any')
  const all = page.getByTestId('node-join-mode-all')
  await expect(any, '两条入站的节点上没有 join 模式字段 ⇒ 分支合流处没有任何收口开关').toBeVisible()
  await expect(
    any,
    '没显式设置过的节点不落在默认档 any 上 ⇒ 界面显示的模式与调度器实际用的不是同一个',
  ).toHaveAttribute('aria-checked', 'true')

  await all.click()
  await expect(all, '点了「Require all inputs」但选中态没跟过去').toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expectPersisted(
    workflow.id,
    (definition) => node(definition, 'merge').joinMode,
    'all',
    'join 模式选了 all 却没落库 ⇒ 分支合流处一条腿没到就开跑，下游拿到不完整的数据',
  )

  await any.click()
  await expectPersisted(
    workflow.id,
    (definition) => nodeKeys(definition, 'merge').includes('joinMode'),
    false,
    "选回默认档 any 之后仍然持久化了 joinMode:'any' ⇒ 一份从没碰过这个开关的定义与它不再字节等价",
  )
})

// ---------------------------------------------------------------------------
// WF-11 —— 特权节点的置灰与遮蔽
// ---------------------------------------------------------------------------

test('RFC-319 WF-11: 没有 scripts:author / code-host-calls:author 的人——调色板里那两类节点置灰且点不动，检查器只给「已隐藏」而不是一排星号，服务端也没把正文送过来 @nightly', async ({
  page,
}) => {
  const username = nextName('reader').replace(/-/g, '')
  const created = await api<{ id: string }>('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      displayName: username,
      email: `${username}@example.com`,
      role: 'user',
      password: PASSWORD,
    }),
  })
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(login.ok, `login ${username}: HTTP ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }

  const workflow = await seedWorkflow({
    nodes: [
      {
        id: 'run_script',
        kind: 'script',
        language: 'python',
        script: "print('rfc319-secret-body')",
        env: { RFC319_SECRET: 'shh' },
        dependencies: ['requests==2.32.3'],
        position: { x: 0, y: 0 },
      },
      {
        id: 'call_api',
        kind: 'code-host-call',
        provider: 'gitlab',
        action: 'comment.reply-thread',
        params: { body: 'rfc319-secret-param' },
        position: { x: 360, y: 0 },
      },
    ],
  })

  // 授到 write 档：这条用例要验的是**特权节点**这一层的遮蔽，不是「只读者看不见
  // 调色板」——只读档下整条调色板都不渲染，那会让下面的断言变成恒真。
  const acl = await api<{ resourceId: string; aclRevision: number }>(
    `/api/workflows/${workflow.id}/acl`,
  )
  await api(`/api/workflows/${workflow.id}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      grants: [{ userId: created.id, level: 'write' }],
      expectedResourceId: acl.resourceId,
      expectedAclRevision: acl.aclRevision,
    }),
  })

  // 服务端这一侧：无权者拿到的定义里，三个被遮字段全是 `***`。若这里漏了，
  // 前端遮不遮都无所谓了——正文已经在网络上送到了他手里。
  const asReader = await apiAs<{ definition: Definition }>(
    sessionToken,
    `/api/workflows/${workflow.id}`,
  )
  expect(
    [
      node(asReader.definition, 'run_script').script,
      node(asReader.definition, 'run_script').env,
      node(asReader.definition, 'run_script').dependencies,
    ],
    '服务端把脚本正文 / 环境变量 / 依赖原样送给了没有 scripts:author 的人 ⇒ 前端遮不遮都无所谓了',
  ).toEqual(['***', { RFC319_SECRET: '***' }, ['***']])
  expect(
    node(asReader.definition, 'call_api').params,
    '服务端把 code-host 调用参数原样送给了没有 code-host-calls:author 的人',
  ).toEqual({ body: '***' })

  await openEditor(page, workflow.id, sessionToken)

  // 调色板：两类特权节点都置灰，并逐字说清缺哪个权限点。
  await openNodePicker(page)
  const scriptRow = page.getByTestId('workflow-node-picker-item-kind-script')
  const codeHostRow = page.getByTestId('workflow-node-picker-item-kind-code-host-call')
  await expect(
    scriptRow,
    '无 scripts:author 的人仍能从调色板拖出脚本节点 ⇒ 他会写完一整个节点，然后在保存时吃拒绝',
  ).toHaveAttribute('aria-disabled', 'true')
  await expect(
    scriptRow,
    '置灰了却不说缺哪个权限点 ⇒ 用户只看到一个灰按钮，不知道该去找谁要什么',
  ).toContainText('Requires the scripts:author permission')
  await expect(
    codeHostRow,
    '无 code-host-calls:author 的人仍能从调色板拖出代码托管调用节点',
  ).toHaveAttribute('aria-disabled', 'true')
  await expect(codeHostRow, '置灰了却不说缺哪个权限点').toContainText(
    'Requires the code-host-calls:author permission',
  )

  // 点下去必须什么都不发生。
  //
  // ⚠️ 这里不能用 `locator.click()`：Playwright 的可操作性判定把 `aria-disabled="true"`
  // 当成 disabled，于是它会一直等到超时——那证明的是「用户点不到」（上面两条
  // `toHaveAttribute` 已经说了），不是「即便点到了也不算数」。真正的闸在
  // `WorkflowNodePicker.tsx:252-256` 的 `choose` 里，它同时也是 DRAG 路径的闸，
  // 所以这里直接派发一次 click 事件去撞那个闸。
  await scriptRow.dispatchEvent('click')
  await expect(
    page.getByTestId('workflow-node-picker-dialog'),
    '点了置灰的特权条目之后选择器关掉了 ⇒ 说明它真的被当成一次成功的选择处理了',
  ).toBeVisible()

  // 栅栏：在**同一个**选择器里挑一个他有权用的条目。它必须真的加进定义——既证明
  // 这个用户对这份工作流本来就有写权（否则上面全部退化成「只读者看不到调色板」），
  // 也把「那次被拒的点击一个节点都没加进去」变成一句能落地的断言。
  // `.first()`：同一个条目会在「Recommended」与它自己的分类里各出现一次。
  await page.getByTestId('workflow-node-picker-item-kind-input').first().click()
  await expect(page.getByTestId('workflow-node-picker-dialog')).toBeHidden()
  await expectPersisted(
    workflow.id,
    (definition) => definition.nodes.map((n) => n.kind).sort(),
    ['code-host-call', 'input', 'script'],
    '点了置灰的脚本条目之后画布上多出了一个 script 节点 ⇒ 那个闸只是视觉上的',
  )

  // 检查器：整个表单不渲染，只留一句「已隐藏」。渲染一排 `***` 比明说更糟。
  //
  // 这里不能走 `selectNode`——它等的是显示名输入框，而这两个检查器对无权者**根本
  // 不渲染任何字段**（ScriptEdit.tsx:184-196 / CodeHostCallEdit.tsx:415-423 的提前
  // 返回），等一个不该存在的控件只会超时。
  await clickNode(page, 'call_api')
  await expect(
    page.getByTestId('code-host-inspector-no-view-permission'),
    'code-host 节点对无权者仍然渲染表单 ⇒ 里面显示的是服务端遮过的 `***`，作者会以为参数真的是这串星号',
  ).toBeVisible()
  await clickNode(page, 'run_script')
  await expect(
    page.getByTestId('script-inspector-no-view-permission'),
    '脚本节点对无权者仍然渲染表单 ⇒ 一排 `***` 会被当成正文，而「谁能读 = 谁能写」这条判据也破了',
  ).toContainText('Script hidden')
  await expect(
    page.getByTestId('script-body-editor'),
    '无权者的检查器里还挂着正文编辑器 ⇒ 他能对着一份被遮蔽的正文打字，保存时全部丢失',
  ).toHaveCount(0)

  // 对照：有权限的管理员在同一个调色板里必须**不**被置灰——否则上面四条对任何
  // 实现都成立（包括一个永远置灰的实现）。
  const adminPage = await page.context().browser()!.newPage()
  try {
    await openEditor(adminPage, workflow.id)
    await openNodePicker(adminPage)
    await expect(
      adminPage.getByTestId('workflow-node-picker-item-kind-script'),
      '有 scripts:author 的管理员也被置灰 ⇒ 这条闸是个常量，对任何人都关着',
    ).not.toHaveAttribute('aria-disabled', 'true')
  } finally {
    await adminPage.close()
  }
})

// ---------------------------------------------------------------------------
// WF-15 —— 节点右键上下文菜单
// ---------------------------------------------------------------------------

// ⚠️ 实测到的产品缺陷，**刻意没有写成断言**（RFC-319 是零生产改动的加固批）：
// `WorkflowCanvas.tsx:2658-2661` 写着「把右键命中的节点纳入选择」，但那一发
// `setSelection` 只改 React 侧的选择态，紧接着 xyflow 自己的 `onSelectionChange`
// （`WorkflowCanvas.tsx:2903-2921`，注释里明说它「在每次 node/edge 更新后都会
// 重新触发」）就用它自己那份仍然只含旧节点的选择把它盖回去。后果：**先选中 A、
// 再右键 B 并选「删除」，被删掉的是 A**。本机实测（先 selectNode('inner')、再右键
// 'alpha' 并点 Delete）落库结果是 `['alpha','box']`——inner 被删了，alpha 还在。
// 这与 `e2e/rfc319-canvas-editing-ops.spec.ts` 记的「Ctrl+A /「Select all」是空操作」
// 是同一个根因（`WorkflowCanvas.tsx:1921-1927` 的 selectAll 也只写 React 选择态）。
// 因此本用例只验「右键命中的就是当前选中的那个节点」这条正常路径，不把上面那个
// 错位行为写成期望。
test('RFC-319 WF-15: 节点右键菜单——wrapper 专属三项在普通节点上置灰、在 wrapper 上可用，Escape 什么都不做，复制 / 删除真的落库 @nightly', async ({
  page,
}) => {
  const workflow = await seedWorkflow({
    nodes: [
      agentNode('alpha', 'rfc319-wfi-alpha', 0, 0),
      agentNode('inner', 'rfc319-wfi-beta', 420, 240),
      {
        id: 'box',
        kind: 'wrapper-git',
        nodeIds: ['inner'],
        position: { x: 380, y: 180 },
        size: { width: 320, height: 220 },
      },
    ],
  })

  await openEditor(page, workflow.id)
  // 选中 alpha（而不是 inner）：被选中的节点会挂出悬浮工具条，而 inner 就坐在
  // wrapper 里面，它的工具条正好压在 wrapper 的标题栏上，后面那次右键就点不到了。
  // alpha 离得远，怎么选都不挡别人。
  await selectNode(page, 'alpha')

  await openNodeMenu(page, 'inner')

  const menu = page.getByRole('menu')
  await expect(menu, '右键节点没有交出上下文菜单 ⇒ 画布上最快的一条动作路径消失了').toBeVisible()

  // wrapper 专属三项在普通节点上必须置灰：点下去什么都不发生的菜单项会让用户
  // 以为画布卡死了。
  for (const label of ['Unwrap', 'Fit to children', 'Delete wrapper and inner nodes']) {
    await expect(
      menu.getByRole('menuitem', { name: label, exact: true }),
      `普通节点上的「${label}」没有置灰 ⇒ 点下去什么都不发生，用户会以为画布卡死`,
    ).toBeDisabled()
  }
  await expect(
    menu.getByRole('menuitem', { name: 'Duplicate', exact: true }),
    '「Duplicate」在一个普通节点上被置灰 ⇒ 这份菜单对它自己该支持的动作也关着',
  ).toBeEnabled()

  // Escape 关掉菜单，且**什么都不做**（「什么都没做」由下面那次 Duplicate 落库
  // 当栅栏证明：若 Escape 顺手执行了某一项，节点数就不会恰好是 4）。
  await page.keyboard.press('Escape')
  await expect(menu, 'Escape 关不掉右键菜单 ⇒ 它会一直盖在画布上').toBeHidden()

  // wrapper 上，同样三项必须可用——否则上面那三条 disabled 断言对任何实现都成立。
  await openNodeMenu(page, 'box')
  for (const label of ['Unwrap', 'Fit to children', 'Delete wrapper and inner nodes']) {
    await expect(
      menu.getByRole('menuitem', { name: label, exact: true }),
      `wrapper 上的「${label}」也被置灰 ⇒ 这三项对任何节点都关着，等于不存在`,
    ).toBeEnabled()
  }
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // 复制一份：菜单项真的接到了 `duplicateNode` 上，而不是只是个标签。
  // 这一格同时是上面两次 Escape 的栅栏：若 Escape 顺手执行了某一项，这里的节点数
  // 就不会恰好是 4。
  await openNodeMenu(page, 'inner')
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
  await expect(menu, '选完菜单项之后菜单没关').toBeHidden()
  await expectPersisted(
    workflow.id,
    (definition) => definition.nodes.length,
    4,
    '右键「Duplicate」没有真的复制出节点 ⇒ 这一项是个只会关菜单的空标签（上面两次 Escape 也就无从证明「什么都没做」）',
  )

  // 「删除」真的删掉那个节点，而不是只关掉菜单。走的是正常路径：先点中它（选择态
  // 与右键命中的是同一个节点），再从菜单里删。
  await selectNode(page, 'alpha')
  await openNodeMenu(page, 'alpha')
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expectPersisted(
    workflow.id,
    (definition) => ['alpha', 'box', 'inner'].filter((id) => nodeIdsOf(definition).includes(id)),
    ['box', 'inner'],
    '右键「Delete」没有删掉那个节点 ⇒ 这一项要么无效、要么删错了对象',
  )
})

// ---------------------------------------------------------------------------
// WF-40 —— 校验回执过期与重新校验
// ---------------------------------------------------------------------------

test('RFC-319 WF-40: 校验回执在草稿改动后与资源清单变动后分别标为过期并说清原因，「重新校验」把结论重新签在当前修订版上 @nightly', async ({
  page,
}) => {
  const workflow = await seedWorkflow({
    inputs: [{ kind: 'text', key: 'brief', label: 'Brief', required: false }],
    nodes: [
      { id: 'in_brief', kind: 'input', inputKey: 'brief', position: { x: 0, y: 0 } },
      agentNode('worker', 'rfc319-wfi-alpha', 320, 0),
    ],
    edges: [
      {
        id: 'e_brief',
        source: { nodeId: 'in_brief', portName: 'value' },
        target: { nodeId: 'worker', portName: 'brief' },
      },
    ],
  })

  await openEditor(page, workflow.id)
  await runValidation(page)

  const summary = page.getByTestId('workflow-validation-summary')
  const panel = page.locator('.workflow-validation')
  await expect(
    panel,
    '刚刚显式校验完的回执就被标成过期 ⇒ 这个状态位与草稿修订版无关，等于没有',
  ).toHaveAttribute('data-state', 'current')

  // ① 草稿改动 ⇒ 回执立刻不作数。判据不是「摘要变了」，而是它变成了那句**明确的**
  //    「需要重新校验」，且展开后说清原因是草稿变了。
  await selectNode(page, 'worker')
  await page.locator('[id="workflow-inspector-field-worker-title"] input').fill('rfc319-renamed')
  await expect(
    panel,
    '草稿改了但校验回执仍然显示为当前 ⇒ 用户会带着一个对旧修订版签发的「通过」去启动',
  ).toHaveAttribute('data-state', 'stale', { timeout: 30_000 })
  await expect(summary).toHaveText(/Revalidation required/)
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })

  // 结果面板在显式校验之后就是展开的（`handleValidate` 把 modalSurface 设成
  // 'validation'），所以这里不再点摘要——再点一次是**关掉**它。
  const overlay = page.getByTestId('workflow-validation-overlay')
  await expect(
    overlay,
    '过期了却不说是为什么过期 ⇒ 用户不知道该重新校验还是该去修资源',
  ).toContainText('Last validation (the draft has changed)')

  await overlay.getByRole('button', { name: 'Revalidate' }).click()
  await expect(panel, '点了「重新校验」之后回执仍然是过期的 ⇒ 那个按钮是个装饰').toHaveAttribute(
    'data-state',
    'current',
    { timeout: 30_000 },
  )

  // ② 资源清单变动 ⇒ 草稿一个字节没动，回执照样不作数。
  //    这里新建一个**无关的**代理：`workflowValidationInventorySignature`
  //    （workflows.edit.tsx:140-167）把整张代理表按 (id, name, updatedAt) 算进签名，
  //    多一行就够了。刻意不去动被引用的那个代理——改它的名字会连带触发定义里
  //    agentName 的同步改写，那样 `draft` 与 `inventory` 两个原因就分不开了。
  await seedAgent(nextName('bump'), ['answer'])

  // 编辑器按 15s 一轮拉取三张资源清单（workflows.edit.tsx:355-375 的 refetchInterval），
  // 所以这里给足两轮的窗口，不用固定 sleep。
  await expect(
    panel,
    '被引用的代理已经变了，校验回执却还显示为当前 ⇒ 「通过」这个结论建立在一份已经不存在的资源清单上',
  ).toHaveAttribute('data-state', 'stale', { timeout: 45_000 })
  await expect(
    overlay,
    '资源清单变动被说成「草稿变了」⇒ 用户会去翻自己根本没做过的改动',
  ).toContainText('Last validation (validation resources may have changed)')

  await overlay.getByRole('button', { name: 'Revalidate' }).click()
  await expect(
    panel,
    '资源清单变动后重新校验仍然停在过期 ⇒ 这条路径没有出口，用户永远启动不了',
  ).toHaveAttribute('data-state', 'current', { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// WF-52 —— 配置包导出的已保存版本围栏
// ---------------------------------------------------------------------------

test('RFC-319 WF-52: 配置包导出按已保存版本设围栏——干净草稿时点下去带的是当前版本号，服务端对陈旧版本回 package-root-changed，脏草稿时入口直接禁用并说明原因 @nightly', async ({
  page,
}) => {
  const clean = await seedWorkflow({ nodes: [agentNode('alpha', 'rfc319-wfi-alpha', 0, 0)] })
  const dirty = await seedWorkflow({ nodes: [agentNode('alpha', 'rfc319-wfi-alpha', 0, 0)] })

  await openEditor(page, clean.id)
  const savedVersion = await readVersion(clean.id)

  const actions = await openWorkflowActions(page)
  const exportAction = actions.getByTestId('export-package-workflow')
  await expect(
    exportAction,
    '干净草稿下导出入口也被禁用 ⇒ 这个入口对任何状态都关着，等于不存在',
  ).toBeEnabled()

  // 出站请求上的 `expectedVersion` 就是围栏本身：它丢了 ⇒ 另一个标签页刚推上去的
  // 版本会被静默导出，而用户以为自己拿到的是屏幕上这一份。
  const [exportRequest] = await Promise.all([
    page.waitForRequest(
      (request) => new URL(request.url()).pathname === `/api/workflows/${clean.id}/export-package`,
      { timeout: 30_000 },
    ),
    exportAction.click(),
  ])
  expect(
    new URL(exportRequest.url()).searchParams.get('expectedVersion'),
    '导出请求没带上当前已保存版本 ⇒ 「所见即所得」的围栏根本没建立',
  ).toBe(String(savedVersion))

  // 服务端这一侧：围栏不符必须 409 + 明确的拒绝码，而不是静默给一个新版本的包。
  const stale = await raw(
    daemon.token,
    `/api/workflows/${clean.id}/export-package?expectedVersion=${savedVersion + 1}`,
  )
  expect(
    [stale.status, JSON.parse(stale.body === '' ? '{}' : stale.body).code],
    '陈旧的 expectedVersion 仍然导出成功 ⇒ 用户拿到的是别人刚推上去的那一版，且毫无提示',
  ).toEqual([409, 'package-root-changed'])

  const current = await raw(
    daemon.token,
    `/api/workflows/${clean.id}/export-package?expectedVersion=${savedVersion}`,
  )
  expect(
    [current.status, current.contentType],
    '版本对得上时导出反而失败 ⇒ 围栏收得太紧，正常导出这条路被堵死',
  ).toEqual([200, 'application/zip'])

  await closeWorkflowActions(page)

  // 脏草稿：把这份工作流的保存打回 503，草稿就确定性地停在非 clean 相位上，
  // 导出入口必须禁用并说清「先保存」。用精确 pathname 谓词，无关请求不进 handler。
  await page.route(
    (url) => url.pathname === `/api/workflows/${dirty.id}`,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'unavailable', message: 'blocked by RFC-319 WF-52' }),
      })
    },
  )

  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(dirty.id)}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })

  await selectNode(page, 'alpha')
  await page.locator('[id="workflow-inspector-field-alpha-title"] input').fill('rfc319-unsaved')
  // 保存一直被打回，于是相位在 Unsaved changes / Saving / Checking save result /
  // Save failed 之间循环，**永远回不到 Saved**——判据就是这一点（写死其中某一个
  // 中间态会变成一条与重试节拍赛跑的用例）。
  await expect
    .poll(async () => (await page.getByTestId('workflow-draft-phase').textContent())?.trim(), {
      message: '保存被打回 503 之后草稿相位仍然停在 Saved ⇒ 编辑器在骗用户「已经存好了」',
      timeout: 30_000,
    })
    .toMatch(/^(Unsaved changes|Saving|Checking save result|Save failed)$/)

  const dirtyActions = await openWorkflowActions(page)
  const dirtyExport = dirtyActions.getByTestId('export-package-workflow')
  await expect(
    dirtyExport,
    '脏草稿下导出入口仍可点 ⇒ 导出的包与用户屏幕上那份不一致，而他不会知道',
  ).toBeDisabled()
  await expect(
    dirtyExport,
    '禁用了却不说为什么 ⇒ 用户只看到一个灰按钮，不知道要先保存',
  ).toHaveAttribute('title', 'Save the current changes before exporting.')
})

// ---------------------------------------------------------------------------
// WF-56 —— 校验面板的「自动适配 wrapper 尺寸」
// ---------------------------------------------------------------------------

test('RFC-319 WF-56: 内层节点跑出 wrapper 边界时校验面板报警并挂出「自动适配」，点一下真的清掉 wrapper 的固定尺寸，重新校验后这条告警消失 @nightly', async ({
  page,
}) => {
  // wrapper 有一个持久化的 `size`，而它的成员节点被摆在那个矩形之外——正是
  // 手改 YAML / 旧导出会留下的那种漂移（workflow.validator.ts:2127-2161）。
  const workflow = await seedWorkflow({
    nodes: [
      agentNode('inner', 'rfc319-wfi-alpha', 900, 640),
      {
        id: 'box',
        kind: 'wrapper-git',
        nodeIds: ['inner'],
        position: { x: 0, y: 0 },
        size: { width: 200, height: 120 },
      },
    ],
  })

  await openEditor(page, workflow.id)
  await runValidation(page)

  const overlay = page.getByTestId('workflow-validation-overlay')
  await expect(
    overlay,
    '内层节点跑出 wrapper 边界却没有任何告警 ⇒ 画布上看着在框里，实际不在，作者永远发现不了',
  ).toContainText('wrapper-children-outside-bounds')

  const autoFit = overlay.locator('.workflow-validation__autofit')
  await expect(
    autoFit,
    '这条告警没有挂出「自动适配」修复动作 ⇒ 作者只能去 YAML 里手删 size，而产品并不提供那条路',
  ).toHaveCount(1)
  await expect(autoFit).toHaveText('Auto-fit')

  await autoFit.click()
  await expectPersisted(
    workflow.id,
    (definition) => nodeKeys(definition, 'box').includes('size'),
    false,
    '点了「自动适配」但 wrapper 的固定尺寸还在 ⇒ 这条告警永远消不掉',
  )

  // 修完之后回执自然过期；重新校验必须真的把这条告警消掉——否则「修复」只是改了
  // 定义、没解决用户看到的那个问题。
  // 面板从显式校验起就一直是展开的，中途不要再点摘要——那是**关掉**它。
  const panel = page.locator('.workflow-validation')
  await expect(panel).toHaveAttribute('data-state', 'stale', { timeout: 30_000 })
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })
  await overlay.getByRole('button', { name: 'Revalidate' }).click()
  await expect(panel).toHaveAttribute('data-state', 'current', { timeout: 30_000 })
  await expect(
    overlay,
    '自动适配之后重新校验，这条告警还在 ⇒ 修复动作没有真的解决它守着的那个问题',
  ).not.toContainText('wrapper-children-outside-bounds')
})
