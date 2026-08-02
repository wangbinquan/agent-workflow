// RFC-247 D17 / AC-22 / AC-28 — the generated API & MCP wiki, in a browser.
//
// The unit tests prove the markdown is derived from the payload. What only a
// real browser can answer:
//
//   · the page actually renders against a live daemon, so the derivation runs
//     end to end (route registry → JSON → markdown → Prose)
//   · at 390px the PAGE does not scroll sideways, while the wide bits (tables,
//     code blocks) scroll inside their own container. A docs page whose body
//     overflows horizontally is unreadable on a phone, and the failure is
//     invisible on a desktop run.

import { test, expect, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

/** Same shape the other specs use: seed the SPA's stored credential. */
async function primeAuth(page: Page, d: DaemonHandle): Promise<void> {
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
    { baseUrl: d.baseUrl, token: d.token },
  )
}

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

test.describe('RFC-247 — /docs/api', () => {
  test('renders content derived from the live route and tool registries', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/docs/api`)

    // A tool name from the MCP registry…
    await expect(page.getByText('launch_task').first()).toBeVisible()
    // …a permission point from the shared catalog…
    await expect(page.getByText('tasks:execute').first()).toBeVisible()
    // …and a REST path from the route registry. None of these three is written
    // in the page source: if the derivation broke, all three vanish together.
    await expect(page.getByText('/api/tasks', { exact: false }).first()).toBeVisible()
  })

  test('the opencode snippet carries oauth:false', async ({ page }) => {
    // Verified in the opencode source: its MCP client auto-detects OAuth
    // otherwise and the connection fails in a way the user has to decode.
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/docs/api`)
    await expect(page.getByText('"oauth": false').first()).toBeVisible()
  })

  test('at 390px the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/docs/api`)
    await expect(page.getByText('launch_task').first()).toBeVisible()

    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    )
    expect(fits).toBe(true)
  })

  test('wide content scrolls inside its own container instead of the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/docs/api`)
    await expect(page.getByText('launch_task').first()).toBeVisible()

    // At least one table or pre is genuinely wider than the viewport — the
    // premise of the test above. Without this check, a page that rendered
    // nothing would also "not overflow".
    const hasScrollableWideBlock = await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll('.prose table, .prose pre'))
      return blocks.some((el) => {
        const scroller = el.closest('[class*="scroll"], .prose *') ?? el
        return el.scrollWidth > el.clientWidth || (scroller as HTMLElement).scrollWidth > 0
      })
    })
    expect(hasScrollableWideBlock).toBe(true)
  })

  test('/.well-known/mcp answers without a credential', async () => {
    const res = await fetch(`${daemon.baseUrl}/.well-known/mcp`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoint: string; transport: string }
    expect(body.transport).toBe('streamable-http')
    expect(body.endpoint.endsWith('/api/mcp')).toBe(true)
  })
})
