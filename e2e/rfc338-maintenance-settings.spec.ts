// RFC-338 — compiled-binary maintenance Worker and narrow Settings surface.
//
// Source-level Worker tests cannot catch Bun standalone-entry resolution: a
// release once built successfully yet opened the Worker through an absolute
// /$bunfs URL and degraded with ModuleNotFound. This spec starts the compiled
// E2E artifact, so Ready is proof that the actual shipped entry can load.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function primeToken(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: daemon.token },
  )
}

test('compiled Worker is ready and daily scheduling remains usable at 390px', async ({ page }) => {
  await primeToken(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/settings?tab=gc`)

  await expect(page.getByTestId('maintenance-worker-state')).toHaveText('Ready', {
    timeout: 30_000,
  })
  await expect(page.getByText(/ModuleNotFound/)).toHaveCount(0)

  const hourly = page.getByRole('radio', { name: 'Hourly, staggered' })
  const daily = page.getByRole('radio', { name: 'Once daily' })
  await expect(hourly).toHaveAttribute('aria-checked', 'true')
  await hourly.press('ArrowRight')
  await expect(daily).toHaveAttribute('aria-checked', 'true')

  const time = page.getByTestId('maintenance-schedule-time')
  const timezone = page.getByTestId('maintenance-schedule-timezone')
  await expect(time).toHaveValue('02:00')
  await expect(timezone).not.toHaveValue('')

  await time.fill('')
  await timezone.fill('Mars/Olympus')
  await expect(page.getByText(/valid 24-hour time/i)).toBeVisible()
  await expect(page.getByText(/valid IANA timezone/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'the maintenance card overflows the 390px viewport',
  ).toBe(true)
})
