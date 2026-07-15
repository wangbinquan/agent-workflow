// RFC-198 T8a — executable foundation for the global UX browser matrix.
//
// Later RFC-198 PRs extend this file across the breakpoint/table/dialog matrix.
// These first cases lock the canonical project viewport, explicit app-theme
// precedence over the opposite OS preference, and the default control target.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

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

async function setDaemonTheme(theme: 'light' | 'dark'): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  expect(response.ok, `failed to set ${theme} theme (${response.status})`).toBe(true)
}

async function openAgents(page: Page): Promise<void> {
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
}

async function readThemeStyles(page: Page): Promise<{
  theme: string | undefined
  background: string
  primaryBackground: string
}> {
  const primary = page.locator('.btn--primary').first()
  await expect(primary).toBeVisible()
  return primary.evaluate((element) => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
    primaryBackground: getComputedStyle(element).backgroundColor,
  }))
}

test.describe('RFC-198 T8a UX consistency foundation', () => {
  test('uses the canonical 1280x800 project viewport', async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 1280, height: 800 })
  })

  test.describe('isolated app baseline', () => {
    test.beforeAll(async () => {
      daemon = await startDaemon()
    })

    test.afterAll(async () => {
      if (daemon !== undefined) await daemon.stop()
    })

    test('explicit app themes win over the opposite OS color scheme', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      await setDaemonTheme('light')
      await openAgents(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      expect(await readThemeStyles(page)).toEqual({
        theme: 'light',
        background: 'rgb(248, 249, 251)',
        primaryBackground: 'rgb(31, 95, 218)',
      })

      await page.emulateMedia({ colorScheme: 'light' })
      await setDaemonTheme('dark')
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      expect(await readThemeStyles(page)).toEqual({
        theme: 'dark',
        background: 'rgb(21, 24, 29)',
        primaryBackground: 'rgb(39, 89, 165)',
      })
    })

    test('default primary controls provide at least a 36px target', async ({ page }) => {
      await setDaemonTheme('light')
      await openAgents(page)
      const target = page.locator('.btn--primary').first()
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(36)
      expect(box!.height).toBeGreaterThanOrEqual(36)
    })
  })
})
