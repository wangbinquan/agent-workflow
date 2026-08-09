// RFC-054 W2-5 + RFC-198 T8 + RFC-199 T16 + RFC-219 T6 — visual regression
// baselines for the canonical shell pages, workflow-editor workspace modes,
// a large categorized node catalog, and a deterministic dynamic-workflow preview.
//
// LOCKS: a chunk of pixels for each canonical page. Catches UI changes
// that:
//   * Drop / shift / restyle a key element (panel collapses, header
//     gone, sidebar moved) without anyone noticing.
//   * Introduce visual noise (over-bright contrast, mismatched fonts).
//   * Break the layout at the canonical 1280×800 viewport.
//
// Playwright's `toHaveScreenshot()` writes platform-suffixed baselines
// (`*-darwin.png`, `*-linux.png`, …) under
// `e2e/visual-regression.spec.ts-snapshots/`. CI ubuntu and developer
// darwin each keep their own; updating either requires re-running with
// `--update-snapshots` on that platform.
//
// Gating: this spec is OPT-IN behind `RUN_VISUAL_REGRESSION=1`. Default
// `bun run e2e` skips it because:
//   * The first run on each platform fails (no baseline) — surfacing
//     that the suite needs platform-aware baseline generation;
//   * Font subpixel jitter on a developer's M-series Mac is enough to
//     drift 0.1% pixel diff per page without touching the code, which
//     would create flaky PR CI noise.
// The dedicated nightly workflow `visual-regression-nightly.yml` is
// where the gate actually runs, on ubuntu only (matching the committed
// `-linux.png` baselines).

import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { routePopulatedInbox } from './inbox-fixtures'
import {
  OPERATIONS_VISUAL_TIME,
  routeOperationsSurfaceFixtures,
} from './operations-surface-fixtures'
import { routeTaskOperationsFixture } from './task-operations-fixtures'

const RUN_VISUAL_REGRESSION = process.env.RUN_VISUAL_REGRESSION === '1'
const EXPECTED_VISUAL_SCENE_COUNT = 31
const HOMEPAGE_VISUAL_TIME = new Date(2026, 6, 23, 14, 0, 0)
const VISUAL_RUNTIME_STATUS = {
  runtimes: [
    {
      name: 'opencode',
      protocol: 'opencode',
      binary: 'opencode',
      ok: true,
      version: '1.18.3',
      isDefault: true,
    },
    {
      name: 'claude-code',
      protocol: 'claude-code',
      binary: 'claude',
      ok: false,
      version: null,
      isDefault: false,
    },
  ],
  sandbox: { mode: 'off', mechanism: null, available: false },
} as const

let daemon: DaemonHandle | undefined

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('visual-regression: daemon is not running')
  return daemon
}

// Every scene owns an isolated daemon. This makes a single --grep execution
// byte-equivalent to the full file: seeded resources and a previous scene's
// theme can never leak into the next screenshot.
test.beforeEach(async ({ page }) => {
  if (!RUN_VISUAL_REGRESSION) return
  daemon = await startDaemon()
  // The visual daemon intentionally points config.opencodePath at a shell
  // fixture. RFC-224 must reject those bytes in production, but recording that
  // expected rejection would make host executable identity part of unrelated
  // page pixels. Keep this presentation-only query deterministic; backend and
  // frontend contract suites own the real verified-status behavior.
  await page.route('**/api/runtimes/status', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    await route.fulfill({ json: VISUAL_RUNTIME_STATUS })
  })
})

test.afterEach(async () => {
  const activeDaemon = daemon
  daemon = undefined
  if (activeDaemon !== undefined) await activeDaemon.stop()
})

async function primeAuth(page: Page): Promise<void> {
  const d = requireDaemon()
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

/**
 * The shell first renders without `/api/auth/me`, then hydrates the real
 * session user. A screenshot that happens to match the old pixels can finish
 * before that request settles, while an intentional visual diff keeps polling
 * long enough to capture the final user instead. Always lock the hydrated
 * state so baseline acceptance never depends on assertion timing.
 */
async function waitForStableAuthenticatedShell(page: Page): Promise<void> {
  const userMenu = page.locator('.user-menu__trigger')
  await expect(userMenu).toContainText('e2e_admin')
  await expect(userMenu).toContainText('E2E Administrator')
  // UserMenu and ShellNavigation subscribe to the same actor query through
  // separate observers. The menu can commit one render before the admin-only
  // navigation rows, so waiting on it alone still leaves screenshots racing
  // the late /webhooks row. Lock the visible navigation tree as well.
  await expect(
    page.locator('[data-testid^="shell-navigation-"]:visible a[href="/webhooks"]'),
  ).toBeVisible()
  await page.waitForLoadState('networkidle')
}

async function setDaemonTheme(theme: 'light' | 'dark'): Promise<void> {
  const d = requireDaemon()
  const response = await fetch(`${d.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  if (!response.ok) {
    throw new Error(`visual-regression: failed to set ${theme} theme (${response.status})`)
  }
}

async function setStableNetworkPort(): Promise<void> {
  const d = requireDaemon()
  const response = await fetch(`${d.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
    },
    // This is persisted UI state only; the already-running isolated daemon
    // keeps its actual harness-selected port until restart.
    body: JSON.stringify({ bindPort: 43_210 }),
  })
  if (!response.ok) {
    throw new Error(`visual-regression: failed to set stable network port (${response.status})`)
  }
}

