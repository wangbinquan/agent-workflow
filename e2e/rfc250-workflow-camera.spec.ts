// RFC-250 T34 / AC16-AC18 — real-browser camera and semantic-zoom contract.
//
// This spec deliberately uses a 15-node deterministic workflow whose full-graph
// fit is below the readable threshold on both desktop and 390px. It locks:
//   * initial readable focus instead of an unreadable automatic overview;
//   * explicit overview -> readable handoff, minimap reachability, and zoom bands;
//   * wrapper-header, edge-midpoint, and validation-issue focus at readable zoom;
//   * inline edge/wrapper actions leaving the DOM before their hit boxes shrink;
//   * user pan surviving a real workflow-detail WS invalidation/refetch;
//   * a task canvas mounted at display:none (real 0x0 product path) refitting once
//     when the user reveals Workflow status.

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { WorkflowDetail } from '@agent-workflow/shared'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

const READABLE_MIN_ZOOM = 1.1
const TOPOLOGY_MAX_ZOOM = 0.55
const OVERVIEW_MAX_ZOOM = 0.75
const COMPLEX_NODE_COUNT = 15

interface CameraViewport {
  x: number
  y: number
  zoom: number
}

interface SeededWorkflow {
  id: string
  name: string
}

let daemon: DaemonHandle
let seededAgentId = ''
let repoDir = ''
let workflowSequence = 0

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
  seededAgentId = await seedAgent()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc250-camera-'))
  writeFileSync(join(repoDir, 'README.md'), '# RFC-250 camera fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== '') rmSync(repoDir, { recursive: true, force: true })
})

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
}

async function seedAgent(): Promise<string> {
  const response = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: 'rfc250-camera-agent',
      description: 'RFC-250 deterministic camera fixture',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!response.ok) throw new Error(`seedAgent: ${response.status} ${await response.text()}`)
  return ((await response.json()) as { id: string }).id
}

function independentAgentNode(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    kind: 'agent-single',
    agentId: seededAgentId,
    agentName: 'rfc250-camera-agent',
    promptTemplate: `Independent camera step ${id}.`,
    position: { x, y },
  }
}

function complexDefinition(): Record<string, unknown> {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      // Keep the business entry first. The initial-camera planner must choose
      // it when the complete graph would only fit below readable zoom.
      { id: 'input_entry', kind: 'input', inputKey: 'topic', position: { x: 0, y: -100 } },
      {
        id: 'agent_01',
        kind: 'agent-single',
        agentId: seededAgentId,
        agentName: 'rfc250-camera-agent',
        promptTemplate: 'Answer {{topic}}.',
        // Offset the target vertically so the real SVG interaction path has a
        // non-degenerate bounding box in both browser engines.
        position: { x: 300, y: 0 },
      },
      independentAgentNode('agent_02', 600, -100),
      independentAgentNode('agent_03', 900, -100),
      independentAgentNode('agent_04', 0, 250),
      independentAgentNode('agent_05', 0, -450),
      independentAgentNode('agent_06', 300, -450),
      independentAgentNode('agent_07', 600, -450),
      independentAgentNode('agent_08', 900, -450),
      independentAgentNode('agent_09', 300, 250),
      independentAgentNode('agent_10', 600, 250),
      independentAgentNode('agent_11', 900, 250),
      {
        id: 'review_issue',
        kind: 'review',
        inputSource: { nodeId: '', portName: '' },
        title: 'Review issue target',
        description: 'Intentional validation issue for camera navigation.',
        rerunnableOnReject: [],
        rerunnableOnIterate: [],
        rollbackFilesOnReject: true,
        rollbackFilesOnIterate: false,
        position: { x: 0, y: 600 },
      },
      {
        id: 'output_answer',
        kind: 'output',
        ports: [{ name: 'answer', bind: { nodeId: 'agent_01', portName: 'answer' } }],
        position: { x: 300, y: 600 },
      },
      {
        id: 'wrapper_empty',
        kind: 'wrapper-git',
        nodeIds: [],
        position: { x: 600, y: 600 },
        size: { width: 500, height: 420 },
      },
    ],
    edges: [
      {
        id: 'edge_entry_agent',
        source: { nodeId: 'input_entry', portName: 'topic' },
        target: { nodeId: 'agent_01', portName: 'topic' },
      },
      {
        id: 'edge_agent_output',
        source: { nodeId: 'agent_01', portName: 'answer' },
        target: { nodeId: 'output_answer', portName: 'answer' },
      },
    ],
  }
}

