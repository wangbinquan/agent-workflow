// RFC-319 —— WF-02 / 45 / 55 / 57 / X4 / X5 + UX-28 / UX-37：工作流的**出入口**
// （从配置包进来、往 AI 意图构建出去、启动前的取消、被别人删掉 / 被收回权限之后
// 的终态）与**外壳级偏好**（管理员语言写 daemon、前进后退与滚动位置）。
//
// 这一批的共同点是：**它们都不在"编辑一张图"的主路径上**，所以静止的界面对它们
// 全都给不出信号——一个把 `agentRef` 接回**旧**代理的导入、一个点了取消却仍然把人
// 带走的启动、一个在别处被删掉却仍然显示 "Saved" 的编辑器、一个只会跳转却没把
// 修改目标挂上去的 AI 入口、一个写了 localStorage 却没写 daemon 的语言开关——
// 在界面上与正确的版本长得一模一样，只有把**服务端落库结果 / 出站请求体 / 终态
// 芯片文案**拿出来比才分得清。
//
// 失效形态（这些用例红了，用户会遭遇什么）：
//   * WF-02 —— 从配置包新建的工作流若把节点接回**源**代理，用户以为自己拿到了
//     一份独立副本，实际上两份工作流共用一个代理：日后改其中一个的代理行为，
//     另一个跟着变，而界面上没有任何地方记录过这层关系；若根本没把闭包里的代理
//     列进预览，用户只会得到一张指向不存在代理的图，启动校验时才炸。
//   * WF-45 —— 工作流在另一个标签页 / 另一个人手里被删掉，本页若继续显示
//     "Saved"，用户会接着编辑十分钟，每一次自动保存都静默失败；权限被收回时
//     若不给 inaccessible 终态与"重试访问"，用户看到的是一片空白的画布，
//     既不知道发生了什么，也没有恢复路径。
//   * WF-55 —— "启动任务"要先保存 + 精确校验，慢的时候是好几秒。取消若只是把
//     按钮收起来而没有真的中止，迟到的响应会把人**从编辑器里拽走**；反过来，
//     取消若被当成错误上报，用户会看到一条自己主动触发的红色横幅。
//   * WF-57 —— 平台执行合同目录是"这个工具运行时会收到什么、必须交回什么"的
//     唯一事实源。目录里列了某条合同、按 ref 却读不回它的指南（或读回来的是
//     另一条），作者就会按错误的字段路径实现工具，错误要到运行期才显形；
//     非法 ref 与不存在的 ref 若给同一种拒绝，调用方无法分辨"我拼错了"和
//     "平台没有这条合同"。
//   * WF-X4 —— "用 AI 修改"的入口若只是跳到 /intent 而没把这份工作流挂成修改
//     目标，AI 会从零开始造一张新图，用户以为它在改自己那张。
//   * WF-X5 —— code-round 节点是平台合成的，它的检查器若渲染成一张普通表单，
//     用户会去改一个改不动的东西（改完还不落库），而真正的旋钮在能力配置里。
//   * UX-28 —— 管理员切语言只写浏览器不写 daemon，下次换台机器 / 换个浏览器
//     全部退回英文；写失败若不回滚，界面显示中文而 daemon 仍是英文，两边永久
//     不一致且没有任何提示。
//   * UX-37 —— 后退回列表时滚动位置若归零，用户每看完一条详情就要重新滚半页
//     才能找回刚才那一行。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链——外链会被 CI 的 markdown
// link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/workflows.tsx:230-277                    快速创建弹窗 → `workflow-create-package` → 导入弹窗（expectedRootType='workflow'）
//   packages/backend/src/services/resourcePackage/serialize.ts:42-66      local slug = `${type}-${名字归一}`
//   packages/backend/src/services/resourcePackage/serialize.ts:437-442    导出时 `agentId` 被抬成 `agentRef`
//   packages/backend/src/services/bundle/lower.ts:277-282                 导入时 `agentRef` 落回 `agentId`（这就是"重新接线"）
//   packages/backend/src/services/resourcePackage/closure.ts:228-237      工作流闭包 = 定义里每个节点的 agentId
//   packages/frontend/src/hooks/useWorkflowSync.ts:66-72                  `workflow.deleted` 帧 → onRemoteDelete
//   packages/frontend/src/lib/workflow-editor-draft.ts:364-374            REMOTE_DELETED ⇒ deleted 终态；REMOTE_INACCESSIBLE ⇒ inaccessible 终态
//   packages/frontend/src/hooks/useWorkflowEditorDraft.ts:425-447         "重试访问"是一次**真的** GET，成败分别派发 SUCCEEDED / FAILED
//   packages/frontend/src/routes/workflows.edit.tsx:429                   初次加载 403/404 ⇒ observeInaccessible
//   packages/frontend/src/components/workflow-editor/WorkflowDraftStatus.tsx:232-284  inaccessible / deleted 两块终态区
//   packages/frontend/src/routes/workflows.edit.tsx:940-949               `workflow-launch-cancel` 只在 preparingLaunch 时渲染，点它 = abort
//   packages/frontend/src/routes/workflows.edit.tsx:681-690               AbortError ⇒ setActionError(null)（取消不算错误）
//   packages/backend/src/routes/executionContracts.ts:32-60               目录端点剔除 guideJson；精确端点回整份 guideJson
//   packages/backend/src/modules/execution-contract/domain/model.ts:427-438  ref 形如 `<contractId>@<version>`
//   packages/backend/src/modules/execution-contract/application/executionContractService.ts:95-101  未知 ref ⇒ 404 execution-contract-not-found
//   packages/frontend/src/components/IntentEntryButton.tsx:38-50          create 变体带 hint、modify 变体带 mountType/mountId
//   packages/frontend/src/components/intent/IntentCreateComposer.tsx:76-85  mount ⇒ 请求体带 `mounts` 且**不带** hint
//   packages/frontend/src/components/canvas/NodeInspector.tsx:110         'code-round' → CodeRoundEdit
//   packages/frontend/src/components/canvas/inspector/CodeRoundEdit.tsx:23-30  只有 NoticeBanner + 能力提示，没有任何表单控件
//   packages/frontend/src/components/LanguageSwitch.tsx:73-98             乐观切换 + 明确错误回滚
//   packages/frontend/src/lib/config-resource.ts:38-43                    **只有 4xx 算明确失败**；5xx 属结果未知（走 ambiguous 分支）
//   packages/frontend/src/router.tsx:184-188                              scrollRestoration: true
//   packages/frontend/src/styles.css:5806-5812                            真正滚动的是 `.content`，window 从不滚（.app-shell 锁 100vh）
//
// 与既有覆盖的边界（避免重复）：
//   * `e2e/config-package-import.spec.ts`（RES-39）覆盖的是**代理 + 技能**包的
//     干跑 / 逐项决策；本文件只补它没有的**工作流根**那一档（不同的 closure
//     抽取器、不同的 lower 路径、不同的入口页）。
//   * `e2e/rfc319-workflow-inspector-and-packages.spec.ts` 的 WF-52 覆盖**导出**
//     围栏；本文件覆盖**导入**。
//   * `e2e/rfc250-workflow-camera.spec.ts:798-820` 已锁"他处保存 ⇒ 本页重新拉取
//     且相机不被抢"；本文件补的是同一条能力里**没有**被覆盖的两个终态
//     （deleted / inaccessible）。
//   * `e2e/rfc319-intent-access-boundaries.spec.ts` 锁的是两个入口按钮**按
//     intent:write 收放**（0 / 1 计数）；它从不点开这个按钮，所以"点进去之后
//     挂没挂上修改目标"至今零覆盖——那才是 WF-X4 这条能力本身。
//   * `e2e/rfc319-agent-authoring.spec.ts` 的 AGENT-21 把**目录**当夹具用（挑一条
//     合同去选），从不读精确指南端点，也从不断言目录本身的自洽性与拒绝分支。

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle
let workDir: string
let sequence = 0

