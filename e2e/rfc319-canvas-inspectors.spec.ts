// RFC-319 —— WF-26～WF-32 / WF-X3：工作流画布**各类节点检查器**（右侧抽屉）。
//
// 画布上一个节点长什么样，与它**配置成了什么**几乎无关：一个没选代理的
// agent 卡片、一个 targetDir 写成 `../escape` 的上传输入、一个把退出条件指向
// 已经不在循环里的节点的 loop、一个有两个分片源的 fanout——在静止的画布上
// 全都和配置正确的版本长得一模一样。检查器是这些配置**唯一**的人类入口，
// 而它写下的东西必须原样落进 `workflow.definition`：那份 JSON 才是调度器读的。
//
// 因此本文件的判据一律是**回读服务端定义**（`GET /api/workflows/:id`），
// 而不是表单上显示成什么。表单文案只在它本身就是给用户的**警告 / 拦截信号**
// 时才断言（例如「shard source kind must be list<T>」「Input key … is already
// used」）——那种时候「有没有说出来」就是能力本身。
//
// 失效形态（这些用例红了，用户会遭遇什么）：
//   * 选了代理但只写下 name 不写 id（或反之）⇒ 重命名 / 重建同名代理后节点
//     悄悄绑到别人的代理上，或直接 agent-not-found；
//   * `{{ref}}` 诊断不再报缺失 ⇒ 作者以为提示词接好了，任务在启动校验才炸；
//   * 输入 key 冲突没被拦 ⇒ 两个启动器字段合并成一个，另一个永远收不到值；
//   * 上传 targetDir 的非法值没被指出 ⇒ 文件落到工作树外 / 启动时才失败；
//   * output 端口的表单与边不同步 ⇒ 画布上看着接好了，任务详情页却没有那张卡；
//   * review 的内容来源允许选非 Markdown 端口 ⇒ 人工门开出来是一片空白；
//   * 驳回/迭代重跑集合能选到不可达节点 ⇒ 校验器拒绝启动，作者不知道哪里错；
//   * clarify 没绑到提问代理 / 不在 loop 里却不警告 ⇒ 反问轮次无上限、或根本没人问；
//   * loop 最大迭代数能存 0 ⇒ 循环体一次都不跑；退出条件能指向非成员节点 ⇒ 永远触顶；
//   * fanout 出现两个分片源 ⇒ 校验器判 shard-source-duplicate，而作者只是拨了个开关；
//   * 清空显示名留下空字符串而不是删字段 ⇒ 画布标题不再回落到代理名，变成一串 node id。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链）：
//   packages/frontend/src/components/canvas/NodeInspector.tsx:92-111        每种 kind 一个 Edit 组件的注册表
//   packages/frontend/src/lib/workflow-inspector-target.ts:16-18            `workflow-inspector-field-<node>-<field>` 锚点 id
//   packages/frontend/src/components/canvas/inspector/AgentSingleEdit.tsx:102-112   选代理同时写 agentName + agentId
//   packages/frontend/src/components/canvas/inspector/promptRefs.tsx:20-28  缺失 `{{ref}}` 的判定
//   packages/frontend/src/components/canvas/inspector/InputEdit.tsx:46-62   inputKey 空 / 重复的报错文案
//   packages/frontend/src/components/canvas/inspector/InputEdit.tsx:88-95   报错时 blur **不提交**
//   packages/frontend/src/components/canvas/inspector/InputEdit.tsx:294-298 targetDir 非法判定（.. / 绝对路径 / 盘符）
//   packages/frontend/src/components/canvas/inspector/InputEdit.tsx:355-369 onConflict 分段控件
//   packages/frontend/src/components/canvas/inspector/OutputEdit.tsx:44-46  端口列表经 set-output-ports 事务
//   packages/frontend/src/components/canvas/inspector/OutputEdit.tsx:147    未选上游节点时端口下拉禁用
//   packages/frontend/src/lib/workflow-transition.ts:521-532                output 端口绑定同步生成边
//   packages/frontend/src/lib/workflow-transition.ts:444-452                review 内容来源同步生成 `__review_input__` 边
//   packages/frontend/src/components/canvas/inspector/ReviewEdit.tsx:118-131 端口是否可评审由 outputKinds 判定
//   packages/frontend/src/components/canvas/inspector/ReviewEdit.tsx:152-159 重跑候选 = 内容来源的可达上游
//   packages/frontend/src/components/canvas/inspector/ReviewEdit.tsx:99-102  文件回滚开关的默认值（驳回 true / 迭代 false）
//   packages/frontend/src/components/canvas/inspector/ClarifyEdit.tsx:31-43  绑定提问代理 + loop 内判定
//   packages/frontend/src/components/canvas/inspector/CrossClarifyEdit.tsx:42-51 绑定提问者 / 设计者 + loop 内判定
//   packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx:38-55 wrapper-git 不渲染任何循环旋钮
//   packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx:111   maxIterations 下钳到 1
//   packages/frontend/src/components/canvas/inspector/WrapperGitLoopEdit.tsx:181-185 退出条件候选只含当前 loop 成员
//   packages/frontend/src/components/canvas/inspector/WrapperFanoutEdit.tsx:150-166 分片源单例不变量
//   packages/frontend/src/components/canvas/inspector/WrapperFanoutEdit.tsx:176-180 分片源 kind 必须是 list<T> 的警告
//   packages/frontend/src/components/canvas/inspector/NodeTitleField.tsx:38-42     清空显示名 ⇒ 删掉 title 字段本身
//   packages/shared/src/reviewMultiDoc.ts:81                                `__review_input__` 端口名
//   packages/shared/src/wrapperFanout.ts:151-167                            无聚合器时派生出 `__done__`
//   packages/backend/src/services/workflow.validator.ts:2044-2065           upload targetDir 的服务端规则
//
// 与既有覆盖的边界（避免重复）：
//   * `e2e/workflow-editor.spec.ts` 锁的是编辑器的**键鼠 / 拖拽 / 相机 / 布局**，
//     只验「点节点会打开抽屉」，不进抽屉内容；
//   * `e2e/canvas-connection-dialog.spec.ts` 锁**连线弹窗**（新建 / 复用 / 分片边界角色）；
//   * `e2e/canvas-wrapper-membership.spec.ts` 锁**拖进 / 拖出 wrapper 的归属**；
//   * `e2e/rfc295-runtime-parameter-picker.spec.ts` 已锁 agent 提示词参数选择器插入
//     **内置** token（`{{__repo_path__}}`）并 reload 存活——本文件只补它没覆盖的
//     **本地输入端口 token**（由入边派生，AgentSingleEdit 自己组装的那一档）；
//   * 上述各检查器的 jsdom 单测（`packages/frontend/tests/node-inspector-*.test.tsx`、
//     `wrapper-loop-inspector.test.tsx`、`review-inspector-source-guidance.test.tsx`、
//     `rfc262-upload-on-conflict.test.tsx`）只在内存里断言 onChange 的入参，
//     **没有任何一条穿过真实 daemon 的自动保存与持久化**——这正是本文件补的那一维。