async function seedWorkflow(
  profile: string,
  definition: Record<string, unknown> = complexDefinition(),
): Promise<SeededWorkflow> {
  const name = `rfc250-camera-${profile}-${++workflowSequence}-a`
  const response = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name,
      description: 'RFC-250 camera e2e fixture',
      definition,
    }),
  })
  if (!response.ok) {
    throw new Error(`seedWorkflow ${profile}: ${response.status} ${await response.text()}`)
  }
  return { id: ((await response.json()) as { id: string }).id, name }
}

async function readWorkflow(workflowId: string): Promise<WorkflowDetail> {
  const response = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  if (!response.ok) throw new Error(`readWorkflow ${workflowId}: ${response.status}`)
  return (await response.json()) as WorkflowDetail
}

function workflowMutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)]! + encoded
    value >>= 5n
  }
  return encoded
}

async function renameWorkflowOnServer(workflowId: string, name: string): Promise<void> {
  const current = await readWorkflow(workflowId)
  const response = await fetch(
    `${daemon.baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`,
    {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        expectedVersion: current.version,
        clientMutationId: workflowMutationId(),
        snapshot: {
          name,
          description: current.description,
          definition: current.definition,
        },
      }),
    },
  )
  if (!response.ok) {
    throw new Error(
      `renameWorkflowOnServer ${workflowId}: ${response.status} ${await response.text()}`,
    )
  }
}

async function primeAuth(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

async function readViewport(page: Page): Promise<CameraViewport> {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const transform = getComputedStyle(element).transform
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform)
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 }
  })
}

async function waitForViewportSettled(
  page: Page,
  previousViewport?: CameraViewport,
): Promise<CameraViewport> {
  if (previousViewport !== undefined) {
    await expect
      .poll(async () => {
        const current = await readViewport(page)
        return Math.max(
          Math.abs(current.x - previousViewport.x),
          Math.abs(current.y - previousViewport.y),
          Math.abs(current.zoom - previousViewport.zoom) * 100,
        )
      })
      .toBeGreaterThan(0.5)
  }
  let previous: CameraViewport | null = null
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const current = await readViewport(page)
        const delta =
          previous === null
            ? Number.POSITIVE_INFINITY
            : Math.max(
                Math.abs(current.x - previous.x),
                Math.abs(current.y - previous.y),
                Math.abs(current.zoom - previous.zoom) * 100,
              )
        stableSamples = delta <= 0.05 ? stableSamples + 1 : 0
        previous = current
        return stableSamples
      },
      { intervals: Array.from({ length: 12 }, () => 40) },
    )
    .toBeGreaterThanOrEqual(3)
  return readViewport(page)
}

async function waitForZoom(
  page: Page,
  predicate: (zoom: number) => boolean,
  message: string,
): Promise<CameraViewport> {
  await expect.poll(async () => predicate((await readViewport(page)).zoom), { message }).toBe(true)
  return readViewport(page)
}

async function clickZoomUntil(
  page: Page,
  control: '.react-flow__controls-zoomin' | '.react-flow__controls-zoomout',
  predicate: (zoom: number) => boolean,
): Promise<CameraViewport> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const before = await readViewport(page)
    if (predicate(before.zoom)) return before
    await page.locator(control).click({ force: true })
    await expect
      .poll(async () => Math.abs((await readViewport(page)).zoom - before.zoom))
      .toBeGreaterThan(0.005)
  }
  const final = await readViewport(page)
  throw new Error(`zoom controls did not reach requested range; final zoom=${final.zoom}`)
}

async function expectAllNodesInsideCanvas(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('.workflow-canvas')
    if (canvas === null) throw new Error('workflow canvas missing')
    const outer = canvas.getBoundingClientRect()
    const offenders = Array.from(
      document.querySelectorAll<HTMLElement>('.react-flow__node'),
    ).flatMap((node) => {
      const rect = node.getBoundingClientRect()
      const inside =
        rect.left >= outer.left - 3 &&
        rect.right <= outer.right + 3 &&
        rect.top >= outer.top - 3 &&
        rect.bottom <= outer.bottom + 3
      return inside
        ? []
        : [
            {
              id: node.dataset.id ?? '?',
              node: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
              canvas: {
                left: outer.left,
                right: outer.right,
                top: outer.top,
                bottom: outer.bottom,
              },
            },
          ]
    })
    return { count: document.querySelectorAll('.react-flow__node').length, offenders }
  })
  expect(result.count).toBe(COMPLEX_NODE_COUNT)
  expect(result.offenders).toEqual([])
}