interface WorkflowNodeLike extends Record<string, unknown> {
  id: string
  kind: string
}
interface DefinitionLike {
  nodes: WorkflowNodeLike[]
  edges: Array<Record<string, unknown>>
}
interface WorkflowDetailLike {
  id: string
  name: string
  version: number
  snapshotHash: string
  definition: DefinitionLike
}
type LocalizedText = Record<string, string>
type ExecutorKind = 'agent' | 'workflow' | 'program'
/** `GET /api/execution-contracts` 的一条（= runtimeView 去掉 guideJson）。 */
interface ContractSummary {
  contractRef: { contractId: string; version: number }
  displayName: LocalizedText
  description: LocalizedText
  inputMode: string
  inputSchemaId: string
  outputSchemaId: string
  outputTopLevelFields: string[]
  allowedExecutorKinds: ExecutorKind[]
  agentOutputPort: string | null
  agentOutputKind: string | null
}
/** `GET /api/execution-contracts/:ref` 的整份指南。 */
interface ContractGuide {
  contractRef: { contractId: string; version: number }
  displayName: LocalizedText
  description: LocalizedText
  inputMode: string
  allowedExecutorKinds: ExecutorKind[]
  transports: Record<ExecutorKind, { outputPort?: string; outputKind?: string } | null>
  input: {
    schemaId: string
    topLevelFields: string[]
    primaryFieldPaths: string[]
    fields: Array<{ path: string }>
  }
  output: {
    schemaId: string
    topLevelFields: string[]
    primaryFieldPaths: string[]
    fields: Array<{ path: string }>
  }
}

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

async function raw(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.text() }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await raw(daemon.token, path, init)
  expect(res.status < 400, `${init?.method ?? 'GET'} ${path}: ${res.status} ${res.body}`).toBe(true)
  return JSON.parse(res.body) as T
}

/**
 * `clientMutationId` 是**严格的 ULID**（schemas/workflow.ts:379-382：长度 26 +
 * `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`），随手拼一个可读字符串会被 422 拒。
 */
function mutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = String(Math.floor(Math.random() * 8))
  for (let i = 1; i < 26; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

async function seedAgent(name: string): Promise<string> {
  const created = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 workflow entries fixture',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '# fixture\n',
    }),
  })
  return created.id
}

/** 一张最小但**可启动**的图：input → agent-single → output。 */
function runnableDefinition(agentId: string, agentName: string): Record<string, unknown> {
  return {
    $schema_version: 5,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
      {
        id: 'agent_1',
        kind: 'agent-single',
        agentId,
        agentName,
        promptTemplate: 'Handle {{topic}}.',
        position: { x: 320, y: 0 },
      },
      {
        id: 'out_1',
        kind: 'output',
        ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
        position: { x: 640, y: 0 },
      },
    ],
    edges: [
      {
        id: 'e_in_agent',
        source: { nodeId: 'in_1', portName: 'topic' },
        target: { nodeId: 'agent_1', portName: 'topic' },
      },
      {
        id: 'e_agent_out',
        source: { nodeId: 'agent_1', portName: 'answer' },
        target: { nodeId: 'out_1', portName: 'answer' },
      },
    ],
  }
}

async function seedWorkflow(name: string, definition: Record<string, unknown>): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({ name, description: 'RFC-319 workflow entries fixture', definition }),
  })
  return created.id
}

const readWorkflow = (id: string): Promise<WorkflowDetailLike> =>
  api<WorkflowDetailLike>(`/api/workflows/${encodeURIComponent(id)}`)

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

async function openAs(
  browser: Browser,
  token: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await context.addInitScript(
    ([baseUrl, tok]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, token] as const,
  )
  return { context, page: await context.newPage() }
}

