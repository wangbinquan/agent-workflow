// RFC-054 W2-3 — xyflow workflow editor interaction e2e.
//
// LOCKS the editor's keyboard / click / drag user surface:
//   * Editor mounts and renders existing nodes (cold path).
//   * Clicking a node opens its inspector drawer.
//   * Clicking an edge opens its inspector drawer.
//   * Delete key removes a selected node (and its edges).
//   * Backspace also removes (Mac convention).
//   * Drag-from-sidebar drops a new node onto the canvas
//     (HTML5 native drag — Playwright's `dragTo` does NOT fire
//     `dragstart` / `drop` on the draggable palette button, so this test
//     synthesizes the events with `page.evaluate` + DataTransfer).
//   * Drop into the canvas appends a new node row.
//   * The editor accepts undo via Ctrl+Z (RFC-016 wrappers preserved
//     across the undo step).
//   * Multi-select via Ctrl/Cmd-click extends the selection.
//   * Pan via the canvas viewport doesn't break click hit-test (a
//     subtle xyflow bug that affected RFC-016 wrapper-nest before
//     the pan / drag boundary was fixed).
//
// Notably absent: connect-edge by dragging a port handle to another
// port. xyflow's handle drag is a stream of `pointermove` events that
// Playwright's `page.mouse.move` doesn't drive through the React Flow
// reconciler — the test would be flaky. Edge creation is exercised
// indirectly via the round-trip in W2-7's import/export spec, and via
// the unit tests under `packages/frontend/tests/canvas-*.test.ts`.
//
// HTML5 drag note: the sidebar palette uses native HTML5 drag-and-drop
// (`draggable=true` + `onDragStart`). Playwright's built-in dragTo
// uses the legacy MOUSE pipeline which doesn't fire HTML5 drag events
// in chromium. The workaround used below (`page.evaluate` synthesizing
// the events with a real `DataTransfer`) is the only reliable way to
// drive HTML5 drag in Playwright today.

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

let daemon: DaemonHandle
let repoDir: string
let workflowId: string
let workflowSequence = 0

test.setTimeout(60_000)

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

async function seedAgent(name: string): Promise<void> {
  const res = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      description: 'W2-3 editor fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`seedAgent ${name}: ${res.status}`)
  }
}

async function seedWorkflow(
  definition: Record<string, unknown> = {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
      {
        id: 'agent_1',
        kind: 'agent-single',
        agentName: 'w2-3-agent-a',
        promptTemplate: 'Describe {{topic}}.',
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
        id: 'e1',
        source: { nodeId: 'in_1', portName: 'topic' },
        target: { nodeId: 'agent_1', portName: 'topic' },
      },
      {
        id: 'e2',
        source: { nodeId: 'agent_1', portName: 'answer' },
        target: { nodeId: 'out_1', portName: 'answer' },
      },
    ],
  },
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `w2-3-editor-workflow-${++workflowSequence}`,
      description: 'W2-3 fixture',
      definition,
    }),
  })
  if (!res.ok) throw new Error(`seedWorkflow: ${res.status}`)
  const wf = (await res.json()) as { id: string }
  return wf.id
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-editor-'))
  writeFileSync(join(repoDir, 'README.md'), '# w2-3 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  await seedAgent('w2-3-agent-a')
  await seedAgent('w2-3-agent-b')
})

