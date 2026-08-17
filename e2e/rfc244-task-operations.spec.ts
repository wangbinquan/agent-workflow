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

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  token: string = requireDaemon().token,
): Promise<T> {
  const response = await fetch(`${requireDaemon().baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `RFC-301 live fixture ${path} failed (${response.status}): ${await response.text()}`,
    )
  }
  return response.json() as Promise<T>
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  return requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) }, token)
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error('RFC-301 live fixture timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
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

test('Webhook and API origin filters keep complete trees and reset cursor identity', async ({
  page,
}) => {
  const controller = await openOperations(page)
  await page.getByRole('button', { name: 'Load more tasks' }).click()
  expect(controller.requests.some((request) => request.includes('cursor=root-page-2'))).toBe(true)

  await page.getByTestId('tasks-filter-button').click()
  let dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  const originGroup = dialog.getByRole('radiogroup', { name: 'Launch origin' })
  expect(await originGroup.getByRole('radio').allTextContents()).toEqual([
    'All origins',
    'Manual',
    'Scheduled',
    'Webhook',
    'API',
  ])
  await originGroup.getByRole('radio', { name: 'Webhook', exact: true }).click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(page).toHaveURL(/[?&]origin=webhook(?:&|$)/)
  await expect(page.getByTestId('task-row-dense-alert')).toBeVisible()
  await expect(page.getByTestId('task-row-branch-many')).toBeVisible()
  await expect(page.getByTestId('task-row-dense-scheduled')).toHaveCount(0)
  const webhookRootRequest = controller.requests.at(-1)!
  expect(webhookRootRequest).toContain('origin=webhook')
  expect(webhookRootRequest).not.toContain('cursor=')

  await page.getByTestId('task-expand-branch-many').click()
  await expect(page.getByTestId('task-row-branch-child-01')).toBeVisible()
  expect(controller.requests.at(-1)).toContain('parent_id=branch-many')
  expect(controller.requests.at(-1)).toContain('origin=webhook')

  await page.getByTestId('tasks-filter-button').click()
  dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  const selectedWebhook = dialog.getByRole('radio', { name: 'Webhook', exact: true })
  await selectedWebhook.focus()
  await selectedWebhook.press('End')
  await expect(dialog.getByRole('radio', { name: 'API', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await dialog.getByRole('button', { name: 'Apply filters' }).click()

  await expect(page).toHaveURL(/[?&]origin=api(?:&|$)/)
  await expect(page.getByTestId('task-row-tree-root')).toBeVisible()
  await expect(page.getByTestId('task-row-agent-subject')).toBeVisible()
  await expect(page.getByTestId('task-row-dense-alert')).toHaveCount(0)
  const apiRootRequest = controller.requests.findLast(
    (request) => request.includes('origin=api') && !request.includes('parent_id='),
  )!
  expect(apiRootRequest).toContain('origin=api')
  expect(apiRootRequest).not.toContain('cursor=')

  await page.getByTestId('tasks-filter-button').click()
  dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
  await dialog.getByRole('button', { name: 'Clear filters' }).click()
  await dialog.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).not.toHaveURL(/[?&]origin=/)
})

test('390px origin picker is touchable, internally scrollable, keyboard-complete, and theme-readable', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 568 },
    hasTouch: true,
  })
  const page = await context.newPage()
  try {
    await openOperations(page)
    await page.getByTestId('tasks-filter-button').tap()
    const dialog = page.getByTestId('tasks-filter-dialog').getByRole('dialog')
    const originGroup = dialog.getByRole('radiogroup', { name: 'Launch origin' })
    const api = originGroup.getByRole('radio', { name: 'API', exact: true })

    const before = await originGroup.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth)
    await api.tap()
    await expect(api).toHaveAttribute('aria-checked', 'true')
    await originGroup.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    await expect
      .poll(() => originGroup.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    await expectNoHorizontalOverflow(page)

    await api.focus()
    await api.press('Home')
    await expect(originGroup.getByRole('radio', { name: 'All origins' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await originGroup.getByRole('radio', { name: 'All origins' }).press('End')
    await expect(api).toHaveAttribute('aria-checked', 'true')

    for (const theme of ['light', 'dark'] as const) {
      const colors = await originGroup.evaluate((element, nextTheme) => {
        document.documentElement.dataset.theme = nextTheme
        const active = element.querySelector<HTMLElement>('[aria-checked="true"]')!
        const inactive = element.querySelector<HTMLElement>('[aria-checked="false"]')!
        return {
          activeBackground: getComputedStyle(active).backgroundColor,
          inactiveBackground: getComputedStyle(inactive).backgroundColor,
          activeColor: getComputedStyle(active).color,
          inactiveColor: getComputedStyle(inactive).color,
        }
      }, theme)
      expect(colors.activeBackground).not.toBe(colors.inactiveBackground)
      expect(colors.activeColor).not.toBe(colors.inactiveColor)
    }

    const results = await new AxeBuilder({ page })
      .include('[data-testid="tasks-filter-dialog"]')
      .analyze()
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious',
      ),
    ).toEqual([])

    await api.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('tasks-filter-button')).toBeFocused()
  } finally {
    await context.close()
  }
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

test('real session, PAT, schedule, and webhook launches filter exactly and scheduled children inherit', async () => {
  type TaskWire = { id: string; [key: string]: unknown }
  type OperationsPage = { items: TaskWire[] }
  type WorkflowWire = { id: string; name: string }

  const createWorkflow = (name: string, nodes: unknown[] = []) =>
    postJson<WorkflowWire>('/api/workflows', {
      name,
      description: 'RFC-301 live launch-origin fixture',
      definition: { $schema_version: 5, inputs: [], nodes, edges: [] },
    })

  const leaf = await createWorkflow('rfc301-live-leaf')
  const middle = await createWorkflow('rfc301-live-middle', [
    {
      id: 'call-leaf',
      kind: 'call-workflow',
      workflowName: leaf.name,
      workflowId: leaf.id,
    },
  ])
  const root = await createWorkflow('rfc301-live-root', [
    {
      id: 'call-middle',
      kind: 'call-workflow',
      workflowName: middle.name,
      workflowId: middle.id,
    },
  ])

  const manual = await postJson<TaskWire>('/api/tasks', {
    workflowId: leaf.id,
    name: 'rfc301-live-manual',
    scratch: true,
    inputs: {},
  })
  expect(Object.hasOwn(manual, 'launchOrigin')).toBe(false)

  const minted = await postJson<{ token: string; pat: { scopes: string[] } }>('/api/auth/pats', {
    name: 'rfc301-live-api',
    scopes: ['tasks:execute'],
    purpose: 'general',
  })
  expect(minted.pat.scopes).toEqual(['tasks:execute'])
  const api = await postJson<TaskWire>(
    '/api/tasks',
    {
      workflowId: leaf.id,
      name: 'rfc301-live-api',
      scratch: true,
      inputs: {},
    },
    minted.token,
  )
  expect(Object.hasOwn(api, 'launchOrigin')).toBe(false)

  const schedule = await postJson<{ id: string }>('/api/scheduled-tasks', {
    name: 'rfc301-live-schedule',
    launchKind: 'workflow',
    launchPayload: {
      workflowId: root.id,
      name: 'rfc301-live-scheduled-root',
      scratch: true,
      inputs: {},
    },
    scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
    enabled: false,
  })
  const scheduled = await postJson<{ taskId: string }>(
    `/api/scheduled-tasks/${schedule.id}/run-now`,
    {},
  )

  const endpoint = await postJson<{ id: string; urlToken: string; secret: string }>(
    '/api/webhook-endpoints',
    { name: 'rfc301-live-endpoint' },
  )
  const trigger = await postJson<{ id: string }>('/api/webhook-triggers', {
    name: 'rfc301-live-webhook',
    endpointId: endpoint.id,
    repoScope: { kind: 'exact', paths: ['platform/api'] },
    eventTypes: ['pipeline_failed'],
    ignoreUsernames: [],
    autoRegisterRepos: false,
    launchKind: 'workflow',
    launchRefId: leaf.id,
    launchPayload: { inputs: {}, scratch: true },
  })
  const ingress = await fetch(`${requireDaemon().baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': endpoint.secret,
      'x-gitlab-event': 'Pipeline Hook',
      'x-gitlab-event-uuid': 'rfc301-live-delivery',
    },
    body: JSON.stringify({
      object_kind: 'pipeline',
      user: { username: 'developer' },
      project: {
        path_with_namespace: 'platform/api',
        git_http_url: 'https://gitlab.invalid/platform/api.git',
        git_ssh_url: 'git@gitlab.invalid:platform/api.git',
      },
      object_attributes: {
        id: 301,
        ref: 'feature/rfc301',
        status: 'failed',
        sha: '301301',
      },
    }),
  })
  expect(ingress.status).toBe(200)

  const fires = await waitFor(
    () =>
      requestJson<Array<{ outcome: string; taskId: string | null }>>(
        `/api/webhook-triggers/${trigger.id}/fires`,
      ),
    (rows) => rows.some((row) => row.outcome === 'launched' && row.taskId !== null),
  )
  const webhookTaskId = fires.find((row) => row.outcome === 'launched')!.taskId!

  const pageFor = (origin: string, parentId?: string) =>
    requestJson<OperationsPage>(
      `/api/tasks/page?scope=mine&limit=50&origin=${origin}${
        parentId === undefined ? '' : `&parent_id=${encodeURIComponent(parentId)}`
      }`,
    )

  const manualPage = await pageFor('manual')
  expect(manualPage.items.map((item) => item.id)).toContain(manual.id)
  expect(manualPage.items.map((item) => item.id)).not.toContain(api.id)
  const apiPage = await pageFor('api')
  expect(apiPage.items.map((item) => item.id)).toContain(api.id)
  expect(apiPage.items.map((item) => item.id)).not.toContain(manual.id)
  const webhookPage = await pageFor('webhook')
  expect(webhookPage.items.map((item) => item.id)).toContain(webhookTaskId)

  const scheduledRootPage = await pageFor('scheduled')
  expect(scheduledRootPage.items.map((item) => item.id)).toContain(scheduled.taskId)
  const scheduledChildren = await waitFor(
    () => pageFor('scheduled', scheduled.taskId),
    (page) => page.items.length === 1,
  )
  const middleTaskId = scheduledChildren.items[0]!.id
  const scheduledGrandchildren = await waitFor(
    () => pageFor('scheduled', middleTaskId),
    (page) => page.items.length === 1,
    60_000,
  )
  expect(scheduledGrandchildren.items).toHaveLength(1)

  for (const page of [manualPage, apiPage, webhookPage, scheduledRootPage, scheduledChildren]) {
    for (const item of page.items) expect(Object.hasOwn(item, 'launchOrigin')).toBe(false)
  }
})
