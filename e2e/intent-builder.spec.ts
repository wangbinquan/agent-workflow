// RFC-234 (T13) — intent-builder e2e over the stubbed runtime.
//
// The intent stubs echo the RFC-200 nonce and answer with deterministic agent
// or workflow changesets, so this spec exercises the REAL chain end to end —
// session create → system-agent turn → envelope parse → draft mint → commit
// pipeline → resource lands — with only the model swapped out:
//   US-1  create session → draft panel (op card + rich preview) → commit →
//         agent exists via API and shows the provenance badge on its detail.
//   US-6  modify entry on the created agent's detail page → new session
//         pre-mounts it (res#agent#1 listed in the mounts section).
//   Workflow draft → four-step journey → shared canvas preview → expanded
//         dialog → responsive 390px layout without horizontal overflow.
//   Plus the RFC standard sweeps: axe (wcag2a/aa, critical+serious) on
//   /intent list + detail, desktop/mobile screenshots, a 390×844 dark-mode
//   render sanity, and a real hasTouch create/stepper path.

import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { startDaemon, type DaemonHandle } from './harness'
import { describeBlocking } from './axe-blocking'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon({ stubMode: 'intent' })
})
test.afterAll(async () => {
  await daemon.stop()
})

async function authPage(page: Page, targetDaemon: DaemonHandle = daemon): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [targetDaemon.baseUrl, targetDaemon.token] as const,
  )
}

/** Create a session through the UI and wait until the draft panel appears. */
async function createSessionAndAwaitDraft(
  page: Page,
  message: string,
  targetDaemon: DaemonHandle = daemon,
): Promise<void> {
  await page.goto(`${targetDaemon.baseUrl}/intent`)
  const inlineComposer = page.getByTestId('intent-create-inline')
  await inlineComposer.getByTestId('intent-create-message').fill(message)
  await inlineComposer.getByRole('button', { name: 'Start building' }).click()
  // Post-create navigation lands on /intent/:id; the 1.5s refetch loop keeps
  // polling while the stubbed turn runs.
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  await expect(page.getByTestId('intent-draft')).toBeVisible({ timeout: 30_000 })
}

