// RFC-223 PR-9 / T17 — real browser + daemon lock for canonical resource IDs.
//
// An administrator can see two tenants' same-name MCPs at once. Every action
// below must stay bound to the selected stable id: navigation, edit, probe,
// and delete. The sibling row is checked through both the UI and the API.

import { expect, test, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

interface SessionUser {
  id: string
  username: string
  sessionToken: string
}

interface McpReceipt {
  id: string
  name: string
  description: string
  operationConfigHash: string
}

async function createUser(username: string): Promise<SessionUser> {
  const password = 'longEnoughPassword'
  const created = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      displayName: username,
      role: 'user',
      password,
    }),
  })
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as { id: string }

  const login = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(login.status).toBe(200)
  const { sessionToken } = (await login.json()) as { sessionToken: string }
  return { id, username, sessionToken }
}

async function createMcp(owner: SessionUser, description: string): Promise<McpReceipt> {
  const response = await fetch(`${daemon.baseUrl}/api/mcps`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'shared-mcp',
      description,
      type: 'remote',
      config: {
        url: 'http://127.0.0.1:1/mcp',
        timeoutMs: 1_000,
        oauth: false,
      },
      enabled: true,
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as McpReceipt
}

async function readMcp(id: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/mcps/${id}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
}

async function primeAdmin(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('admin same-name MCP actions remain bound to the selected tenant id', async ({ page }) => {
  const ownerA = await createUser('rfc223_owner_a')
  const ownerB = await createUser('rfc223_owner_b')
  const mcpA = await createMcp(ownerA, 'tenant A untouched')
  const mcpB = await createMcp(ownerB, 'tenant B selected')

  await primeAdmin(page)
  await page.goto(`${daemon.baseUrl}/mcps`)

  const cardA = page.getByTestId(`split-card-${mcpA.id}`)
  const cardB = page.getByTestId(`split-card-${mcpB.id}`)
  await expect(cardA).toContainText('shared-mcp')
  await expect(cardA).toContainText(ownerA.username)
  await expect(cardB).toContainText('shared-mcp')
  await expect(cardB).toContainText(ownerB.username)

  await cardB.click()
  await expect(page).toHaveURL(new RegExp(`/mcps/${mcpB.id}$`))
  await expect(page.getByRole('heading', { level: 2, name: 'shared-mcp' })).toBeVisible()

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpB.id}`,
  )
  await page.getByRole('textbox', { name: 'Description' }).fill('tenant B edited')
  await page.getByTestId('mcp-save-button').click()
  expect((await saveResponse).status()).toBe(200)

  const afterSaveA = await readMcp(mcpA.id)
  const afterSaveB = await readMcp(mcpB.id)
  expect(afterSaveA.status).toBe(200)
  expect(afterSaveB.status).toBe(200)
  expect(((await afterSaveA.json()) as McpReceipt).description).toBe('tenant A untouched')
  expect(((await afterSaveB.json()) as McpReceipt).description).toBe('tenant B edited')

  await page.getByTestId('mcp-tab-probe').click()
  const probeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpB.id}/probe`,
  )
  await page.getByTestId(`mcp-inventory-reprobe-${mcpB.id}`).click()
  const probed = await probeResponse
  expect(probed.status()).toBe(200)
  expect(((await probed.json()) as { mcpId: string }).mcpId).toBe(mcpB.id)

  await page.getByTestId('detail-delete-button').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('confirm-input').fill('shared-mcp')
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/api/mcps/${mcpB.id}`,
  )
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  expect((await deleteResponse).status()).toBe(204)

  await expect(page).toHaveURL(new RegExp('/mcps/?$'))
  await expect(page.getByTestId(`split-card-${mcpB.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`split-card-${mcpA.id}`)).toContainText('tenant A untouched')
  expect((await readMcp(mcpA.id)).status).toBe(200)
  expect((await readMcp(mcpB.id)).status).toBe(404)
})
