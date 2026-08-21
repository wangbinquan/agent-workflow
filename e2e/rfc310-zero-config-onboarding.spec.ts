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
  await expect(page.locator('[data-testid^="employee-work-item-"]')).toHaveCount(18)
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
