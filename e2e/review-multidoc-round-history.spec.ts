// RFC-319 B60 —— HUMAN-40 / HUMAN-X4：多文档评审的**轮次**这一面。
//
// 多文档评审跟单文档不是同一件事：一轮里有 N 篇文档，人要逐篇决定接受 / 不接受，整轮
// 再一起批准或打回。这就多出四条单文档没有的用户面契约，而它们此前一条 e2e 都没有
// （仓内此前没有任何 e2e 打开过多文档评审页）：
//
//   1. **列表里得看得出这是多文档**。看不出来，人会按单文档的心智点进去，然后发现
//      「怎么只审到一篇」——被漏审的那几篇会带着未审状态一起走完流程。
//   2. **展开的是「轮」不是「版本」**。多文档的 versionIndex 是**逐篇**编号的
//      （v1,v1,v1,v2…），照单文档那样铺版本行，人根本对不上「第几轮」——RFC-142
//      的注释逐字写着这条。
//   3. **历史轮必须只读，并且写清那一轮为什么被打回**。历史轮上还能点接受 / 批准，
//      等于让人对着一份已经作废的稿子做决定；而不写驳回理由，人就不知道这一轮到底
//      哪里没过。
//   4. **上一轮接受过、这一轮内容变了的文档要打「已变更」**。RFC-129 的设计判据：
//      选择是跨轮继承的——不打这个标，一个人上一轮接受过的文档改了内容还挂着
//      「已接受」，他会直接批准，等于**没人审过**新内容就发布了。
//
// 外加 HUMAN-X4：逐篇接受 / 不接受的**界面**通路与 q / w 快捷键（`multiDocHotkeys.ts`
// 里那条「带 ctrl/meta/alt/shift 一律不接管」的守卫，只有真键盘事件才试得出来）。
//
// 判据取自源码单一事实源：
//   shared/reviewMultiDoc.ts:281-303   inheritSelection：继承非 unselected 的选择，内容变了 ⇒ stale
//   services/review.ts:796-819         新一轮逐项按 path→index 继承并写 selection_stale
//   services/review.ts:1716            stale = selectionStale === true 出到 ReviewDetail.documents
//   services/review.ts:2912            人一旦重新表态，stale 归 false
//   routes/reviews.tsx:203-210         列表多文档徽标
//   routes/reviews.tsx:355-415         RoundRows：多文档按轮展开，非当前轮的 Open 带 ?round=
//   components/review/MultiDocReviewView.tsx:366-405  历史轮不渲染整轮决策按钮
//   components/review/MultiDocReviewView.tsx:445-462  只读横幅（点名第几轮 + 该轮决策）
//   lib/review/multiDocHotkeys.ts:20-41  q/w = 接受 / 不接受；带修饰键一律不接管

import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'
import { loadWorkflowFixture } from './workflow-fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUSINESS_DIR = join(HERE, '..', 'examples', 'workflows', 'business')

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

/** 整轮驳回理由：必须原样出现在历史轮的决策信息块里。 */
const REJECT_REASON =
  'RFC-319 B60: name the retention owner and legal approval evidence in every published document'

const READ_ONLY_PERMISSION = { read: 'allow', edit: 'deny', write: 'deny' } as const

const AGENT_FIXTURES = [
  {
    name: 'business-document-reviewer',
    outputs: ['finding'],
    outputKinds: { finding: 'markdown' },
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-compliance-aggregator',
    outputs: ['report'],
    outputKinds: { report: 'markdown' },
    outputWrapperPortNames: { report: 'compliance_report' },
    role: 'aggregator',
    permission: READ_ONLY_PERMISSION,
  },
  {
    name: 'business-document-publisher',
    outputs: ['documents'],
    outputKinds: { documents: 'list<markdown>' },
    permission: {},
  },
  {
    name: 'business-document-releaser',
    outputs: ['published_paths'],
    outputKinds: { published_paths: 'list<path<md>>' },
    permission: {},
  },
  // 单文档对照组用：它是 business stub 里唯一一个「输入全部可由纯文本喂饱」的分支，
  // 因此能在不碰 fanout / worktree 的前提下产出一个 markdown 端口。
  {
    name: 'business-quality-gate',
    outputs: ['quality_status', 'release_brief'],
    outputKinds: { quality_status: 'string', release_brief: 'markdown' },
    permission: {},
  },
] as const

let daemon: DaemonHandle
let repoDir: string
let stateDir: string
/** 多文档评审（doc-batch 工作流）的 review node_run。 */
let multiDocNodeRunId: string
/** 第一轮（已驳回）的 roundKey。 */
let firstRoundKey: string
/** 单文档对照评审的 node_run —— 用来证明多文档徽标 / 按轮展开不是无条件渲染的。 */
let singleDocNodeRunId: string
const agentIds = new Map<string, string>()

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
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
  isMultiDoc?: boolean
}

