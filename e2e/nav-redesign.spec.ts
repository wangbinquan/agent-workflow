// RFC-032 PR1 — e2e: 3-group sidebar + settings gear + auth gate.
//
// Why this spec exists: PR1 reshapes the left chrome from a flat 10-item
// list into 3 groups + a home link + a footer gear. The shell is the
// chrome users sit inside for every other workflow, so any regression
// (e.g. the workflows link goes to /workflows/edit instead, the gear
// stops navigating to /settings, /agents loses its active highlight)
// breaks every other e2e too. This spec exercises the three pieces of
// PR1 that don't depend on PR2 (inbox) or PR3 (homepage).
//
// Cases (from design.md §8.4):
//   #1 — happy path: clicking the "Skills" sub-item under the "Agents"
//        group routes to /skills and the row gets the --active class.
//   #4 — settings gear: clicking the footer gear lands on /settings and
//        the gear button picks up the --active outline.
//   #5 — auth gate: visiting /agents without a token kicks the user out
//        to /auth (no sidebar visible).

import { test, expect } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function primeAuth(page: import('@playwright/test').Page, d: DaemonHandle): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        // ignore
      }
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

test('RFC-032 nav-redesign happy path: agents group → click Skills → URL flips + active class', async ({
  page,
}) => {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/agents`)
  // Sidebar group header is rendered as uppercase small-caps text. The
  // header itself does not include the chevron in its accessible name, so
  // matching on the i18n text "Agents" is the safe bet.
  await expect(page.locator('.nav-group[data-group="agents"]')).toBeVisible()

  // The Skills sub-item lives inside the agents group. Click it.
  const skillsLink = page.locator('.nav-group[data-group="agents"] a', { hasText: 'Skills' })
  await skillsLink.click()
  await page.waitForURL(/\/skills$/)

  // Skills row is now active inside the agents group.
  await expect(
    page.locator('.nav-group[data-group="agents"] a.nav-item--active', { hasText: 'Skills' }),
  ).toBeVisible()
})

test('RFC-032 nav-redesign settings gear: click → /settings + --active outline', async ({
  page,
}) => {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/agents`)
  const gear = page.locator('.sidebar__footer button.settings-gear')
  await expect(gear).toBeVisible()
  // Not active before click.
  await expect(gear).not.toHaveClass(/settings-gear--active/)
  await gear.click()
  await page.waitForURL(/\/settings$/)
  // Active after click.
  await expect(gear).toHaveClass(/settings-gear--active/)
  await expect(gear).toHaveAttribute('aria-current', 'page')
})

test('RFC-032 nav-redesign auth gate: no token → /auth, no sidebar', async ({ page }) => {
  // Deliberately do NOT prime auth. The root beforeLoad must redirect to
  // /auth, and the bare shell must NOT render the sidebar.
  await page.goto(`${daemon.baseUrl}/agents`)
  await page.waitForURL(/\/auth/)
  await expect(page.locator('aside.sidebar')).toHaveCount(0)
})

test('RFC-032 nav-redesign homepage: non-first-run / renders 3 sections + Start task button', async ({
  page,
}) => {
  await primeAuth(page, daemon)
  // Seed a workflow + repo so the onboarding probe says "not first run".
  // The daemon comes up clean; we create one workflow via API so
  // useOnboardingProbe().isFirstRun flips false.
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'nav-redesign-stub-agent',
      description: 'e2e seed',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'nav-redesign-stub-workflow',
      description: 'e2e seed',
      definition: {
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      },
    }),
  })

  await page.goto(`${daemon.baseUrl}/`)
  await expect(page.locator('[data-testid="homepage"]')).toBeVisible()
  await expect(page.locator('[data-testid="homepage-section-running"]')).toBeVisible()
  await expect(page.locator('[data-testid="homepage-section-inbox"]')).toBeVisible()
  await expect(page.locator('[data-testid="homepage-section-recent"]')).toBeVisible()
  await expect(page.locator('[data-testid="homepage-start-task"]')).toBeVisible()
})

test('RFC-061 PR-C inbox stub: footer button opens drawer; empty hint shows', async ({
  page,
}) => {
  // RFC-061 PR-C: the reviews + clarify tabs are temporarily removed
  // until the suspensions-projection UI is rebuilt. Drawer keeps shell
  // layout (button + container) but only renders memory-candidate rows
  // for admins; empty state shows for everyone else.
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/agents`)

  const inboxButton = page.locator('[data-testid="inbox-footer-button"]')
  await expect(inboxButton).toBeVisible()

  await inboxButton.click()
  await expect(page.locator('[data-testid="inbox-drawer"]')).toBeVisible()
  // Empty hint (en-US bundle).
  await expect(page.locator('[data-testid="inbox-drawer"]')).toContainText('Nothing waiting')

  // ESC closes.
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="inbox-drawer"]')).toHaveCount(0)
})
