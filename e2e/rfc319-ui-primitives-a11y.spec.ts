// RFC-319 —— 前端**公共原语**的键盘 / 可访问性契约（UX-13 / 14b / 15 / 16 / 17 / 20 / X3 / X7）。
//
// 这一批与其他 RFC-319 spec 的性质不同：被测对象不是某一个页面的业务规则，而是
// `packages/frontend/src/components/` 里那几个被**上百处**复用的原语——Dialog /
// Select / MultiSelect / ChipsInput / TabBar / Segmented / Pagination / FilterBar /
// ManagedLiveRegion。它们坏掉时不会有任何一个页面报错，只会让整个产品的键盘用户
// 与读屏用户同时失去一类能力，而且**没有任何一条既有断言会红**。
//
// 因此全文遵守一条硬规矩：**只在真实产品路径上覆盖**，绝不为测试造 demo 页面。
// 每条用例都先走到产品里真正用到那个原语的地方（/memory 的新建记忆弹窗、/users 的
// 新建用户弹窗、/events 的投递审计、/workflows/$id 的节点选择器、/agents/new 的技能
// 选择器），再在那里断言原语的契约。原语退化时红的是这些页面，正好是用户遭遇它的地方。
//
// 全部是 P2 / P3，所以每条标题都带 ` @nightly`——PR 腿按
// `.github/workflows/e2e-full-nightly.yml` 的 `--grep-invert` 把它们排除掉。
//
// ## 为什么这些断言写成这个形状（每条都对着一个「改坏了会怎样」）
//
//   * **UX-13** —— 遮罩点按是弹窗最常用的关闭手势；body 滚动锁没了，用户在弹窗里
//     滚滚轮会把**背后的页面**滚走，关掉弹窗后发现自己不知道滚到哪去了。
//     `dismissDisabled` 是事务期的保险丝：创建用户的 POST 还在飞时若能按 ESC 关掉
//     弹窗，用户会以为自己取消了，实际账号照建不误。
//     所以断言落在 `document.body` 的**实际样式**上，而不是「弹窗可见」——后者在
//     滚动锁被整段删掉时同样成立。
//   * **UX-14b** —— `.segmented` 是 radiogroup，radiogroup 在整个页面的 Tab 序列里
//     只能占**一个**停靠点（WAI-ARIA roving tabindex）。全仓 e2e 此前对 `tabindex`
//     **零断言**：把 `tabIndex={opt.value === tabStopValue ? 0 : -1}` 改成常量 0
//     一条用例都不会红，而键盘用户会发现每多一个选项就要多按一次 Tab。
//     所以这里**逐字断言 tabindex 的值**，并且额外证明「从选中项按 Tab 会离开这个组」。
//   * **UX-15** —— `<Select>` 是自绘下拉：原生 `<select>` 的键盘行为一条都不白送，
//     全靠 `onListKey` 里那几十行。type-ahead（首字母跳转）尤其脆——它只在
//     `!searchable` 时挂着（Select.tsx:373），选项数一过 8 就自动换成搜索框。
//     断言的终点是**列表真的被筛掉了**，不是「高亮换了一行」。
//   * **UX-16** —— TabBar 同样是 roving tabindex，外加一层溢出滚动：窄容器里
//     `.tabs-viewport` 要长出两个 44px 的翻页键，并且在 `prefers-reduced-motion`
//     下**立即**滚动而不是做 300ms 动画。后半条是本文件唯一一处「必须同步读」的
//     断言：点击与读值放在同一个 `page.evaluate` 里，`behavior:'smooth'` 会当场红。
//   * **UX-17** —— ChipsInput / MultiSelect 是「自由文本 → 结构化数组」的唯一入口。
//     去重与校验若失效，用户能把同一个 tag 加两遍、把 200 字的句子当 tag 存进去，
//     而错误提示是它们唯一的反馈通道。
//   * **UX-20** —— 托管播报区是读屏用户**唯一**能听见「刚才发生了什么」的地方。
//     断言的是它的 textContent **真的变了**（一次操作 → poll 那段文字），
//     而不是「region 存在」——后者在 `announce()` 调用被删光后照样成立。
//   * **UX-X3** —— 44px 是触摸目标的下限（RFC-198）。它整个是一条 CSS 规则
//     （styles.css `@media (max-width: 720px)` 里那一族 `min-height: 44px`），
//     删掉它没有任何测试会红。同时断言「交互控件不撑出横向滚动」，因为把控件
//     加宽到 44px 最省事的坏法就是让页面横滚。
//   * **UX-X7** —— Pagination / FilterBar 两个原语在全仓 e2e 里**从未被真机点过**
//     （`grep -rn "<Pagination" e2e/` 零命中）。这里在投递审计这条真实产品路径上
//     把「翻页 / 跳页 / 筛选 / 清除筛选」四件事各走一遍，终点一律是**服务端数据**
//     （总数与行数），不是控件自己的显示。
//
// ## 判据锚点（纯文本引用，禁 GitHub 外链——外链会被 CI 的 markdown link check
// ## 逐条请求，见 CLAUDE.md §opencode 源码自取规则）
//
//   packages/frontend/src/components/Dialog.tsx:99-123      body 滚动锁的共享计数与还原
//   packages/frontend/src/components/Dialog.tsx:190-193     open ⇒ 取锁；关闭 ⇒ 释放
//   packages/frontend/src/components/Dialog.tsx:400-404     遮罩 mousedown 且 target===遮罩本身才关
//   packages/frontend/src/components/Dialog.tsx:211-230     ESC：dismissDisabled 时整条监听不挂
//   packages/frontend/src/components/Dialog.tsx:423-431     × 键的 disabled 跟着 dismissDisabled
//   packages/frontend/src/components/users/CreateUserDialog.tsx:52  busy ⇒ dismissDisabled
//   packages/frontend/src/components/Segmented.tsx:95-98     tabStopValue：选中项（或首个可用项）
//   packages/frontend/src/components/Segmented.tsx:162       tabIndex = 0 / -1 的唯一来源
//   packages/frontend/src/components/Segmented.tsx:100-137   方向键换选中项并搬走焦点
//   packages/frontend/src/components/Select.tsx:195          searchable 默认阈值 = 8 个选项
//   packages/frontend/src/components/Select.tsx:308-405      listbox 的键盘状态机（↑↓/Home/End/Enter/type-ahead）
//   packages/frontend/src/components/Select.tsx:373-403      type-ahead：只在 !searchable 时存在
//   packages/frontend/src/components/Select.tsx:407-410      aria-activedescendant 的计算
//   packages/frontend/src/components/TabBar.tsx:378          tabIndex = 0 / -1 的唯一来源
//   packages/frontend/src/components/TabBar.tsx:264-316      方向键 + Home/End + automatic 激活
//   packages/frontend/src/components/TabBar.tsx:121-139      溢出判定与 reduced-motion 的 'auto'
//   packages/frontend/src/components/TabBar.tsx:326-333      scrollByPage：0.7 屏 + reduced-motion 立即
//   packages/frontend/src/components/ChipsInput.tsx:50-88    trim → 空 → 去重 → validate → commit
//   packages/frontend/src/components/ChipsInput.tsx:160      错误行是校验的唯一反馈面
//   packages/frontend/src/components/memory/MemoryFormFields.tsx:174-182  tag 校验（40 字 / 16 条）
//   packages/frontend/src/components/MultiSelect.tsx:128-135 allowCustom ⇒ 「添加自定义」行
//   packages/frontend/src/components/MultiSelect.tsx:181-232 toggle / Backspace / Enter
//   packages/frontend/src/components/SkillsPicker.tsx:109-120 allowCustom 的唯一开启点
//   packages/frontend/src/components/ManagedLiveRegion.tsx:41-63 role=status + 序号 key 重挂
//   packages/frontend/src/components/workflow-editor/WorkflowNodePicker.tsx:233-245 三种播报文案
//   packages/frontend/src/components/Pagination.tsx:28-45    跳页表单的钳制与 onPageChange
//   packages/frontend/src/components/FilterBar.tsx:30-48     role=group + trailing 动作位
//   packages/frontend/src/components/webhooks/DeliveriesPanel.tsx:151-231 状态/事件/仓库三个筛选维度
//   packages/frontend/src/components/webhooks/DeliveriesPanel.tsx:374-380 Pagination 接线
//   packages/frontend/src/styles.css:23372,23516-23528       @media (max-width:720px) 的 44px 一族
//   packages/backend/src/routes/webhookDeliveries.ts:49-118  分页封套与 limit 默认 50
//
// ## 与既有 spec 的分工（刻意不重叠）
//
//   * `e2e/keyboard-flows.spec.ts` —— UX-12（Dialog 的初始焦点 / Tab 陷阱 / ESC 归还
//     焦点）与 UX-14（Segmented 的方向键选择）。它**不碰** tabindex 的取值、
//     不碰遮罩点按、不碰 body 滚动锁、不碰 dismissDisabled。
//   * `e2e/ux-consistency.spec.ts` —— UX-22 的三条响应式断点与整页无横向溢出。
//     它按断点验布局，**从不量任何控件的高度**，所以 44px 触摸目标整条没人守。
//   * `e2e/workflow-editor.spec.ts:380-390` —— 只断言节点选择器的分类条
//     `scrollWidth > clientWidth`（溢出**存在**）。翻页键能不能用、roving tabindex
//     是不是只有一个 0、reduced-motion 下是不是立即滚动，全部零覆盖。
//   * `e2e/rfc319-webhook-endpoints.spec.ts` —— 端点配置面与入口面（EVENT-01…13），
//     只走 `/events?tab=sources`；投递审计面板的筛选与分页一次都没打开过。
//   * `e2e/rfc319-agent-authoring.spec.ts` AGENT-X4 —— 技能选择器里**置灰选项**
//     不可选。本文件的 UX-17 只走自由文本提交与 chip 删除，两者不重叠。