async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user' | 'manager' | 'guest'
}): Promise<{ userId: string; sessionToken: string }> {
  const created = await raw(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  expect(created.status, `createUser ${opts.username}: ${created.body}`).toBe(201)
  const { id } = JSON.parse(created.body) as { id: string }
  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  expect(login.ok, `login ${opts.username}: ${login.status}`).toBe(true)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { userId: id, sessionToken }
}

/** 把某个用户加进 / 移出一份工作流的授权表（RFC-099 的 OCC 围栏是必填的）。 */
async function setWorkflowGrants(
  workflowId: string,
  grants: Array<{ userId: string; level: 'read' | 'write' }>,
): Promise<void> {
  const acl = await api<{ aclRevision: number }>(
    `/api/workflows/${encodeURIComponent(workflowId)}/acl`,
  )
  await api(`/api/workflows/${encodeURIComponent(workflowId)}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      grants,
      expectedResourceId: workflowId,
      expectedAclRevision: acl.aclRevision,
    }),
  })
}

async function openEditor(page: Page, workflowId: string, workflowName: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(
    page.getByRole('heading', { level: 1, name: workflowName, exact: true }),
    '编辑器没打开，后面的断言全部无效',
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  workDir = mkdtempSync(join(tmpdir(), 'rfc319-wfux-'))
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test.afterEach(async ({ page }) => {
  // docs/dev-gotchas.md「page.route 两把锁」的锁 B：先摘 handler，再趁 page 还
  // 活着把在飞的 callback 等完。必须是 'wait'，'ignoreErrors' 等于把红吞掉。
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// WF-02 —— 从配置包创建工作流
// ---------------------------------------------------------------------------

test('RFC-319 WF-02: 从配置包新建工作流——预览列出根工作流与它引用的代理，两项都选新建后落库的节点接的是新代理而不是源代理 @nightly', async ({
  page,
}) => {
  const run = ++sequence
  const sourceAgentName = `rfc319-wf02-agent-${run}`
  const sourceWorkflowName = `rfc319-wf02-flow-${run}`
  const sourceAgentId = await seedAgent(sourceAgentName)
  const sourceWorkflowId = await seedWorkflow(
    sourceWorkflowName,
    runnableDefinition(sourceAgentId, sourceAgentName),
  )

  const exported = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(sourceWorkflowId)}/export-package`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  expect(exported.status, '工作流导出包没拿到，导入侧的夹具前提不成立').toBe(200)
  const packagePath = join(workDir, `rfc319-wf02-${run}.zip`)
  writeFileSync(packagePath, Buffer.from(await exported.arrayBuffer()))

  // slug 由 serialize.ts:47-54 从「类型 + 名字归一」派生，所以这里可以**精确**
  // 预期它是哪两条，而不是「里面有 workflow 字样的那条」。
  const workflowSlug = `workflow-${sourceWorkflowName}`
  const agentSlug = `agent-${sourceAgentName}`

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows`)
  await page.getByTestId('workflow-new-button').click()
  await page.getByTestId('workflow-create-package').click()
  await page.getByTestId('package-import-file').setInputFiles(packagePath)
  await page.getByTestId('package-import-preview').click()
  await expect(page.getByTestId('package-import-commit')).toBeVisible({ timeout: 30_000 })

  // 闭包判据：一份只引用了一个代理的工作流，包里必须**恰好**是这两条。少了
  // 代理那条 ⇒ 导入出来的图指向一个本机可能不存在的代理；多出别的条目 ⇒ 用户
  // 在毫不知情的情况下被要求对无关资源做决策。
  const entrySlugs = await page.locator('[data-testid^="package-action-"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const id = node.getAttribute('data-testid') ?? ''
      const rest = id.slice('package-action-'.length)
      return rest.slice(0, rest.lastIndexOf('-'))
    }),
  )
  expect(
    [...new Set(entrySlugs)].sort(),
    '预览里的条目不是「根工作流 + 它引用的代理」这两条',
  ).toEqual([agentSlug, workflowSlug].sort())

  // 根类型与入口一致 ⇒ 不该出现「这不是工作流包」的提示（对照 RES-39 里那条
  // 专门验错配的用例）。
  await expect(
    page.getByTestId('package-import-root-mismatch'),
    '工作流包从工作流入口导入却被判成根类型不符',
  ).toHaveCount(0)

  const importedWorkflowName = `rfc319-wf02-imported-flow-${run}`
  const importedAgentName = `rfc319-wf02-imported-agent-${run}`
  await page.getByTestId(`package-action-${workflowSlug}-new`).click()
  await page.getByTestId(`package-name-${workflowSlug}`).fill(importedWorkflowName)
  await page.getByTestId(`package-action-${agentSlug}-new`).click()
  await page.getByTestId(`package-name-${agentSlug}`).fill(importedAgentName)

  await page.getByTestId('package-import-commit').click()
  await expect(page.getByTestId('package-import-report')).toBeVisible({ timeout: 60_000 })

  const agents = await api<Array<{ id: string; name: string }>>('/api/agents')
  const importedAgent = agents.find((row) => row.name === importedAgentName)
  expect(importedAgent, '选了「新建」却没有新建代理').toBeTruthy()
  expect(
    agents.find((row) => row.name === sourceAgentName)?.id,
    '「新建」不许动同名的既有代理——那是源工作流还在用的东西',
  ).toBe(sourceAgentId)

  const workflows = await api<Array<{ id: string; name: string }>>('/api/workflows')
  const importedWorkflow = workflows.find((row) => row.name === importedWorkflowName)
  expect(importedWorkflow, '选了「新建」却没有新建工作流').toBeTruthy()
  const importedDefinition = (await readWorkflow(importedWorkflow!.id)).definition
  expect(
    importedDefinition.nodes.map((node) => node.kind).sort(),
    '导入出来的图节点数 / 种类与源图不一致 ⇒ 定义在往返里被改写了',
  ).toEqual(['agent-single', 'input', 'output'])
  const importedAgentNode = importedDefinition.nodes.find((node) => node.kind === 'agent-single')
  expect(
    importedAgentNode?.agentId,
    '导入出来的节点接回了**源**代理 ⇒ 两份工作流共用一个代理，' +
      '日后改源代理这份跟着变，而这层关系没有任何地方记录过',
  ).toBe(importedAgent!.id)
  expect(importedAgentNode?.agentId, '重新接线判据的对照：它绝不能还是源代理 id').not.toBe(
    sourceAgentId,
  )

  // 源工作流本身一个字节没动（导入是新建，不是覆盖）。
  const sourceDefinition = (await readWorkflow(sourceWorkflowId)).definition
  expect(
    sourceDefinition.nodes.find((node) => node.kind === 'agent-single')?.agentId,
    '导入顺手改掉了源工作流的接线',
  ).toBe(sourceAgentId)

  // 回执上的「打开」是这条链路的收尾：它必须真的把人带到**新建的那份**。
  await page.getByTestId('package-import-open-root').click()
  await page.waitForURL((url) => url.pathname === `/workflows/${importedWorkflow!.id}`, {
    timeout: 30_000,
  })
  await expect(
    page.getByRole('heading', { level: 1, name: importedWorkflowName, exact: true }),
  ).toBeVisible({ timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// WF-45 —— 多端同步的两个终态
// ---------------------------------------------------------------------------

test('RFC-319 WF-45: 工作流在别处被删除——本页不刷新就从 Saved 翻成 Deleted 终态，并给出一条真的能走的返回列表 @nightly', async ({
  page,
}) => {
  const run = ++sequence
  const agentName = `rfc319-wf45a-agent-${run}`
  const workflowName = `rfc319-wf45a-flow-${run}`
  const agentId = await seedAgent(agentName)
  const workflowId = await seedWorkflow(workflowName, runnableDefinition(agentId, agentName))

  await primeAuth(page)
  await openEditor(page, workflowId, workflowName)
  // 「不在场」的一半：删除之前这一整块终态区根本不该渲染。少了这条，下面的
  // 「出现了」就可能只是「它一直都在」。
  await expect(
    page.getByTestId('workflow-draft-status-focus'),
    '还没发生任何事就已经在显示草稿终态区',
  ).toHaveCount(0)

  const detail = await readWorkflow(workflowId)
  const deleted = await raw(daemon.token, `/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
    body: JSON.stringify({
      expectedVersion: detail.version,
      clientMutationId: mutationId(),
      confirm: workflowName,
    }),
  })
  expect(deleted.status < 400, `删除夹具工作流失败：${deleted.status} ${deleted.body}`).toBe(true)

  // 页面**没有**导航、没有刷新——状态是 /ws/workflows 的 workflow.deleted 帧推过来的。
  await expect(
    page.getByTestId('workflow-draft-phase'),
    '工作流已经被删了，编辑器还显示 Saved ⇒ 用户会继续编辑，每次自动保存都静默失败',
  ).toHaveText('Deleted', { timeout: 30_000 })
  const terminal = page.getByTestId('workflow-draft-status-focus')
  await expect(terminal).toBeVisible()
  await expect(
    terminal,
    '终态横幅没说清是「被删除」⇒ 用户无法把它和普通的保存失败区分开',
  ).toContainText('Workflow deleted')

  await terminal.getByRole('button', { name: 'Return to workflows' }).click()
  await page.waitForURL((url) => url.pathname === '/workflows', { timeout: 30_000 })
  // 终态里的这个动作是用户的显式决定，产品刻意不再二次确认
  // （workflows.edit.tsx:1080-1085）——如果它弹了确认框，上面的 waitForURL 会超时，
  // 这一条则把「弹了但被自动放行」也堵上。
  await expect(page.getByRole('dialog'), '返回列表这一步弹了二次确认').toHaveCount(0)
})

