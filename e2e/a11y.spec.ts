// RFC-054 W2-6 — accessibility (axe-core) sweep of the key pages.
//
// LOCKS: every page on the critical user journey passes axe-core's `wcag2a`
// + `wcag2aa` rule sets with ZERO `critical` or `serious` violations.
// Catches:
//   * Missing label / form association regressions (Dialog inputs without
//     <label> linkage — a common shadcn/Base UI footgun)
//   * Contrast regressions from theme tweaks
//   * Missing alt text / unlabeled buttons / icon-only controls without
//     aria-label
//   * Tabindex collisions / unreachable focus targets
//
// Rationale for "critical+serious only": axe also reports `moderate` /
// `minor` findings (e.g. "heading-order", "region") which are useful style
// hints but often domain-specific and not regressions. Gating on the top
// two severity levels keeps the signal high — every red here SHOULD be
// fixed before merging.
//
// What this spec deliberately does NOT do:
//   * No `test.afterEach` injection into the existing happy-path specs.
//     That couples axe runtime to every spec and slows the suite by ~20%;
//     a dedicated a11y spec runs axe once per page, in serial within the
//     file, keeping wall-clock bounded.
//   * No screenshots / visual-regression mixing. axe is structural; visual
//     diffs land in W2-5 (visual-regression.spec.ts).

import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
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

/**
 * Pre-W2-6 known violations that exist in production today. Listed here
 * with a TODO + tracking note rather than failing the suite — new PRs
 * that introduce additional violations still go red, but landing W2-6
 * doesn't require fixing pre-existing ones in the same diff.
 *
 * Empty post-fix: RFC-054 W2-6 KNOWN_VIOLATIONS entries for /memory +
 * /settings color-contrast were lifted after the muted token in
 * styles.css was darkened from #6b7180 to #5b6271 (ratio 4.34 → 5.56),
 * clearing the WCAG AA 4.5:1 threshold.
 *
 * Format: `<route>::<rule-id>`.
 */
const KNOWN_VIOLATIONS = new Set<string>()

/**
 * Scan a single page for axe violations and fail the test if any critical
 * or serious ones are reported that aren't in `KNOWN_VIOLATIONS`. Returns
 * the moderate / minor count for informational logging.
 *
 * Also returns the set of violation keys actually seen so the allowlist
 * test below can detect stale entries (refactor fixed it; entry forgot
 * to come off).
 */
async function expectNoCriticalOrSeriousAxeViolations(
  page: Page,
  pageLabel: string,
): Promise<{ moderate: number; minor: number; seenKeys: Set<string> }> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    // Exclude xyflow's internal panels — they're third-party SVG content
    // with their own a11y story (drag handles, edge labels). We assert on
    // the page chrome around them, not the canvas internals.
    .exclude('.react-flow__renderer')
    .exclude('.react-flow__attribution')
    .analyze()

  const critical = results.violations.filter((v) => v.impact === 'critical')
  const serious = results.violations.filter((v) => v.impact === 'serious')
  const moderate = results.violations.filter((v) => v.impact === 'moderate')
  const minor = results.violations.filter((v) => v.impact === 'minor')

  const seenKeys = new Set<string>()
  const blocking: typeof results.violations = []
  for (const v of [...critical, ...serious]) {
    const key = `${pageLabel}::${v.id}`
    seenKeys.add(key)
    if (!KNOWN_VIOLATIONS.has(key)) blocking.push(v)
  }

  if (blocking.length > 0) {
    const lines = blocking.map(
      (v) =>
        `  [${v.impact}] ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'}): ${v.help}\n     ${v.helpUrl}\n` +
        v.nodes
          .map(
            (n) =>
              `       at: ${n.target.join(' ')}\n       ${n.failureSummary?.slice(0, 200) ?? ''}`,
          )
          .join('\n'),
    )
    throw new Error(
      `axe-core found ${blocking.length} unallowlisted critical+serious violations on ${pageLabel}:\n${lines.join('\n')}\n\nIf this is an intentional regression please fix the UI; if it's a known issue, add the key '<route>::<rule-id>' to KNOWN_VIOLATIONS with a TODO and tracking comment.`,
    )
  }
  return { moderate: moderate.length, minor: minor.length, seenKeys }
}

test.describe('RFC-054 W2-6 — accessibility (axe-core) on key pages', () => {
  test('/auth (unauthenticated landing) has no critical or serious violations', async ({
    page,
  }) => {
    // Visit /auth WITHOUT priming auth — the gate page itself must pass
    // a11y for users who can't authenticate yet (e.g. dev onboarding).
    await page.goto(`${daemon.baseUrl}/auth`)
    // Wait for the form to mount; the heading is the stable anchor.
    await expect(page.getByRole('heading', { name: /sign in|connect/i }).first()).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/auth')
  })

  test('/agents list passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents')
  })

  test('/agents/new (RFC-155 FormSection form) passes a11y', async ({ page }) => {
    // RFC-155 — the agent form is the first consumer of the FormSection
    // primitive (details/summary > h2 collapsible sections); scan it so the
    // new DOM shape stays inside the axe gate. The two collapsed sections are
    // also expanded so their inner fields are scanned, not skipped as hidden.
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents/new`)
    await expect(page.getByRole('heading', { name: 'Basics', exact: true })).toBeVisible()
    await page.getByRole('heading', { name: 'Resources & references', exact: true }).click()
    await page.getByRole('heading', { name: 'Advanced', exact: true }).click()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents/new')
  })

  test('/workflows list passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/workflows')
  })

  test('/repos list passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/repos`)
    await expect(page.getByRole('heading', { name: /repos/i }).first()).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/repos')
  })

  test('/memory list passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/memory`)
    await expect(page.getByRole('heading', { name: /memor/i }).first()).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/memory')
  })

  test('/settings page passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings`)
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/settings')
  })

  test('/ (homepage / dashboard) passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/`)
    // Homepage layout — wait for the main content region. The shell mounts
    // even without data, so don't anchor on data-dependent content.
    await page.waitForLoadState('networkidle')
    await expectNoCriticalOrSeriousAxeViolations(page, '/')
  })
})
