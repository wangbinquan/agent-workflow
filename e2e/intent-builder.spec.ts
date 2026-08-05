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
//   /intent list + detail, and a 390×844 dark-mode render sanity.

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
  // The prefilled mount landed: the mounts section lists the agent handle.
  await expect(page.getByText('res#agent#1')).toBeVisible({ timeout: 30_000 })
})

test('workflow draft makes the node graph a primary, expandable review surface', async ({
  page,
}) => {
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
    await expect(page.getByTestId('intent-stage-status')).toContainText('Step 3/4 · Review')
    await expect(page.getByText('Active', { exact: true })).toHaveCount(0)
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

    await page.getByRole('button', { name: 'Open large preview' }).click()
    const dialog = page.getByTestId('intent-preview-canvas-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('intent-preview-canvas-expanded')).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(build).toBeVisible()
    await expect(review).toBeVisible()
    await expect(inlineCanvas).toBeVisible()
    const mobileGeometry = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.content')
      const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
      const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
      const canvas = document.querySelector<HTMLElement>('[data-testid="intent-preview-canvas"]')
      if (content === null || build === null || review === null || canvas === null) return null
      const buildRect = build.getBoundingClientRect()
      const reviewRect = review.getBoundingClientRect()
      return {
        hasHorizontalOverflow: content.scrollWidth > content.clientWidth,
        reviewFollowsBuild: reviewRect.top >= buildRect.bottom,
        canvasFitsReview: canvas.getBoundingClientRect().width <= reviewRect.width,
      }
    })
    expect(mobileGeometry).toEqual({
      hasHorizontalOverflow: false,
      reviewFollowsBuild: true,
      canvasFitsReview: true,
    })
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
  await expect(page.getByTestId('intent-composer')).toBeVisible({ timeout: 15_000 })
  const mobileLayout = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.content')
    const build = document.querySelector<HTMLElement>('[data-testid="intent-build-workspace"]')
    const review = document.querySelector<HTMLElement>('[data-testid="intent-review-workspace"]')
    if (content === null || build === null || review === null) return null
    const buildRect = build.getBoundingClientRect()
    const reviewRect = review.getBoundingClientRect()
    return {
      hasHorizontalOverflow: content.scrollWidth > content.clientWidth,
      reviewFollowsBuild: reviewRect.top >= buildRect.bottom,
    }
  })
  expect(mobileLayout).toEqual({
    hasHorizontalOverflow: false,
    reviewFollowsBuild: true,
  })
  const detailScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(describeBlocking(detailScan)).toEqual([])
})