test('RFC-319 WF-45: 编辑器开着时权限被收回——下一次自动保存把页面推进 inaccessible 终态，「重试访问」在恢复授权前后给出不同结果 @nightly', async ({
  browser,
}) => {
  const run = ++sequence
  const agentName = `rfc319-wf45b-agent-${run}`
  const workflowName = `rfc319-wf45b-flow-${run}`
  const agentId = await seedAgent(agentName)
  // 三个节点故意全部叠在 (0,0)：这样「自动布局」必定改动定义，而不是把一份
  // 本来就摊开的图重排成同样的坐标（那样这条用例就成了空转）。
  const stacked = runnableDefinition(agentId, agentName)
  for (const node of stacked.nodes as Array<Record<string, unknown>>) {
    node.position = { x: 0, y: 0 }
  }
  const workflowId = await seedWorkflow(workflowName, stacked)

  const carol = await createUserAndLogin({
    username: `rfc319-wf45b-carol-${run}`,
    password: 'longEnoughPassword',
    role: 'user',
  })
  await setWorkflowGrants(workflowId, [{ userId: carol.userId, level: 'write' }])

  const side = await openAs(browser, carol.sessionToken)
  try {
    const { page } = side
    await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
    await expect(
      page.getByRole('heading', { level: 1, name: workflowName, exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved', { timeout: 30_000 })
    await expect(
      page.getByTestId('workflow-draft-status-focus'),
      '还没发生任何事就已经在显示草稿终态区',
    ).toHaveCount(0)

    // 收回授权，然后照常继续编辑——用户这一侧没有任何提示，他不知道自己刚刚
    // 失去了这份工作流。用「自动布局」当这一笔编辑：它是**内容**改动，恢复授权
    // 之后 edit grant 足以把它保存回去（改名不行：服务端 403
    // `resource-rename-owner-only`——edit 授权只覆盖内容）。
    await setWorkflowGrants(workflowId, [])
    await clickCanvasControl(page, 'workflow-layout-all')

    const terminal = page.getByTestId('workflow-draft-status-focus')
    await expect(
      page.getByTestId('workflow-draft-phase'),
      '权限已经没了，自动保存却还在静默重试 ⇒ 用户会继续编辑，什么也保存不上',
    ).toHaveText('Inaccessible', { timeout: 30_000 })
    await expect(terminal).toBeVisible()
    await expect(
      terminal,
      '终态没说清是「读不到了」⇒ 用户无法把权限问题和普通保存失败区分开',
    ).toContainText('This workflow is no longer accessible')

    // ① 还没恢复授权时点「重试访问」：它必须**真的**去问一次服务端，因此仍然
    //    停在 inaccessible。少了这一步，下面的「恢复授权后能回来」用一个无条件
    //    清状态的假按钮也能通过。
    await terminal.getByRole('button', { name: 'Retry access' }).click()
    await expect(
      page.getByTestId('workflow-draft-phase'),
      '服务端还在拒绝，「重试访问」却把终态清掉了 ⇒ 这个按钮只是在骗用户，' +
        '他会接着编辑一份永远保存不上的草稿',
    ).toHaveText('Inaccessible')
    await expect(terminal).toContainText('This workflow is no longer accessible')

    // ② 恢复授权之后再点同一个按钮：这一次必须真的回到可用态。先在 Node 侧
    //    确认服务端确实放行了，否则这一次点击到底该不该成功本身就是不确定的。
    await setWorkflowGrants(workflowId, [{ userId: carol.userId, level: 'write' }])
    await expect
      .poll(async () => (await raw(carol.sessionToken, `/api/workflows/${workflowId}`)).status)
      .toBe(200)
    await terminal.getByRole('button', { name: 'Retry access' }).click()
    await expect(
      page.getByTestId('workflow-draft-phase'),
      '授权已经恢复，「重试访问」却还是回不来 ⇒ 这个按钮是装饰，用户只能刷整页并丢掉草稿',
    ).toHaveText('Saved', { timeout: 30_000 })
    await expect(page.getByTestId('workflow-draft-status-focus')).toHaveCount(0)
    // 被终态扣下的那一笔编辑在恢复后自己落了地——这就是「本地草稿被保留」的
    // 可验证形态（workflow-editor-draft.ts:980-993 的 REQUEST_SAVE）。判据不是
    // 「位置变了」而是「布局算对了」：夹具里三个节点**全部**叠在 (0,0)，自动
    // 布局的定义就是把它们摊开成互不重叠的坐标。
    await expect
      .poll(
        async () => {
          const nodes = (await readWorkflow(workflowId)).definition.nodes
          const positions = nodes.map((node) => JSON.stringify(node.position))
          return new Set(positions).size
        },
        { message: '恢复访问后被扣下的草稿没有补上 ⇒ 用户那次编辑被静默吞掉' },
      )
      .toBe(3)
  } finally {
    await side.context.close()
  }
})

// ---------------------------------------------------------------------------
// WF-55 —— 启动准备期间的取消
// ---------------------------------------------------------------------------

test('RFC-319 WF-55: 启动准备期点取消——中止在飞的精确校验、留在编辑器且不报错，迟到的成功响应也不会把人带走 @nightly', async ({
  page,
}) => {
  const run = ++sequence
  const agentName = `rfc319-wf55-agent-${run}`
  const workflowName = `rfc319-wf55-flow-${run}`
  const agentId = await seedAgent(agentName)
  const workflowId = await seedWorkflow(workflowName, runnableDefinition(agentId, agentName))
  const detail = await readWorkflow(workflowId)

  // 锁 A（docs/dev-gotchas.md）：要回源的真实响应就在 Node 侧预取，handler 里
  // 只剩一次 fulfill。这份回执是**真的**——所以放行之后，只要取消没生效，
  // 启动就会真的跳走，下面那条 URL 断言就会红。
  const receipt = await api<Record<string, unknown>>(
    `/api/workflows/${encodeURIComponent(workflowId)}/validate`,
    {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: detail.version,
        expectedSnapshotHash: detail.snapshotHash,
      }),
    },
  )

  await primeAuth(page)
  await openEditor(page, workflowId, workflowName)
  const editorPath = `/workflows/${workflowId}`

  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const validatePath = `/api/workflows/${workflowId}/validate`
  await page.route(
    (url) => url.pathname === validatePath,
    async (route) => {
      await gate
      await route
        .fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(receipt),
        })
        .catch(() => undefined)
    },
  )

  await page.getByRole('button', { name: 'Launch task' }).click()
  const cancel = page.getByTestId('workflow-launch-cancel')
  await expect(
    cancel,
    '启动准备期没有出现取消入口 ⇒ 慢的时候用户只能干等，或者以为界面卡死',
  ).toBeVisible({ timeout: 30_000 })

  await cancel.click()
  await expect(cancel, '点了取消，准备态还挂在那里').toHaveCount(0)
  await expect(
    page.getByTestId('workflow-action-error-focus'),
    '取消是用户自己按的，被当成错误报出来 ⇒ 一条自己触发的红色横幅',
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Launch task' })).toBeEnabled()
  expect(new URL(page.url()).pathname, '取消之后人已经不在编辑器了').toBe(editorPath)

  // 放行那条被挂住的请求：它带的是一份**有效**回执，取消若没有真的 abort，
  // 这里就会走完 handleLaunch 的后半段并跳到 /launch。
  release!()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByTestId('workflow-action-error-focus')).toHaveCount(0)
  expect(
    new URL(page.url()).pathname,
    '取消之后迟到的成功响应仍然把人带走了 ⇒ 取消只是把按钮藏了起来',
  ).toBe(editorPath)

  // 正向对照：同一个按钮、同一张图，不取消时**必须**跳到启动向导。没有这一条，
  // 上面两条「还在编辑器」用一个坏掉的启动按钮也能满足。
  await page.getByRole('button', { name: 'Launch task' }).click()
  // `/workflows/:id/launch` is a synchronous legacy redirect; fast WebKit can
  // pass through that transient URL before waitForURL starts observing it.
  // Assert the stable task-wizard destination and its exact-revision handoff.
  await page.waitForURL((url) => url.pathname === '/tasks/new', { timeout: 30_000 })
  const launchUrl = new URL(page.url())
  expect(launchUrl.searchParams.get('kind')).toBe('workflow')
  expect(launchUrl.searchParams.get('workflow')).toBe(workflowId)
  expect(launchUrl.searchParams.get('workflowVersion'), '启动交接没带上精确版本号').toBe(
    String(detail.version),
  )
})

