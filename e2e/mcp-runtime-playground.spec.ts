// RFC-238 — real-browser coverage for the MCP multi-turn runtime playground.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let mcpId: string

test.beforeAll(async () => {
  daemon = await startDaemon()
  const mcp = await requestJson<{ id: string }>('/api/mcps', {
    method: 'POST',
    body: {
      name: 'runtime-playground-e2e',
      description: 'RFC-238 browser fixture',
      type: 'remote',
      config: {
        url: 'http://127.0.0.1:1/mcp',
        timeoutMs: 1_000,
        oauth: false,
      },
      enabled: true,
    },
  })
  mcpId = mcp.id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (!response.ok) {
    throw new Error(
      `RFC-238 e2e fixture ${options.method ?? 'GET'} ${path} failed: ` +
        `${response.status} ${await response.text()}`,
    )
  }
  if (response.status === 204) return null as T
  return response.json() as Promise<T>
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

async function openRuntimeDialog(page: Page): Promise<void> {
  const probeTab = page.getByRole('tab', { name: 'Tools & probe', exact: true })
  if ((await probeTab.getAttribute('aria-selected')) !== 'true') await probeTab.click()
  await page.getByRole('button', { name: 'Test with runtime', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'MCP runtime test', exact: true })).toBeVisible()
}

async function expectDialogAxeClean(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include('[data-testid="mcp-runtime-test-dialog"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  expect(
    result.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target.join(' ')),
      })),
  ).toEqual([])
}

test('offers both runtimes, remains usable at 390px, restores focus, and renders failures', async ({
  page,
}) => {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/mcps/${mcpId}`)
  await openRuntimeDialog(page)

  const dialog = page.getByRole('dialog', { name: 'MCP runtime test', exact: true })
  await expect(dialog.getByText('This can make real MCP calls', { exact: true })).toBeVisible()
  const runtime = dialog.getByRole('combobox', { name: 'Runtime', exact: true })
  await runtime.click()
  await expect(page.getByRole('option', { name: 'opencode', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'claude-code', exact: true })).toBeVisible()
  await page.getByRole('option', { name: 'claude-code', exact: true }).click()
  await expect(runtime).toHaveText(/claude-code/)

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileMetrics = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })
  expect(mobileMetrics.left).toBeGreaterThanOrEqual(0)
  expect(mobileMetrics.right).toBeLessThanOrEqual(mobileMetrics.viewportWidth)
  expect(mobileMetrics.top).toBeGreaterThanOrEqual(0)
  expect(mobileMetrics.bottom).toBeLessThanOrEqual(mobileMetrics.viewportHeight)
  expect(mobileMetrics.horizontalOverflow).toBe(false)
  await expectDialogAxeClean(page)

  const close = dialog.locator('.dialog__close')
  await close.focus()
  await close.press('Shift+Tab')
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))),
  ).toBe(true)
  await page.keyboard.press('Escape')
  const trigger = page.getByRole('button', { name: 'Test with runtime', exact: true })
  await expect(trigger).toBeFocused()
  await expect(requestJson(`/api/mcps/${mcpId}/runtime-test-session`)).resolves.toBeNull()

  await openRuntimeDialog(page)
  const reopened = page.getByRole('dialog', { name: 'MCP runtime test', exact: true })
  const reopenedRuntime = reopened.getByRole('combobox', { name: 'Runtime', exact: true })
  await reopenedRuntime.click()
  await page.getByRole('option', { name: 'opencode', exact: true }).click()
  const composer = reopened.getByRole('textbox', { name: 'First test message', exact: true })
  const prompt = 'List the tools without making a write call.'
  await composer.fill(prompt)
  await reopened.getByRole('button', { name: 'Start test', exact: true }).click()

  await expect(reopened.getByText(prompt, { exact: true })).toBeVisible()
  // The issue panel only renders once the turn reaches a TERMINAL state, and
  // reaching it means actually spawning a runtime process. That is slower on
  // Windows (process creation there costs far more), so the default expect
  // timeout raced it: green on POSIX, flaky and then red on the windows leg.
  // The budget is for the spawn, not a tolerance for the panel being slow.
  const turnIssue = reopened.getByTestId('mcp-runtime-test-turn-issue')
  await expect(turnIssue).toBeVisible({ timeout: 30_000 })
  await expect(turnIssue.getByText('Diagnostic code:', { exact: false })).toBeVisible()

  await requestJson('/api/config', {
    method: 'PUT',
    body: { theme: 'dark' },
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await openRuntimeDialog(page)
  await expectDialogAxeClean(page)
})