async function expectNodeInsideCanvasWithMargin(
  page: Page,
  nodeId: string,
  previousViewport: CameraViewport,
  margin = 16,
): Promise<void> {
  await waitForViewportSettled(page, previousViewport)
  const minimumInset = await page.evaluate((id) => {
    const canvas = document.querySelector<HTMLElement>('.workflow-canvas')
    const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)
    if (canvas === null || node === null) return Number.NEGATIVE_INFINITY
    const outer = canvas.getBoundingClientRect()
    const selected = node.getBoundingClientRect()
    return Math.min(
      selected.left - outer.left,
      outer.right - selected.right,
      selected.top - outer.top,
      outer.bottom - selected.bottom,
    )
  }, nodeId)
  expect(
    minimumInset,
    `${nodeId} did not retain a ${margin}px canvas margin after Inspector layout`,
  ).toBeGreaterThanOrEqual(margin)
}

async function expectScreenPixelLabel(page: Page): Promise<void> {
  const label = page.locator('.react-flow__node[data-id="input_entry"] .canvas-node__title').first()
  await expect(label).toBeVisible()
  const rect = await label.boundingBox()
  expect(rect, 'entry label has no screen-space rectangle').not.toBeNull()
  expect(
    rect?.height ?? 0,
    'entry label is shorter than a readable screen line',
  ).toBeGreaterThanOrEqual(14)
  expect(rect?.width ?? 0, 'entry label collapsed to a micro-label').toBeGreaterThanOrEqual(24)
}

async function expectHitRect(locator: Locator, minimum: number, label: string): Promise<void> {
  await expect(locator, `${label} is not mounted`).toHaveCount(1)
  const rect = await locator.boundingBox()
  expect(rect, `${label} has no screen-space rectangle`).not.toBeNull()
  expect(rect?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(minimum)
  expect(rect?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(minimum)
}

async function expectEveryHitRect(locator: Locator, minimum: number, label: string): Promise<void> {
  const count = await locator.count()
  expect(count, `${label} has no controls`).toBeGreaterThan(0)
  for (let index = 0; index < count; index += 1) {
    await expectHitRect(locator.nth(index), minimum, `${label} ${index + 1}`)
  }
}

async function expectEditorHeaderActionsInBounds(page: Page): Promise<void> {
  const header = page.locator('.editor-page-header')
  const actions = header.locator(':scope > .page__actions')
  await expect(header.locator(':scope > .page__actions > .btn--primary')).toBeVisible()
  await expect(page.getByTestId('workflow-more-actions')).toBeVisible()

  const geometry = await actions.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const header = element.parentElement
    const heading = header?.querySelector<HTMLElement>(':scope > .page__heading') ?? null
    const headingBounds = heading?.getBoundingClientRect()
    const headingStyle = heading === null ? null : getComputedStyle(heading)
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      headerClass: header?.className ?? '',
      left: bounds.left,
      right: bounds.right,
      headerWidth: header?.getBoundingClientRect().width ?? 0,
      headingWidth: headingBounds?.width ?? 0,
      headingFlexBasis: headingStyle?.flexBasis ?? '',
      headingMinWidth: headingStyle?.minWidth ?? '',
      clippedActions: Array.from(element.children).flatMap((child) => {
        const rect = child.getBoundingClientRect()
        if (rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1) return []
        const control = child as HTMLElement
        return [control.dataset.testid ?? control.textContent?.trim() ?? control.tagName]
      }),
    }
  })

  expect(
    geometry.left,
    'workflow header action rail crossed the viewport start',
  ).toBeGreaterThanOrEqual(0)
  expect(
    geometry.right,
    'workflow header action rail crossed the viewport end',
  ).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(
    geometry.scrollWidth,
    `workflow header actions still overflow at 1280px: ${geometry.clippedActions.join(', ')}; ` +
      `class=${geometry.headerClass}, header=${geometry.headerWidth}, heading=${geometry.headingWidth}, ` +
      `basis=${geometry.headingFlexBasis}, min=${geometry.headingMinWidth}`,
  ).toBeLessThanOrEqual(geometry.clientWidth + 1)
  expect(geometry.clippedActions, 'workflow header contains clipped actions').toEqual([])
}

async function expectLowZoomNodeMarkers(page: Page, node: Locator, label: string): Promise<void> {
  const metrics = await node.locator('.canvas-node').evaluate((element) => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')
    if (viewport === null) throw new Error('workflow viewport missing')
    const transform = getComputedStyle(viewport).transform
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform)
    const card = element as HTMLElement
    const alreadySelected = card.classList.contains('canvas-node--selected')
    card.classList.add('canvas-node--selected')
    const marker = getComputedStyle(card, '::after')
    const result = {
      width: Number.parseFloat(marker.width) * matrix.a,
      height: Number.parseFloat(marker.height) * matrix.d,
      content: marker.content,
    }
    if (!alreadySelected) card.classList.remove('canvas-node--selected')
    return result
  })
  expect(metrics.content, `${label} selection marker did not render`).not.toBe('none')
  expect(metrics.width, `${label} selection marker width`).toBeGreaterThanOrEqual(7.9)
  expect(metrics.height, `${label} selection marker height`).toBeGreaterThanOrEqual(7.9)
  await expectHitRect(node.locator('.canvas-node__validation').first(), 8, `${label} validation`)
}

