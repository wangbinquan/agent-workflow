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

test.beforeAll(async () => {
  daemon = await startDaemon()
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
