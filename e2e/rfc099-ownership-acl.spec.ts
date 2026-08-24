// RFC-099 — resource-ownership ACL through TWO real browser contexts.
//
// LOCKS the owner/grant story at the UI layer (proposal 用户故事 1):
//   1. alice (regular user) owns an agent; via the detail page's AclPanel she
//      flips it PRIVATE → carol's /agents list no longer shows it and the
//      direct detail URL dead-ends (the 404 renders the error state).
//   2. alice grants carol through the UserPicker → carol sees the agent
//      again; her AclPanel is READ-ONLY (no save button, owner shown).
//   3. The workflow editor's 「Permissions」 dialog opens the same panel for
//      workflows (smoke — panel renders with owner row).
//
// Backend route matrices live in rfc099-resource-routes.test.ts; this spec
// pins the browser-visible wiring: panel mounts, picker search round-trip,
// list filtering after ACL changes.

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

interface SeededUser {
  username: string
  sessionToken: string
  userId: string
}

async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user'
}): Promise<SeededUser> {
  const createRes = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  if (!createRes.ok) throw new Error(`createUser ${opts.username}: ${createRes.status}`)
  const { id } = (await createRes.json()) as { id: string }
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  if (!loginRes.ok) throw new Error(`login ${opts.username}: ${loginRes.status}`)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken }
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

async function makeAgentPublic(agentId: string, token: string): Promise<void> {
  const res = await fetch(`${daemon.baseUrl}/api/agents/${agentId}/acl`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: agentId,
      expectedAclRevision: 0,
    }),
  })
  expect(res.ok, await res.text().catch(() => '')).toBe(true)
}

