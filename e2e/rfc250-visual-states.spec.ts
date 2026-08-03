// RFC-250 T35/T37/T43 — visual evidence for the high-risk populated states
// explicitly required by design.md §12.3.
//
// These screenshots are deliberately opt-in. The ordinary Chromium/WebKit E2E
// matrix still exercises the semantic flows in the dedicated RFC-250 specs,
// but it must never become dependent on a developer/runner-specific pixel
// baseline. `bun run test:visual` is the only local entry point that sets the
// gate and executes these scenes.

import { expect, test, type Locator, type Page } from '@playwright/test'
import type { StructuralDiff } from '@agent-workflow/shared'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { initGitRepo } from './command'
import { startDaemon, type DaemonHandle } from './harness'

const RUN_VISUAL_REGRESSION = process.env.RUN_VISUAL_REGRESSION === '1'
const EXPECTED_RFC250_VISUAL_SCENE_COUNT = 9
const TASK_WIZARD_DRAFT_PREFIX = 'aw:task-wizard-draft:v1:'
const here = dirname(fileURLToPath(import.meta.url))
const stubClarify = resolve(here, 'fixtures', 'stub-opencode-clarify.sh')

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

const CHANGES_DIFF = `diff --git a/src/ui/account.ts b/src/ui/account.ts
index 1111..2222 100644
--- a/src/ui/account.ts
+++ b/src/ui/account.ts
@@ -1,2 +1,2 @@
-export const accountState = 'legacy'
+export const accountState = 'ready'
 export const owner = 'platform'
diff --git a/src/ui/navigation.ts b/src/ui/navigation.ts
index 3333..4444 100644
--- a/src/ui/navigation.ts
+++ b/src/ui/navigation.ts
@@ -1,2 +1,2 @@
-export const compact = false
+export const compact = true
 export const keyboard = true
diff --git a/src/core/session.ts b/src/core/session.ts
index 5555..6666 100644
--- a/src/core/session.ts
+++ b/src/core/session.ts
@@ -1,2 +1,2 @@
-export const durable = false
+export const durable = true
 export const generation = 3
diff --git a/src/core/recovery.ts b/src/core/recovery.ts
index 7777..8888 100644
--- a/src/core/recovery.ts
+++ b/src/core/recovery.ts
@@ -1,2 +1,2 @@
-export const restore = 'manual'
+export const restore = 'guided'
 export const discard = 'explicit'
diff --git a/src/core/permissions.ts b/src/core/permissions.ts
index 9999..aaaa 100644
--- a/src/core/permissions.ts
+++ b/src/core/permissions.ts
@@ -1,2 +1,2 @@
-export const matrix = 'table'
+export const matrix = 'responsive'
 export const discoverable = true
diff --git a/README.md b/README.md
index bbbb..cccc 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # RFC-250 fixture
+Interaction states are recoverable and explicit.
`

let daemon: DaemonHandle | undefined
let ownedTempDirs: string[] = []

function requireDaemon(): DaemonHandle {
  if (daemon === undefined) throw new Error('RFC-250 visual daemon is not running')
  return daemon
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireDaemon().token}`,
    'Content-Type': 'application/json',
  }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const d = requireDaemon()
  const response = await fetch(`${d.baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(
      `RFC-250 visual fixture POST ${path}: ${response.status} ${await response.text()}`,
    )
  }
  return response.json()
}

async function setLightTheme(): Promise<void> {
  const d = requireDaemon()
  const response = await fetch(`${d.baseUrl}/api/config`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ theme: 'light' }),
  })
  if (!response.ok) throw new Error(`RFC-250 visual theme setup failed: ${response.status}`)
}

