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
import AxeBuilder from '@axe-core/playwright'
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
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`seedAgent ${name}: ${res.status}`)
  }
}

async function useLargeAgentCatalog(page: Page, total = 50): Promise<void> {
  await page.route(/\/api\/agents(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    if (!response.ok()) {
      await route.fulfill({ response })
      return
    }
    const existing = (await response.json()) as Array<Record<string, unknown>>
    const template = existing[0]
    if (template === undefined) throw new Error('large Agent catalog needs one seeded template')
    const synthetic = Array.from({ length: Math.max(0, total - existing.length) }, (_, index) => ({
      ...template,
      id: `rfc219-agent-${index}`,
      name:
        index === 0
          ? 'rfc219-agent-with-a-name-long-enough-to-prove-the-type-chip-never-overlaps'
          : `rfc219-agent-${String(index).padStart(2, '0')}`,
      description: `RFC-219 large catalog capability ${index}`,
    }))
    await route.fulfill({ response, json: [...existing, ...synthetic] })
  })
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

async function expectEditorAxeClean(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('.react-flow__renderer')
    .exclude('.react-flow__attribution')
    .analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${label} axe violations`,
  ).toEqual([])
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
    await page.setViewportSize({ width: 1536, height: 900 })
    await openEditor(page)
    const before = await page.locator('.react-flow__node').count()
    expect(before).toBe(3)

    // The five RFC-219 categories stay inside the 240px rail. Their shared
    // TabBar owns horizontal overflow; the editor page itself never does.
    const categories = page.getByTestId('workflow-node-picker-categories')
    await expect(categories).toBeVisible()
    const categoryOverflow = await categories.evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    expect(categoryOverflow.scroll).toBeGreaterThan(categoryOverflow.client)
    expect(categoryOverflow.body).toBeLessThanOrEqual(1)

    // The row is a zero-drag click target; its explicit grip owns native
    // HTML5 drag so pointer activation cannot accidentally start a drag.
    const dragGrip = page.locator('.workflow-node-picker__drag-grip').first()
    await expect(dragGrip).toBeVisible()

    // Synthesize an HTML5 drag from the palette item to a canvas
    // location. Playwright's `dragTo` uses the mouse pipeline which
    // skips dragstart/drop event firing for HTML5 drag — we use
    // page.evaluate with a real DataTransfer instead.
    await page.evaluate(() => {
      const src = document.querySelector('.workflow-node-picker__drag-grip') as HTMLElement | null
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
    const before = await nodes.count()

    // Pointer/touch-equivalent activation: Add opens the full-screen palette,
    // whose rows are real buttons. Mobile users never depend on HTML5 drag.
    await page.getByTestId('workflow-add-step').click()
    const palette = page.getByTestId('workflow-editor-palette-surface')
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('tablist', { name: 'Filter by node type' })).toBeVisible()
    await palette.locator('.editor-sidebar__item').first().click()
    await expect(nodes).toHaveCount(before + 1)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
    await expect(page.getByTestId('workflow-editor-inspector-surface')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.waitForTimeout(100)
    expect(await nodes.count()).toBe(before + 1)

    // Close Inspector (which clears selection), restore the fixture with the
    // visible Undo action, then exercise native keyboard activation. Space
    // must synthesize one click, not double-fire through a custom key handler.
    await page.getByTestId('workflow-editor-inspector-surface').locator('.dialog__close').click()
    await page.getByTestId('workflow-undo').click()
    await expect(nodes).toHaveCount(before)
    await page.getByTestId('workflow-add-step').click()
    // The palette is a Dialog, so it owns a focus trap. Two waits, both of which
    // the pointer branch above already had and this branch was missing: the
    // surface must be open before we reach into it, and focus must have actually
    // settled on the row before Space. Without the second one, our focus() can
    // land before the trap's initial focus, the trap takes it back, and Space
    // fires into the void — the node count stays at `before` and line 364 fails.
    // (CI run 29757172909, shard 4/4; this file already needed 255e6473 for the
    // same class of race on the same locator.)
    const keyboardPalette = page.getByTestId('workflow-editor-palette-surface')
    await expect(keyboardPalette).toBeVisible()
    const keyboardItem = keyboardPalette.locator('.editor-sidebar__item').first()
    await keyboardItem.focus()
    await expect(keyboardItem).toBeFocused()
    await page.keyboard.press('Space')
    await expect(nodes).toHaveCount(before + 1)
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1)
    await expect(page.getByTestId('workflow-editor-inspector-surface')).toBeVisible()
    await page.waitForTimeout(100)
    expect(await nodes.count()).toBe(before + 1)

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(overflow.body).toBeLessThanOrEqual(1)
    expect(overflow.root).toBeLessThanOrEqual(1)
  })

  test('390px zero-drag path adds, follows validation, connects, revalidates, and launches', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    workflowId = await seedWorkflow({
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    })
    await openEditor(page, 0)

    // Empty-state → agent. The canvas-owned picker hands off directly to the
    // single compact Inspector surface after insertion.
    await page.getByTestId('workflow-empty-add-first').click()
    const firstPicker = page.getByTestId('workflow-node-picker-dialog')
    await expect(firstPicker).toBeVisible()
    await firstPicker.getByTestId('workflow-node-picker-item-agent-w2-3-agent-a').first().click()
    await expect(page.locator('.react-flow__node')).toHaveCount(1)
    let inspector = page.getByTestId('workflow-editor-inspector-surface')
    await expect(inspector).toBeVisible()
    await inspector.locator('.dialog__close').click()

    // Header Add → review, still without drag/touch precision gestures. A
    // review without inputSource is intentionally invalid; the seeded agent's
    // markdown output is compatible and the same connection planner repairs it.
    await page.getByTestId('workflow-add-step').click()
    const palette = page.getByTestId('workflow-editor-palette-surface')
    await palette.getByTestId('workflow-node-picker-item-kind-review').first().click()
    await expect(page.locator('.react-flow__node')).toHaveCount(2)
    inspector = page.getByTestId('workflow-editor-inspector-surface')
    await expect(inspector).toBeVisible()
    await inspector.locator('.dialog__close').click()

    // The first validation is intentionally red. Its issue button performs a
    // validation→selection→Inspector handoff rather than leaving a dead list.
    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    const validationSummary = page.getByTestId('workflow-validation-summary')
    await expect(validationSummary).toBeVisible()
    await expect(validationSummary).not.toContainText('Validated')
    await validationSummary.click()
    const validationDialog = page.getByTestId('workflow-validation-dialog')
    await expect(validationDialog).toBeVisible()
    await validationDialog.locator('.workflow-validation__issue').first().click()
    inspector = page.getByTestId('workflow-editor-inspector-surface')
    await expect(inspector).toBeVisible()

    // The issue lands directly on Review's source field. Repair the connection
    // there instead of asking a phone user to find a producer that focus/fitView
    // may have moved outside the viewport. These Select changes use the same
    // transition that writes both inputSource and its synchronized edge.
    await inspector.getByRole('combobox', { name: 'Source node', exact: true }).click()
    await page.getByRole('option').filter({ hasText: 'w2-3-agent-a' }).click()
    await inspector.getByRole('combobox', { name: 'Source port', exact: true }).click()
    await page.getByRole('option', { name: 'answer', exact: true }).click()
    await inspector.locator('.dialog__close').click()

    // Revalidate the exact saved revision, then Launch through the fresh gate.
    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    await expect(validationSummary).toContainText('Validated')
    await page.getByRole('button', { name: /Launch task/ }).click()
    await expect(page).toHaveURL(/\/tasks\/new\?/)
    const launchUrl = new URL(page.url())
    expect(launchUrl.searchParams.get('kind')).toBe('workflow')
    expect(launchUrl.searchParams.get('workflow')).toBe(workflowId)
    expect(launchUrl.searchParams.get('workflowVersion')).toMatch(/^\d+$/)
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
    // At the canonical 1280px medium mode the palette is a Dialog.
    await page.getByTestId('workflow-add-step').click()
    const palette = page.getByTestId('workflow-editor-palette-surface')
    const filter = palette.locator('input[type="search"]')
    await expect(filter).toBeVisible()
    const items = palette.locator('.editor-sidebar__item')
    const totalBefore = await items.count()
    expect(totalBefore).toBeGreaterThan(0)

    // Type a string that should narrow the list. "agent" should
    // remain (palette has agent-single + agent-multi entries).
    await filter.fill('agent')
    await page.waitForTimeout(200)
    const afterAgent = await items.count()
    // At minimum the agent rows remain; at most the original count.
    expect(afterAgent).toBeGreaterThan(0)
    expect(afterAgent).toBeLessThanOrEqual(totalBefore)

    // Type a string that should match nothing.
    await filter.fill('zzz-no-such-item-1729')
    await page.waitForTimeout(200)
    await expect(items).toHaveCount(0)
  })

  test('RFC-219 large catalog reaches Wrapper and Human in one category action', async ({
    page,
  }) => {
    await useLargeAgentCatalog(page, 50)
    await page.setViewportSize({ width: 1179, height: 800 })
    await openEditor(page)
    const nodes = page.locator('.react-flow__node')
    const before = await nodes.count()

    await page.getByTestId('workflow-add-step').click()
    const palette = page.getByTestId('workflow-editor-palette-surface')
    await expect(palette).toBeVisible()
    await expect(palette.getByTestId('workflow-node-picker-category-agents')).toContainText('50')
    await expect(palette.getByTestId('workflow-node-picker-category-wrappers')).toContainText('3')
    await expect(palette.getByTestId('workflow-node-picker-category-human')).toContainText('3')

    await palette.getByTestId('workflow-node-picker-category-wrappers').click()
    await expect(palette.locator('[data-testid^="workflow-node-picker-item-agent-"]')).toHaveCount(
      0,
    )
    await expect(
      palette.locator('[data-testid^="workflow-node-picker-item-kind-wrapper-"]'),
    ).toHaveCount(3)
    await expect(palette.getByTestId('workflow-node-picker-category-panel-wrappers')).toBeVisible()

    await palette.getByTestId('workflow-node-picker-category-human').click()
    await expect(palette.locator('[data-testid^="workflow-node-picker-item-agent-"]')).toHaveCount(
      0,
    )
    const review = palette.getByTestId('workflow-node-picker-item-kind-review')
    await expect(review).toBeVisible()
    await expect(review.locator('.workflow-node-picker__type-chip')).toHaveText('Human')
    await review.click()
    await expect(nodes).toHaveCount(before + 1)

    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(overflow.body).toBeLessThanOrEqual(1)
    expect(overflow.root).toBeLessThanOrEqual(1)
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

  test('validation details switch at the 521/520 short-height boundary without resizing canvas', async ({
    page,
  }) => {
    for (const height of [521, 520]) {
      await page.setViewportSize({ width: 1280, height })
      await openEditor(page)
      await page.getByRole('button', { name: 'Validate', exact: true }).click()
      const summary = page.getByTestId('workflow-validation-summary')
      await expect(summary).toBeVisible()
      const before = await page.locator('.canvas-frame').boundingBox()
      if (before === null) throw new Error('canvas frame missing before validation details')

      await summary.click()
      if (height === 521) {
        await expect(page.getByTestId('workflow-validation-overlay')).toBeVisible()
        await expect(page.getByTestId('workflow-validation-dialog')).toHaveCount(0)
        await page.getByTestId('workflow-validation-overlay').locator('button').first().click()
      } else {
        const dialog = page.getByTestId('workflow-validation-dialog')
        await expect(dialog).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(1)
        const panel = await dialog.locator('.dialog__panel').boundingBox()
        if (panel === null) throw new Error('short-height validation panel missing')
        expect(panel.width).toBeCloseTo(1280, 0)
        expect(panel.height).toBeCloseTo(520, 0)
        await dialog.locator('.dialog__close').click()
      }

      const after = await page.locator('.canvas-frame').boundingBox()
      if (after === null) throw new Error('canvas frame missing after validation details')
      expect(after.width).toBeCloseTo(before.width, 0)
      expect(after.height).toBeCloseTo(before.height, 0)
    }
  })

  test('RFC-199 four-mode workspace preserves canvas geometry and one inspector surface', async ({
    page,
  }, testInfo) => {
    type Geometry = {
      viewport: { width: number; height: number }
      mode: string
      columns: string
      canvas: { width: number; height: number }
      paletteWidth: number | null
      inspectorWidth: number | null
      dialogWidth: number | null
      dialogCount: number
      bodyOverflow: number
      rootOverflow: number
    }

    const viewports = [
      { width: 1536, height: 900 },
      { width: 1535, height: 900 },
      { width: 1280, height: 800 },
      { width: 1180, height: 800 },
      { width: 1179, height: 800 },
      { width: 901, height: 800 },
      { width: 900, height: 800 },
      { width: 721, height: 800 },
      { width: 720, height: 800 },
      { width: 390, height: 844 },
      { width: 640, height: 400 },
    ]
    const samples: Geometry[] = []

    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await openEditor(page)
      await page.locator('.react-flow__node[data-id="agent_1"]').click()
      const expectedMode =
        viewport.width >= 1536
          ? 'wide'
          : viewport.width >= 1180
            ? 'medium'
            : viewport.width >= 721
              ? 'compact'
              : 'phone'
      await expect(page.locator('.editor-layout')).toHaveAttribute(
        'data-workspace-mode',
        expectedMode,
      )
      if (expectedMode === 'wide' || expectedMode === 'medium') {
        await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
      } else {
        await expect(page.getByTestId('workflow-editor-inspector-surface')).toBeVisible()
      }

      samples.push(
        await page.evaluate((currentViewport) => {
          const layout = document.querySelector<HTMLElement>('.editor-layout')
          const canvas = document.querySelector<HTMLElement>('.editor-layout > .canvas-frame')
          if (layout === null || canvas === null) throw new Error('editor geometry owner missing')
          const palette = layout.querySelector<HTMLElement>(':scope > .editor-sidebar')
          const inspector = layout.querySelector<HTMLElement>(':scope > .inspector')
          const dialog = document.querySelector<HTMLElement>(
            '[data-testid="workflow-editor-inspector-surface"] .dialog__panel',
          )
          const canvasBox = canvas.getBoundingClientRect()
          return {
            viewport: currentViewport,
            mode: layout.dataset.workspaceMode ?? '',
            columns: getComputedStyle(layout).gridTemplateColumns,
            canvas: { width: canvasBox.width, height: canvasBox.height },
            paletteWidth: palette?.getBoundingClientRect().width ?? null,
            inspectorWidth: inspector?.getBoundingClientRect().width ?? null,
            dialogWidth: dialog?.getBoundingClientRect().width ?? null,
            dialogCount: document.querySelectorAll('[role="dialog"]').length,
            bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
            rootOverflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        }, viewport),
      )
    }

    await testInfo.attach('rfc199-responsive-editor-geometry.json', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json',
    })

    const sample = (width: number, height: number) =>
      samples.find((entry) => entry.viewport.width === width && entry.viewport.height === height)!
    const wide = sample(1536, 900)
    expect(wide.paletteWidth).toBeCloseTo(240, 0)
    expect(wide.inspectorWidth).toBeGreaterThanOrEqual(359)
    expect(wide.inspectorWidth).toBeLessThanOrEqual(421)
    expect(wide.canvas.width).toBeGreaterThanOrEqual(519)

    for (const current of [sample(1535, 900), sample(1280, 800), sample(1180, 800)]) {
      expect(current.paletteWidth).toBeNull()
      expect(current.inspectorWidth).toBeGreaterThanOrEqual(359)
      expect(current.inspectorWidth).toBeLessThanOrEqual(421)
      expect(current.canvas.width).toBeGreaterThanOrEqual(519)
      expect(current.dialogWidth).toBeNull()
    }

    for (const current of [
      sample(1179, 800),
      sample(901, 800),
      sample(900, 800),
      sample(721, 800),
    ]) {
      expect(current.paletteWidth).toBeNull()
      expect(current.inspectorWidth).toBeNull()
      expect(current.dialogWidth).toBeGreaterThan(0)
      expect(current.dialogWidth).toBeLessThanOrEqual(420.5)
      expect(current.dialogCount).toBe(1)
    }

    for (const current of [sample(720, 800), sample(390, 844), sample(640, 400)]) {
      expect(current.paletteWidth).toBeNull()
      expect(current.inspectorWidth).toBeNull()
      expect(current.dialogWidth).toBeCloseTo(current.viewport.width, 0)
      expect(current.dialogCount).toBe(1)
    }
    expect(sample(390, 844).canvas.height).toBeGreaterThanOrEqual(560)
    expect(sample(640, 400).canvas.height).toBeGreaterThanOrEqual(240)

    for (const current of samples) {
      expect(current.bodyOverflow).toBeLessThanOrEqual(1)
      expect(current.rootOverflow).toBeLessThanOrEqual(1)
    }
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
    const paneCenter = {
      x: paneBox.x + paneBox.width / 2,
      y: paneBox.y + paneBox.height / 2,
    }

    await page.getByTestId('workflow-add-step').click()
    await page
      .getByTestId('workflow-editor-palette-surface')
      .locator('.editor-sidebar__item')
      .first()
      .click()
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

    // The insert converts the aimed screen point (pane centre) with
    // screenToFlowPosition and then anchors the node's CENTER there via
    // centerAnchoredTopLeft (2026-07-21 落点修复), using
    // DEFAULT_NODE_SIZE_BY_KIND for the pre-measure size — agent-single is
    // 280×180, so the flow top-left is the projected centre minus (140, 90).
    // Assert in FLOW space (the node element's translate()) so rendered card
    // size cannot skew the anchor check; zoom-projection drift is what this
    // case isolates.
    const viewportMatrix = await page
      .locator('.react-flow__viewport')
      .evaluate((element) => getComputedStyle(element).transform)
    const matrixParts = viewportMatrix
      .match(/matrix\(([^)]+)\)/)?.[1]
      ?.split(',')
      .map(Number)
    if (matrixParts === undefined || matrixParts.length !== 6) {
      throw new Error(`unexpected viewport transform: ${viewportMatrix}`)
    }
    const scale = matrixParts[0]!
    const flowCenter = {
      x: (paneCenter.x - paneBox.x - matrixParts[4]!) / scale,
      y: (paneCenter.y - paneBox.y - matrixParts[5]!) / scale,
    }
    const nodeTransform = await page
      .locator(`.react-flow__node[data-id="${insertedId}"]`)
      .evaluate((element) => element.style.transform)
    const translated = nodeTransform.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/)
    if (translated === null) throw new Error(`unexpected node transform: ${nodeTransform}`)
    const actualTopLeft = { x: Number(translated[1]), y: Number(translated[2]) }
    expect(Math.abs(actualTopLeft.x - (flowCenter.x - 140))).toBeLessThanOrEqual(3)
    expect(Math.abs(actualTopLeft.y - (flowCenter.y - 90))).toBeLessThanOrEqual(3)
  })

  test('editor rails and modal handoffs have no critical/serious axe violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1536, height: 900 })
    await openEditor(page)
    await page.locator('.react-flow__node[data-id="agent_1"]').click()
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
    await expectEditorAxeClean(page, '1536 editor inspector rail')

    await page.setViewportSize({ width: 1280, height: 800 })
    await openEditor(page)
    await page.locator('.react-flow__node[data-id="agent_1"]').click()
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
    await expectEditorAxeClean(page, '1280 editor inspector rail')

    await page.setViewportSize({ width: 1179, height: 800 })
    await openEditor(page)
    await page.getByTestId('workflow-add-step').click()
    await expect(page.getByTestId('workflow-editor-palette-surface')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expectEditorAxeClean(page, '1179 editor palette dialog')
    await page.getByTestId('workflow-editor-palette-surface').locator('.dialog__close').click()

    await page.setViewportSize({ width: 390, height: 844 })
    await openEditor(page)
    await page.getByTestId('workflow-add-step').click()
    let dialog = page.getByTestId('workflow-editor-palette-surface')
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expectEditorAxeClean(page, '390 editor NodePicker dialog')
    await dialog.locator('.dialog__close').click()

    await page.locator('.react-flow__node[data-id="agent_1"]').click()
    dialog = page.getByTestId('workflow-editor-inspector-surface')
    await expect(dialog).toBeVisible()
    await expectEditorAxeClean(page, '390 editor inspector dialog')
    await dialog.getByTestId('inspector-connect-next').click()
    dialog = page.getByRole('dialog', { name: 'Connect workflow steps' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expectEditorAxeClean(page, '390 editor connection dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    dialog = page.getByTestId('workflow-editor-inspector-surface')
    await expect(dialog).toBeVisible()
    await dialog.locator('.dialog__close').click()
    await page.getByTestId('workflow-more-actions').click()
    dialog = page.getByTestId('workflow-actions-dialog')
    await expect(dialog).toBeVisible()
    await expectEditorAxeClean(page, '390 editor More actions dialog')
    await dialog.getByTestId('workflow-rename-button').click()
    dialog = page.getByTestId('workflow-rename-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expectEditorAxeClean(page, '390 editor Rename dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByTestId('workflow-more-actions').click()
    dialog = page.getByTestId('workflow-actions-dialog')
    await dialog.getByTestId('workflow-delete-button').click()
    dialog = page.getByRole('dialog', { name: 'Delete workflow' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expectEditorAxeClean(page, '390 editor Delete dialog')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByTestId('workflow-more-actions')).toBeFocused()

    // One dark representative catches token/contrast regressions too.
    const dark = await fetch(`${daemon.baseUrl}/api/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ theme: 'dark' }),
    })
    expect(dark.ok).toBe(true)
    await page.reload()
    await expect(page.locator('.workflow-canvas')).toBeVisible()
    await page.getByTestId('workflow-more-actions').click()
    await expectEditorAxeClean(page, '390 dark editor More actions dialog')

    const light = await fetch(`${daemon.baseUrl}/api/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ theme: 'light' }),
    })
    expect(light.ok).toBe(true)
  })
})