async function closeInspector(page: Page): Promise<void> {
  const dialog = page.getByTestId('workflow-editor-inspector-surface')
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.locator('.dialog__close').click()
    await expect(dialog).toHaveCount(0)
    return
  }
  const railClose = page.locator('.inspector__close').first()
  if (await railClose.isVisible().catch(() => false)) {
    await railClose.click()
    await expect(railClose).toHaveCount(0)
  }
}

async function expectWrapperHeaderFocused(page: Page): Promise<void> {
  await waitForViewportSettled(page)
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('.workflow-canvas')
    const wrapper = document.querySelector<HTMLElement>(
      '.react-flow__node[data-id="wrapper_empty"]',
    )
    const header = wrapper?.querySelector<HTMLElement>('.canvas-node__header')
    if (canvas === null || wrapper === null || header === null) {
      throw new Error('wrapper focus geometry is incomplete')
    }
    const c = canvas.getBoundingClientRect()
    const w = wrapper.getBoundingClientRect()
    const h = header.getBoundingClientRect()
    const canvasCenterY = c.top + c.height / 2
    return {
      headerDelta: Math.abs(h.top + h.height / 2 - canvasCenterY),
      bodyDelta: Math.abs(w.top + w.height / 2 - canvasCenterY),
    }
  })
  expect(geometry.headerDelta, 'wrapper header is not the camera focal point').toBeLessThanOrEqual(
    42,
  )
  expect(
    geometry.bodyDelta,
    'wrapper body center was focused instead of the readable header',
  ).toBeGreaterThan(120)
}

async function expectEdgeMidpointNearCanvasCenter(page: Page): Promise<void> {
  await waitForViewportSettled(page)
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('.workflow-canvas')
    const source = document.querySelector<HTMLElement>('.react-flow__node[data-id="input_entry"]')
    const target = document.querySelector<HTMLElement>('.react-flow__node[data-id="agent_01"]')
    if (canvas === null || source === null || target === null) {
      throw new Error('edge focus geometry is incomplete')
    }
    const c = canvas.getBoundingClientRect()
    const s = source.getBoundingClientRect()
    const t = target.getBoundingClientRect()
    const midpoint = {
      x: (s.left + s.width / 2 + (t.left + t.width / 2)) / 2,
      y: (s.top + s.height / 2 + (t.top + t.height / 2)) / 2,
    }
    return {
      centerDelta: Math.hypot(
        midpoint.x - (c.left + c.width / 2),
        midpoint.y - (c.top + c.height / 2),
      ),
      minimumInset: Math.min(
        midpoint.x - c.left,
        c.right - midpoint.x,
        midpoint.y - c.top,
        c.bottom - midpoint.y,
      ),
    }
  })

  // The desktop Inspector rail materializes in the same selection render.
  // Assert only after the viewport is stable so a transient midpoint crossed
  // during the handoff cannot satisfy the final-state contract.
  expect(geometry.centerDelta).toBeLessThanOrEqual(45)
  expect(geometry.minimumInset).toBeGreaterThanOrEqual(16)
}

