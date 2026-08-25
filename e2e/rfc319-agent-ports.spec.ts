// RFC-319 —— 代理端口编辑面的**服务端可核对**覆盖（AGENT-14/15/16/17/18/19/20/X5）。
//
// ## 这个文件锁的是什么失效形态
//
// 端口不是一个字段，是**一个值摊在四条线上**：`outputs` 数组 + `outputKinds` /
// `outputWrapperPortNames` 两张 sidecar 表 + `branchPorts` 名字列表
// （packages/frontend/src/lib/agent-ports.ts:229-283 的 applyOutputSidecars 就是
// 为了让改名/删除对这四条线同时生效才存在的）。只要其中一条没跟上，用户看到的
// 症状全都不是「端口编辑坏了」，而是别的东西坏了：
//
//   * 改名没搬 kind ⇒ 端口回落 DEFAULT_OUTPUT_KIND='string'，下游 review 节点
//     突然说「这个端口不是 Markdown」（agent-ports.ts:379-410 的删除路径同理）；
//   * 删端口没删 branchPorts ⇒ 后端 assertBranchPortsDeclared
//     （packages/backend/src/services/agent.ts:973-985）直接拒收整个代理，用户
//     手里再没有任何界面能改掉那条看不见的残留；
//   * required 的 true/false 存反 ⇒ 启动表单把用户没勾的端口全判成必填
//     （agent-ports.ts:77-88 的注释记的就是这次事故）；
//   * branchPorts 没落库 ⇒ 代理在运行期发 active="false" 会被判协议违规
//     （packages/backend/src/services/runner.ts:2163-2178），任务直接 failed。
//
// ## 为什么现有用例挡不住
//
// `e2e/agent-port-editor.spec.ts`（RFC-194）已经锁住了**浏览器内**的交互契约：
// 输入端口增/改/删的焦点交接、输出端口 list<path<md>> 的 KindSelect 与两段
// Escape、ports 面板 axe、390px 布局。但它**从头到尾没有点过一次保存**——整条
// 用例跑在 `/agents/new` 上，没有任何一个断言经过 PUT / SQLite / 回读。也就是说
// 上面四种「摊在四条线上的值没同步」的事故，那个文件一格都不会红。
//
// 本文件因此**只做它不做的事**：每条改动都落到服务端并用 API 回读对账，外加
// 现有文件完全没有的五块——分支端口的运行期效力、端口名校验矩阵、对话框开着
// 时的 stale 拒绝、聚合器 wrapperPortName、孤儿 sidecar 清理、页签角标。
//
// ## 判据锚点（纯文本，禁外链）
//
//   * 事务式对话框 / stale 判定 / canSave：
//     packages/frontend/src/components/agent-ports/AgentPortDialog.tsx:102-136,
//     :257-330, :345-380
//   * 端口名校验四分支：packages/frontend/src/lib/agent-ports.ts:37-67
//   * 输入端口 required 的 canonical-absent 语义：agent-ports.ts:77-88
//   * sidecar 随改名搬家 / 随删除清空：agent-ports.ts:229-283, :379-410
//   * 孤儿 sidecar 发现与清理：agent-ports.ts:412-447；
//     packages/frontend/src/components/OutputsEditor.tsx:97-99, :158-190
//   * 五个页签角标：packages/frontend/src/components/AgentForm.tsx:454-515
//   * branchPorts 后端拒收未声明端口：
//     packages/backend/src/services/agent.ts:973-985
//   * 运行期未声明分支端口 ⇒ failureCode='branch-port-not-declared'：
//     packages/backend/src/services/runner.ts:2163-2178
//   * 详情页 clean-follow（AGENT-17 的前提）：
//     packages/frontend/src/routes/agents.detail.tsx:96；
//     packages/frontend/src/hooks/useDraftFromQuery.ts:118-129

import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let sequence = 0

// 只有 AGENT-19 会真跑模型；其余用例不启动任务。`branch` 桩是唯一会按 prompt
// 里的 RFC306_CLOSE 标记发 active="false" 的模式
// （packages/system-mocks/src/runtime/mode-branch.ts）。
test.setTimeout(180_000)