// ---------------------------------------------------------------------------
// WF-57 —— 执行合同目录 与 精确合同指南
// ---------------------------------------------------------------------------

test('RFC-319 WF-57: 执行合同目录逐条都能按精确 ref 读回自洽的指南，非法 ref 与不存在的 ref 给出可分辨的拒绝，无权账号一条都读不到 @nightly', async () => {
  const run = ++sequence
  const catalog = await api<{ items: ContractSummary[] }>('/api/execution-contracts')
  // 语料下限：目录空了下面整个循环就是空转绿。
  expect(
    catalog.items.length,
    '平台执行合同目录是空的 ⇒ 下面逐条对账的循环一次都不会跑',
  ).toBeGreaterThan(0)

  // 目录条目**不是**指南的子集，而是它的一份派生投影
  // （executionContractService.ts:34-52）：schemaId / topLevelFields /
  // agentOutputPort / agentOutputKind 都是算出来的。所以逐条比的不是「长得像」，
  // 而是「每一格都还能从指南算回来」——投影错一格，选择器与运行期就会各按各的
  // 字段走，而两边都不会报错。
  for (const summary of catalog.items) {
    const ref = `${summary.contractRef.contractId}@${summary.contractRef.version}`
    const guide = await api<ContractGuide>(`/api/execution-contracts/${encodeURIComponent(ref)}`)
    expect(
      guide.contractRef,
      `按 ${ref} 读回来的指南属于另一条合同 ⇒ 作者会照着别人的字段路径实现工具`,
    ).toEqual(summary.contractRef)
    expect(
      guide.displayName,
      `${ref} 的目录条目与精确指南标题不一致 ⇒ 用户在选择器里选的和读到的不是同一条`,
    ).toEqual(summary.displayName)
    expect(guide.description).toEqual(summary.description)
    expect(guide.inputMode).toBe(summary.inputMode)
    expect(
      summary.inputSchemaId,
      `${ref} 的目录输入 schema 与指南对不上 ⇒ 校验用的是一份、文档写的是另一份`,
    ).toBe(guide.input.schemaId)
    expect(summary.outputSchemaId).toBe(guide.output.schemaId)
    expect(
      summary.outputTopLevelFields,
      `${ref} 的目录输出顶层字段与指南对不上 ⇒ 工具照目录交回的产物会被校验器拒掉`,
    ).toEqual(guide.output.topLevelFields)
    expect(summary.allowedExecutorKinds).toEqual(guide.allowedExecutorKinds)

    // 「可用执行体」与「有没有 transport」是同一件事的两种说法
    // （domain/model.ts:327-338 的 superRefine）。任一侧掉了，界面会给出一个
    // 选得中却根本注入不进参数的执行体。
    for (const kind of ['agent', 'workflow', 'program'] as const) {
      expect(
        summary.allowedExecutorKinds.includes(kind),
        `${ref} 的 ${kind}：可用性与 transport 声明自相矛盾`,
      ).toBe(guide.transports[kind] !== null)
    }
    const agentTransport = guide.transports.agent
    expect(
      summary.agentOutputPort,
      `${ref} 的 agentOutputPort 不是从 agent transport 派生的 ⇒ 平台按契约投递结果时找错出口`,
    ).toBe(agentTransport === null ? null : (agentTransport.outputPort ?? 'agent-result'))
    expect(summary.agentOutputKind).toBe(agentTransport?.outputKind ?? null)

    // 目录**刻意不带**整份指南（executionContracts.ts:40-42 的解构剔除）：
    // 它是一次列全部合同的请求，塞进 N 份指南等于每开一次选择器就传一遍全文。
    expect(
      (summary as Record<string, unknown>).guideJson,
      `${ref} 的目录条目里夹带了整份指南 JSON`,
    ).toBeUndefined()

    // 指南自洽：被标成「关键业务参数 / 产出」的路径必须真的在字段表里。
    // 对不上时界面（ExecutionContractGuidePanel 的 flatMap 找不到就丢掉）会
    // **静默少画一格**，作者不会知道自己漏读 / 漏写了一个必填字段。
    const inputPaths = new Set(guide.input.fields.map((field) => field.path))
    const outputPaths = new Set(guide.output.fields.map((field) => field.path))
    expect(
      guide.input.primaryFieldPaths.filter((path) => !inputPaths.has(path)),
      `${ref} 的关键输入字段指向了字段表里不存在的路径`,
    ).toEqual([])
    expect(
      guide.output.primaryFieldPaths.filter((path) => !outputPaths.has(path)),
      `${ref} 的关键产出字段指向了字段表里不存在的路径`,
    ).toEqual([])
  }

  // 语料下限之二：上面的循环里有一半判据只在「这条合同支持 agent」时才有内容，
  // 全表都不支持 agent 的话它们全是空转（而 AGENT-21 的选择器正是靠这一档）。
  expect(
    catalog.items.filter((item) => item.allowedExecutorKinds.includes('agent')).length,
    '目录里没有任何一条允许 agent 执行 ⇒ 代理端口物化那一整条链路无从谈起',
  ).toBeGreaterThan(0)

  // 两种拒绝必须可分辨：拼错了 vs 平台没有这条。给同一种码的话调用方无从下手。
  const malformed = await raw(daemon.token, '/api/execution-contracts/not-a-valid-ref')
  expect(malformed.status, `非法 ref 的状态码：${malformed.body}`).toBe(422)
  expect(JSON.parse(malformed.body).code).toBe('execution-contract-ref-invalid')

  const unknown = await raw(daemon.token, '/api/execution-contracts/rfc319-no-such-contract%401')
  expect(unknown.status, `不存在的 ref 的状态码：${unknown.body}`).toBe(404)
  expect(
    JSON.parse(unknown.body).code,
    '不存在的合同与拼错的 ref 给了同一种拒绝 ⇒ 调用方分不清该改哪一边',
  ).toBe('execution-contract-not-found')

  // 目录端点挂的是 digital-employees:read（executionContracts.ts:36-39），
  // guest 预设里没有这一点。
  const guest = await createUserAndLogin({
    username: `rfc319-wf57-guest-${run}`,
    password: 'longEnoughPassword',
    role: 'guest',
  })
  const listAsGuest = await raw(guest.sessionToken, '/api/execution-contracts')
  expect(listAsGuest.status, `guest 读目录：${listAsGuest.body}`).toBe(403)
  const first = catalog.items[0]!
  const guideAsGuest = await raw(
    guest.sessionToken,
    `/api/execution-contracts/${encodeURIComponent(
      `${first.contractRef.contractId}@${first.contractRef.version}`,
    )}`,
  )
  expect(
    guideAsGuest.status,
    'guest 读不到目录却读得到精确指南 ⇒ 逐条 URL 就是一条绕过目录门的旁路',
  ).toBe(403)
})

