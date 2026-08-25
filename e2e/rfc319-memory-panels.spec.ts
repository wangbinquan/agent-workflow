// RFC-319 —— 记忆页的**用户面**：新建 / 校验 / 分区导航 / 按 scope 浏览 /
// 冲突取代 / 审批失败 / 编辑弹窗的详情态 / 各面板的加载失败与重试。
// 覆盖 MEM-02 / MEM-03 / MEM-06 / MEM-07 / MEM-11 / MEM-12 / MEM-20 / MEM-23 /
// MEM-X6 / MEM-X7。
//
// **刻意不重复**（已被别处锁住，本文件只把它们当夹具用，不再断言）：
//   * MEM-04 / MEM-08 / MEM-10 / MEM-19 / MEM-34 / MEM-35 / MEM-36 / MEM-37 /
//     MEM-48（可见性与管理权边界、驳回终态、删除双门、列表过滤）
//     —— e2e/memory-access.spec.ts；
//   * MEM-24 / MEM-31（蒸馏任务分区的权限门与深链回落）
//     —— e2e/memory-distill-gating.spec.ts；
//   * RFC-045 的手工建 → 编辑 → 批准直线流程 —— e2e/memory-manual-create-edit.spec.ts；
//   * 「融合」页签的空态 / 错误态互斥与徽章 —— e2e/fusion-review-surface.spec.ts:285。
//     六个记忆面板里的**第六个**（fusion）因此在本文件的 MEM-X6 里被显式跳过，
//     不是漏掉——见该用例开头的清单。
//
// 记忆是**会被注入进下一次任务 prompt** 的内容，所以这一屏的所有失效都属于
// 「不报错、只是安静地跑偏」那一类：
//
//   * 非 global scope 选不中目标 ⇒ 用户以为自己给某个 agent 挂了条规矩，
//     实际落在 global 上，从此每个任务都吃这条规矩；或者反过来一条也没生效；
//   * 表单校验漏放 ⇒ 空标题 / 超长正文打到服务端，用户拿到的是一坨 422 原文；
//     更糟的是非 global 缺 scopeId 时**静默按 global 存下**；
//   * 按 scope 浏览的分档计数错 / 缺一档 ⇒ 用户在「全部已批准」里看得到、
//     在它自己那一档下永远找不到（RFC-248 实撞过 repo_group 这一档）；
//   * 冲突候选没有对比、或「批准并取代」没接上 supersede ⇒ 新旧两条同时留在
//     approved 面上，往后每次注入都把互相矛盾的两条一起塞进 prompt；
//   * 审批失败静默 ⇒ 用户点了「批准」，卡片还在那儿，他再点一次、再点一次，
//     真正的失败原因只留在服务端；
//   * 编辑弹窗详情拉不到却仍摆着 Save ⇒ 用户对着一个空表单点保存，
//     要么什么都不发生，要么把空值写回去；
//   * 无改动也发 PATCH ⇒ 每次「打开看看又关掉」都把 version 顶高一格，
//     审计里全是没有内容的版本；
//   * 面板加载失败冒充空态 ⇒ 「没有待审记忆」和「拉取失败」在界面上长得一样，
//     等着人审的候选从此彻底消失在视野里。
//
// 判据取自源码单一事实源（纯文本引用，勿改成外链）：
//   packages/frontend/src/routes/memory.tsx:92-94            requestedTab 解析与 distill 回落
//   packages/frontend/src/routes/memory.tsx:107-114          未知 tab → replace 成 all，hash 保留
//   packages/frontend/src/routes/memory.tsx:287-297          面板 aria-labelledby + h2 tabIndex=-1
//   packages/frontend/src/components/PageSectionNav.tsx:419-441  面板卸载后把焦点交还当前分区链接
//   packages/frontend/src/components/memory/MemoryFormFields.tsx:108-130  validateMemoryForm
//   packages/frontend/src/components/memory/MemoryFormFields.tsx:174-182  ChipsInput 的 validateTag
//   packages/frontend/src/components/memory/MemoryFormFields.tsx:198-226  scopeId 档（global 无目标 / 其余走 Select）
//   packages/frontend/src/components/memory/MemoryDialogShell.tsx:61-65   校验闸 isInvalid
//   packages/frontend/src/components/memory/MemoryDialogShell.tsx:120-133 只有非 contentState 才渲染 Save
//   packages/frontend/src/components/memory/MemoryDialogShell.tsx:136-141 loading / error / 表单三态
//   packages/frontend/src/components/memory/MemoryEditDialog.tsx:39-61    diffAgainst（顺序无关的 tags 比较）
//   packages/frontend/src/components/memory/MemoryEditDialog.tsx:150-158  空 diff ⇒ 直接关闭，不发 PATCH
//   packages/frontend/src/components/memory/MemoryEditDialog.tsx:177-183  contentState 接线
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:60-85 加载 / 错误 / 空三态
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:106-141 Compare → approve_and_supersede
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:142-146 memory-approve-error
//   packages/frontend/src/components/memory/MemoryApprovalQueue.tsx:231-240 Compare 按钮的出现条件
//   packages/frontend/src/components/memory/MemoryConflictCompareDialog.tsx:37-43,55-68,82-92
//   packages/frontend/src/components/memory/MemoryAllList.tsx:316-350     三态 + 两种空态文案
//   packages/frontend/src/components/memory/MemoryAllList.tsx:329-339     有数据时错误横幅与行**并存**
//   packages/frontend/src/components/memory/MemoryByScopeBrowser.tsx:41-65 五档分组 + 计数 + 每档空态
//   packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx:62-68 三态
//   packages/frontend/src/lib/memory.ts:125-131               SCOPE_TABS 五档顺序
//   packages/backend/src/services/memory.ts:152-200           createManualCandidate 恒置
//                                                            distillAction / supersedesId = null
//   packages/backend/src/services/memory.ts:313-333           getMemoryById 的 supersede 祖先链
//   packages/backend/src/services/memory.ts:365-425           approve_and_supersede 的四条不变量
//   packages/backend/src/routes/memories.ts:127-140           dropCandidates
//   packages/shared/src/schemas/memory.ts:131-155             MemoryCreateRequestSchema
//
// **已知缺陷，本文件如实绕开而不锁死**（交付说明里另有汇报）：
//   `MemoryDialogShell.tsx:34-38` 把 `/api/cached-repos` 的行声明成 `{ id, url, localPath }`，
//   `:194-196` 的 `reposToOptions` 于是取 `r.url` 当标签；但 RFC-204 早已把明文 `url`
//   从 wire 上摘掉，服务端实际只回 `urlRedacted`（`packages/shared/src/schemas/cachedRepo.ts:15`、
//   `packages/backend/src/services/gitRepoCache.ts:353-359`）。结果是 **repo 档的下拉每一行都是空白**。
//   本文件在 MEM-02 里按**位置**选中它并用服务端回读校验 scopeId，不去断言它的文案——
//   断言空白等于把这个 bug 锁进测试。
//
// **覆盖边界（如实记，免得后人看到「改了没红」误以为没覆盖）**：
//   * `MemoryFormFields.tsx:125-128` 里 `validateMemoryForm` 的 errTagTooLong /
//     errTagsTooMany 两支**在 UI 上够不到**——`:174-182` 的 ChipsInput validate
//     先把越界 token 挡在 commit 之前，state 里根本不会出现越界标签。删掉那两支
//     本文件照样绿；真正兜住用户那一层的是 chips 自己的错误行，MEM-03 断的是它。
//   * `routes/memory.tsx:98,184,293` 的 `sectionHeadingRef` 是**死代码**：造出来、
//     一路传到 h2 上、全仓没有任何地方调用它的 `focus()`。没有行为可断言，
//     MEM-23 改断 `PageSectionNav.tsx:419-441` 的焦点交还。
//   * `MemoryAllList.tsx:331-338` 的逐行取消归档错误（`memory-unarchive-error-<id>`）、
//     `MemoryConflictCompareDialog.tsx:59-60` 里现有记忆详情拉失败的重试分支、
//     以及两个弹窗的 in-flight disabled 态（`MemoryDialogShell.tsx:115,128`）——均未覆盖。
//   * `MemoryScopedList.tsx` （资源详情页的「记忆」子页签）不在 /memory 这一屏内，不属本文件。
//   * repo 档下拉的**文案**（见上一节的已知缺陷）刻意不断言。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

