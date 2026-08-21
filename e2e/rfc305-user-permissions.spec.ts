// RFC-305 real-daemon/browser acceptance: one catalog powers create + edit,
// OCC preserves drafts, authority refreshes live, and PAT/background caps use
// the current account grant set while preserving the PAT system-domain boundary.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'

import { describeBlocking } from './axe-blocking'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

async function request(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${daemon.baseUrl}${path}`, { ...init, headers })
}

async function primeAuth(target: Page | BrowserContext, token: string): Promise<void> {
  await target.addInitScript(
    ({ baseUrl, sessionToken }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', sessionToken)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, sessionToken: token },
  )
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  const response = await request(daemon.token, '/api/config', {
    method: 'PUT',
    body: JSON.stringify({ theme }),
  })
  expect(response.ok, `set ${theme} theme failed: ${response.status}`).toBe(true)
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.ok, `login ${username} failed: ${response.status}`).toBe(true)
  return ((await response.json()) as { sessionToken: string }).sessionToken
}

async function expectNoHorizontalOverflow(locator: Locator, label: string): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(
    metrics.scrollWidth,
    `${label} overflows (${metrics.scrollWidth}px > ${metrics.clientWidth}px)`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1)
}

async function expectAxeClean(page: Page, include: string, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(include)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(describeBlocking(results), label).toEqual([])
}

function waitForWorkflowHello(page: Page): Promise<void> {
  return new Promise<void>((resolveHello, rejectHello) => {
    const timeout = setTimeout(
      () => rejectHello(new Error('timed out waiting for /ws/workflows hello')),
      15_000,
    )
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/ws/workflows') return
      socket.on('framereceived', (frame) => {
        if (!String(frame.payload).includes('"type":"hello"')) return
        clearTimeout(timeout)
        resolveHello()
      })
    })
  })
}

async function nextMeWith(
  page: Page,
  required: readonly string[],
  absent: readonly string[] = [],
): Promise<void> {
  // The application request proves the lossy authority notification caused an
  // actor-cache refresh. Do not read its body in the wait predicate: Chromium
  // and WebKit can retire the protocol resource between response notification
  // and Network.getResponseBody. Read a fresh authenticated snapshot only
  // after the application response has completed.
  await page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/auth/me' && response.status() === 200
  })

  await expect
    .poll(
      async () => {
        const values = await page.evaluate(async () => {
          const baseUrl = window.localStorage.getItem('agent-workflow.baseUrl')
          const token = window.localStorage.getItem('agent-workflow.token')
          if (baseUrl === null || token === null) throw new Error('missing browser auth fixture')
          const response = await fetch(`${baseUrl}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!response.ok) throw new Error(`actor snapshot returned ${response.status}`)
          return ((await response.json()) as { permissions?: string[] }).permissions ?? []
        })
        const permissions = new Set(values)
        return (
          required.every((permission) => permissions.has(permission)) &&
          absent.every((permission) => !permissions.has(permission))
        )
      },
      { message: 'current actor converges after authority.changed' },
    )
    .toBe(true)
}

async function createScriptWorkflow(token: string, name: string): Promise<Response> {
  return request(token, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-305 live-authority fixture',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: [
          {
            id: 'script',
            kind: 'script',
            language: 'bash',
            script: 'echo rfc305',
          },
        ],
        edges: [],
      },
    }),
  })
}

