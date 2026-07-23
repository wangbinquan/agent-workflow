// RFC-054 W1-4 — task lifecycle-states e2e.
//
// LOCKS: each of the 7 reachable task.status values has at least one
// proof-by-example end-to-end path with a triple-layer assertion:
//   - API:  GET /api/tasks/:id status (definitive)
//   - WS:   page captured a `task.status` frame from /ws/tasks (broadcast layer)
//   - UI:   status-chip on /tasks/:id renders the expected status text
//
// Coverage: running / done / failed / canceled / interrupted / awaiting_review /
// awaiting_human.
//
// `pending` is intentionally excluded — the dispatch window between INSERT
// and runner pick-up is <100ms on every machine we've measured (scheduler
// kicks synchronously inside `startTask`). Race-y to capture in e2e; the
// pending shape is exercised exhaustively by service-layer tests instead
// (scheduler.test.ts, transition-cas-route-409.test.ts, lifecycle property).

import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
const SLOW_STUB = resolve(here, 'fixtures', 'stub-opencode-slow.sh')
const CLARIFY_STUB = resolve(here, 'fixtures', 'stub-opencode-clarify.sh')

// Each case rebuilds its own daemon + fixture repo + AGENT_WORKFLOW_HOME for
// isolation. Serial mode is for port allocation hygiene only.
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

// ----------------------------------------------------------------------------
// Helpers — repo / workflow / task seeding.
// ----------------------------------------------------------------------------

interface RepoFixture {
  repoDir: string
  cleanup: () => void
}

function makeFixtureRepo(): RepoFixture {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-lifecycle-'))
  writeFileSync(join(repoDir, 'README.md'), '# lifecycle fixture repo\n', 'utf-8')
  initGitRepo(repoDir)
  return {
    repoDir,
    cleanup: () => {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

interface BasicFixtures {
  agentName: string
  workflowId: string
}

/** Minimal linear workflow: input → agent-single → output. */
async function seedLinearWorkflow(
  daemon: DaemonHandle,
  opts: { agentName: string; nodeRetries?: number; outputs?: string[] } = {
    agentName: 'lifecycle-agent',
  },
): Promise<BasicFixtures> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const outputs = opts.outputs ?? ['answer']
  const aRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: opts.agentName,
      description: 'lifecycle-states e2e stub',
      outputs,
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!aRes.ok) throw new Error(`seed agent: ${aRes.status}`)
  const agent = (await aRes.json()) as { id: string }

  const agentNodeOverrides: Record<string, unknown> = {}
  if (opts.nodeRetries !== undefined) agentNodeOverrides.retries = opts.nodeRetries

  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `lifecycle-${opts.agentName}`,
      description: 'lifecycle-states e2e workflow',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: opts.agentName,
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
            ...agentNodeOverrides,
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: outputs[0]!, bind: { nodeId: 'agent_1', portName: outputs[0]! } }],
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
            source: { nodeId: 'agent_1', portName: outputs[0]! },
            target: { nodeId: 'out_1', portName: outputs[0]! },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seed workflow: ${wfRes.status} ${await wfRes.text()}`)
  const wf = (await wfRes.json()) as { id: string }
  return { agentName: opts.agentName, workflowId: wf.id }
}

/** Linear + review workflow: input → agent → review → output. */
async function seedReviewWorkflow(
  daemon: DaemonHandle,
  agentName = 'lifecycle-agent-review',
): Promise<BasicFixtures> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  // review node validator requires the upstream port to be declared as
  // markdown (or markdown_file). Add outputKinds so static validation
  // passes; the stub envelope content is plain text that still parses as
  // trivial markdown.
  const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'lifecycle-states review e2e',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!agentRes.ok) throw new Error(`seed review agent: ${agentRes.status}`)
  const agent = (await agentRes.json()) as { id: string }
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `lifecycle-${agentName}`,
      description: 'lifecycle-states review e2e workflow',
      definition: {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
          },
          {
            id: 'review_1',
            kind: 'review',
            title: 'lifecycle review',
            description: '',
            inputSource: { nodeId: 'agent_1', portName: 'answer' },
            rerunnableOnReject: [],
            rerunnableOnIterate: [],
            rollbackFilesOnReject: false,
            rollbackFilesOnIterate: false,
            position: { x: 640, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'doc', bind: { nodeId: 'review_1', portName: 'approved_doc' } }],
            position: { x: 960, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_agent',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e_agent_review',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'review_1', portName: '__review_input__' },
          },
          {
            id: 'e_review_out',
            source: { nodeId: 'review_1', portName: 'approved_doc' },
            target: { nodeId: 'out_1', portName: 'doc' },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seed review workflow: ${wfRes.status}`)
  const wf = (await wfRes.json()) as { id: string }
  return { agentName, workflowId: wf.id }
}