async function expectAxeClean(page: Page, label: string, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa'])
  if (include !== undefined) builder = builder.include(include)
  const result = await builder.analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${label} axe violations`,
  ).toEqual([])
}

async function openAgentAcl(page: Page): Promise<void> {
  await page.getByTestId('detail-more-actions').click()
  const actions = page.getByTestId('detail-actions-dialog')
  await expect(actions).toBeVisible()
  await actions.getByTestId('acl-dialog-button').click()
}

const AGENT_NAME = 'rfc099-secret-agent'

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-099: private agent disappears for strangers; granting via AclPanel restores read-only access', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice99',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'carol99',
    password: 'longEnoughPassword',
    role: 'user',
  })

  // alice creates the agent via API (the AgentForm itself is covered by
  // existing e2e); RFC-099 stamps her as owner.
  const createAgent = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: AGENT_NAME,
      description: 'rfc099 e2e fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'secret instructions',
    }),
  })
  expect(createAgent.ok).toBe(true)
  const { id: agentId } = (await createAgent.json()) as { id: string }
  // RFC-231 makes canonical creates private. This ACL story intentionally
  // starts from a shared resource so it can then prove public → private →
  // granted visibility transitions.
  await makeAgentPublic(agentId, alice.sessionToken)

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, alice.sessionToken)
  const alicePage: Page = await aliceCtx.newPage()

  const carolCtx = await browser.newContext()
  await primeAuth(carolCtx, carol.sessionToken)
  const carolPage: Page = await carolCtx.newPage()

  // (0) Explicitly public: carol sees the agent in her list.
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME }).first()).toBeVisible()

  // (1) alice opens the detail page → More → Permissions. The AclPanel dialog
  // shows her as owner and she flips visibility to private. Secondary resource
  // administration shares this More surface across all detail pages.
  await alicePage.goto(`${daemon.baseUrl}/agents/${agentId}`)
  await openAgentAcl(alicePage)
  await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  await expect(alicePage.getByTestId('acl-panel')).toContainText('alice99')
  await alicePage.getByTestId('acl-visibility-private').click()
  await alicePage.getByTestId('acl-save').click()
  // A successful save CLOSES the dialog (user feedback).
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  // (2) carol: list no longer contains the agent; direct URL is INDISTINGUISHABLE
  //     from a resource that never existed.
  //
  // ⚠️ RFC-319 T30 —— 这里原本是 `expect(carolPage.getByTestId('acl-panel')).toHaveCount(0)`，
  // 一条**恒真断言**：`acl-panel` 只在 More→Permissions 弹窗内渲染（见 openAgentAcl），
  // 而 carol 从未点开过那个弹窗。无论权限如何它都是 0——即便私有化彻底失效、carol
  // 看到了完整详情页，那条断言照样绿。上一行的列表过滤是真覆盖，两半判若两人。
  //
  // 换成**存在性不可区分**：把「真实但不可见的 id」与「根本不存在的 id」两次访问
  // 呈现出来的文本逐字比较。私有化一旦泄露——哪怕只泄露一个名字、或者把 404 换成
  // 403（403 本身就是「这个 id 存在」的信号）——两者就不再相等。
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME })).toHaveCount(0)

  const denialShownTo = async (id: string): Promise<string> => {
    await carolPage.goto(`${daemon.baseUrl}/agents/${id}`)
    const banner = carolPage.locator('.error-box').first()
    await expect(banner).toBeVisible()
    // 名字不得出现在任何位置（标题、面包屑、列表 rail）。
    await expect(carolPage.getByText(AGENT_NAME)).toHaveCount(0)
    return (await banner.innerText()).trim()
  }
  const hiddenButReal = await denialShownTo(agentId)
  const neverExisted = await denialShownTo('01JZZZZZZZZZZZZZZZZZZZZZZZ')
  expect(
    hiddenButReal,
    '私有资源的详情页必须与「这个 id 从来不存在」逐字同形；两者一旦不同，' +
      'id 的存在性就从错误信息里泄露出去了',
  ).toBe(neverExisted)

  // (3) alice grants carol through the UserPicker and saves. The results
  // list is PORTALED to document.body (the original in-panel dropdown was
  // clipped by .dialog__body's scroll region and unclickable — the user-
  // reported "搜索用户无法点击" bug this flow now locks).
  await openAgentAcl(alicePage)
  await alicePage.getByTestId('acl-members-input').click()
  await alicePage.getByTestId('acl-members-input').fill('carol')
  await alicePage.getByTestId('acl-members-option-carol99').click()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  // (3b) NESTED dialog smoke — the owner-transfer dialog opens INSIDE the
  // permissions dialog. Pre-fix the two focus traps locked the page solid
  // (user report: "转让所有者的弹窗弹出来后，界面必死"), so every
  // interaction below would time out. The picker follows combobox keyboard
  // semantics: the first Escape closes its portaled listbox; the second closes
  // only the INNER dialog. The permissions dialog must survive.
  await openAgentAcl(alicePage)
  await alicePage.getByTestId('acl-transfer-owner').click()
  const transferInput = alicePage.getByTestId('acl-transfer-input')
  await expect(transferInput).toBeVisible()
  await transferInput.fill('carol')
  await expect(alicePage.getByTestId('acl-transfer-option-carol99')).toBeVisible()
  await alicePage.keyboard.press('Escape')
  await expect(alicePage.getByTestId('acl-transfer-option-carol99')).toHaveCount(0)
  await expect(transferInput).toBeVisible()
  await alicePage.keyboard.press('Escape')
  await expect(transferInput).toHaveCount(0)
  await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  await expect(alicePage.getByTestId('acl-transfer-owner')).toBeFocused()

  // (4) carol sees it again; her panel (behind the same header button) is
  // read-only (no save / transfer).
  await carolPage.goto(`${daemon.baseUrl}/agents/${agentId}`)
  await openAgentAcl(carolPage)
  await expect(carolPage.getByTestId('acl-panel')).toBeVisible()
  await expect(carolPage.getByTestId('acl-panel')).toContainText('alice99')
  await expect(carolPage.getByTestId('acl-save')).toHaveCount(0)
  await expect(carolPage.getByTestId('acl-transfer-owner')).toHaveCount(0)
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME }).first()).toBeVisible()

  // (5) Workflow editor surfaces the same panel behind the 「Permissions」
  // button (smoke).
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'rfc099-flow',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  const wf = (await wfRes.json()) as { id: string }
  await alicePage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
  await alicePage.getByTestId('workflow-more-actions').click()
  await expect(alicePage.getByTestId('workflow-actions-dialog')).toBeVisible()
  await alicePage.getByTestId('workflow-acl-button').click()
  const workflowAcl = alicePage.getByTestId('workflow-acl-dialog')
  await expect(workflowAcl).toBeVisible()
  await expect(alicePage.getByRole('dialog')).toHaveCount(1)
  await expect(workflowAcl.getByTestId('acl-panel')).toContainText('alice99')
  await expectAxeClean(alicePage, 'workflow ACL dialog')

  // RFC-199 T14.4/G4: owner transfer is the sole sanctioned nested dialog.
  // The topmost layer owns focus and Escape while the parent remains open.
  await workflowAcl.getByTestId('acl-transfer-owner').click()
  const transferDialog = alicePage.getByTestId('acl-transfer-dialog')
  await expect(transferDialog).toBeVisible()
  await expect(alicePage.getByRole('dialog')).toHaveCount(2)
  await expect(transferDialog.getByRole('heading', { name: 'Transfer ownership' })).toBeVisible()
  const workflowTransferInput = transferDialog.getByTestId('acl-transfer-input')
  await expect(workflowTransferInput).toBeFocused()
  await expect(workflowTransferInput).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(() =>
      transferDialog.evaluate((element) => element.contains(element.ownerDocument.activeElement)),
    )
    .toBe(true)
  await expectAxeClean(
    alicePage,
    'workflow owner-transfer dialog',
    '[data-testid="acl-transfer-dialog"]',
  )
  await alicePage.keyboard.press('Escape')
  await expect(workflowTransferInput).toHaveAttribute('aria-expanded', 'false')
  await expect(transferDialog).toBeVisible()
  await alicePage.keyboard.press('Escape')
  await expect(transferDialog).toHaveCount(0)
  await expect(workflowAcl).toBeVisible()
  await expect(workflowAcl.getByTestId('acl-transfer-owner')).toBeFocused()

  await aliceCtx.close()
  await carolCtx.close()
})
