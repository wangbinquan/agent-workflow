// RFC-232 — real-browser owner columns for task and scheduled-task lists.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

const LONG_DISPLAY_NAME = `Owner Visual Validation ${'X'.repeat(104)}`
const PEER_USERNAME = 'owner_peer'
const PEER_PASSWORD = 'OwnerPeerPassword123!'

interface OwnerFixtures {
  adminTaskId: string
  peerTaskId: string
  adminScheduleId: string
  peerScheduleId: string
}

let daemon: DaemonHandle
let fixtures: OwnerFixtures

test.beforeAll(async () => {
  daemon = await startDaemon()
  fixtures = await seedOwnerFixtures()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function requestJson<T>(
  path: string,
  options: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<T> {
  const token = options.token === undefined ? daemon.token : options.token
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (!response.ok) {
    throw new Error(
      `RFC-232 e2e fixture ${options.method ?? 'GET'} ${path} failed: ` +
        `${response.status} ${await response.text()}`,
    )
  }
  return response.json() as Promise<T>
}

async function seedActorRows(
  token: string,
  suffix: string,
): Promise<{ taskId: string; scheduleId: string }> {
  const workflow = await requestJson<{ id: string }>('/api/workflows', {
    method: 'POST',
    token,
    body: {
      name: `owner-${suffix}-workflow`,
      description: 'RFC-232 browser fixture',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    },
  })
  const task = await requestJson<{ id: string }>('/api/tasks', {
    method: 'POST',
    token,
    body: {
      workflowId: workflow.id,
      name: `owner-${suffix}-task`,
      scratch: true,
      inputs: {},
    },
  })
  const schedule = await requestJson<{ id: string }>('/api/scheduled-tasks', {
    method: 'POST',
    token,
    body: {
      name: `owner-${suffix}-schedule`,
      launchKind: 'workflow',
      launchPayload: {
        workflowId: workflow.id,
        name: `owner-${suffix}-scheduled-run`,
        scratch: true,
        inputs: {},
      },
      scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
      enabled: true,
    },
  })
  return { taskId: task.id, scheduleId: schedule.id }
}

async function seedOwnerFixtures(): Promise<OwnerFixtures> {
  const me = await requestJson<{ user: { id: string } }>('/api/auth/me')
  await requestJson(`/api/users/${me.user.id}`, {
    method: 'PATCH',
    body: { displayName: LONG_DISPLAY_NAME },
  })
  await requestJson('/api/users', {
    method: 'POST',
    body: {
      username: PEER_USERNAME,
      displayName: LONG_DISPLAY_NAME,
      role: 'user',
      password: PEER_PASSWORD,
    },
  })
  const peerLogin = await requestJson<{ sessionToken: string }>('/api/auth/login', {
    method: 'POST',
    token: null,
    body: { username: PEER_USERNAME, password: PEER_PASSWORD },
  })

  const adminRows = await seedActorRows(daemon.token, 'admin')
  const peerRows = await seedActorRows(peerLogin.sessionToken, 'peer')
  return {
    adminTaskId: adminRows.taskId,
    peerTaskId: peerRows.taskId,
    adminScheduleId: adminRows.scheduleId,
    peerScheduleId: peerRows.scheduleId,
  }
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function expectOwnerCell(
  row: Locator,
  username: string,
): Promise<{ cell: Locator; label: Locator }> {
  const cell = row.locator('.data-table__owner-cell, .task-operations__owner')
  const label = cell.locator('.owner-label')
  if (await cell.evaluate((element) => element.matches('.data-table__owner-cell'))) {
    await expect(cell).toHaveAccessibleName(
      new RegExp(`^(?:Owner： )?${LONG_DISPLAY_NAME} @${username}$`),
    )
  } else {
    await expect(cell.locator('.sr-only')).toHaveText(/^Owner/)
  }
  await expect(label.locator('.owner-label__display')).toHaveText(LONG_DISPLAY_NAME)
  await expect(label.locator('.owner-label__identity')).toHaveText(`@${username}`)
  await expect(label).toHaveAttribute('title', `${LONG_DISPLAY_NAME} (@${username})`)
  return { cell, label }
}

async function expectLongIdentityLayout(label: Locator): Promise<void> {
  const displayMetrics = await label.locator('.owner-label__display').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    }
  })
  expect(displayMetrics.scrollWidth).toBeGreaterThan(displayMetrics.clientWidth)
  expect(displayMetrics).toMatchObject({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })

  const identityMetrics = await label.locator('.owner-label__identity').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    }
  })
  expect(identityMetrics.scrollWidth).toBe(identityMetrics.clientWidth)
  expect(identityMetrics.textOverflow).toBe('clip')
  expect(identityMetrics.whiteSpace).toBe('normal')
}