type SceneFixture = 'clean' | 'seeded-resources'

interface SeededResources {
  agentId: string
  workflowId: string
}

async function prepareScene(
  page: Page,
  options: { theme: 'light' | 'dark'; fixture: SceneFixture },
): Promise<SeededResources | null> {
  await page.emulateMedia({ colorScheme: options.theme })
  await setDaemonTheme(options.theme)
  return options.fixture === 'seeded-resources' ? seedResources() : null
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const d = requireDaemon()
  const response = await fetch(`${d.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`visual-regression: failed to seed ${path} (${response.status})`)
  }
  return response.json()
}

async function seedResources(): Promise<SeededResources> {
  const agent = (await postJson('/api/agents', {
    name: 'visual-stub-agent',
    description: 'e2e seed',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })) as { id: string }
  const workflow = (await postJson('/api/workflows', {
    name: 'visual-stub-workflow',
    description: 'e2e seed',
    definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
  })) as { id: string }
  return { agentId: agent.id, workflowId: workflow.id }
}

async function seedEditorWorkflow(): Promise<string> {
  const agentName = 'visual-editor-agent'
  const agent = (await postJson('/api/agents', {
    name: agentName,
    description: 'Deterministic workflow-editor visual fixture',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })) as { id: string }
  const workflow = (await postJson('/api/workflows', {
    name: 'visual-editor-workflow',
    description: 'A stable three-step authoring canvas',
    definition: {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'visual_input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'visual_agent',
          kind: 'agent-single',
          agentId: agent.id,
          agentName,
          promptTemplate: 'Explain {{topic}} clearly.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'visual_output',
          kind: 'output',
          ports: [{ name: 'answer', bind: { nodeId: 'visual_agent', portName: 'answer' } }],
          position: { x: 640, y: 0 },
        },
      ],
      edges: [
        {
          id: 'visual_input_agent',
          source: { nodeId: 'visual_input', portName: 'topic' },
          target: { nodeId: 'visual_agent', portName: 'topic' },
        },
        {
          id: 'visual_agent_output',
          source: { nodeId: 'visual_agent', portName: 'answer' },
          target: { nodeId: 'visual_output', portName: 'answer' },
        },
      ],
    },
  })) as { id: string }
  return workflow.id
}

async function openEditorScene(
  page: Page,
  workflowId: string,
  expectedNodes: number,
): Promise<void> {
  await primeAuth(page)
  await page.goto(`${requireDaemon().baseUrl}/workflows/${workflowId}`)
  await expect(page.locator('.workflow-canvas')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(expectedNodes)
  if ((page.viewportSize()?.width ?? 1280) > 720) {
    await waitForStableAuthenticatedShell(page)
  }
}

interface VisualCanvasViewport {
  x: number
  y: number
  zoom: number
}

async function readVisualCanvasViewport(page: Page): Promise<VisualCanvasViewport> {
  return page.locator('.react-flow__viewport').evaluate((element) => {
    const transform = getComputedStyle(element).transform
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform)
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 }
  })
}

async function waitForVisualCanvasViewportSettled(
  page: Page,
  previousViewport: VisualCanvasViewport,
): Promise<void> {
  await expect
    .poll(async () => {
      const current = await readVisualCanvasViewport(page)
      return Math.max(
        Math.abs(current.x - previousViewport.x),
        Math.abs(current.y - previousViewport.y),
        Math.abs(current.zoom - previousViewport.zoom) * 100,
      )
    })
    .toBeGreaterThan(0.5)

  let previous: VisualCanvasViewport | null = null
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const current = await readVisualCanvasViewport(page)
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
}

/**
 * Wait until the React Flow viewport stops moving, with no prior movement
 * required.
 *
 * `waitForVisualCanvasViewportSettled` above deliberately waits for the
 * viewport to MOVE first — it exists for "click a node, the canvas pans,
 * then it settles". A page that merely finishes loading never satisfies that
 * first poll, so a load-time screenshot had no settle step at all: the shot
 * could land mid-`fitView`, and the nodes came out a few pixels off their
 * final position. That is what made `mobile-task-detail.png` fail on the CI
 * runner while passing locally — a race, not a baseline drift, so raising the
 * pixel threshold would only have hidden it.
 */
async function waitForVisualCanvasViewportStable(page: Page): Promise<void> {
  let previous: VisualCanvasViewport | null = null
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const current = await readVisualCanvasViewport(page)
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
      { intervals: Array.from({ length: 20 }, () => 40) },
    )
    .toBeGreaterThanOrEqual(3)
}

/**
 * Re-fit a read-only canvas only after fonts and ResizeObserver measurements
 * have settled. The component owns a bounded automatic-refit window, but a
 * screenshot must not depend on whether the hosted runner delivered its last
 * measurement just before or just after that window closed.
 */
async function fitVisualCanvasAtSettledGeometry(page: Page, canvas: Locator): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
  const fitView = canvas.locator('.react-flow__controls-fitview')
  await expect(fitView).toBeVisible()
  await fitView.click()
  await waitForVisualCanvasViewportStable(page)
}

async function expectSelectedNodeCanvasMargin(
  page: Page,
  nodeId: string,
  previousViewport: VisualCanvasViewport,
  margin = 16,
): Promise<void> {
  const selectedNode = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await expect(selectedNode).toHaveClass(/selected/)
  await waitForVisualCanvasViewportSettled(page, previousViewport)
  const [canvasRect, nodeRect] = await Promise.all([
    page.locator('.workflow-canvas').boundingBox(),
    selectedNode.boundingBox(),
  ])
  if (canvasRect === null || nodeRect === null) {
    throw new Error(`${nodeId} final canvas geometry is incomplete`)
  }
  const minimumInset = Math.min(
    nodeRect.x - canvasRect.x,
    canvasRect.x + canvasRect.width - (nodeRect.x + nodeRect.width),
    nodeRect.y - canvasRect.y,
    canvasRect.y + canvasRect.height - (nodeRect.y + nodeRect.height),
  )
  expect(
    minimumInset,
    `${nodeId} did not retain a ${margin}px workflow-canvas margin`,
  ).toBeGreaterThanOrEqual(margin)
}

async function expectSelectedNodeVisibleBesideInspector(
  page: Page,
  nodeId: string,
  previousViewport: VisualCanvasViewport,
  margin = 16,
): Promise<void> {
  const selectedNode = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  const inspectorPanel = page
    .getByTestId('workflow-editor-inspector-surface')
    .locator('.workflow-editor-surface-dialog')
  await expect(selectedNode).toHaveClass(/selected/)
  await expect(inspectorPanel).toBeVisible()
  await waitForVisualCanvasViewportSettled(page, previousViewport)
  const [canvasRect, nodeRect, inspectorRect] = await Promise.all([
    page.locator('.workflow-canvas').boundingBox(),
    selectedNode.boundingBox(),
    inspectorPanel.boundingBox(),
  ])
  if (canvasRect === null || nodeRect === null || inspectorRect === null) {
    throw new Error('compact Inspector visibility geometry is incomplete')
  }
  // Compact uses a right-side Dialog panel over the canvas. Its dimmed
  // backdrop may cover the canvas, but the selected card itself must sit
  // wholly in the unobscured strip to the panel's left — being present
  // under an opaque panel is not a readable camera result.
  const visibleCanvasRight = Math.min(canvasRect.x + canvasRect.width, inspectorRect.x)
  const minimumVisibleInset = Math.min(
    nodeRect.x - canvasRect.x,
    visibleCanvasRight - (nodeRect.x + nodeRect.width),
    nodeRect.y - canvasRect.y,
    canvasRect.y + canvasRect.height - (nodeRect.y + nodeRect.height),
  )
  expect(
    minimumVisibleInset,
    `${nodeId} was hidden by the compact Inspector instead of retaining a ${margin}px visible-canvas margin`,
  ).toBeGreaterThanOrEqual(margin)
}

async function routeLargeAgentCatalog(page: Page, total = 50): Promise<void> {
  await page.route(/\/api\/agents(?:\?.*)?$/, async (route) => {
    const response = await route.fetch()
    if (!response.ok()) {
      await route.fulfill({ response })
      return
    }
    const existing = (await response.json()) as Array<Record<string, unknown>>
    const template = existing[0]
    if (template === undefined) {
      throw new Error('visual-regression: large Agent catalog needs one seeded template')
    }
    const synthetic = Array.from({ length: Math.max(0, total - existing.length) }, (_, index) => ({
      ...template,
      id: `rfc219-visual-agent-${index}`,
      name: `rfc219-visual-agent-${String(index).padStart(2, '0')}`,
      description: `Deterministic RFC-219 visual capability ${index}`,
    }))
    await route.fulfill({ response, json: [...existing, ...synthetic] })
  })
}

async function seedTerminalTask(): Promise<{ taskId: string; agentId: string }> {
  const d = requireDaemon()
  const agentName = 'visual-task-agent'
  const agent = (await postJson('/api/agents', {
    name: agentName,
    description: 'Deterministic mobile task-detail visual fixture',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })) as { id: string }
  const workflow = (await postJson('/api/workflows', {
    name: 'visual-task-workflow',
    description: 'Deterministic mobile task-detail visual fixture',
    definition: {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'agent_1',
          kind: 'agent-single',
          agentId: agent.id,
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
    name: 'Mobile visual task',
    scratch: true,
    inputs: { topic: 'responsive interfaces' },
  })) as { id: string }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${d.baseUrl}/api/tasks/${task.id}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (response.ok) {
      const current = (await response.json()) as { status: string }
      if (current.status === 'done') return { taskId: task.id, agentId: agent.id }
      if (['failed', 'canceled', 'interrupted'].includes(current.status)) {
        throw new Error(`visual-regression: task fixture reached ${current.status}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('visual-regression: task fixture did not finish in 30s')
}

async function routeDynamicWorkflowPreview(
  page: Page,
  taskId: string,
  agentId: string,
): Promise<void> {
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const task = (await response.json()) as Record<string, unknown>
    await route.fulfill({
      response,
      json: {
        ...task,
        status: 'awaiting_review',
        workgroupId: 'visual-dynamic-workgroup',
        workgroupName: 'Visual dynamic workgroup',
      },
    })
  })
  await page.route(`**/api/workgroup-tasks/${taskId}/room`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        taskId,
        taskStatus: 'awaiting_review',
        config: {
          workgroupId: 'visual-dynamic-workgroup',
          workgroupName: 'Visual dynamic workgroup',
          mode: 'dynamic_workflow',
          leaderMemberId: null,
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 10,
          completionGate: false,
          instructions: '',
          goal: 'Turn a product brief into a clear implementation plan.',
          members: [
            {
              id: 'visual-planner-member',
              memberType: 'agent',
              agentId,
              agentName: 'visual-task-agent',
              userId: null,
              displayName: 'Planner',
              roleDesc: 'Breaks the brief into an executable plan.',
            },
          ],
        },
        gate: {
          declaredDone: false,
          awaitingConfirmation: false,
          rejected: false,
          summary: null,
        },
        dw: {
          phase: 'awaiting_confirm',
          generateAttempts: 1,
          rejectRounds: 0,
          generatedDef: {
            $schema_version: 4,
            inputs: [{ kind: 'text', key: 'brief', label: 'Brief', required: true }],
            nodes: [
              {
                id: 'visual_dw_input',
                kind: 'input',
                inputKey: 'brief',
                position: { x: 0, y: 0 },
              },
              {
                id: 'visual_dw_plan',
                kind: 'agent-single',
                agentId,
                agentName: 'visual-task-agent',
                promptTemplate: 'Create a plan for {{brief}}.',
                position: { x: 320, y: 0 },
              },
              {
                id: 'visual_dw_output',
                kind: 'output',
                ports: [
                  {
                    name: 'answer',
                    bind: { nodeId: 'visual_dw_plan', portName: 'answer' },
                  },
                ],
                position: { x: 640, y: 0 },
              },
            ],
            edges: [
              {
                id: 'visual_dw_input_plan',
                source: { nodeId: 'visual_dw_input', portName: 'brief' },
                target: { nodeId: 'visual_dw_plan', portName: 'brief' },
              },
              {
                id: 'visual_dw_plan_output',
                source: { nodeId: 'visual_dw_plan', portName: 'answer' },
                target: { nodeId: 'visual_dw_output', portName: 'answer' },
              },
            ],
          },
        },
        messages: [],
        assignments: [],
        memberRuns: {},
        runHistory: [],
        // RFC-209 —— 房间聚合的新字段。e2e 在 workspace typecheck 之外，桩体不同步就会
        // 悄悄与契约脱节（本仓有过先例）。
        budgetUsed: 0,
      }),
    })
  })
}