async function primePage(
  page: Page,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
): Promise<void> {
  const d = requireDaemon()
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await setLightTheme()
  await page.addInitScript(
    ({ baseUrl, token }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
      window.localStorage.setItem('agent-workflow.token', token)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { baseUrl: d.baseUrl, token: d.token },
  )
}

async function waitForStableDesktopShell(page: Page): Promise<void> {
  const trigger = page.locator('.user-menu__trigger')
  await expect(trigger).toContainText('e2e_admin')
  await expect(trigger).toContainText('E2E Administrator')
}

async function createAgent(name: string, outputs: string[] = ['answer']): Promise<string> {
  const created = (await postJson('/api/agents', {
    name,
    description: 'Deterministic RFC-250 visual fixture',
    outputs,
    outputKinds: Object.fromEntries(outputs.map((output) => [output, 'markdown'])),
    readonly: true,
    bodyMd: '',
  })) as { id: string }
  return created.id
}

function independentAgentNode(
  agentId: string,
  id: string,
  x: number,
  y: number,
): Record<string, unknown> {
  return {
    id,
    kind: 'agent-single',
    agentId,
    agentName: 'rfc250-visual-camera-agent',
    promptTemplate: `Independent camera step ${id}.`,
    position: { x, y },
  }
}

/** Same 15-node topology and stable ids as rfc250-workflow-camera.spec.ts. */
function complexWorkflowDefinition(agentId: string): Record<string, unknown> {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
    nodes: [
      { id: 'input_entry', kind: 'input', inputKey: 'topic', position: { x: 0, y: -100 } },
      {
        id: 'agent_01',
        kind: 'agent-single',
        agentId,
        agentName: 'rfc250-visual-camera-agent',
        promptTemplate: 'Answer {{topic}}.',
        position: { x: 300, y: 0 },
      },
      independentAgentNode(agentId, 'agent_02', 600, -100),
      independentAgentNode(agentId, 'agent_03', 900, -100),
      independentAgentNode(agentId, 'agent_04', 0, 250),
      independentAgentNode(agentId, 'agent_05', 0, -450),
      independentAgentNode(agentId, 'agent_06', 300, -450),
      independentAgentNode(agentId, 'agent_07', 600, -450),
      independentAgentNode(agentId, 'agent_08', 900, -450),
      independentAgentNode(agentId, 'agent_09', 300, 250),
      independentAgentNode(agentId, 'agent_10', 600, 250),
      independentAgentNode(agentId, 'agent_11', 900, 250),
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

async function seedComplexWorkflow(): Promise<string> {
  const agentId = await createAgent('rfc250-visual-camera-agent')
  const workflow = (await postJson('/api/workflows', {
    name: 'rfc250-complex-readable-workflow',
    description: 'Fifteen-node deterministic camera visual fixture',
    definition: complexWorkflowDefinition(agentId),
  })) as { id: string }
  return workflow.id
}

async function openComplexWorkflow(page: Page): Promise<Locator> {
  const workflowId = await seedComplexWorkflow()
  await primePage(page)
  await page.goto(`${requireDaemon().baseUrl}/workflows/${workflowId}`)
  const canvas = page.locator('.workflow-canvas')
  await expect(canvas).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(15)
  await expect(canvas).toHaveAttribute('data-camera-mode', 'readable-focus')
  await expect(canvas).toHaveAttribute('data-zoom-band', 'readable')
  await waitForStableDesktopShell(page)
  return canvas
}

async function createRunnableWorkflow(agentId: string, name: string): Promise<string> {
  const workflow = (await postJson('/api/workflows', {
    name,
    description: 'Deterministic RFC-250 task visual fixture',
    definition: {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'visual_input', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'visual_agent',
          kind: 'agent-single',
          agentId,
          agentName: 'rfc250-changes-agent',
          promptTemplate: 'Explain {{topic}}.',
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

async function waitForTaskStatus(taskId: string, expected: string): Promise<void> {
  const d = requireDaemon()
  await expect
    .poll(
      async () => {
        const response = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${d.token}` },
        })
        if (!response.ok) return `http-${response.status}`
        return ((await response.json()) as { status: string }).status
      },
      { timeout: 30_000 },
    )
    .toBe(expected)
}

async function seedGitTask(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc250-visual-changes-'))
  ownedTempDirs.push(repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# RFC-250 visual changes\n', 'utf8')
  initGitRepo(repoDir)

  const agentId = await createAgent('rfc250-changes-agent')
  const workflowId = await createRunnableWorkflow(agentId, 'rfc250-changes-workflow')
  const task = (await postJson('/api/tasks', {
    workflowId,
    name: 'RFC-250 interaction integrity review',
    repoUrl: pathToFileURL(repoDir).href,
    ref: 'main',
    inputs: { topic: 'interaction integrity' },
  })) as { id: string }
  await waitForTaskStatus(task.id, 'done')
  return task.id
}

function changesStructuralFixture(taskId: string): StructuralDiff {
  return {
    scope: 'task',
    taskId,
    fromRef: '1111111111111111111111111111111111111111',
    toRef: 'WORKTREE',
    engine: 'baseline',
    status: 'ok',
    files: [
      {
        filePath: 'src/ui/account.ts',
        lang: 'typescript',
        status: 'ok',
        changes: [
          {
            changeType: 'modified',
            kind: 'method',
            after: {
              id: 'src/ui/account.ts#renderAccount:method:1',
              kind: 'method',
              name: 'renderAccount',
              qualifiedName: 'AccountView.renderAccount',
              lang: 'typescript',
              filePath: 'src/ui/account.ts',
              confidence: 'extracted',
              range: { startLine: 1, endLine: 2 },
            },
            bodyChanged: true,
          },
        ],
        edges: [],
        impact: [],
      },
    ],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    callChainAvailable: true,
    contentDigest: 'rfc250-visual-content-digest',
    summary: {
      files: 6,
      classes: { added: 0, modified: 0, removed: 0, renamed: 0 },
      methods: { added: 0, modified: 1, removed: 0, renamed: 0 },
      fields: { added: 0, modified: 0, removed: 0, renamed: 0 },
      imports: { added: 0, modified: 0, removed: 0, renamed: 0 },
      dependencies: { added: 0, modified: 0, removed: 0, renamed: 0 },
    },
  }
}

async function seedClarifySession(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc250-visual-clarify-'))
  ownedTempDirs.push(repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# RFC-250 clarify visual fixture\n', 'utf8')
  initGitRepo(repoDir)

  const agentId = await createAgent('rfc250-visual-clarify-designer', ['design'])
  const workflow = (await postJson('/api/workflows', {
    name: 'rfc250-clarify-durability-workflow',
    description: 'Deterministic local-only draft fixture',
    definition: {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'designer',
          kind: 'agent-single',
          agentId,
          agentName: 'rfc250-visual-clarify-designer',
          promptTemplate: 'Design for {{topic}}.',
          position: { x: 320, y: 0 },
        },
        {
          id: 'clarify_1',
          kind: 'clarify',
          title: 'Clarify design',
          description: 'Designer asks before producing the document.',
          position: { x: 560, y: 160 },
        },
        {
          id: 'review_design',
          kind: 'review',
          title: 'Review design',
          description: '',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
          rollbackFilesOnReject: false,
          rollbackFilesOnIterate: false,
          position: { x: 640, y: 0 },
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [{ name: 'doc', bind: { nodeId: 'review_design', portName: 'approved_doc' } }],
          position: { x: 960, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_in_designer',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
        {
          id: 'e_clarify_ask',
          source: { nodeId: 'designer', portName: '__clarify__' },
          target: { nodeId: 'clarify_1', portName: 'questions' },
        },
        {
          id: 'e_clarify_answer',
          source: { nodeId: 'clarify_1', portName: 'answers' },
          target: { nodeId: 'designer', portName: '__clarify_response__' },
        },
        {
          id: 'e_designer_review',
          source: { nodeId: 'designer', portName: 'design' },
          target: { nodeId: 'review_design', portName: '__review_input__' },
        },
        {
          id: 'e_review_output',
          source: { nodeId: 'review_design', portName: 'approved_doc' },
          target: { nodeId: 'out_1', portName: 'doc' },
        },
      ],
    },
  })) as { id: string }

  const task = (await postJson('/api/tasks', {
    workflowId: workflow.id,
    name: 'RFC-250 checkout decision',
    repoUrl: pathToFileURL(repoDir).href,
    ref: 'main',
    inputs: { topic: 'durable checkout state' },
  })) as { id: string }
  await waitForTaskStatus(task.id, 'awaiting_human')

  const d = requireDaemon()
  const response = await fetch(
    `${d.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
    { headers: { Authorization: `Bearer ${d.token}` } },
  )
  if (!response.ok) throw new Error(`RFC-250 clarify list fixture failed: ${response.status}`)
  const sessions = (await response.json()) as Array<{ intermediaryNodeRunId: string }>
  const nodeRunId = sessions[0]?.intermediaryNodeRunId
  if (nodeRunId === undefined) throw new Error('RFC-250 clarify fixture produced no session')
  return nodeRunId
}

async function openDirtyTaskWizard(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  const agentId = await createAgent(`rfc250-wizard-${viewport.width}`)
  await primePage(page, viewport)
  await page.goto(`${requireDaemon().baseUrl}/tasks/new?kind=agent&agentId=${agentId}`)
  await expect(page.getByTestId('task-wizard')).toBeVisible()
  await page.getByTestId('wizard-space-scratch').click()
  await page.getByTestId('stepper-next').click()
  await page.getByTestId('wizard-task-name').fill('Recover customer rollout checklist')
  await page
    .getByTestId('wizard-description')
    .fill('Keep this detailed draft intact while I inspect another task.')

  await expect
    .poll(() =>
      page.evaluate(
        (prefix) => Object.keys(window.sessionStorage).some((key) => key.startsWith(prefix)),
        TASK_WIZARD_DRAFT_PREFIX,
      ),
    )
    .toBe(true)

  if (viewport.width <= 900) {
    await page.getByTestId('mobile-menu-trigger').click()
    const nav = page.getByTestId('shell-navigation-mobile')
    await expect(nav).toBeVisible()
    await nav.locator('a[href="/tasks"]').click()
  } else {
    await page.getByTestId('shell-navigation-desktop').locator('a[href="/tasks"]').click()
  }
  await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()
  await expect(page.getByTestId('unsaved-stay')).toBeFocused()
}

test.describe('RFC-250 §12.3 high-risk visual states', () => {
  test.skip(!RUN_VISUAL_REGRESSION, 'RFC-250 snapshots are gated by RUN_VISUAL_REGRESSION=1')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)

  test.beforeEach(async ({ page: _page }, testInfo) => {
    ownedTempDirs = []
    if (testInfo.title.includes('Clarify local-only')) {
      const stubState = mkdtempSync(join(tmpdir(), 'aw-rfc250-visual-clarify-state-'))
      ownedTempDirs.push(stubState)
      daemon = await startDaemon({
        stubOpencode: stubClarify,
        extraEnv: { CLARIFY_STUB_STATE: stubState },
      })
      return
    }
    daemon = await startDaemon()
  })

  test.afterEach(async () => {
    const active = daemon
    daemon = undefined
    if (active !== undefined) await active.stop()
    for (const path of ownedTempDirs) rmSync(path, { recursive: true, force: true })
    ownedTempDirs = []
  })

  test('PAT permission matrix · 390', async ({ page }) => {
    await primePage(page, { width: 390, height: 844 })
    await page.goto(`${requireDaemon().baseUrl}/account?section=tokens`)
    const panel = page.locator(
      'section.account-section-panel[aria-labelledby="account-section-title-tokens"]',
    )
    await expect(panel).toBeVisible()
    await panel.getByTestId('token-create-open').click()
    await page.getByTestId('token-template-full').click()
    await page.getByTestId('token-advanced-toggle').click()
    const dialog = page.getByTestId('token-create-dialog')
    await expect(dialog.locator('.token-matrix')).toBeVisible()
    await expect(dialog).toHaveScreenshot('pat-permission-matrix-390.png', COMPONENT_SNAPSHOT_OPTS)
  })

  test('PAT masked reveal', async ({ page }) => {
    await primePage(page)
    await page.goto(`${requireDaemon().baseUrl}/account?section=tokens`)
    await page.getByTestId('token-create-open').click()
    await page.getByTestId('token-create-name').fill('RFC-250 release automation')
    await page.getByTestId('token-template-task-automation').click()
    await page.getByTestId('token-create-confirm').click()
    const dialog = page.getByTestId('token-created-dialog')
    const rawToken = page.getByTestId('token-created-value')
    await expect(dialog).toBeVisible()
    await expect(rawToken).toHaveText(/\S+/)
    await expect(page.getByTestId('token-created-refreshing')).toBeHidden()
    await expect(dialog).toHaveScreenshot('pat-reveal-masked.png', {
      ...COMPONENT_SNAPSHOT_OPTS,
      mask: [rawToken],
    })
  })

  test('Task Wizard dirty dialog · desktop', async ({ page }) => {
    await openDirtyTaskWizard(page, { width: 1280, height: 800 })
    await waitForStableDesktopShell(page)
    await expect(page).toHaveScreenshot('task-wizard-dirty-desktop.png', SNAPSHOT_OPTS)
  })

  test('Task Wizard dirty dialog · 390', async ({ page }) => {
    await openDirtyTaskWizard(page, { width: 390, height: 844 })
    await expect(page).toHaveScreenshot('task-wizard-dirty-390.png', SNAPSHOT_OPTS)
  })

  test('complex Workflow readable camera', async ({ page }) => {
    await openComplexWorkflow(page)
    await expect(page).toHaveScreenshot('workflow-complex-readable.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('complex Workflow explicit overview', async ({ page }) => {
    const canvas = await openComplexWorkflow(page)
    await page.getByTestId('workflow-camera-overview').click()
    await expect(canvas).toHaveAttribute('data-camera-mode', 'overview')
    await expect(page.getByTestId('workflow-camera-readable')).toBeVisible()
    await expect(page).toHaveScreenshot('workflow-complex-overview.png', {
      ...SNAPSHOT_OPTS,
      mask: [page.locator('.page--editor .page__meta code')],
    })
  })

  test('Clarify local-only draft', async ({ page }) => {
    const nodeRunId = await seedClarifySession()
    await page.route(`**/api/clarify/${nodeRunId}/draft`, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'rfc250-visual-draft-sync-unavailable',
          message: 'The shared draft service is temporarily unavailable.',
        }),
      })
    })
    await primePage(page, { width: 1280, height: 900 })
    await page.goto(`${requireDaemon().baseUrl}/clarify/${nodeRunId}`)
    await expect(page.getByTestId('clarify-detail-page')).toBeVisible()
    await page.getByRole('radio', { name: 'Postgres' }).click()
    await expect(page.getByTestId('clarify-draft-local-only')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
      'data-draft-status',
      'local-only',
    )
    await waitForStableDesktopShell(page)
    const main = page.getByTestId('app-shell-main')
    await main.evaluate((element) => element.scrollTo({ top: 0, left: 0 }))
    await expect(main).toHaveScreenshot('clarify-draft-local-only.png', COMPONENT_SNAPSHOT_OPTS)
  })

  test('Changes grouped sidebar', async ({ page }) => {
    const taskId = await seedGitTask()
    await page.route(`**/api/tasks/${taskId}/diff`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          diff: CHANGES_DIFF,
          baseCommit: '1111111111111111111111111111111111111111',
          truncated: false,
        }),
      })
    })
    await page.route(`**/api/tasks/${taskId}/structural-diff?*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(changesStructuralFixture(taskId)),
      })
    })
    await page.route(`**/api/tasks/${taskId}/change-narrative`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'narrative-not-found', message: 'No narrative yet.' }),
      })
    })
    await primePage(page)
    await page.goto(`${requireDaemon().baseUrl}/tasks/${taskId}?tab=changes`)
    const panel = page.getByTestId('change-review')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('change-group')).toHaveCount(3)
    await expect(panel).toHaveScreenshot('changes-grouped-sidebar.png', COMPONENT_SNAPSHOT_OPTS)
  })

  test('Agent resource-integrity blocker', async ({ page }) => {
    const agentId = await createAgent('rfc250-blocker-agent')
    await page.route(
      (url) => url.pathname === `/api/agents/${agentId}/resource-status`,
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            references: [],
            issues: [
              {
                code: 'resource-missing',
                refKind: 'skill',
                state: 'missing',
                refId: 'skill-release-readiness',
                refName: null,
                ownerAgentId: null,
                ownerAgentName: null,
                direct: true,
              },
            ],
          }),
        })
      },
    )
    await primePage(page)
    await page.goto(`${requireDaemon().baseUrl}/agents/${agentId}`)
    await page.getByTestId('agent-tab-resources').click()
    const blocker = page.getByTestId('agent-resource-integrity-error')
    await expect(blocker).toBeVisible()
    await expect(blocker).toHaveAttribute('role', 'alert')
    await waitForStableDesktopShell(page)
    await expect(page).toHaveScreenshot('agent-resource-integrity-error.png', SNAPSHOT_OPTS)
  })
})

const declaredRfc250VisualSceneCount = (
  readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/^\s{2}test\(/gm) ?? []
).length
if (declaredRfc250VisualSceneCount !== EXPECTED_RFC250_VISUAL_SCENE_COUNT) {
  throw new Error(
    `RFC-250 visual states: expected ${EXPECTED_RFC250_VISUAL_SCENE_COUNT} scenes, declared ${declaredRfc250VisualSceneCount}`,
  )
}
