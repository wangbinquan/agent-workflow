// RFC-319 B61 —— HUMAN-36 / HUMAN-42 / HUMAN-48：单文档评审页上三件「小」事。
//
// 这三条都不起眼，但失效的形态都很难看：
//
//   * **A / R / I 是三个单键就落地的决定，而 A 在没有评论时不弹窗、直接批准**
//     （`reviews.detail.tsx:294-317`：只有存在评论 / 草稿才拦一道确认）。也就是说
//     这一屏上有一个「按一下就不可逆」的键。那么它必须挡住三类误触：**组合键**
//     （Cmd+A 是全选，源码注释逐字写着「Never let browser or OS chords such as
//     Cmd+A submit an irreversible review decision」）、**输入框里打字**（评论里写
//     "approve" 会连打两个能触发的字母）、**历史版本视图**（对一份旧稿做决定）。
//   * **下载**：标题里带 `/` `:` 这类字符时，文件名不清洗，点击会在部分系统上静默
//     失败——人以为下载了，其实什么也没有。空正文时按钮必须禁用，否则存下来一个
//     0 字节的 .md，比不给下载更糟。
//   * **归属**：谁做的决定、什么角色，要在页面上写清（否则一轮驳回之后没人知道该
//     找谁问）；**但绝不能进 agent 的提示词**——RFC-099 的硬约束：模型不该知道
//     是谁在给它下结论，否则它会开始「看人下菜」。这条只有真跑一次重跑、去读那条
//     重跑 prompt 才验得出来。
//
// 覆盖边界（如实记）：
//   * 「历史版本上不许开决定框」有**两道各自独立的守卫**：keydown 里的
//     `if (mode === 'historical') return`，以及渲染处的
//     `{mode !== 'historical' && decisionDialog !== null && …}`。实测**只拆一道**
//     两条都不红——另一道兜住了。只有两道一起拆才咬中本条断言。这不是断言弱，
//     是产品这里确实是双保险；记在这里，免得后人看到「拆了没红」误以为没覆盖。
//   * 本条只覆盖 HUMAN-48 的**评审那一半**（决策人 + 角色 + 不进 prompt）。澄清那半
//     的「谁提交」徽标（`clarify-submitter`）目前仓内仍无任何断言，HUMAN-48 因此
//     仍留在缺口表里，留给澄清页那一批一起做。
//
// 判据取自源码单一事实源：
//   routes/reviews.detail.tsx:379-419  keydown：historical / 输入框 / 任一修饰键 一律不接管
//   routes/reviews.detail.tsx:294-317  A：有评论或草稿才弹确认，否则直接提交
//   routes/reviews.detail.tsx:455-469  下载：空正文禁用；文件名清洗 + 版本号后缀
//   components/review/ReviewDecisionInfo.tsx:60-72  决策归属（人 + 角色）
//   services/review.ts（重跑提示词组装）+ rfc099-prompt-isolation 既有单测：归属绝不进 prompt

import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

/** 标题里塞满文件系统不接受的字符——文件名清洗的判据。 */
const REVIEW_TITLE = 'user/auth: design'
const EXPECTED_FILENAME = 'user_auth__design-v1.md'
const REJECT_REASON = 'RFC-319 B61: spell out the retention owner'

let daemon: DaemonHandle
let repoDir: string
let stateDir: string
let taskId: string
let nodeRunId: string
let meId: string
let meName: string

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface ReviewSummaryRow {
  nodeRunId: string
  reviewIteration: number
  awaitingReview: boolean
  currentVersionIndex: number
}

interface NodeRunRow {
  id: string
  nodeId: string
  iteration: number
  retryIndex: number
  promptText: string | null
}