async function panCanvas(page: Page): Promise<CameraViewport> {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (box === null) throw new Error('canvas pane missing for user pan')
  const before = await readViewport(page)
  const start = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.8 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 64, start.y - 38, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(async () => {
      const after = await readViewport(page)
      return Math.hypot(after.x - before.x, after.y - before.y)
    })
    .toBeGreaterThan(40)
  return readViewport(page)
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

async function runComplexCameraScenario(
  page: Page,
  profile: 'desktop' | '390-coarse',
  minimumHitRect: 24 | 44,
): Promise<void> {
  const seeded = await seedWorkflow(profile)
  const detailPath = `/api/workflows/${encodeURIComponent(seeded.id)}`
  let detailGetCount = 0
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === detailPath) {
      detailGetCount += 1
    }
  })

  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${seeded.id}`)

  const canvas = page.locator('.workflow-canvas')
  await expect(canvas).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(COMPLEX_NODE_COUNT)
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await waitForZoom(
    page,
    (zoom) => zoom >= READABLE_MIN_ZOOM,
    `${profile} initial camera never reached readable zoom`,
  )
  await expect(canvas).toHaveAttribute('data-zoom-band', 'readable')
  await expectScreenPixelLabel(page)
  await expect(page.getByTestId('workflow-add-step')).toHaveCount(0)
  await expect(page.getByTestId('workflow-canvas-add')).toHaveCount(1)
  if (profile === 'desktop') await expectEditorHeaderActionsInBounds(page)
  await expectEveryHitRect(
    page.locator('.workflow-canvas__layout-panel [role="toolbar"] > button'),
    minimumHitRect,
    `${profile} canvas toolbar`,
  )
  await expectEveryHitRect(
    page.locator('.workflow-canvas .react-flow__controls-button'),
    minimumHitRect,
    `${profile} React Flow controls`,
  )

  const minimap = page.locator('.react-flow__minimap')
  await expect(minimap).toBeVisible()
  const minimapRect = await minimap.boundingBox()
  expect(minimapRect?.width ?? 0).toBeGreaterThanOrEqual(80)
  expect(minimapRect?.height ?? 0).toBeGreaterThanOrEqual(50)

  // A normal readable-mode click opens the desktop Inspector rail and narrows
  // the canvas. The selected card must be re-focused against that committed
  // viewport. `agent_01` starts to the right of the entry focus and is pushed
  // beyond the narrowed rail layout if the post-layout camera handoff is
  // removed, so this is not satisfied by the initial camera by accident.
  if (profile === 'desktop') {
    const beforeSelection = await readViewport(page)
    const nonEntryNode = page.locator('.react-flow__node[data-id="agent_01"]')
    await nonEntryNode.click({ force: true })
    await expect(nonEntryNode).toHaveClass(/selected/)
    await expect(page.locator('.inspector')).toBeVisible()
    await expectNodeInsideCanvasWithMargin(page, 'agent_01', beforeSelection)
    await closeInspector(page)
  }

  // The real zoom controls bracket both semantic thresholds in the DOM. Pure
  // boundary equality is separately locked by workflow-canvas-camera.test.ts.
  const overviewBand = await clickZoomUntil(
    page,
    '.react-flow__controls-zoomout',
    (zoom) => zoom >= TOPOLOGY_MAX_ZOOM && zoom < READABLE_MIN_ZOOM,
  )
  expect(overviewBand.zoom).toBeGreaterThanOrEqual(TOPOLOGY_MAX_ZOOM)
  expect(overviewBand.zoom).toBeLessThan(READABLE_MIN_ZOOM)
  await expect(canvas).toHaveAttribute('data-zoom-band', 'overview')

  const topologyBand = await clickZoomUntil(
    page,
    '.react-flow__controls-zoomout',
    (zoom) => zoom < TOPOLOGY_MAX_ZOOM,
  )
  expect(topologyBand.zoom).toBeLessThan(TOPOLOGY_MAX_ZOOM)
  await expect(canvas).toHaveAttribute('data-zoom-band', 'topology')
  await expect(
    page.locator('.react-flow__node[data-id="input_entry"] .canvas-node__title').first(),
  ).not.toBeVisible()

  await clickZoomUntil(
    page,
    '.react-flow__controls-zoomin',
    (zoom) => zoom >= TOPOLOGY_MAX_ZOOM && zoom < READABLE_MIN_ZOOM,
  )
  await expect(canvas).toHaveAttribute('data-zoom-band', 'overview')
  await clickZoomUntil(page, '.react-flow__controls-zoomin', (zoom) => zoom >= READABLE_MIN_ZOOM)
  await expect(canvas).toHaveAttribute('data-zoom-band', 'readable')

  // Overview is explicit, exits through a named action, fits every object, and
  // removes undersized projected controls from both DOM and Tab order.
  await clickCanvasControl(page, 'workflow-camera-overview')
  await expect(canvas).toHaveAttribute('data-camera-mode', 'overview')
  await waitForZoom(
    page,
    (zoom) => zoom <= OVERVIEW_MAX_ZOOM,
    `${profile} explicit overview exceeded its max zoom`,
  )
  await expectAllNodesInsideCanvas(page)
  await expect(page.locator('.workflow-edge-insert')).toHaveCount(0)
  await expect(page.getByTestId('wrapper-add-inside-wrapper_empty')).toHaveCount(0)
  await expect(page.getByTestId('workflow-camera-readable')).toBeVisible()

  await clickCanvasControl(page, 'workflow-camera-readable')
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'return-to-readable stayed tiny')
  await expectScreenPixelLabel(page)
  await expect(page.getByTestId('wrapper-add-inside-wrapper_empty')).toHaveCount(1)

  // Overview node activation uses the same readable-focus planner. A large
  // wrapper focuses its header rather than centering an unreadable empty body.
  await clickCanvasControl(page, 'workflow-camera-overview')
  await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'wrapper overview did not settle')
  const wrapper = page.locator('.react-flow__node[data-id="wrapper_empty"]')
  await wrapper.click({ force: true })
  await expect(wrapper).toHaveClass(/selected/)
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'wrapper focus stayed tiny')
  await expectWrapperHeaderFocused(page)
  await expectHitRect(
    page.getByTestId('wrapper-add-inside-wrapper_empty'),
    minimumHitRect,
    `${profile} wrapper inline action`,
  )
  await expectEveryHitRect(
    page.locator('.workflow-canvas__node-actions > button'),
    minimumHitRect,
    `${profile} selected-node toolbar`,
  )
  await closeInspector(page)

  // In overview the midpoint action is absent, so clicking the interaction
  // path cannot accidentally open the insert picker. The selected edge is
  // lifted back to readable zoom and its action remounts at screen size.
  await clickCanvasControl(page, 'workflow-camera-overview')
  await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'edge overview did not settle')
  const edge = page.locator(
    '.react-flow__edge[data-id="edge_entry_agent"] .react-flow__edge-interaction',
  )
  await edge.click({ force: true })
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'edge focus stayed tiny')
  await expectEdgeMidpointNearCanvasCenter(page)
  await expect.poll(async () => page.locator('.workflow-edge-insert').count()).toBeGreaterThan(0)
  await expectHitRect(
    page.locator('.workflow-edge-insert').first(),
    minimumHitRect,
    `${profile} edge inline action`,
  )
  await closeInspector(page)

  // Explicit Validate opens and focuses the result heading. The issue action
  // then performs validation -> selection -> readable camera -> Inspector.
  await page.getByTestId('workflow-validate').click()
  const validationSurface = page.locator(
    '[data-testid="workflow-validation-overlay"], [data-testid="workflow-validation-dialog"]',
  )
  await expect(validationSurface).toBeVisible()
  const validationHeading = validationSurface.getByRole('heading', {
    name: 'Workflow validation',
  })
  await expect(validationHeading).toBeFocused()
  const reviewIssue = validationSurface
    .locator('.workflow-validation__issue')
    .filter({ hasText: 'review-input-source-missing' })
    .first()
  await expect(reviewIssue).toBeVisible()
  const reviewNode = page.locator('.react-flow__node[data-id="review_issue"]')

  // The validation receipt stays projected after its details close. Exercise
  // the real overview camera and measure both low-zoom marker classes in
  // screen pixels; the selection marker is temporarily armed on the same real
  // card so this remains a browser/CSS geometry assertion rather than a
  // source-string lock.
  await page.keyboard.press('Escape')
  await expect(validationSurface).not.toBeVisible()
  await clickCanvasControl(page, 'workflow-camera-overview')
  await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'marker overview did not settle')
  await expectLowZoomNodeMarkers(page, reviewNode, `${profile} low-zoom node`)
  await clickCanvasControl(page, 'workflow-camera-readable')
  await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'marker return stayed tiny')

  await page.getByTestId('workflow-validation-summary').click()
  const reopenedReviewIssue = page
    .locator(
      '[data-testid="workflow-validation-overlay"], [data-testid="workflow-validation-dialog"]',
    )
    .locator('.workflow-validation__issue')
    .filter({ hasText: 'review-input-source-missing' })
    .first()
  await expect(reopenedReviewIssue).toBeVisible()
  await reopenedReviewIssue.click()
  await expect(reviewNode).toHaveClass(/selected/)
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'issue focus stayed tiny')
  await closeInspector(page)

  // Wait for the editor's physical WS connection to perform its initial
  // reconciliation GET, then prove a later server-side rename causes another
  // real detail refetch without replacing the user's viewport.
  await expect.poll(() => detailGetCount).toBeGreaterThanOrEqual(2)
  const panned = await panCanvas(page)
  const getCountBeforeRemoteUpdate = detailGetCount
  const remoteName = seeded.name.slice(0, -1) + 'b'
  await renameWorkflowOnServer(seeded.id, remoteName)
  await expect.poll(() => detailGetCount).toBeGreaterThan(getCountBeforeRemoteUpdate)
  await expect(page.getByRole('heading', { level: 1, name: remoteName })).toBeVisible()
  await expect
    .poll(async () => {
      const current = await readViewport(page)
      return Math.max(
        Math.abs(current.x - panned.x),
        Math.abs(current.y - panned.y),
        Math.abs(current.zoom - panned.zoom) * 100,
      )
    })
    .toBeLessThanOrEqual(1.5)

  // 390 那条腿在这一点上点不开相机面板（窄屏的投影控件另有自己的一套断言，
  // 见同函数前面的 expectHitRect 段），而本条能力的缺口是「这个动作在任何地方
  // 都没有被测过」——在 desktop 上钉住即已补齐。窄屏留给后续按投影控件的形态单列。
  if (profile === 'desktop') {
    // ⚠️ RFC-319 T37（审计条目 WF-23）—— 「聚焦选中」这个相机动作此前**零覆盖**：
    // `workflow-camera-focus-selection`（WorkflowCanvas.tsx:3194）在 `e2e/` 与
    // `packages/frontend/tests/` 里一次都没出现过。模式切换、缩放带、wrapper 头部聚焦、
    // 边中点居中、隐藏面板重适配都有真断言，唯独这一个按钮没有——所以把这条能力算成
    // 「已覆盖」是过度声称的。
    //
    // 放在本函数最末尾而不是插在中段：中段的每一步都对进入时的相机/选中状态有假设
    // （第一版插在 overview 段之前，把后面 wrapper.click 的 `toHaveClass(/selected/)`
    // 弄红了——那条红与本条能力无关，纯粹是我扰动了它的前置状态）。
    //
    // 三段判据：无选中时禁用（唯一前置条件）、有选中时可用、点下去相机真的动了。
    await clickCanvasControl(page, 'workflow-camera-overview')
    await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'overview before focus-selection')
    await page.keyboard.press('Escape')
    await expect(
      page.getByTestId('workflow-camera-focus-selection'),
      '没有选中任何对象时「聚焦选中」仍可点 ⇒ 点了只会什么都不发生',
    ).toBeDisabled()

    // 先回到可读缩放再选中。原来是在 overview 下 `click({ force: true })`：
    // 强制点击按元素中心投一次鼠标事件、跳过可操作性判定，而低缩放下节点只有
    // 几个像素——落在哪、被谁接住，完全取决于引擎对合成事件的处理。实测它在
    // chromium 与 macOS webkit 上选得中，唯独 **Linux 上的 webkit** 选不中
    // （e2e-webkit-nightly：class 里始终没有 `selected`）。那不是这条用例想验的
    // 东西。改在可读缩放下选中——节点是正常大小，点击对每个引擎都可靠。
    const focusTarget = page.locator('.react-flow__node[data-id="agent_01"]')
    await clickCanvasControl(page, 'workflow-camera-readable')
    await waitForZoom(page, (zoom) => zoom >= READABLE_MIN_ZOOM, 'readable before selecting')
    await focusTarget.click()
    await expect(focusTarget).toHaveClass(/selected/)
    // 选中本身就会带来一次 readable-focus（前面几段已锁）。先退回 overview，
    // 这样「点按钮之后缩放上去」才是这个按钮的功劳，而不是选中的副作用。
    await clickCanvasControl(page, 'workflow-camera-overview')
    await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'overview after selecting')
    await expect(page.getByTestId('workflow-camera-focus-selection')).toBeEnabled()
    await clickCanvasControl(page, 'workflow-camera-focus-selection')
    await waitForZoom(
      page,
      (zoom) => zoom >= READABLE_MIN_ZOOM,
      'focus-selection did not move the camera onto the selected node',
    )
    await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  }

  await expectEditorAxeClean(page, `${profile} complex workflow camera`)
}

test('desktop complex workflow keeps camera readable, explicit, and user-owned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
  await runComplexCameraScenario(page, 'desktop', 24)
})

test('390px coarse-pointer complex workflow preserves 44px projected actions', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  })
  try {
    const page = await context.newPage()
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await runComplexCameraScenario(page, '390-coarse', 44)
  } finally {
    await context.close()
  }
})

test('task canvas mounted in a hidden 0x0 pane refits once after reveal', async ({ page }) => {
  const runnable = await seedWorkflow('hidden-reveal', {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      { id: 'hidden_input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
      {
        id: 'hidden_agent',
        kind: 'agent-single',
        agentId: seededAgentId,
        agentName: 'rfc250-camera-agent',
        promptTemplate: 'Answer {{topic}}.',
        position: { x: 320, y: 0 },
      },
      {
        id: 'hidden_output',
        kind: 'output',
        ports: [{ name: 'answer', bind: { nodeId: 'hidden_agent', portName: 'answer' } }],
        position: { x: 640, y: 0 },
      },
    ],
    edges: [
      {
        id: 'hidden_e1',
        source: { nodeId: 'hidden_input', portName: 'topic' },
        target: { nodeId: 'hidden_agent', portName: 'topic' },
      },
      {
        id: 'hidden_e2',
        source: { nodeId: 'hidden_agent', portName: 'answer' },
        target: { nodeId: 'hidden_output', portName: 'answer' },
      },
    ],
  })
  const createTask = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name: 'rfc250-hidden-camera-task',
      workflowId: runnable.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'hidden canvas reveal' },
    }),
  })
  if (!createTask.ok) {
    throw new Error(`create hidden-reveal task: ${createTask.status} ${await createTask.text()}`)
  }
  const taskId = ((await createTask.json()) as { id: string }).id

  await page.setViewportSize({ width: 1280, height: 800 })
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=outputs`)

  const taskCanvas = page.locator('.workflow-canvas[data-surface="task"]')
  await expect(taskCanvas).toHaveCount(1)
  const hiddenRect = await taskCanvas.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  expect(hiddenRect.width).toBe(0)
  expect(hiddenRect.height).toBe(0)

  await page.locator('[data-task-detail-section-link="workflow-status"]').click()
  await expect(taskCanvas).toBeVisible()
  await expect(taskCanvas.locator('.react-flow__node')).toHaveCount(3)
  const revealedViewport = await waitForZoom(
    page,
    (zoom) => zoom > TOPOLOGY_MAX_ZOOM,
    'revealed task canvas remained at the hidden-mount minZoom',
  )
  expect(revealedViewport.zoom).toBeGreaterThan(TOPOLOGY_MAX_ZOOM)

  const revealGeometry = await taskCanvas.evaluate((canvas) => {
    const outer = canvas.getBoundingClientRect()
    const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.react-flow__node'))
    return {
      canvas: { width: outer.width, height: outer.height },
      offenders: nodes
        .filter((node) => {
          const rect = node.getBoundingClientRect()
          return (
            rect.left < outer.left - 3 ||
            rect.right > outer.right + 3 ||
            rect.top < outer.top - 3 ||
            rect.bottom > outer.bottom + 3
          )
        })
        .map((node) => node.dataset.id ?? '?'),
    }
  })
  expect(revealGeometry.canvas.width).toBeGreaterThan(0)
  expect(revealGeometry.canvas.height).toBeGreaterThan(0)
  expect(revealGeometry.offenders).toEqual([])
})

