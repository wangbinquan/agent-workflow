// RFC-234 (T13) — intent-builder e2e over the stubbed runtime.
//
// stub-opencode-intent.sh echoes the RFC-200 nonce and answers every turn
// with a fixed changeset (one agent-create op, `$new:e2e-auditor`), so this
// spec exercises the REAL chain end to end — session create → system-agent
// turn → envelope parse → draft mint → commit pipeline → resource lands —
// with only the model swapped out:
//   US-1  create session → draft panel (op card + rich preview) → commit →
//         agent exists via API and shows the provenance badge on its detail.
//   US-6  modify entry on the created agent's detail page → new session
//         pre-mounts it (res#agent#1 listed in the mounts section).
//   Plus the RFC standard sweeps: axe (wcag2a/aa, critical+serious) on
//   /intent list + detail, and a 390×844 dark-mode render sanity.

import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, type DaemonHandle } from './harness'

const here = dirname(fileURLToPath(import.meta.url))
const stubIntent = resolve(here, 'fixtures', 'stub-opencode-intent.sh')

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon({ stubOpencode: stubIntent })
})
test.afterAll(async () => {
  await daemon.stop()
})

async function authPage(page: Page): Promise<void> {
  await page.addInitScript(
    ([baseUrl, token]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    [daemon.baseUrl, daemon.token] as const,
  )
}

/** Create a session through the UI and wait until the draft panel appears. */
async function createSessionAndAwaitDraft(page: Page, message: string): Promise<void> {
  await page.goto(`${daemon.baseUrl}/intent`)
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

test('a11y + mobile dark: /intent list and session detail', async ({ page }) => {
  await authPage(page)
  await page.goto(`${daemon.baseUrl}/intent`)
  await expect(page.getByRole('heading', { name: 'Intent Builder' }).first()).toBeVisible()
  const listScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const listBlocking = listScan.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  )
  expect(listBlocking.map((v) => v.id)).toEqual([])

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
  const detailBlocking = detailScan.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  )
  expect(detailBlocking.map((v) => v.id)).toEqual([])
})
