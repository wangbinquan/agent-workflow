// RFC-319 —— 动态工作流编排面 + 工作流里的子工作组调用。
//
// 覆盖能力账本行：WG-27 / WG-28 / WG-X5 / WG-42 / TASK-X4b。
//
// 与既有 spec 的分工（**务必不要重复**）：
//   · e2e/workgroup-matrix.spec.ts —— 同一条 dynamic-workflow 全链**全程 apiFetch**，
//     一次浏览器都不开：它锁的是引擎（生成→驳回→重生成→审批→执行的服务端语义）。
//     编排面本身（相位卡 / 只读预览画布 / 驳回对话框 / 另存回执 / 工作流画布何时
//     才肯渲染真图）它一格都没锁，今天只有 jsdom + mock fetch 的
//     `packages/frontend/tests/dynamic-workflow-panel.test.tsx` 在守，
//     那份用例连一次真实的 `/dw-confirm` 都没发过。本文件补的就是这一层。
//   · e2e/rfc319-workgroup-room-and-delivery.spec.ts —— 房间的发言 / 派单 / 完成门
//     **交互**契约。它的 WG-29 顺带断言过「派单卡不刷新自己出现」，但没有任何时间界，
//     而房间查询自带 15s 兜底轮询（tasks.detail.tsx:335-340），所以那条断言在
//     WS 全断的情况下照样能过。WG-X5 补的正是这个判据缺口：把每次改动卡在
//     「一次房间取数刚落地」之后发出，再要求 5 秒内自己更新——下一次兜底轮询要
//     15 秒才来，于是「更新了」只能来自 WS 帧。
//   · e2e/rfc243-call-nodes.spec.ts —— 只覆盖 call-workflow 的**编辑器**接缝，
//     明文写着不跑父→子执行链。
//   · packages/backend/tests/rfc243-call-workgroup.test.ts —— 同一条链的内存库集成，
//     闭包是手写 INSERT 进去的、runTask 直调；公共 HTTP 发起路径（闭包在启动时冻结）
//     与任务列表的父子树都不在它的射程内。
//   · e2e/rfc244-task-operations.spec.ts —— 父子树的展开/收起**只对 page.route 假数据**
//     点过（routeTaskOperationsFixture）。TASK-X4b 要的是一条真子任务。
//
// 各条失效形态（也就是这些断言红掉时用户会遭遇什么）：
//
//  WG-27  动态工作流的人工闸是「让人先看一眼图再决定跑不跑」的唯一入口。预览画布若在
//         审批前就把**生成宿主图**画出来，人看到的是编排器那张假图、以为审批的是它；
//         驳回若能空评论提交，编排器下一轮拿到的是一条空反馈、只能原样再生成一次；
//         审批后若没把生成的 DAG 换进 task.workflow_snapshot，工作流画布上什么都没有，
//         用户无从判断这次跑的到底是哪张图。
//  WG-28  另存是「这张一次性图值得留下来」的唯一出口。名字空着还发请求 = 落一条无名资源；
//         存下来的定义若与预览不一致，用户复用的是另一张图；驳回后「已保存」回执若不清掉，
//         它会挂在**下一张**图上，诱导用户重复保存同一个名字。
//  WG-X5  房间是组任务唯一的观察窗。三帧任何一帧断掉，用户看到的都是「什么都没发生」，
//         最长要等 15 秒兜底轮询才会自己纠正——而人在这 15 秒里会以为自己点漏了。
//  WG-42  call-workgroup 是把一段 DAG 外包给工作组的唯一方式。花名册若不冻在启动那一刻，
//         事后改组会静默改变已在跑的调用；goalTemplate 若不在父侧渲染，子任务的目标里
//         留着 `{{port}}` 字面量、组员照着一句占位符干活；result 锚若不回填，父工作流
//         下游节点拿到空串，整条链在无人报错的情况下断掉。
//  TASK-X4b 子任务若也当根行列出来，运维列表里同一次调用出现两遍、且看不出从属关系；
//         若根本不挂在父行下，用户没有任何入口找到 call 节点起出来的那条子任务。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链；读的时候按 file:line 复核）：
//   packages/backend/src/services/dynamicWorkflowRunner.ts:436-447  —— 生成成功 ⇒ phase=awaiting_confirm + 开闸
//   packages/backend/src/services/workgroup/dwActions.ts:99-170     —— approve：两层复核 + 把生成图换进快照后 resume
//   packages/backend/src/services/workgroup/dwActions.ts:173-238    —— reject：评论必填、phase 回 generating、反馈进下一轮提示词
//   packages/backend/src/services/workgroup/dwActions.ts:241-276    —— dw-save-as-workflow：落成普通 workflow 资源
//   packages/frontend/src/components/workgroup/DynamicWorkflowPanel.tsx:84-88   —— 只有驳回才清掉「已保存」回执
//   packages/frontend/src/components/workgroup/DynamicWorkflowPanel.tsx:200-258 —— awaiting_confirm：只读预览 + 闸按钮
//   packages/frontend/src/components/workgroup/DynamicWorkflowPanel.tsx:260-286 —— executing 卡的文案跟着**任务**状态走
//   packages/frontend/src/components/workgroup/DynamicWorkflowPanel.tsx:303-327 —— 驳回提交在空评论时 disabled
//   packages/frontend/src/routes/tasks.detail.tsx:984-1000          —— 未 executing ⇒ 工作流画布只给占位空态
//   packages/frontend/src/routes/tasks.detail.tsx:330-340           —— 房间聚合的 15s 兜底轮询（WG-X5 的对照物）
//   packages/frontend/src/hooks/useTaskSync.ts:80-82                —— 三帧 → 失效 workgroupRoomKey
//   packages/backend/src/services/scheduler.ts:3563-3620            —— call 节点：预算/iso/childTaskId stamp/发起子任务
//   packages/backend/src/services/scheduler.ts:4323-4430            —— launchCallWorkgroupChild：冻结组 + 渲染 goalTemplate
//   packages/frontend/src/routes/tasks.tsx:757-810                  —— 父子树的 TaskBranch / data-depth / 分支容器
//   packages/frontend/src/routes/tasks.tsx:940-965                  —— 展开按钮 + 子任务计数 chip
//
// 夹具形态（为什么是这两个 stub）：
//   · `workgroup-matrix` 是仓内唯一实现了 `aw-workflow-orchestrator` 分支的 stand-in：
//     第一轮给单节点图，看到 `## Previous attempt was REJECTED` + `REGENERATE_WITH_REVIEWER`
//     才给 source→reviewer 两节点图。动态工作流的「驳回后重生成」因此是真跑出来的。
//     它同时提供 `showcase-wg-lead` 的完成分支（目标里带三句完成标记 ⇒ 第一轮就宣布完成），
//     WG-X5 需要的「停在 awaiting_review + 完成门待确认」的房间由它给出。
//   · `basic` 是**工作组感知**的最小 stand-in（mode-basic.ts:56-64：看到 `wg_decision`
//     端口声明就立刻以 `{"action":"done","summary":"stub e2e leader done"}` 收场），
//     所以一个 call-workgroup 子任务在一轮之内跑完——WG-42 / TASK-X4b 要的是
//     「子任务真的起来并收场」，不是组内多轮编排。
//
// 「服务端到底怎么样了」一律回读公共接口（/api/tasks、/api/tasks/:id/node-runs、
// /api/workgroup-tasks/:id/room），不只信界面、也不只信回执。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedShowcase, type ShowcaseSeedResult } from '../examples/workgroups/showcase/seed'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