async function waitForReview(minIteration = 0): Promise<ReviewSummaryRow> {
  let last: ReviewSummaryRow[] = []
  await expect
    .poll(
      async () => {
        last = await api<ReviewSummaryRow[]>(`/api/reviews?taskId=${encodeURIComponent(taskId)}`)
        return last.some((r) => r.awaitingReview && r.reviewIteration >= minIteration)
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  const row = last.find((r) => r.awaitingReview && r.reviewIteration >= minIteration)
  if (row === undefined) throw new Error('no review')
  return row
}

async function openReview(page: Page, search = ''): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/reviews/${encodeURIComponent(nodeRunId)}${search}`)
  await expect(page.locator('.review-detail__download')).toBeVisible()
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b61-state-'))
  daemon = await startDaemon({
    stubMode: 'business-workflows',
    extraEnv: { BUSINESS_WORKFLOW_STATE_DIR: stateDir },
    configOverrides: {
      defaultNodeRetries: 0,
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 10_000,
    },
  })
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b61-repo-'))
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b61 fixture\n')
  initGitRepo(repoDir)

  const me = await api<{ user: { id: string; displayName: string } }>('/api/auth/me')
  meId = me.user.id
  meName = me.user.displayName

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'business-quality-gate',
      description: 'RFC-319 B61 fixture',
      outputs: ['quality_status', 'release_brief'],
      outputKinds: { quality_status: 'string', release_brief: 'markdown' },
      permission: {},
      bodyMd: 'Deterministic agent used by the RFC-319 single-doc review scenario.',
    }),
  })
  const wf = await api<{ id: string; version: number }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b61-single-doc-review',
      description: 'RFC-319 B61 single-document review',
      definition: {
        $schema_version: 3,
        inputs: [
          { kind: 'text', key: 'status', label: 'Status', required: true },
          { kind: 'text', key: 'report', label: 'Report', required: true },
        ],
        nodes: [
          { id: 'in_status', kind: 'input', inputKey: 'status', position: { x: 0, y: 0 } },
          { id: 'in_report', kind: 'input', inputKey: 'report', position: { x: 0, y: 160 } },
          {
            id: 'gate',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'business-quality-gate',
            promptTemplate: [
              'BUSINESS_FIX_QUALITY_GATE',
              'audit_status={{audit_status}}',
              'test_status={{test_status}}',
              'audit_report={{audit_report}}',
              'test_report={{test_report}}',
            ].join('\n'),
            position: { x: 320, y: 80 },
          },
          {
            id: 'doc_review',
            kind: 'review',
            title: REVIEW_TITLE,
            inputSource: { nodeId: 'gate', portName: 'release_brief' },
            rerunnableOnReject: ['gate'],
            position: { x: 640, y: 80 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'approved', bind: { nodeId: 'doc_review', portName: 'approved_doc' } }],
            position: { x: 960, y: 80 },
          },
        ],
        edges: [
          {
            id: 'e_status_audit',
            source: { nodeId: 'in_status', portName: 'status' },
            target: { nodeId: 'gate', portName: 'audit_status' },
          },
          {
            id: 'e_status_test',
            source: { nodeId: 'in_status', portName: 'status' },
            target: { nodeId: 'gate', portName: 'test_status' },
          },
          {
            id: 'e_report_audit',
            source: { nodeId: 'in_report', portName: 'report' },
            target: { nodeId: 'gate', portName: 'audit_report' },
          },
          {
            id: 'e_report_test',
            source: { nodeId: 'in_report', portName: 'report' },
            target: { nodeId: 'gate', portName: 'test_report' },
          },
          {
            id: 'e_gate_review',
            source: { nodeId: 'gate', portName: 'release_brief' },
            target: { nodeId: 'doc_review', portName: '__review_input__' },
          },
          {
            id: 'e_review_out',
            source: { nodeId: 'doc_review', portName: 'approved_doc' },
            target: { nodeId: 'out_1', portName: 'approved' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: wf.id,
      expectedWorkflowVersion: wf.version,
      name: 'rfc319-b61-single-doc',
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { status: 'needs-fix', report: '# RFC-319 B61\n\nOne document under review.\n' },
    }),
  })
  taskId = task.id
  const review = await waitForReview()
  nodeRunId = review.nodeRunId
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

test('下载：文件名把标题里的斜杠冒号清干净，存下来的就是页面上那一篇 @nightly', async ({
  page,
}) => {
  await openReview(page)
  const button = page.locator('.review-detail__download')
  await expect(button).toBeEnabled()
  // title 属性是用户点之前唯一能看到的文件名——先把它钉死。
  await expect(button).toHaveAttribute('title', `Download ${EXPECTED_FILENAME}`)

  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  expect(
    download.suggestedFilename(),
    '标题里的 / 与 : 没清掉的话，部分系统会直接把这次点击吞掉（人以为下载了）',
  ).toBe(EXPECTED_FILENAME)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const saved = Buffer.concat(chunks).toString('utf-8')
  expect(saved, '下载下来的必须就是页面上那一篇正文').toContain('Quality gate blocked')
})

test('正文是空的时候，下载按钮必须是禁的 —— 否则存下来一个 0 字节的 .md @nightly', async ({
  page,
}) => {
  // 正文来自详情接口。这里在**导航之前**就把它换成空串，并且从**预先取好的**真实
  // 载荷里造响应（handler 内不再 `route.fetch()`）——否则「取上游 → 再 fulfill」
  // 中间那段异步窗口会和页面 8s 轮询、以及测试收尾撞上，报 `Route is already handled`。
  // 这条断言在界面上不可见（按钮长得一样），只有 disabled 属性分得出来。
  const real = await api<Record<string, unknown>>(`/api/reviews/${nodeRunId}`)
  await page.route('**/api/reviews/**', async (route) => {
    // 只改详情那一条；同前缀下还有 ?taskId= 列表、/comments、/versions/:id 等一律放行。
    if (new URL(route.request().url()).pathname !== `/api/reviews/${nodeRunId}`) {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...real, currentBody: '' }),
    })
  })
  await openReview(page)
  await expect(
    page.locator('.review-detail__download'),
    '正文是空的还让点，存下来就是个 0 字节的 .md',
  ).toBeDisabled()
})

test('A / R / I：单键能开，但组合键、输入框里打字、历史版本都不许触发 @nightly', async ({
  page,
}) => {
  await openReview(page)
  const dialog = page.getByTestId('review-decision-dialog')

  // 正向：I 与 R 各自开自己的确认框（两者都不是「按一下就落地」，但键必须真的接上）。
  // 两个框各自报出**自己那一档**会重跑什么：本工作流 rerunnableOnReject=['gate']、
  // rerunnableOnIterate 为空（回落成「直接上游」）。两个键要是接到同一个 handler 上，
  // 这两条就会互相说出对方的话。
  await page.keyboard.press('i')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('direct upstream')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  await page.keyboard.press('r')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('gate')

  // 输入框里打字不许被接管：驳回理由里写 "a rough draft: i still reject" 一句话就
  // 带了三个能触发的字母。这一档的守卫是 activeElement 是不是 INPUT/TEXTAREA，
  // 与下面那条修饰键守卫是两条独立的路。
  const reasonBox = dialog.locator('textarea')
  await reasonBox.click()
  // 先清空：开框的那个 `r` 有时会跟着落进这个 autoFocus 的 textarea（keydown 打开框、
  // 随后的 keypress 落到新获得焦点的输入框上），实测时有时无。这条用例要断的是
  // 「**打进去的字**会不会被当成快捷键」，不该顺带依赖那个竞态。
  await reasonBox.fill('')
  // 必须**逐键敲**：`fill()` 是直接赋值、不产生 keydown，那样这条断言是空的——
  // 实测把 activeElement 守卫整个拆掉，`fill()` 版本照样绿。
  const typed = 'a rough draft: i still reject the wording'
  await reasonBox.pressSequentially(typed, { delay: 5 })
  await page.waitForTimeout(300)
  await expect(
    dialog,
    '在输入框里打字触发了别的决定 —— 写驳回理由时会随手把评审结掉',
  ).toContainText('gate')
  await expect(reasonBox).toHaveValue(typed)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // 组合键：Cmd/Ctrl+A 是全选。A 在没有评论时**不弹窗、直接批准**，所以这里不能只看
  // 「有没有弹窗」——必须回到服务端确认这一轮**没有被决定**。
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.waitForTimeout(500)
  await expect(dialog).toHaveCount(0)
  const afterChord = await api<ReviewSummaryRow[]>(
    `/api/reviews?taskId=${encodeURIComponent(taskId)}`,
  )
  expect(
    afterChord.find((r) => r.nodeRunId === nodeRunId)?.awaitingReview,
    '一次全选就把评审批准了 —— 这是不可逆的',
  ).toBe(true)

  // 历史视图那一档的守卫在下一条里验——`?version=` 指向**当前**版本时会折回当前视图
  // （与 `?round=` 同款折叠），所以真正的历史版本只有在这一轮被决定、v2 生成之后才存在。
})

test('驳回之后：页面写清是谁、什么角色做的决定；而这份归属绝不进重跑的提示词 @nightly', async ({
  page,
}) => {
  await openReview(page)
  const before = await api<{ currentVersion: { id: string } }>(`/api/reviews/${nodeRunId}`)

  await page.keyboard.press('r')
  const dialog = page.getByTestId('review-decision-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('textarea').fill(REJECT_REASON)
  await page.getByRole('button', { name: 'Confirm' }).click()
  await expect(dialog).toHaveCount(0)

  // 新一轮到位。
  await waitForReview(1)

  // 历史版本上：决策归属（人 + 角色）+ 驳回理由。
  await openReview(page, `?version=${before.currentVersion.id}`)
  const decider = page.getByTestId('review-decider')
  await expect(decider).toContainText(meName)
  await expect(decider).toContainText('Owner')
  await expect(page.getByTestId('review-decision-reason')).toContainText(REJECT_REASON)

  // 顺带把键盘那条的第三档补上：历史版本上按 I 不许开决定框——对一份已经被否掉的
  // 旧稿再做决定，落到哪一轮都说不清。
  await page.keyboard.press('i')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('review-decision-dialog'), '历史版本上还能开决定框').toHaveCount(0)

  // 而重跑那一趟的提示词里，既没有 user id 也没有显示名。
  const runs = await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)
  const gateRuns = runs.runs.filter((r) => r.nodeId === 'gate')
  expect(gateRuns.length, '驳回必须真的重跑了 gate，否则下面这条断言是空的').toBeGreaterThan(1)
  const rerun = gateRuns.at(-1)!
  expect(rerun.promptText ?? '', '驳回理由本来就该进重跑提示词').toContain(REJECT_REASON)
  expect(rerun.promptText ?? '', '决策人 id 进了 prompt —— 模型会开始看人下菜').not.toContain(meId)
  expect(rerun.promptText ?? '', '决策人显示名进了 prompt').not.toContain(meName)
})