test('390px create/edit catalog, OCC, dark mode and live script authority', async ({
  browser,
  page,
}) => {
  const username = 'rfc305-browser-user'
  const password = 'longEnoughPassword'
  await setTheme('light')
  await page.setViewportSize({ width: 390, height: 844 })
  await primeAuth(page, daemon.token)
  await page.goto(`${daemon.baseUrl}/users`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'New user', exact: true }).click()

  let dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // RFC-309 merges the two capability-template layers and adds the manual
  // code-round launch point ⇒ 78 rows. Three merged template writes also move
  // into the user baseline, leaving 24 individually grantable points.
  // RFC-310: +22 config-resource points (PR-1B) and +5 development-missions
  // points (PR-2) ⇒ 105 rows; the user preset difference gained exactly one
  // grantable point (repository-employee-assignments:update) ⇒ 25.
  // PR-7b +3 (handoff/attach/resume) ⇒ 108; PR-9 +1 (cutover) ⇒ 109;
  // PR-10 −1 (code-rounds:launch retired with the legacy writer) ⇒ 108.
  // RFC-312 +1 (`users:presence`) ⇒ 109. 它**不进任何静态 preset**（RFC-305 没有 deny 集，
  // 进了就永远无法按账号收回），只作为可授予项出现在目录里 —— 所以行数 +1、生效数不变。
  // RFC-310 Event Center +4（event-sources read/create/update/archive）⇒ 113；四点都在
  // user baseline，因此只增加目录行，不增加可单独勾选数。
  await expect(dialog.locator('.user-permission-row')).toHaveCount(113)
  // PR-9 +1 grantable (development-missions:cutover is admin-tier, so it is a
  // preset difference); PR-10 −1 row but +0 grantable (code-rounds:launch was
  // in the user baseline) ⇒ 26.
  // RFC-312 +1 grantable (`users:presence`)：它**不进 user 静态 preset**（RFC-305 没有
  // deny 集，进了就永远无法按账号收回），所以既 +1 行、也 +1 可勾选 ⇒ 27。
  // 这两处计数必须一起改——上一轮只改了行数，CI 在第一处就停下，第二处直到下一次 run 才现形。
  await expect(dialog.locator('input[type="checkbox"]:not(:disabled)')).toHaveCount(27)
  await dialog.getByRole('textbox', { name: /Username/ }).fill(username)
  await dialog.getByRole('textbox', { name: /Display name/ }).fill('RFC-305 Browser User')
  await dialog.getByLabel(/^Password/).fill(password)
  await dialog.getByTestId('user-permission-search').fill('scripts:author')
  const createScriptGrant = dialog.getByTestId('user-permission-scripts:author')
  await expect(createScriptGrant).toBeVisible()
  await createScriptGrant.check()
  await expect(dialog.getByText('scripts:author', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(dialog, 'light create dialog')
  await expectNoHorizontalOverflow(dialog.locator('.dialog__body'), 'light create body')
  await expectNoHorizontalOverflow(page.locator('html'), 'light document')
  await expectAxeClean(page, '.dialog__panel', 'light create permission dialog')

  const createdResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/users',
  )
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  const createdResponse = await createdResponsePromise
  expect(createdResponse.status()).toBe(201)
  const created = (await createdResponse.json()) as {
    id: string
    additionalPermissions: string[]
    accessRevision: number
  }
  // RFC-312：新建 user/manager 由 `initialGrantsForRole` **显式发放** `users:presence`
  // （它不进任何静态 preset——RFC-305 没有 deny 集，进了 baseline 就永远无法按账号收回），
  // 所以建号回执里必然多这一项。顺序与服务端一致，另见 packages/backend/tests/users-http.test.ts:246。
  // 这是同一个改动在本文件里的**第三处**计数/集合断言（另两处见 :180 / :187）——
  // 以后再加权限点，先把这三处一起过一遍，别一次只修一处等 CI 逐个报。
  expect(created.additionalPermissions).toEqual(['users:presence', 'scripts:author'])
  expect(created.accessRevision).toBe(0)
  await expect(dialog).toHaveCount(0)

  const userToken = await login(username, password)
  const authored = await createScriptWorkflow(userToken, 'rfc305-live-script')
  expect(authored.status).toBe(201)
  const workflowId = ((await authored.json()) as { id: string }).id

  const targetContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await primeAuth(targetContext, userToken)
  const targetPage = await targetContext.newPage()
  const workflowHello = waitForWorkflowHello(targetPage)
  await targetPage.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  await expect(targetPage.getByRole('heading', { name: 'rfc305-live-script' })).toBeVisible()
  await workflowHello

  await setTheme('dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTestId(`user-manage-${created.id}`).click()
  dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expectNoHorizontalOverflow(dialog, 'dark edit dialog')
  await expectNoHorizontalOverflow(dialog.locator('.dialog__body'), 'dark edit body')
  await expectNoHorizontalOverflow(page.locator('html'), 'dark document')
  await expectAxeClean(page, '.dialog__panel', 'dark edit permission dialog')

  const targetGainedCodeHost = nextMeWith(targetPage, ['scripts:author', 'code-host-calls:author'])
  const concurrent = await request(daemon.token, `/api/users/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author', 'code-host-calls:author'],
        expectedRevision: 0,
      },
    }),
  })
  expect(concurrent.status).toBe(200)
  await targetGainedCodeHost

  await dialog.getByTestId('user-permission-search').fill('repos:update')
  const staleDraft = dialog.getByTestId('user-permission-repos:update')
  await staleDraft.check()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByText('Permissions changed elsewhere')).toBeVisible()
  await expect(staleDraft).toBeChecked()

  await dialog.getByRole('button', { name: 'Reload latest', exact: true }).click()
  await expect(dialog.getByTestId('user-permission-code-host-calls:author')).toBeChecked()
  await dialog.getByTestId('users-edit-role-manager').click()
  await expect(dialog.getByTestId('user-permission-scripts:author')).toBeChecked()
  await expect(dialog.getByTestId('user-permission-scripts:author')).toBeDisabled()
  await dialog.getByTestId('users-edit-role-user').click()
  await expect(dialog.getByTestId('user-permission-scripts:author')).not.toBeChecked()
  await expect(dialog.getByTestId('user-permission-code-host-calls:author')).not.toBeChecked()
  await dialog.getByTestId('user-permission-scripts:author').check()

  const targetLostCodeHost = nextMeWith(targetPage, ['scripts:author'], ['code-host-calls:author'])
  const savedResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/users/${created.id}`,
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await savedResponsePromise).status()).toBe(200)
  await targetLostCodeHost
  await expect(dialog).toHaveCount(0)

  await page.getByTestId(`user-manage-${created.id}`).click()
  dialog = page.getByRole('dialog')
  await dialog.getByTestId('user-permission-search').fill('scripts:author')
  await dialog.getByTestId('user-permission-scripts:author').uncheck()
  const targetLostScript = nextMeWith(targetPage, [], ['scripts:author', 'code-host-calls:author'])
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await targetLostScript

  const denied = await createScriptWorkflow(userToken, 'rfc305-revoked-script')
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ code: 'script-author-forbidden' })

  // Authoring is a save-time capability. Revocation must not turn an already
  // saved, owned workflow into an unexecutable artifact.
  const execution = await request(userToken, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId,
      name: 'rfc305-existing-script-after-revoke',
      scratch: true,
      inputs: {},
    }),
  })
  expect(execution.status).toBe(201)
  await targetContext.close()
})