/** Linear + clarify workflow: input → agent-with-clarify-ports → clarify_1 → output. */
async function seedClarifyWorkflow(daemon: DaemonHandle): Promise<BasicFixtures> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'lifecycle-agent-clarify'
  const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'lifecycle-states clarify e2e',
      outputs: ['design'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!agentRes.ok) throw new Error(`seed clarify agent: ${agentRes.status}`)
  const agent = (await agentRes.json()) as { id: string }
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'lifecycle-clarify',
      description: 'lifecycle-states clarify e2e workflow',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
            promptTemplate: '{{topic}}',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'lifecycle clarify',
            description: '',
            position: { x: 560, y: 160 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'doc', bind: { nodeId: 'designer', portName: 'design' } }],
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
            id: 'e_clarify_ans',
            source: { nodeId: 'clarify_1', portName: 'answers' },
            target: { nodeId: 'designer', portName: '__clarify_response__' },
          },
          {
            id: 'e_designer_out',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'out_1', portName: 'doc' },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seed clarify workflow: ${wfRes.status} ${await wfRes.text()}`)
  const wf = (await wfRes.json()) as { id: string }
  return { agentName, workflowId: wf.id }
}

async function launchTask(
  daemon: DaemonHandle,
  workflowId: string,
  repoPath: string,
  name = 'lifecycle-task',
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflowId,
      name,
      inputs: { topic: 'lifecycle-test' },
      repoUrl: pathToFileURL(repoPath).href,
      ref: 'main',
    }),
  })
  if (!res.ok) {
    throw new Error(`launchTask: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { id: string }
  return body.id
}

async function getTaskStatus(daemon: DaemonHandle, taskId: string): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  if (!res.ok) throw new Error(`getTaskStatus ${taskId}: ${res.status}`)
  const body = (await res.json()) as { status: string }
  return body.status
}

async function waitForStatus(
  daemon: DaemonHandle,
  taskId: string,
  predicate: (status: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await getTaskStatus(daemon, taskId)
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`waitForStatus(${label}) timed out after ${timeoutMs}ms; last=${last}`)
}

async function primeAuthLocalStorage(page: Page, daemon: DaemonHandle): Promise<void> {
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

// ----------------------------------------------------------------------------
// WS frame recorder — attach to a Playwright Page and accumulate any
// `task.status` frames into a Map<taskId, Set<status>>. The /ws/tasks list
// channel broadcasts `{type: 'task.status', taskId, status}` for every state
// change; the per-task channel broadcasts a similar shape (no `taskId`
// field). We accept both.
// ----------------------------------------------------------------------------

function attachWsTaskStatusRecorder(page: Page): {
  /** Statuses observed per taskId from any captured WS frame. */
  statusesFor: (taskId: string) => Set<string>
  /** All captured frame payloads (for debugging). */
  rawFrames: () => string[]
} {
  const byTaskId = new Map<string, Set<string>>()
  const raw: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      const payload = frame.payload as string
      raw.push(payload)
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>
        if (obj.type !== 'task.status') return
        const taskId = typeof obj.taskId === 'string' ? obj.taskId : undefined
        const status = typeof obj.status === 'string' ? obj.status : undefined
        if (taskId === undefined || status === undefined) return
        let s = byTaskId.get(taskId)
        if (!s) {
          s = new Set()
          byTaskId.set(taskId, s)
        }
        s.add(status)
      } catch {
        /* not JSON, ignore */
      }
    })
  })
  return {
    statusesFor: (taskId: string) => byTaskId.get(taskId) ?? new Set(),
    rawFrames: () => raw,
  }
}