// 本文件不用 `page.route` 注入任何响应（判据一律取真实链路）；这条收尾仍然留着，
// 一旦以后有人加了注入，docs/dev-gotchas.md 的「两把锁」里的锁 B 已经就位。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// 类型（只声明本文件断言用得到的字段）
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string
  name: string | null
  status: string
  parentTaskId: string | null
  workgroupId: string | null
  workgroupName: string | null
  spaceKind: string | null
  invocationDepth: number | null
  workflowSnapshot?: { nodes?: Array<{ id?: string; kind?: string }> }
}

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  childTaskId: string | null
}

interface NodeRunsResponse {
  runs: NodeRunRow[]
  outputs: Array<{ nodeRunId: string; port: string; value: string }>
}

interface RoomResponse {
  taskStatus: string
  config: {
    goal: string
    instructions: string
    maxRounds: number
    workgroupName: string
    members: Array<{ id: string; displayName: string; memberType: string }>
  }
  gate: { declaredDone: boolean; awaitingConfirmation: boolean; summary: string | null }
  messages: Array<{ id: string; kind: string; bodyMd: string }>
  assignments: Array<{ id: string; title: string; status: string }>
}

interface WorkflowSummary {
  id: string
  name: string
}

interface WorkflowDetail {
  id: string
  name: string
  definition: {
    nodes: Array<{ id: string; kind: string; agentId?: string; promptTemplate?: string }>
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

async function api<T>(daemon: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path} ⇒ ${res.status} ${body}`).toBe(true)
  return (body === '' ? undefined : JSON.parse(body)) as T
}

async function authPage(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, daemon.token] as const,
  )
}

/** 记录浏览器往某条 pathname 发过几次 POST（用来证明「按不下去 = 一次都没发」）。 */
function countPosts(page: Page, pathname: string): () => number {
  let n = 0
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    if (new URL(request.url()).pathname !== pathname) return
    n += 1
  })
  return () => n
}

// ===========================================================================
// 一、动态工作流编排面 + 房间实时三帧（`workgroup-matrix` stand-in）
// ===========================================================================

test.describe('dynamic-workflow orchestration surface', () => {
  let daemon: DaemonHandle
  let stateDir = ''
  let showcase: ShowcaseSeedResult

  /** stub 的 `aw-workflow-orchestrator` 分支要求原样看到这两串，否则直接 exit 10。 */
  const DW_GOAL =
    'DW_MATRIX_GOAL literal {{dw_goal_literal}}. Generate a source-to-reviewer delivery DAG.'
  /** stub 的「被驳回后重生成」分支要求原样看到这一串。 */
  const REGENERATE_TOKEN = 'REGENERATE_WITH_REVIEWER'
  /** `showcase-wg-lead` 认得的三句完成标记同时出现 ⇒ 第一轮就宣布完成（于是走完成门）。 */
  const LEADER_GOAL_DONE =
    'WG_MATRIX_GOAL literal {{do_not_expand}}. research complete. ' +
    'implementation-code-v1 complete. implementation-tests-v1 complete.'

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    stateDir = mkdtempSync(join(tmpdir(), 'rfc319-wgdyn-state-'))
    daemon = await startDaemon({
      stubMode: 'workgroup-matrix',
      extraEnv: { WORKGROUP_MATRIX_STATE_DIR: stateDir },
    })
    showcase = await seedShowcase({
      baseUrl: daemon.baseUrl,
      token: daemon.token,
      runtime: 'opencode',
    })
  })

  test.afterAll(async () => {
    if (daemon !== undefined) await daemon.stop()
    if (stateDir !== '') rmSync(stateDir, { recursive: true, force: true })
  })

  async function launchDynamicTask(name: string): Promise<string> {
    const group = showcase.workgroups.dynamicWorkflow
    const task = await api<TaskRow>(daemon, `/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        goal: DW_GOAL,
        scratch: true,
        expectedWorkgroupId: group.id,
        expectedWorkgroupVersion: group.version,
      }),
    })
    return task.id
  }

  function previewNodes(page: Page) {
    return page.locator('[data-testid="dw-preview-canvas"] .react-flow__node')
  }

  test('RFC-319 WG-27: 生成的图先停在编排面待确认（工作流画布这时只给占位）→ 空评论驳不下去 → 带反馈重生成出两节点图 → 审批把生成的 DAG 换进快照并跑到 done @nightly', async ({
    page,
  }) => {
    const taskId = await launchDynamicTask('RFC-319 WG-27 dynamic gate')
    const confirmPosts = countPosts(page, `/api/workgroup-tasks/${taskId}/dw-confirm`)
    await authPage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=dw-orchestration`)

    // ---- ① 第一张图停在人工闸上，预览是**生成出来的**那张图 ----
    await expect(
      page.getByTestId('dw-confirm-card'),
      '编排面一直没进入待确认 ⇒ 生成完成后没有开人工闸，用户没有任何决定点',
    ).toBeVisible({ timeout: 90_000 })
    await expect(
      previewNodes(page),
      '待确认的只读预览不是编排器这一轮生成的单节点图 ⇒ 人审的不是将要执行的那张图',
    ).toHaveCount(1)
    await expect(previewNodes(page).first()).toContainText('dw_initial')
    await expect(previewNodes(page).first()).toContainText('showcase-dw-source')

    // ---- ② 审批之前，工作流画布必须只给占位：那时的快照还是**生成宿主图** ----
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=workflow-status`)
    const statusPane = page.locator('[data-task-detail-section="workflow-status"]')
    await expect(
      statusPane.getByText('The real DAG appears here once the orchestration is approved.'),
      '审批之前工作流画布没有给占位 ⇒ 它把生成宿主图当成「本次要跑的图」画了出来',
    ).toBeVisible()
    await expect(
      statusPane.locator('.react-flow__node'),
      '审批之前工作流画布上已经有节点 ⇒ 用户会以为自己审的是这张图',
    ).toHaveCount(0)

    // ---- ③ 驳回必须带反馈：空评论时提交按不下去，且一次请求都不发 ----
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=dw-orchestration`)
    await expect(page.getByTestId('dw-confirm-card')).toBeVisible()
    await page.getByTestId('dw-gate-reject').click()
    await expect(page.getByTestId('dw-reject-dialog')).toBeVisible()
    await expect(
      page.getByTestId('dw-reject-submit'),
      '空评论也能提交驳回 ⇒ 编排器下一轮拿到一条空反馈，只能原样再生成一次',
    ).toBeDisabled()
    await page.getByTestId('dw-reject-comment').fill('   ')
    await expect(
      page.getByTestId('dw-reject-submit'),
      '只填空白字符就解禁了提交 ⇒ 反馈必填这条规则形同虚设',
    ).toBeDisabled()
    expect(confirmPosts(), '闸还没做出任何决定，浏览器就已经往 dw-confirm 发过请求').toBe(0)

    // ---- ④ 带反馈提交 ⇒ 回到生成中，反馈原文摆在用户眼前，重生成出两节点图 ----
    await page.getByTestId('dw-reject-comment').fill(`${REGENERATE_TOKEN} add a reviewer stage`)
    await page.getByTestId('dw-reject-submit').click()
    await expect(
      page.getByTestId('dw-generating-card'),
      '驳回之后没有回到「生成中」 ⇒ 这次驳回没有触发重生成',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('dw-rejection-feedback'),
      '重生成过程中没有把这一轮要处理的反馈摆出来 ⇒ 用户看不出编排器在改什么',
    ).toHaveText(`${REGENERATE_TOKEN} add a reviewer stage`)

    await expect(
      page.getByTestId('dw-confirm-card'),
      '重生成之后没有再次开闸 ⇒ 驳回变成了单程票',
    ).toBeVisible({ timeout: 90_000 })
    await expect(
      previewNodes(page),
      '重生成出来的还是原来那张单节点图 ⇒ 驳回反馈没有进入下一轮生成提示词',
    ).toHaveCount(2)
    // 逐节点用可重试的定位断言，不做 allInnerTexts() 快照：xyflow 先挂节点壳、
    // 内部文本随后一帧才落，快照式读法会在慢机器上读到空串（实测撞到过一次）。
    await expect(
      previewNodes(page).filter({ hasText: 'dw_source' }),
      '重生成的图里没有 source 节点 ⇒ 预览画的不是这一轮真正生成的定义',
    ).toHaveCount(1)
    await expect(
      previewNodes(page).filter({ hasText: 'dw_review' }),
      '重生成的图里没有 reviewer 节点 ⇒ 带反馈的那一轮没有按反馈补出评审阶段',
    ).toHaveCount(1)

    // ---- ⑤ 审批 ⇒ 生成的 DAG 换进任务快照并真的跑起来 ----
    await page.getByTestId('dw-gate-approve').click()
    await expect(
      page.getByTestId('dw-executing-card'),
      '审批之后编排面没有切到「执行中」 ⇒ 审批没有把任务推进执行相位',
    ).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('dw-executing-card'),
      '任务已经收场，执行卡还在说「正在执行」 ⇒ 卡片文案没有跟着任务状态走',
    ).toContainText('Execution finished', { timeout: 120_000 })

    const finished = await api<TaskRow>(daemon, `/api/tasks/${taskId}`)
    expect(finished.status, '审批后的任务没有跑到 done ⇒ 生成的 DAG 根本没执行成功').toBe('done')
    expect(
      (finished.workflowSnapshot?.nodes ?? []).map((n) => n.id),
      '任务快照仍是生成宿主图 ⇒ 审批没有把生成的 DAG 换进去，跑的和审的不是同一张图',
    ).toEqual(['dw_source', 'dw_review'])

    const data = await api<NodeRunsResponse>(daemon, `/api/tasks/${taskId}/node-runs`)
    const source = data.runs.find((r) => r.nodeId === 'dw_source')
    const reviewer = data.runs.find((r) => r.nodeId === 'dw_review')
    expect(source?.status, '生成图的 source 节点没有跑出一条 done 的运行').toBe('done')
    expect(reviewer?.status, '生成图的 reviewer 节点没有跑出一条 done 的运行').toBe('done')
    expect(
      data.outputs.find((o) => o.nodeRunId === reviewer?.id && o.port === 'report')?.value,
      '生成图下游节点没有产出 report 端口 ⇒ 这张图只是「跑过」而没有真的接出数据',
    ).toBe('dynamic reviewer complete')

    // ---- ⑥ 执行之后工作流画布换成真图 ----
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=workflow-status`)
    await expect(
      statusPane.locator('.react-flow__node'),
      '审批之后工作流画布仍然没有节点 ⇒ 用户无从判断这次跑的是哪张图',
    ).toHaveCount(2)
    await expect(
      statusPane.locator('.react-flow__node').filter({ hasText: 'dw_source' }),
      '工作流画布上没有被审批的那张图的 source 节点',
    ).toHaveCount(1)
    await expect(
      statusPane.locator('.react-flow__node').filter({ hasText: 'dw_review' }),
      '工作流画布上没有被审批的那张图的 reviewer 节点',
    ).toHaveCount(1)
  })

  test('RFC-319 WG-28: 把生成的图另存为正式工作流——名字空着一次请求都不发，存下来的定义与预览逐节点一致，随后驳回会把这条「已保存」回执清掉 @nightly', async ({
    page,
  }) => {
    const taskId = await launchDynamicTask('RFC-319 WG-28 save as workflow')
    const savePosts = countPosts(page, `/api/workgroup-tasks/${taskId}/dw-save-as-workflow`)
    await authPage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=dw-orchestration`)
    await expect(page.getByTestId('dw-confirm-card')).toBeVisible({ timeout: 90_000 })

    const before = await api<WorkflowSummary[]>(daemon, '/api/workflows')
    const savedName = 'rfc319-wg28-generated'
    expect(
      before.some((w) => w.name === savedName),
      '夹具前提不成立：同名工作流已经存在，后面的「新建了一条」判据失去意义',
    ).toBe(false)

    // ---- ① 名字空着：提交按不下去，且一次请求都不发 ----
    await page.getByTestId('dw-save-as-btn').click()
    await expect(page.getByTestId('dw-save-as-dialog')).toBeVisible()
    await expect(
      page.getByTestId('dw-save-as-submit'),
      '名字空着也能提交 ⇒ 会落一条无名工作流资源',
    ).toBeDisabled()
    await page.getByTestId('dw-save-as-name').fill('   ')
    await expect(
      page.getByTestId('dw-save-as-submit'),
      '只填空白字符就解禁了提交 ⇒ 名字必填这条规则形同虚设',
    ).toBeDisabled()
    expect(savePosts(), '名字还没填完，浏览器就已经往 dw-save-as-workflow 发过请求').toBe(0)

    // ---- ② 填名保存：落成一条真资源，定义与预览逐节点一致 ----
    await page.getByTestId('dw-save-as-name').fill(savedName)
    await page.getByTestId('dw-save-as-submit').click()
    await expect(
      page.getByTestId('dw-saved-note'),
      '保存之后没有任何回执 ⇒ 用户不知道到底存没存下来',
    ).toHaveText(`Saved as ${savedName}.`)
    expect(savePosts(), '一次保存却发了多次请求 ⇒ 会落出重复资源').toBe(1)

    const after = await api<WorkflowSummary[]>(daemon, '/api/workflows')
    const created = after.filter((w) => w.name === savedName)
    expect(created, '另存之后工作流列表里没有多出恰好一条同名资源').toHaveLength(1)
    const detail = await api<WorkflowDetail>(daemon, `/api/workflows/${created[0]?.id}`)
    expect(
      detail.definition.nodes.map((n) => ({ id: n.id, kind: n.kind })),
      '存下来的定义与待确认预览里的那张图不一致 ⇒ 用户复用的是另一张图',
    ).toEqual([{ id: 'dw_initial', kind: 'agent-single' }])
    expect(
      detail.definition.nodes[0]?.agentId,
      '存下来的节点没有落成规范的 agentId ⇒ 这条工作流一旦启动就找不到成员代理',
    ).toBe(showcase.agents.dynamicSource.id)
    expect(
      detail.definition.nodes[0]?.promptTemplate,
      '存下来的节点丢了编排器给的提示词 ⇒ 复用时它是一个空壳节点',
    ).toBe('DW_INITIAL_SINGLE produce one draft')

    // ---- ③ 驳回会换掉提案：这条「已保存」回执不许跟着新图走 ----
    // 全程不离开这一页：回执是组件内 state，任何一次导航都会把它清成 null，
    // 那样这条判据就变成了「导航会重置 state」而不是「驳回会清回执」。
    await page.getByTestId('dw-gate-reject').click()
    await page.getByTestId('dw-reject-comment').fill(`${REGENERATE_TOKEN} add a reviewer stage`)
    await page.getByTestId('dw-reject-submit').click()
    await expect(page.getByTestId('dw-generating-card')).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByTestId('dw-confirm-card'),
      '驳回之后没有再次开闸 ⇒ 后面这条回执判据无从落地',
    ).toBeVisible({ timeout: 90_000 })
    await expect(
      previewNodes(page),
      '闸上摆的还是被驳回的那张图 ⇒ 回执是否清掉这件事失去区分度',
    ).toHaveCount(2)
    await expect(
      page.getByTestId('dw-saved-note'),
      '换了一张图，上一张的「已保存」回执还挂着 ⇒ 用户会以为新图也存过了',
    ).toHaveCount(0)

    // ---- ④ 另存出来的是一条普通资源：工作流列表页能看见它 ----
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(
      page.getByRole('link', { name: savedName, exact: true }),
      '另存出来的工作流在 /workflows 上看不见 ⇒ 它没有成为一条可复用的普通资源',
    ).toBeVisible()
  })

  test('RFC-319 WG-X5: 房间三帧实时刷新——留言 / 派单卡 / 完成门都在一次房间取数刚落地之后 5 秒内自己出现，不靠 15 秒兜底轮询也不靠刷新 @nightly', async ({
    page,
  }) => {
    const group = showcase.workgroups.leaderWorker
    const task = await api<TaskRow>(daemon, `/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'RFC-319 WG-X5 live room',
        goal: LEADER_GOAL_DONE,
        scratch: true,
      }),
    })
    const taskId = task.id
    const roomPath = `/api/workgroup-tasks/${taskId}/room`

    await expect
      .poll(
        async () => {
          const room = await api<RoomResponse>(daemon, roomPath)
          return `${room.taskStatus}:${String(room.gate.awaitingConfirmation)}`
        },
        {
          message: '夹具任务没有停在 awaiting_review + 完成门待确认 ⇒ 三帧里的门那一帧无从触发',
          timeout: 90_000,
          intervals: [300],
        },
      )
      .toBe('awaiting_review:true')

    /**
     * 等到「房间取数刚落地」的那一刻再动手：房间查询的兜底轮询是 15s 且每次取数后
     * 重新计时（tasks.detail.tsx:335-340），所以此后 5 秒内的任何更新都只可能来自
     * WS 帧——这正是本条用例与 WG-29「不刷新就出现」的区别。
     */
    async function afterFreshRoomFetch(): Promise<void> {
      await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === roomPath &&
          response.request().method() === 'GET' &&
          response.ok(),
        { timeout: 40_000 },
      )
    }

    await authPage(page, daemon)
    const mounted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === roomPath &&
        response.request().method() === 'GET' &&
        response.ok(),
      { timeout: 40_000 },
    )
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=chatroom`)
    await expect(page.getByTestId('workgroup-room')).toBeVisible({ timeout: 60_000 })
    await mounted

    // ---- ① wg.message.created：另一处发的留言自己出现在时间线上 ----
    const marker = 'RFC319_WGX5_BLACKBOARD_MARKER'
    await api(daemon, `${roomPath.replace('/room', '')}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: marker }),
    })
    await expect(
      page.getByText(marker, { exact: true }),
      '别处发的留言没有在 5 秒内出现 ⇒ wg.message.created 没有驱动房间重取，' +
        '用户要等 15 秒兜底轮询才看得到别人说了什么',
    ).toBeVisible({ timeout: 5_000 })
    const afterMessage = await api<TaskRow>(daemon, `/api/tasks/${taskId}`)
    expect(
      afterMessage.status,
      '这条留言把任务状态也推动了 ⇒ 上面那条断言可能是 task.status 帧带出来的，失去区分度',
    ).toBe('awaiting_review')

    // ---- ② wg.assignment.updated：另一处 @ 出来的派单卡自己出现在右栏 ----
    await afterFreshRoomFetch()
    const before = new Set((await api<RoomResponse>(daemon, roomPath)).assignments.map((a) => a.id))
    await api(daemon, `${roomPath.replace('/room', '')}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '@owner RFC319_WGX5_DISPATCH' }),
    })
    const withCard = await api<RoomResponse>(daemon, roomPath)
    const card = withCard.assignments.find((a) => !before.has(a.id))
    expect(card, '夹具前提不成立：@owner 没有在服务端开出派单卡').toBeDefined()
    await expect(
      page.getByTestId(`wg-card-${card?.id ?? 'missing'}`),
      '别处 @ 出来的派单卡没有在 5 秒内出现 ⇒ 房间没有被派单帧驱动重取，' +
        '被点名的人在界面上看不到轮到自己了',
    ).toBeVisible({ timeout: 5_000 })

    // ---- ③ wg.gate.updated：另一处做出的完成门决定当场收口这个房间 ----
    await afterFreshRoomFetch()
    await expect(
      page.getByTestId('workgroup-room-gate'),
      '夹具前提不成立：房间右栏没有渲染完成门卡片',
    ).toBeVisible()
    await api(daemon, `${roomPath.replace('/room', '')}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    await expect(
      page.getByTestId('workgroup-room-gate'),
      '别处已经批过的完成门还挂在这个房间里 ⇒ 用户会对着一个早已作废的门再按一次',
    ).toHaveCount(0, { timeout: 5_000 })
    await expect(
      page.getByTestId('workgroup-room-input'),
      '任务已经收场，房间还可写 ⇒ 终态收口没有跟着实时帧落地',
    ).toBeDisabled({ timeout: 5_000 })
  })
})

