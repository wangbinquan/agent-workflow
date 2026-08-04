// RFC-244 — browser acceptance for the high-density task operations view.
// The 2026-08-04 scroll-owner regression is pinned here too: task rows scroll
// inside the operations surface while the page title and filters remain fixed.

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

test('task rows own vertical scrolling without moving the page title or filters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openOperations(page)

  const before = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
    const header = document.querySelector<HTMLElement>('.operations-surface__header')
    const toolbar = document.querySelector<HTMLElement>('.operations-toolbar')
    const list = document.querySelector<HTMLOListElement>('.task-operations__list')
    if (content === null || header === null || toolbar === null || list === null) return null
    return {
      contentOverflowY: getComputedStyle(content).overflowY,
      contentScrollTop: content.scrollTop,
      headerTop: header.getBoundingClientRect().top,
      toolbarTop: toolbar.getBoundingClientRect().top,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      listOverflowY: getComputedStyle(list).overflowY,
    }
  })
  expect(before).not.toBeNull()
  expect(before!.contentOverflowY).toBe('hidden')
  expect(before!.contentScrollTop).toBe(0)
  expect(before!.listOverflowY).toBe('auto')
  expect(before!.listScrollHeight).toBeGreaterThan(before!.listClientHeight)

  await page.locator('.task-operations__list').evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })

  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector<HTMLElement>('[data-testid="app-shell-main"]')
        const header = document.querySelector<HTMLElement>('.operations-surface__header')
        const toolbar = document.querySelector<HTMLElement>('.operations-toolbar')
        const list = document.querySelector<HTMLOListElement>('.task-operations__list')
        if (content === null || header === null || toolbar === null || list === null) return null
        return {
          contentScrollTop: content.scrollTop,
          documentScrollTop: document.documentElement.scrollTop,
          headerTop: header.getBoundingClientRect().top,
          toolbarTop: toolbar.getBoundingClientRect().top,
          listScrolled: list.scrollTop > 0,
        }
      }),
    )
    .toEqual({
      contentScrollTop: 0,
      documentScrollTop: 0,
      headerTop: before!.headerTop,
      toolbarTop: before!.toolbarTop,
      listScrolled: true,
    })
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

  const branchRow = page.getByTestId('task-row-branch-many')
  const expandBox = await page.getByTestId('task-expand-branch-many').boundingBox()
  const nameBox = await branchRow.locator('.task-operations__name').boundingBox()
  const ownerBox = await branchRow.locator('.task-operations__owner').boundingBox()
  const navBox = await branchRow.locator('.task-operations__nav').boundingBox()
  expect(expandBox).not.toBeNull()
  expect(nameBox).not.toBeNull()
  expect(ownerBox).not.toBeNull()
  expect(navBox).not.toBeNull()
  expect(expandBox!.x + expandBox!.width).toBeLessThanOrEqual(nameBox!.x)
  expect(navBox!.x).toBeGreaterThan(ownerBox!.x)

  await page.getByRole('button', { name: 'Load more tasks' }).click()
  await expect(page.getByTestId('task-row-root-page-two-18')).toBeVisible()
  await expect(rootItems).toHaveCount(34)

  await page.getByTestId('task-expand-branch-many').click()
  await expect(page.getByTestId('task-row-branch-child-01')).toBeVisible()
  const childBox = await page.getByTestId('task-row-branch-child-01').boundingBox()
  const childWellBox = await page
    .getByTestId('task-row-branch-child-01')
    .locator('xpath=ancestor::ol[1]')
    .boundingBox()
  expect(childBox).not.toBeNull()
  expect(childWellBox).not.toBeNull()
  expect(childBox!.height).toBeGreaterThanOrEqual(48)
  expect(childBox!.height).toBeLessThanOrEqual(56)
  expect(childWellBox!.x).toBeGreaterThan(rootBox!.x)
  expect(childWellBox!.width).toBeLessThan(rootBox!.width)
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

  for (const width of [1024, 901]) {
    await page.setViewportSize({ width, height: 768 })
    await expectNoHorizontalOverflow(page)
  }
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

  const searchBox = await page.getByTestId('tasks-search').boundingBox()
  const filterBox = await page.getByTestId('tasks-filter-button').boundingBox()
  expect(searchBox).not.toBeNull()
  expect(filterBox).not.toBeNull()
  expect(Math.abs(searchBox!.y - filterBox!.y)).toBeLessThanOrEqual(2)

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
