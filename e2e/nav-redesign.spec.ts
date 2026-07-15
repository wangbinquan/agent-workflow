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
import { routePopulatedInbox } from './inbox-fixtures'

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

test('RFC-195 inbox dialog: footer button opens an accessible empty-state dialog', async ({
  page,
}) => {
  // The daemon comes up clean — no pending reviews / clarify sessions —
  // so the button stays visible without a badge, and clicking it brings
  // up the drawer with the empty hint. We don't seed pending items here;
  // dedicated e2e for the populated path lives next to the review /
  // clarify e2e (e2e/review.spec.ts / e2e/clarify.spec.ts), which already
  // mount full task fixtures and would otherwise duplicate setup.
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/agents`)

  const inboxButton = page.locator('[data-testid="inbox-footer-button"]')
  await expect(inboxButton).toBeVisible()
  // No badge until reviews/clarify endpoints report nonzero counts.
  await expect(page.locator('[data-testid="inbox-footer-badge"]')).toHaveCount(0)

  await inboxButton.click()
  const dialog = page.getByRole('dialog', { name: 'Inbox' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(page.locator('[data-testid="inbox-tab-all"]')).toBeVisible()
  await expect(page.locator('[data-testid="inbox-tab-reviews"]')).toBeVisible()
  await expect(page.locator('[data-testid="inbox-tab-clarify"]')).toBeVisible()
  // Empty hint (en-US bundle).
  await expect(dialog).toContainText('Nothing waiting')

  // ESC closes.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('RFC-195 inbox dialog: populated 390px panel keeps content and footer in bounds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await routePopulatedInbox(page)
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/agents`)

  await page.getByTestId('inbox-footer-button').click()
  const dialog = page.getByRole('dialog', { name: 'Inbox' })
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('inbox-row-review-visual-review-0')).toBeVisible()
  await expect(dialog).toHaveClass(/inbox-dialog/)

  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  if (box === null) return

  // RFC-195: <=720px is a true full-screen sheet. The half-pixel tolerance
  // absorbs browser rounding while still catching the old 240px-left drawer
  // (which overflowed a 390px viewport by roughly 210px).
  expect(box.x).toBeGreaterThanOrEqual(-0.5)
  expect(box.y).toBeGreaterThanOrEqual(-0.5)
  expect(box.x + box.width).toBeLessThanOrEqual(390.5)
  expect(box.y + box.height).toBeLessThanOrEqual(844.5)
  expect(box.width).toBeGreaterThanOrEqual(389)
  expect(box.height).toBeGreaterThanOrEqual(843)

  await expect(page.getByTestId('inbox-drawer-open-reviews')).toBeInViewport()
  await expect(page.getByTestId('inbox-drawer-open-clarify')).toBeInViewport()
  const overflow = await dialog.evaluate((panel) => {
    const body = panel.querySelector<HTMLElement>('.dialog__body')
    return {
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      panelFits: panel.scrollWidth <= panel.clientWidth,
      bodyFits: body !== null && body.scrollWidth <= body.clientWidth,
      bodyScrolls: body !== null && body.scrollHeight > body.clientHeight,
    }
  })
  expect(overflow).toEqual({
    documentFits: true,
    panelFits: true,
    bodyFits: true,
    bodyScrolls: true,
  })
})
