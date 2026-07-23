// RFC-225 — real-daemon workgroup autosave and editor-header contract.
//
// This is the browser seam that unit/component tests cannot prove:
// a real PUT advances the persisted version, the receipt updates the editor
// header without a manual Save action, low-frequency actions remain reachable,
// and the same header/status composition stays usable at 390px.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let workgroup: { id: string; name: string; version: number }

const AGENT_NAME = 'rfc225-browser-agent'
const WORKGROUP_NAME = 'rfc225-browser-workgroup'

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RFC-225 fixture ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function primeAuth(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function setDaemonTheme(theme: 'light' | 'dark'): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  expect(response.ok).toBe(true)
}

async function expectAxeClean(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${label} axe violations`,
  ).toEqual([])
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const agent = await postJson<{ id: string }>('/api/agents', {
    name: AGENT_NAME,
    description: 'RFC-225 browser fixture',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  workgroup = await postJson('/api/workgroups', {
    name: WORKGROUP_NAME,
    description: 'Versioned autosave browser fixture',
    instructions: 'Initial instructions',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 8,
    completionGate: false,
    clarifyBudget: 0,
    fanOut: false,
    members: [
      {
        memberType: 'agent',
        agentId: agent.id,
        displayName: 'Lead',
        roleDesc: 'Coordinates the work.',
      },
      {
        memberType: 'agent',
        agentId: agent.id,
        displayName: 'Builder',
        roleDesc: 'Implements the plan.',
      },
    ],
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('autosaves a real edit and keeps workflow-parity header/actions usable at desktop and 390px', async ({
  page,
}) => {
  await primeAuth(page)
  await page.setViewportSize({ width: 1536, height: 900 })
  await page.goto(`${daemon.baseUrl}/workgroups/${workgroup.id}`)

  const header = page.locator('.editor-page-header')
  await expect(header).toBeVisible()
  await expect(header.getByRole('heading', { name: WORKGROUP_NAME, exact: true })).toBeVisible()
  await expect(header.locator('.page__meta')).toContainText(`${workgroup.id} · v1`)
  await expect(header.locator('.btn--primary')).toHaveCount(1)
  await expect(header.getByTestId('workgroup-launch-button')).toHaveText('Launch task')
  await expect(header.getByTestId('workgroup-more-actions')).toHaveText('More actions')
  const headerActionFonts = await header.evaluate((element) => {
    const launch = element.querySelector<HTMLElement>('[data-testid="workgroup-launch-button"]')
    const more = element.querySelector<HTMLElement>('[data-testid="workgroup-more-actions"]')
    return {
      launch: launch === null ? '' : getComputedStyle(launch).fontSize,
      more: more === null ? '' : getComputedStyle(more).fontSize,
    }
  })
  expect(headerActionFonts.more).toBe(headerActionFonts.launch)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
  const statusSpacing = await page.evaluate(() => {
    const stack = document.querySelector<HTMLElement>('[data-testid="workgroup-status-stack"]')
    const split = document.querySelector<HTMLElement>('.page--split > .split')
    return {
      stackVisible: stack !== null && stack.getBoundingClientRect().height > 0,
      gap: (split?.getBoundingClientRect().top ?? 0) - (stack?.getBoundingClientRect().bottom ?? 0),
    }
  })
  expect(statusSpacing.stackVisible).toBe(true)
  expect(statusSpacing.gap).toBeGreaterThanOrEqual(12)

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/workgroups/${workgroup.id}`,
  )
  await page.getByTestId('workgroup-field-instructions').fill('Saved automatically by RFC-225')
  const receiptResponse = await saveResponse
  expect(receiptResponse.ok()).toBe(true)
  const receipt = (await receiptResponse.json()) as {
    revision: { version: number }
    workgroup: { instructions: string }
  }
  expect(receipt.revision.version).toBe(2)
  expect(receipt.workgroup.instructions).toBe('Saved automatically by RFC-225')
  await expect(header.locator('.page__meta')).toContainText(`${workgroup.id} · v2`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')

  await page.getByTestId('workgroup-more-actions').click()
  const actionsDialog = page.getByTestId('workgroup-actions-dialog')
  await expect(actionsDialog).toBeVisible()
  await expect(actionsDialog.getByTestId('workgroup-rename-button')).toBeVisible()
  await expect(actionsDialog.getByTestId('workgroup-acl-button')).toBeVisible()
  await expect(actionsDialog.getByTestId('workgroup-delete-button')).toBeVisible()
  await expectAxeClean(page, 'desktop workgroup editor actions')
  await page.keyboard.press('Escape')
  await expect(actionsDialog).toBeHidden()

  await page.setViewportSize({ width: 1080, height: 720 })
  await expect(header.getByTestId('workgroup-launch-button')).toBeVisible()
  await expect(header.getByTestId('workgroup-more-actions')).toBeVisible()
  const mediumViewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(mediumViewport.scrollWidth).toBeLessThanOrEqual(mediumViewport.clientWidth + 1)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(header).toBeVisible()
  await expect(header.getByTestId('workgroup-launch-button')).toBeVisible()
  await expect(header.getByTestId('workgroup-more-actions')).toBeVisible()
  const geometry = await page.evaluate(() => {
    const root = document.documentElement
    const headerElement = document.querySelector<HTMLElement>('.editor-page-header')
    const actions = headerElement?.querySelector<HTMLElement>('.page__actions')
    return {
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      headerWidth: headerElement?.getBoundingClientRect().width ?? 0,
      actionsClientWidth: actions?.clientWidth ?? 0,
      actionsScrollWidth: actions?.scrollWidth ?? 0,
    }
  })
  expect(geometry.rootScrollWidth).toBeLessThanOrEqual(geometry.rootClientWidth + 1)
  expect(geometry.headerWidth).toBeLessThanOrEqual(geometry.rootClientWidth + 1)
  expect(geometry.actionsClientWidth).toBeGreaterThan(0)
  expect(geometry.actionsScrollWidth).toBeGreaterThan(0)
  expect(geometry.actionsScrollWidth).toBeLessThanOrEqual(geometry.actionsClientWidth + 1)

  await page.getByTestId('workgroup-more-actions').click()
  await expect(actionsDialog).toBeVisible()
  await expect(actionsDialog.getByTestId('workgroup-delete-button')).toBeVisible()
  await expectAxeClean(page, '390px workgroup editor actions')
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 640, height: 400 })
  await expect(header.getByTestId('workgroup-launch-button')).toBeVisible()
  await expect(header.getByTestId('workgroup-more-actions')).toBeVisible()

  await setDaemonTheme('dark')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTestId('workgroup-more-actions').click()
  await expectAxeClean(page, '390px dark workgroup editor actions')
  await setDaemonTheme('light')
})
