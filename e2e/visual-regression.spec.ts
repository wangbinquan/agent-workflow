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

import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { routePopulatedInbox } from './inbox-fixtures'

const RUN_VISUAL_REGRESSION = process.env.RUN_VISUAL_REGRESSION === '1'
const EXPECTED_VISUAL_SCENE_COUNT = 26

let daemon: DaemonHandle | undefined

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('visual-regression: daemon is not running')
  return daemon
}

// Every scene owns an isolated daemon. This makes a single --grep execution
// byte-equivalent to the full file: seeded resources and a previous scene's
// theme can never leak into the next screenshot.
test.beforeEach(async () => {
  if (!RUN_VISUAL_REGRESSION) return
  daemon = await startDaemon()
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

async function routeTasksTableFixture(page: Page): Promise<void> {
  const now = Date.now()
  await page.route(/\/api\/tasks(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'visual-task-row',
          name: 'Stable responsive table fixture',
          workflowId: 'visual-workflow-id',
          workflowName: 'visual-stub-workflow-with-a-long-name',
          repoPath: '/tmp/agent-workflow-with-a-deliberately-long-repository-display-name',
          repoUrl: null,
          status: 'done',
          startedAt: now - 5_400_000,
          finishedAt: now - 4_800_000,
          errorSummary: null,
          repoCount: 1,
          spaceKind: 'remote',
          sourceAgentName: null,
          openAlertCount: 0,
        },
      ]),
    })
  })
}

async function seedResources(): Promise<SeededResources> {
  await postJson('/api/agents', {
    name: 'visual-stub-agent',
    description: 'e2e seed',
    outputs: ['answer'],
    readonly: true,
    bodyMd: '',
  })
  const workflow = (await postJson('/api/workflows', {
    name: 'visual-stub-workflow',
    description: 'e2e seed',
    definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
  })) as { id: string }
  return { workflowId: workflow.id }
}

async function seedEditorWorkflow(): Promise<string> {
  const agentName = 'visual-editor-agent'
  await postJson('/api/agents', {
    name: agentName,
    description: 'Deterministic workflow-editor visual fixture',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
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

async function seedTerminalTask(): Promise<string> {
  const d = requireDaemon()
  const agentName = 'visual-task-agent'
  await postJson('/api/agents', {
    name: agentName,
    description: 'Deterministic mobile task-detail visual fixture',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
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
      if (current.status === 'done') return task.id
      if (['failed', 'canceled', 'interrupted'].includes(current.status)) {
        throw new Error(`visual-regression: task fixture reached ${current.status}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('visual-regression: task fixture did not finish in 30s')
}

async function routeDynamicWorkflowPreview(page: Page, taskId: string): Promise<void> {
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

  test('/auth (unauthenticated landing)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await page.route('**/api/auth/oidc/providers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ providers: [] }),
      }),
    )
    await page.goto(`${requireDaemon().baseUrl}/auth`)
    await expect(page.getByRole('heading', { name: /sign in|connect/i }).first()).toBeVisible()
    await expect(page.getByTestId('oidc-discovery-loading')).toBeHidden()
    await expect(
      page.getByText('No identity providers are configured. Use password or token sign-in.'),
    ).toBeVisible()
    await expect(page).toHaveScreenshot('auth.png', SNAPSHOT_OPTS)
  })

  test('/agents list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('agents.png', SNAPSHOT_OPTS)
  })

  test('/workflows list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/workflows`)
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await expect(page.locator('.page__actions')).toHaveScreenshot(
      'page-header-actions.png',
      COMPONENT_SNAPSHOT_OPTS,
    )
    await expect(page.locator('.empty-state')).toHaveScreenshot(
      'empty-state.png',
      COMPONENT_SNAPSHOT_OPTS,
    )
    await expect(page).toHaveScreenshot('workflows.png', SNAPSHOT_OPTS)
  })

  test('/repos list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/repos`)
    await expect(page.getByRole('heading', { name: /repos/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('repos.png', SNAPSHOT_OPTS)
  })

  test('/memory list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/memory`)
    await expect(page.getByRole('heading', { name: /memor/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('memory.png', SNAPSHOT_OPTS)
  })

  test('/settings page', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/settings`)
    await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible()
    await expect(page).toHaveScreenshot('settings.png', SNAPSHOT_OPTS)
  })

  // RFC-190: keep both true first-run and seeded dashboard scenes. Each owns
  // an isolated daemon, so declaration order is no longer part of the fixture.
  test('/ first-run (onboarding)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/`)
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('onboarding.png', SNAPSHOT_OPTS)
  })

  test('/ (homepage / dashboard, seeded non-first-run)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/`)
    await expect(page.locator('[data-testid="homepage"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('homepage.png', SNAPSHOT_OPTS)
  })

  test('/tasks list', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'clean' })
    await routeTasksTableFixture(page)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
    await expect(page.getByTestId('task-row-visual-task-row')).toBeVisible()
    const tableViewport = page.locator('.table-viewport').first()
    await expect(tableViewport).toHaveAttribute('data-overflow-end', 'true')
    await expect(tableViewport).toHaveScreenshot('table-edge.png', COMPONENT_SNAPSHOT_OPTS)
    await expect(page).toHaveScreenshot('tasks.png', SNAPSHOT_OPTS)
  })

  test('RFC-195 inbox empty dialog (light)', async ({ page }) => {
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
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
    await prepareScene(page, { theme: 'light', fixture: 'seeded-resources' })
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/agents/visual-stub-agent`)
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
    const taskId = await seedTerminalTask()
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}`)
    await expect(page.getByRole('heading', { name: /Mobile visual task/ })).toBeVisible()
    await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible()
    await expect(page.locator('.canvas-node--agent').first()).toBeVisible()
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
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
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
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
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
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
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
    await page.getByTestId('workflow-add-step').click()
    await expect(page.locator('.editor-layout')).toHaveAttribute('data-workspace-mode', 'compact')
    await expect(page.getByTestId('workflow-editor-palette-surface')).toBeVisible()
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
    await page.getByTestId('workflow-add-step').click()
    const palette = page.getByTestId('workflow-editor-palette-surface')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(palette.getByTestId('workflow-node-picker-category-agents')).toContainText('50')
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
    await page.locator('.react-flow__node[data-id="visual_agent"]').click()
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
    const taskId = await seedTerminalTask()
    await routeDynamicWorkflowPreview(page, taskId)
    await primeAuth(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}?tab=dw-orchestration`)
    await expect(page.getByTestId('dw-confirm-card')).toBeVisible()
    const preview = page.getByTestId('dw-preview-canvas')
    await expect(preview).toBeVisible()
    await expect(preview.locator('.react-flow__node')).toHaveCount(3)
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
