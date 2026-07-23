// RFC-211 §12 — spotlight tour, real-browser regression locks.
//
// Why this must be an e2e (not a jsdom unit) test: the reported bug only
// reproduces in a real browser. The first-task tour has a "click the ports tab"
// step whose NEXT step targets the add-output-port button — a control that is
// keep-mounted but hidden (zero-size rect) until the ports tab is opened. If the
// user could press Next here, the tour would jump to a step whose anchor exists
// but measures 0×0 at the origin, so the bubble floated over nothing / lost its
// place. The fix makes that step advance ONLY when the highlighted tab is
// clicked (no Next button).
//
// The advance is wired via a document-level, capture-phase click listener that
// matches the anchor by selector at click time. An earlier attempt bound a
// listener directly to the tab node; React reconciles/re-renders that node, so
// the once-bound listener went stale and the click silently failed to advance —
// a jsdom unit test PASSED on that broken version because jsdom doesn't exercise
// the same re-render path. Hence this browser lock.

import { expect, test, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let seededAgentId = ''

test.beforeAll(async () => {
  daemon = await startDaemon()
  // The launch/create-task segment of the tour needs a real agent to launch.
  const res = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'my-coder',
      description: 'RFC-211 tour fixture agent',
      outputs: ['result'],
      readonly: false,
      bodyMd: '',
    }),
  })
  expect(res.ok, `failed to seed agent (${res.status})`).toBe(true)
  seededAgentId = ((await res.json()) as { id: string }).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

/** Auth + seed the spotlight tour directly at a given step, before first paint. */
async function primeTour(page: Page, stepIndex: number): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token, stepIndex }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
      window.localStorage.setItem('aw-tour-seen', '1')
      window.localStorage.setItem('aw-tour', JSON.stringify({ tourId: 'first-task', stepIndex }))
    },
    { baseUrl: daemon.baseUrl, token: daemon.token, stepIndex },
  )
}

test('a click-advance step hides Next and advances only when the highlighted tab is clicked', async ({
  page,
}) => {
  // Step index 3 of the first-task tour is "open the ports tab" (advanceOnClick).
  await primeTour(page, 3)
  await page.goto(`${daemon.baseUrl}/agents/new`)

  const bubble = page.getByTestId('spotlight-tour-bubble')
  await expect(bubble).toBeVisible()
  // The reported regression: a click-advance step must NOT offer a Next button
  // (pressing it would strand the tour on a hidden anchor).
  await expect(page.getByTestId('spotlight-tour-next')).toHaveCount(0)

  // The add-port button is keep-mounted but hidden until the tab opens — the
  // 0×0 anchor that a premature advance would have floated the bubble over.
  await expect(page.getByTestId('agent-tab-ports')).toBeVisible()
  await expect(page.getByTestId('agent-output-port-add')).toBeHidden()

  // Clicking the highlighted tab is the only way forward: it opens the panel AND
  // advances the tour to the add-port step, whose anchor is now real.
  await page.getByTestId('agent-tab-ports').click()
  await expect(page.getByTestId('agent-panel-ports')).toBeVisible()
  await expect(page.getByTestId('agent-output-port-add')).toBeVisible()

  // The bubble followed to the next step (5 of 9) and stayed on screen.
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText('Step 5 of 9')

  // No off-screen float on the tight right/bottom-edge anchor.
  const box = await bubble.boundingBox()
  const vp = page.viewportSize()
  expect(box).not.toBeNull()
  if (box !== null && vp !== null) {
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  }
})

// RFC-211 §12 — the create-task segment (steps 7→8→9). The reported dead-end:
// clicking Launch (step 7) landed on /tasks/new, but the "submit" step's
// advanceOnRoute '/tasks/' was a prefix of '/tasks/new', so the tour auto-
// skipped it and jumped to "watch result" over a blank, unsubmitted wizard.
// The fix: the launch entry deep-links `tour=first-task`, the wizard opens on
// Confirm with a scratch space + prefilled name/prompt (submit button present &
// enabled), and the submit step advances on the click — not on the route.
test('launch step opens a ready-to-submit wizard and does not skip the submit step', async ({
  page,
}) => {
  // Seed at the launch step (index 6 / "Step 7 of 9") on the agent detail page.
  await primeTour(page, 6)
  await page.goto(`${daemon.baseUrl}/agents/${seededAgentId}`)

  const bubble = page.getByTestId('spotlight-tour-bubble')
  await expect(bubble).toBeVisible()
  await expect(bubble).toContainText('Step 7 of 9')

  // Click the highlighted Launch entry.
  await page.getByTestId('agent-launch-button').click()

  // It deep-links the wizard into tour mode.
  await expect(page).toHaveURL(/\/tasks\/new\?.*tour=first-task/)

  // The tour must land on the SUBMIT step (8 of 9) — NOT cascade past it to the
  // result step (9 of 9). This is the exact regression.
  await expect(bubble).toContainText('Step 8 of 9')

  // The wizard opened on Confirm with everything prefilled, so the real launch
  // button is present AND enabled (canSubmit true) — the anchor the tour points
  // at actually exists and is actionable.
  const launch = page.getByTestId('wizard-launch')
  await expect(launch).toBeVisible()
  await expect(launch).toBeEnabled()
  await expect(launch).toHaveAttribute('data-tour', 'task-submit')

  // The bubble is anchored (not floating centred over a missing target).
  const box = await bubble.boundingBox()
  expect(box).not.toBeNull()
})

test('clicking Launch submits the task and advances the tour to the result step', async ({
  page,
}) => {
  await primeTour(page, 6)
  await page.goto(`${daemon.baseUrl}/agents/${seededAgentId}`)
  await page.getByTestId('agent-launch-button').click()
  await expect(page).toHaveURL(/\/tasks\/new\?.*tour=first-task/)

  const bubble = page.getByTestId('spotlight-tour-bubble')
  await expect(bubble).toContainText('Step 8 of 9')

  // Submit the prefilled task. This both fires the tour's click-advance and
  // launches the task, which navigates to the task detail page.
  await page.getByTestId('wizard-launch').click()

  // Landed on the task detail page (/tasks/<id>, not /tasks/new).
  await expect(page).toHaveURL(/\/tasks\/(?!new)[^/]+/)

  // The final step (9 of 9) spotlights the live task status on the detail page.
  await expect(bubble).toContainText('Step 9 of 9')
  await expect(page.locator('[data-tour="task-status"]')).toBeVisible()
})
