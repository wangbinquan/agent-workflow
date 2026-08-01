// RFC-244 — browser acceptance for the high-density task operations view.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'
import {
  routeTaskOperationsFixture,
  type TaskOperationsFixtureController,
} from './task-operations-fixtures'

let daemon: DaemonHandle | undefined

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('RFC-244 e2e daemon is not running')
  return daemon
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: requireDaemon().baseUrl, token: requireDaemon().token },
  )
}

async function openOperations(page: Page): Promise<TaskOperationsFixtureController> {
  const controller = await routeTaskOperationsFixture(page)
  await primeAuth(page)
  await page.goto(`${requireDaemon().baseUrl}/tasks`)
  await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()
  return controller
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
        const operations = document.querySelector<HTMLElement>('.task-operations')
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          mainFits: main !== null && main.scrollWidth <= main.clientWidth,
          operationsFits: operations !== null && operations.scrollWidth <= operations.clientWidth,
        }
      }),
    )
    .toEqual({ documentFits: true, mainFits: true, operationsFits: true })
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

test('1280px keeps 30+ tasks dense and paginates roots and child branches independently', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openOperations(page)

  const rootItems = page.locator('.task-operations__list > .task-operations__item')
  await expect(rootItems).toHaveCount(16)
  const rootBox = await page.getByTestId('task-row-dense-running').boundingBox()
  expect(rootBox).not.toBeNull()
  expect(rootBox!.height).toBeGreaterThanOrEqual(56)
  expect(rootBox!.height).toBeLessThanOrEqual(64)

  await page.getByRole('button', { name: 'Load more tasks' }).click()
  await expect(page.getByTestId('task-row-root-page-two-18')).toBeVisible()
  await expect(rootItems).toHaveCount(34)

  await page.getByTestId('task-expand-branch-many').click()
  await expect(page.getByTestId('task-row-branch-child-01')).toBeVisible()
  const childBox = await page.getByTestId('task-row-branch-child-01').boundingBox()
  expect(childBox).not.toBeNull()
  expect(childBox!.height).toBeGreaterThanOrEqual(48)
  expect(childBox!.height).toBeLessThanOrEqual(56)
  await page.getByRole('button', { name: 'Load more child tasks' }).click()
  await expect(page.getByTestId('task-row-branch-child-20')).toBeVisible()

  await expect(page.getByTestId('task-row-long-content')).toContainText(
    'Owner With A Deliberately Long Display Name',
  )
  await expect(page.getByTestId('task-row-long-content')).toContainText(
    'owner-with-a-long-unique-username',
  )
  await expect(page.getByTestId('task-scheduled-chip-dense-scheduled')).toBeVisible()
  await expect(page.getByTestId('task-parent-unavailable-unavailable-parent-child')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('debounced deep search restores its visible ancestry and advanced status filtering round-trips through URL', async ({
  page,
}) => {
  const controller = await openOperations(page)
  const search = page.getByTestId('tasks-search')
  await search.fill('deep target')
  await expect(page).toHaveURL(/\/tasks\?q=deep(?:\+|%20)target/)
  await expect(page.getByTestId('task-row-tree-root')).toBeVisible()
  await expect(page.getByTestId('task-row-tree-middle')).toBeVisible()
  await expect(page.getByTestId('task-row-deep-target')).toBeVisible()
  expect(controller.requests.filter((request) => request.includes('q=deep+target'))).toHaveLength(3)

  await search.fill('')
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()

  await page.getByTestId('tasks-filter-button').click()
  const dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  await expect(dialog).toBeVisible()
  const status = dialog.getByRole('combobox', { name: 'Exact status' })
  await status.fill('run')
  await status.press('Enter')
  await status.press('Escape')
  await dialog.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/[?&]statuses=running(?:&|$)/)
  await expect(page.getByTestId('task-row-dense-running')).toBeVisible()
  await expect(page.getByTestId('task-row-dense-failed')).toHaveCount(0)
})

test('root and branch failures are retryable and the populated view has no serious axe findings', async ({
  page,
}) => {
  const controller = await routeTaskOperationsFixture(page)
  controller.failRoot = true
  await primeAuth(page)
  await page.goto(`${requireDaemon().baseUrl}/tasks`)
  const rootRetry = page.getByRole('button', { name: /retry/i }).first()
  await expect(rootRetry).toBeVisible()
  controller.failRoot = false
  await rootRetry.click()
  await expect(page.getByTestId('task-row-ux-task-1')).toBeVisible()

  controller.failChildFor = 'branch-many'
  await page.getByTestId('task-expand-branch-many').click()
  const branchError = page.getByTestId('task-children-error-branch-many')
  await expect(branchError).toBeVisible()
  controller.failChildFor = null
  await branchError.getByRole('button', { name: /retry/i }).click()
  await expect(page.getByTestId('task-row-branch-child-01')).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  const serious = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(serious).toEqual([])
})

test('390×844 and 390×568 reflow the same nested list without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openOperations(page)
  await expectNoHorizontalOverflow(page)
  await page.getByTestId('task-expand-branch-many').click()
  await expect(page.getByTestId('task-row-branch-child-01')).toBeVisible()
  const expandBox = await page.getByTestId('task-expand-branch-many').boundingBox()
  expect(expandBox).not.toBeNull()
  expect(expandBox!.width).toBeGreaterThanOrEqual(44)
  expect(expandBox!.height).toBeGreaterThanOrEqual(44)

  await page.setViewportSize({ width: 390, height: 568 })
  await expectNoHorizontalOverflow(page)
  await page.getByTestId('tasks-filter-button').click()
  const dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  await expect(dialog).toBeVisible()
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(568)
})