// serial：MEM-X7 需要「库里一条记忆都没有」的前提，而其余每条用例都会往库里写。
// 顺序是这个文件的一部分，别改成 parallel，也别把 MEM-X7 挪到后面去。
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
/** 夹具资源：四个非 global scope 各一个可选目标。 */
let agentId = ''
let agentName = ''
let workflowId = ''
let workflowName = ''
let repoGroupId = ''
let repoGroupName = ''
let cachedRepoId = ''
const scratch: string[] = []
let sequence = 0

interface MemoryWire {
  id: string
  scopeType: string
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
  status: string
  version: number
  supersedesId: string | null
  supersededById: string | null
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await req(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

/**
 * 手工建的记忆初始状态恒为 `candidate`（`services/memory.ts:152-200`，
 * 没有「跳过人审」的捷径）；`approve=true` 时再走一次 promote 把它送进
 * approved 面。
 */
async function seedMemory(
  scopeType: string,
  scopeId: string | null,
  title: string,
  bodyMd: string,
  approve: boolean,
): Promise<string> {
  const created = await api<{ memory: { id: string } }>('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ scopeType, scopeId, title, bodyMd }),
  })
  if (approve) {
    await api(`/api/memories/${created.memory.id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    })
  }
  return created.memory.id
}

async function memoryOf(id: string): Promise<{ memory: MemoryWire; ancestors: MemoryWire[] }> {
  return api<{ memory: MemoryWire; ancestors: MemoryWire[] }>(`/api/memories/${id}`)
}

/** 按**精确标题**回读服务端的那一行——UI 建出来的行 id 测试并不知道。 */
async function memoryByTitle(title: string): Promise<MemoryWire> {
  const list = await api<{ items: MemoryWire[] }>(
    `/api/memories?search=${encodeURIComponent(title)}`,
  )
  const hit = list.items.find((row) => row.title === title)
  expect(
    hit,
    `服务端没有标题为「${title}」的记忆 ⇒ 界面说保存成功，其实什么都没写进去`,
  ).toBeTruthy()
  return hit as MemoryWire
}

async function openApp(page: Page, path: string): Promise<void> {
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
  // 分区导航渲染出来才算这一页真的起来了；不等的话后面所有 toHaveCount(0)
  // 都可能只是在断言「页面还没画」。
  await expect(page.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
}

/** 故障注入闸：`state.armed` 为真时把匹配到的请求换成 503。 */
interface Fault {
  armed: boolean
}

async function injectOutage(page: Page, match: (url: URL) => boolean, state: Fault): Promise<void> {
  await page.route(
    (url) => match(url),
    async (route) => {
      if (!state.armed) {
        await route.continue()
        return
      }
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'rfc319-injected-outage',
          message: 'injected by rfc319-memory-panels e2e',
        }),
      })
    },
  )
}

/** `/api/memories` 的读法很多；只掐指定 `status` / `include` 的那一种。 */
function memoryListMatcher(status: string, include?: string): (url: URL) => boolean {
  return (url) =>
    url.pathname === '/api/memories' &&
    url.searchParams.get('status') === status &&
    (url.searchParams.get('include') ?? null) === (include ?? null)
}

/** 记忆面板里的错误横幅（ErrorBanner 一律带 `.error-box`）。 */
function panelError(page: Page): Locator {
  return page.getByTestId('memory-section-panel').locator('.error-box')
}

/** 打开 `<Select>` 的 portal 列表并按名字点中一项。 */
async function chooseScopeTarget(page: Page, dialog: Locator, name: RegExp): Promise<void> {
  await dialog.getByRole('combobox', { name: 'Scope target', exact: true }).click()
  const listbox = page.getByRole('listbox', { name: 'Scope target', exact: true })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name }).click()
  await expect(listbox).toHaveCount(0)
}

test.beforeAll(async () => {
  daemon = await startDaemon()

  agentName = `rfc319-mem-agent-${++sequence}`
  agentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: agentName,
        description: 'RFC-319 memory panel fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
      }),
    })
  ).id

  workflowName = `rfc319-mem-workflow-${++sequence}`
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: workflowName,
        description: 'RFC-319 memory panel fixture',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      }),
    })
  ).id

  // repo / repo_group 两档的下拉来源是真实的镜像与组，不能凭空捏造 id：
  // 服务端只在**创建**时校验管理权，scopeId 是否存在要靠这两档的下拉本身保证。
  const repoDir = mkdtempSync(join(tmpdir(), `aw-rfc319-mempanel-${++sequence}-`))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 memory panels fixture\n', 'utf-8')
  initGitRepo(repoDir)
  scratch.push(repoDir)
  const repoUrl = repoRemoteUrl(repoDir)
  const started = await api<{ batchId: string; state: string }>('/api/cached-repos/batch-import', {
    method: 'POST',
    body: JSON.stringify({ urls: [repoUrl] }),
  })
  await expect
    .poll(
      async () =>
        (await api<{ state: string }>(`/api/cached-repos/imports/${started.batchId}`)).state,
      { timeout: 90_000 },
    )
    .toBe('completed')
  const mirrors = await api<{ items: Array<{ id: string; urlRedacted: string }> }>(
    '/api/cached-repos',
  )
  const mirror = mirrors.items.find((row) => row.urlRedacted === repoUrl)
  expect(mirror, `夹具仓没有导入成功: ${JSON.stringify(mirrors.items)}`).toBeTruthy()
  cachedRepoId = (mirror as { id: string }).id

  repoGroupName = `rfc319-mem-group-${++sequence}`
  repoGroupId = (
    await api<{ id: string }>('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: repoGroupName,
        description: '',
        nodes: [{ path: '', attachment: { kind: 'repo', repoUrl } }],
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

// ---------------------------------------------------------------------------
// MEM-X7 —— All 库的两个空态：文案必须不同，且都不是错误态假扮的
//
// ⚠️ 本用例**必须第一个跑**（describe 是 serial）：它要的前提是「这台 daemon 上
//    还没有任何记忆」，而后面每一条用例都会往库里写东西。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X7: 空库时「已批准」与「已归档」各说各的话，不是同一句套话，也不是错误态假扮的空', async ({
  page,
}) => {
  expect(
    (await api<{ items: MemoryWire[] }>('/api/memories')).items,
    '这台 daemon 上已经有记忆了 ⇒ 本用例的前提不成立（它必须第一个跑）',
  ).toHaveLength(0)

  await openApp(page, '/memory')

  // ① 已批准视图的空态。两条文案都断言：只有标题的话，「暂时没有」和
  //    「怎么才能有」这两件事里用户只拿到前一件，他不知道下一步该做什么。
  await expect(
    page.getByText('No approved memories in the library yet', { exact: true }),
    '空库时「已批准」连一句空态都没有 ⇒ 用户面对一片空白，不知道是没有还是没加载出来',
  ).toBeVisible()
  await expect(
    page.getByText('Approve a candidate first; future tasks can then use it within its scope.', {
      exact: true,
    }),
    '空态只有标题没有出路 ⇒ 用户不知道记忆要先经人审才会进库',
  ).toBeVisible()
  await expect(
    page.getByTestId('memory-all-list'),
    '空态与列表同时在场 ⇒ 页面自相矛盾',
  ).toHaveCount(0)
  await expect(
    panelError(page),
    '空态旁边还挂着错误横幅 ⇒ 「没有数据」和「拉取失败」被混成一件事',
  ).toHaveCount(0)

  // ② 切到「已归档」。这一档的文案必须**不同**——两个视图共用一句话的话，
  //    用户切过来根本看不出自己切没切成功。
  await page.getByTestId('memory-all-filter-archived').click()
  await expect(page.getByText('No archived memories', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'Items archived from the Approved view stay here and can be restored at any time.',
      { exact: true },
    ),
    '归档空态没告诉用户「归档的东西还能恢复」 ⇒ 他会以为归档等于删除',
  ).toBeVisible()
  await expect(
    page.getByText('No approved memories in the library yet', { exact: true }),
    '归档视图复用了「已批准」的空态文案 ⇒ 分段控件切了个寂寞，用户无从判断当前在看哪一档',
  ).toHaveCount(0)
  await expect(panelError(page), '归档空态旁边挂着错误横幅 ⇒ 同样是空/错混淆').toHaveCount(0)

  // ③ 负向对照：这两句空态不是写死的。库里放进一条已批准记忆，
  //    「已批准」那句就必须消失——否则上面两条断言只是在读常量。
  const controlTitle = `rfc319-x7-control-${++sequence}`
  await seedMemory('global', null, controlTitle, 'RFC-319 MEM-X7 negative control body.', true)
  await page.getByTestId('memory-all-filter-approved').click()
  await expect(page.getByTestId('memory-all-list')).toBeVisible()
  await expect(
    page.getByText('No approved memories in the library yet', { exact: true }),
    '库里已经有已批准记忆，空态却还在 ⇒ 空态是写死的，前面的断言证明不了任何东西',
  ).toHaveCount(0)
  await expect(page.getByTestId('memory-all-list')).toContainText(controlTitle)
})

// ---------------------------------------------------------------------------
// MEM-23 —— 分区导航与 ?tab= 深链
// ---------------------------------------------------------------------------

test('RFC-319 MEM-23: /memory 的分区由 URL 决定——默认落在 All、深链直达、未知 tab 静默回落且保住 hash', async ({
  page,
}) => {
  // ① 不带 tab ⇒ 稳定落在「全部已批准」。这一档是首页记忆磁贴计的那个池子，
  //    落错分区的话磁贴上的数字与点进来看到的东西对不上。
  await openApp(page, '/memory')
  await expect(
    page.getByTestId('memory-section-all'),
    '缺省不落在 All ⇒ 首页磁贴的计数与点进来看到的内容互相矛盾',
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('memory-section-panel')).toHaveClass(/memory-section-panel--all/)
  await expect(
    page.locator('.page-section-nav [aria-current="page"]'),
    '同时有多个分区自称「当前」 ⇒ 用户与读屏都无法判断自己在哪一档',
  ).toHaveCount(1)

  // ② 点另一档 ⇒ URL 跟着走。URL 不跟着走的话，用户没法把「我看的这一屏」
  //    发给同事，刷新也会弹回默认档。
  await page.getByTestId('memory-section-by-scope').click()
  await expect(page).toHaveURL(`${daemon.baseUrl}/memory?tab=by-scope`)
  await expect(page.getByTestId('memory-section-by-scope')).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByTestId('memory-section-all'),
    '切走之后旧分区还挂着 aria-current ⇒ 导航上同时亮两格',
  ).not.toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('memory-by-scope')).toBeVisible()
  // 面板标题跟着换，且 aria-labelledby 指向的就是它——读屏用户靠这条知道
  // 自己进了哪一档。
  const panel = page.getByTestId('memory-section-panel')
  await expect(panel).toHaveAttribute('aria-labelledby', 'memory-section-title-by-scope')
  await expect(page.locator('#memory-section-title-by-scope')).toHaveText('By Scope')
  await expect(
    page.locator('#memory-section-title-by-scope'),
    '面板标题不可程序化聚焦 ⇒ 分区切换后读屏无处可落',
  ).toHaveAttribute('tabindex', '-1')

  // ③ 深链直达一个具体分区（书签 / 聊天记录里的链接就是这种形状）。
  await openApp(page, '/memory?tab=approval-queue')
  await expect(
    page.getByTestId('memory-section-approval-queue'),
    '深链没有落到指定分区 ⇒ 别人发来的链接点开是另一屏',
  ).toHaveAttribute('aria-current', 'page')

  // ④ 未知 tab（旧书签 / 手抖 / 改过名的分区）必须**静默回落到 all 并改写 URL**，
  //    而不是显示一片空白；同时 URL 里与记忆无关的 hash 不能被顺手吃掉。
  await openApp(page, '/memory?tab=nope-not-a-tab#rfc319-keep-me')
  await expect(
    page.getByTestId('memory-section-all'),
    '未知 tab 没有回落 ⇒ 用户点开旧链接看到一屏什么都没有的页面',
  ).toHaveAttribute('aria-current', 'page')
  await expect
    .poll(() => page.url(), { timeout: 15_000 })
    .toBe(`${daemon.baseUrl}/memory?tab=all#rfc319-keep-me`)

  // ⑤ 焦点归宿：Back 把当前面板整个卸掉时，焦点必须落回「当前分区」那条链接，
  //    否则它掉到 <body>，键盘用户要从页首重新 Tab 一遍。
  //    （现状备注：`routes/memory.tsx:98,184,293` 造了个 sectionHeadingRef 一路传到
  //     h2 上，但**全仓没有任何地方调用它的 focus()**——真正兜住这条的是
  //     `PageSectionNav.tsx:419-441` 的交还逻辑。这里断的是后者。）
  await openApp(page, '/memory?tab=by-scope')
  await page.getByTestId('memory-section-all').click()
  await expect(page.getByTestId('memory-all')).toBeVisible()
  await page.getByTestId('memory-all-filter-archived').focus()
  await expect(page.getByTestId('memory-all-filter-archived')).toBeFocused()
  await page.goBack()
  await expect(page.getByTestId('memory-by-scope')).toBeVisible()
  await expect(
    page.getByTestId('memory-section-by-scope'),
    'Back 之后焦点掉出了导航 ⇒ 键盘用户被扔回页首，要重新 Tab 一整遍才能继续',
  ).toBeFocused()
})

// ---------------------------------------------------------------------------
// MEM-02 —— 新建记忆时选非 global scope，并从下拉里选中一个真实目标
// ---------------------------------------------------------------------------

test('RFC-319 MEM-02: 四个非 global 档都能从下拉选中真实目标，服务端记下的 scope 与所选一致', async ({
  page,
}) => {
  await openApp(page, '/memory')

  interface ScopeCase {
    scopeType: 'agent' | 'workflow' | 'repo_group' | 'repo'
    /** 下拉里那一项的可辨认文案；repo 档没有可用文案，见文件头的已知缺陷。 */
    optionName: RegExp | null
    expectedScopeId: () => string
    chipLabel: string
  }
  const cases: ScopeCase[] = [
    {
      scopeType: 'agent',
      optionName: new RegExp(agentName),
      expectedScopeId: () => agentId,
      chipLabel: 'Agent',
    },
    {
      scopeType: 'workflow',
      optionName: new RegExp(workflowName),
      expectedScopeId: () => workflowId,
      chipLabel: 'Workflow',
    },
    {
      scopeType: 'repo_group',
      optionName: new RegExp(repoGroupName),
      expectedScopeId: () => repoGroupId,
      chipLabel: 'Repo group',
    },
    {
      scopeType: 'repo',
      optionName: null,
      expectedScopeId: () => cachedRepoId,
      chipLabel: 'Repo',
    },
  ]

  for (const scopeCase of cases) {
    const title = `rfc319-mem02-${scopeCase.scopeType}-${++sequence}`
    await page.getByTestId('memory-new-button').click()
    const dialog = page.getByTestId('memory-new-dialog')
    await expect(dialog).toBeVisible()

    // 默认档是 global，它**没有**目标下拉——先确认这个基线，
    // 否则下面「切档之后出现下拉」证明不了是切档带来的。
    await expect(
      dialog.getByTestId('memory-form-scope-id-global'),
      'global 档也摆出目标下拉 ⇒ 用户会以为自己漏选了什么',
    ).toBeVisible()
    await expect(dialog.getByTestId('memory-form-scope-id')).toHaveCount(0)

    await dialog.getByTestId(`memory-form-scope-${scopeCase.scopeType}`).click()
    await expect(
      dialog.getByTestId('memory-form-scope-id'),
      `切到 ${scopeCase.scopeType} 档没有出现目标下拉 ⇒ 用户根本没机会指定挂在谁身上`,
    ).toBeVisible()
    await expect(
      dialog.getByTestId('memory-form-scope-id-global'),
      '切走之后还留着「(global — no target)」 ⇒ 用户以为自己建的是 global 记忆',
    ).toHaveCount(0)

    await dialog.getByTestId('memory-form-title').fill(title)
    await dialog
      .getByTestId('memory-form-body')
      .fill(`RFC-319 MEM-02 body for the ${scopeCase.scopeType} scope.`)

    // 目标没选之前 Save 必须是关着的——非 global 缺 scopeId 却放行的话，
    // 服务端要么 422（用户看到一坨原文），要么按 global 存下（更坏：静默走样）。
    await expect(
      dialog.getByTestId('memory-new-dialog-save'),
      `${scopeCase.scopeType} 档没选目标就能保存 ⇒ 记忆挂在哪儿全凭运气`,
    ).toBeDisabled()

    if (scopeCase.optionName !== null) {
      await chooseScopeTarget(page, dialog, scopeCase.optionName)
    } else {
      // repo 档：下拉行的标签因 `MemoryDialogShell.tsx:194-196` 取了 wire 上
      // 已不存在的 `url` 而全是空白（见文件头）。这里按位置选中唯一那一个镜像，
      // 并先断言「占位项 + 1 个镜像」以确保 nth(1) 无歧义。
      await dialog.getByRole('combobox', { name: 'Scope target', exact: true }).click()
      const listbox = page.getByRole('listbox', { name: 'Scope target', exact: true })
      await expect(listbox).toBeVisible()
      await expect(
        listbox.getByRole('option'),
        'repo 档下拉的行数与已导入的镜像数对不上 ⇒ 按位置选中的那一行不再确定',
      ).toHaveCount(2)
      await listbox.getByRole('option').nth(1).click()
      await expect(listbox).toHaveCount(0)
    }

    // 选中之后 Save 才放行——这条同时是上面 disabled 断言的负向对照。
    await expect(
      dialog.getByTestId('memory-new-dialog-save'),
      `${scopeCase.scopeType} 档选好目标后仍然存不下去 ⇒ 这一档等于不可用`,
    ).toBeEnabled()
    await dialog.getByTestId('memory-new-dialog-save').click()
    await expect(dialog).toHaveCount(0)

    // 建成之后页面自己翻到审批队列（`routes/memory.tsx:152-155`），
    // 新候选带着正确的 scope 标签出现在那儿。
    await expect(page.getByTestId('memory-section-approval-queue')).toHaveAttribute(
      'aria-current',
      'page',
    )
    const card = page.locator('.memory-candidate-card', { hasText: title })
    await expect(card, '新建的候选没出现在审批队列 ⇒ 用户以为自己白填了一遍表单').toBeVisible()
    await expect(
      card.locator('.memory-row__scope'),
      `候选卡片上的 scope 标签不是「${scopeCase.chipLabel}」 ⇒ 人审时看到的归属是错的`,
    ).toHaveText(scopeCase.chipLabel)

    // 服务端可核对的事实：scopeType / scopeId 与用户所选逐字节一致。
    // 这一条才是真正的判据——UI 上的标签可以是对的，写进库的却是另一回事。
    const stored = await memoryByTitle(title)
    expect(
      stored.scopeType,
      `服务端记下的 scopeType 是 ${stored.scopeType}，用户选的是 ${scopeCase.scopeType}`,
    ).toBe(scopeCase.scopeType)
    expect(
      stored.scopeId,
      '服务端记下的 scopeId 与下拉里选中的目标不一致 ⇒ 这条记忆会在别人的任务里生效',
    ).toBe(scopeCase.expectedScopeId())
  }
})

// ---------------------------------------------------------------------------
// MEM-03 —— 表单校验：不合规的输入必须在本地被拦下，一个请求都不发
// ---------------------------------------------------------------------------

test('RFC-319 MEM-03: 空/超长标题、空/超长正文、非 global 缺目标、超长标签——都在本地拦下且不发请求', async ({
  page,
}) => {
  // 判据之一是「一个 POST 都没有」：本地放行、让服务端 422 兜底的话，
  // 用户拿到的是一坨他看不懂的 zod 原文，而不是贴在字段下面的一句话。
  const creates: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/memories') {
      creates.push(r.url())
    }
  })

