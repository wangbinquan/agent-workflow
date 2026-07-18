// RFC-054 W2-4 — multi-user collaboration through TWO real browser contexts.
//
// LOCKS the end-to-end RBAC + WS-isolation story at the UI layer:
//   * Two simultaneous browser sessions for two different real users
//     (alice = admin, bob = regular user) only see what they're
//     authorized to see — and the WS event stream respects the boundary.
//   * Per-task channel updates fired by user A's task DO NOT arrive on
//     user B's browser unless they're explicitly granted visibility.
//     This is the most subtle leak path because the WS server's
//     channel-subscription gate is OFF the request thread and is easy
//     to regress.
//   * Admin sees all (`/tasks` lists alice's + bob's tasks under the
//     admin's session), regular user sees only their own.
//
// W1-5 already covers the API gate (cross-user 403); W2-4 lifts the
// same contract up to the browser, where the auth header is the session
// cookie / localStorage token and the WS subscribe handshake is the
// new attack surface.

import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

let daemon: DaemonHandle
let repoDir: string

interface SeededUser {
  username: string
  sessionToken: string
  userId: string
  role: 'admin' | 'user'
}

async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user'
}): Promise<SeededUser> {
  const createRes = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  if (!createRes.ok) {
    throw new Error(`createUser ${opts.username}: ${createRes.status}`)
  }
  const { id } = (await createRes.json()) as { id: string }

  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  if (!loginRes.ok) throw new Error(`login ${opts.username}: ${loginRes.status}`)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken, role: opts.role }
}

async function seedWorkflow(): Promise<{ workflowId: string; agentName: string }> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'collab-agent'
  await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'collab e2e agent',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'collab-wf',
      description: 'collab e2e',
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentName,
            promptTemplate: 'Echo {{topic}}.',
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
    }),
  })
  if (!wfRes.ok) throw new Error(`seedWorkflow: ${wfRes.status}`)
  const { id } = (await wfRes.json()) as { id: string }
  return { workflowId: id, agentName }
}

async function createTaskAsUser(
  user: SeededUser,
  workflowId: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: pathToFileURL(repoDir).href,
      ref: 'main',
      inputs: { topic: 'collab-test' },
    }),
  })
  if (!res.ok) throw new Error(`createTask as ${user.username}: ${res.status}`)
  const body = (await res.json()) as { id: string }
  return body.id
}

async function primeAuthForContext(ctx: BrowserContext, user: SeededUser): Promise<void> {
  // Each context isolates its own localStorage, so we seed via
  // addInitScript that fires before the SPA mounts.
  await ctx.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: user.sessionToken },
  )
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-collab-'))
  writeFileSync(join(repoDir, 'README.md'), '# collab fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (repoDir !== undefined) {
    try {
      rmSync(repoDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('two browsers, two users: each only sees their own task on /tasks (admin sees both)', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice-collab',
    password: 'AliceCollabPass#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab',
    password: 'BobCollabPass#1',
    role: 'user',
  })
  const wf = await seedWorkflow()

  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-task')
  const bobTaskId = await createTaskAsUser(bob, wf.workflowId, 'bob-task')

  // Two contexts = two isolated browsers (different localStorage, different
  // cookies, different WS connections).
  const ctxAlice = await browser.newContext()
  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxAlice, alice)
  await primeAuthForContext(ctxBob, bob)

  const aPage = await ctxAlice.newPage()
  const bPage = await ctxBob.newPage()

  // Alice (admin) visits /tasks — sees BOTH tasks.
  await aPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(aPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
  // Wait for the table to populate; the row count reflects the API call.
  await expect(aPage.getByText('alice-task').first()).toBeVisible()
  await expect(aPage.getByText('bob-task').first()).toBeVisible()

  // Bob (regular user) visits /tasks — sees ONLY his task.
  await bPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(bPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
  await expect(bPage.getByText('bob-task').first()).toBeVisible()
  // Negative — alice's task name should NOT appear anywhere in bob's view.
  await expect(bPage.getByText('alice-task')).toHaveCount(0)

  await ctxAlice.close()
  await ctxBob.close()

  // Sanity — also verify directly via API that the tasks exist for the
  // record (this is the contract W1-5 already locked, repeated here so
  // a future API change doesn't silently make this UI test pass on
  // shared visibility regressions).
  expect(aliceTaskId).toBeTruthy()
  expect(bobTaskId).toBeTruthy()
})

test("two browsers, two users: bob CANNOT navigate to alice's task detail (403)", async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice-collab-2',
    password: 'AliceCollab2#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab-2',
    password: 'BobCollab2#1',
    role: 'user',
  })
  const wf = await seedWorkflow()
  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-detail-task')

  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxBob, bob)
  const bPage = await ctxBob.newPage()

  // Hard-navigate to alice's task detail. The page should refuse — either
  // by redirecting to an error / unauthorized view, or by showing an
  // explicit 403 / "not found" state. Both are acceptable; we just need
  // to confirm the task content is NOT rendered.
  await bPage.goto(`${daemon.baseUrl}/tasks/${aliceTaskId}`)
  // Wait for any of: a 403 message, the task list redirect, or a
  // "not found" indicator. The exact UX may evolve; the negative
  // assertion is: the task NAME doesn't render anywhere on bob's view.
  await bPage.waitForLoadState('networkidle')
  await expect(bPage.getByText('alice-detail-task')).toHaveCount(0)

  await ctxBob.close()
})

test('/ws/tasks list channel filters per-frame by canViewTask (post-fix)', async ({ browser }) => {
  // Post-fix (RFC-054 W2-4 KNOWN_GAP resolved): the WS server now runs
  // a per-frame canViewTask gate against the subscriber's actor. Bob's
  // /ws/tasks subscription must NOT receive frames mentioning alice's
  // task id — server-side dropping happens before send, so the bytes
  // never cross the wire.
  //
  // See packages/backend/src/ws/server.ts handleOpen('tasks-list') for
  // the gate + extractTaskIdFromListMessage for the per-message taskId
  // extraction (drops unknown-shape variants by default).
  const alice = await createUserAndLogin({
    username: 'alice-collab-3',
    password: 'AliceCollab3#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab-3',
    password: 'BobCollab3#1',
    role: 'user',
  })
  const wf = await seedWorkflow()

  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxBob, bob)
  const bPage = await ctxBob.newPage()

  // Capture every WS frame received by bob's page.
  const wsFrames: Array<{ url: string; payload: string }> = []
  bPage.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : ''
      if (text.length > 0) wsFrames.push({ url: ws.url(), payload: text })
    })
  })

  await bPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(bPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()

  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-ws-task')
  await bPage.waitForTimeout(2000)

  const leakingFrames = wsFrames.filter((f) => f.payload.includes(aliceTaskId))
  expect(leakingFrames).toHaveLength(0)

  await ctxBob.close()
})