async function expectWrappedIdentityLayout(label: Locator): Promise<void> {
  await expect(label).toHaveClass(/owner-label--wrap/)
  const displayMetrics = await label.locator('.owner-label__display').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflow: style.overflow,
      overflowWrap: style.overflowWrap,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    }
  })
  expect(displayMetrics.scrollWidth).toBeLessThanOrEqual(displayMetrics.clientWidth)
  expect(displayMetrics).toMatchObject({
    overflow: 'visible',
    overflowWrap: 'anywhere',
    textOverflow: 'clip',
    whiteSpace: 'normal',
  })
}

async function expectOwnerAxeClean(
  page: Page,
  selectors: { surface: string; owner: string } = {
    surface: 'table.data-table',
    owner: '.data-table__owner-cell',
  },
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(selectors.surface)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([])

  const ownerResults = await new AxeBuilder({ page })
    .include(selectors.owner)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(
    ownerResults.incomplete.flatMap((item) =>
      item.nodes.map((node) => ({
        id: item.id,
        target: node.target,
        failureSummary: node.failureSummary,
        checks: [...node.any, ...node.all, ...node.none].map((check) => ({
          message: check.message,
          data: check.data,
        })),
      })),
    ),
  ).toEqual([])
}

test('owner identity is visible, distinct, accessible, and reachable at 390px', async ({
  page,
}) => {
  await primeAuth(page)

  await page.goto(`${daemon.baseUrl}/tasks`)
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
  await expect(page.locator('.task-operations__head > span')).toHaveText([
    'Task',
    'Execution',
    'Time',
    'Owner',
    '',
  ])
  const adminTask = page.getByTestId(`task-row-${fixtures.adminTaskId}`)
  const peerTask = page.getByTestId(`task-row-${fixtures.peerTaskId}`)
  const adminTaskOwner = await expectOwnerCell(adminTask, 'e2e_admin')
  await expectOwnerCell(peerTask, PEER_USERNAME)
  await expectWrappedIdentityLayout(adminTaskOwner.label)
  await expectOwnerAxeClean(page, {
    surface: '.task-operations',
    owner: '.task-operations__owner',
  })

  await page.goto(`${daemon.baseUrl}/scheduled`)
  await expect(page.getByRole('heading', { name: 'Scheduled Tasks', exact: true })).toBeVisible()
  await expect(page.locator('thead th')).toHaveText([
    'Schedule',
    'State & last run',
    'Next run',
    'Owner',
    '',
    '',
  ])
  const adminSchedule = page.getByTestId(`scheduled-row-${fixtures.adminScheduleId}`)
  const peerSchedule = page.getByTestId(`scheduled-row-${fixtures.peerScheduleId}`)
  const adminScheduleOwner = await expectOwnerCell(adminSchedule, 'e2e_admin')
  await expectOwnerCell(peerSchedule, PEER_USERNAME)
  await expectLongIdentityLayout(adminScheduleOwner.label)
  await expectOwnerAxeClean(page)

  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto(`${daemon.baseUrl}/tasks`)
  const narrowTask = page.getByTestId(`task-row-${fixtures.adminTaskId}`)
  const narrowTaskOwner = (await expectOwnerCell(narrowTask, 'e2e_admin')).cell
  const pageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth)
  for (const box of [await narrowTask.boundingBox(), await narrowTaskOwner.boundingBox()]) {
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(pageWidth.clientWidth)
  }
  await expect(
    narrowTask.getByRole('link', { name: 'owner-admin-task', exact: true }),
  ).toBeInViewport()
  await expect(narrowTask.locator('.owner-label__identity')).toHaveText('@e2e_admin')

  await page.goto(`${daemon.baseUrl}/scheduled`)
  const narrowSchedule = page.getByTestId(`scheduled-row-${fixtures.adminScheduleId}`)
  const narrowScheduleOwner = (await expectOwnerCell(narrowSchedule, 'e2e_admin')).cell
  const scheduleScroller = page.locator('.table-viewport__scroller')
  const scheduledPageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(scheduledPageWidth.scrollWidth).toBeLessThanOrEqual(scheduledPageWidth.clientWidth)
  expect(
    await scheduleScroller.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)
  for (const box of [await narrowSchedule.boundingBox(), await narrowScheduleOwner.boundingBox()]) {
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(scheduledPageWidth.clientWidth)
  }
  await expect(narrowSchedule.locator('.owner-label__identity')).toHaveText('@e2e_admin')
  await expect(
    narrowSchedule.getByRole('button', { name: 'Run now', exact: true }),
  ).toBeInViewport()
})