test('real daemon PAT range/resource cap follows grant revoke and regrant', async () => {
  const taskWorkflow = await createScriptWorkflow(daemon.token, 'rfc305-range-source')
  expect(taskWorkflow.status).toBe(201)
  const taskWorkflowId = ((await taskWorkflow.json()) as { id: string }).id
  const taskResponse = await request(daemon.token, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: taskWorkflowId,
      name: 'rfc305-other-owner-task',
      scratch: true,
      inputs: {},
    }),
  })
  expect(taskResponse.status).toBe(201)
  const taskId = ((await taskResponse.json()) as { id: string }).id

  const createUser = await request(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: 'rfc305-pat-user',
      displayName: 'RFC-305 PAT User',
      role: 'user',
      password: 'longEnoughPassword',
      additionalPermissions: ['tasks:read:all', 'repos:update'],
    }),
  })
  expect(createUser.status).toBe(201)
  const user = (await createUser.json()) as { id: string; accessRevision: number }
  const userSession = await login('rfc305-pat-user', 'longEnoughPassword')

  const refusedSystemScope = await request(userSession, '/api/auth/pats', {
    method: 'POST',
    body: JSON.stringify({
      name: 'forged-system-scope',
      purpose: 'general',
      scopes: ['scripts:author'],
    }),
  })
  expect(refusedSystemScope.status).toBe(422)
  expect(await refusedSystemScope.json()).toMatchObject({ code: 'pat-scope-ungrantable' })

  const patResponse = await request(userSession, '/api/auth/pats', {
    method: 'POST',
    body: JSON.stringify({
      name: 'current-account-cap',
      purpose: 'general',
      scopes: ['repos:update'],
    }),
  })
  expect(patResponse.status).toBe(201)
  const pat = ((await patResponse.json()) as { token: string }).token

  const listContainsTask = async (): Promise<boolean> => {
    const response = await request(pat, '/api/tasks')
    expect(response.status).toBe(200)
    const rows = (await response.json()) as Array<{ id: string }>
    return rows.some((row) => row.id === taskId)
  }
  const exerciseRepoUpdate = async (): Promise<number> => {
    const response = await request(pat, '/api/repo-groups/missing-rfc305', {
      method: 'PUT',
      body: JSON.stringify({ name: 'missing' }),
    })
    return response.status
  }

  expect(await listContainsTask()).toBe(true)
  expect(await exerciseRepoUpdate()).not.toBe(403)

  const revoked = await request(daemon.token, `/api/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access: { role: 'user', additionalPermissions: [], expectedRevision: 0 },
    }),
  })
  expect(revoked.status).toBe(200)
  expect(await listContainsTask()).toBe(false)
  expect(await exerciseRepoUpdate()).toBe(403)

  const regranted = await request(daemon.token, `/api/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access: {
        role: 'user',
        additionalPermissions: ['tasks:read:all', 'repos:update'],
        expectedRevision: 1,
      },
    }),
  })
  expect(regranted.status).toBe(200)
  expect(await listContainsTask()).toBe(true)
  expect(await exerciseRepoUpdate()).not.toBe(403)
})

