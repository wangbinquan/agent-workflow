// RFC-324 —— 授权分档的端到端旅程（两个真实浏览器上下文）。
//
// 锁 proposal.md §7 的 AC-13 / AC-15，也就是这个 RFC 真正想解决的那个体感：
//
//   用户原话是「想把工作流授权给别人用但不想让他改，现在没有好的权限设置方式」。
//   后端的 grant 本来就是只读的——痛点全在前台：面板没有档位可选，编辑器对被授权
//   者完全可交互，第一次自动保存才吃 403，文案还写着「此工作流可能已删除」。
//
// 旅程逐步对应产品承诺：
//   ① alice 在权限面板里把 carol 加进来 → 默认落在**只读**档（安全默认，AC-12）；
//   ② carol 打开同一份工作流的编辑器：看得见、有「只读授权」徽标、编辑控件不渲染，
//      且**整个过程零 PUT**——那发 heal 自动保存正是 audit-backlog 记的 403 来源；
//   ③ alice 把她升成可编辑 → carol **不刷新页面**就拿到编辑态（AC-15 的升档方向）；
//   ④ alice 降回只读 → carol **不刷新页面**就回到只读态（AC-15 的降档方向）。
//
// ③④ 是这条 spec 唯一无法被单测替代的部分：它依赖后端 ACL 写入后经 WS 发出的
// `resource-acl.changed` 帧、前端据此让 `['acl']` 缓存失效、`useResourceAccess`
// 重新解析、`canUpdate` 收敛这一整条链。链上任何一环断掉，被降档的人都会一直停在
// 可编辑的界面上直到他自己刷新——而他没有任何理由去刷新。

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

interface SeededUser {
  username: string
  userId: string
  sessionToken: string
}

async function createUserAndLogin(username: string): Promise<SeededUser> {
  const createRes = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    }),
  })
  expect(createRes.ok, `createUser ${username}`).toBe(true)
  const { id } = (await createRes.json()) as { id: string }
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'longEnoughPassword' }),
  })
  expect(loginRes.ok, `login ${username}`).toBe(true)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { username, userId: id, sessionToken }
}

async function primeAuth(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    ({ baseUrl, tok }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, tok: token },
  )
}

const WORKFLOW_NAME = 'rfc324-graded-flow'

/** 打开编辑器右上角 More → Permissions，返回面板所在的 dialog。 */
async function openWorkflowAcl(page: Page) {
  await page.getByTestId('workflow-more-actions').click()
  await expect(page.getByTestId('workflow-actions-dialog')).toBeVisible()
  await page.getByTestId('workflow-acl-button').click()
  const dialog = page.getByTestId('workflow-acl-dialog')
  await expect(dialog.getByTestId('acl-panel')).toBeVisible()
  return dialog
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-324: 只读授权者的编辑器是只读的且零自动保存；升档与降档都不需要刷新页面', async ({
  browser,
}) => {
  const alice = await createUserAndLogin('alice324')
  const carol = await createUserAndLogin('carol324')

  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: WORKFLOW_NAME,
      description: 'rfc324 e2e fixture',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  // body 只能读一次：先取文本（失败时它就是诊断信息），再自己解析。
  const wfBody = await wfRes.text()
  expect(wfRes.ok, wfBody).toBe(true)
  const { id: workflowId } = JSON.parse(wfBody) as { id: string }

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, alice.sessionToken)
  const alicePage = await aliceCtx.newPage()

  const carolCtx = await browser.newContext()
  await primeAuth(carolCtx, carol.sessionToken)
  const carolPage = await carolCtx.newPage()

  // carol 的整场会话里，任何对这份工作流的写请求都记下来。只读期间必须一条都没有。
  const carolWrites: string[] = []
  carolPage.on('request', (request) => {
    const url = request.url()
    if (!url.includes(`/api/workflows/${workflowId}`)) return
    const method = request.method()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
    carolWrites.push(`${method} ${new URL(url).pathname}`)
  })

  // ── ① alice 授权 carol：默认落只读档 ──────────────────────────────────────
  await alicePage.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  const aliceAcl = await openWorkflowAcl(alicePage)
  await aliceAcl.getByTestId('acl-members-input').click()
  await aliceAcl.getByTestId('acl-members-input').fill('carol')
  // 结果列表是 portal 到 document.body 的（RFC-099 的 e2e 里记过这一点：早先它被
  // .dialog__body 的滚动区裁掉、点不到），所以按 page 而不是 dialog 定位。
  await alicePage.getByTestId('acl-members-option-carol324').click()

  const readOption = aliceAcl.getByTestId(`acl-level-read-${carol.userId}`)
  const writeOption = aliceAcl.getByTestId(`acl-level-write-${carol.userId}`)
  await expect(readOption, '新加的人必须出现档位控件').toBeVisible()
  await expect(
    readOption,
    '新加的授权默认是只读——这是安全默认，也是 RFC-324 之前 grant 的唯一含义',
  ).toHaveAttribute('aria-checked', 'true')
  await expect(writeOption).toHaveAttribute('aria-checked', 'false')
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  // ── ② carol 的编辑器：看得见、只读、零写请求 ─────────────────────────────
  await carolPage.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  await expect(
    carolPage.getByTestId('workflow-readonly-badge'),
    '只读授权者必须知道自己为什么拖不动画布；沉默的只读态与「界面坏了」没有区别',
  ).toBeVisible()
  await expect(
    carolPage.getByTestId('workflow-undo'),
    '编辑控件挂在 canUpdate 上；只读档下它们不该渲染',
  ).toHaveCount(0)

  // 给 heal 自动保存（若还活着）足够的时间打出那一发 PUT。
  await expect
    .poll(async () => carolPage.evaluate(() => document.readyState), { timeout: 10_000 })
    .toBe('complete')
  await carolPage.waitForTimeout(2_000)
  expect(
    carolWrites,
    '只读授权者打开编辑器必须零写请求——那发 heal 自动保存正是 audit-backlog:489-499 里' +
      '「一打开就 403、文案还说可能已删除」的来源',
  ).toEqual([])

  // ── ③ 升档：carol 不刷新页面就拿到编辑态 ─────────────────────────────────
  await alicePage.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  const upgradePanel = await openWorkflowAcl(alicePage)
  await upgradePanel.getByTestId(`acl-level-write-${carol.userId}`).click()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  await expect(
    carolPage.getByTestId('workflow-readonly-badge'),
    '升档后徽标必须自己消失：carol 没有理由去刷新页面',
  ).toHaveCount(0, { timeout: 20_000 })
  await expect(carolPage.getByTestId('workflow-undo'), '升档后编辑控件必须自己出现').toBeVisible({
    timeout: 20_000,
  })

  // ── ④ 降档：carol 不刷新页面就回到只读 ───────────────────────────────────
  const downgradePanel = await openWorkflowAcl(alicePage)
  await downgradePanel.getByTestId(`acl-level-read-${carol.userId}`).click()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  await expect(
    carolPage.getByTestId('workflow-readonly-badge'),
    '降档是这条链最要紧的方向：撤回编辑权之后，对方还停在可编辑界面上就是权限没落地',
  ).toBeVisible({ timeout: 20_000 })
  await expect(carolPage.getByTestId('workflow-undo')).toHaveCount(0, { timeout: 20_000 })

  await aliceCtx.close()
  await carolCtx.close()
})