interface ReviewDocument {
  docVersionId: string
  itemIndex: number
  title: string
  selection: 'unselected' | 'accepted' | 'not_accepted'
  stale?: boolean
}

interface ReviewRound {
  roundKey: string
  decision: string
  decisionReason: string | null
  isCurrent: boolean
  members: unknown[]
}

async function waitForReview(taskId: string, minIteration = 0): Promise<ReviewSummaryRow> {
  let last: ReviewSummaryRow[] = []
  await expect
    .poll(
      async () => {
        last = await api<ReviewSummaryRow[]>(`/api/reviews?taskId=${encodeURIComponent(taskId)}`)
        return last.some((row) => row.awaitingReview && row.reviewIteration >= minIteration)
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  const row = last.find((r) => r.awaitingReview && r.reviewIteration >= minIteration)
  if (row === undefined) throw new Error(`no review for ${taskId}`)
  return row
}

async function documents(nodeRunId: string): Promise<ReviewDocument[]> {
  const detail = await api<{ documents?: ReviewDocument[] }>(`/api/reviews/${nodeRunId}`)
  return detail.documents ?? []
}

async function openPage(page: Page, path: string): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}${path}`)
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-multidoc-state-'))
  daemon = await startDaemon({
    stubMode: 'business-workflows',
    extraEnv: { BUSINESS_WORKFLOW_STATE_DIR: stateDir },
    configOverrides: {
      defaultNodeRetries: 0,
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 10_000,
    },
  })

  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-multidoc-repo-'))
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 multidoc fixture\n')
  writeFileSync(
    join(repoDir, 'docs', 'customer-policy.md'),
    '# Customer policy\n\nSource: Customer Operations.\n',
  )
  writeFileSync(
    join(repoDir, 'docs', 'partner-policy.md'),
    '# Partner policy\n\nSource: Partner Operations.\n',
  )
  initGitRepo(repoDir)

  for (const fixture of AGENT_FIXTURES) {
    const created = await api<{ id: string; name: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        ...fixture,
        description: `RFC-319 B60 fixture: ${fixture.name}`,
        bodyMd: 'Deterministic agent used by the RFC-319 multi-doc review scenario.',
      }),
    })
    agentIds.set(created.name, created.id)
  }

  const wf = await loadWorkflowFixture<{ id: string; version: number }>(
    apiFetch,
    join(BUSINESS_DIR, 'document-batch-compliance-publishing.yaml'),
  )
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: wf.id,
      expectedWorkflowVersion: wf.version,
      name: 'rfc319-b60-multidoc',
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: {
        documents: 'docs/customer-policy.md\ndocs/partner-policy.md',
        compliance_policy: 'RETENTION_OWNER_REQUIRED and legal approval evidence are mandatory',
      },
    }),
  })

  // ── 第一轮：只接受「客户公告」，核对表留着不表态 ─────────────────────────
  // 这一手是后面「已变更」徽标的判别式：继承来的**已接受** + 内容变了 ⇒ 打标；
  // 没表过态的那篇继承为 unselected ⇒ 不打标。两篇都打标 / 都不打标都会被这条抓到。
  const firstReview = await waitForReview(task.id)
  multiDocNodeRunId = firstReview.nodeRunId
  expect(firstReview.isMultiDoc, 'doc-batch 工作流的 review 必须是多文档轮').toBe(true)
  const firstDocs = await documents(multiDocNodeRunId)
  expect(firstDocs.map((d) => d.title)).toEqual(['Customer notice v1', 'Compliance checklist v1'])
  await api(`/api/reviews/${multiDocNodeRunId}/documents/${firstDocs[0]!.docVersionId}/selection`, {
    method: 'PATCH',
    body: JSON.stringify({ selection: 'accepted' }),
  })

  const roundsBefore = await api<ReviewRound[]>(`/api/reviews/${multiDocNodeRunId}/rounds`)
  expect(roundsBefore).toHaveLength(1)
  firstRoundKey = roundsBefore[0]!.roundKey

  // ── 整轮驳回，带理由 ───────────────────────────────────────────────────
  await api(`/api/reviews/${multiDocNodeRunId}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'rejected',
      reviewIteration: firstReview.reviewIteration,
      rejectReason: REJECT_REASON,
    }),
  })
  await waitForReview(task.id, firstReview.reviewIteration + 1)
  await expect
    .poll(async () => (await documents(multiDocNodeRunId)).map((d) => d.title), {
      timeout: 60_000,
    })
    .toEqual(['Customer notice v2', 'Compliance checklist v2'])

  // ── 单文档对照组：证明「多文档徽标」「按轮展开」不是无条件渲染 ──────────────
  // 单 markdown 端口做 review 源 ⇒ 单文档 approved_doc 形态
  // （shared/reviewMultiDoc.ts:96-108）。评审节点的源**必须**是 agent 节点
  // （validator: review-input-source-not-markdown），所以这里借 business stub 里
  // 唯一一个输入可由纯文本喂饱的分支（quality-gate）产出那一篇 markdown。
  const singleWf = await api<{ id: string; version: number }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b60-single-doc-control',
      description: 'RFC-319 B60 single-document control review',
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
            agentId: agentIds.get('business-quality-gate'),
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
            id: 'single_review',
            kind: 'review',
            title: 'RFC-319 single-doc control',
            inputSource: { nodeId: 'gate', portName: 'release_brief' },
            position: { x: 640, y: 80 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [
              { name: 'approved', bind: { nodeId: 'single_review', portName: 'approved_doc' } },
            ],
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
            target: { nodeId: 'single_review', portName: '__review_input__' },
          },
          {
            id: 'e_review_out',
            source: { nodeId: 'single_review', portName: 'approved_doc' },
            target: { nodeId: 'out_1', portName: 'approved' },
          },
        ],
      },
    }),
  })
  const singleTask = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: singleWf.id,
      expectedWorkflowVersion: singleWf.version,
      name: 'rfc319-b60-single-doc-control',
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: {
        status: 'needs-fix',
        report: '# Single doc control\n\nOne document, one decision.\n',
      },
    }),
  })
  const singleReview = await waitForReview(singleTask.id)
  singleDocNodeRunId = singleReview.nodeRunId
  expect(singleReview.isMultiDoc ?? false, '对照组必须是单文档轮，否则它不成其为对照').toBe(false)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