test('guest browser exposes public resources without mutation or task affordances', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 900 })
  const username = 'rfc305-browser-guest'
  const password = 'longEnoughPassword'
  const createdGuest = await request(daemon.token, '/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username,
      displayName: 'RFC-305 Browser Guest',
      role: 'guest',
      password,
    }),
  })
  expect(createdGuest.status).toBe(201)

  const createAgent = async (name: string): Promise<string> => {
    const response = await request(daemon.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-305 guest browser fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'public-read-only fixture',
      }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { id: string }).id
  }

  const publicName = 'rfc305-guest-public-agent'
  const privateName = 'rfc305-guest-private-agent'
  const publicId = await createAgent(publicName)
  await createAgent(privateName)
  const madePublic = await request(daemon.token, `/api/agents/${publicId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: publicId,
      expectedAclRevision: 0,
    }),
  })
  expect(madePublic.status).toBe(200)

  const publicWorkflow = await createScriptWorkflow(daemon.token, 'rfc305-guest-public-workflow')
  expect(publicWorkflow.status).toBe(201)
  const publicWorkflowId = ((await publicWorkflow.json()) as { id: string }).id
  const madeWorkflowPublic = await request(daemon.token, `/api/workflows/${publicWorkflowId}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: publicWorkflowId,
      expectedAclRevision: 0,
    }),
  })
  expect(madeWorkflowPublic.status).toBe(200)

  const guestToken = await login(username, password)
  await primeAuth(page, guestToken)
  const runtimeRegistryRequests: string[] = []
  const protectedDestinationRequests: string[] = []
  page.on('request', (browserRequest) => {
    const pathname = new URL(browserRequest.url()).pathname
    if (pathname === '/api/runtimes') {
      runtimeRegistryRequests.push(browserRequest.url())
    }
    if (
      pathname === '/api/tasks/page' ||
      pathname === '/api/cached-repos' ||
      pathname === '/api/memories' ||
      pathname === '/api/fusions/pending-count'
    ) {
      protectedDestinationRequests.push(browserRequest.url())
    }
  })
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: publicName }).first()).toBeVisible()
  await expect(page.getByText(privateName, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'New agent', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible()
  expect(
    await page
      .getByTestId('shell-navigation-desktop')
      .locator('a')
      .evaluateAll((links) =>
        links.map((link) => new URL((link as HTMLAnchorElement).href).pathname),
      ),
  ).toEqual([
    '/',
    '/agents',
    '/skills',
    '/mcps',
    '/plugins',
    '/workflows',
    '/workgroups',
    '/intent',
    // RFC-310：数字员工是一个顶层分组，分类、工作项与工具都在同一个固定职责图入口
    // 下完成；实际执行仍归统一任务列表，`/outcomes` 归运行组。这条清单是**完整产品地图**的
    // 快照——guest 照样看得见全部条目，只是无权目标页为空且不发请求（RFC-305 的
    // stable-nav 契约），所以导航改版必然要同步改它。
    '/digital-employees',
    '/tasks',
    '/outcomes',
    '/scheduled',
    '/repos',
    '/events',
    '/memory',
  ])

  // The menu remains a complete product map, but destinations for which the
  // guest lacks the catalog read permission stay empty and request-free.
  await page.goto(`${daemon.baseUrl}/tasks`)
  await expect(page.getByTestId('app-shell-main').locator(':scope > *')).toHaveCount(0)
  await page.goto(`${daemon.baseUrl}/repos`)
  await expect(page.getByTestId('app-shell-main').locator(':scope > *')).toHaveCount(0)
  await page.goto(`${daemon.baseUrl}/memory`)
  await expect(page.getByTestId('app-shell-main').locator(':scope > *')).toHaveCount(0)
  expect(protectedDestinationRequests).toEqual([])

  await page.locator('.user-menu__trigger').click()
  await expect(page.locator('.user-menu__role')).toHaveText('guest')

  await page.goto(`${daemon.baseUrl}/workflows?create=1&source=guest-check`)
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'rfc305-guest-public-workflow', exact: true }).first(),
  ).toBeVisible()
  await expect(page.getByTestId('workflow-new-button')).toHaveCount(0)
  await expect(page.getByTestId('workflow-create-dialog')).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.has('create')).toBe(false)

  await page.goto(`${daemon.baseUrl}/workflows/${publicWorkflowId}`)
  await expect(
    page.getByRole('heading', { name: 'rfc305-guest-public-workflow', exact: true }),
  ).toBeVisible()
  const readOnlyGeometry = await page.locator('.editor-layout').evaluate((layout) => {
    const canvas = layout.querySelector<HTMLElement>('.canvas-frame')
    if (canvas === null) throw new Error('missing read-only workflow canvas')
    return {
      className: layout.className,
      layoutWidth: layout.getBoundingClientRect().width,
      canvasWidth: canvas.getBoundingClientRect().width,
    }
  })
  expect(readOnlyGeometry.className).toContain('editor-layout--read-only')
  expect(readOnlyGeometry.canvasWidth).toBeGreaterThanOrEqual(readOnlyGeometry.layoutWidth - 2)

  await page.goto(`${daemon.baseUrl}/agents/${publicId}`)
  await expect(page.getByRole('heading', { name: publicName, exact: true })).toBeVisible()
  await expect(page.getByTestId('agent-runtime-load-error')).toHaveCount(0)
  expect(runtimeRegistryRequests).toEqual([])
  await expect(page.getByTestId('agent-save-button')).toHaveCount(0)
  await page.getByTestId('detail-more-actions').click()
  await expect(page.getByTestId('export-package-agent')).toBeVisible()
  await expect(page.getByTestId('acl-dialog-button')).toHaveCount(0)
  await expect(page.getByTestId('detail-delete-button')).toHaveCount(0)
})