import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

let daemon: DaemonHandle
let daemonHome: string
let sequence = 0

/** UX-15 / UX-X7 的语料：一个端点 + 三个仓库的合法投递 + 三条验签失败。 */
const REPOS = ['alpha/one', 'bravo/two', 'charlie/three'] as const
const REPO_COUNTS: Record<(typeof REPOS)[number], number> = {
  'alpha/one': 30,
  'bravo/two': 15,
  'charlie/three': 10,
}
const REJECTED_COUNT = 3
const ACCEPTED_TOTAL =
  REPO_COUNTS['alpha/one'] + REPO_COUNTS['bravo/two'] + REPO_COUNTS['charlie/three']
const DELIVERY_TOTAL = ACCEPTED_TOTAL + REJECTED_COUNT
/** DeliveriesPanel 不传 limit ⇒ 后端默认 50（webhookDeliveries.ts:50）。 */
const DELIVERY_PAGE_SIZE = 50
const DELIVERY_PAGE_COUNT = Math.ceil(DELIVERY_TOTAL / DELIVERY_PAGE_SIZE)

/** UX-16 / UX-20 的语料：一张空工作流，节点选择器从它上面打开。 */
let workflowId: string

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${init?.method ?? 'GET'} ${path}: HTTP ${res.status} ${body}`).toBe(true)
  return (body === '' ? null : JSON.parse(body)) as T
}

interface MintedEndpoint {
  id: string
  urlToken: string
  secret: string
}

/** GitLab Push Hook —— 平台支持的事件（gitlabAdapter.ts:210-228）。 */
function pushBody(repoPath: string): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'push',
    user: { username: 'rfc319-ux-human' },
    project: {
      path_with_namespace: repoPath,
      web_url: `https://gitlab.invalid/${repoPath}`,
      git_http_url: `https://gitlab.invalid/${repoPath}.git`,
      git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
    },
    ref: 'refs/heads/main',
    before: `before${String(n)}`,
    after: `after${String(n)}`,
  })
}

async function deliver(
  endpoint: MintedEndpoint,
  repoPath: string,
  secret: string = endpoint.secret,
): Promise<number> {
  const res = await fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': secret,
      'x-gitlab-event': 'Push Hook',
      'x-gitlab-event-uuid': `rfc319-ux-${String(++sequence)}`,
    },
    body: pushBody(repoPath),
  })
  return res.status
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    [daemon.baseUrl, daemon.token] as const,
  )
}

/** 逐字读一组元素的 `tabindex`。roving tabindex 的判据只能是这个数组本身。 */
async function tabIndexes(items: Locator): Promise<string[]> {
  return items.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('tabindex') ?? '(none)'),
  )
}

/** 当前焦点元素的「身份卡」：用来证明 Tab 之后焦点离开了某个 widget。 */
async function activeDescriptor(page: Page): Promise<{ role: string; testid: string }> {
  return page.evaluate(() => {
    const el = document.activeElement
    return {
      role: el?.getAttribute('role') ?? '(none)',
      testid: el?.getAttribute('data-testid') ?? '(none)',
    }
  })
}

/** 打开 /memory 的「新建记忆」弹窗，返回 [遮罩, 面板]。 */
async function openMemoryDialog(page: Page): Promise<{ overlay: Locator; panel: Locator }> {
  await page.goto(`${daemon.baseUrl}/memory`)
  await page.getByTestId('memory-new-button').click()
  const overlay = page.getByTestId('memory-new-dialog')
  await expect(overlay).toBeVisible()
  const panel = overlay.locator('.dialog__panel')
  await expect(panel).toBeVisible()
  // Dialog 的焦点陷阱是**异步**把焦点送进面板的（Dialog.tsx:243-248）。
  // 不等它落定就去按键，会和陷阱赛跑——docs/dev-gotchas.md 有专条。
  await expect(page.getByTestId('memory-form')).toBeVisible()
  return { overlay, panel }
}