test('评审列表：多文档看得出是多文档，展开的是「轮」而不是版本', async ({ page }) => {
  await openPage(page, '/reviews')
  // 两条评审各自一个任务分组（`.reviews-group`）；按分组取，避免两张表的行 / 面板
  // 在整页 DOM 顺序上互相错位。
  const multiGroup = page.locator('.reviews-group').filter({ hasText: 'publication_review' })
  const singleGroup = page.locator('.reviews-group').filter({ hasText: 'single_review' })
  const multiRow = multiGroup.locator('tbody tr').first()
  const singleRow = singleGroup.locator('tbody tr').first()
  await expect(multiRow).toBeVisible()
  await expect(singleRow).toBeVisible()

  // 徽标只挂在多文档那一行——对照组在同一张表里，无条件渲染会被这条抓到。
  await expect(multiRow.getByTestId('review-multidoc-badge')).toHaveCount(1)
  await expect(singleRow.getByTestId('review-multidoc-badge')).toHaveCount(0)
  // 钉住对照行确实是那条单文档评审（而不是碰巧同名的别的行）。
  await expect(singleRow.locator(`a[href*="${singleDocNodeRunId}"]`).first()).toBeVisible()

  // 展开多文档：按轮，两轮，第一轮 rejected，第二轮 current。
  await multiRow.locator('.reviews-row__expand').click()
  const roundPanel = multiGroup.locator('.reviews-version-panel')
  await expect(roundPanel).toContainText('Review rounds · 2')
  const roundItems = roundPanel.locator('.reviews-version-list__item')
  await expect(roundItems).toHaveCount(2)
  await expect(roundItems.nth(0)).toContainText('Round 1')
  await expect(roundItems.nth(0)).toContainText('rejected')
  await expect(roundItems.nth(0)).toContainText('2 document(s)')
  await expect(roundItems.nth(1)).toContainText('Round 2')
  await expect(roundItems.nth(1)).toContainText('current')
  // 非当前轮的 Open 必须带上 ?round=；当前轮不带（否则「回到当前轮」自己就是历史轮）。
  await expect(roundItems.nth(0).locator('a')).toHaveAttribute(
    'href',
    new RegExp(`\\?round=${firstRoundKey}$`),
  )
  await expect(roundItems.nth(1).locator('a')).not.toHaveAttribute('href', /\?round=/)

  // 展开单文档：仍是版本行（v1），不是轮 —— 两种展开形态必须分得开。
  await singleRow.locator('.reviews-row__expand').click()
  const singlePanel = singleGroup.locator('.reviews-version-panel')
  await expect(singlePanel).not.toContainText('Review rounds')
  await expect(singlePanel.locator('.reviews-version-list__item').first()).toContainText('v1')
})