/**
 * Per-test snapshot config. Threshold 0.2% per RFC-054 plan §risk 9
 * (font subpixel jitter). `animations: 'disabled'` freezes CSS
 * transitions so a snapshot taken mid-animation isn't a flake source.
 * `caret: 'hide'` hides the text cursor (which blinks → naturally
 * changes between frames).
 */
const SNAPSHOT_OPTS = {
  maxDiffPixelRatio: 0.002,
  animations: 'disabled' as const,
  caret: 'hide' as const,
  fullPage: true,
}

const COMPONENT_SNAPSHOT_OPTS = {
  maxDiffPixelRatio: SNAPSHOT_OPTS.maxDiffPixelRatio,
  animations: SNAPSHOT_OPTS.animations,
  caret: SNAPSHOT_OPTS.caret,
}

test.describe('RFC-054 W2-5 — visual regression on key pages', () => {
  test.skip(
    !RUN_VISUAL_REGRESSION,
    'visual regression gated by RUN_VISUAL_REGRESSION=1 (see e2e/visual-regression.README.md)',
  )

  test('/auth (ready password + SSO landing)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await page.route('**/api/auth/oidc/providers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'ready',
          providers: [{ slug: 'company-sso', displayName: 'Company SSO', iconUrl: null }],
          passwordLoginEnabled: true,
          daemonTokenEnabled: false,
        }),
      }),
    )
    await page.goto(`${requireDaemon().baseUrl}/auth`)
    await expect(page.getByRole('heading', { name: /sign in|connect/i }).first()).toBeVisible()
    await expect(page.getByTestId('oidc-discovery-loading')).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Single sign-on' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Password' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Login with Company SSO' })).toBeVisible()
    await expect(page).toHaveScreenshot('auth.png', SNAPSHOT_OPTS)
  })

  test('/agents list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('agents.png', SNAPSHOT_OPTS)
  })

  test('/workflows list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    // Package import is a creation method now. A genuinely empty gallery keeps
    // one primary CTA in EmptyState and must not resurrect a header action row.
    await expect(page.locator('.page__actions')).toHaveCount(0)
    await expect(page.locator('.empty-state')).toHaveScreenshot(
      'empty-state.png',
      COMPONENT_SNAPSHOT_OPTS,
    )
    await expect(page).toHaveScreenshot('workflows.png', SNAPSHOT_OPTS)
  })

  test('/repos list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await page.clock.setFixedTime(OPERATIONS_VISUAL_TIME)
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos`)
    await expect(page.getByRole('heading', { name: /repos/i }).first()).toBeVisible()
    await expect(page.getByTestId('repos-row-repo-ux-01')).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('repos.png', SNAPSHOT_OPTS)
  })

  test('RFC-249 repo group editor · 20 flat repositories · 1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos?tab=groups`)
    await page.getByTestId('repo-group-edit-group-flat-20').click()
    await expect(page.getByTestId('repo-group-node-service-20')).toBeAttached()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('repo-group-flat-20-1440.png', SNAPSHOT_OPTS)
  })

  test('RFC-249 repo group editor · three-level tree · 1440', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos?tab=groups`)
    await page.getByTestId('repo-group-edit-group-nested-3').click()
    await page.getByTestId('repo-group-node-select-vendor/sdk/ext').click()
    await expect(page.getByTestId('repo-group-node-settings-vendor/sdk/ext')).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('repo-group-nested-1440.png', SNAPSHOT_OPTS)
  })

  test('RFC-249 repo group editor · inline settings · 736', async ({ page }) => {
    await page.setViewportSize({ width: 736, height: 900 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos?tab=groups`)
    await page.getByTestId('repo-group-edit-group-nested-3').click()
    await page.getByTestId('repo-group-node-select-apps/web').click()
    await expect(page.getByTestId('repo-group-node-settings-apps/web')).toBeVisible()
    // The compact shell intentionally hides the desktop user menu. The dialog
    // content above is the stable authenticated-state anchor for this scene.
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('repo-group-inline-736.png', SNAPSHOT_OPTS)
  })

  test('RFC-249 repo group editor · batch mode · 390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos?tab=groups`)
    // TableViewport is the intentional keyboard/touch overflow surface on a
    // phone. Reproduce the user's horizontal swipe before opening the editor.
    await page.getByRole('region', { name: 'Repo groups' }).evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    const editButton = page.getByTestId('repo-group-edit-group-flat-20')
    await expect(editButton).toBeVisible()
    // The scene exercises the editor rather than TableViewport's already
    // covered pointer mechanics; dispatch after the explicit swipe setup.
    await editButton.dispatchEvent('click')
    for (const path of ['service-1', 'service-2', 'service-3']) {
      const checkbox = page.getByTestId(`repo-group-node-${path}`).locator('input[type="checkbox"]')
      await checkbox.scrollIntoViewIfNeeded()
      await checkbox.click()
    }
    await expect(page.getByTestId('repo-group-batch-bar')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('repo-group-batch-390.png', SNAPSHOT_OPTS)
  })

  test('/scheduled list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await page.clock.setFixedTime(OPERATIONS_VISUAL_TIME)
    await routeOperationsSurfaceFixtures(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/scheduled`)
    await expect(page.getByRole('heading', { name: /scheduled/i }).first()).toBeVisible()
    await expect(page.getByTestId('scheduled-row-scheduled-ux-01')).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('scheduled.png', SNAPSHOT_OPTS)
  })

  test('/memory list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/memory`)
    await expect(page.getByRole('heading', { name: /memor/i }).first()).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('memory.png', SNAPSHOT_OPTS)
  })

  test('/settings page', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/settings`)
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('settings.png', SNAPSHOT_OPTS)
  })

  // RFC-190: keep both true first-run and seeded dashboard scenes. Each owns
  // an isolated daemon, so declaration order is no longer part of the fixture.
  test('/ first-run (onboarding)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/`)
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('onboarding.png', SNAPSHOT_OPTS)
  })

  test('/ (homepage / dashboard, seeded non-first-run)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await page.clock.setFixedTime(HOMEPAGE_VISUAL_TIME)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/`)
    await expect(page.locator('[data-testid="homepage"]')).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(page).toHaveScreenshot('homepage.png', SNAPSHOT_OPTS)
  })

  test('/tasks list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeTaskOperationsFixture(page, {
      primaryId: 'visual-task-row',
      primaryName: 'Stable dense task operations fixture',
      workflowName: 'visual-stub-workflow-with-a-long-name',
    })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
    await expect(page.getByTestId('task-row-visual-task-row')).toBeVisible()
    const operations = page.locator('.task-operations')
    await expect(operations).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    await expect(operations).toHaveScreenshot('table-edge.png', COMPONENT_SNAPSHOT_OPTS)
    await page.getByRole('heading', { name: /tasks/i }).first().scrollIntoViewIfNeeded()
    await expect(page).toHaveScreenshot('tasks.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox empty dialog (light)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await waitForStableAuthenticatedShell(page)
    await expect(page.getByText('visual-stub-agent', { exact: true })).toBeVisible()
    await page.getByTestId('inbox-footer-button').click()
    const dialog = page.getByRole('dialog', { name: 'Inbox' })
    await expect(dialog).toContainText('Nothing waiting')
    await expect(dialog.locator('.dialog__footer')).toHaveScreenshot(
      'dialog-footer.png',
      COMPONENT_SNAPSHOT_OPTS,
    )
    await expect(page).toHaveScreenshot('inbox-empty-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox populated dialog (light)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await routePopulatedInbox(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await waitForStableAuthenticatedShell(page)
    await expect(page.getByText('visual-stub-agent', { exact: true })).toBeVisible()
    await page.getByTestId('inbox-footer-button').click()
    await expect(page.getByTestId('inbox-row-review-visual-review-0')).toBeVisible()
    await expect(page).toHaveScreenshot('inbox-populated-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox populated dialog (dark)', async ({ page }) => {
    await prepareScene(page, { theme: 'dark', fixture: 'seeded-resources' })
    await routePopulatedInbox(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await waitForStableAuthenticatedShell(page)
    await expect(page.getByText('visual-stub-agent', { exact: true })).toBeVisible()
    await page.getByTestId('inbox-footer-button').click()
    await expect(page.getByTestId('inbox-row-review-visual-review-0')).toBeVisible()
    await expect(page).toHaveScreenshot('inbox-populated-dark.png', SNAPSHOT_OPTS)
  })

  // RFC-198 T8 — five representative 390x844 mobile surfaces. Keep this
  // intentionally small: UX geometry has broader semantic coverage in
  // ux-consistency.spec.ts; these scenes lock the most important pixels.
  test('390 mobile home with navigation (seeded, light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/`)
    await expect(page.getByTestId('homepage')).toBeVisible()
    await page.getByTestId('mobile-menu-trigger').click()
    const mobileNav = page.getByTestId('mobile-nav-dialog').getByRole('dialog')
    await expect(mobileNav).toBeVisible()
    await waitForStableAuthenticatedShell(page)
    const memoryLink = mobileNav.locator('a[href="/memory?tab=all"]')
    await expect(memoryLink).toBeVisible()
    // RFC-254 T33: wait for the nav list to STOP MOVING, not for it to FIT.
    //
    // The previous wait required the last entry's bottom to sit inside
    // `.dialog__body`. That holds at 390×844 with Linux/macOS font metrics and
    // is NEVER true on Windows, where Segoe UI renders the list taller and the
    // body legitimately overflows — it is a scroll region by design, so the
    // assertion was simply stricter than the requirement. Untouched, the wait
    // burned its full 15s and the test died before either screenshot, which is
    // why Windows produced 44 of the 46 baselines rather than 46.
    //
    // Scrolling the item into view first was tried and REJECTED: it is not a
    // no-op where the item already fits — it shifted the macOS rendering and
    // broke the existing darwin baselines. Settling is what this wait is
    // actually for, so it now asks for exactly that: two consecutive samples
    // agreeing on the box. No platform scrolls, no existing baseline moves, and
    // the win32 shot records what a Windows user genuinely sees.
    let previousBottom = Number.NaN
    await expect
      .poll(async () => {
        const bottom = await memoryLink.evaluate(
          (element) => element.getBoundingClientRect().bottom,
        )
        const settled = bottom === previousBottom
        previousBottom = bottom
        return settled
      })
      .toBe(true)
    await expect(mobileNav).toHaveScreenshot('mobile-nav-open.png', COMPONENT_SNAPSHOT_OPTS)
    await expect(page).toHaveScreenshot('mobile-home-nav.png', SNAPSHOT_OPTS)
  })

  test('390 mobile workflow gallery (seeded, light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await expect(page.getByTestId('workflow-card-visual-stub-workflow')).toBeVisible()
    await expect(page.getByTestId('workflow-new-button')).toBeVisible()
    await expect(page).toHaveScreenshot('mobile-workflows.png', SNAPSHOT_OPTS)
  })

  test('390 mobile agent split detail (seeded, light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const fixture = await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    if (fixture === null) throw new Error('mobile agent scene requires seeded resources')
    await page.goto(`${requireDaemon().baseUrl}/agents/${fixture.agentId}`)
    await expect(
      page.getByRole('heading', { name: 'visual-stub-agent', exact: true }),
    ).toBeVisible()
    await expect(page.getByTestId('agents-mobile-back')).toBeVisible()
    await expect(page.locator('.split__list')).toBeHidden()
    await expect(page).toHaveScreenshot('mobile-agent-detail.png', SNAPSHOT_OPTS)
  })

  test('390 mobile settings form (clean, light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await setStableNetworkPort()
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/settings?tab=network`)
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByTestId('settings-compact-select')).toContainText('Network')
    await expect(page.getByTestId('settings-bind-port')).toBeVisible()
    await expect(page.getByTestId('settings-bind-port')).toHaveValue('43210')
    await expect(page).toHaveScreenshot('mobile-settings-network.png', SNAPSHOT_OPTS)
  })

  test('390 mobile terminal task detail (seeded, light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const { taskId } = await seedTerminalTask()
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}`)
    await expect(page.getByRole('heading', { name: /Mobile visual task/ })).toBeVisible()
    await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible()
    await expect(page.locator('.canvas-node--agent').first()).toBeVisible()
    // A visible node is not a settled canvas: async fonts/node measurements
    // can land on either side of the component's bounded auto-refit window.
    // Re-fit once from the final measured geometry before locking pixels.
    await fitVisualCanvasAtSettledGeometry(page, page.locator('.workflow-canvas'))
    await expect(page).toHaveScreenshot('mobile-task-detail.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.task-detail__id code')],
    })
  })

  // RFC-199 T16.3 — deterministic editor workspace modes. Random resource
  // ids are masked; the graph, viewport, theme, and selected node are fixed.
  test('RFC-199 editor 1536 three-rail workspace (light)', async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    const beforeSelection = await readVisualCanvasViewport(page)
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
    await expectSelectedNodeCanvasMargin(page, 'visual_agent', beforeSelection)
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'wide')
    await expect(page.locator('.editor-layout > .editor-sidebar')).toBeVisible()
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-1536-three-rail-light.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-199 editor 1280 inspector rail (light)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    const beforeSelection = await readVisualCanvasViewport(page)
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
    await expectSelectedNodeCanvasMargin(page, 'visual_agent', beforeSelection)
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'medium')
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-1280-inspector-light.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-199 editor 1280 inspector rail (dark)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await prepareScene(page, { theme: 'dark', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    const beforeSelection = await readVisualCanvasViewport(page)
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
    await expectSelectedNodeCanvasMargin(page, 'visual_agent', beforeSelection)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'medium')
    await expect(page.locator('.editor-layout > .inspector')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-1280-inspector-dark.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-199 editor 1179 palette side modal (light)', async ({ page }) => {
    await page.setViewportSize({ width: 1179, height: 800 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    await page.getByTestId('workflow-canvas-add').click()
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'compact')
    await expect(page.getByTestId('workflow-node-picker-dialog')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-1179-palette-light.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-219 editor 1179 large catalog Human category (dark)', async ({ page }) => {
    await page.setViewportSize({ width: 1179, height: 800 })
    await prepareScene(page, { theme: 'dark', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await routeLargeAgentCatalog(page, 50)
    await openEditorScene(page, workflowId, 3)
    // RFC-253 added a late/stale-baseline-sensitive category to this scene.
    // Lock the complete catalog before taking pixels: the 0.2% full-page
    // allowance previously let the missing row pass on its own.
    await page.getByTestId('workflow-canvas-add').click()
    const palette = page.getByTestId('workflow-node-picker-dialog')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(palette.getByTestId('workflow-node-picker-category-agents')).toContainText('50')
    const scriptsCategory = palette.getByTestId('workflow-node-picker-category-scripts')
    await expect(scriptsCategory).toContainText('Scripts')
    await expect(scriptsCategory.locator('.tabs__tab-badge')).toHaveText('1')
    await palette.getByTestId('workflow-node-picker-category-human').click()
    await expect(palette.getByTestId('workflow-node-picker-category-panel-human')).toBeVisible()
    await expect(palette.getByTestId('workflow-node-picker-item-kind-review')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-node-picker-1179-large-human-dark.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-199 editor 1179 inspector side modal (light)', async ({ page }) => {
    await page.setViewportSize({ width: 1179, height: 800 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    const beforeSelection = await readVisualCanvasViewport(page)
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
    await expectSelectedNodeVisibleBesideInspector(page, 'visual_agent', beforeSelection)
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'compact')
    await expect(page.getByTestId('workflow-editor-inspector-surface')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-1179-inspector-light.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('RFC-199 editor 390 empty canvas with picker (light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const seeded = await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    if (seeded === null) throw new Error('visual-regression: missing seeded workflow')
    await openEditorScene(page, seeded.workflowId, 0)
    await page.getByTestId('workflow-empty-add-first').click()
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'phone')
    await expect(page.getByTestId('workflow-node-picker-dialog')).toBeVisible()
    // The opaque phone surface covers the random editor metadata. Do not add
    // a Playwright mask here: masks paint above overlays and would obscure the
    // picker itself even though the id is already hidden underneath it.
    await expect(page).toHaveScreenshot('workflow-editor-390-empty-picker-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-199 editor 390 full-screen inspector (light)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const workflowId = await seedEditorWorkflow()
    await openEditorScene(page, workflowId, 3)
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'phone')
    await expect(page.getByTestId('workflow-editor-inspector-surface')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-editor-390-inspector-light.png', SNAPSHOT_OPTS)
  })

  test('RFC-199 deterministic dynamic-workflow preview (light)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    const { taskId, agentId } = await seedTerminalTask()
    await routeDynamicWorkflowPreview(page, taskId, agentId)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}?tab=dw-orchestration`)
    await expect(page.getByTestId('dw-confirm-card')).toBeVisible()
    const preview = page.getByTestId('dw-preview-canvas')
    await expect(preview).toBeVisible()
    await expect(preview.locator('.react-flow__node')).toHaveCount(3)
    await waitForStableAuthenticatedShell(page)
    await expect(page.getByTestId('task-members-dialog-button')).toBeVisible()
    // WorkflowCanvas deliberately keeps a 1200ms refit window while the
    // surrounding task-detail layout settles. Close that window, then perform
    // one explicit fit from the final measured geometry: CI has demonstrated
    // that the last ResizeObserver delivery can straddle the timeout.
    await page.waitForTimeout(1300)
    await fitVisualCanvasAtSettledGeometry(page, preview)
    await expect(preview).toHaveScreenshot(
      'dynamic-workflow-preview-canvas.png',
      COMPONENT_SNAPSHOT_OPTS,
    )
    await expect(page).toHaveScreenshot('dynamic-workflow-preview.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.task-detail__id code')],
    })
  })
})

const declaredVisualSceneCount = (
  readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/^\s{2}test\(/gm) ?? []
).length
if (declaredVisualSceneCount !== EXPECTED_VISUAL_SCENE_COUNT) {
  throw new Error(
    `visual-regression: expected ${EXPECTED_VISUAL_SCENE_COUNT} scenes, declared ${declaredVisualSceneCount}`,
  )
}