/** /events → 事件流水 → 「Webhook ingress」范围（DeliveriesPanel 的真实入口）。 */
async function openWebhookDeliveries(page: Page): Promise<Locator> {
  await page.goto(`${daemon.baseUrl}/events?tab=deliveries`)
  await page.getByTestId('event-delivery-kind-filter').click()
  const scopeOptions = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(scopeOptions).toBeVisible()
  await scopeOptions
    .locator('li[role="option"]')
    .filter({ has: page.locator('.select__option-label', { hasText: 'Webhook ingress' }) })
    .click()
  const panel = page.getByTestId('webhook-deliveries-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('webhook-deliveries-table')).toBeVisible()
  return panel
}

/** 打开工作流编辑器上的节点选择器（`workflow-canvas-add` 是它的真实触发键）。 */
async function openNodePicker(page: Page): Promise<Locator> {
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(workflowId)}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await page.getByTestId('workflow-canvas-add').click()
  const dialog = page.getByTestId('workflow-node-picker-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('workflow-node-picker-search')).toBeFocused()
  return dialog
}

test.beforeAll(async () => {
  daemonHome = mkdtempSync(join(tmpdir(), 'aw-rfc319-uxprim-'))
  // 「样例已提供过」的标记：不种 RFC-307 的 demo 内容，否则代理 / 工作流的条数
  // 不可断言（demo 行挂在 `__system__` 名下且是 public）。
  writeFileSync(join(daemonHome, '.demo-seeded'), `${String(Date.now())}\n`)
  daemon = await startDaemon({ home: daemonHome })

  // UX-17（MultiSelect）：两条受管技能，让选择器里有真实可选行。
  for (const name of ['rfc319-ux-skill-alpha', 'rfc319-ux-skill-bravo']) {
    await api('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: `RFC-319 UX fixture ${name}`,
        bodyMd: '# fixture\n',
      }),
    })
  }

  // UX-16 / UX-20：一张空工作流。节点选择器的目录与它的内容无关，空的最省事。
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-ux-primitives',
      description: 'RFC-319 UI primitives fixture',
      definition: { $schema_version: 5, inputs: [], nodes: [], edges: [] },
    }),
  })
  workflowId = created.id

  // UX-14b：紧凑行高必须量真实的标准事件投递，不能依赖可选 demo 数据。
  // system 消费者不会被通知 worker 认领，因此这条 pending 记录在整份 spec
  // 运行期间保持稳定。
  const densitySubjectRef = 'rfc319-ux-density-subject'
  await api('/api/event-center/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      eventTypeRef: { id: 'approval.status.changed', revision: 1 },
      subject: { typeId: 'external-approval', subjectRef: densitySubjectRef },
      subscriber: { kind: 'system', subscriberRef: 'rfc319-ux-density-consumer' },
    }),
  })
  const densityObservation = await api<{ deliveryIds: string[] }>(
    '/api/event-center/observations',
    {
      method: 'POST',
      body: JSON.stringify({
        sourceRef: { id: 'development.approval-state', revision: 1 },
        eventTypeRef: { id: 'approval.status.changed', revision: 1 },
        subject: { typeId: 'external-approval', subjectRef: densitySubjectRef },
        occurredAt: Date.now(),
        dedupeKey: 'rfc319-ux-density-event',
        summary: 'RFC-319 compact Event Center activity row',
        payloadArtifactRef: null,
        triggerParameters: { subject_ref: densitySubjectRef },
      }),
    },
  )
  expect(densityObservation.deliveryIds, '紧凑行高语料没有产生订阅投递').toHaveLength(1)

  // UX-15 / UX-X7：一个端点 + 58 条投递（55 合法 / 3 验签失败）。
  const endpoint = await api<MintedEndpoint>('/api/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify({ name: 'rfc319-ux-endpoint' }),
  })
  const plan: string[] = []
  for (const repo of REPOS) for (let i = 0; i < REPO_COUNTS[repo]; i += 1) plan.push(repo)
  // 端点级限流是 300/min（rateLimiter.ts:41），58 条远在闸下；分批只为控制并发。
  for (let i = 0; i < plan.length; i += 10) {
    const statuses = await Promise.all(plan.slice(i, i + 10).map((repo) => deliver(endpoint, repo)))
    for (const status of statuses) expect(status, 'seed delivery rejected').toBeLessThan(400)
  }
  for (let i = 0; i < REJECTED_COUNT; i += 1) {
    const status = await deliver(endpoint, 'alpha/one', 'rfc319-wrong-secret')
    expect(status, '验签失败的播种必须真的被拒（否则语料里没有 rejected 行）').toBe(401)
  }
  const seeded = await api<{ total: number }>('/api/webhook-deliveries?limit=1')
  expect(seeded.total, '投递语料条数与用例的分页预期必须一致').toBe(DELIVERY_TOTAL)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    if (daemonHome !== undefined) rmSync(daemonHome, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// `page.route` 的 handler 必须在 page 还活着的时候等干净：先摘 handler，再等在飞的
// callback 跑完。必须是 'wait' 而不是 'ignoreErrors'——后者只是把错吞掉。
// 见 docs/dev-gotchas.md §e2e 里凡是 `page.route` 拦 API 的。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// UX-13 —— Dialog：遮罩点按关闭 / body 滚动锁 / 事务期锁死
// ---------------------------------------------------------------------------

test('RFC-319 UX-13: 弹窗打开时 body 滚动被锁住、点面板内部不关、点遮罩空白处才关且滚动原样归还 @nightly', async ({
  page,
}) => {
  await primeAuth(page)

  const bodyOverflow = () => page.evaluate(() => document.body.style.overflow)
  await page.goto(`${daemon.baseUrl}/memory`)
  const before = await bodyOverflow()

  const { overlay, panel } = await openMemoryDialog(page)

  // ① 滚动锁。断言的是 body 的**实际内联样式**——Dialog.tsx:104 写的就是这一句。
  //    换成「弹窗可见」的话，把整段 acquireDialogBodyScrollLock 删掉也不会红。
  expect(
    await bodyOverflow(),
    '弹窗开着却没锁住 body 滚动 ⇒ 在弹窗里滚滚轮会把背后的页面滚走，关掉后用户不知道自己在哪',
  ).toBe('hidden')

  // ② 点面板内部**不能**关。守的是 Dialog.tsx:402 的 `e.target === overlayRef.current`：
  //    去掉这个判等，弹窗里点任何空白都会把自己关掉，表单当场清空。
  await panel.click({ position: { x: 8, y: 8 } })
  await expect(
    overlay,
    '点弹窗面板内部把弹窗关掉了 ⇒ 用户在表单里点一下空白，刚填的东西全没了',
  ).toBeVisible()
  expect(await bodyOverflow()).toBe('hidden')

  // ③ 点遮罩空白处才关。遮罩是 `position:fixed; inset:0` 且顶部留了 96px 内边距
  //    （styles.css:17476-17485），(8,8) 稳定落在遮罩自己身上。
  await overlay.click({ position: { x: 8, y: 8 } })
  await expect(overlay, '点遮罩没有关闭弹窗 ⇒ 全产品最常用的那个关闭手势失效了').toBeHidden()

  // ④ 还锁。释放走的是「最后一个持有者才还原快照值」（Dialog.tsx:114-122）。
  await expect
    .poll(bodyOverflow, {
      message: '弹窗关了但 body 的 overflow 没还回去 ⇒ 整个页面从此再也滚不动',
    })
    .toBe(before)
})

test('RFC-319 UX-13: 创建用户的事务在飞时弹窗三条退出路径全部锁死，请求落地后才自行关闭 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const username = `rfc319-ux-locked-${String(++sequence)}`

  // 用一个「可控释放」的拦截把 POST 挂住，制造真实的 `busy=true` 事务期。
  // handler 里不出现 route.fetch()（docs/dev-gotchas.md 两把锁的锁 A）——
  // 这里只是把请求**继续**发给真 daemon，延迟发生在 continue 之前。
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === '/api/users',
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      await held
      await route.continue()
    },
  )

  await page.goto(`${daemon.baseUrl}/users`)
  await page.getByRole('button', { name: 'New user' }).click()
  const panel = page.locator('.dialog__panel', { has: page.locator('#users-create-form') })
  await expect(panel).toBeVisible()

  await panel.getByLabel('Username').fill(username)
  await panel.getByLabel('Display name').fill('RFC-319 locked dialog')
  await panel.getByLabel('Password').fill('Rfc319UxPrimitives!1')
  await panel.getByRole('button', { name: 'Create' }).click()

  const closeButton = panel.getByRole('button', { name: 'Close' })
  await expect(
    closeButton,
    '事务在飞时 × 键仍可点 ⇒ 用户以为自己取消了，账号照建不误',
  ).toBeDisabled()

  // ESC：dismissDisabled 时 Dialog 根本不挂那条 keydown 监听（Dialog.tsx:212）。
  await page.keyboard.press('Escape')
  await expect(panel, '事务在飞时 ESC 关掉了弹窗 ⇒ 同上，取消是假的').toBeVisible()

  // 遮罩点按：同一道闸的另一条分支（Dialog.tsx:401）。
  await page.locator('.dialog__overlay').click({ position: { x: 8, y: 8 } })
  await expect(panel, '事务在飞时点遮罩关掉了弹窗 ⇒ 同上').toBeVisible()

  // 放行后弹窗必须自己关掉，且账号真的落库——证明上面锁住的是**真事务**，
  // 不是一个永远打不开的死弹窗。
  release?.()
  await expect(panel).toBeHidden()
  const users = await api<Array<{ username: string }>>('/api/users')
  expect(
    users.some((user) => user.username === username),
    '放行之后账号没落库 ⇒ 上面锁住的根本不是一次真实的创建事务',
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// UX-14b —— Segmented 的单 Tab 停靠点
// ---------------------------------------------------------------------------

test('RFC-319 UX-14b: Segmented 单选组只有选中项是 Tab 停靠点，方向键换选中项时停靠点跟着搬家 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const { panel } = await openMemoryDialog(page)

  const group = panel.getByRole('radiogroup', { name: 'Scope' })
  await expect(group).toBeVisible()
  const options = group.getByRole('radio')
  await expect(options).toHaveCount(5) // global / agent / workflow / repo / repo_group

  // ① 逐字断言 tabindex。这一条是本用例存在的全部理由：把 Segmented.tsx:162 的
  //    `tabIndex={opt.value === tabStopValue ? 0 : -1}` 改成常量 0，页面看起来
  //    一模一样，只有这个数组会变。
  expect(
    await tabIndexes(options),
    'roving tabindex 坏了 ⇒ 键盘用户每经过一个单选组要多按 4 次 Tab',
  ).toEqual(['0', '-1', '-1', '-1', '-1'])
  await expect(page.getByTestId('memory-form-scope-global')).toHaveAttribute('aria-checked', 'true')

  // ② 从选中项按一次 Tab，焦点必须**离开这个组**。全部 tabindex=0 时，
  //    这一步会停在下一个 radio 上——这正是上面那个数组要防的退化。
  await page.getByTestId('memory-form-scope-global').focus()
  await expect(page.getByTestId('memory-form-scope-global')).toBeFocused()
  await page.keyboard.press('Tab')
  const afterTab = await activeDescriptor(page)
  expect(
    afterTab.role,
    `按一次 Tab 后焦点还停在单选组里（testid=${afterTab.testid}）⇒ 这个组占了不止一个 Tab 停靠点`,
  ).not.toBe('radio')

  // ③ 方向键换选中项之后，停靠点必须跟着搬到新的选中项上。
  await page.getByTestId('memory-form-scope-global').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('memory-form-scope-agent')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('memory-form-scope-agent')).toBeFocused()
  expect(
    await tabIndexes(options),
    '换了选中项但 Tab 停靠点没跟着走 ⇒ 用户 Tab 回来时会落在一个没被选中的选项上',
  ).toEqual(['-1', '0', '-1', '-1', '-1'])
})