test('US-1: intent create → draft preview → commit → resource lands with provenance', async ({
  page,
}) => {
  await authPage(page)
  await createSessionAndAwaitDraft(page, 'build me an auditor agent')

  // Draft panel: one op card with the agent rich preview.
  await expect(page.getByTestId('intent-op-card')).toHaveCount(1)
  await expect(page.getByTestId('intent-preview-agent')).toBeVisible()

  // Commit through the slot dialog (no secrets in this changeset).
  await page.getByTestId('intent-open-commit').click()
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-next').click()
  await page.getByTestId('intent-commit-submit').click()
  await expect(page.getByText('Committed', { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  })

  // The resource actually landed (API truth), owned by the committing user.
  const res = await fetch(`${daemon.baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  expect(res.ok).toBe(true)
  const agents = (await res.json()) as Array<{ id: string; name: string }>
  const auditor = agents.find((a) => a.name === 'e2e-auditor')
  expect(auditor).toBeTruthy()

  // Provenance badge on the resource detail page links back to the session.
  await page.goto(`${daemon.baseUrl}/agents/${auditor!.id}`)
  await expect(page.getByTestId('intent-provenance-badge')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('intent-provenance-badge').click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
})

test('US-6: modify entry pre-mounts the target resource in a new session', async ({ page }) => {
  await authPage(page)
  // Self-contained: create the modify target via API (no coupling to US-1).
  const created = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'e2e-modify-target',
      description: 'modify target',
      outputs: ['answer'],
      bodyMd: 'Target for the intent modify entry.',
    }),
  })
  expect(created.ok).toBe(true)
  const auditor = (await created.json()) as { id: string }

  await page.goto(`${daemon.baseUrl}/agents/${auditor.id}`)
  await page.getByTestId('agent-intent-entry').click()
  await page.waitForURL(/\/intent\?/)
  const dialog = page.getByRole('dialog')
  const dialogComposer = dialog.getByTestId('intent-create-dialog')
  await dialogComposer.getByTestId('intent-create-message').fill('rename the auditor outputs')
  await dialog.getByRole('button', { name: 'Start building' }).click()
  await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
  // The prefilled mount landed in the top-level working-context bar.
  await expect(page.getByText('e2e-modify-target', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
})

test('RFC-293 workbench queues context, iterates around checkpoints, discards, and scrolls independently', async ({
  page,
}, testInfo) => {
  const workbenchDaemon = await startDaemon({
    stubMode: 'intent',
    extraEnv: { STUB_INTENT_DELAY_MS: '900' },
  })
  try {
    await authPage(page, workbenchDaemon)
    await page.setViewportSize({ width: 1800, height: 1000 })
    const targetResponse = await fetch(`${workbenchDaemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workbenchDaemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'e2e-working-context',
        description: 'late mounted context',
        outputs: ['context'],
        bodyMd: 'Provide context.',
      }),
    })
    expect(targetResponse.ok).toBe(true)

    await page.goto(`${workbenchDaemon.baseUrl}/intent`)
    const create = page.getByTestId('intent-create-inline')
    await create.getByTestId('intent-create-message').fill('build an iterative intent workbench')
    await create.getByRole('button', { name: 'Start building' }).click()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)

    // The first turn is deliberately slow. Stage a resource while it runs and
    // queue the whole delta once; the successor appears without another message.
    await page.getByRole('button', { name: 'Manage working context' }).click()
    const workingDialog = page.getByRole('dialog')
    const picker = workingDialog.getByTestId('intent-mount-picker')
    await picker.focus()
    await page.getByRole('option', { name: /e2e-working-context/ }).click()
    await picker.press('Escape')
    await workingDialog.getByRole('button', { name: 'Refresh after this turn' }).click()
    await expect(page.getByText('e2e-working-context', { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('heading', { name: /Draft changeset \(revision 2\)/ })).toBeVisible(
      {
        timeout: 30_000,
      },
    )

    const composer = page.getByTestId('intent-composer')
    await composer.fill('Make the candidate more focused.')
    await page.getByTestId('intent-composer-submit').click()
    await expect(page.getByRole('heading', { name: /Draft changeset \(revision 3\)/ })).toBeVisible(
      {
        timeout: 30_000,
      },
    )

    await page.getByRole('button', { name: 'Discard and regenerate' }).click()
    await expect(page.getByRole('heading', { name: /Draft changeset \(revision 4\)/ })).toBeVisible(
      {
        timeout: 30_000,
      },
    )
    await expect(page.getByText('Discarded', { exact: true })).toBeVisible()

    await page.getByTestId('intent-open-commit').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-next').click()
    await page.getByTestId('intent-commit-submit').click()
    await expect(page.getByText('Continuing from checkpoint #1', { exact: true })).toBeVisible({
      timeout: 30_000,
    })

    await composer.fill('Continue beyond the committed checkpoint.')
    await page.getByTestId('intent-composer-submit').click()
    await expect(page.getByRole('heading', { name: /Draft changeset \(revision 5\)/ })).toBeVisible(
      {
        timeout: 30_000,
      },
    )

    const geometry = await page.evaluate(() => {
      const pageRoot = document.querySelector<HTMLElement>('.intent-session-page')
      const content = document.querySelector<HTMLElement>('.content')
      const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
      const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
      if (pageRoot === null || content === null || build === null || review === null) return null
      const reviewTop = review.getBoundingClientRect().top
      review.scrollTop = 0
      build.scrollTop = build.scrollHeight
      const buildBottom = build.scrollTop
      const reviewAfterBuildScroll = review.scrollTop
      review.scrollTop = Math.min(120, review.scrollHeight)
      const contentStyle = getComputedStyle(content)
      const usableContentWidth =
        content.clientWidth -
        Number.parseFloat(contentStyle.paddingLeft) -
        Number.parseFloat(contentStyle.paddingRight)
      return {
        fillsContent: Math.abs(pageRoot.getBoundingClientRect().width - usableContentWidth) <= 4,
        buildScrollable: build.scrollHeight > build.clientHeight,
        reviewVisibleAfterBuildScroll:
          review.getBoundingClientRect().top === reviewTop &&
          review.getBoundingClientRect().bottom > 0,
        reviewUnaffectedByBuildScroll: reviewAfterBuildScroll === 0,
        buildUnaffectedByReviewScroll: build.scrollTop === buildBottom,
        reviewWiderThanBuild: review.clientWidth > build.clientWidth,
      }
    })
    expect(geometry).toEqual({
      fillsContent: true,
      buildScrollable: true,
      reviewVisibleAfterBuildScroll: true,
      reviewUnaffectedByBuildScroll: true,
      buildUnaffectedByReviewScroll: true,
      reviewWiderThanBuild: true,
    })
    await testInfo.attach('intent-rfc293-workbench-wide', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    await page.setViewportSize({ width: 1080, height: 800 })
    const buildTab = page.getByRole('tab', { name: 'Build workspace' })
    const reviewTab = page.getByRole('tab', { name: 'Draft review workspace' })
    await expect(buildTab).toBeVisible()
    await buildTab.click()
    await expect(page.getByTestId('intent-build-workspace')).toBeVisible()
    await expect(page.getByTestId('intent-review-workspace')).toBeHidden()
    await reviewTab.click()
    await expect(page.getByTestId('intent-review-workspace')).toBeVisible()
    await expect(page.getByTestId('intent-build-workspace')).toBeHidden()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await testInfo.attach('intent-rfc293-workbench-1080', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
  } finally {
    await workbenchDaemon.stop()
  }
})

test('workflow draft makes the node graph a primary, expandable review surface', async ({
  page,
}, testInfo) => {
  const workflowDaemon = await startDaemon({
    stubMode: 'intent',
    // The old `intent-workflow-opencode.sh` was this stub plus this variable.
    extraEnv: { STUB_INTENT_VARIANT: 'workflow' },
  })
  try {
    await authPage(page, workflowDaemon)
    await createSessionAndAwaitDraft(page, 'build a request-to-worker workflow', workflowDaemon)

    const build = page.getByTestId('intent-build-workspace')
    const review = page.getByTestId('intent-review-workspace')
    const workflowPreview = page.getByTestId('intent-preview-workflow')
    const inlineCanvas = page.getByTestId('intent-preview-canvas')
    await expect(page.getByTestId('intent-journey-state')).toContainText('Step 3 of 4')
    await expect(page.getByTestId('intent-journey-state')).toContainText('Review')
    await expect(page.getByText('Active', { exact: true })).toHaveCount(0)
    await page
      .getByTestId('intent-op-outline-item')
      .filter({ hasText: 'e2e-workflow-preview' })
      .click()
    await expect(workflowPreview).toBeVisible()
    await expect(page.getByText('3 nodes')).toBeVisible()
    await expect(page.getByText('2 edges')).toBeVisible()

    const desktopGeometry = await page.evaluate(() => {
      const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
      const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
      const canvas = document.querySelector<HTMLElement>('[data-testid="intent-preview-canvas"]')
      if (build === null || review === null || canvas === null) return null
      return {
        buildWidth: build.getBoundingClientRect().width,
        reviewWidth: review.getBoundingClientRect().width,
        canvasHeight: canvas.getBoundingClientRect().height,
        canvasWidth: canvas.getBoundingClientRect().width,
      }
    })
    expect(desktopGeometry).not.toBeNull()
    expect(desktopGeometry!.reviewWidth).toBeGreaterThan(desktopGeometry!.buildWidth)
    expect(desktopGeometry!.canvasWidth).toBeGreaterThan(440)
    expect(desktopGeometry!.canvasHeight).toBeGreaterThanOrEqual(350)
    await testInfo.attach('intent-workflow-desktop', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    await page.getByRole('button', { name: 'Open large preview' }).click()
    const dialog = page.getByTestId('intent-preview-canvas-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('intent-preview-canvas-expanded')).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()

    await page.setViewportSize({ width: 390, height: 844 })
    // The reserved generation may settle before or after navigation, so the
    // first detail load legitimately initializes Build (while generating) or
    // Review (once the draft is ready) — the same race the a11y/mobile probe
    // handles (c3146c36). This probe owns the mobile Build workspace, so select
    // Build explicitly instead of racing the agent turn. The "live refresh must
    // not steal the tab" invariant (design §0A.3) is guaranteed by the product's
    // initializedWorkspaceSessionRef guard (intent.detail.tsx), not re-raced here.
    const buildTab = page.getByRole('tab', { name: 'Build workspace' })
    await expect(buildTab).toBeVisible()
    await buildTab.click()
    await expect(buildTab).toHaveAttribute('aria-selected', 'true')
    await expect(build).toBeVisible()
    await expect(review).toBeHidden()
    await expect(inlineCanvas).toBeHidden()
    await page.getByRole('tab', { name: 'Draft review workspace' }).click()
    await expect(review).toBeVisible()
    await expect(build).toBeHidden()
    await expect(inlineCanvas).toBeVisible()
    const mobileGeometry = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.content')
      const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
      const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
      const canvas = document.querySelector<HTMLElement>('[data-testid="intent-preview-canvas"]')
      const tabs = document.querySelector<HTMLElement>('.intent-session__mobile-tabs')
      const tabsViewport = tabs?.parentElement
      if (content === null || build === null || review === null || canvas === null) return null
      const reviewRect = review.getBoundingClientRect()
      return {
        hasHorizontalOverflow: content.scrollWidth > content.clientWidth,
        panelsRemainMounted: build.isConnected && review.isConnected,
        canvasFitsReview: canvas.getBoundingClientRect().width <= reviewRect.width,
        tabsFillViewport:
          tabs !== null &&
          tabsViewport !== null &&
          tabsViewport !== undefined &&
          Math.abs(
            tabs.getBoundingClientRect().width - tabsViewport.getBoundingClientRect().width,
          ) <= 2,
      }
    })
    expect(mobileGeometry).toEqual({
      hasHorizontalOverflow: false,
      panelsRemainMounted: true,
      canvasFitsReview: true,
      tabsFillViewport: true,
    })
    await testInfo.attach('intent-workflow-mobile', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    await page.getByRole('tab', { name: 'Build workspace' }).click()
    await expect(build).toBeVisible()
    await expect(review).toBeHidden()
  } finally {
    await workflowDaemon.stop()
  }
})

test('a11y + mobile dark: /intent list and session detail', async ({ page }) => {
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/intent`)
  await expect(page.getByRole('heading', { name: 'Intent Builder' }).first()).toBeVisible()
  const listScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  // RFC-254 T35: assert on the described form, not on `.map(v => v.id)` — same
  // empty-array contract, but a failure names the element and its colours.
  // See e2e/axe-blocking.ts for why (three Windows reds that proved nothing).
  expect(describeBlocking(listScan)).toEqual([])

  // Self-contained session for the detail scan (no coupling to other tests).
  const createdSession = await fetch(`${daemon.baseUrl}/api/intent-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'a11y sweep session' }),
  })
  expect(createdSession.ok).toBe(true)
  const rows = [(await createdSession.json()) as { id: string }]
  const themed = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme: 'dark' }),
  })
  expect(themed.ok).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${daemon.baseUrl}/intent/${rows[0]!.id}`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The reserved generation may settle before or after navigation. The
  // canonical journey therefore legitimately opens Build while generating or
  // Review once the draft is ready. This a11y/layout probe owns Build, so make
  // that tab choice explicit instead of racing the agent turn.
  const buildTab = page.getByRole('tab', { name: 'Build workspace' })
  await expect(buildTab).toBeVisible()
  await buildTab.click()
  await expect(buildTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('intent-composer')).toBeVisible({ timeout: 15_000 })
  const mobileLayout = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.content')
    const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
    const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
    if (content === null || build === null || review === null) return null
    return {
      hasHorizontalOverflow: content.scrollWidth > content.clientWidth,
      panelsRemainMounted: build.isConnected && review.isConnected,
      buildVisible: build.getBoundingClientRect().height > 0,
      reviewHidden: review.getBoundingClientRect().height === 0,
    }
  })
  expect(mobileLayout).toEqual({
    hasHorizontalOverflow: false,
    panelsRemainMounted: true,
    buildVisible: true,
    reviewHidden: true,
  })
  const detailScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(describeBlocking(detailScan)).toEqual([])
})

test('390px touch flow creates a session and advances the commit stepper', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  try {
    await authPage(page)
    await page.goto(`${daemon.baseUrl}/intent`)
    const composer = page.getByTestId('intent-create-inline')
    await composer.getByTestId('intent-create-message').fill('build a touch-first auditor agent')
    await composer.getByRole('button', { name: 'Start building' }).tap()
    await page.waitForURL(/\/intent\/[0-9A-Z]+/i)
    await expect(page.getByTestId('intent-draft')).toHaveCount(1, { timeout: 30_000 })
    await page.getByRole('tab', { name: 'Draft review workspace' }).tap()
    await expect(page.getByTestId('intent-draft')).toBeVisible()
    const mobileReview = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
      const heading = panel?.querySelector<HTMLElement>('.intent-session__draft h2')
      const actions = panel?.querySelector<HTMLElement>('.intent-session__draft-actions')
      if (panel === null || panel === undefined || heading === null || actions === null) return null
      const panelRect = panel.getBoundingClientRect()
      const headingRect = heading.getBoundingClientRect()
      return {
        actionPosition: getComputedStyle(actions).position,
        headingVisible: headingRect.top >= panelRect.top && headingRect.bottom <= panelRect.bottom,
      }
    })
    expect(mobileReview).toEqual({ actionPosition: 'static', headingVisible: true })

    await page.getByTestId('intent-open-commit').tap()
    await page.getByTestId('intent-commit-next').tap()
    await expect(page.locator('.intent-commit-stepper__step--current')).toContainText('Details')
    await page.getByTestId('intent-commit-next').tap()
    await expect(page.getByTestId('intent-commit-review')).toBeVisible()
  } finally {
    await context.close()
  }
})
