// RFC-330 —— 工具注册 / 岗位模版立为第 14 / 15 类 ACL 资源的端到端旅程（两个真实浏览器上下文）。
//
// 锁 proposal.md §7 的 AC-12 / AC-13，以及 6 条新路由里的 4 条 `/acl`（案例成员两条在
// rfc310-digital-employee-journey.spec.ts 的案例段里）：
//   ① alice 建的岗位模版默认 private：bob 的类型页看不到它；
//   ② alice 在模版卡片的「权限」入口把 bob 加为**只读** → bob 看得见、有只读徽标、无编辑按钮，
//      自己的「权限」入口打开的是只读视图（GET /acl）；
//   ③ alice 升 bob 为可编辑（PUT /acl）→ bob **不刷新页面**拿到编辑按钮；
//   ④ alice 降回只读 → bob 不刷新页面回到只读态；
//   ⑤ 工具：alice 的私有工具 `/acl` 对 bob 是 404，授权后 200。
//
// ③④ 依赖 ACL 写入后 WS 的 `resource-acl.changed` 帧让三张列表重取（useWebSocket.ts）。

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

const TYPE_REF = 'development@10'

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

async function api<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T }
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

const TEMPLATE_NAME = 'rfc330 graded template'

function templateCard(page: Page) {
  return page.locator('article.employee-summary-card', { hasText: TEMPLATE_NAME })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-330: 岗位模版默认私有；只读 / 可编辑档位不刷新页面即在卡片上收敛；工具 /acl 同形', async ({
  browser,
}) => {
  const alice = await createUserAndLogin('alice330')
  const bob = await createUserAndLogin('bob330')

  // alice 建一份岗位模版（默认 private）。
  const created = await api<{ id: string; visibility: string; access: string }>(
    alice.sessionToken,
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/job-templates`,
    {
      method: 'POST',
      body: {
        name: TEMPLATE_NAME,
        description: 'rfc330 e2e fixture',
        defaultToolBindings: [],
      },
    },
  )
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const templateId = created.body.id
  const aclBase = `/api/digital-employee-job-templates/${encodeURIComponent(templateId)}/acl`

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, alice.sessionToken)
  const alicePage = await aliceCtx.newPage()
  const bobCtx = await browser.newContext()
  await primeAuth(bobCtx, bob.sessionToken)
  const bobPage = await bobCtx.newPage()

  // ① bob 看不到 private 模版；/acl 对他是 404。
  await bobPage.goto(`${daemon.baseUrl}/digital-employees/${TYPE_REF}?view=jobs`)
  await expect(bobPage.getByRole('tab', { name: /Job templates|岗位/ }).first()).toBeVisible()
  await expect(templateCard(bobPage)).toHaveCount(0)
  expect((await api(bob.sessionToken, aclBase)).status).toBe(404)

  // ② alice 在卡片的「权限」入口把 bob 加为只读（GET + PUT /acl 经 UI）。
  await alicePage.goto(`${daemon.baseUrl}/digital-employees/${TYPE_REF}?view=jobs`)
  await expect(templateCard(alicePage)).toBeVisible()
  await templateCard(alicePage).getByTestId('acl-dialog-button').click()
  const aliceAcl = alicePage.getByTestId('acl-panel')
  await expect(aliceAcl).toBeVisible()
  await aliceAcl.getByTestId('acl-members-input').click()
  await aliceAcl.getByTestId('acl-members-input').fill('bob')
  await alicePage.getByTestId('acl-members-option-bob330').click()
  await expect(aliceAcl.getByTestId(`acl-level-read-${bob.userId}`)).toBeVisible()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-panel')).toHaveCount(0)

  // bob：可见、只读徽标、无编辑按钮；自己的权限入口是只读视图。
  await bobPage.reload()
  await expect(templateCard(bobPage)).toBeVisible()
  await expect(templateCard(bobPage).getByText('Read-only access')).toBeVisible()
  await expect(templateCard(bobPage).getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await templateCard(bobPage).getByTestId('acl-dialog-button').click()
  await expect(bobPage.getByTestId('acl-panel')).toBeVisible()
  await expect(bobPage.getByTestId('acl-save')).toHaveCount(0)
  await bobPage.keyboard.press('Escape')
  expect((await api(bob.sessionToken, aclBase)).status).toBe(200)

  // ③ alice 升 bob 为可编辑（API PUT）→ bob 不刷新拿到编辑按钮。
  const current = await api<{ aclRevision: number }>(alice.sessionToken, aclBase)
  const upgraded = await api(alice.sessionToken, aclBase, {
    method: 'PUT',
    body: {
      grants: [{ userId: bob.userId, level: 'write' }],
      expectedResourceId: templateId,
      expectedAclRevision: current.body.aclRevision,
    },
  })
  expect(upgraded.status).toBe(200)
  await expect(templateCard(bobPage).getByRole('button', { name: 'Edit' })).toBeVisible({
    timeout: 20_000,
  })
  await expect(templateCard(bobPage).getByText('Read-only access')).toHaveCount(0)

  // ④ alice 降回只读 → bob 不刷新回到只读态。
  const afterUpgrade = await api<{ aclRevision: number }>(alice.sessionToken, aclBase)
  const downgraded = await api(alice.sessionToken, aclBase, {
    method: 'PUT',
    body: {
      grants: [{ userId: bob.userId, level: 'read' }],
      expectedResourceId: templateId,
      expectedAclRevision: afterUpgrade.body.aclRevision,
    },
  })
  expect(downgraded.status).toBe(200)
  await expect(templateCard(bobPage).getByText('Read-only access')).toBeVisible({
    timeout: 20_000,
  })
  await expect(templateCard(bobPage).getByRole('button', { name: 'Edit' })).toHaveCount(0, {
    timeout: 20_000,
  })

  // ⑤ 工具：alice 的私有工具 /acl 对 bob 404，授权后 200；bob 的 PUT 仍 403。
  const typePackage = await api<{
    authoringManifest: {
      workItems: Array<{
        workItemRef: string
        workContractRef: { contractId: string; version: number }
        toolRoleGroups: Array<{
          roleRef: string
          workContractRef: { contractId: string; version: number } | null
        }>
      }>
    }
    workContracts: Array<{ contractId: string; version: number; allowedToolKinds: string[] }>
  }>(alice.sessionToken, `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}`)
  const agents = await api<Array<{ id: string; updatedAt: number }>>(
    alice.sessionToken,
    '/api/agents/builtins/digital-employee-templates',
  )
  const item = typePackage.body.authoringManifest.workItems.find((candidate) =>
    candidate.toolRoleGroups.some((role) => {
      const ref = role.workContractRef ?? candidate.workContractRef
      return typePackage.body.workContracts.some(
        (contract) =>
          contract.contractId === ref.contractId &&
          contract.version === ref.version &&
          contract.allowedToolKinds.includes('agent'),
      )
    }),
  )
  expect(item, 'a work item accepting an agent tool').toBeDefined()
  const role = item!.toolRoleGroups[0]!
  const agent = agents.body[0]!
  const tool = await api<{ id: string }>(
    alice.sessionToken,
    `/api/digital-employee-types/${encodeURIComponent(TYPE_REF)}/work-items/${encodeURIComponent(item!.workItemRef)}/tools`,
    {
      method: 'POST',
      body: {
        displayName: 'rfc330 private tool',
        description: 'rfc330 e2e fixture',
        roleRef: role.roleRef,
        implementation: { kind: 'agent', agentRef: { id: agent.id, revision: agent.updatedAt } },
      },
    },
  )
  expect(tool.status, JSON.stringify(tool.body)).toBe(201)
  const toolAcl = `/api/digital-employee-tools/${encodeURIComponent(tool.body.id)}/acl`
  expect((await api(bob.sessionToken, toolAcl)).status).toBe(404)
  const toolCurrent = await api<{ aclRevision: number }>(alice.sessionToken, toolAcl)
  expect(toolCurrent.status).toBe(200)
  const toolGrant = await api(alice.sessionToken, toolAcl, {
    method: 'PUT',
    body: {
      grants: [{ userId: bob.userId, level: 'read' }],
      expectedResourceId: tool.body.id,
      expectedAclRevision: toolCurrent.body.aclRevision,
    },
  })
  expect(toolGrant.status).toBe(200)
  expect((await api(bob.sessionToken, toolAcl)).status).toBe(200)
  const bobToolPut = await api(bob.sessionToken, toolAcl, {
    method: 'PUT',
    body: { visibility: 'public', expectedResourceId: tool.body.id, expectedAclRevision: 1 },
  })
  expect(bobToolPut.status).toBe(403)

  await aliceCtx.close()
  await bobCtx.close()
})