// ===========================================================================
// 二、工作流里的子工作组调用（`basic` stand-in）
// ===========================================================================

test.describe('call-workgroup child tasks', () => {
  let daemon: DaemonHandle
  let groupId = ''
  const groupName = 'rfc319-call-target-group'
  const charter = 'RFC319_CALLWG_CHARTER keep it to one leader round.'
  const goalToken = 'RFC319-CALLWG-ALPHA-7731'

  let leadAgentId = ''
  let parentTaskId = ''
  let childTaskId = ''
  let callRunId = ''

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    daemon = await startDaemon({ stubMode: 'basic' })

    const lead = await api<{ id: string }>(daemon, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-callwg-lead',
        description: 'RFC-319 call-workgroup fixture leader',
        bodyMd: 'Close the group in one round.',
        outputs: [],
        outputKinds: {},
        readonly: false,
      }),
    })
    leadAgentId = lead.id
    const group = await api<{ id: string }>(daemon, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({
        name: groupName,
        description: 'RFC-319 call-workgroup fixture',
        instructions: charter,
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 4,
        completionGate: false,
        clarifyBudget: 0,
        fanOut: false,
        members: [
          { memberType: 'agent', agentId: lead.id, displayName: 'lead', roleDesc: 'coordinate' },
        ],
      }),
    })
    groupId = group.id

    const workflow = await api<{ id: string }>(daemon, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-callwg-parent',
        description: 'RFC-319 call-workgroup fixture',
        definition: {
          $schema_version: 4,
          inputs: [{ kind: 'text', key: 'req', label: 'Requirement' }],
          nodes: [
            { id: 'pin', kind: 'input', inputKey: 'req', position: { x: 0, y: 0 } },
            {
              id: 'call_wg',
              kind: 'call-workgroup',
              workgroupName: groupName,
              workgroupId: groupId,
              goalTemplate: 'RFC319_CALLWG_GOAL::{{req}}',
              position: { x: 220, y: 0 },
            },
            {
              id: 'pout',
              kind: 'output',
              ports: [{ name: 'report', bind: { nodeId: 'call_wg', portName: 'result' } }],
              position: { x: 440, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'pin', portName: 'req' },
              target: { nodeId: 'call_wg', portName: 'req' },
            },
          ],
        },
      }),
    })

    const parent = await api<TaskRow>(daemon, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        name: 'RFC-319 call-workgroup parent',
        scratch: true,
        inputs: { req: goalToken },
      }),
    })
    parentTaskId = parent.id

    await expect
      .poll(async () => (await api<TaskRow>(daemon, `/api/tasks/${parentTaskId}`)).status, {
        message: '父任务没有收场 ⇒ call-workgroup 那一段根本没跑通，后面每条断言都失去意义',
        timeout: 120_000,
        intervals: [400],
      })
      .toBe('done')

    const runs = await api<NodeRunsResponse>(daemon, `/api/tasks/${parentTaskId}/node-runs`)
    const call = runs.runs.find((r) => r.nodeId === 'call_wg')
    expect(call?.childTaskId, 'call 行上没有 stamp 子任务 id ⇒ 这次调用没有真的发起子任务').toEqual(
      expect.any(String),
    )
    callRunId = call?.id ?? ''
    childTaskId = call?.childTaskId ?? ''
  })

  test.afterAll(async () => {
    if (daemon !== undefined) await daemon.stop()
  })

  test('RFC-319 WG-42: 工作流里的 call-workgroup 起出真正的子任务——冻结的花名册与章程随子任务走，goalTemplate 里的 {{端口}} 在父侧渲染成子任务的字面目标 @nightly', async () => {
    const child = await api<TaskRow>(daemon, `/api/tasks/${childTaskId}`)
    expect(child.parentTaskId, '子任务没有挂在父任务上 ⇒ 它是一条孤儿任务').toBe(parentTaskId)
    expect(child.workgroupId, '子任务没有绑到被调用的工作组').toBe(groupId)
    expect(child.spaceKind, '子任务没有继承父任务的工作空间 ⇒ 它在另一份工作树上干活').toBe(
      'inherited',
    )
    expect(child.invocationDepth, '子任务的调用深度不是 1 ⇒ 深度上限那道闸拦不住递归调用').toBe(1)
    expect(child.status, '子任务没有跑到 done ⇒ 这次外包并没有真的完成').toBe('done')

    const room = await api<RoomResponse>(daemon, `/api/workgroup-tasks/${childTaskId}/room`)
    expect(room.config.goal, 'goalTemplate 没有在父侧渲染 ⇒ 组员照着一句 {{req}} 占位符干活').toBe(
      `RFC319_CALLWG_GOAL::${goalToken}`,
    )
    expect(room.config.goal, '渲染后的目标里仍留着模板占位符').not.toContain('{{')
    expect(
      room.config.members.map((m) => m.displayName),
      '子任务的花名册不是被调用工作组的花名册 ⇒ 这次外包交给了别人',
    ).toEqual(['lead'])
    expect(room.config.instructions, '子任务没有带上工作组章程 ⇒ 组员失去行为约束').toBe(charter)
    expect(room.config.maxRounds, '子任务没有带上工作组的回合上限').toBe(4)

    // 冻结的意思是「子任务读的是发起那一刻的那份，不是活的组资源」：
    // 事后把组改掉，已经跑完的子任务必须逐字不变。
    const live = await api<{ version: number }>(daemon, `/api/workgroups/${groupId}`)
    await api(daemon, `/api/workgroups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedVersion: live.version,
        clientMutationId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
        snapshot: {
          name: groupName,
          description: 'RFC-319 call-workgroup fixture (edited after the call)',
          instructions: 'RFC319_CALLWG_CHARTER_EDITED after the child task finished.',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 9,
          completionGate: false,
          clarifyBudget: 0,
          fanOut: false,
          members: [
            {
              memberType: 'agent',
              agentId: leadAgentId,
              displayName: 'lead',
              roleDesc: 'coordinate',
            },
          ],
        },
      }),
    })
    const afterEdit = await api<RoomResponse>(daemon, `/api/workgroup-tasks/${childTaskId}/room`)
    expect(
      afterEdit.config.instructions,
      '事后改组资源改动了已经跑完的子任务的章程 ⇒ 子任务读的是活的组，不是冻结的那份',
    ).toBe(charter)
    expect(
      afterEdit.config.maxRounds,
      '事后改组资源改动了已经跑完的子任务的回合上限 ⇒ 冻结没有生效',
    ).toBe(4)
  })

  test('RFC-319 WG-42: 子工作组的结果锚回填父端口——call 行的 result 逐字等于子任务 leader 的完成决议，并顺着边流到父工作流的输出节点 @nightly', async () => {
    const room = await api<RoomResponse>(daemon, `/api/workgroup-tasks/${childTaskId}/room`)
    const decision = room.messages.find((m) => m.kind === 'decision')
    expect(decision?.bodyMd, '子任务里没有一条完成决议 ⇒ 结果锚无从指向').toEqual(
      expect.any(String),
    )
    expect(room.gate.summary, '子任务的完成摘要与决议正文对不上 ⇒ 结果锚指向的不是这条决议').toBe(
      decision?.bodyMd,
    )

    const runs = await api<NodeRunsResponse>(daemon, `/api/tasks/${parentTaskId}/node-runs`)
    const callResult = runs.outputs.find((o) => o.nodeRunId === callRunId && o.port === 'result')
    expect(
      callResult?.value,
      'call 行没有产出 result 端口 ⇒ 父工作流下游拿到空串，链路在无人报错的情况下断掉',
    ).toBe(decision?.bodyMd)

    const outRun = runs.runs.find((r) => r.nodeId === 'pout')
    expect(
      runs.outputs.find((o) => o.nodeRunId === outRun?.id && o.port === 'report')?.value,
      '子工作组的结果没有顺着边流到父工作流的输出节点 ⇒ 外包的产出留在了调用行里',
    ).toBe(decision?.bodyMd)
  })

  test('RFC-319 TASK-X4b: call-workgroup 产生的子任务只作为父任务的子行出现——根层一格都没有，收起再展开还是同一棵树，点进去还能顺着父链接回来', async ({
    page,
  }) => {
    await authPage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)

    await expect(
      page.getByTestId(`task-row-${parentTaskId}`).first(),
      '任务列表里没有这条父任务 ⇒ 后面每条断言都失去意义',
    ).toBeVisible({ timeout: 60_000 })

    const expander = page.getByTestId(`task-expand-${parentTaskId}`)
    await expect(
      expander,
      '父任务行上没有展开控件 ⇒ 用户没有任何入口找到 call 节点起出来的子任务',
    ).toHaveCount(1)
    // 带着子树的那一行才是本条用例要对账的行（同一条任务在「工作流」与「工作组」
    // 两个来源镜头下各列一行，只有后者挂着这次调用的子任务）。
    const parentRow = page
      .locator('[role="listitem"][data-depth="0"]')
      .filter({ has: page.getByTestId(`task-expand-${parentTaskId}`) })
      .locator(`[data-testid="task-row-${parentTaskId}"]`)
    await expect(
      expander,
      '父任务行的展开控件初始不是展开态 ⇒ 命中子任务的那一支没有把上下文自动摊开',
    ).toHaveAttribute('aria-expanded', 'true')

    // 子任务查询在父行之后异步收敛；evaluateAll 本身不会等待 locator 出现。
    // 先用可重试断言同时钉住「最终出现」和「全页只有一条」，再读取层级。
    const childRow = page.getByTestId(`task-row-${childTaskId}`)
    await expect(
      childRow,
      '子任务查询没有收敛成全页唯一的一条子行（0 条 = 未加载，2 条 = 根层重复）',
    ).toHaveCount(1, { timeout: 60_000 })
    const childDepths = await childRow.evaluateAll((els) =>
      els.map((el) => el.parentElement?.getAttribute('data-depth') ?? 'none'),
    )
    expect(
      childDepths,
      '子任务没有恰好以一条一级子行的形态出现（根层多出一格 = 同一次调用被列了两遍）',
    ).toEqual(['1'])

    // 它确实挂在父行自己的那个分支容器里，而不是碰巧排在下面。
    const branchId = await expander.getAttribute('aria-controls')
    expect(branchId, '展开控件没有声明它控制哪个分支容器 ⇒ 这棵树对读屏是断的').toEqual(
      expect.any(String),
    )
    await expect(
      page.locator(`[id="${branchId ?? ''}"]`).getByTestId(`task-row-${childTaskId}`),
      '子任务不在父行的分支容器里 ⇒ 它只是碰巧排在父行下面，并没有构成父子树',
    ).toHaveCount(1)

    await expect(
      childRow,
      '子行没有写清它是哪个 call 节点起出来的 ⇒ 一次调用多个子工作组时无从分辨',
    ).toContainText('call_wg')
    await expect(childRow, '子行没有标出被调用的工作组 ⇒ 看不出这段活外包给了谁').toContainText(
      groupName,
    )
    await expect(parentRow, '父行没有标出它带着几条子任务').toContainText(/1 child task/)

    // 收起 → 子行消失；再展开 → 同一条子行回来。
    await expander.click()
    await expect(
      page.getByTestId(`task-row-${childTaskId}`),
      '收起之后子行还在 ⇒ 展开控件没有真的控制这一支',
    ).toHaveCount(0)
    await expect(expander).toHaveAttribute('aria-expanded', 'false')
    await expander.click()
    await expect(
      page.getByTestId(`task-row-${childTaskId}`),
      '再次展开之后子行没有回来 ⇒ 这棵树只能摊开一次',
    ).toHaveCount(1)

    // 点进子任务，还能顺着父链接走回来。
    await childRow.getByRole('link', { name: /call_wg/ }).click()
    await expect(page).toHaveURL(new RegExp(`/tasks/${childTaskId}`))
    const parentLink = page.getByRole('link', { name: /Parent task/ })
    await expect(
      parentLink,
      '子任务详情页没有回到父任务的链接 ⇒ 下钻之后回不去，父子关系是单向的',
    ).toHaveAttribute('href', `/tasks/${parentTaskId}`)
  })
})
