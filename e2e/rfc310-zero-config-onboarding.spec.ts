// RFC-310 current first-use browser contract.
//
// A new administrator starts from the Digital Employees catalog, sees the
// whole deterministic responsibility card map, selects the work item in context,
// and adds a tool on the same page. The test deliberately has no legacy
// `/code` journey, stage selector, or editable line: the fixed cards are the navigation model.

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

test('a first-time user publishes a job template with the built-in implementation tool', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees/development%405`)
  await page.getByRole('tab', { name: 'Job templates' }).click()
  await page.getByRole('button', { name: 'New job template', exact: true }).click()

  const identityDialog = page.getByTestId('employee-job-identity-dialog')
  await identityDialog.getByLabel('Template name').fill('First development role')
  const draftResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/digital-employee-types\/[^/]+\/job-templates$/.test(new URL(response.url()).pathname),
  )
  await identityDialog
    .getByRole('button', { name: 'Create and configure duties', exact: true })
    .click()
  const createdDraft = await draftResponse
  expect(createdDraft.status()).toBe(201)
  expect(createdDraft.request().postDataJSON()).toMatchObject({
    name: 'First development role',
    defaultToolBindings: [],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [],
  })

  const editor = page.getByTestId('employee-job-template-editor')
  await expect(editor).toBeVisible()
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const durableDraft = page
    .locator('.employee-summary-card')
    .filter({ hasText: 'First development role' })
  await expect(durableDraft).toContainText('Draft')
  await durableDraft.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(editor).toBeVisible()
  await editor.locator('[data-work-item-ref="analyze-implement"]').click()
  const dutyDialog = page.getByTestId('employee-job-duty-dialog')
  await dutyDialog.getByRole('combobox').click()
  await expect(page.getByRole('option')).not.toHaveCount(0)
  await page.getByRole('option').first().click()
  await dutyDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click()

  await expect(editor).toHaveCount(0)
  const created = page
    .locator('.employee-summary-card')
    .filter({ hasText: 'First development role' })
  await expect(created).toContainText('Published · v1')
})

test('a first-time user configures a work-item tool directly on the fixed responsibility cards', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/digital-employees`)

  await expect(page.getByTestId('digital-employee-type-list')).toBeVisible()
  await page.getByTestId('digital-employee-type-development').click()
  await expect(page.getByTestId('employee-toolbox-responsibility-map')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Toolbox' }).click()
  const responsibilityMap = page.getByTestId('employee-toolbox-responsibility-map')
  await expect(responsibilityMap).toBeVisible()
  await expect(responsibilityMap.locator('[data-work-item-ref]')).toHaveCount(20)
  await expect(page.getByText('Delivery and diagnosis', { exact: true })).toBeVisible()
  await expect(page.getByText('MR care and repair', { exact: true })).toBeVisible()

  await responsibilityMap.locator('[data-work-item-ref="analyze-implement"]').click()
  await page.waitForURL(/view=toolbox&workItem=analyze-implement/)
  const dutyDialog = page.getByRole('dialog', { name: 'Configure duty: Analyze and implement' })
  await expect(dutyDialog).toBeVisible()
  const toolbox = page.getByTestId('employee-node-toolbox')
  await expect(toolbox).toBeVisible()
  await expect(toolbox).toContainText('Understand the request or diagnose the problem')
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
  const createdTool = toolbox
    .locator('.node-tool-row')
    .filter({ hasText: 'First implementation tool' })
  await expect(createdTool).toHaveCount(1)
  await expect(createdTool.getByText('Available', { exact: true })).toBeVisible()
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
    `${daemon.baseUrl}/digital-employees/development%405?view=toolbox&workItem=analyze-implement`,
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
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/development%405/work-items/analyze-implement/tools`
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
  const listUrl = `${daemon.baseUrl}/api/digital-employee-types/development%405/work-items/analyze-implement/tools`
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
    `${daemon.baseUrl}/digital-employees/development%405?view=toolbox&workItem=analyze-implement`,
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

test('pipeline failure types expand into equal-width required nodes and only show compatible tools', async ({
  page,
}) => {
  await primeAuth(page)
  const toolName = `Compile-only pipeline repair ${Date.now()}`
  await page.goto(
    `${daemon.baseUrl}/digital-employees/development%405?view=toolbox&workItem=repair-pipeline`,
  )

  const toolbox = page.getByTestId('employee-node-toolbox')
  await toolbox.getByRole('button', { name: 'Add tool', exact: true }).click()
  const toolDialog = page.getByRole('dialog', { name: 'Add tool to Repair pipeline failures' })
  await toolDialog.getByLabel('Tool name').fill(toolName)
  await toolDialog.getByLabel('Supported pipeline failure types').fill('compile-error')
  await toolDialog.getByRole('combobox').click()
  await page.getByRole('option', { name: /^Built in · General pipeline repair Compatible/ }).click()
  await toolDialog.getByRole('button', { name: 'Check contract and add', exact: true }).click()
  await expect(toolDialog).toHaveCount(0)

  const toolRow = toolbox.locator('.node-tool-row').filter({ hasText: toolName })
  await expect(toolRow).toContainText('Failure types：compile-error')
  await toolbox.getByRole('link', { name: 'Assign failure types', exact: true }).click()
  await page.waitForURL(/view=jobs&workItem=classify-pipeline/)
  await expect(
    page.getByRole('heading', { name: 'Configure “Classify pipeline failures”' }),
  ).toBeVisible()

  await page
    .getByRole('button', { name: 'New job template and configure this duty', exact: true })
    .click()
  const identityDialog = page.getByTestId('employee-job-identity-dialog')
  await identityDialog.getByLabel('Template name').fill('Typed pipeline repair role')
  await identityDialog
    .getByRole('button', { name: 'Create and configure duties', exact: true })
    .click()

  const classifierDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(classifierDialog).toBeVisible()
  const dispatchEditor = classifierDialog.getByTestId('job-dispatch-classify-pipeline')
  await dispatchEditor.getByRole('button', { name: 'Add failure type', exact: true }).click()
  await dispatchEditor.getByRole('button', { name: 'Add failure type', exact: true }).click()
  const routeEditors = dispatchEditor.locator('.job-dispatch-route')
  await expect(routeEditors).toHaveCount(2)
  await routeEditors.nth(0).getByLabel('Type key').fill('compile-error')
  await routeEditors.nth(0).getByLabel('Failure type name').fill('Compile error')
  await routeEditors.nth(1).getByLabel('Type key').fill('test-failure')
  await routeEditors.nth(1).getByLabel('Failure type name').fill('Test failure')
  await classifierDialog.getByRole('button', { name: 'Done', exact: true }).click()

  const jobMap = page.getByTestId('employee-toolbox-responsibility-map')
  const dispatchNodes = jobMap.locator('[data-dispatch-route-key]')
  await expect(dispatchNodes).toHaveCount(2)
  await expect(dispatchNodes.nth(0)).toContainText('P1 · Tool')
  await expect(dispatchNodes.nth(0)).toContainText('Compile error')
  await expect(dispatchNodes.nth(1)).toContainText('P2 · Tool')
  await expect(dispatchNodes.nth(1)).toContainText('Test failure')
  const widths = await jobMap
    .locator('.employee-toolbox-card')
    .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width))
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5)

  await dispatchNodes.filter({ hasText: 'Compile error' }).click()
  let repairDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(repairDialog).toContainText('Repair priority P1')
  await repairDialog.getByRole('combobox').click()
  await expect(page.getByRole('option', { name: new RegExp(toolName) })).toBeVisible()
  await page.getByRole('option', { name: new RegExp(toolName) }).click()
  await repairDialog.getByRole('button', { name: 'Done', exact: true }).click()

  await page.getByRole('button', { name: 'Save and publish', exact: true }).click()
  repairDialog = page.getByTestId('employee-job-duty-dialog')
  await expect(repairDialog).toContainText('Repair priority P2')
  await expect(repairDialog).toContainText('Required')
  await repairDialog.getByRole('combobox').click()
  await expect(page.getByRole('option', { name: new RegExp(toolName) })).toHaveCount(0)
  const compatibleOptions = page.getByRole('option')
  await expect(compatibleOptions).not.toHaveCount(0)
  await compatibleOptions.first().click()
  await repairDialog.getByRole('button', { name: 'Done', exact: true }).click()

  await expect(dispatchNodes.nth(0)).toHaveClass(/employee-toolbox-card--configured/)
  await expect(dispatchNodes.nth(1)).toHaveClass(/employee-toolbox-card--configured/)
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click()
})
