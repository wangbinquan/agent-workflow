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
import { routePopulatedInbox } from './inbox-fixtures'

let daemon: DaemonHandle

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  expect(response.ok, `failed to seed ${path} (${response.status})`).toBe(true)
  return response.json()
}

async function seedTerminalTask(): Promise<string> {
  const agentName = 'a11y-task-agent'
  await postJson('/api/agents', {
    name: agentName,
    description: 'RFC-201 task detail accessibility fixture',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })
  const workflow = (await postJson('/api/workflows', {
    name: 'a11y-task-workflow',
    description: 'RFC-201 task detail accessibility fixture',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentName,
          promptTemplate: 'Explain {{topic}} briefly.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
          position: { x: 640, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_in_agent',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'agent_1', portName: 'topic' },
        },
        {
          id: 'e_agent_out',
          source: { nodeId: 'agent_1', portName: 'answer' },
          target: { nodeId: 'out_1', portName: 'answer' },
        },
      ],
    },
  })) as { id: string }
  const task = (await postJson('/api/tasks', {
    workflowId: workflow.id,
    name: 'A11y task detail',
    scratch: true,
    inputs: { topic: 'accessible page sections' },
  })) as { id: string }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${daemon.baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (response.ok) {
      const current = (await response.json()) as { status: string }
      if (current.status === 'done') return task.id
      if (['failed', 'canceled', 'interrupted'].includes(current.status)) {
        throw new Error(`a11y task fixture reached ${current.status}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('a11y task fixture did not finish in 30s')
}

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

  test('/agents inbox dialog open passes a11y', async ({ page }) => {
    // Render both populated kind chips and a partial-error banner so the scan
    // covers the contrast/name risks hidden by a clean empty daemon.
    await routePopulatedInbox(page, { rows: 6, workgroupError: true })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents`)
    await page.getByTestId('inbox-footer-button').click()

    const dialog = page.getByRole('dialog', { name: 'Inbox' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(page.getByTestId('inbox-row-clarify-visual-clarify-0')).toBeVisible()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents (inbox dialog open)')
  })

  test('/agents/new (RFC-169 five-tab form) passes a11y', async ({ page }) => {
    // RFC-169/201 — the agent form is a five-tab right rail (Basics / Prompt / Ports
    // / Capabilities & collaboration / Advanced). Scan the default (Basics) panel + the tab
    // strip, then visit the Advanced tab so its JSON fields are also scanned
    // (keep-mounted panels are hidden until active, so axe skips them otherwise).
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/agents/new`)
    await expect(page.getByRole('tab', { name: 'Basics', exact: true })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents/new')
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents/new (Advanced tab)')

    // RFC-173/201 — the Capabilities & collaboration tab hosts the <MultiSelect> tag
    // comboboxes. Scan the two-group panel, then open a picker (with a selected
    // tag) so axe also covers the portaled listbox + chip remove buttons — the
    // nested-button risk lives exactly here.
    await page.getByRole('tab', { name: 'Capabilities & collaboration', exact: true }).click()
    await expectNoCriticalOrSeriousAxeViolations(
      page,
      '/agents/new (Capabilities & collaboration tab)',
    )
    const skills = page.getByRole('combobox', { name: 'Skills' })
    await skills.click()
    await skills.fill('demo-skill')
    await skills.press('Enter') // free-text add → a removable tag
    await skills.click() // reopen the listbox
    await expect(page.getByRole('listbox')).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/agents/new (Resources picker open)')
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

  test('/skills/new local tabs pass a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/skills/new`)
    await expect(page.getByRole('tab', { name: 'Manual creation', exact: true })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/skills/new (manual)')
    await page.getByRole('tab', { name: 'Import ZIP', exact: true }).click()
    await expectNoCriticalOrSeriousAxeViolations(page, '/skills/new (ZIP)')
  })

  test('/mcps detail tabs pass a11y', async ({ page }) => {
    await postJson('/api/mcps', {
      name: 'a11y-mcp',
      description: 'RFC-201 MCP accessibility fixture',
      type: 'local',
      config: { command: ['bun', '--version'] },
      enabled: true,
    })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/mcps/a11y-mcp`)
    await expect(page.getByRole('heading', { name: 'a11y-mcp', exact: true })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/mcps/a11y-mcp')
  })

  test('/settings mobile dark table and OIDC form dialog pass a11y', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
    await setDaemonTheme('dark')
    await page.route(/\/api\/oidc\/providers(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'a11y-provider',
            slug: 'a11y-provider',
            displayName: 'Accessibility identity provider',
            issuerUrl: 'https://identity.example.test',
            clientId: 'a11y-client',
            scopes: 'openid profile email',
            provisioning: 'invite',
            allowedEmailDomains: [],
            iconUrl: null,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      })
    })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/settings?tab=authentication`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.table-viewport__scroller')).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/settings auth table (390 dark)')

    await page.getByTestId('oidc-add-provider').click()
    await expect(page.getByRole('dialog', { name: 'Add OIDC provider' })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/settings OIDC dialog (390 dark)')
  })

  test('/ first-run (onboarding) passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/`)
    // On a clean daemon `/` renders the first-run Onboarding (RFC-190 split:
    // the seeded dashboard gets its own case below).
    await page.waitForLoadState('networkidle')
    await expectNoCriticalOrSeriousAxeViolations(page, '/ (onboarding)')
  })

  // RFC-211: the guided tour is a brand-new page whose whole point is that it
  // is built from the shared primitives rather than bespoke chrome — the flow
  // cards and the spotlight bubble (a labelled role="dialog" with real buttons)
  // carry roles/labels only because those primitives provide them. Axe is what
  // proves that stayed true. (The old example-sandbox track picker / stepper /
  // destructive-confirm dialog were removed; the tour now builds real resources
  // in place, so the interactive surface to scan is the spotlight overlay.)
  test('/onboarding (guided tour) passes a11y', async ({ page }) => {
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/onboarding`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('guide-page')).toBeVisible()
    // Scan the launcher landing (the three flow cards) first...
    await expectNoCriticalOrSeriousAxeViolations(page, '/onboarding (launcher)')
    // ...then start a flow so the spotlight overlay is on screen and scan the
    // dialog bubble too — that's the surface a keyboard/AT user actually drives.
    await page.getByTestId('guide-start-first-task').click()
    await expect(page.getByTestId('spotlight-tour-bubble')).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/onboarding (guided tour)')
  })

  // RFC-190: the capability-portal homepage (pipeline hero SVG + tiles +
  // task feed) only renders non-first-run — seed one agent + workflow so
  // the axe gate actually covers it. Runs AFTER the onboarding case
  // (declaration order) so that one still sees the clean daemon.
  test('/ (homepage / dashboard, seeded) passes a11y', async ({ page }) => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'a11y-stub-agent',
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
        name: 'a11y-stub-workflow',
        description: 'e2e seed',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      }),
    })
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/`)
    await expect(page.locator('[data-testid="homepage"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expectNoCriticalOrSeriousAxeViolations(page, '/ (seeded homepage)')
  })

  test('/tasks/:id grouped page sections pass a11y', async ({ page }) => {
    const taskId = await seedTerminalTask()
    await primeAuth(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.getByRole('heading', { name: /^A11y task detail/ })).toBeVisible()
    await expectNoCriticalOrSeriousAxeViolations(page, '/tasks/:id')
  })
})