// ---------------------------------------------------------------------------
// WF-X4 —— 从工作流列表 / 编辑器进入 AI 意图构建
// ---------------------------------------------------------------------------

test('RFC-319 WF-X4: 工作流列表与编辑器的 AI 入口——列表带工件提示、编辑器把这份工作流当修改目标挂进创建请求 @nightly', async ({
  page,
}) => {
  const run = ++sequence
  const agentName = `rfc319-wfx4-agent-${run}`
  const workflowName = `rfc319-wfx4-flow-${run}`
  const agentId = await seedAgent(agentName)
  const workflowId = await seedWorkflow(workflowName, runnableDefinition(agentId, agentName))

  await primeAuth(page)

  // ① 列表入口 = create 变体：带工件提示、**不**带挂载目标。
  await page.goto(`${daemon.baseUrl}/workflows`)
  await page.getByTestId('workflows-intent-entry').click()
  await page.waitForURL((url) => url.pathname === '/intent', { timeout: 30_000 })
  const listSearch = new URL(page.url()).searchParams
  expect(listSearch.get('create'), '列表入口没把创建弹窗一起带开').toBe('true')
  expect(
    listSearch.get('hint'),
    '列表入口没带工件提示 ⇒ AI 得从零猜用户想造的是工作流还是别的什么',
  ).toBe('workflow')
  expect(listSearch.get('mountType'), '列表入口不该挂任何修改目标').toBeNull()
  const createDialog = page.getByRole('dialog')
  await expect(createDialog).toBeVisible({ timeout: 30_000 })
  await expect(
    createDialog.getByTestId('intent-modify-target'),
    '列表入口开出来的是「修改某个既有资源」的弹窗',
  ).toHaveCount(0)
  await expect(
    createDialog.locator('[data-testid="intent-create-hint-workflow"]'),
    '列表入口开出来的弹窗里没有工件类型选择 ⇒ create 变体退化成了 modify 变体',
  ).toBeVisible()

  // ② 编辑器入口 = modify 变体：带 mountType/mountId、不带 hint。
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(
    page.getByRole('heading', { level: 1, name: workflowName, exact: true }),
  ).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('workflow-intent-entry').click()
  await page.waitForURL((url) => url.pathname === '/intent', { timeout: 30_000 })
  const editorSearch = new URL(page.url()).searchParams
  expect(editorSearch.get('mountType'), '编辑器入口没说明挂载的是什么类型').toBe('workflow')
  expect(
    editorSearch.get('mountId'),
    '编辑器入口挂的不是当前这份工作流 ⇒ AI 会去改另一张图（或从零造一张）',
  ).toBe(workflowId)

  const modifyDialog = page.getByRole('dialog')
  await expect(modifyDialog).toBeVisible({ timeout: 30_000 })
  await expect(
    modifyDialog.getByTestId('intent-modify-target'),
    '编辑器入口没把「修改目标」告诉用户',
  ).toBeVisible()
  await expect(
    modifyDialog.locator('[data-testid^="intent-create-hint-"]'),
    'modify 变体不该再问「你想造哪类资源」——目标已经定了',
  ).toHaveCount(0)

  // ③ 真正的判据：预挂载最终要变成创建请求里的 `mounts`。拦下这唯一一条
  //    pathname 把请求体读出来（**不放行**，免得留下一个真会去跑轮次的会话）。
  let createBody: Record<string, unknown> | null = null
  await page.route(
    (url) => url.pathname === '/api/intent-sessions',
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      createBody = route.request().postDataJSON() as Record<string, unknown>
      await route
        .fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'rfc319-wfx4-not-really-creating',
            message: 'RFC-319 WF-X4 intercepted the create so no session is left behind',
          }),
        })
        .catch(() => undefined)
    },
  )
  await modifyDialog.getByTestId('intent-create-message').fill('rfc319 wf-x4 rewire the outputs')
  await modifyDialog.getByRole('button', { name: 'Start building' }).click()
  await expect.poll(() => createBody, { message: '点了开始构建却没有发出创建请求' }).not.toBeNull()
  expect(
    createBody!.mounts,
    '创建请求里没有把这份工作流挂成修改目标 ⇒ 界面上写着「修改目标」，AI 收到的却是一句空指令',
  ).toEqual([{ resourceType: 'workflow', resourceId: workflowId }])
  expect(
    createBody!.hint,
    'modify 请求里还带着工件提示 ⇒ 与挂载目标可能互相矛盾（IntentCreateComposer.tsx:82）',
  ).toBeUndefined()
})