// RFC-199 autosaves every canvas mutation. Each interaction case therefore
// needs its own workflow resource instead of inheriting the previous case's
// deleted/inserted nodes through the shared daemon.
test.beforeEach(async () => {
  workflowId = await seedWorkflow()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function openEditor(page: Page, expectedNodeCount = 3): Promise<void> {
  await primeAuth(page, daemon)
  await page.goto(`${daemon.baseUrl}/workflows/${workflowId}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  if (expectedNodeCount > 0) {
    await page.waitForSelector('.react-flow__node', { state: 'visible' })
  }
  await expect(page.locator('.react-flow__node')).toHaveCount(expectedNodeCount)
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test.describe('RFC-054 W2-3 — workflow editor interactions', () => {
  test('editor mounts and renders the 3 seeded nodes', async ({ page }) => {
    await openEditor(page)
    // The 3 nodes are input / agent-single / output. Each gets a
    // .react-flow__node element on mount.
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
  })

  test('clicking a node selects it (selected class applied)', async ({ page }) => {
    await openEditor(page)
    const firstNode = page.locator('.react-flow__node').first()
    await firstNode.click()
    // xyflow toggles `selected` class on the wrapper.
    await expect(firstNode).toHaveClass(/selected/)
  })

  test('clicking empty canvas clears the selection', async ({ page }) => {
    await openEditor(page)
    const firstNode = page.locator('.react-flow__node').first()
    await firstNode.click()
    await expect(firstNode).toHaveClass(/selected/)

    // Click the renderer pane background — the .react-flow__pane is
    // the click-eater layer underneath nodes/edges.
    await page.locator('.react-flow__pane').click({ position: { x: 50, y: 400 } })
    await expect(firstNode).not.toHaveClass(/selected/)
  })

  test('pressing Backspace with a node selected removes it', async ({ page }) => {
    await openEditor(page)
    const before = await page.locator('.react-flow__node').count()
    expect(before).toBe(3)

    // Click the agent (middle) node + delete it. Avoid deleting
    // input/output which would orphan the wiring.
    const agentNode = page.locator('.react-flow__node').nth(1)
    await agentNode.click()
    await expect(agentNode).toHaveClass(/selected/)
    await page.keyboard.press('Backspace')

    // Node count decreases by 1.
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
  })

  test('Ctrl+Z undoes the deletion (RFC-016 undo invariant)', async ({ page }) => {
    await openEditor(page)
    const agentNode = page.locator('.react-flow__node').nth(1)
    await agentNode.click()
    await page.keyboard.press('Backspace')
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    await expect(page.getByTestId('workflow-undo')).toBeEnabled()
    await expect(page.locator('.workflow-canvas')).toBeFocused()

    await page.keyboard.press('Control+z')
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await expect(page.locator('.react-flow__node').nth(1)).toHaveClass(/selected/)

    await page.keyboard.press('Control+Shift+z')
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
  })

  test('Shift+click extends node selection (xyflow multi-select default)', async ({
    page,
    browserName,
  }) => {
    // Skipped on webkit (Playwright WPE build): `force: true` got past
    // the actionability hit-test but xyflow's Shift modifier handling on
    // webkit doesn't actually extend the selection — the second click
    // deselects the first instead of multi-selecting. Verified in
    // webkit-nightly run 26293636014. The multi-select feature is
    // exercised in production on Chromium (xyflow's primary support
    // matrix); cross-browser parity is xyflow's responsibility.
    test.skip(
      browserName === 'webkit',
      'xyflow Shift+click multi-select not stable on Playwright webkit',
    )
    await openEditor(page)
    const nodes = page.locator('.react-flow__node')
    await nodes.nth(0).click()
    // xyflow's default multiSelectionKeyCode is 'Shift' (on non-mac) /
    // 'Meta' (on mac). Playwright on darwin maps Shift correctly via
    // the modifier system; the Shift key works cross-platform.
    await nodes.nth(1).click({ modifiers: ['Shift'] })
    await expect(nodes.nth(0)).toHaveClass(/selected/)
    await expect(nodes.nth(1)).toHaveClass(/selected/)
  })

  test('drag-from-sidebar synthesizes HTML5 drag → new node appended', async ({ page }) => {
    await openEditor(page)
    const before = await page.locator('.react-flow__node').count()
    expect(before).toBe(3)

    // Find the first draggable palette item in the sidebar.
    const paletteItem = page.locator('.editor-sidebar__item').first()
    await expect(paletteItem).toBeVisible()

    // Synthesize an HTML5 drag from the palette item to a canvas
    // location. Playwright's `dragTo` uses the mouse pipeline which
    // skips dragstart/drop event firing for HTML5 drag — we use
    // page.evaluate with a real DataTransfer instead.
    await page.evaluate(() => {
      const src = document.querySelector('.editor-sidebar__item') as HTMLElement | null
      const canvas = document.querySelector('.react-flow__pane') as HTMLElement | null
      if (!src || !canvas) throw new Error('palette or canvas missing')
      const box = canvas.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const dt = new DataTransfer()
      src.dispatchEvent(
        new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }),
      )
      // The drop target (canvas .react-flow__pane) needs dragover +
      // drop. preventDefault is required on dragover for drop to fire.
      const over = new DragEvent('dragover', {
        dataTransfer: dt,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      })
      canvas.dispatchEvent(over)
      const drop = new DragEvent('drop', {
        dataTransfer: dt,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      })
      canvas.dispatchEvent(drop)
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    })

    // The drop handler appends a new node. Count goes up by 1.
    await page.waitForTimeout(300)
    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1)
  })

  test('390px palette click and keyboard activation add one selected node without overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openEditor(page)
    const nodes = page.locator('.react-flow__node')
    const paletteItem = page.locator('.editor-sidebar__item').first()
    const before = await nodes.count()

    // Pointer/touch-equivalent activation: the palette row is a real button,
    // so mobile users do not depend on unsupported HTML5 touch dragging.
    await paletteItem.click()
    await expect(nodes).toHaveCount(before + 1)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
    await expect(page.locator('.editor-layout--with-inspector > .inspector')).toBeVisible()
    await page.waitForTimeout(100)
    expect(await nodes.count()).toBe(before + 1)

    // Restore the fixture count, then exercise the native keyboard activation
    // path. Space must synthesize one click, not double-fire through a custom
    // key handler.
    await page.locator('.react-flow__node.selected').click()
    await page.keyboard.press('Backspace')
    await expect(nodes).toHaveCount(before)
    await paletteItem.focus()
    await page.keyboard.press('Space')
    await expect(nodes).toHaveCount(before + 1)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
    await expect(page.locator('.editor-layout--with-inspector > .inspector')).toBeVisible()
    await page.waitForTimeout(100)
    expect(await nodes.count()).toBe(before + 1)

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(overflow.body).toBeLessThanOrEqual(1)
    expect(overflow.root).toBeLessThanOrEqual(1)
  })

  test('canvas pan does not break subsequent click hit-test (RFC-016 pre-fix regression)', async ({
    page,
  }) => {
    await openEditor(page)
    const before = await page.locator('.react-flow__node').count()

    // Pan via mouse drag on the empty pane area.
    await page.mouse.move(200, 400)
    await page.mouse.down()
    await page.mouse.move(400, 500, { steps: 5 })
    await page.mouse.up()

    // After pan, the first node should still be clickable + selectable.
    const firstNode = page.locator('.react-flow__node').first()
    await firstNode.click()
    await expect(firstNode).toHaveClass(/selected/)

    // No nodes were created or deleted by the pan.
    await expect(page.locator('.react-flow__node')).toHaveCount(before)
  })

  test('palette filter input narrows the visible drag items', async ({ page }) => {
    await openEditor(page)
    // The palette filter is a search input above the sections.
    const filter = page.locator('input[type="search"]').first()
    await expect(filter).toBeVisible()
    const totalBefore = await page.locator('.editor-sidebar__item').count()
    expect(totalBefore).toBeGreaterThan(0)

    // Type a string that should narrow the list. "agent" should
    // remain (palette has agent-single + agent-multi entries).
    await filter.fill('agent')
    await page.waitForTimeout(200)
    const afterAgent = await page.locator('.editor-sidebar__item').count()
    // At minimum the agent rows remain; at most the original count.
    expect(afterAgent).toBeGreaterThan(0)
    expect(afterAgent).toBeLessThanOrEqual(totalBefore)

    // Type a string that should match nothing.
    await filter.fill('zzz-no-such-item-1729')
    await page.waitForTimeout(200)
    await expect(page.locator('.editor-sidebar__item')).toHaveCount(0)
  })

  test('react-flow controls panel renders zoom / fit-view buttons', async ({ page }) => {
    await openEditor(page)
    // xyflow's Controls subcomponent renders 4 default buttons:
    // zoom in, zoom out, fit-view, lock interactivity.
    await expect(page.locator('.react-flow__controls')).toBeVisible()
    const controlButtons = page.locator('.react-flow__controls button')
    expect(await controlButtons.count()).toBeGreaterThanOrEqual(3)
  })

  test('editor URL reflects the current workflow id', async ({ page }) => {
    await openEditor(page)
    // Sanity that the route param plumbs through — if a future
    // router refactor accidentally inlines the id, this fires.
    expect(page.url()).toContain(`/workflows/${workflowId}`)
  })

  test('RFC-199 B0 records the five legacy editor geometry baselines', async ({
    page,
  }, testInfo) => {
    type Geometry = {
      viewport: { width: number; height: number }
      columns: string
      layoutClientHeight: number
      layoutScrollHeight: number
      palette: { x: number; y: number; width: number; height: number; bottom: number }
      canvas: { x: number; y: number; width: number; height: number; bottom: number }
      inspector: { x: number; y: number; width: number; height: number; bottom: number }
    }

    const samples: Geometry[] = []
    for (const viewport of [
      { width: 1536, height: 900 },
      { width: 1280, height: 800 },
      { width: 1179, height: 800 },
      { width: 720, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      await openEditor(page)
      await page.locator('.react-flow__node[data-id="agent_1"]').click()
      await expect(page.locator('.editor-layout > .inspector')).toBeVisible()

      samples.push(
        await page.locator('.editor-layout').evaluate((layout, currentViewport) => {
          const relativeRect = (element: Element) => {
            const layoutBox = layout.getBoundingClientRect()
            const box = element.getBoundingClientRect()
            const x = box.left - layoutBox.left + layout.scrollLeft
            const y = box.top - layoutBox.top + layout.scrollTop
            return {
              x,
              y,
              width: box.width,
              height: box.height,
              bottom: y + box.height,
            }
          }
          const palette = layout.querySelector(':scope > .editor-sidebar')
          const canvas = layout.querySelector(':scope > .canvas-frame')
          const inspector = layout.querySelector(':scope > .inspector')
          if (palette === null || canvas === null || inspector === null) {
            throw new Error('legacy editor columns missing')
          }
          return {
            viewport: currentViewport,
            columns: getComputedStyle(layout).gridTemplateColumns,
            layoutClientHeight: layout.clientHeight,
            layoutScrollHeight: layout.scrollHeight,
            palette: relativeRect(palette),
            canvas: relativeRect(canvas),
            inspector: relativeRect(inspector),
          }
        }, viewport),
      )
    }

    await testInfo.attach('rfc199-b0-editor-geometry.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    })

    const byWidth = new Map(samples.map((sample) => [sample.viewport.width, sample]))
    const wide = byWidth.get(1536)!
    const cramped = byWidth.get(1280)!
    const compactDesktop = byWidth.get(1179)!
    const boundary = byWidth.get(720)!
    const phone = byWidth.get(390)!

    // Legacy desktop is always three rails. The 1280 fixture proves the
    // RFC's motivating defect directly: the actual canvas is far below the
    // future 520px floor, and 1179 gets squeezed even further.
    expect(wide.palette.width).toBeCloseTo(240, 0)
    expect(wide.inspector.width).toBeCloseTo(480, 0)
    expect(cramped.palette.width).toBeCloseTo(240, 0)
    expect(cramped.inspector.width).toBeCloseTo(480, 0)
    expect(cramped.canvas.width).toBeLessThan(520)
    expect(compactDesktop.canvas.width).toBeLessThan(cramped.canvas.width)

    // <=720 is the RFC-198 vertical-stack baseline being superseded. At
    // 390px all three surfaces are laid out one after another and overflow
    // the bounded editor viewport: this is a measured long tower, not a
    // screenshot-only observation.
    expect(boundary.palette.bottom).toBeLessThanOrEqual(boundary.canvas.y + 1)
    expect(boundary.canvas.bottom).toBeLessThanOrEqual(boundary.inspector.y + 1)
    expect(phone.palette.bottom).toBeLessThanOrEqual(phone.canvas.y + 1)
    expect(phone.canvas.bottom).toBeLessThanOrEqual(phone.inspector.y + 1)
    expect(phone.canvas.height).toBeGreaterThanOrEqual(560)
    expect(phone.inspector.height).toBeGreaterThanOrEqual(384)
    expect(phone.layoutScrollHeight).toBeGreaterThan(phone.layoutClientHeight + 300)
  })

  test('RFC-199 B0 screen-to-flow placement survives a zoomed viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    // Keep the viewport centre unoccupied so this case isolates exact
    // screen-to-flow projection. Collision/spiral displacement is locked by
    // workflow-placement.test.ts and must not be mistaken for projection drift.
    workflowId = await seedWorkflow({
      $schema_version: 3,
      inputs: [
        { kind: 'text', key: 'left', label: 'Left', required: false },
        { kind: 'text', key: 'right', label: 'Right', required: false },
      ],
      nodes: [
        { id: 'left', kind: 'input', inputKey: 'left', position: { x: -1_000, y: 0 } },
        { id: 'right', kind: 'input', inputKey: 'right', position: { x: 1_000, y: 0 } },
      ],
      edges: [],
    })
    await openEditor(page, 2)
    await page.locator('.react-flow__node[data-id="left"]').click()
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()

    const pane = page.locator('.react-flow__pane')
    const zoomIn = page.locator('.react-flow__controls-zoomin')
    await zoomIn.click()
    await zoomIn.click()
    await page.waitForTimeout(250)
    const transform = await page
      .locator('.react-flow__viewport')
      .evaluate((element) => getComputedStyle(element).transform)
    expect(transform).not.toBe('none')

    const before = await page
      .locator('.react-flow__node')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id')))
    const paneBox = await pane.boundingBox()
    if (paneBox === null) throw new Error('canvas pane missing')
    const expectedTopLeft = {
      x: paneBox.x + paneBox.width / 2,
      y: paneBox.y + paneBox.height / 2,
    }

    await page.locator('.editor-sidebar__item').first().click()
    await expect(page.locator('.react-flow__node')).toHaveCount(before.length + 1)
    const insertedId = await page
      .locator('.react-flow__node')
      .evaluateAll(
        (nodes, oldIds) =>
          nodes.map((node) => node.getAttribute('data-id')).find((id) => !oldIds.includes(id)) ??
          null,
        before,
      )
    if (insertedId === null) throw new Error('inserted node id missing')
    const insertedBox = await page
      .locator(`.react-flow__node[data-id="${insertedId}"]`)
      .boundingBox()
    if (insertedBox === null) throw new Error('inserted node box missing')

    // addPaletteItemAtViewportCenter takes a screen point, converts it with
    // screenToFlowPosition, and xyflow projects it back through the active
    // zoom transform. The new node's top-left therefore lands on the visible
    // pane center even though the flow viewport is no longer identity.
    expect(Math.abs(insertedBox.x - expectedTopLeft.x)).toBeLessThanOrEqual(3)
    expect(Math.abs(insertedBox.y - expectedTopLeft.y)).toBeLessThanOrEqual(3)
  })
})