test('历史轮：只读、点名第几轮、并写清那一轮为什么被打回', async ({ page }) => {
  await openPage(page, `/reviews/${encodeURIComponent(multiDocNodeRunId)}?round=${firstRoundKey}`)

  // 只读横幅点名「第 1 轮 · rejected」——只说「只读」不说是哪一轮，人分不清自己在看什么。
  const banner = page.locator('.readonly-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('round 1')
  await expect(banner).toContainText('rejected')

  // 驳回理由必须原样在场：不写理由，人不知道这一轮到底哪里没过。
  await expect(page.getByTestId('review-decision-reason')).toContainText(REJECT_REASON)

  // 文档导航里是**那一轮**的成员（v1），不是当前轮的 v2。
  const docList = page.locator('.review-multidoc__doc-title')
  await expect(docList).toHaveCount(2)
  await expect(docList.nth(0)).toHaveText('Customer notice v1')
  await expect(docList.nth(1)).toHaveText('Compliance checklist v1')

  // 一切写入通路都不在场：历史轮上还能点接受 / 批准，等于对一份作废的稿子做决定。
  await expect(page.getByTestId('multidoc-accept')).toHaveCount(0)
  await expect(page.getByTestId('multidoc-not-accept')).toHaveCount(0)
  await expect(page.getByTestId('multidoc-approve')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0)

  // 认不出来的 round 不能静默当成当前轮：要出警告，并把地址退回当前轮。
  await openPage(page, `/reviews/${encodeURIComponent(multiDocNodeRunId)}?round=g-nope`)
  await expect(page.getByTestId('review-invalid-round-warning')).toContainText('g-nope')
  await expect.poll(() => new URL(page.url()).search).toBe('')
  await expect(page.locator('.readonly-banner')).toHaveCount(0)
})

test('上一轮接受过、这一轮内容变了的文档，必须打「已变更」', async ({ page }) => {
  // 服务端先对账：继承来的选择还在，且只有内容变了的那篇是 stale。
  const docs = await documents(multiDocNodeRunId)
  expect(docs.map((d) => [d.title, d.selection, d.stale === true])).toEqual([
    ['Customer notice v2', 'accepted', true],
    ['Compliance checklist v2', 'unselected', false],
  ])

  await openPage(page, `/reviews/${encodeURIComponent(multiDocNodeRunId)}`)
  const rows = page.locator('.review-multidoc__doc')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Accepted')
  await expect(rows.nth(0).getByTestId('multidoc-stale-badge')).toHaveCount(1)
  await expect(rows.nth(0).getByTestId('multidoc-stale-badge')).toHaveText('Changed')
  // 没表过态的那篇不打标——徽标要是无条件渲染，人就永远分不出哪篇真的变了。
  await expect(rows.nth(1)).toContainText('Undecided')
  await expect(rows.nth(1).getByTestId('multidoc-stale-badge')).toHaveCount(0)
})

test('逐篇接受 / 不接受：界面按钮与 q / w 快捷键，且带修饰键一律不接管', async ({ page }) => {
  await openPage(page, `/reviews/${encodeURIComponent(multiDocNodeRunId)}`)
  const rows = page.locator('.review-multidoc__doc')
  await expect(rows).toHaveCount(2)

  // 第二篇此前没表过态：点「不接受」后应立刻反映在导航行上。
  await rows.nth(1).click()
  await page.getByTestId('multidoc-not-accept').click()
  await expect(rows.nth(1)).toContainText('Excluded')

  // q = 接受。
  await page.keyboard.press('q')
  await expect(rows.nth(1)).toContainText('Accepted')

  // 第一篇是那条**继承来 + 已变更**的：人一旦重新表态，「已变更」就该消失
  // （stale 归 false）。否则这个标会永远挂着，第二次起就没人再当回事了。
  await expect(rows.nth(0).getByTestId('multidoc-stale-badge')).toHaveCount(1)
  await rows.nth(0).click()
  await page.getByTestId('multidoc-not-accept').click()
  await expect(rows.nth(0)).toContainText('Excluded')
  await expect(
    rows.nth(0).getByTestId('multidoc-stale-badge'),
    '重新表态之后「已变更」还挂着 —— 这个提示就永远洗不掉了',
  ).toHaveCount(0)

  // 带修饰键的同一个键**不能**被接管：Cmd/Ctrl+Q 在系统里是退出。
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+q' : 'Control+q')
  await page.waitForTimeout(300)
  await expect(
    rows.nth(0),
    '带修饰键的 q 被接管了 —— 会顶掉浏览器 / 系统自己的快捷键',
  ).toContainText('Excluded')

  // ↑ / ↓ 在文档间移动焦点（无环绕）。
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1), '到底了不该环绕回第一篇').toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true')
})
