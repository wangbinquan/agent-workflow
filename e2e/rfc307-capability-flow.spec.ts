// RFC-307 T27 — the flow is visible and editable on a real daemon, and the
// demo content is there to make that provable without a code host.
//
// RFC-309 MOVED the surface these assertions read: the standalone Flow tab is
// gone, because its first two questions (which capability, then which
// configuration) are both answered by opening a template. Everything RFC-307
// claimed still has to be true — it is just reached at `/code/templates/$id`
// now, which is why this file was rewritten rather than deleted.
//
// The unit suites already lock the projection, the soundness check, the route
// and the seeder. What only this spec can show is the thing the user actually
// asked for — that on a FRESH INSTALL, with nothing configured and no merge
// request anywhere, a person can:
//
//   1. open `/code`, see a capability's thirteen steps drawn, and see which two
//      of them are a model (constitution R2 made visible);
//   2. click a step and change what it runs — and have the change survive a
//      reload, which is what "改得动" means and what a form that 403s does not;
//   3. see a finished round with its state on the same picture.
//
// Every piece of that depends on the demo seed, which is exactly why the seed
// is part of this RFC rather than a nicety: without it a fresh install has no
// binding to configure, so the drawer would open onto nothing.
//
// The daemon is real, the database is real, the seed runs at boot the way it
// does in production. Nothing is stubbed here — there is nothing to stub,
// because the whole feature is deliberately free of the code host.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

/**
 * Hand the browser the daemon it should talk to, and an admin session.
 *
 * English is pinned deliberately: these assertions read user-facing copy, and a
 * spec that passes or fails on the tester's language preference is not testing
 * the product.
 */
/** The demo template the seed plants — the only one on a fresh install. */
const DEMO_TEMPLATE = 'aw-demo-template-mr-review'

async function attach(page: Page): Promise<void> {
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
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test('a fresh install can see a capability flow with nothing configured', async ({ page }) => {
  // AC-1: no repository, no enabled capability, no round. The question "what
  // does this thing do?" has to be answerable BEFORE any of that. RFC-309 keeps
  // the guarantee and changes the door: the demo template is what a fresh
  // install has, and opening it IS opening the flow.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code/templates/${DEMO_TEMPLATE}`)

  await expect(page.getByTestId('code-flow-panel')).toBeVisible()
  const cards = page.locator('[data-testid="stage-node-flow"] .stage-node')
  await expect(cards).toHaveCount(13, { timeout: 30_000 })

  // The constitution, on screen: thirteen steps, two of them a model.
  await expect(page.locator('[data-testid="stage-node-flow"] [data-stage-kind="ai"]')).toHaveCount(
    2,
  )
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible()
  await expect(page.getByTestId('stage-node-publish')).toBeVisible()
})

test('a capability with no sequence says so rather than drawing an empty canvas', async ({
  page,
}) => {
  // `mr-monitor` is the standing monitor loop. Reached now by pointing a
  // template at it — the Flow tab's capability switcher is gone with the tab.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code?tab=templates`)
  await expect(page.getByTestId('code-new-template')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('code-new-template').click()

  await page.getByTestId('code-template-capability').click()
  await page.getByRole('option', { name: /monitor/i }).click()

  // A real answer in words. An empty canvas would read as "nothing happens
  // here", and a 404 would send someone hunting for a typo that is not there.
  await expect(page.getByText('not driven by a stage sequence')).toBeVisible()
})

test('clicking a step opens its real configuration, and the shared slot is named', async ({
  page,
}) => {
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code/templates/${DEMO_TEMPLATE}`)
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('stage-node-review-shard').click()

  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  // The artifacts it reads and writes — the answer to "why does this step need
  // that", which the plain-text list never gave.
  await expect(page.getByTestId('stage-io-review-shard')).toContainText('shards')

  // AC-4's second half: `reviewer` fills BOTH AI stages, and the drawer says so
  // rather than letting someone believe they changed one step of thirteen.
  await expect(page.getByTestId('stage-siblings-review-shard')).toContainText('review-global')

  // AC-6: the hook allowlist as a statement of fact, taken from the contract.
  await expect(page.getByTestId('stage-injectable-review-shard')).toContainText('extraContext')
})

test('a prompt edited on the graph is saved and still there after a reload', async ({ page }) => {
  // The whole "改得动" claim in one assertion. Before this RFC the same edit was
  // possible only by finding `promptBySlot` in a JSON form with no indication of
  // which of thirteen steps it belonged to.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code/templates/${DEMO_TEMPLATE}`)
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stage-node-review-shard').click()

  const edited = `edited by e2e ${String(Date.now())}`
  const prompt = page.getByTestId('stage-prompt-review-shard')
  await expect(prompt).toBeVisible()
  await prompt.fill(edited)
  await page.getByTestId('stage-save-agent-review-shard').click()

  // Round-trips through `PUT /api/capability-templates/:id` and comes back from
  // the database, not from local state.
  await page.reload()
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stage-node-review-shard').click()
  await expect(page.getByTestId('stage-prompt-review-shard')).toHaveValue(edited)
})

test('the demo round shows the same picture with its state on it', async ({ page }) => {
  // AC-3 + AC-8. The seeded round exists precisely so this is reachable on a
  // fresh install; a real one would need a code host, which is the requirement
  // the demo exists to remove.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code?tab=activity`)

  // The seeded work item, addressed by its anchor rather than by the capability
  // name — which also appears in the Flow tab mounted behind this one (RFC-169).
  await expect(page.getByText('mr-review · mr 42')).toBeVisible({ timeout: 30_000 })

  // Every stage of the seeded round finished, so every card carries `done` —
  // the runtime overlay reusing the canvas status rules rather than defining
  // its own. Scoped to the round's own namespaced canvas.
  const done = page.locator('[data-testid^="round-stage-"][data-status="done"]')
  await expect(done).toHaveCount(13, { timeout: 30_000 })
})

test('the demo content is labelled as a sample and is not read-only', async ({ page }) => {
  // The rule that keeps sample data from becoming a nuisance. `builtin: true`
  // would have hidden these rows from every list and refused every edit — which
  // is what the first version did, and what made "safe to delete" untrue.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/workflows`)
  await expect(page.getByText('[demo] Review a change')).toBeVisible({ timeout: 30_000 })

  await page.goto(`${daemon.baseUrl}/code?tab=templates`)
  // RFC-309 hard-cut the framework/binding pair to one editable template.
  await expect(page.getByTestId('code-template-aw-demo-template-mr-review')).toBeVisible()
})