/** Poll until the WS frame buffer contains the expected status for this taskId. */
async function waitForWsStatus(
  rec: { statusesFor: (taskId: string) => Set<string> },
  taskId: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (rec.statusesFor(taskId).has(expected)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `waitForWsStatus(${taskId}, ${expected}) timed out after ${timeoutMs}ms; ` +
      `seen=[${[...rec.statusesFor(taskId)].join(',')}]`,
  )
}

// ----------------------------------------------------------------------------
// 7 cases. Each builds its own daemon + repo so failures are isolated.
// ----------------------------------------------------------------------------

// LOCKS: task-state-running — scheduler dispatch flips pending → running and
// emits `task.status` over WS while the agent process is alive.
test('task lifecycle: running (slow stub + dispatch)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '20000' },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    // Open /tasks first to establish the /ws/tasks subscription BEFORE
    // launching the task. The list channel broadcasts task.status for
    // every state change so we catch the initial pending → running flip.
    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible({
      timeout: 10_000,
    })

    const fixtures = await seedLinearWorkflow(daemon, { agentName: 'lifecycle-running' })
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)

    // API layer.
    await waitForStatus(daemon, taskId, (s) => s === 'running', 10_000, 'running-api')
    // WS layer.
    await waitForWsStatus(rec, taskId, 'running', 5_000)
    // UI layer.
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.locator('.status-chip', { hasText: /^running$/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: task-state-done — happy path with fast stub; final terminal status.
test('task lifecycle: done (fast stub happy path)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible({
      timeout: 10_000,
    })

    const fixtures = await seedLinearWorkflow(daemon, { agentName: 'lifecycle-done' })
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)

    await waitForStatus(daemon, taskId, (s) => s === 'done', 30_000, 'done-api')
    await waitForWsStatus(rec, taskId, 'done', 5_000)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.locator('.status-chip', { hasText: /^done$/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: task-state-failed — agent exits non-zero with no retries → task=failed.
test('task lifecycle: failed (stub exit 1, retries=0)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0', STUB_OPENCODE_EXIT_CODE: '1' },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)

    const fixtures = await seedLinearWorkflow(daemon, {
      agentName: 'lifecycle-failed',
      nodeRetries: 0,
    })
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)

    await waitForStatus(daemon, taskId, (s) => s === 'failed', 30_000, 'failed-api')
    await waitForWsStatus(rec, taskId, 'failed', 5_000)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.locator('.status-chip', { hasText: /^failed$/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: task-state-canceled — POST /cancel during running flips → canceled.
test('task lifecycle: canceled (POST /api/tasks/:id/cancel mid-running)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '20000' },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)

    const fixtures = await seedLinearWorkflow(daemon, { agentName: 'lifecycle-canceled' })
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)
    await waitForStatus(daemon, taskId, (s) => s === 'running', 10_000, 'running-precancel')

    const cancelRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expect(cancelRes.ok).toBe(true)

    await waitForStatus(daemon, taskId, (s) => s === 'canceled', 15_000, 'canceled-api')
    await waitForWsStatus(rec, taskId, 'canceled', 5_000)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    await expect(page.locator('.status-chip', { hasText: /^canceled$/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: task-state-interrupted — SIGKILL daemon mid-task + reboot reaps to
// interrupted. NOTE: WS event for the interrupted transition is NOT broadcast
// (orphans.ts updates the DB row directly without calling emitTaskStatus), so
// this case verifies API + UI only. If a future refactor adds the broadcast,
// add a `waitForWsStatus(rec, taskId, 'interrupted')` here.
test('task lifecycle: interrupted (SIGKILL → restart → orphan reap)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemonA = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '20000' },
  })
  const home = daemonA.home
  try {
    const fixtures = await seedLinearWorkflow(daemonA, { agentName: 'lifecycle-interrupted' })
    const taskId = await launchTask(daemonA, fixtures.workflowId, repo.repoDir)
    await waitForStatus(daemonA, taskId, (s) => s === 'running', 10_000, 'A-running-int')

    await daemonA.killChild('SIGKILL')

    const daemonB = await startDaemon({
      home,
      stubOpencode: SLOW_STUB,
      extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
    })
    try {
      await primeAuthLocalStorage(page, daemonB)
      // Orphan reap runs at boot synchronously; by the time daemonB returns
      // ready the row is already 'interrupted'.
      expect(await getTaskStatus(daemonB, taskId)).toBe('interrupted')

      await page.goto(`${daemonB.baseUrl}/tasks/${taskId}`)
      await expect(page.locator('.status-chip', { hasText: /^interrupted$/i }).first()).toBeVisible(
        { timeout: 15_000 },
      )
    } finally {
      await daemonB.stop()
    }
  } finally {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    repo.cleanup()
  }
})

// LOCKS: task-state-awaiting_review — agent completes, review node creates
// doc_version v1, task transitions to awaiting_review.
test('task lifecycle: awaiting_review (agent → review node)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({
    stubOpencode: SLOW_STUB,
    extraEnv: { STUB_OPENCODE_SLEEP_MS: '0' },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)

    const fixtures = await seedReviewWorkflow(daemon)
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)

    await waitForStatus(
      daemon,
      taskId,
      (s) => s === 'awaiting_review',
      20_000,
      'awaiting_review-api',
    )
    await waitForWsStatus(rec, taskId, 'awaiting_review', 5_000)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    // i18n en-US task status chip for awaiting_review = "Awaiting review".
    await expect(
      page.locator('.status-chip', { hasText: /^Awaiting review$/i }).first(),
    ).toBeVisible({ timeout: 15_000 })
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: task-state-awaiting_human — clarify-aware agent emits <workflow-
// clarify>, clarify node parks awaiting user answers, task transitions to
// awaiting_human.
test('task lifecycle: awaiting_human (clarify stub asks question)', async ({ page }) => {
  const repo = makeFixtureRepo()
  const clarifyState = mkdtempSync(join(tmpdir(), 'aw-e2e-clarify-state-'))
  const daemon = await startDaemon({
    stubOpencode: CLARIFY_STUB,
    extraEnv: { CLARIFY_STUB_STATE: clarifyState },
  })
  try {
    const rec = attachWsTaskStatusRecorder(page)
    await primeAuthLocalStorage(page, daemon)
    await page.goto(`${daemon.baseUrl}/tasks`)

    const fixtures = await seedClarifyWorkflow(daemon)
    const taskId = await launchTask(daemon, fixtures.workflowId, repo.repoDir)

    await waitForStatus(daemon, taskId, (s) => s === 'awaiting_human', 20_000, 'awaiting_human-api')
    await waitForWsStatus(rec, taskId, 'awaiting_human', 5_000)
    await page.goto(`${daemon.baseUrl}/tasks/${taskId}`)
    // i18n en-US task status chip for awaiting_human = "Awaiting input"
    // (the node-level chip is "Awaiting answer"; either may surface
    // depending on the page section — accept both).
    await expect(
      page.locator('.status-chip', { hasText: /Awaiting (input|answer)/i }).first(),
    ).toBeVisible({ timeout: 15_000 })
  } finally {
    await daemon.stop()
    try {
      rmSync(clarifyState, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    repo.cleanup()
  }
})