interface AgentRow {
  id: string
  name: string
  updatedAt: number
  aclRevision: number | null
  outputs: string[]
  outputKinds?: Record<string, string>
  outputWrapperPortNames?: Record<string, string>
  branchPorts?: string[]
  inputs?: Array<{ name: string; kind: string; required?: boolean; description?: string }>
  role?: string
}

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  failureCode: string | null
  errorMessage: string | null
  parentNodeRunId: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function getJson<T>(path: string): Promise<T> {
  const res = await api(path)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await api(path, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** 带 revision fence 的 PUT —— 与 agents.detail.tsx:105-112 走同一条路。 */
async function putAgent(id: string, patch: Record<string, unknown>): Promise<AgentRow> {
  const current = await getJson<AgentRow>(`/api/agents/${id}`)
  const res = await api(`/api/agents/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...patch,
      expectedUpdatedAt: current.updatedAt,
      expectedAclRevision: current.aclRevision ?? 0,
    }),
  })
  if (!res.ok) throw new Error(`PUT /api/agents/${id} → ${res.status} ${await res.text()}`)
  return (await res.json()) as AgentRow
}

async function seedAgent(fields: Record<string, unknown>): Promise<AgentRow> {
  return post<AgentRow>('/api/agents', {
    description: 'RFC-319 端口用例夹具',
    bodyMd: 'fixture',
    ...fields,
  })
}

async function primeAuth(page: Page): Promise<void> {
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
}

/** 打开某个代理详情页的 Ports 面板，返回面板 locator。 */
async function openPortsPanel(page: Page, agentId: string): Promise<Locator> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${agentId}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()
  await page.getByTestId('agent-tab-ports').click()
  const panel = page.getByTestId('agent-panel-ports')
  await expect(panel).toBeVisible()
  return panel
}

async function chooseOption(page: Page, trigger: Locator, name: RegExp): Promise<void> {
  await trigger.click()
  const listbox = page.getByRole('listbox')
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name }).click()
  await expect(listbox).toHaveCount(0)
}

/** 在打开的端口对话框里把 KindSelect 调成目标 kind。 */
async function chooseKind(
  page: Page,
  dialog: Locator,
  spec: { base: RegExp; ext?: RegExp; list?: boolean },
): Promise<void> {
  await chooseOption(page, dialog.getByRole('combobox', { name: /Data type/ }), spec.base)
  if (spec.ext !== undefined) {
    await chooseOption(page, dialog.getByRole('combobox', { name: /file extension/ }), spec.ext)
  }
  if (spec.list === true) {
    const listToggle = dialog.getByRole('checkbox', { name: /\blist$/ })
    await listToggle.check()
    await expect(listToggle).toBeChecked()
  }
}

/** 点详情页保存并等它真的落库（用 API 回读，不信任 UI 自己的状态）。 */
async function saveAgentForm(page: Page, agentId: string, expectUpdatedAfter: number) {
  await page.getByTestId('agent-save-button').click()
  await expect
    .poll(async () => (await getJson<AgentRow>(`/api/agents/${agentId}`)).updatedAt, {
      timeout: 20_000,
    })
    .toBeGreaterThan(expectUpdatedAfter)
  return getJson<AgentRow>(`/api/agents/${agentId}`)
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'branch' })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// AGENT-14 —— 输出端口的增 / 改 / 删，落到服务端为准
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-14: 输出端口的增/改/删经保存后落库，kind sidecar 跟着端口名一起搬家 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({ name: `rfc319-out-${++sequence}`, outputs: [] })

  const panel = await openPortsPanel(page, agent.id)
  await expect(panel.getByTestId('agent-output-ports-empty')).toBeVisible()

  // ---- 新增两个端口（一个 markdown、一个 list<path<md>>）----
  await panel.getByTestId('agent-output-port-add').click()
  const addDialog = page.getByTestId('agent-output-port-dialog')
  await expect(addDialog).toBeVisible()
  await addDialog.getByTestId('agent-output-port-name').fill('answer')
  await chooseKind(page, addDialog, { base: /^markdown/ })
  await addDialog.getByTestId('agent-output-port-save').click()
  // 事务提交后对话框必须关闭：不关的话用户会以为没保存成功而重复点，产生重名端口。
  await expect(addDialog).toHaveCount(0)

  await panel.getByTestId('agent-output-port-add').click()
  const secondDialog = page.getByTestId('agent-output-port-dialog')
  await secondDialog.getByTestId('agent-output-port-name').fill('report')
  await chooseKind(page, secondDialog, {
    base: /file path/i,
    ext: /Markdown \(\.md\)/i,
    list: true,
  })
  await secondDialog.getByTestId('agent-output-port-save').click()
  await expect(secondDialog).toHaveCount(0)

  await expect(panel.getByTestId('agent-port-card-output-0')).toContainText('answer')
  await expect(
    panel.getByTestId('agent-port-card-output-1'),
    'kind 没有回显到卡片 ⇒ 用户无法在不重新打开对话框的情况下核对自己刚选的数据类型',
  ).toContainText('list<path<md>>')

  const afterAdd = await saveAgentForm(page, agent.id, agent.updatedAt)
  expect(
    afterAdd.outputs,
    '新增的输出端口没落库 ⇒ 用户以为配好了，工作流连线时却找不到这个端口',
  ).toEqual(['answer', 'report'])
  expect(
    afterAdd.outputKinds,
    'kind sidecar 没落库 ⇒ 端口在下游按默认 string 处理，review 节点会拒绝这个「不是 Markdown」的来源',
  ).toMatchObject({ answer: 'markdown', report: 'list<path<md>>' })

  // ---- 编辑：改名，kind 必须跟着搬家 ----
  await panel
    .getByTestId('agent-port-card-output-0')
    .getByRole('button', { name: /^Edit output port answer/ })
    .click()
  const editDialog = page.getByTestId('agent-output-port-dialog')
  await expect(editDialog).toBeVisible()
  const editName = editDialog.getByTestId('agent-output-port-name')
  // 编辑态必须带出既有值，否则用户每次改一个字段都要把其它字段重新填一遍。
  await expect(editName).toHaveValue('answer')
  await editName.fill('final_answer')
  // 改名要给出「可能打断既有工作流引用」的提醒——这是唯一的事前告知。
  await expect(editDialog).toContainText('Renaming may invalidate existing workflow references')
  await editDialog.getByTestId('agent-output-port-save').click()
  await expect(editDialog).toHaveCount(0)

  const afterRename = await saveAgentForm(page, agent.id, afterAdd.updatedAt)
  expect(afterRename.outputs).toEqual(['final_answer', 'report'])
  expect(
    afterRename.outputKinds?.final_answer,
    '改名后 kind 没跟过来 ⇒ 端口静默退回 string，下游按纯文本处理这份 Markdown',
  ).toBe('markdown')
  expect(
    Object.prototype.hasOwnProperty.call(afterRename.outputKinds ?? {}, 'answer'),
    '旧名字的 kind 残留成了孤儿 sidecar ⇒ 用户下次想复用 answer 这个名字会被「先清理孤儿映射」挡住',
  ).toBe(false)

  // ---- 删除：端口连同它的 sidecar 一起消失 ----
  const reportCard = panel.getByTestId('agent-port-card-output-1')
  await reportCard.getByRole('button', { name: /^Delete output port report/ }).click()
  await reportCard.getByRole('button', { name: /^Confirm deletion of output port report/ }).click()
  await expect(
    panel.getByTestId('agent-output-port-list').locator('.agent-port-card'),
    '两击确认删除没生效 ⇒ 用户点了删除却什么都没发生',
  ).toHaveCount(1)

  const afterDelete = await saveAgentForm(page, agent.id, afterRename.updatedAt)
  expect(afterDelete.outputs).toEqual(['final_answer'])
  expect(
    afterDelete.outputKinds?.report,
    '删端口没删它的 kind ⇒ 库里留下一条谁也看不见的孤儿映射，占着 report 这个名字',
  ).toBeUndefined()
  // 反向对照：没被删的那个端口一个字段都不许受牵连。
  expect(afterDelete.outputKinds?.final_answer).toBe('markdown')
})

// ---------------------------------------------------------------------------
// AGENT-15 —— 输入端口的增 / 改 / 删，含 required 与描述
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-15: 输入端口的增/改/删落库，required 开关与描述各自按语义持久化 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({ name: `rfc319-in-${++sequence}`, outputs: ['answer'] })
  const panel = await openPortsPanel(page, agent.id)
  await expect(panel.getByTestId('agent-input-ports-empty')).toBeVisible()

  // ---- 必填 + 带描述 ----
  await panel.getByTestId('agent-input-port-add').click()
  const first = page.getByTestId('agent-input-port-dialog')
  await expect(first).toBeVisible()
  await first.getByTestId('agent-input-port-name').fill('requirement')
  await chooseKind(page, first, { base: /^markdown/ })
  const requiredSwitch = first.getByTestId('agent-input-port-required')
  // RFC-218 D5：声明式输入默认必填，编辑器的初始态必须与启动表单的判定一致，
  // 否则作者看到的「可选」和启动时被拦下的「必填」对不上。
  await expect(requiredSwitch).toBeChecked()
  await first.getByTestId('agent-input-port-description').fill('   背景与目标   ')
  await first.getByTestId('agent-input-port-save').click()
  await expect(first).toHaveCount(0)

  // ---- 可选 + 无描述 ----
  await panel.getByTestId('agent-input-port-add').click()
  const second = page.getByTestId('agent-input-port-dialog')
  await second.getByTestId('agent-input-port-name').fill('hints')
  await second.getByTestId('agent-input-port-required').uncheck()
  await second.getByTestId('agent-input-port-save').click()
  await expect(second).toHaveCount(0)

  const card0 = panel.getByTestId('agent-port-card-input-0')
  const card1 = panel.getByTestId('agent-port-card-input-1')
  await expect(card0, '描述没有去掉首尾空白 ⇒ 能力卡片上出现莫名其妙的缩进').toContainText(
    '背景与目标',
  )
  await expect(card0).toContainText('required')
  await expect(
    card1,
    '取消必填后卡片仍打 required 标 ⇒ 作者以为这个端口可选，编排方却按必填连线',
  ).not.toContainText('required')
  await expect(card1).toContainText('No description')

  const afterAdd = await saveAgentForm(page, agent.id, agent.updatedAt)
  const requirement = afterAdd.inputs?.find((p) => p.name === 'requirement')
  const hints = afterAdd.inputs?.find((p) => p.name === 'hints')
  expect(requirement, '输入端口没落库 ⇒ 能力卡片与编排方看不到这个代理需要什么').toBeDefined()
  expect(requirement?.kind).toBe('markdown')
  expect(requirement?.description, '描述没有 trim 后落库 ⇒ 存进去的是带空白的脏值').toBe(
    '背景与目标',
  )
  // RFC-218（agent-ports.ts:77-88）：必填是「缺省即真」，显式 false 才代表可选。
  // 反过来存（存 true、丢 false）会把每个没勾的端口在启动时判成必填。
  expect(
    Object.prototype.hasOwnProperty.call(requirement ?? {}, 'required'),
    'required=true 被显式写进去了 ⇒ 与 canonical-absent 约定背离，往返一次就会漂移',
  ).toBe(false)
  expect(
    hints?.required,
    '取消必填没有以显式 false 落库 ⇒ 启动表单按「缺省即必填」把这个可选端口判成必填，用户被拦住且无从下手',
  ).toBe(false)

  // ---- 编辑：把可选改回必填并补描述 ----
  await card1.getByRole('button', { name: /^Edit input port hints/ }).click()
  const editDialog = page.getByTestId('agent-input-port-dialog')
  await expect(editDialog.getByTestId('agent-input-port-required')).not.toBeChecked()
  await editDialog.getByTestId('agent-input-port-required').check()
  await editDialog.getByTestId('agent-input-port-description').fill('可选的补充线索')
  await editDialog.getByTestId('agent-input-port-save').click()
  await expect(editDialog).toHaveCount(0)

  const afterEdit = await saveAgentForm(page, agent.id, afterAdd.updatedAt)
  const editedHints = afterEdit.inputs?.find((p) => p.name === 'hints')
  expect(
    Object.prototype.hasOwnProperty.call(editedHints ?? {}, 'required'),
    '重新勾上必填后 required:false 没被清掉 ⇒ 启动表单仍旧当它可选，用户改了个寂寞',
  ).toBe(false)
  expect(editedHints?.description).toBe('可选的补充线索')

  // ---- 删除 ----
  await card0.getByRole('button', { name: /^Delete input port requirement/ }).click()
  await card0.getByRole('button', { name: /^Confirm deletion of input port requirement/ }).click()
  await expect(panel.getByTestId('agent-port-card-input-0')).toContainText('hints')

  const afterDelete = await saveAgentForm(page, agent.id, afterEdit.updatedAt)
  expect(
    afterDelete.inputs?.map((p) => p.name),
    '删掉的输入端口还在库里 ⇒ 能力卡片继续向编排方宣告一个代理其实不再需要的输入',
  ).toEqual(['hints'])
})

// ---------------------------------------------------------------------------
// AGENT-16 —— 端口名校验矩阵（必填 / 格式 / 长度 / 同向重名）
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-16: 端口名必填/格式/长度/同向重名——对话框内报错且保存禁用，改对了就能存 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({
    name: `rfc319-name-${++sequence}`,
    outputs: ['answer'],
    inputs: [{ name: 'context', kind: 'string' }],
  })
  const panel = await openPortsPanel(page, agent.id)

  await panel.getByTestId('agent-output-port-add').click()
  const dialog = page.getByTestId('agent-output-port-dialog')
  const name = dialog.getByTestId('agent-output-port-name')
  const save = dialog.getByTestId('agent-output-port-save')
  await expect(dialog).toBeVisible()

  // ① 必填：先输入再清空，让校验 touched 起来。
  await name.fill('x')
  await name.fill('')
  await expect(
    dialog,
    '空端口名没有报错 ⇒ 用户点保存后得到一个匿名端口，工作流侧永远连不上',
  ).toContainText('Enter a port name.')
  await expect(save, '空端口名却允许保存 ⇒ 脏数据直接进库').toBeDisabled()

  // ② 格式非法：大写 / 连字符 / 数字开头都不行。
  for (const invalid of ['Answer', 'my-port', '1st_port']) {
    await name.fill(invalid)
    await expect(
      dialog,
      `「${invalid}」被当成合法端口名 ⇒ 它无法作为 {{token}} 出现在提示词模板里，代理一启动就静态校验失败`,
    ).toContainText('Start with a lowercase letter')
    await expect(save).toBeDisabled()
  }

  // ③ 同向重名：已有 answer。
  await name.fill('answer')
  await expect(
    dialog,
    '同向重名没有报错 ⇒ 两个同名端口在 XML envelope 里无法区分，聚合时后者覆盖前者',
  ).toContainText('Port names must be unique.')
  await expect(save).toBeDisabled()

  // ④ 长度：输出端口刻意不设上限（agent-ports.ts:46-54），输入端口在 128 处
  //    由 maxlength 硬拦——用户永远打不出超长名字，而不是打完再被拒。
  const longName = `a${'b'.repeat(199)}`
  await name.fill(longName)
  await expect(
    name,
    '输出端口名被截断了 ⇒ 用户存进去的名字和 agent.md / envelope 里的不一致，端口对不上',
  ).toHaveValue(longName)
  await expect(save, '合法的长输出端口名被拒 ⇒ 从别处导入的既有长端口名再也改不动').toBeEnabled()

  // ⑤ 反向对照：改成合法名字后确实能存，且真的进库。
  await name.fill('summary')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(dialog).toHaveCount(0)
  const afterOutput = await saveAgentForm(page, agent.id, agent.updatedAt)
  expect(
    afterOutput.outputs,
    '校验通过的端口没能存下 ⇒ 校验从「挡脏数据」变成了「挡所有数据」',
  ).toEqual(['answer', 'summary'])

  // ⑥ 输入端口侧：128 的边界由 maxlength 承担（对话框里的 too-long 分支因此不可达），
  //    但重名与格式一样要报错；且**跨方向不算重名**。
  await panel.getByTestId('agent-input-port-add').click()
  const inputDialog = page.getByTestId('agent-input-port-dialog')
  const inputName = inputDialog.getByTestId('agent-input-port-name')
  await expect(
    inputName,
    '输入端口名没有 128 上限 ⇒ 超长名字会被后端 schema 拒收，而用户看到的只是一次没有解释的保存失败',
  ).toHaveAttribute('maxlength', '128')
  await inputName.fill(longName)
  await expect(inputName, 'maxlength 没有拦住超长输入 ⇒ 同上').toHaveValue(longName.slice(0, 128))

  await inputName.fill('context')
  await expect(inputDialog).toContainText('Port names must be unique.')
  await expect(inputDialog.getByTestId('agent-input-port-save')).toBeDisabled()

  // 跨方向同名是合法的：输入 answer 与输出 answer 是两个独立命名空间。
  await inputName.fill('answer')
  await expect(
    inputDialog,
    '输入端口叫 answer 被判成和输出端口重名 ⇒ 用户被迫为同一个语义起两个名字',
  ).not.toContainText('Port names must be unique.')
  await expect(inputDialog.getByTestId('agent-input-port-save')).toBeEnabled()
  await inputDialog.getByTestId('agent-input-port-save').click()
  await expect(inputDialog).toHaveCount(0)

  const afterInput = await saveAgentForm(page, agent.id, afterOutput.updatedAt)
  expect(afterInput.inputs?.map((p) => p.name)).toEqual(['context', 'answer'])
})

// ---------------------------------------------------------------------------
// AGENT-17 —— 对话框开着时底层数据被刷新（stale target）
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-17: 对话框开着时底层端口被别人改了——拒绝提交，重开才放行 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({
    name: `rfc319-stale-${++sequence}`,
    outputs: ['answer'],
    inputs: [{ name: 'requirement', kind: 'string', description: 'v1 描述' }],
  })
  const panel = await openPortsPanel(page, agent.id)

  const card = panel.getByTestId('agent-port-card-input-0')
  await card.getByRole('button', { name: /^Edit input port requirement/ }).click()
  const dialog = page.getByTestId('agent-input-port-dialog')
  await expect(dialog).toBeVisible()
  // 用户已经在对话框里改了东西——这正是最容易「保存一下把别人覆盖掉」的时刻。
  await dialog.getByTestId('agent-input-port-description').fill('本标签页写的描述')
  await expect(dialog.getByTestId('agent-input-port-save')).toBeEnabled()

  // 另一个写者（另一个标签页 / 另一个人）改掉了同一个端口。
  await putAgent(agent.id, {
    inputs: [{ name: 'requirement', kind: 'string', description: '别人写的 v2 描述' }],
  })

  // 详情页的草稿是 clean-follow 的（agents.detail.tsx:96）：网络恢复会触发后台
  // 重取，把新的服务端值 rebase 进来——对话框脚下的数据就这样被换掉了。
  // 需要等到查询过了 staleTime(5s) 才会真的重取，所以轮询着反复触发。
  const staleNotice = dialog.getByText('The target port changed. Close and reopen the editor.')
  await expect
    .poll(
      async () => {
        await page.context().setOffline(true)
        await page.context().setOffline(false)
        return staleNotice.count()
      },
      { timeout: 60_000, intervals: [1_000, 1_000, 2_000, 2_000, 3_000] },
    )
    .toBeGreaterThan(0)

  await expect(
    dialog.getByTestId('agent-input-port-save'),
    '底层端口已经变了却还允许提交 ⇒ 这次提交会拿旧快照整个覆盖别人刚写的内容，且双方都不会收到任何提示',
  ).toBeDisabled()

  // 服务端仍是别人的值——没有被这次半途的编辑污染。
  const during = await getJson<AgentRow>(`/api/agents/${agent.id}`)
  expect(during.inputs?.[0]?.description).toBe('别人写的 v2 描述')

  // 反向对照：关掉重开之后，编辑与保存必须恢复正常，否则这条护栏就成了死锁。
  await dialog.getByTestId('agent-input-port-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expect(
    card,
    '后台刷新没有把新值带到卡片上 ⇒ 用户重开对话框看到的还是旧值，改完照样覆盖',
  ).toContainText('别人写的 v2 描述')

  await card.getByRole('button', { name: /^Edit input port requirement/ }).click()
  const reopened = page.getByTestId('agent-input-port-dialog')
  await expect(reopened).toBeVisible()
  await expect(reopened.getByTestId('agent-input-port-description')).toHaveValue('别人写的 v2 描述')
  await reopened.getByTestId('agent-input-port-description').fill('在最新版本上继续改')
  await expect(reopened.getByTestId('agent-input-port-save')).toBeEnabled()
  await reopened.getByTestId('agent-input-port-save').click()
  await expect(reopened).toHaveCount(0)

  const after = await saveAgentForm(page, agent.id, during.updatedAt)
  expect(
    after.inputs?.[0]?.description,
    '重开之后的正常编辑也存不下去 ⇒ stale 护栏把用户永久挡在门外',
  ).toBe('在最新版本上继续改')
})

// ---------------------------------------------------------------------------
// AGENT-18 —— 聚合器的 wrapperPortName
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-18: 聚合器 wrapperPortName 的编辑与重名——重名不许存，改名后落库 @nightly', async ({
  page,
}) => {
  const agent = await seedAgent({
    name: `rfc319-agg-${++sequence}`,
    role: 'aggregator',
    outputs: ['merged', 'notes'],
  })
  const panel = await openPortsPanel(page, agent.id)

  const mergedCard = panel.getByTestId('agent-port-card-output-0')
  await expect(
    mergedCard,
    '聚合器卡片没有说明这个端口以什么名字提升到 wrapper ⇒ 用户要去猜 fanout 出口叫什么',
  ).toContainText('Promoted with the same name, merged')

  await mergedCard.getByRole('button', { name: /^Edit output port merged/ }).click()
  const dialog = page.getByTestId('agent-output-port-dialog')
  const wrapper = dialog.getByTestId('agent-output-port-wrapper')
  const save = dialog.getByTestId('agent-output-port-save')
  await expect(
    wrapper,
    '聚合器角色下没有提升名字输入框 ⇒ RFC-060 的 outputWrapperPortNames 在界面上完全不可编辑',
  ).toBeVisible()

  // 提升名撞上另一个端口的提升名（notes 默认提升为 notes）。
  await wrapper.fill('notes')
  await expect(
    dialog,
    '两个端口提升成同一个 wrapper 名却放行 ⇒ fanout 出口只剩一个，另一个分片结果被静默丢弃',
  ).toContainText('Promoted port names must be unique.')
  await expect(save).toBeDisabled()

  // 反向对照：换成不冲突的名字就该能存。
  await wrapper.fill('merged_report')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(dialog).toHaveCount(0)
  await expect(
    mergedCard,
    '卡片没有显示 merged → merged_report 的映射 ⇒ 用户看不出自己改过提升名',
  ).toContainText('merged_report')

  const after = await saveAgentForm(page, agent.id, agent.updatedAt)
  expect(
    after.outputWrapperPortNames,
    '提升名没落库 ⇒ 保存后再打开又变回同名，用户的改动被静默丢弃',
  ).toMatchObject({ merged: 'merged_report' })
  expect(after.outputs).toEqual(['merged', 'notes'])
  expect(after.role).toBe('aggregator')

  // 把提升名填回端口本名 ⇒ 映射应当被清掉，而不是存一条 merged→merged 的废条目。
  await panel
    .getByTestId('agent-port-card-output-0')
    .getByRole('button', { name: /^Edit output port merged/ })
    .click()
  const second = page.getByTestId('agent-output-port-dialog')
  await second.getByTestId('agent-output-port-wrapper').fill('merged')
  await second.getByTestId('agent-output-port-save').click()
  await expect(second).toHaveCount(0)
  const cleared = await saveAgentForm(page, agent.id, after.updatedAt)
  expect(
    cleared.outputWrapperPortNames?.merged,
    '提升名填回本名后仍留着一条同名映射 ⇒ 一旦端口改名，这条映射就变成孤儿并占住旧名字',
  ).toBeUndefined()
})

// ---------------------------------------------------------------------------
// AGENT-20 —— 孤儿 sidecar 清理
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-20: 孤儿 sidecar 清理只删被点的那一条，且真的从库里消失 @nightly', async ({
  page,
}) => {
  // 两张 sidecar 表里各有一条不对应任何已声明端口的残留，外加一个同名 key
  // 同时出现在两张表里——清理必须按 (表, key) 定位，不能按 key 一把梭。
  const agent = await seedAgent({
    name: `rfc319-orphan-${++sequence}`,
    role: 'aggregator',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown', ghost: 'markdown', shared: 'markdown' },
    outputWrapperPortNames: { shared: 'promoted_shared' },
  })
  const panel = await openPortsPanel(page, agent.id)

  const orphans = panel.locator('.agent-port-orphans__item')
  await expect(
    orphans,
    '孤儿映射没有被列出来 ⇒ 它们对用户完全不可见，却会在下次复用同名端口时把保存挡住',
  ).toHaveCount(3)
  await expect(panel.locator('.agent-port-orphans')).toContainText('ghost')
  await expect(panel.locator('.agent-port-orphans')).toContainText('promoted_shared')

  // 只清 outputKinds 里的 ghost 一条。
  await panel
    .getByRole('button', { name: 'Clean up the orphan mapping for outputKinds:ghost' })
    .click()
  await panel
    .getByRole('button', { name: 'Confirm cleanup of the orphan mapping for outputKinds:ghost' })
    .click()
  await expect(orphans, '清理没生效 ⇒ 用户点了删除却什么都没发生').toHaveCount(2)

  const afterOne = await saveAgentForm(page, agent.id, agent.updatedAt)
  expect(
    afterOne.outputKinds?.ghost,
    '清掉的孤儿 kind 还在库里 ⇒ 用户以为清干净了，下次用 ghost 这个名字依旧被挡',
  ).toBeUndefined()
  expect(
    afterOne.outputKinds?.shared,
    '同名 key 在另一张表里的条目被连坐删掉 ⇒ 一次点击删了两条数据，用户无从察觉',
  ).toBe('markdown')
  expect(afterOne.outputWrapperPortNames?.shared).toBe('promoted_shared')
  expect(afterOne.outputKinds?.answer, '真正在用的端口 kind 被误伤').toBe('markdown')

  // 孤儿映射对用户的**实际伤害**就在这里：它把那个名字占住了。新建同名输出端口
  // 必须被明确拒绝并指向清理入口，而不是悄悄把旧映射接管过去。
  await panel.getByTestId('agent-output-port-add').click()
  const blocked = page.getByTestId('agent-output-port-dialog')
  await blocked.getByTestId('agent-output-port-name').fill('shared')
  await blocked.getByTestId('agent-output-port-save').click()
  await expect(
    blocked,
    '被孤儿映射占住的名字直接放行 ⇒ 新端口会静默继承一段谁也没在编辑的旧配置（kind / 提升名）',
  ).toContainText('This name still has an orphan mapping. Clean it up below first.')
  await expect(blocked.getByTestId('agent-output-port-save')).toBeDisabled()
  await blocked.getByTestId('agent-output-port-cancel').click()
  await expect(blocked).toHaveCount(0)

  // 反向对照：把两张表里的 shared 都清掉之后，同名端口就该建得起来。
  for (const source of ['outputKinds', 'outputWrapperPortNames']) {
    await panel
      .getByRole('button', { name: `Clean up the orphan mapping for ${source}:shared` })
      .click()
    await panel
      .getByRole('button', { name: `Confirm cleanup of the orphan mapping for ${source}:shared` })
      .click()
  }
  await expect(orphans, '清理完所有孤儿后区块还在 ⇒ 用户不知道自己已经清干净了').toHaveCount(0)

  await panel.getByTestId('agent-output-port-add').click()
  const dialog = page.getByTestId('agent-output-port-dialog')
  await dialog.getByTestId('agent-output-port-name').fill('shared')
  await dialog.getByTestId('agent-output-port-save').click()
  await expect(
    dialog,
    '清理干净后同名端口仍建不起来 ⇒ 这个名字被永久锁死，用户没有任何出路',
  ).toHaveCount(0)

  const afterAll = await saveAgentForm(page, agent.id, afterOne.updatedAt)
  expect(afterAll.outputs).toEqual(['answer', 'shared'])
  expect(
    afterAll.outputKinds?.shared,
    '新建的 shared 端口继承了被清掉的旧 kind ⇒ 清理只清了界面没清库',
  ).toBeUndefined()
  expect(
    afterAll.outputWrapperPortNames?.shared,
    '新建的 shared 端口继承了旧的提升名 ⇒ 同上，且 fanout 出口会叫一个用户从没设过的名字',
  ).toBeUndefined()
  expect(afterAll.outputKinds?.answer, '清理孤儿把在用端口的 kind 一起清了').toBe('markdown')
})

// ---------------------------------------------------------------------------
// AGENT-X5 —— 五个页签角标
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-X5: 代理表单五个页签角标——端口数/阻断错误数/引用数/引用问题数/非法 JSON 数 @nightly', async ({
  page,
}) => {
  const mcp = await post<{ id: string }>('/api/mcps', {
    name: `rfc319-badge-mcp-${++sequence}`,
    description: 'badge fixture',
    type: 'remote',
    config: { url: 'http://127.0.0.1:1/mcp', oauth: false },
    enabled: true,
  })
  const plugin = await post<{ id: string; name: string }>('/api/plugins', {
    name: `rfc319-badge-plugin-${++sequence}`,
    spec: daemon.stubOpencode,
    description: 'badge fixture',
    enabled: true,
  })
  const agent = await seedAgent({
    name: `rfc319-badge-${++sequence}`,
    outputs: ['answer', 'notes'],
    inputs: [{ name: 'context', kind: 'string' }],
    mcp: [mcp.id],
    plugins: [plugin.id],
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
  await expect(page.getByTestId('agent-save-button')).toBeVisible()

  const portsBadge = page.getByTestId('agent-tab-ports-badge')
  const resourcesBadge = page.getByTestId('agent-tab-resources-badge')
  const advancedBadge = page.getByTestId('agent-tab-advanced').locator('.tabs__tab-badge')

  // ① 端口数（中性）：1 个输入 + 2 个输出。角标是折叠页签里唯一的「这里有内容」提示。
  await expect(portsBadge, '端口页签没有数量角标 ⇒ 折叠后用户不知道这个代理声明过端口').toHaveText(
    '3',
  )
  await expect(portsBadge).toHaveAttribute('data-tone', 'neutral')
  // ② 引用数（中性）：1 个 MCP + 1 个插件。
  await expect(resourcesBadge).toHaveText('2')
  await expect(resourcesBadge).toHaveAttribute('data-tone', 'neutral')
  // 没有问题时不该出现「高级」角标，否则危险色就贬值了。
  await expect(advancedBadge, '没有非法 JSON 却挂着危险角标 ⇒ 角标失去信号价值').toHaveCount(0)

  // ③ 非法 JSON 数（危险）：两个 JSON 字段各写坏一个。
  await page.getByTestId('agent-tab-advanced').click()
  await page.getByTestId('agent-json-permission').fill('{')
  await expect(
    advancedBadge,
    '非法 JSON 没有在页签上留痕 ⇒ 用户切走后看不出哪个页签里躺着一段没法保存的内容',
  ).toHaveText('1')
  await expect(advancedBadge).toHaveAttribute('data-tone', 'danger')
  await page.getByTestId('agent-json-frontmatter-extra').fill('{"a":')
  await expect(advancedBadge).toHaveText('2')
  await expect(
    page.getByTestId('agent-save-button'),
    '带着非法 JSON 还能点保存 ⇒ 请求要么被后端拒，要么把半截对象写进库',
  ).toBeDisabled()

  // ④ 阻断错误数（危险）：把保留键写进额外 frontmatter —— 端口 sidecar 的唯一
  //    事实源是专用字段，塞进 frontmatterExtra 会产生两份互相打架的配置。
  await page.getByTestId('agent-json-permission').fill('{}')
  await page.getByTestId('agent-json-frontmatter-extra').fill('{"outputKinds":{"ghost":"string"}}')
  await expect(
    advancedBadge,
    '两个 JSON 都修好了角标却没消 ⇒ 用户不知道自己已经改对了',
  ).toHaveCount(0)
  await expect(
    portsBadge,
    '端口配置有阻断错误时角标还显示端口数 ⇒ 危险状态被数量掩盖，用户点保存才知道存不下去',
  ).toHaveText('1')
  await expect(portsBadge).toHaveAttribute('data-tone', 'danger')
  await expect(portsBadge).toHaveAttribute('aria-label', 'Port configuration errors: 1')
  await expect(
    page.getByTestId('agent-save-button'),
    '端口配置阻断时仍可保存 ⇒ 保留键与专用字段两份配置一起进库',
  ).toBeDisabled()

  // ⑤ 引用问题数（危险）：把被引用的插件停用。刷新页面丢掉上面的未保存编辑。
  const pluginRow = await getJson<{ operationConfigHash: string }>(`/api/plugins/${plugin.id}`)
  const disabled = await api(`/api/plugins/${plugin.id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: false, expectedConfigHash: pluginRow.operationConfigHash }),
  })
  expect(disabled.status, `停用插件失败：${await disabled.text()}`).toBe(200)

  await page.reload()
  await expect(page.getByTestId('agent-save-button')).toBeVisible()
  await expect(
    resourcesBadge,
    '引用出问题时能力页签角标没有变成危险态 ⇒ 用户要等任务真跑起来才知道代理引用坏了',
  ).toHaveText('1')
  await expect(resourcesBadge).toHaveAttribute('data-tone', 'danger')
  await expect(resourcesBadge).toHaveAttribute('aria-label', 'Resource reference errors: 1')
  // 未保存的编辑没了，端口角标应当回到中性的数量态。
  await expect(portsBadge).toHaveText('3')
  await expect(portsBadge).toHaveAttribute('data-tone', 'neutral')
})