// ---------------------------------------------------------------------------
// UX-14b —— Event Center 事件流水的宽度与信息密度
// ---------------------------------------------------------------------------

test('RFC-319 UX-14b: 事件流水在桌面保持紧凑行，在窄屏把筛选与页签留在自己的可视宽度内 @nightly', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/events?tab=deliveries`)

  const rows = page.locator(
    '[data-testid="event-delivery-list"] tbody > tr[data-testid^="event-delivery-row-"]',
  )
  await expect(rows.first()).toBeVisible()
  const desktopHeights = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  )
  expect(
    Math.max(...desktopHeights),
    '紧凑表格的常态行超过 44px ⇒ 完整 ID / 错误又被塞回主行，一屏可见条数再次下降',
  ).toBeLessThanOrEqual(44)

  await page.setViewportSize({ width: 720, height: 800 })
  const audit = page.getByTestId('event-center-audit')
  await expect(audit).toBeVisible()
  const [auditWidth, scrollerWidth, tabGeometry] = await Promise.all([
    audit.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
    audit.locator('.table-viewport__scroller').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    })),
    page
      .locator('.event-center-page > .operations-surface > .tabs-viewport')
      .evaluate((element) => {
        const surface = element.parentElement?.getBoundingClientRect()
        const viewport = element.getBoundingClientRect()
        return {
          surfaceRight: surface?.right ?? 0,
          viewportRight: viewport.right,
        }
      }),
  ])
  expect(auditWidth.scrollWidth, '记录范围筛选或表格把事件流水 section 撑宽 ⇒ 整页会横向滚动').toBe(
    auditWidth.clientWidth,
  )
  expect(
    scrollerWidth.scrollWidth,
    '完整审计列没有留在 TableViewport 里 ⇒ 右侧状态 / 时间 / 操作可能又被静默裁掉',
  ).toBeGreaterThan(scrollerWidth.clientWidth)
  expect(scrollerWidth.overflowX, 'TableViewport 没有成为横向滚动容器 ⇒ 窄屏无法访问右侧列').toBe(
    'auto',
  )
  expect(
    tabGeometry.viewportRight,
    'Event Center 页签 viewport 超过 surface 右边界 ⇒ 最右页签仍然会被裁切',
  ).toBeLessThanOrEqual(tabGeometry.surfaceRight + 0.5)
})

// ---------------------------------------------------------------------------
// UX-15 —— Select 自绘下拉的键盘选择
// ---------------------------------------------------------------------------

test('RFC-319 UX-15: 自绘下拉用方向键 / Home / End / 首字母跳转选行，Enter 确认后列表真的被筛掉 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const panel = await openWebhookDeliveries(page)

  const trigger = panel.getByTestId('webhook-delivery-filter-repo')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  // 键盘打开：ArrowDown ⇒ openIntent='first'（Select.tsx:299-305）。
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const listbox = page.locator('ul[role="listbox"].select__listbox--portal')
  await expect(listbox).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  // 这个下拉只有 4 个选项（全部仓库 + 三个仓库），低于 SELECT_SEARCH_THRESHOLD=8，
  // 所以它是**无搜索框**的纯 listbox —— 首字母跳转只在这一档存在（Select.tsx:373）。
  await expect(
    listbox.getByRole('option'),
    '仓库下拉的选项数变了 ⇒ 过了 8 会自动换成搜索框，本用例锁的 type-ahead 那一档就不复存在了',
  ).toHaveCount(REPOS.length + 1)
  await expect(listbox.locator('.select__search-input')).toHaveCount(0)

  const active = listbox.locator('.select__option--active')
  const expectActive = async (label: string, because: string): Promise<void> => {
    // 读 `.select__option-label` 而不是整行：选中行还会渲染一枚 `✓`
    // （Select.tsx:585-589），拿整行文本会把它一起读进来。
    await expect(active.locator('.select__option-label'), because).toHaveText(label)
    // 高亮行与读屏指针必须是同一行，否则读屏用户听到的和看到的不是一回事。
    const [activeId, pointer] = await Promise.all([
      active.getAttribute('id'),
      listbox.getAttribute('aria-activedescendant'),
    ])
    expect(pointer, 'aria-activedescendant 没有指向高亮行 ⇒ 读屏用户被念的是另一行').toBe(activeId)
  }

  await expectActive('All repositories', 'ArrowDown 打开时应当停在第一行')
  await page.keyboard.press('ArrowDown')
  await expectActive('alpha/one', 'ArrowDown 没有往下走一行')
  await page.keyboard.press('End')
  await expectActive('charlie/three', 'End 没有跳到最后一行')
  await page.keyboard.press('Home')
  await expectActive('All repositories', 'Home 没有跳回第一行')

  // 首字母跳转：'b' 必须直接落到 bravo/two。三个仓库名刻意用了互不相同的首字母，
  // 且都与 'All repositories' 的 'a' 区分得开。
  await page.keyboard.press('b')
  await expectActive(
    'bravo/two',
    '首字母跳转失效 ⇒ 长下拉里只能一行一行按方向键，这正是 type-ahead 存在的理由',
  )

  // Enter 确认：终点是**列表真的被筛掉了**，不是高亮换了一行。
  await page.keyboard.press('Enter')
  await expect(listbox).toBeHidden()
  await expect(trigger, 'Enter 之后焦点没有回到触发键 ⇒ 键盘用户当场失去落点').toBeFocused()
  await expect(trigger).toContainText('bravo/two')
  await expect(
    panel.getByTestId('webhook-deliveries-total'),
    'Enter 确认之后列表没有按选中的仓库过滤 ⇒ 这个下拉只是看起来能用',
  ).toHaveText(`${String(REPO_COUNTS['bravo/two'])} total`)
  await expect(panel.locator('tbody tr')).toHaveCount(REPO_COUNTS['bravo/two'])
})

// ---------------------------------------------------------------------------
// UX-16 —— TabBar：roving tabindex + 方向键换页签 + 溢出滚动
// ---------------------------------------------------------------------------

test('RFC-319 UX-16: 页签条只有选中页签是 Tab 停靠点，方向键与 Home/End 换页签并同步搬走停靠点 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const dialog = await openNodePicker(page)

  const tablist = dialog.getByTestId('workflow-node-picker-categories')
  await expect(tablist).toBeVisible()
  const tabs = tablist.getByRole('tab')
  await expect(tabs).toHaveCount(7) // all / agents / wrappers / calls / scripts / io / human

  const firstTab = dialog.getByTestId('workflow-node-picker-category-all')
  const secondTab = dialog.getByTestId('workflow-node-picker-category-agents')
  const lastTab = dialog.getByTestId('workflow-node-picker-category-human')

  expect(
    await tabIndexes(tabs),
    'TabBar 的 roving tabindex 坏了 ⇒ 键盘用户每经过一条页签条要多按 6 次 Tab',
  ).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1'])
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')

  // 单 Tab 停靠点：从选中页签按一次 Tab 必须离开 tablist。
  await firstTab.focus()
  await expect(firstTab).toBeFocused()
  await page.keyboard.press('Tab')
  const afterTab = await activeDescriptor(page)
  expect(
    afterTab.role,
    `按一次 Tab 后焦点还停在页签条里（testid=${afterTab.testid}）⇒ 这条页签条占了不止一个停靠点`,
  ).not.toBe('tab')

  // 方向键：automatic 激活 ⇒ 移动焦点的同时换页签（TabBar.tsx:286）。
  // 终点是**面板真的换了**，不是 aria 属性自说自话。
  await firstTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(secondTab).toBeFocused()
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')
  await expect(
    dialog.getByTestId('workflow-node-picker-category-panel-agents'),
    '方向键换了页签但面板没跟着换 ⇒ 用户看到的还是上一个分类',
  ).toBeVisible()
  expect(
    await tabIndexes(tabs),
    '换了页签但 Tab 停靠点没跟着走 ⇒ 用户 Tab 回来时落在一个没选中的页签上',
  ).toEqual(['-1', '0', '-1', '-1', '-1', '-1', '-1'])

  await page.keyboard.press('End')
  await expect(lastTab).toBeFocused()
  await expect(lastTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(firstTab).toBeFocused()
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  expect(await tabIndexes(tabs)).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1'])

  // ArrowLeft 从第一个回绕到最后一个（TabBar.tsx:276 的取模）。
  await page.keyboard.press('ArrowLeft')
  await expect(
    lastTab,
    '在第一个页签上按 ArrowLeft 没有回绕到最后一个 ⇒ 键盘用户被卡在边界上',
  ).toBeFocused()
})

test.describe('reduced motion', () => {
  test('RFC-319 UX-16: 窄容器下页签条长出两个翻页键，reduced-motion 下点一次就整屏滚到位（不做动画） @nightly', async ({
    page,
  }) => {
    await primeAuth(page)
    // 显式 `emulateMedia` 而不是 `test.use({ reducedMotion })`：后者在本仓的
    // Playwright 配置下**没有**真的把媒体特性打进页面（实测
    // `matchMedia('(prefers-reduced-motion: reduce)').matches === false`，
    // 于是整条 reduced-motion 分支根本没被走到，用例会变成一条假绿）。
    // 下面那句 `jump.reducedMotion` 断言就是这条经验的常驻守卫。
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // 编辑器在 <1180 走 compact 布局（lib/workflow-editor-workspace.ts:5-10），
    // 节点选择器仍是弹窗；这个宽度下 7 个分类页签一定装不下。
    await page.setViewportSize({ width: 900, height: 800 })
    const dialog = await openNodePicker(page)

    const viewport = dialog.locator('.tabs-viewport', {
      has: page.getByTestId('workflow-node-picker-categories'),
    })
    await expect(
      viewport,
      '窄容器下页签条没有判定出溢出 ⇒ 后面被挤出去的页签用户永远够不到',
    ).toHaveAttribute('data-has-overflow', 'true')
    await expect(viewport).toHaveAttribute('data-overflow-start', 'false')
    await expect(viewport).toHaveAttribute('data-overflow-end', 'true')

    const scrollStart = viewport.getByRole('button', { name: 'Show more sections before' })
    const scrollEnd = viewport.getByRole('button', { name: 'Show more sections after' })
    await expect(scrollStart, '还没滚动时「向前」键必须是禁用态').toBeDisabled()
    await expect(scrollEnd).toBeEnabled()

    // 44px 触摸目标：两个翻页键是 `.tabs-viewport__scroll`（styles.css:8217-8218）。
    for (const button of [scrollStart, scrollEnd]) {
      const box = await button.boundingBox()
      expect(box, '翻页键没有盒子 ⇒ 它根本没渲染出来').not.toBeNull()
      expect(box!.width, '翻页键宽度不足 44px').toBeGreaterThanOrEqual(44)
      expect(box!.height, '翻页键高度不足 44px').toBeGreaterThanOrEqual(44)
    }

    // reduced-motion ⇒ scrollBy 用 behavior:'auto'（TabBar.tsx:331）。
    // 「立即」这件事只能同步验：把 click 与读值放进**同一个** evaluate，
    // 中间不留任何一帧。behavior 改回 'smooth' 时 after 会停在 0 附近。
    const jump = await viewport.evaluate((root: HTMLElement) => {
      const strip = root.querySelector<HTMLElement>('[role="tablist"]')!
      const button = root.querySelector<HTMLElement>('.tabs-viewport__scroll--end')!
      const before = strip.scrollLeft
      button.click()
      return {
        before,
        after: strip.scrollLeft,
        // 一次「翻页」的目标量（TabBar.tsx 的 SCROLL_PAGE_RATIO = 0.7），
        // 但浏览器会把它钳在这条带子自己的最大滚动距离上。
        page: strip.clientWidth * 0.7,
        max: strip.scrollWidth - strip.clientWidth,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      }
    })
    expect(jump.before).toBe(0)
    expect(jump.reducedMotion, '浏览器没有报告 reduced-motion ⇒ 这条用例根本没走到那一支').toBe(
      true,
    )
    // 允许 2px 的取整余量：目标量是 clientWidth*0.7、再被钳在最大滚动距离上，
    // 浏览器还会把结果落到整数像素。差一个「翻页」量级的距离说明它做的是动画
    // 而不是跳转——把 `behavior` 改回常量 'smooth' 时这里读到的是 0。
    expect(jump.max, '这条页签带根本没有可滚动的余量 ⇒ 下面的断言无从谈起').toBeGreaterThan(0)
    expect(
      jump.after,
      'reduced-motion 下点翻页键没有立即滚到位 ⇒ 关掉动画的用户看到的是一条僵住的页签条',
    ).toBeGreaterThanOrEqual(Math.min(jump.page, jump.max) - 2)

    await expect(
      viewport,
      '滚动之后「向前」侧的溢出标记没有翻过来 ⇒ 用户回不去前面的页签',
    ).toHaveAttribute('data-overflow-start', 'true')
    await expect(scrollStart).toBeEnabled()
  })
})

// ---------------------------------------------------------------------------
// UX-17 —— ChipsInput / MultiSelect
// ---------------------------------------------------------------------------

test('RFC-319 UX-17: 标签输入 Enter 与逗号都能提交，重复与超长被逐条说明地拒收，× 与 Backspace 各删一枚 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const { panel } = await openMemoryDialog(page)

  const field = panel.getByTestId('memory-form-tag-input')
  const chips = panel.locator('.chips-input .chip')
  const error = panel.locator('.chips-input__error')

  // ① Enter 提交 + ② 逗号提交。两条通路都在 ChipsInput.tsx:70-72 的同一个分支里，
  //    但只测一条的话，把 `|| e.key === ','` 删掉不会有人发现。
  await field.fill('alpha')
  await page.keyboard.press('Enter')
  await expect(chips).toHaveCount(1)
  await field.type('bravo,')
  await expect(chips, '逗号没有提交 token ⇒ 用户按住逗号打了一串，一个 tag 也没进去').toHaveCount(2)
  await expect(chips.nth(0)).toContainText('alpha')
  await expect(chips.nth(1)).toContainText('bravo')
  await expect(field).toHaveValue('')

  // ③ 去重。错误行是唯一反馈面，且**不能**把重复的那个加进去。
  await field.fill('alpha')
  await page.keyboard.press('Enter')
  await expect(chips, '重复 token 被加了第二遍 ⇒ 同一个 tag 在库里出现两次').toHaveCount(2)
  await expect(
    error,
    '重复被静默丢弃、没有任何提示 ⇒ 用户以为自己没按到回车，会一直重按',
  ).toHaveText('duplicate: alpha')

  // ④ 自定义校验拒收（MemoryFormFields.tsx:174-177，上限 40 字）。
  await field.fill('x'.repeat(41))
  await page.keyboard.press('Enter')
  await expect(chips, '超长 tag 被放进来了 ⇒ 提交时才吃服务端 422，用户不知道是哪一条').toHaveCount(
    2,
  )
  await expect(error).toHaveText('Each tag must be ≤ 40 characters')

  // 校验通过的边界值必须能进去——证明上面拦的是长度本身，不是这条路整个坏了。
  await field.fill('y'.repeat(40))
  await page.keyboard.press('Enter')
  await expect(chips).toHaveCount(3)
  await expect(error).toHaveCount(0)

  // ⑤ chip 上的 × 删除指定那一枚（不是最后一枚）。
  await panel.getByTestId('memory-form-tag-remove-alpha').click()
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toContainText('bravo')

  // ⑥ 空输入框上的 Backspace 删最后一枚（ChipsInput.tsx:73-75）。
  await field.click()
  await expect(field).toHaveValue('')
  await page.keyboard.press('Backspace')
  await expect(
    chips,
    '空输入框上的 Backspace 没有删掉最后一枚 ⇒ 手不离键盘就改不了已提交的标签',
  ).toHaveCount(1)
  await expect(chips.nth(0)).toContainText('bravo')
})

test('RFC-319 UX-17: 技能多选框接受自由文本提交为项目技能，chip 可删、已选行再点是取消而不是加第二遍 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByTestId('agent-tab-resources').click()

  const combo = page.getByRole('combobox', { name: 'Skills' })
  await expect(combo).toBeVisible()
  const field = combo.locator('xpath=..')
  const chips = field.locator('.chip')

  // ① 自由文本提交（allowCustom，SkillsPicker.tsx:118）。
  await combo.click()
  const listbox = page.locator('ul[role="listbox"][aria-multiselectable="true"]')
  await expect(listbox).toBeVisible()
  await combo.fill('rfc319-project-skill')
  const custom = listbox.locator('.multi-select__add-custom')
  await expect(
    custom,
    '自由文本没有给出「添加」行 ⇒ 仓内自发现的项目技能在界面上根本填不进去',
  ).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(chips).toHaveCount(1)
  await expect(chips.nth(0)).toContainText('rfc319-project-skill')

  // ② 受管选项：点一次选中、再点一次取消——这是 MultiSelect 的去重契约
  //    （MultiSelect.tsx:181-184 的 toggle），不是「加第二遍」。
  await combo.fill('rfc319-ux-skill-alpha')
  // 只取受管选项行：同一个查询下「添加自定义」行也在列表里（token 前缀不同，
  // SkillsPicker.tsx:29-31 的 `managed:` / 自由文本不相等），裸 getByRole 会命中两条。
  const managedRow = listbox.locator('.multi-select__option', { hasText: 'rfc319-ux-skill-alpha' })
  await managedRow.click()
  await expect(chips).toHaveCount(2)
  await expect(managedRow).toHaveAttribute('aria-selected', 'true')
  await managedRow.click()
  await expect(
    chips,
    '再点一次已选中的行把它加了第二遍 ⇒ 同一条技能会在代理的 skills 里出现两次',
  ).toHaveCount(1)
  await expect(managedRow).toHaveAttribute('aria-selected', 'false')

  // ③ 重新选上，然后用 chip 的 × 删掉指定那一枚。
  await managedRow.click()
  await expect(chips).toHaveCount(2)
  await field.getByRole('button', { name: /^Remove rfc319-project-skill$/ }).click()
  await expect(chips).toHaveCount(1)
  await expect(chips.nth(0)).toContainText('rfc319-ux-skill-alpha')

  // ④ 查询为空时的 Backspace 删最后一枚（MultiSelect.tsx:229-231）。
  await combo.fill('')
  await page.keyboard.press('Backspace')
  await expect(
    chips,
    '查询为空时的 Backspace 没有删掉最后一枚 ⇒ 键盘用户只能靠鼠标点 ×',
  ).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// UX-20 —— 托管 aria-live 播报区
// ---------------------------------------------------------------------------

test('RFC-319 UX-20: 托管播报区随节点选择器的筛选逐次改写内容，读屏用户听得到「还剩几项」 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const dialog = await openNodePicker(page)

  // 播报区是页面级的（ManagedLiveRegionProvider 挂在 workflows.edit.tsx:1038），
  // 不在弹窗里；它必须是 role=status + aria-live=polite，否则读屏不会主动念。
  const region = page.getByTestId('managed-live-region')
  await expect(region).toHaveAttribute('role', 'status')
  await expect(region).toHaveAttribute('aria-live', 'polite')

  const text = async (): Promise<string> => (await region.textContent())?.trim() ?? ''

  // ① 打开选择器本身就是一次播报（WorkflowNodePicker.tsx:233-245）。
  await expect
    .poll(text, {
      message: '打开节点选择器后播报区仍是空的 ⇒ 读屏用户不知道目录里有多少可选项',
    })
    .toMatch(/^\d+ workflow steps available\.$/)
  const opened = await text()

  // ② 搜到 0 项：文案必须换成「没有匹配」。这一步是本用例的主判据——
  //    把 announce() 那个 useEffect 删掉，region 会**停在**上一句话，
  //    于是下面这条 poll 会一直超时。
  await page.getByTestId('workflow-node-picker-search').fill('zzz-no-such-step-zzz')
  await expect
    .poll(text, {
      message: '筛到零结果时播报区没有跟着改写 ⇒ 读屏用户面对一个静默的空列表',
    })
    .toBe('No matching steps.')

  // ③ 清空查询回到全量：必须播回原来那句，证明它是**跟着数据算**的，
  //    不是只在挂载时喊过一次。
  await page.getByTestId('workflow-node-picker-search').fill('')
  await expect.poll(text).toBe(opened)

  // ④ 换分类：文案切到带分类名的那一支（resultsCountInCategory）。
  await dialog.getByTestId('workflow-node-picker-category-human').click()
  await expect
    .poll(text, { message: '换分类后播报区没有说清楚现在看的是哪一类' })
    .toMatch(/^\d+ Human steps available\.$/)
})

// ---------------------------------------------------------------------------
// UX-X3 —— 移动端最小触摸目标 + 不横向溢出
// ---------------------------------------------------------------------------

test('RFC-319 UX-X3: 390px 下页签 / 分段控件 / 下拉 / 输入框 / 导航项都不小于 44px，且三处产品面都不横向溢出 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  await page.setViewportSize({ width: 390, height: 844 })

  const noHorizontalOverflow = async (where: string): Promise<void> => {
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement
      return { scroll: root.scrollWidth, client: root.clientWidth }
    })
    expect(
      overflow.scroll,
      `${where}：页面横向溢出 ${String(overflow.scroll - overflow.client)}px ⇒ 手机上要左右拖才能看全`,
    ).toBeLessThanOrEqual(overflow.client + 1)
  }

  /**
   * 逐族量**真实盒子**（`getBoundingClientRect`），不是读 CSS 声明。
   *
   * 每一族都先断言「这一族在这个容器里确实渲染了」——否则选择器写错时整条
   * 断言会静默塌缩成恒真。`scope` 一律收到具体容器上：同一个类名在不同路由下
   * 可能被**路由级更强的选择器**改成别的密度（`.btn--sm` / `.btn--xs` 是产品
   * 明示的 36px 紧凑档，它们本来就不在这条判据里）。
   */
  const expectTouchTargets = async (
    scope: Locator,
    where: string,
    families: ReadonlyArray<{ selector: string; label: string }>,
  ): Promise<void> => {
    for (const family of families) {
      const boxes = await scope.locator(family.selector).evaluateAll((nodes) =>
        nodes
          .filter((node) => (node as HTMLElement).offsetParent !== null)
          .map((node) => ({
            height: Math.round(node.getBoundingClientRect().height),
            text: (node.textContent ?? '').trim().slice(0, 24),
          })),
      )
      expect(
        boxes.length,
        `${where} 的${family.label}（${family.selector}）一个都没渲染 ⇒ 选择器写错了，下面的断言是恒真的`,
      ).toBeGreaterThan(0)
      expect(
        boxes.filter((box) => box.height < 44),
        `${where} 的${family.label}触摸目标不足 44px ⇒ styles.css 的 @media (max-width: 720px) 里那一族 min-height:44px 掉了，手机上点不准`,
      ).toEqual([])
    }
  }

  // ① 新建代理页：页签 / 下拉 / 输入框 / 主行动键四族齐全的最短路径。
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await expect(page.getByTestId('agent-create-button')).toBeVisible()
  await expectTouchTargets(page.locator('body'), '新建代理页', [
    { selector: '.tabs__tab', label: '页签' },
    { selector: '.select__trigger', label: '下拉触发键' },
    { selector: '.form-input:not(.form-input--sm)', label: '表单输入框' },
    { selector: '.btn:not(.btn--sm):not(.btn--xs)', label: '主行动键' },
  ])
  await noHorizontalOverflow('新建代理页')

  // ② 新建记忆弹窗：分段控件与弹窗自己的 × 键只有在弹窗里才量得到。
  //    先切到 agent 档，让 scope target 那个 <Select> 真的渲染出来。
  const { panel } = await openMemoryDialog(page)
  await page.getByTestId('memory-form-scope-agent').click()
  await expect(panel.locator('.select__trigger')).toBeVisible()
  await expectTouchTargets(panel, '新建记忆弹窗', [
    { selector: '.segmented__option', label: '分段控件选项' },
    { selector: '.select__trigger', label: '下拉触发键' },
    { selector: '.form-input:not(.form-input--sm)', label: '表单输入框' },
    { selector: '.dialog__close', label: '弹窗关闭键' },
  ])
  await noHorizontalOverflow('新建记忆弹窗打开时')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // ③ 侧栏在窄屏收进抽屉，导航项是那里唯一的入口——它比页面里的控件更需要 44px。
  await page.getByTestId('mobile-menu-trigger').click()
  const navDialog = page.getByTestId('mobile-nav-dialog')
  await expect(navDialog).toBeVisible()
  await expectTouchTargets(navDialog, '移动端导航抽屉', [
    { selector: '.nav-item', label: '导航项' },
  ])
  await noHorizontalOverflow('移动端导航抽屉打开时')
})

// ---------------------------------------------------------------------------
// UX-X7 —— Pagination + FilterBar 在产品路径上的实机覆盖
// ---------------------------------------------------------------------------

test('RFC-319 UX-X7: 投递审计的分页键与跳页表单真的换页，筛选栏按状态收窄并能一键清除 @nightly', async ({
  page,
}) => {
  await primeAuth(page)
  const panel = await openWebhookDeliveries(page)

  const pagination = panel.getByTestId('webhook-deliveries-pagination')
  const rows = panel.locator('tbody tr')
  const label = pagination.locator('.pagination__label')
  const prev = pagination.getByRole('button', { name: 'Previous' })
  const next = pagination.getByRole('button', { name: 'Next' })
  const lastPageRows = DELIVERY_TOTAL - DELIVERY_PAGE_SIZE * (DELIVERY_PAGE_COUNT - 1)

  // FilterBar 是一个具名 group——它存在的理由就是让读屏用户知道这一族控件是筛选。
  await expect(panel.getByRole('group', { name: 'Delivery filters' })).toBeVisible()
  await expect(panel.getByTestId('webhook-deliveries-total')).toHaveText(
    `${String(DELIVERY_TOTAL)} total`,
  )

  // ① 首页：上一页禁用、行数 = 一页的容量。
  await expect(label).toHaveText(`Page 1 of ${String(DELIVERY_PAGE_COUNT)}`)
  await expect(prev, '第一页上「上一页」仍可点 ⇒ 点下去会请求第 0 页').toBeDisabled()
  await expect(rows).toHaveCount(DELIVERY_PAGE_SIZE)

  // ② 下一页：断言的是**行数换了**，不是页码文字换了——只改页码不重取数据
  //    正是分页最常见的坏法。
  await next.click()
  await expect(label).toHaveText(
    `Page ${String(DELIVERY_PAGE_COUNT)} of ${String(DELIVERY_PAGE_COUNT)}`,
  )
  await expect(rows, '翻到末页但行数没变 ⇒ 页码动了、数据没动').toHaveCount(lastPageRows)
  await expect(next, '末页上「下一页」仍可点 ⇒ 点下去会翻到一页空的').toBeDisabled()

  await prev.click()
  await expect(label).toHaveText(`Page 1 of ${String(DELIVERY_PAGE_COUNT)}`)
  await expect(rows).toHaveCount(DELIVERY_PAGE_SIZE)

  // ③ 跳页表单：填页码 + 按 Go（Pagination.tsx:29-45）。
  const jump = pagination.getByLabel('Page number')
  await jump.fill(String(DELIVERY_PAGE_COUNT))
  await pagination.getByRole('button', { name: 'Go to page' }).click()
  await expect(label).toHaveText(
    `Page ${String(DELIVERY_PAGE_COUNT)} of ${String(DELIVERY_PAGE_COUNT)}`,
  )
  await expect(rows).toHaveCount(lastPageRows)

  // 越界跳页必须被钳回末页而不是翻到空页。
  await jump.fill('999')
  await pagination.getByRole('button', { name: 'Go to page' }).click()
  await expect(label, '越界页码没有被钳回末页 ⇒ 用户手滑打个大数就看到一页空白').toHaveText(
    `Page ${String(DELIVERY_PAGE_COUNT)} of ${String(DELIVERY_PAGE_COUNT)}`,
  )
  await expect(rows).toHaveCount(lastPageRows)

  // ④ 筛选栏：按状态收窄。rejected 只有验签失败那三条（webhooks.ts:157-165）。
  await expect(
    panel.getByTestId('webhook-deliveries-clear-filters'),
    '还没有任何筛选时就渲染了「清除筛选」 ⇒ 这个动作位失去了它的信号意义',
  ).toHaveCount(0)
  await panel.getByRole('radio', { name: 'Rejected' }).click()
  await expect(panel.getByTestId('webhook-deliveries-total')).toHaveText(
    `${String(REJECTED_COUNT)} total`,
  )
  await expect(rows).toHaveCount(REJECTED_COUNT)
  await expect(label, '筛选之后页数没有跟着缩回 1 ⇒ 用户会停在一页不存在的数据上').toHaveText(
    'Page 1 of 1',
  )

  // ⑤ 一键清除：FilterBar 的 trailing 动作位（FilterBar.tsx:44-48）。
  const clear = panel.getByTestId('webhook-deliveries-clear-filters')
  await expect(
    clear,
    '有筛选在生效却没有清除入口 ⇒ 空态文案让用户「清除筛选」，而页面上根本没有那个键',
  ).toBeVisible()
  await clear.click()
  await expect(panel.getByTestId('webhook-deliveries-total')).toHaveText(
    `${String(DELIVERY_TOTAL)} total`,
  )
  await expect(label).toHaveText(`Page 1 of ${String(DELIVERY_PAGE_COUNT)}`)
  await expect(clear).toHaveCount(0)
})