// ---------------------------------------------------------------------------
// WF-X5 —— code-round 节点的只读检查器
// ---------------------------------------------------------------------------

test('RFC-319 WF-X5: code-round 节点的检查器只给只读说明——点名不可编辑、说清本轮能力，面板里一个可编辑控件都没有 @nightly', async ({
  page,
}) => {
  const run = ++sequence
  const workflowName = `rfc319-wfx5-flow-${run}`
  // 用户永远编写不出这种节点（validator 的 `code-round-not-authorable` 会拒），
  // 但任务详情页要画**已经跑过**的那份快照，所以渲染路径必须成立。这里用
  // 定义直写复现那份快照的形状——PUT/POST 不跑完整校验器（校验是显式端点）。
  const workflowId = await seedWorkflow(workflowName, {
    $schema_version: 5,
    inputs: [],
    nodes: [
      {
        id: 'round_1',
        kind: 'code-round',
        capability: 'mr-review',
        roundSeq: 3,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  })

  await primeAuth(page)
  await openEditor(page, workflowId, workflowName)

  // 画布卡片：能力与轮次是「读者来这里就是想知道的两件事」，桥接断了就退回
  // 破折号占位（WorkflowCanvas.tsx:3835-3839）。
  await expect(
    page.getByTestId('code-round-node-capability'),
    'code-round 卡片没把本轮能力画出来 ⇒ 快照上只剩一个破折号',
  ).toHaveText('MR review')
  await expect(page.getByTestId('code-round-node-seq')).toHaveText('#3')

  await page.locator('.react-flow__node[data-id="round_1"] .canvas-node__header').click()
  const readOnlyPanel = page.getByTestId('code-round-edit')
  await expect(readOnlyPanel, 'code-round 节点的检查器什么都没渲染').toBeVisible({
    timeout: 30_000,
  })
  await expect(
    readOnlyPanel,
    '面板没有明说「这是平台合成的、改不了」⇒ 用户会去找一个不存在的编辑入口',
  ).toContainText('synthesized by the platform and cannot be edited')
  await expect(
    page.getByTestId('code-round-edit-capability'),
    '面板没说清这一轮跑的是哪个能力 ⇒ 用户不知道该去改哪份能力配置',
  ).toContainText('mr-review')

  // 「只读」这件事本身：编辑页签里**一个**可编辑控件都不许有。别的 kind 的
  // 检查器起手就是 NodeTitleField 的 TextInput，所以这条计数一旦被换成通用
  // 表单立刻变红。
  const editPanel = page.locator('[role="tabpanel"]:not([hidden])').filter({ has: readOnlyPanel })
  await expect(editPanel).toHaveCount(1)
  await expect(
    editPanel.locator('input, textarea, select, [contenteditable="true"], [role="combobox"]'),
    'code-round 的检查器渲染出了可编辑控件 ⇒ 用户改完既不落库也没人告诉他为什么',
  ).toHaveCount(0)
  // 预览页签只对 agent-single / call-workgroup / review 开放（NodeInspector.tsx:170-174），
  // 所以这里必须**只有**一个页签；多出来的那个会是一片空白。
  await expect(page.locator('[data-inspector-content="node"]').getByRole('tab')).toHaveCount(1)
})

// ---------------------------------------------------------------------------
// UX-28 —— 管理员语言切换写 daemon 配置
// ---------------------------------------------------------------------------

test('RFC-319 UX-28: 管理员切语言写进 daemon 配置；写被明确拒绝时先乐观切换、再回滚，并把服务端理由显示成 alert @nightly', async ({
  page,
}) => {
  const configLanguage = async (): Promise<string> =>
    (await api<{ language: string }>('/api/config')).language

  expect(await configLanguage(), '夹具前提：daemon 起来时是英文').toBe('en-US')

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents`)
  const sidebar = page.getByTestId('desktop-sidebar')
  const zh = sidebar.locator('.language-switch__option[data-lang="zh-CN"]')
  const en = sidebar.locator('.language-switch__option[data-lang="en-US"]')
  // 两个不同的可观察面，缺一不可：
  //   * `aria-checked` 跟的是 **daemon 的权威值**（LanguageSwitch.tsx:60-65 里
  //     `daemonLanguage` 优先于 i18next），
  //   * 侧栏文案跟的是 **i18next 当前语言**——乐观切换只动得了后者。
  // 只看其中一个就分不清「界面切了」与「daemon 真的改了」。
  const navLabelEn = sidebar.getByText('Agents', { exact: true })
  const navLabelZh = sidebar.getByText('代理', { exact: true })
  await expect(navLabelEn).toBeVisible({ timeout: 30_000 })
  await expect(en).toHaveAttribute('aria-checked', 'true')

  // ① 成功一半：管理员的选择必须落到 **daemon 配置**里，不只是本浏览器。
  await zh.click()
  await expect(zh).toHaveAttribute('aria-checked', 'true')
  await expect(navLabelZh).toBeVisible()
  await expect
    .poll(configLanguage, {
      message: '管理员切了语言，daemon 配置没跟着改 ⇒ 换台机器 / 换个浏览器全部退回英文',
    })
    .toBe('zh-CN')

  // ② 失败一半。注意判据取自 lib/config-resource.ts:38-43：**只有 4xx 才算
  //    "明确失败"**，5xx 属于结果未知、走的是另一条 ambiguous 分支。所以这里
  //    注入的是 400，否则测的根本不是回滚那条路径。
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback()
        return
      }
      await gate
      await route
        .fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'rfc319-ux28-refused',
            message: 'RFC-319 UX-28 refused this write',
          }),
        })
        .catch(() => undefined)
    },
  )

  await en.click()
  // 乐观：请求还挂在门后，界面已经先切过去了（onMutate 里的 setLanguage）。
  await expect(
    navLabelEn,
    '乐观切换没有发生 ⇒ 每次切语言都要等一次往返，慢网络下像是没反应',
  ).toBeVisible()
  // 同一时刻，权威值还没动——分段控件仍指着 daemon 说的那一个。
  await expect(zh).toHaveAttribute('aria-checked', 'true')

  release!()
  await expect(
    navLabelZh,
    'daemon 明确拒绝了这次写，界面却停在新语言 ⇒ 两边永久不一致且没人知道',
  ).toBeVisible({ timeout: 30_000 })
  await expect(navLabelEn).toHaveCount(0)
  const alert = page.locator('.language-switch__error')
  await expect(alert).toHaveAttribute('role', 'alert')
  await expect(alert, '回滚了却不说为什么 ⇒ 用户只会看到自己的点击被"吃掉"').toContainText(
    'RFC-319 UX-28 refused this write',
  )
  expect(await configLanguage(), '被拒绝的那次写不该改动 daemon 配置').toBe('zh-CN')

  // 复位，免得后面的用例在中文界面上跑（管理员的 daemon 配置压过 localStorage）。
  await page.unrouteAll({ behavior: 'wait' })
  await en.click()
  await expect.poll(configLanguage).toBe('en-US')
})

// ---------------------------------------------------------------------------
// UX-37 —— 前进后退与滚动位置恢复
// ---------------------------------------------------------------------------

test('RFC-319 UX-37: 后退回到长页面时恢复的是离开前的滚动位置，再前进仍回到刚才那一页 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/docs/api`)
  // 真正滚动的是 `.content`（AppShell.tsx:223 的 <main>；styles.css:5806-5812
  // 给它 overflow:auto，而 .app-shell 锁 100vh + overflow:hidden，window 永远不滚）。
  const content = page.getByTestId('app-shell-main')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () =>
        await content.evaluate((el) =>
          el.scrollHeight > el.clientHeight + 400 ? 'tall' : 'short',
        ),
      { message: '这一页短到根本滚不动 ⇒ 下面的滚动恢复断言测不到任何东西' },
    )
    .toBe('tall')

  const target = 500
  await content.evaluate((el, top) => {
    el.scrollTop = top
  }, target)
  await expect
    .poll(async () => await content.evaluate((el) => Math.round(el.scrollTop)))
    .toBe(target)

  // 站内导航（不是整页 goto）——路由的 onBeforeLoad 就是在这一刻给上一页拍快照的。
  await page.getByTestId('desktop-sidebar').getByText('Agents', { exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/agents', { timeout: 30_000 })
  await expect.poll(async () => await content.evaluate((el) => Math.round(el.scrollTop))).toBe(0)

  await page.goBack()
  await page.waitForURL((url) => url.pathname === '/docs/api', { timeout: 30_000 })
  await expect
    .poll(async () => await content.evaluate((el) => Math.round(el.scrollTop)), {
      message:
        '后退回来滚动位置归零 ⇒ 每看完一条就要重新滚半页才能找回刚才那一行；' +
        '判据必须是"回到原来那个位置"，只断言"不为 0"的话随便一段残留滚动都能通过',
    })
    .toBeGreaterThan(target - 50)
  const restored = await content.evaluate((el) => Math.round(el.scrollTop))
  expect(restored, `后退恢复的位置离开走前差太远（实测 ${restored}）`).toBeLessThan(target + 50)

  await page.goForward()
  await page.waitForURL((url) => url.pathname === '/agents', { timeout: 30_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Agents', exact: true })).toBeVisible({
    timeout: 30_000,
  })
})