import { expect, test, type Locator, type Page } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
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

async function seedAgent(
  name: string,
  outputs: string[],
  outputKinds: Record<string, string>,
): Promise<void> {
  const created = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 canvas inspector fixture',
      outputs,
      outputKinds,
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

/** 一个已经绑定好代理的 agent-single 节点（画布上最常见的形态）。 */
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
      name: `rfc319-inspectors-${++sequence}`,
      description: 'RFC-319 canvas inspector fixture',
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
 * 判据的落点：**服务端定义**，不是表单显示。
 *
 * 编辑器是 1s 去抖自动保存，所以这里用 poll 等它落库；poll 的语义天然是
 * 「等到变成这样」，因此**只能**用来断言正向结果。凡是「非法值不许落库」的
 * 负向断言，一律先做一次紧随其后的**合法**改动、等它落库当栅栏，再断言非法
 * 那笔没混进去（见各处 `栅栏` 注释）——否则一次迟到的写入会从断言底下溜过去。
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

function node(definition: Definition, nodeId: string): Node {
  const found = definition.nodes.find((candidate) => candidate.id === nodeId)
  if (found === undefined) throw new Error(`node '${nodeId}' vanished from the definition`)
  return found
}

function edgeSignatures(definition: Definition): string[] {
  return definition.edges
    .map(
      (edge) =>
        `${edge.source.nodeId}.${edge.source.portName}→${edge.target.nodeId}.${edge.target.portName}`,
    )
    .sort()
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
}

/** 检查器（1280px 视口是 medium 模式 ⇒ 常驻侧栏，不是弹窗）。 */
function inspector(page: Page): Locator {
  return page.locator('[data-inspector-content="node"]')
}

/**
 * 选中一个节点并等它的检查器挂上。
 *
 * 画布是 transform 视口：初次进入时相机可能只对焦在某一个节点上
 * （canvasCamera.ts:121-135 的 `planInitialCanvasCamera`），别的节点在 DOM 里
 * 存在却在可视区外，点不到。每次先取全图视角——点过节点后相机会回到
 * readable-focus，所以「全图」这个按钮每轮都在（WorkflowCanvas.tsx:3171-3190
 * 按 cameraMode 二选一渲染）。
 */
async function selectNode(page: Page, nodeId: string): Promise<void> {
  await clickCanvasControl(page, 'workflow-camera-overview')
  // 相机是 180ms 动画；动画结束前拿到的坐标会在 click 之前失效。
  await page.waitForTimeout(400)
  const header = page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__header`)
  await expect(header).toBeInViewport()
  await header.click()
  // 锚点 id 由 node id 唯一决定，是「抽屉里现在是哪个节点」最直接的判据。
  await expect(page.locator(`[id="workflow-inspector-field-${nodeId}-title"]`)).toBeVisible()
}

/** 某个节点某个字段的锚点容器（workflow-inspector-target.ts:16-18）。 */
function fieldAnchor(page: Page, nodeId: string, field: string): Locator {
  return page.locator(`[id="workflow-inspector-field-${nodeId}-${field}"]`)
}

/** 共享 <Select>（Select.tsx:406-593）：trigger 是 role=combobox，列表 portal 出去。 */
async function pickSelectOption(page: Page, trigger: Locator, optionText: string): Promise<void> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const search = listbox.locator('input.select__search-input')
  if ((await search.count()) > 0) await search.fill(optionText)
  await listbox.getByRole('option', { name: optionText }).first().click()
  await expect(listbox).toBeHidden()
}

/** 打开 <Select> 的列表只为「看有哪些选项」，看完按 Escape 原样合上。 */
async function readSelectOptions(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click()
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  const labels = await listbox.getByRole('option').allInnerTexts()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  return labels
}

/** 共享 <MultiSelect>（MultiSelect.tsx:237-381）：字段本身是 role=combobox 的 input。 */
async function multiSelectOptions(page: Page, field: Locator): Promise<string[]> {
  await field.click()
  const listbox = page.locator('ul[role="listbox"].multi-select__listbox')
  await expect(listbox).toBeVisible()
  return listbox.getByRole('option').allInnerTexts()
}

async function toggleMultiSelectOption(
  page: Page,
  field: Locator,
  optionText: string,
): Promise<void> {
  const listbox = page.locator('ul[role="listbox"].multi-select__listbox')
  if ((await listbox.count()) === 0 || !(await listbox.isVisible())) await field.click()
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: optionText }).first().click()
  await page.keyboard.press('Escape')
  await expect(listbox).toBeHidden()
}

/** 展开一个折叠的 InspectorSection（InspectorSection.tsx:13-17 是 <details>）。 */
async function expandSection(page: Page, title: string): Promise<void> {
  const summary = inspector(page)
    .locator('details.inspector-section--collapsible > summary')
    .filter({ hasText: title })
  await summary.click()
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  await seedAgent('rfc319-ins-source', ['answer'], { answer: 'markdown' })
  await seedAgent('rfc319-ins-writer', ['draft'], { draft: 'markdown' })
  await seedAgent('rfc319-ins-maker', ['answer'], { answer: 'markdown' })
  // review 用：一个既有 markdown 又有 string 端口的代理，用来证明「端口按 kind 分档」。
  await seedAgent('rfc319-ins-author', ['doc', 'notes'], { doc: 'markdown', notes: 'string' })
  // review 用：只有 string 端口 ⇒ 整个节点都不该能选作内容来源。
  await seedAgent('rfc319-ins-plain', ['notes'], { notes: 'string' })
  await seedAgent('rfc319-ins-planner', ['plan'], { plan: 'markdown' })
  await seedAgent('rfc319-ins-asker', ['answer'], { answer: 'markdown' })
  await seedAgent('rfc319-ins-designer', ['spec'], { spec: 'markdown' })
  await seedAgent('rfc319-ins-worker', ['status'], { status: 'string' })
  await seedAgent('rfc319-ins-lister', ['items'], { items: 'list<string>' })
  await seedAgent('rfc319-ins-shardee', ['note'], { note: 'markdown' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// WF-26 —— agent-single 检查器
// ---------------------------------------------------------------------------

test('WF-26 agent 检查器：选代理同时写下 id 与 name，缺失的 {{ref}} 被点名，参数选择器按光标插入端口 token @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('source', 'rfc319-ins-source', 0, 0),
      // 起点绑的是 source；本用例要把它**改**成 writer。持久化写边界拒绝
      // 没有 agentId 的 agent-single 节点（services/workflow.ts:664-676），
      // 所以「完全未绑定」这一态造不出来——改绑是同一条判据里能造出的最强形态：
      // 只改 name 不改 id（或反之）的实现会当场露馅。
      { ...agentNode('worker', 'rfc319-ins-source', 420, 0), promptTemplate: '' },
    ],
    edges: [
      {
        id: 'e_brief',
        source: { nodeId: 'source', portName: 'answer' },
        target: { nodeId: 'worker', portName: 'brief' },
      },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'worker')

  const agentField = fieldAnchor(page, 'worker', 'agent')
  await expect(
    inspector(page).getByTestId('agent-ref-open'),
    '「查看详情」不指向当前绑定的代理 ⇒ 作者点开的是另一份配置，据此改错东西',
  ).toHaveAttribute('href', `/agents/${agentId('rfc319-ins-source')}`)

  await pickSelectOption(page, agentField.getByRole('combobox'), 'rfc319-ins-writer')

  // 「查看详情」的 href 是节点到底记住了什么的**外部可见证据**：
  // 它由 agentId 拼出来（ResourceReferenceControl.tsx:36-37），name 拼不出它。
  await expect(
    inspector(page).getByTestId('agent-ref-open'),
    '选完代理却没有稳定 id 链接 ⇒ 节点只记住了会变的名字，代理改名即失联',
  ).toHaveAttribute('href', `/agents/${agentId('rfc319-ins-writer')}`)
  await expectPersisted(
    workflowId,
    (definition) => {
      const worker = node(definition, 'worker')
      return { agentId: worker.agentId, agentName: worker.agentName }
    },
    { agentId: agentId('rfc319-ins-writer'), agentName: 'rfc319-ins-writer' },
    'agentId / agentName 没成对落库 ⇒ 同名代理被重建后这个节点会绑到别人的代理上（RFC-223 的 ABA 场景）',
  )

  // 入边派生出的可用端口——作者写提示词时唯一能照抄的清单。
  await expect(
    inspector(page).locator('.inspector__port-refs:not(.inspector__port-refs--missing) .chip'),
    '不列出已接好的入站端口 ⇒ 作者只能猜 {{}} 里该写什么，猜错要到启动才知道',
    // chip 里还含一个 × 删除按钮，所以按前缀匹配文本。
  ).toHaveText([/^brief/])

  const prompt = fieldAnchor(page, 'worker', 'prompt').locator('textarea')
  await prompt.fill('Summarise {{missing_brief}}')
  const missing = inspector(page).locator('.inspector__port-refs--missing')
  await expect(
    missing,
    '提示词里引用了没有入边的端口却不报 ⇒ 运行时那个占位符永远是空，任务白跑一轮',
  ).toBeVisible()
  await expect(missing.locator('.chip')).toHaveText([/^missing_brief/])
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'worker').promptTemplate,
    'Summarise {{missing_brief}}',
    '提示词模板没落库 ⇒ 作者写的东西刷新就没了',
  )

  // 去掉那个不存在的引用：诊断必须消失（正向对照——否则它就是个常亮的假警报）。
  await prompt.fill('Summarise  now.')
  await expect(missing, '删掉不存在的 {{ref}} 后诊断还在 ⇒ 这条警告是常亮的，等于没有').toBeHidden()

  // 参数选择器按**光标位置**插入。这里插的是由入边派生的本地端口 token
  // （AgentSingleEdit.tsx:72-79），与 RFC-295 已锁的内置 token 是两条不同的
  // 目录分支：本地这一支只在检查器里存在。
  //
  // 光标刻意放在**句子中间**（'Summarise ' 之后、' now.' 之前）：放在末尾的话，
  // 一个「无脑追加到末尾」的实现也能通过，这条断言就锁不住任何东西。
  await prompt.evaluate((element: HTMLTextAreaElement) => {
    element.focus()
    element.setSelectionRange('Summarise '.length, 'Summarise '.length)
  })
  await inspector(page).getByTestId('agent-runtime-parameter-picker').click()
  const popover = page.locator('[data-runtime-parameter-popover]')
  await expect(popover).toBeVisible()
  const search = popover.getByRole('combobox')
  await search.fill('brief')
  await popover.getByRole('option', { name: '{{brief}}' }).first().click()
  await expect(popover).toBeHidden()

  await expect(
    prompt,
    '插入没落在光标处 ⇒ token 被追加到末尾或覆盖已有文字，用户得手工把句子救回来',
  ).toHaveValue('Summarise {{brief}} now.')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'worker').promptTemplate,
    'Summarise {{brief}} now.',
    '选择器插入的 token 没落库 ⇒ 用户看到的和调度器读到的提示词不是同一份',
  )
  await expect(
    missing,
    '插入的是真实端口 token 却仍被判缺失 ⇒ 选择器给的和诊断认的不是同一套端口名',
  ).toBeHidden()
})

// ---------------------------------------------------------------------------
// WF-27 —— input 节点检查器
// ---------------------------------------------------------------------------

test('WF-27 input 检查器：五种字段类型逐一落库，enum 选项与 upload 的 targetDir / onConflict 一并落库 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [{ id: 'in_topic', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } }],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'in_topic')

  const kindSelect = inspector(page).getByRole('combobox', { name: 'Field kind' })

  // 五种类型是启动器上五种完全不同的控件。逐一切换 + 逐一回读，任何一种掉队都会
  // 让启动表单渲染成另一种输入方式（例如 git 分支选择器退化成纯文本框）。
  for (const kind of ['files', 'git', 'text'] as const) {
    await pickSelectOption(page, kindSelect, kind)
    await expectPersisted(
      workflowId,
      (definition) => definition.inputs[0]?.kind,
      kind,
      `字段类型 '${kind}' 没落库 ⇒ 启动表单渲染的是另一种控件`,
    )
  }
  await expect(
    inspector(page).getByTestId('enum-choices-input'),
    '非 enum 类型却渲染了选项编辑器 ⇒ 作者会填一堆运行时根本不读的值',
  ).toHaveCount(0)

  await pickSelectOption(page, kindSelect, 'enum')
  const choices = inspector(page).getByTestId('enum-choices-input')
  await expect(
    choices,
    'enum 类型不给选项编辑器 ⇒ 启动表单是一个永远没有候选项的下拉',
  ).toBeVisible()
  await choices.fill('staging')
  await choices.press('Enter')
  await choices.fill('production')
  await choices.press('Enter')
  await inspector(page).getByRole('checkbox', { name: 'Allow multiple selections' }).check()
  await expectPersisted(
    workflowId,
    (definition) => {
      const entry = definition.inputs[0] ?? {}
      return { kind: entry.kind, choices: entry.choices, multiSelect: entry.multiSelect }
    },
    { kind: 'enum', choices: ['staging', 'production'], multiSelect: true },
    'enum 的候选项 / 多选开关没落库 ⇒ 启动者选不到值，或只能选一个',
  )

  await pickSelectOption(page, kindSelect, 'upload')
  const targetDir = inspector(page).getByRole('textbox', { name: 'Target directory' })
  await expect(targetDir, 'upload 类型不给落地目录字段 ⇒ 用户上传的文件没有明确去处').toBeVisible()

  // 负向 1：targetDir 为空。检查器必须当场说出理由——这条规则在服务端也存在
  // （workflow.validator.ts:2050-2058 的 upload-input-target-dir-missing），
  // 但用户是在这里配置的，只有这里说出来才来得及改。
  await expect(
    inspector(page).getByText('Target directory must be a repo-relative path', { exact: false }),
    '空 targetDir 不报错 ⇒ 作者一路配到启动才被拒，且不知道是哪一项',
  ).toBeVisible()

  // 负向 2：路径穿越。
  await targetDir.fill('../escape')
  await expect(
    inspector(page).getByText('Target directory must be a repo-relative path', { exact: false }),
    '`../escape` 不报错 ⇒ 作者以为文件会落在仓库里，实际是往工作树外写',
  ).toBeVisible()

  // 正向：合法相对路径 ⇒ 报错消失、提示回到常规文案。
  await targetDir.fill('inputs/refs')
  await expect(
    inspector(page).getByText('Target directory must be a repo-relative path', { exact: false }),
    '合法相对路径仍报错 ⇒ 这条校验是常亮的假警报，作者会学会无视它',
  ).toBeHidden()

  await inspector(page).getByTestId('upload-on-conflict-overwrite').click()
  await expectPersisted(
    workflowId,
    (definition) => {
      const entry = definition.inputs[0] ?? {}
      return { kind: entry.kind, targetDir: entry.targetDir, onConflict: entry.onConflict }
    },
    { kind: 'upload', targetDir: 'inputs/refs', onConflict: 'overwrite' },
    'upload 的落地目录 / 同名策略没落库 ⇒ 上传的文件要么落错地方，要么被改名后下游引用不到',
  )

  // 栅栏：合法值已经落库（上一条 poll 通过）。此刻再回读一次，确认非法的
  // `../escape` 不是「还没写完」而是**真的没有留在库里**。
  const settled = await readDefinition(workflowId)
  expect(
    settled.inputs[0]?.targetDir,
    '非法 targetDir 残留在定义里 ⇒ 后来的合法编辑并没有真的覆盖它',
  ).toBe('inputs/refs')
})

test('WF-27 input 检查器：重复 / 空的 input key 会被拒绝提交，改成合法值则整棵定义同步改名 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    inputs: [
      { kind: 'text', key: 'topic', label: 'Topic', required: true },
      { kind: 'text', key: 'taken', label: 'Taken', required: true },
    ],
    nodes: [
      { id: 'in_topic', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
      { id: 'in_taken', kind: 'input', inputKey: 'taken', position: { x: 0, y: 260 } },
      agentNode('consumer', 'rfc319-ins-maker', 460, 0),
    ],
    edges: [
      {
        id: 'e_topic',
        source: { nodeId: 'in_topic', portName: 'topic' },
        target: { nodeId: 'consumer', portName: 'topic' },
      },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'in_topic')

  const keyInput = fieldAnchor(page, 'in_topic', 'input-definition').getByRole('textbox')

  // 负向 1：撞上另一个输入的 key。
  await keyInput.fill('taken')
  await keyInput.blur()
  await expect(
    inspector(page).getByText('Input key taken is already used by another workflow input.'),
    '重复 key 不报错 ⇒ 两个启动器字段会合并成一个，另一个永远收不到值',
  ).toBeVisible()

  // 负向 2：清空。
  await keyInput.fill('')
  await keyInput.blur()
  await expect(
    inspector(page).getByText('Input key is required.'),
    '空 key 不报错 ⇒ 这个输入节点的输出端口没有名字，下游 {{}} 引用不到它',
  ).toBeVisible()

  // 正向 + 栅栏：改成合法值并等它落库。这一步同时是上面两条负向断言的栅栏——
  // 只有等到一次**确定落库**的写入之后，「非法值没进去」才是可证的。
  await keyInput.fill('subject')
  await keyInput.blur()
  await expectPersisted(
    workflowId,
    (definition) => ({
      nodeKey: node(definition, 'in_topic').inputKey,
      inputKeys: definition.inputs.map((entry) => entry.key).sort(),
      edges: edgeSignatures(definition),
    }),
    {
      nodeKey: 'subject',
      inputKeys: ['subject', 'taken'],
      // 改名必须同时改写这个输入节点的**出边源端口**（syncInputDefs.ts:84-88），
      // 否则下游那条边指向一个已经不存在的端口。
      edges: ['in_topic.subject→consumer.topic'],
    },
    'input key 改名没有整棵定义同步 ⇒ 节点 / inputs[] / 出边三者互相指不到，启动直接被校验拒绝',
  )

  const settled = await readDefinition(workflowId)
  expect(
    settled.inputs.filter((entry) => entry.key === 'taken'),
    '另一个输入被顶掉或复制了一份 ⇒ 重复 key 的拦截形同虚设',
  ).toHaveLength(1)
  expect(
    node(settled, 'in_taken').inputKey,
    '被撞的那个输入节点的 key 变了 ⇒ 拒绝提交时反而写坏了别人的字段',
  ).toBe('taken')
})

// ---------------------------------------------------------------------------
// WF-28 —— output 节点检查器
// ---------------------------------------------------------------------------

test('WF-28 output 检查器：新增端口 / 绑定上游 / 删除，端口列表与画布边始终同步 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('maker', 'rfc319-ins-maker', 0, 0),
      { id: 'out', kind: 'output', ports: [], position: { x: 460, y: 0 } },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'out')

  const binding = fieldAnchor(page, 'out', 'output-binding')
  // 这些按钮**不能**按 role+name 定位：`Field` 无 group 时渲染成 <label>
  // （Form.tsx:84-95），按钮是它的第一个 labelable 后代，于是 Chromium 把整段
  // label 文本（"Output ports Each port = …"）算成了按钮的可及名。按文本定位。
  await binding.locator('button').filter({ hasText: 'Add port' }).click()

  const row = binding.locator('li.inspector__output-port-row').first()
  const nodeSelect = row.getByRole('combobox', { name: 'upstream nodeId' })
  const portSelect = row.getByRole('combobox', { name: 'port' })
  await expect(
    portSelect,
    '还没选上游节点就能选端口 ⇒ 用户会绑定到一个不属于任何节点的端口名上',
  ).toBeDisabled()
  await expectPersisted(
    workflowId,
    (definition) => ({ ports: node(definition, 'out').ports, edges: edgeSignatures(definition) }),
    { ports: [{ name: 'port_1', bind: { nodeId: '', portName: '' } }], edges: [] },
    '新增端口没落库、或绑定还不完整就先画了一条边 ⇒ 画布上出现一条无源之边',
  )

  await row.locator('input.form-input').first().fill('final')
  await pickSelectOption(page, nodeSelect, 'rfc319-ins-maker (maker)')
  await expect(portSelect, '选完上游节点端口下拉仍禁用 ⇒ 绑定永远补不完').toBeEnabled()
  await pickSelectOption(page, portSelect, 'answer')

  await expectPersisted(
    workflowId,
    (definition) => ({ ports: node(definition, 'out').ports, edges: edgeSignatures(definition) }),
    {
      ports: [{ name: 'final', bind: { nodeId: 'maker', portName: 'answer' } }],
      // 表单里的绑定与画布上的边是同一件事的两个面（workflow-transition.ts:521-532）。
      edges: ['maker.answer→out.final'],
    },
    '表单绑好了但没生成对应的边 ⇒ 画布上看不出数据在流，任务详情页也不会有这张结果卡',
  )

  await row.locator('button').filter({ hasText: 'Remove' }).click()
  await expectPersisted(
    workflowId,
    (definition) => ({ ports: node(definition, 'out').ports, edges: edgeSignatures(definition) }),
    { ports: [], edges: [] },
    '删掉端口后边还留着 ⇒ 一条指向不存在端口的边会让校验器永久判红',
  )
})

// ---------------------------------------------------------------------------
// WF-29 —— review（人工门）检查器
// ---------------------------------------------------------------------------

test('WF-29 review 检查器：内容来源只接受 Markdown 端口，重跑集合只给可达上游，回滚开关落库 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('planner', 'rfc319-ins-planner', 0, 0),
      agentNode('author', 'rfc319-ins-author', 420, 0),
      agentNode('plain', 'rfc319-ins-plain', 0, 300),
      agentNode('island', 'rfc319-ins-planner', 420, 300),
      { id: 'gate', kind: 'review', position: { x: 840, y: 0 } },
    ],
    edges: [
      {
        id: 'e_plan',
        source: { nodeId: 'planner', portName: 'plan' },
        target: { nodeId: 'author', portName: 'plan' },
      },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'gate')

  await expect(
    inspector(page).getByTestId('review-source-guide'),
    '人工门唯一的必填项没有引导 ⇒ 作者以为要把待评审内容粘进描述框里',
  ).toContainText('Only one required input remains')

  const sourceNode = inspector(page).getByTestId('review-source-node')
  await sourceNode.click()
  const sourceList = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(sourceList).toBeVisible()
  await expect(
    sourceList.getByRole('option', { name: 'plain (plain)' }),
    '只有 string 端口的代理却能被选作评审来源 ⇒ 人工门开出来是一片空白，审阅者无从下手',
  ).toHaveAttribute('aria-disabled', 'true')
  await expect(
    sourceList.getByRole('option', { name: 'plain (plain)' }),
    '禁用了却不说为什么 ⇒ 作者只会觉得这个下拉坏了',
  ).toContainText('no output port declared with a Markdown kind')
  await sourceList.getByRole('option', { name: 'rfc319-ins-author (author)' }).click()
  await expect(sourceList).toBeHidden()

  // author 只有一个可评审端口（doc: markdown；notes: string 不算），
  // 所以端口应当被自动补齐——这是 ReviewEdit.tsx:346-351 的唯一候选自动填充。
  await expectPersisted(
    workflowId,
    (definition) => ({
      inputSource: node(definition, 'gate').inputSource,
      edges: edgeSignatures(definition),
    }),
    {
      inputSource: { nodeId: 'author', portName: 'doc' },
      edges: ['author.doc→gate.__review_input__', 'planner.plan→author.plan'],
    },
    '内容来源没落库、或没同步出 __review_input__ 边 ⇒ 任务跑到人工门时不知道该快照哪个产物',
  )

  await expect(
    await readSelectOptions(page, inspector(page).getByTestId('review-source-port')),
    '非 Markdown 端口没有被标成不可选 ⇒ 作者能把人工门指到一段裸字符串上',
  ).toEqual(expect.arrayContaining([expect.stringContaining('not a reviewable Markdown')]))

  // 重跑候选 = 内容来源的**可达上游**（ReviewEdit.tsx:52-75 的反向 BFS）。
  // island / plain 与 author 之间没有边，选中它们只会让校验器拒绝启动。
  const rerunReject = inspector(page).getByTestId('review-rerun-reject')
  const rerunOptions = await multiSelectOptions(page, rerunReject)
  expect(
    rerunOptions.some((label) => label.includes('(island)')),
    '把不可达节点也列进重跑集合 ⇒ 作者选完保存，启动时才被校验器拒绝，且看不出错在哪',
  ).toBe(false)
  expect(
    rerunOptions.some((label) => label.includes('(planner)')),
    '可达上游反而没列出来 ⇒ 驳回后只能重跑直接来源，上游的错误输入永远修不掉',
  ).toBe(true)
  await toggleMultiSelectOption(page, rerunReject, 'rfc319-ins-planner (planner)')

  await toggleMultiSelectOption(
    page,
    inspector(page).getByTestId('review-rerun-iterate'),
    'rfc319-ins-author (author)',
  )
  await expectPersisted(
    workflowId,
    (definition) => ({
      reject: node(definition, 'gate').rerunnableOnReject,
      iterate: node(definition, 'gate').rerunnableOnIterate,
    }),
    { reject: ['planner'], iterate: ['author'] },
    '驳回 / 迭代的重跑集合没落库 ⇒ 审阅者按了驳回，上游该重跑的节点一个都没动',
  )

  // 文件回滚是「驳回」与「迭代」语义上最大的区别：驳回默认把工作树退回快照，
  // 迭代默认不退（ReviewEdit.tsx:99-102）。两个开关都必须能被作者显式改写。
  await expandSection(page, 'Advanced')
  await inspector(page)
    .getByRole('checkbox', { name: 'Restore worktree to pre-snapshot when rejecting' })
    .uncheck()
  await inspector(page)
    .getByRole('checkbox', { name: 'Restore worktree to pre-snapshot when iterating' })
    .check()
  await expectPersisted(
    workflowId,
    (definition) => ({
      reject: node(definition, 'gate').rollbackFilesOnReject,
      iterate: node(definition, 'gate').rollbackFilesOnIterate,
    }),
    { reject: false, iterate: true },
    '回滚开关没落库 ⇒ 驳回时该保留的改动被抹掉、或该回退的没回退，重跑基于脏工作树',
  )
})

// ---------------------------------------------------------------------------
// WF-30 —— clarify / clarify-cross-agent 检查器
// ---------------------------------------------------------------------------

test('WF-30 clarify 检查器：绑定的提问代理与 loop 内外状态如实呈现，会话模式两个方向都落库 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('asker', 'rfc319-ins-asker', 0, 0),
      { id: 'ask', kind: 'clarify', position: { x: 60, y: 320 } },
      { id: 'loose', kind: 'clarify', position: { x: 640, y: 320 } },
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['ask'],
        maxIterations: 3,
        exitCondition: { kind: 'port-empty', nodeId: 'ask', portName: 'answers' },
        outputBindings: [],
        position: { x: 0, y: 260 },
      },
    ],
    edges: [
      {
        id: 'e_ask',
        source: { nodeId: 'asker', portName: '__clarify__' },
        target: { nodeId: 'ask', portName: 'questions' },
      },
    ],
  })
  await openEditor(page, workflowId)

  await selectNode(page, 'ask')
  await expect(
    inspector(page).getByTestId('clarify-linked-agent'),
    '不显示绑定的提问代理 ⇒ 作者无法确认这个反问节点到底挂在谁身上',
  ).toHaveText('asker')
  await expect(
    inspector(page).getByTestId('clarify-in-loop'),
    '在 loop 里却不说 ⇒ 作者不知道反问轮次是被 maxIterations 兜住的',
  ).toContainText('Inside a wrapper-loop')

  await inspector(page).getByTestId('clarify-session-mode-inline').click()
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'ask').sessionMode,
    'inline',
    '会话模式没落库 ⇒ 反问重跑仍开新会话，token 与上下文全部重来',
  )
  // 反方向：即便回到默认值也必须**显式**写下（Segmented 的 allowActiveReselect），
  // 否则 workflow JSON 里没有这个字段，作者的选择在文档上不可见。
  await inspector(page).getByTestId('clarify-session-mode-isolated').click()
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'ask').sessionMode,
    'isolated',
    '改回默认值不写字段 ⇒ 作者的显式选择丢失，下次读定义看不出这里被决定过',
  )

  await selectNode(page, 'loose')
  await expect(
    inspector(page).getByTestId('clarify-linked-agent-missing'),
    '没绑代理却不报 ⇒ 这个反问节点运行时不会被任何代理触发，等于画布上的死装饰',
  ).toBeVisible()
  await expect(
    inspector(page).getByTestId('clarify-in-loop-warning'),
    '不在 loop 里却不警告 ⇒ 反问轮次无上限，代理可以一直问下去把任务拖死',
  ).toContainText('Not inside a wrapper-loop')
})

test('WF-30 cross-clarify 检查器：提问者与被问设计者双向绑定如实呈现，缺一方当场报错 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('designer', 'rfc319-ins-designer', 0, 0),
      agentNode('questioner', 'rfc319-ins-asker', 460, 0),
      { id: 'cross', kind: 'clarify-cross-agent', position: { x: 460, y: 300 } },
      { id: 'orphan', kind: 'clarify-cross-agent', position: { x: 900, y: 300 } },
    ],
    edges: [
      {
        id: 'e_spec',
        source: { nodeId: 'designer', portName: 'spec' },
        target: { nodeId: 'questioner', portName: 'spec' },
      },
      {
        id: 'e_q',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross', portName: 'questions' },
      },
      {
        id: 'e_d',
        source: { nodeId: 'cross', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
  })
  await openEditor(page, workflowId)

  await selectNode(page, 'cross')
  await expect(
    inspector(page).getByTestId('cross-clarify-linked-questioner'),
    '不显示提问者 ⇒ 作者无法确认这条跨代理通道是从谁那儿发起的',
  ).toHaveText('questioner')
  await expect(
    inspector(page).getByTestId('cross-clarify-linked-designer'),
    '不显示被问的设计者 ⇒ 作者不知道提交反馈后到底是谁会被重跑',
  ).toHaveText('designer')

  await inspector(page).getByTestId('cross-clarify-session-mode-questioner-inline').click()
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'cross').sessionModeForQuestioner,
    'inline',
    '提问者重跑的会话模式没落库 ⇒ 重跑照样开新会话，之前的对话上下文丢光',
  )
  await inspector(page).getByTestId('cross-clarify-session-mode-questioner-isolated').click()
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'cross').sessionModeForQuestioner,
    'isolated',
    '改回默认值不写字段 ⇒ 作者的显式选择在定义里看不出来',
  )

  await selectNode(page, 'orphan')
  await expect(
    inspector(page).getByTestId('cross-clarify-linked-questioner-missing'),
    '没接提问者却不报 ⇒ 这个节点永远收不到问题，人工门空等',
  ).toBeVisible()
  await expect(
    inspector(page).getByTestId('cross-clarify-linked-designer-missing'),
    '没接设计者却不报 ⇒ 审阅者按下「提交」之后什么都不会发生',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// WF-31 —— wrapper-git / wrapper-loop 检查器
// ---------------------------------------------------------------------------

test('WF-31 wrapper-git 检查器：只有显示名与成员清单，绝不出现任何循环旋钮 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('inside', 'rfc319-ins-worker', 40, 120),
      { id: 'snap', kind: 'wrapper-git', nodeIds: ['inside'], position: { x: 0, y: 0 } },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'snap')

  await expect(
    inspector(page).getByText('Max iterations'),
    'git 包装器渲染出迭代上限 ⇒ 作者以为自己设了个循环次数，实际那个字段没人读',
  ).toHaveCount(0)
  await expect(
    inspector(page).getByTestId('loop-continue-on-max-iterations'),
    'git 包装器渲染出触顶继续开关 ⇒ 同上，一个永远不生效的设置',
  ).toHaveCount(0)

  await expandSection(page, 'Technical')
  await expect(
    // Field 整体是一个 <label class="form-field">（Form.tsx:95），成员清单是它的
    // 子节点；按标题文本挑出这一个 Field 再看整段文本。
    inspector(page).locator('label.form-field').filter({ hasText: 'Inner node ids' }),
    '不列出成员 ⇒ 作者看不出这次 diff 到底会把谁的改动算进去',
  ).toContainText('inside')
})

test('WF-31 wrapper-loop 检查器：迭代上限下钳到 1、退出条件只认当前成员、输出绑定落库 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('outside', 'rfc319-ins-worker', 0, 0),
      agentNode('member', 'rfc319-ins-worker', 560, 120),
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['member'],
        maxIterations: 2,
        exitCondition: { kind: 'port-empty', nodeId: 'member', portName: 'status' },
        outputBindings: [],
        position: { x: 520, y: 0 },
      },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'loop')

  // 负向：0 次迭代意味着循环体一次都不跑。控件必须把它钳回 1，而不是原样存下。
  const maxIterations = fieldAnchor(page, 'loop', 'loop-max-iterations').locator('input')
  await maxIterations.fill('0')
  await expect(
    maxIterations,
    '迭代上限接受 0 ⇒ 循环体一次都不执行，任务安静地跑完却什么都没做',
  ).toHaveValue('1')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'loop').maxIterations,
    1,
    '被钳过的值没落库 ⇒ 界面显示 1、定义里躺着 0，调度器读的是后者',
  )

  await maxIterations.fill('5')
  await inspector(page).getByTestId('loop-continue-on-max-iterations').check()
  await expectPersisted(
    workflowId,
    (definition) => ({
      maxIterations: node(definition, 'loop').maxIterations,
      continueOnMaxIterations: node(definition, 'loop').continueOnMaxIterations,
    }),
    { maxIterations: 5, continueOnMaxIterations: true },
    '迭代上限 / 触顶继续开关没落库 ⇒ 循环要么跑错轮数，要么触顶时整条工作流直接失败',
  )

  // 退出条件的候选**只能**是当前 loop 的直接成员（wrapperCandidates.ts:84-93）。
  // 指到 loop 外的节点，那个端口在循环体里永远不会更新，退出条件永远不成立。
  const exitNode = inspector(page).getByTestId('loop-exit-node-select')
  const exitCandidates = await readSelectOptions(page, exitNode)
  expect(
    exitCandidates.some((label) => label.includes('(member)')),
    '当前成员反而不在候选里 ⇒ 退出条件根本无从设置（也让下面那条排除断言变成空断言）',
  ).toBe(true)
  expect(
    exitCandidates.some((label) => label.includes('(outside)')),
    '退出条件能指向非成员节点 ⇒ 循环每轮都探测一个不会变的端口，必然跑到触顶',
  ).toBe(false)

  await pickSelectOption(
    page,
    inspector(page).getByRole('combobox', { name: 'Exit condition kind' }),
    'port-equals',
  )
  const equalsValue = inspector(page).getByRole('textbox', { name: 'Equals value' })
  await expect(
    equalsValue,
    '选了 port-equals 却不给比较值字段 ⇒ 退出条件恒等于「等于空串」',
  ).toBeVisible()
  await equalsValue.fill('DONE')
  await pickSelectOption(page, exitNode, 'rfc319-ins-worker (member)')
  await pickSelectOption(page, inspector(page).getByTestId('loop-exit-port-select'), 'status')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'loop').exitCondition,
    { kind: 'port-equals', nodeId: 'member', portName: 'status', value: 'DONE' },
    '退出条件没整体落库 ⇒ 循环按另一套条件判定是否再来一轮',
  )

  await expandSection(page, 'Advanced')
  const bindings = fieldAnchor(page, 'loop', 'loop-output-bindings')
  // 同 WF-28：按钮在 <label> 里，可及名被整段 label 文本吞掉，只能按文本定位。
  await bindings.locator('button').filter({ hasText: 'Add binding' }).click()
  const bindingRow = bindings.locator('li.inspector__output-port-row').first()
  const bindPort = bindingRow.getByRole('combobox', { name: '— pick a port —' })
  await expect(
    bindPort,
    '没选成员节点就能选端口 ⇒ 绑定会指向一个不属于任何成员的端口名',
  ).toBeDisabled()
  await pickSelectOption(
    page,
    bindingRow.getByRole('combobox', { name: '— pick a loop member —' }),
    'rfc319-ins-worker (member)',
  )
  await pickSelectOption(page, bindPort, 'status')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'loop').outputBindings,
    [{ name: 'out_1', bind: { nodeId: 'member', portName: 'status' } }],
    '输出绑定没落库 ⇒ 循环体的产物出不了这个包装器，下游节点收不到任何东西',
  )
})

// ---------------------------------------------------------------------------
// WF-32 —— wrapper-fanout 检查器
// ---------------------------------------------------------------------------

test('WF-32 wrapper-fanout 检查器：分片源是单例、必须是 list<T>，入站接线与派生输出如实呈现 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    nodes: [
      agentNode('feeder', 'rfc319-ins-lister', 0, 0),
      agentNode('inner', 'rfc319-ins-shardee', 620, 180),
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [
          { name: 'items', kind: 'list<string>', isShardSource: true },
          { name: 'context', kind: 'string' },
        ],
        position: { x: 560, y: 0 },
      },
    ],
    edges: [
      {
        id: 'e_items',
        source: { nodeId: 'feeder', portName: 'items' },
        target: { nodeId: 'fan', portName: 'items' },
      },
    ],
  })
  await openEditor(page, workflowId)
  await selectNode(page, 'fan')

  const inputs = fieldAnchor(page, 'fan', 'fanout-inputs')
  const rows = inputs.locator('.fanout-input-row-wrap')
  await expect(rows, '声明的入站端口没有逐行列出 ⇒ 作者看不出扇出到底吃几个输入').toHaveCount(2)
  await expect(
    rows.nth(0).locator('.fanout-input-wired'),
    '接好的入边不在对应端口行上显示 ⇒ 作者无法确认分片源的数据是谁喂的',
  ).toContainText('feeder')
  await expect(
    rows.nth(1).locator('.fanout-input-wired'),
    '没接线的端口不标出来 ⇒ 一个永远拿不到值的广播输入会被当成配好了',
  ).toContainText('(not wired)')

  // 分片源是单例不变量：把第二个打开，第一个必须自动关掉。
  await rows.nth(1).getByRole('checkbox', { name: 'shard source' }).check()
  await expectPersisted(
    workflowId,
    (definition) =>
      (node(definition, 'fan').inputs as Array<{ name: string; isShardSource?: boolean }>).map(
        (port) => `${port.name}:${String(port.isShardSource === true)}`,
      ),
    ['items:false', 'context:true'],
    '一个扇出出现两个分片源（或一个都不剩）⇒ 校验器判 shard-source-duplicate / -missing，而作者只是拨了个开关',
  )

  // 负向：分片源的 kind 必须是 list<T>——否则「逐项分片」无从谈起。
  await expect(
    rows.nth(1).getByText('shard source kind must be list<T>'),
    '非 list 的端口被设成分片源却不警告 ⇒ 作者要到启动被拒时才知道，且看不出是这一行',
  ).toBeVisible()

  // 正向：改成 list<markdown> 后警告消失，且 kind 原样落库。
  await pickSelectOption(
    page,
    rows.nth(1).getByRole('combobox', { name: 'Output kind' }),
    'markdown',
  )
  await rows.nth(1).getByRole('checkbox', { name: 'list', exact: true }).check()
  await expect(
    rows.nth(1).getByText('shard source kind must be list<T>'),
    '已经是 list<T> 却仍警告 ⇒ 这条提示是常亮的，作者会学会无视它',
  ).toBeHidden()
  await expectPersisted(
    workflowId,
    (definition) =>
      (node(definition, 'fan').inputs as Array<{ name: string; kind: string }>).map(
        (port) => `${port.name}:${port.kind}`,
      ),
    ['items:list<string>', 'context:list<markdown>'],
    '端口 kind 没落库 ⇒ 连线时的兼容性判定与运行时的分片行为基于两份不同的声明',
  )

  // 内层没有 role='aggregator' 的代理 ⇒ 只派生一个 __done__ 信号出口
  // （wrapperFanout.ts:156-159）。作者据此决定下游能不能取到数据。
  await expect(
    inspector(page).locator('label.form-field').filter({ hasText: 'Derived outputs' }),
    '不展示派生出口 ⇒ 作者以为能从扇出取到数据，实际只有一个控制流信号',
  ).toContainText('__done__')
})

// ---------------------------------------------------------------------------
// WF-X3 —— 逐节点显示名（NodeTitleField）
// ---------------------------------------------------------------------------

test('WF-X3 显示名：自定义标题落库并改写画布卡片，清空则删掉字段本身并回落到 kind 派生名 @nightly', async ({
  page,
}) => {
  const workflowId = await seedWorkflow({
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      agentNode('writer', 'rfc319-ins-writer', 0, 0),
      { id: 'in_topic', kind: 'input', inputKey: 'topic', position: { x: 0, y: 300 } },
    ],
  })
  await openEditor(page, workflowId)

  const cardTitle = (nodeId: string): Locator =>
    page.locator(`.react-flow__node[data-id="${nodeId}"] .canvas-node__title`)

  await selectNode(page, 'writer')
  await expect(
    cardTitle('writer'),
    '没设显示名时不回落到代理名 ⇒ 画布上一排 node id，读图的人认不出谁是谁',
  ).toHaveText('rfc319-ins-writer')

  const writerTitle = fieldAnchor(page, 'writer', 'title').getByRole('textbox')
  await writerTitle.fill('Draft writer')
  await expect(
    cardTitle('writer'),
    '改了显示名画布卡片不跟着变 ⇒ 作者不知道自己改的是哪张卡',
  ).toHaveText('Draft writer')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'writer').title,
    'Draft writer',
    '显示名没落库 ⇒ 刷新后所有自定义标题一起消失',
  )

  // 清空必须删掉 `title` 字段本身，而不是留下空字符串：nodeTitle 的回落链条
  // 判的是「有没有非空 title」，留一个 '' 会让派生名再也接不上（nodeTitle.ts:53-56）。
  await writerTitle.fill('')
  await expect(
    cardTitle('writer'),
    '清空显示名后卡片没回到代理名 ⇒ 标题变成空白或 node id，画布不可读',
  ).toHaveText('rfc319-ins-writer')
  await expectPersisted(
    workflowId,
    (definition) => Object.prototype.hasOwnProperty.call(node(definition, 'writer'), 'title'),
    false,
    '清空只写了空串没删字段 ⇒ 定义里留着一个空 title，导出 / 导入后回落链条彻底断掉',
  )

  // 同一个字段被所有 kind 共用（NodeInspector 的注册表里每个 Edit 组件都渲染它）。
  await selectNode(page, 'in_topic')
  const inputTitle = fieldAnchor(page, 'in_topic', 'title').getByRole('textbox')
  await inputTitle.fill('Topic to research')
  await expect(
    cardTitle('in_topic'),
    '输入节点的显示名不生效 ⇒ 这个字段只对代理节点管用',
  ).toHaveText('Topic to research')
  await expectPersisted(
    workflowId,
    (definition) => node(definition, 'in_topic').title,
    'Topic to research',
    '输入节点的显示名没落库 ⇒ 同一个控件在不同 kind 上行为不一致',
  )

  await inputTitle.fill('')
  await expect(
    cardTitle('in_topic'),
    '清空后没回落到 inputKey ⇒ 启动表单里认得出的那个 key 在画布上消失了',
  ).toHaveText('topic')
  await expectPersisted(
    workflowId,
    (definition) => Object.prototype.hasOwnProperty.call(node(definition, 'in_topic'), 'title'),
    false,
    '输入节点清空显示名后仍留着空 title ⇒ 与代理节点行为分叉，回落链条断在这一种 kind 上',
  )
})