  await openApp(page, '/memory')
  await page.getByTestId('memory-new-button').click()
  const dialog = page.getByTestId('memory-new-dialog')
  await expect(dialog).toBeVisible()
  const save = dialog.getByTestId('memory-new-dialog-save')

  // ① 全空：标题与正文各自报各自的错。合成一句「表单不完整」的话，
  //    用户得逐个字段猜是哪一个不合规。
  await expect(save, '空表单就能提交 ⇒ 库里会出现没有标题、没有正文的记忆行').toBeDisabled()
  await expect(dialog.getByText('Title cannot be empty', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Body cannot be empty', { exact: true })).toBeVisible()

  // ② 标题超长（上限 120，输入框自己放到 130 好让越界看得见）。
  await dialog.getByTestId('memory-form-title').fill('T'.repeat(130))
  await expect(
    dialog.getByText('Title must be ≤ 120 characters', { exact: true }),
    '超长标题没被拦下 ⇒ 打到服务端才 422，用户看到的是 zod 原文',
  ).toBeVisible()
  await expect(
    dialog.getByText('Title cannot be empty', { exact: true }),
    '同一个字段同时报「为空」和「太长」 ⇒ 用户不知道该往哪个方向改',
  ).toHaveCount(0)
  await expect(save).toBeDisabled()

  // ③ 正文超长（上限 4000）。
  await dialog.getByTestId('memory-form-title').fill(`rfc319-mem03-${++sequence}`)
  await dialog.getByTestId('memory-form-body').fill('B'.repeat(4001))
  await expect(
    dialog.getByText('Body must be ≤ 4000 characters', { exact: true }),
    '超长正文没被拦下 ⇒ 同上，且正文是要被塞进 prompt 的，越界的那部分怎么处理没人知道',
  ).toBeVisible()
  await expect(save).toBeDisabled()

  // ④ 非 global 档缺目标。这一条最危险：它不是「存不下去」，
  //    而是「存到别的地方去了」——用户以为挂在某个 agent 上，实则不然。
  await dialog.getByTestId('memory-form-body').fill('RFC-319 MEM-03 body within limits.')
  await dialog.getByTestId('memory-form-scope-agent').click()
  await expect(
    dialog.getByText('Choose a scope target', { exact: true }),
    '非 global 档缺目标却没有提示 ⇒ 用户不知道自己还差一步',
  ).toBeVisible()
  await expect(save).toBeDisabled()

  // ⑤ 标签超长：ChipsInput 自己的 validate 先拦（`MemoryFormFields.tsx:174-182`），
  //    所以这条错落在输入框下面，且**这个标签根本没被加进去**。
  //    （如实记：`validateMemoryForm` 里的 errTagTooLong / errTagsTooMany 两支
  //     在 UI 上够不到——ChipsInput 先把越界 token 挡在 commit 之前，
  //     那两支只对以编程方式塞进 state 的情形生效。这里锁的是用户真能碰到的那一层。）
  const tagInput = dialog.getByTestId('memory-form-tag-input')
  await tagInput.fill('t'.repeat(41))
  await tagInput.press('Enter')
  await expect(
    dialog.locator('.chips-input__error'),
    '超长标签被静默吃掉 ⇒ 用户以为加上了，回头在筛选里怎么也找不到',
  ).toHaveText('Each tag must be ≤ 40 characters')
  await expect(dialog.locator('.chip'), '越界的标签仍然被加成了 chip ⇒ 提示只是摆设').toHaveCount(0)

  // 到此为止一个请求都不该发出去。
  expect(
    creates,
    '不合规的表单已经把创建请求发出去了 ⇒ 本地校验只是装饰，真正的门在服务端',
  ).toEqual([])

  // ⑥ 负向对照：把每一处都改合规之后，Save 放行、请求真的发出去、记忆真的建成。
  //    没有这一条，上面五条可能只是「这个按钮从来就点不动」。
  const okTitle = `rfc319-mem03-ok-${++sequence}`
  await tagInput.fill('rfc319-ok-tag')
  await tagInput.press('Enter')
  await expect(dialog.locator('.chip')).toHaveCount(1)
  await dialog.getByTestId('memory-form-title').fill(okTitle)
  await chooseScopeTarget(page, dialog, new RegExp(agentName))
  await expect(save, '所有字段都合规了却还是存不下去 ⇒ 上面五条拒绝证明不了针对性').toBeEnabled()
  await save.click()
  await expect(dialog).toHaveCount(0)
  expect(creates, '合规提交没有发出创建请求').toHaveLength(1)
  const stored = await memoryByTitle(okTitle)
  expect(stored.scopeType).toBe('agent')
  expect(stored.scopeId).toBe(agentId)
  expect(stored.tags, '通过校验的标签没有写进服务端').toEqual(['rfc319-ok-tag'])
})

// ---------------------------------------------------------------------------
// MEM-20 —— 按 scope 浏览：五档齐全 + 计数与服务端一致 + 空档有空态 + 行内可编辑
// ---------------------------------------------------------------------------

test('RFC-319 MEM-20: 按 scope 浏览的五档计数与服务端逐档一致，空档给空态，行内编辑改得动', async ({
  page,
}) => {
  // 每一档都放一条已批准的记忆（repo 档**故意留空**，用来证明空态那一支）。
  const seeded = {
    agent: `rfc319-mem20-agent-${++sequence}`,
    workflow: `rfc319-mem20-workflow-${++sequence}`,
    repo_group: `rfc319-mem20-group-${++sequence}`,
    global: `rfc319-mem20-global-${++sequence}`,
  }
  await seedMemory('agent', agentId, seeded.agent, 'RFC-319 MEM-20 agent body.', true)
  await seedMemory('workflow', workflowId, seeded.workflow, 'RFC-319 MEM-20 workflow body.', true)
  await seedMemory('repo_group', repoGroupId, seeded.repo_group, 'RFC-319 MEM-20 group body.', true)
  await seedMemory('global', null, seeded.global, 'RFC-319 MEM-20 global body.', true)

  // 服务端的分档真值——UI 的计数拿它对账，而不是拿测试里数出来的数字对账：
  // 前面几条用例也往库里写过东西，硬编码期望值会在下一次改动里悄悄失真。
  const approved = (await api<{ items: MemoryWire[] }>('/api/memories?status=approved')).items
  const expectedCounts: Record<string, number> = {
    agent: 0,
    workflow: 0,
    repo: 0,
    repo_group: 0,
    global: 0,
  }
  for (const row of approved)
    expectedCounts[row.scopeType] = (expectedCounts[row.scopeType] ?? 0) + 1
  expect(
    expectedCounts.repo,
    'repo 档已经有已批准记忆了 ⇒ 本用例的「空档」样本没了（MEM-02 只建候选、不批准）',
  ).toBe(0)
  expect(
    Object.values(expectedCounts).filter((n) => n > 0).length,
    '没有任何一档是非空的 ⇒ 下面的「有列表」那一支证明不了什么',
  ).toBeGreaterThan(0)

  await openApp(page, '/memory?tab=by-scope')

  // 五档必须**全部**在场且顺序固定（`lib/memory.ts:125-131`）。少一档的后果是
  // RFC-248 真撞过的：用户在新表单里建出来的组记忆，在它自己那一档下永远看不到。
  const labels: Record<string, string> = {
    agent: 'Agent',
    workflow: 'Workflow',
    repo: 'Repo',
    repo_group: 'Repo group',
    global: 'Global',
  }
  const order = ['agent', 'workflow', 'repo', 'repo_group', 'global']
  await expect(
    page.locator('.memory-by-scope__section'),
    '按 scope 浏览少了一档 ⇒ 那一档的记忆在这个页面上永远找不到',
  ).toHaveCount(order.length)
  for (const [index, scope] of order.entries()) {
    const section = page.locator('.memory-by-scope__section').nth(index)
    await expect(
      section,
      `第 ${index + 1} 档不是 ${scope} ⇒ 分档顺序漂了，用户的肌肉记忆全失效`,
    ).toHaveAttribute('data-scope', scope)

    const n = expectedCounts[scope] ?? 0
    await expect(
      section.locator('.memory-by-scope__heading'),
      `${scope} 档的计数与服务端对不上 ⇒ 这是个数字，错了没有任何症状，只会让人按错的量做判断`,
    ).toHaveText(`${labels[scope]} (${n})`)

    if (n === 0) {
      await expect(
        section.locator('.empty-state'),
        `${scope} 档为空却没有空态 ⇒ 一片留白，用户分不清是没有还是没加载出来`,
      ).toBeVisible()
      await expect(
        section.locator('li.memory-row'),
        `${scope} 档的计数是 0 却仍渲染出了行 ⇒ 计数与内容互相矛盾`,
      ).toHaveCount(0)
    } else {
      await expect(
        section.locator('li.memory-row'),
        `${scope} 档渲染出的行数与它自己标出的计数不一致 ⇒ 标题上的数字是假的`,
      ).toHaveCount(n)
      await expect(
        section.locator('.empty-state'),
        `${scope} 档明明有行还摆着空态 ⇒ 页面自相矛盾`,
      ).toHaveCount(0)
    }
  }
  // 刚种下的四条各自落在自己那一档里——只对总数不对内容的话，
  // 分档函数把所有行都塞进同一个桶也能过。
  for (const [scope, title] of Object.entries(seeded)) {
    await expect(
      page.locator(`.memory-by-scope__section[data-scope="${scope}"]`),
      `${scope} 档里找不到刚建在它上面的记忆 ⇒ 分档把行放错了桶`,
    ).toContainText(title)
  }

  // 行内编辑：这个页面上的 [Edit] 必须真的能改到那一行。
  const globalSection = page.locator('.memory-by-scope__section[data-scope="global"]')
  const targetRow = globalSection.locator('li.memory-row', { hasText: seeded.global })
  const before = await memoryByTitle(seeded.global)
  expect(before.version, '新批准的记忆初始 version 不是 1 ⇒ 下面的 +1 断言失去基线').toBe(1)

  await targetRow.getByRole('button', { name: 'Edit', exact: true }).click()
  const editDialog = page.getByTestId('memory-edit-dialog')
  await expect(editDialog).toBeVisible()
  await expect(
    editDialog.getByTestId('memory-form-title'),
    '编辑弹窗没有把当前内容填进去 ⇒ 用户一保存就把原文清空了',
  ).toHaveValue(seeded.global)

  const renamed = `${seeded.global}-renamed`
  await editDialog.getByTestId('memory-form-title').fill(renamed)
  await editDialog.getByTestId('memory-edit-dialog-save').click()
  await expect(editDialog).toHaveCount(0)
  await expect(
    globalSection,
    '保存之后列表还显示旧标题 ⇒ 用户会以为没保存成功，然后再改一遍',
  ).toContainText(renamed)

  const after = await memoryOf(before.id)
  expect(after.memory.title, '界面显示改好了，服务端存的还是旧标题').toBe(renamed)
  expect(after.memory.version, '真的改了内容却没有涨 version ⇒ 审计里看不出这一行被人动过').toBe(
    before.version + 1,
  )
})

// ---------------------------------------------------------------------------
// MEM-06 —— 编辑弹窗自己拉详情：拉不到时给得出重试，且**不摆出 Save**
// ---------------------------------------------------------------------------

test('RFC-319 MEM-06: 编辑弹窗的详情拉不到时只给错误与重试，绝不摆出一个能写空值的保存按钮', async ({
  page,
}) => {
  const title = `rfc319-mem06-${++sequence}`
  const memoryId = await seedMemory('global', null, title, 'RFC-319 MEM-06 body.', true)

  // 列表只回 summary（没有 bodyMd），所以弹窗必须自己去拉 detail——
  // 这一跳失败时如果照常渲染表单，用户会对着一个空表单点保存。
  const fault: Fault = { armed: true }
  await injectOutage(page, (url) => url.pathname === `/api/memories/${memoryId}`, fault)

  await openApp(page, '/memory')
  const row = page.locator(`[data-testid="memory-row-${memoryId}"]`)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()

  const dialog = page.getByTestId('memory-edit-dialog')
  await expect(
    dialog,
    '详情拉不到就连弹窗都不开 ⇒ 用户点了 [Edit] 什么都没发生，只会再点几次',
  ).toBeVisible()
  await expect(
    dialog.locator('.error-box'),
    '详情拉失败却没有任何提示 ⇒ 用户面对一个空表单，不知道是没数据还是没加载出来',
  ).toBeVisible()
  await expect(
    dialog.getByTestId('memory-edit-dialog-save'),
    '详情都没拉到还摆着保存按钮 ⇒ 一点就把空表单的内容写回这条记忆',
  ).toHaveCount(0)
  await expect(
    dialog.getByTestId('memory-form-title'),
    '错误态与表单同时在场 ⇒ 用户分不清眼前这份内容是真的还是残留的',
  ).toHaveCount(0)

  // 重试入口必须在弹窗里就给出来——否则一次瞬时失败要靠整页刷新才能恢复，
  // 而用户根本不知道该刷新。
  const retry = dialog.locator('.error-box').getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()

  fault.armed = false
  await retry.click()
  await expect(
    dialog.getByTestId('memory-form-title'),
    '重试成功了表单还是不出来 ⇒ 重试按钮是个摆设',
  ).toHaveValue(title)
  await expect(
    dialog.locator('.error-box'),
    '重试成功了报错还赖着不走 ⇒ 用户无从判断眼前的表单能不能信',
  ).toHaveCount(0)
  await expect(
    dialog.getByTestId('memory-edit-dialog-save'),
    '详情回来了保存按钮却没回来 ⇒ 这条记忆从此改不动',
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// MEM-07 —— 打开看了看又关掉：不发 PATCH，version 不动
// ---------------------------------------------------------------------------

test('RFC-319 MEM-07: 编辑弹窗里什么都没改就保存 —— 不发 PATCH、version 不动，改一个字才发', async ({
  page,
}) => {
  const title = `rfc319-mem07-${++sequence}`
  const memoryId = await seedMemory('global', null, title, 'RFC-319 MEM-07 body.', true)
  const before = await memoryOf(memoryId)
  expect(before.memory.version, '基线 version 不是 1 ⇒ 后面的「没涨」证明不了什么').toBe(1)

  const patches: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/memories/${memoryId}`) {
      patches.push(r.url())
    }
  })

  await openApp(page, '/memory')
  const row = page.locator(`[data-testid="memory-row-${memoryId}"]`)
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  const dialog = page.getByTestId('memory-edit-dialog')
  await expect(dialog.getByTestId('memory-form-title')).toHaveValue(title)

  // 一个字都没改就点保存。
  await dialog.getByTestId('memory-edit-dialog-save').click()
  await expect(dialog, '无改动保存之后弹窗没关 ⇒ 用户以为保存卡住了，会再点几次').toHaveCount(0)
  expect(
    patches,
    '什么都没改也发了 PATCH ⇒ 每次「打开看看又关掉」都顶高一格 version，审计里全是空版本',
  ).toEqual([])

  const untouched = await memoryOf(memoryId)
  expect(
    untouched.memory.version,
    '无改动的一次保存把 version 顶高了 ⇒ 服务端也认为这行被改过',
  ).toBe(before.memory.version)
  expect(untouched.memory.title, '无改动的一次保存改掉了标题').toBe(title)

  // 负向对照：真改一个字就必须发 PATCH 且 version +1。
  // 否则上面那条可能只是「这个保存按钮从来就不发请求」。
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(dialog.getByTestId('memory-form-title')).toHaveValue(title)
  await dialog.getByTestId('memory-form-body').fill('RFC-319 MEM-07 body, edited once.')
  await dialog.getByTestId('memory-edit-dialog-save').click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => patches.length, { timeout: 15_000 }).toBe(1)
  const edited = await memoryOf(memoryId)
  expect(edited.memory.version, '真的改了内容却没有涨 version').toBe(before.memory.version + 1)
  expect(edited.memory.bodyMd).toBe('RFC-319 MEM-07 body, edited once.')
})

// ---------------------------------------------------------------------------
// MEM-11 —— 冲突候选：并排对比 + 「批准并取代」接上 supersede 链
// ---------------------------------------------------------------------------

test('RFC-319 MEM-11: 冲突候选能并排对比，「批准并取代」之后旧条目退出可用面并接上 supersede 链', async ({
  page,
}) => {
  const existingTitle = `rfc319-mem11-existing-${++sequence}`
  const existingBody = 'Always rebase onto origin/main before pushing.'
  const candidateTitle = `rfc319-mem11-candidate-${++sequence}`
  const candidateBody = 'Never rebase a shared branch; merge origin/main instead.'
  const existingId = await seedMemory('global', null, existingTitle, existingBody, true)
  const candidateId = await seedMemory('global', null, candidateTitle, candidateBody, false)

  // 冲突标注（distillAction='conflict_with' + supersedesId）**只能由蒸馏产出**：
  // 手工建的行恒置这两个字段为 null（`services/memory.ts:170-171,191-192`），
  // 公开 API 上没有任何写入口。所以这里只改写审批队列那一次读的**标注字段**，
  // 让 UI 走进冲突分支；随后的 promote 走真实服务端，四条不变量也在服务端核对。
  await page.route(
    (url) =>
      url.pathname === '/api/memories' &&
      url.searchParams.get('status') === 'candidate' &&
      url.searchParams.get('include') === 'body',
    async (route) => {
      const response = await route.fetch()
      const payload = (await response.json()) as {
        items: Array<{ id: string; distillAction: string | null; supersedesId: string | null }>
      }
      for (const item of payload.items) {
        if (item.id === candidateId) {
          item.distillAction = 'conflict_with'
          item.supersedesId = existingId
        }
      }
      await route.fulfill({ response, json: payload })
    },
  )

  // 前提对照：旧条目此刻确实在「全部已批准」面上。没有这一条，
  // 后面「它消失了」可能只是它本来就没出现过。
  await openApp(page, '/memory')
  await expect(
    page.getByTestId('memory-all-list'),
    '旧条目本来就不在已批准列表里 ⇒ 后面的「退出可用面」证明不了任何东西',
  ).toContainText(existingTitle)

  await page.getByTestId('memory-section-approval-queue').click()
  const card = page.locator('.memory-candidate-card', { hasText: candidateTitle })
  await expect(card).toBeVisible()
  await expect(
    card,
    '冲突候选没有标出它和谁冲突 ⇒ 人审看不出这是个二选一，会直接点「批准」，两条互相矛盾的记忆一起进注入面',
  ).toContainText(`Conflicts with ${existingId}`)

  await expect(
    card.getByTestId(`memory-candidate-${candidateId}-compare`),
    '冲突候选没有对比入口 ⇒ 人审只能靠 id 自己去翻旧条目',
  ).toBeVisible()
  // 负向对照：队列里其它候选（前面几条用例建的，都没有冲突标注）**不许**长出
  // 对比按钮。给每张卡片都挂一个「对比」的话，人审会以为每条都在跟什么东西冲突，
  // 这个入口从此被无视——真正的冲突也就跟着被无视了。
  await expect(
    page.locator('.memory-candidate-card'),
    '队列里只有一张候选卡片 ⇒ 「只有冲突候选才有对比按钮」这条对照没有样本',
  ).not.toHaveCount(1)
  await expect(
    page.locator('.memory-approval-queue [data-testid$="-compare"]'),
    '没有冲突标注的候选也长出了对比按钮 ⇒ 这个入口失去指示意义',
  ).toHaveCount(1)
  await card.getByTestId(`memory-candidate-${candidateId}-compare`).click()

  const compare = page.getByTestId('memory-conflict-compare-dialog')
  await expect(compare).toBeVisible()
  // 左右两栏各是各的：栏位串了的话，人审是照着**反过来**的内容做的取舍。
  await expect(
    compare.getByTestId('memory-compare-existing'),
    '「现有记忆」那一栏没有显示旧条目的正文 ⇒ 人审在没有对照的情况下做取舍',
  ).toContainText(existingBody)
  await expect(compare.getByTestId('memory-compare-existing')).toContainText(existingTitle)
  await expect(
    compare.getByTestId('memory-compare-candidate'),
    '「候选」那一栏没有显示候选正文 ⇒ 同上',
  ).toContainText(candidateBody)
  await expect(
    compare.getByTestId('memory-compare-existing'),
    '左右两栏串了 ⇒ 人审看到的对照关系是反的，取舍必然做反',
  ).not.toContainText(candidateBody)

  await compare.getByTestId('memory-compare-approve-supersede').click()
  await expect(
    compare,
    '取代之后对话框没关 ⇒ 用户以为没生效，会再点一次（第二次必然 409）',
  ).toHaveCount(0)

  // 服务端可核对的四条不变量（`services/memory.ts:365-425`）。
  // 少任何一条，新旧两条都会同时留在 approved 面上，往后每次注入都把
  // 互相矛盾的两条一起塞进 prompt。
  const promoted = await memoryOf(candidateId)
  expect(promoted.memory.status, '「批准并取代」之后候选没有进入 approved').toBe('approved')
  expect(
    promoted.memory.supersedesId,
    '新条目没有记下它取代了谁 ⇒ 追溯链断了，没人知道这条是从哪儿演化来的',
  ).toBe(existingId)
  expect(
    promoted.memory.version,
    '取代者的 version 不是「被取代者 + 1」 ⇒ 版本序列断档，看不出演化顺序',
  ).toBe(2)
  expect(
    promoted.ancestors.map((row) => row.id),
    '详情里的祖先链不含被取代的旧条目 ⇒ UI 上追溯不到上一版',
  ).toContain(existingId)

  const superseded = await memoryOf(existingId)
  expect(
    superseded.memory.status,
    '旧条目仍是 approved ⇒ 它会继续被注入，和新条目一起给出互相矛盾的指令',
  ).toBe('superseded')
  expect(superseded.memory.supersededById, '旧条目没记下是谁取代了它 ⇒ 反向追溯断了').toBe(
    candidateId,
  )

  // 用户可见的后果：候选离开审批队列，新条目进入已批准面，旧条目退出。
  await expect(
    page.locator('.memory-candidate-card', { hasText: candidateTitle }),
    '已经批准过的候选还赖在审批队列里 ⇒ 人审会对着同一条反复处理',
  ).toHaveCount(0)
  await page.getByTestId('memory-section-all').click()
  await expect(page.getByTestId('memory-all-list')).toContainText(candidateTitle)
  await expect(
    page.getByTestId('memory-all-list'),
    '被取代的旧条目还留在「全部已批准」里 ⇒ 用户以为它仍然生效',
  ).not.toContainText(existingTitle)
})

// ---------------------------------------------------------------------------
// MEM-12 —— 审批失败：横幅必须出来，卡片必须留住，服务端状态必须没动
// ---------------------------------------------------------------------------

test('RFC-319 MEM-12: 批准失败时页面把失败摆出来，候选留在原地，服务端状态一动不动', async ({
  page,
}) => {
  const title = `rfc319-mem12-${++sequence}`
  const memoryId = await seedMemory('global', null, title, 'RFC-319 MEM-12 body.', false)

  const fault: Fault = { armed: true }
  await injectOutage(page, (url) => url.pathname === `/api/memories/${memoryId}/promote`, fault)

  await openApp(page, '/memory?tab=approval-queue')
  const card = page.locator('.memory-candidate-card', { hasText: title })
  await expect(card).toBeVisible()
  await card.getByTestId(`memory-candidate-${memoryId}-approve`).click()

  await expect(
    page.getByTestId('memory-approve-error'),
    '批准失败却什么都不说 ⇒ 用户点了没反应，只会再点一次、再点一次，真正的原因只留在服务端',
  ).toBeVisible()
  await expect(
    card,
    '批准失败了卡片却先行消失 ⇒ 用户以为处理完了，这条候选从此没人再看一眼',
  ).toBeVisible()
  await expect(
    page.getByTestId('memory-approval-queue-empty'),
    '失败之后队列显示成空 ⇒ 「都处理完了」和「一条都没提交成功」在界面上长得一样',
  ).toHaveCount(0)

  // 服务端可核对的事实：这一行一点没动。
  const stillCandidate = await memoryOf(memoryId)
  expect(
    stillCandidate.memory.status,
    '请求失败了服务端却已经把它批准了 ⇒ 界面报错、库里已改，两边说法不一致',
  ).toBe('candidate')

  // 负向对照：故障撤掉后同一个按钮必须真的能批准，且横幅消失。
  fault.armed = false
  await card.getByTestId(`memory-candidate-${memoryId}-approve`).click()
  await expect(
    page.getByTestId('memory-approve-error'),
    '重试成功了错误横幅还赖着不走 ⇒ 用户不知道这次到底成没成',
  ).toHaveCount(0)
  await expect(
    page.locator('.memory-candidate-card', { hasText: title }),
    '批准成功了卡片却还在队列里 ⇒ 人审会对着同一条反复处理',
  ).toHaveCount(0)
  const approved = await memoryOf(memoryId)
  expect(approved.memory.status, '撤掉故障之后仍然批不动 ⇒ 上面那条失败断言证明不了针对性').toBe(
    'approved',
  )
})

// ---------------------------------------------------------------------------
// MEM-X6 —— 各记忆面板的加载失败：错误 ≠ 空态，重试要有，已有数据不许被清空
//
// 记忆页一共六个面板。本用例覆盖其中五个：
//   审批队列 / 全部已批准 / 全部已归档 / 按 scope 浏览 / 蒸馏任务。
// 第六个「融合」的空态-错误态互斥与重试已由 e2e/fusion-review-surface.spec.ts:285
// 锁住（`memory-fusion-error` / `memory-fusion-empty`），这里不重复。
// ---------------------------------------------------------------------------

test('RFC-319 MEM-X6: 五个记忆面板拉取失败时都给错误 + 重试，绝不冒充空态；重试成功后恢复原样', async ({
  page,
}) => {
  // 「已归档」那一档要有东西可看，才谈得上「失败时它没了」。
  const archivedTitle = `rfc319-x6-archived-${++sequence}`
  const archivedId = await seedMemory(
    'global',
    null,
    archivedTitle,
    'RFC-319 MEM-X6 archived row.',
    true,
  )
  await api(`/api/memories/${archivedId}/archive`, { method: 'POST' })

  // 蒸馏任务面板在这台 daemon 上**正常态就是空态**（没跑过任何任务），
  // 所以它的「healthy」就是那句空态文案——这条同时把「错误不许冒充空态」钉死。
  expect(
    (await api<{ items: unknown[] }>('/api/memory-distill-jobs')).items,
    '这台 daemon 上出现了蒸馏任务 ⇒ 蒸馏面板的 healthy 判据（空态文案）失效',
  ).toHaveLength(0)

  // 每个面板一条：`path` 是深链，`prepare` 是进入该面板还需要的那一下点击，
  // `healthy` 是「正常时必须看得见的那个东西」，`matcher` 是这个面板自己那一次读
  // （不能连累别人的读）。
  const panels: Array<{
    name: string
    path: string
    prepare?: (p: Page) => Promise<void>
    healthy: (p: Page) => Locator
    matcher: (url: URL) => boolean
    /** 错误态下必须**不在场**的空态——用来钉死「错误不许冒充空」。 */
    forbiddenOnError?: (p: Page) => Locator
  }> = [
    {
      name: '审批队列',
      path: '/memory?tab=approval-queue',
      healthy: (p) => p.getByTestId('memory-approval-queue'),
      matcher: memoryListMatcher('candidate', 'body'),
      forbiddenOnError: (p) => p.getByTestId('memory-approval-queue-empty'),
    },
    {
      name: '全部已批准',
      path: '/memory?tab=all',
      healthy: (p) => p.getByTestId('memory-all-list'),
      matcher: memoryListMatcher('approved'),
      forbiddenOnError: (p) =>
        p.getByText('No approved memories in the library yet', { exact: true }),
    },
    {
      name: '全部已归档',
      path: '/memory?tab=all',
      // 归档档是分段控件切出来的，不是独立路由——每次 goto / reload 之后都要再切一次。
      prepare: async (p) => {
        await p.getByTestId('memory-all-filter-archived').click()
      },
      healthy: (p) => p.getByTestId('memory-all-list'),
      matcher: memoryListMatcher('archived'),
      forbiddenOnError: (p) => p.getByText('No archived memories', { exact: true }),
    },
    {
      name: '按 scope 浏览',
      path: '/memory?tab=by-scope',
      healthy: (p) => p.getByTestId('memory-by-scope'),
      matcher: memoryListMatcher('approved'),
      forbiddenOnError: (p) => p.getByText('No memories in this scope').first(),
    },
    {
      name: '蒸馏任务',
      path: '/memory?tab=distill-jobs',
      healthy: (p) =>
        p.getByTestId('memory-section-panel').getByText('No distill jobs queued', { exact: true }),
      matcher: (url) => url.pathname === '/api/memory-distill-jobs',
    },
  ]

  for (const panel of panels) {
    const fault: Fault = { armed: false }
    const scoped = await page.context().newPage()
    try {
      await injectOutage(scoped, panel.matcher, fault)

      // ① 正常态基线。没有它，「错误态下它不在场」可能只是它本来就从不出现。
      await scoped.addInitScript(
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
      await scoped.goto(`${daemon.baseUrl}${panel.path}`)
      await expect(scoped.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
      if (panel.prepare !== undefined) await panel.prepare(scoped)
      await expect(
        panel.healthy(scoped),
        `${panel.name}：正常态下都看不到内容 ⇒ 这个面板的基线就是坏的`,
      ).toBeVisible({ timeout: 30_000 })

      // ② armed + 重新进入 ⇒ 错误横幅 + 重试按钮；正常内容与空态都必须让位。
      fault.armed = true
      await scoped.reload()
      await expect(scoped.getByTestId('memory-section-panel')).toBeVisible({ timeout: 30_000 })
      if (panel.prepare !== undefined) await panel.prepare(scoped)
      const errorBox = panelError(scoped)
      await expect(
        errorBox,
        `${panel.name}：拉取失败连一句提示都没有 ⇒ 用户看到一片空白，以为「没有数据」`,
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        panel.healthy(scoped),
        `${panel.name}：拉取失败了却照常渲染内容 ⇒ 用户照着一份来路不明的数据做判断`,
      ).toHaveCount(0)
      if (panel.forbiddenOnError !== undefined) {
        await expect(
          panel.forbiddenOnError(scoped),
          `${panel.name}：拉取失败时显示的是空态 ⇒ 「都处理完了」和「拉不到」长得一样，等着人审的东西从此消失在视野里`,
        ).toHaveCount(0)
      }
      const retry = errorBox.getByRole('button', { name: 'Retry', exact: true }).first()
      await expect(
        retry,
        `${panel.name}：错误态没有重试入口 ⇒ 一次瞬时失败要靠整页刷新才能恢复，而用户不知道该刷新`,
      ).toBeVisible()

      // ③ 撤掉故障后点重试 ⇒ 内容回来、横幅走人。
      fault.armed = false
      await retry.click()
      await expect(
        panel.healthy(scoped),
        `${panel.name}：重试之后内容没回来 ⇒ 重试按钮是个摆设`,
      ).toBeVisible()
      await expect(
        errorBox,
        `${panel.name}：重试成功了报错还赖着不走 ⇒ 用户无从判断眼前的是新数据还是残留的错误`,
      ).toHaveCount(0)
    } finally {
      await scoped.close()
    }
  }
})

test('RFC-319 MEM-X6: 已经加载出来的行不会被一次失败的后台刷新清空——错误横幅与列表同时在场', async ({
  page,
}) => {
  // 这一条锁的是 `MemoryAllList.tsx:329-339`：拿到过数据之后再失败，
  // 横幅走 FeedbackStack 与行**并列**，而不是把行整片换掉。
  // 反过来（失败就清空）意味着用户翻着列表，后台一次抖动就让整页内容凭空消失。
  const victimTitle = `rfc319-x6-keepalive-${++sequence}`
  const victimId = await seedMemory(
    'global',
    null,
    victimTitle,
    'RFC-319 MEM-X6 keep-alive row.',
    true,
  )

  const fault: Fault = { armed: false }
  await injectOutage(page, memoryListMatcher('approved'), fault)
  await openApp(page, '/memory?tab=all')
  const list = page.getByTestId('memory-all-list')
  await expect(list).toBeVisible()
  await expect(list).toContainText(victimTitle)
  const rowsBefore = await list.locator('li.memory-row').count()
  expect(rowsBefore, '列表本来就是空的 ⇒ 「行没被清空」证明不了任何东西').toBeGreaterThan(0)

  // 触发后台重取的是**一次成功的行内操作**（归档 → onSuccess 里 invalidate
  // ['memories','all']，`MemoryAllList.tsx:84-90`）：写成功了、紧接着的那一次
  // 重取失败。这正是「用户刚做完一个动作，页面却整片空掉」的形态。
  // 刻意不用 WS 事件当触发源——那样这条用例会依赖 socket 建连早于本行代码。
  fault.armed = true
  await page.getByTestId(`memory-all-${victimId}-archive`).click()
  await expect(page.getByTestId('memory-confirm-dialog')).toBeVisible()
  await page.getByTestId('memory-confirm-ok').click()
  await expect(
    page.getByTestId('memory-confirm-dialog'),
    '归档明明成功了确认框还不关 ⇒ 用户以为卡住了，会再点一次',
  ).toHaveCount(0)
  expect(
    (await memoryOf(victimId)).memory.status,
    '归档请求没有真的落到服务端 ⇒ 后面的「重取失败」不是发生在一次成功写入之后',
  ).toBe('archived')

  await expect(
    panelError(page),
    '后台刷新失败却一声不吭 ⇒ 用户不知道眼前这份列表已经是旧的了',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    list,
    '一次失败的后台刷新把已经加载出来的行整片清空了 ⇒ 用户翻着列表，内容凭空消失',
  ).toBeVisible()
  expect(
    await list.locator('li.memory-row').count(),
    '后台刷新失败后行数变了 ⇒ 缓存被半清空，用户看到的是残缺的一份',
  ).toBe(rowsBefore)
  await expect(
    page.getByText('No approved memories in the library yet', { exact: true }),
    '后台刷新失败之后页面翻成了空态 ⇒ 用户以为自己的记忆全没了',
  ).toHaveCount(0)
})
