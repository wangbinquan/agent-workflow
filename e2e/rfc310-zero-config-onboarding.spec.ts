// RFC-310 current first-use browser contract.
//
// A new administrator starts from the Digital Employees catalog, sees the
// whole deterministic responsibility map, selects the work item in context,
// and adds a tool on the same page. The test deliberately has no legacy
// `/code` journey or stage selector: the fixed graph is the navigation model.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      localStorage.setItem('agent-workflow.token', token)
      localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'development' })
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('a first-time user configures a work-item tool directly on the fixed responsibility map', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees`)

  await expect(page.getByTestId('digital-employee-type-list')).toBeVisible()
  await page.getByTestId('digital-employee-type-development').click()
  await expect(page.getByTestId('digital-employee-responsibility-graph')).toBeVisible()
  await expect(page.locator('[data-testid^="employee-work-item-"]')).toHaveCount(20)
  await expect(page.getByText('Delivery and diagnosis', { exact: true })).toBeVisible()
  await expect(page.getByText('MR care and repair', { exact: true })).toBeVisible()

  await page.getByTestId('employee-work-item-analyze-implement').click()
  await page.waitForURL(/view=toolbox&workItem=analyze-implement/)
  const toolbox = page.getByTestId('employee-node-toolbox')
  await expect(toolbox).toBeVisible()
  await expect(toolbox).toContainText(
    'Digital employee / Development employee / Analyze and implement / Tool',
  )
  await expect(toolbox).toContainText('Input material')
  await expect(toolbox).toContainText('Deterministic output and completion')
  await expect(toolbox.getByRole('combobox', { name: /stage/i })).toHaveCount(0)

  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add tool to Analyze and implement' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: /Tool name/ }).fill('First implementation tool')
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()

  await expect(dialog).toHaveCount(0)
  await expect(toolbox.getByText('First implementation tool', { exact: true })).toBeVisible()
  await expect(toolbox.getByText('Available', { exact: true })).toBeVisible()
})

test('a failed contract check is corrected on the same tool registration id', async ({ page }) => {
  await primeAuth(page)
  const name = `Same-id correction ${Date.now()}`
  let corrupted = false
  await page.route('**/work-items/analyze-implement/tools', async (route) => {
    const request = route.request()
    if (!corrupted && request.method() === 'POST') {
      corrupted = true
      const body = request.postDataJSON() as {
        implementation: { agentRef: { id: string; revision: number } }
      }
      body.implementation.agentRef = { id: 'missing:test-agent', revision: 1 }
      await route.continue({ postData: JSON.stringify(body) })
      return
    }
    await route.continue()
  })

  await page.goto(
    `${daemon.baseUrl}/digital-employees/development%403?view=toolbox&workItem=analyze-implement`,
  )
  const toolbox = page.getByTestId('employee-node-toolbox')
  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add tool to Analyze and implement' })
  await dialog.getByRole('textbox', { name: /Tool name/ }).fill(name)
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()

  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('This tool is not publishable yet')).toBeVisible()
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/development%403/work-items/analyze-implement/tools`
  const failedResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(failedResponse.ok()).toBe(true)
  const failed = (await failedResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  const failedRows = failed.items.filter((tool) => tool.content.displayName === name)
  expect(failedRows).toHaveLength(1)
  expect(failedRows[0]?.publishedRevision).toBeNull()

  await dialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const correctedResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  const corrected = (await correctedResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  const correctedRows = corrected.items.filter((tool) => tool.content.displayName === name)
  expect(correctedRows).toEqual([
    expect.objectContaining({ id: failedRows[0]?.id, publishedRevision: 1 }),
  ])
  await expect(toolbox.locator('.node-tool-row').filter({ hasText: name })).toHaveCount(1)
})

test('an existing invalid tool opens in the editor and publishes its correction', async ({
  page,
}) => {
  await primeAuth(page)
  const name = `Editable invalid tool ${Date.now()}`
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/development%403/work-items/analyze-implement/tools`
  const seededResponse = await page.request.post(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
    data: {
      displayName: name,
      description: 'Seeded invalid registration',
      roleRef: 'primary',
      implementation: {
        kind: 'agent',
        agentRef: { id: 'missing:editable-agent', revision: 1 },
      },
      connectionRef: null,
    },
  })
  expect(seededResponse.status()).toBe(201)
  const seeded = (await seededResponse.json()) as {
    id: string
    validationReceipt: { status: string }
  }
  expect(seeded.validationReceipt.status).toBe('invalid')

  await page.goto(
    `${daemon.baseUrl}/digital-employees/development%403?view=toolbox&workItem=analyze-implement`,
  )
  const toolbox = page.getByTestId('employee-node-toolbox')
  const row = toolbox.locator('.node-tool-row').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  await expect(row.getByText('Invalid', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: `Edit tool: ${name}` })
  await expect(dialog.getByRole('textbox', { name: /Tool name/ })).toHaveValue(name)
  await dialog.getByRole('combobox').click()
  await page.getByRole('option', { name: /^Built in · Code writing Compatible/ }).click()
  await dialog
    .getByRole('button', { name: 'Check contract and publish new version', exact: true })
    .click()

  await expect(dialog).toHaveCount(0)
  await expect(row.getByText('Available', { exact: true })).toBeVisible()
  const finalResponse = await page.request.get(listUrl, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  const final = (await finalResponse.json()) as {
    items: Array<{ id: string; content: { displayName: string }; publishedRevision: number | null }>
  }
  expect(final.items.filter((tool) => tool.content.displayName === name)).toEqual([
    expect.objectContaining({ id: seeded.id, publishedRevision: 1 }),
  ])
})