// ---------------------------------------------------------------------------
// AGENT-19 —— 分支端口：勾选之后运行期真的关得掉这条分支
// ---------------------------------------------------------------------------

test('RFC-319 AGENT-19: 勾上「分支端口」才让运行期真的关得掉分支——同一个工作流勾选前后各跑一次 @nightly', async ({
  page,
}) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-rfc319-ports-repo-'))
  try {
    writeFileSync(join(repoDir, 'README.md'), '# rfc319 agent-ports fixture\n', 'utf-8')
    initGitRepo(repoDir)

    const suffix = ++sequence
    // judge 先**不**声明任何分支端口——这正是「勾选前」的状态。
    const judge = await seedAgent({
      name: `rfc319-judge-${suffix}`,
      outputs: ['need_fix', 'all_clear'],
    })
    const worker = await seedAgent({ name: `rfc319-worker-${suffix}`, outputs: ['summary'] })

    const workflow = await post<{ id: string }>('/api/workflows', {
      name: `rfc319-branch-${suffix}`,
      description: 'RFC-319 AGENT-19 —— judge 关掉 all_clear 分支',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'judge',
            kind: 'agent-single',
            agentName: judge.name,
            agentId: judge.id,
            promptTemplate: 'Judge the repo. RFC306_CLOSE:all_clear',
          },
          { id: 'fixer', kind: 'agent-single', agentName: worker.name, agentId: worker.id },
          { id: 'greeter', kind: 'agent-single', agentName: worker.name, agentId: worker.id },
          {
            id: 'out_fix',
            kind: 'output',
            ports: [{ name: 'fix_result', bind: { nodeId: 'fixer', portName: 'summary' } }],
          },
          {
            id: 'out_ok',
            kind: 'output',
            ports: [{ name: 'ok_result', bind: { nodeId: 'greeter', portName: 'summary' } }],
          },
        ],
        edges: [
          {
            id: 'e_fix',
            source: { nodeId: 'judge', portName: 'need_fix' },
            target: { nodeId: 'fixer', portName: 'findings' },
          },
          {
            id: 'e_ok',
            source: { nodeId: 'judge', portName: 'all_clear' },
            target: { nodeId: 'greeter', portName: 'note' },
          },
        ],
      },
    })

    const runToTerminal = async (label: string) => {
      const task = await post<{ id: string }>('/api/tasks', {
        workflowId: workflow.id,
        repoUrl: repoRemoteUrl(repoDir),
        inputs: {},
        name: `rfc319-agent19-${label}`,
      })
      let status = 'pending'
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        status = (await getJson<{ status: string }>(`/api/tasks/${task.id}`)).status
        if (['done', 'failed', 'canceled', 'interrupted'].includes(status)) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const nodeRuns = await getJson<NodeRunsResponse>(`/api/tasks/${task.id}/node-runs`)
      const freshest = new Map<string, NodeRunRow>()
      for (const row of nodeRuns.runs) {
        if (row.parentNodeRunId !== null) continue
        const current = freshest.get(row.nodeId)
        if (current === undefined || row.id > current.id) freshest.set(row.nodeId, row)
      }
      return { status, byNode: freshest }
    }

    // ---- 勾选前：代理没声明分支端口，运行期的 active="false" 是协议违规 ----
    const before = await runToTerminal('before')
    expect(
      before.status,
      '代理没声明分支端口，运行期却接受了关分支的标记 ⇒ 代理以为自己关掉了一条分支，平台照跑不误，这是这个特性最坏的失效形态',
    ).toBe('failed')
    expect(
      before.byNode.get('judge')?.failureCode,
      '未声明分支端口的关分支标记没有被判成协议违规 ⇒ 同上，且用户拿不到任何可读的原因',
    ).toBe('branch-port-not-declared')

    // ---- 在界面上勾「分支端口」，并确认它真的落库 ----
    const panel = await openPortsPanel(page, judge.id)
    const allClearCard = panel.getByTestId('agent-port-card-output-1')
    await expect(allClearCard).toContainText('all_clear')
    await allClearCard.getByRole('button', { name: /^Edit output port all_clear/ }).click()
    const dialog = page.getByTestId('agent-output-port-dialog')
    const branchSwitch = dialog.getByTestId('agent-output-port-branch')
    await expect(
      branchSwitch,
      '输出端口对话框里没有分支开关 ⇒ RFC-306 在界面上无从声明',
    ).not.toBeChecked()
    await branchSwitch.check()
    await dialog.getByTestId('agent-output-port-save').click()
    await expect(dialog).toHaveCount(0)
    await expect(
      allClearCard,
      '勾了分支端口卡片上却没有标记 ⇒ 用户无法一眼看出哪些端口能关分支',
    ).toContainText('branch port')

    const judgeAfter = await saveAgentForm(page, judge.id, judge.updatedAt)
    expect(
      judgeAfter.branchPorts,
      '分支端口没落库 ⇒ 界面上勾了，运行期照旧判协议违规，任务一跑就 failed',
    ).toEqual(['all_clear'])
    // 反向对照：没勾的端口不许被顺带写进去。
    expect(judgeAfter.branchPorts).not.toContain('need_fix')

    // ---- 保存期的那道闸：branchPorts 只许点名真实存在的输出端口 ----
    // 两张列表是分开存的，所以会漂：删掉 `all_clear` 却忘了同时摘掉 branchPorts，
    // 编辑器里看不出任何异常，一路要跑到运行期才炸成 branch-port-not-declared——
    // 而那时报的是「你确信自己声明过的端口」，用户完全无从下手。保存时就拦住，
    // 两张表才不会各说各话（agent.ts:973-985）。
    const staleBranch = await api(`/api/agents/${judge.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        outputs: ['need_fix', 'all_clear'],
        branchPorts: ['all_clear', 'need_fixx'],
        expectedUpdatedAt: judgeAfter.updatedAt,
        expectedAclRevision: judgeAfter.aclRevision ?? 0,
      }),
    })
    expect(
      staleBranch.status,
      'branchPorts 点名了不存在的输出端口却存下来了 ⇒ 这条漂移在界面上不可见，要到运行期才炸',
    ).toBe(422)
    const staleBody = (await staleBranch.json()) as { code?: string; details?: unknown }
    expect(staleBody.code).toBe('branch-port-not-declared')
    expect(
      staleBody.details,
      '拒收时没点名是哪个端口 ⇒ 用户只知道「有问题」，不知道改哪一个',
    ).toMatchObject({ notFound: ['need_fixx'] })
    // 拒收必须是整笔回退：合法的那一项也不许被顺手写进去。
    const afterReject = await getJson<AgentRow>(`/api/agents/${judge.id}`)
    expect(afterReject.branchPorts).toEqual(['all_clear'])

    // ---- 勾选后：同一个工作流、同一段提示词，这次分支真的关得掉 ----
    const after = await runToTerminal('after')
    expect(after.status, '声明了分支端口之后任务仍然失败 ⇒ 勾选这个开关没有任何实际效力').toBe(
      'done',
    )
    expect(after.byNode.get('judge')?.status).toBe('done')
    expect(
      after.byNode.get('greeter')?.status,
      '被关掉的分支下游照样执行了 ⇒ 用户看到的是「代理说不用改，平台还是跑了一遍修复」',
    ).toBe('skipped')
    expect(
      after.byNode.get('out_ok')?.status,
      '关分支只跳过了直接下游，输出节点还在跑 ⇒ 任务详情页会给出一个来源被跳过的空结果卡片',
    ).toBe('skipped')
    // 另一条分支必须照跑——否则「跳过」可能只是整张图都没跑起来。
    expect(after.byNode.get('fixer')?.status).toBe('done')
    expect(after.byNode.get('out_fix')?.status).toBe('done')
  } finally {
    try {
      rmSync(repoDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})
