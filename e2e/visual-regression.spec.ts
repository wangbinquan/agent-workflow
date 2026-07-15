// RFC-054 W2-5 — visual regression baseline + diff for 8 key pages.
//
// LOCKS: a chunk of pixels for each canonical page. Catches UI changes
// that:
//   * Drop / shift / restyle a key element (panel collapses, header
//     gone, sidebar moved) without anyone noticing.
//   * Introduce visual noise (over-bright contrast, mismatched fonts).
//   * Break the layout at the canonical 1280×800 viewport.
//
// Playwright's `toHaveScreenshot()` writes platform-suffixed baselines
// (`*-darwin.png`, `*-linux.png`, …) under
// `e2e/visual-regression.spec.ts-snapshots/`. CI ubuntu and developer
// darwin each keep their own; updating either requires re-running with
// `--update-snapshots` on that platform.
//
// Gating: this spec is OPT-IN behind `RUN_VISUAL_REGRESSION=1`. Default
// `bun run e2e` skips it because:
//   * The first run on each platform fails (no baseline) — surfacing
//     that the suite needs platform-aware baseline generation;
//   * Font subpixel jitter on a developer's M-series Mac is enough to
//     drift 0.1% pixel diff per page without touching the code, which
//     would create flaky PR CI noise.
// The dedicated nightly workflow `visual-regression-nightly.yml` is
// where the gate actually runs, on ubuntu only (matching the committed
// `-linux.png` baselines).

import { test, expect, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'
import { routePopulatedInbox } from './inbox-fixtures'

const RUN_VISUAL_REGRESSION = process.env.RUN_VISUAL_REGRESSION === '1'

let daemon: DaemonHandle

test.beforeAll(async () => {
  if (!RUN_VISUAL_REGRESSION) return
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

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

async function setDaemonTheme(theme: 'light' | 'dark'): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  if (!response.ok) {
    throw new Error(`visual-regression: failed to set ${theme} theme (${response.status})`)
  }
}

/**
 * Per-test snapshot config. Threshold 0.2% per RFC-054 plan §risk 9
 * (font subpixel jitter). `animations: 'disabled'` freezes CSS
 * transitions so a snapshot taken mid-animation isn't a flake source.
 * `caret: 'hide'` hides the text cursor (which blinks → naturally
 * changes between frames).
 */
const SNAPSHOT_OPTS = {
  maxDiffPixelRatio: 0.002,
  animations: 'disabled' as const,
  caret: 'hide' as const,
  fullPage: true,
}

test.describe('RFC-054 W2-5 — visual regression on key pages', () => {
  test.skip(
    !RUN_VISUAL_REGRESSION,
    'visual regression gated by RUN_VISUAL_REGRESSION=1 (see e2e/visual-regression.README.md)',
  )

  test('/auth (unauthenticated landing)', async ({ page }) => {
    await page.goto(`${daemon.baseUrl}/auth`)
    await expect(page.getByRole('heading', { name: /sign in|connect/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('auth.png', SNAPSHOT_OPTS)
  })

  test('/agents list', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('agents.png', SNAPSHOT_OPTS)
  })

  test('/workflows list', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('workflows.png', SNAPSHOT_OPTS)
  })

  test('/repos list', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/repos`)
    await expect(page.getByRole('heading', { name: /repos/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('repos.png', SNAPSHOT_OPTS)
  })

  test('/memory list', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/memory`)
    await expect(page.getByRole('heading', { name: /memor/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('memory.png', SNAPSHOT_OPTS)
  })

  test('/settings page', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings`)
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('settings.png', SNAPSHOT_OPTS)
  })

  // RFC-190: `/` used to be captured once as "homepage.png", but on this
  // clean daemon that actually rendered the FIRST-RUN Onboarding page (no
  // agents/workflows yet) — the dashboard had no visual coverage at all.
  // Split: first capture the true first-run Onboarding, THEN seed one
  // agent + workflow (same API seeding as nav-redesign.spec.ts) and capture
  // the real capability-portal homepage. Declaration order matters: the
  // onboarding shot must run before anything seeds this daemon.
  test('/ first-run (onboarding)', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/`)
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('onboarding.png', SNAPSHOT_OPTS)
  })

  test('/ (homepage / dashboard, seeded non-first-run)', async ({ page }) => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'visual-stub-agent',
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
        name: 'visual-stub-workflow',
        description: 'e2e seed',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      }),
    })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.locator('[data-testid="homepage"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('homepage.png', SNAPSHOT_OPTS)
  })

  test('/tasks list', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('tasks.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox empty dialog (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('light')
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByTestId('inbox-footer-button').click()
    const dialog = page.getByRole('dialog', { name: 'Inbox' })
    await expect(dialog).toContainText('Nothing waiting')
    await expect(page).toHaveScreenshot('inbox-empty-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox populated dialog (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('light')
    await routePopulatedInbox(page)
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.getByTestId('inbox-footer-button').click()
    await expect(page.getByTestId('inbox-row-review-visual-review-0')).toBeVisible()
    await expect(page).toHaveScreenshot('inbox-populated-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox populated dialog (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await setDaemonTheme('dark')
    await routePopulatedInbox(page)
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByTestId('inbox-footer-button').click()
    await expect(page.getByTestId('inbox-row-review-visual-review-0')).toBeVisible()
    await expect(page).toHaveScreenshot('inbox-populated-dark.png', SNAPSHOT_OPTS)
  })
})