// ⚠️ RFC-319 T37（审计条目 WF-23）—— 「聚焦选中」这个相机动作此前**零覆盖**：
// `workflow-camera-focus-selection`（WorkflowCanvas.tsx:3194）在 `e2e/` 与
// `packages/frontend/tests/` 里一次都没出现过。模式切换、缩放带、wrapper 头部聚焦、
// 边中点居中、隐藏面板重适配都有真断言，唯独这一个按钮没有——所以把这条能力算成
// 「已覆盖」是过度声称。
//
// 独立成一条用例而不是并进上面那个共享场景函数，是被实测逼出来的：
//   * 插在中段 ⇒ 扰动了后面 `wrapper.click` 的 `toHaveClass(/selected/)` 前置状态；
//   * 放在末尾 ⇒ CI 的 Linux runner 上超时。那一段前面刚做过「远端改名 → 详情重取」，
//     校验面板因此进入 `stale` 态并**盖住相机控件**；而 `stale` 在那之后是**终态**
//     （本地草稿与服务端已分叉，不重新校验就不会回到 current），等不出来。
// 自带一个干净的编辑器就没有这些耦合。
test('RFC-319 WF-23: focus-selection is gated on a selection and actually moves the camera', async ({
  page,
}) => {
  const seeded = await seedWorkflow('focus-selection')
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/workflows/${seeded.id}`)

  const canvas = page.locator('.workflow-canvas')
  await expect(canvas).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(COMPLEX_NODE_COUNT)

  // 无选中 ⇒ 禁用。这是这个按钮唯一的前置条件。
  await clickCanvasControl(page, 'workflow-camera-overview')
  await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'overview before focus-selection')
  await page.keyboard.press('Escape')
  await expect(
    page.getByTestId('workflow-camera-focus-selection'),
    '没有选中任何对象时「聚焦选中」仍可点 ⇒ 点了只会什么都不发生',
  ).toBeDisabled()

  // 选中 ⇒ 可用。选中本身会带来一次 readable-focus，所以先退回 overview，
  // 这样「点按钮之后缩放上去」才是这个按钮的功劳，而不是选中的副作用。
  const focusTarget = page.locator('.react-flow__node[data-id="agent_01"]')
  await focusTarget.click({ force: true })
  await expect(focusTarget).toHaveClass(/selected/)
  await clickCanvasControl(page, 'workflow-camera-overview')
  await waitForZoom(page, (zoom) => zoom <= OVERVIEW_MAX_ZOOM, 'overview after selecting')
  await expect(page.getByTestId('workflow-camera-focus-selection')).toBeEnabled()

  await clickCanvasControl(page, 'workflow-camera-focus-selection')
  await waitForZoom(
    page,
    (zoom) => zoom >= READABLE_MIN_ZOOM,
    'focus-selection did not move the camera onto the selected node',
  )
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
})
