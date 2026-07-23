// RFC-054 W1-5 — cross-user / role-based authorization isolation e2e.
//
// LOCKS: Tasks owned by user A must not be visible to unrelated user B
// (canViewTask gate in /api/tasks/:id); admin-only endpoints must reject
// regular users (resourcePermissionGate / requirePermission); RFC-221 must
// keep PAT creation disabled. A regression in any of these means user A's
// data leaks to user B without the user reporting it — the kind of silent
// breakage W1-5 exists to catch.
//
// This suite covers the `admin` × `user` authorization matrix. RFC-222's
// `manager` role has its own focused coverage.
// - admin: all PERMISSIONS (incl. `tasks:read:all`, `settings:write`,
//          `users:write`).
// - user:  USER_BASELINE (account:self, tasks:read:own, agents/workflows
//          read+write but NOT settings or users management).
//
// The "developer / viewer" roles named in the RFC-054 plan don't exist in
// the schema; we cover the actual `admin` × `user` matrix here instead.
//
// 7 cases, each rebuilds its own daemon for full isolation:
//
//   1. regular bob can NOT see admin alice's task             → 403 task-not-visible
//   2. admin alice CAN see regular bob's task                 → 200 (tasks:read:all)
//   3. regular bob can NOT see another regular carol's task   → 403 task-not-visible
//   4. regular bob CAN see own task (control / sanity)        → 200
//   5. regular bob can NOT GET /api/config                    → 403 forbidden
//   6. regular bob can NOT POST /api/users                    → 403 forbidden
//   7. PAT creation remains disabled                          → 403 pat-creation-disabled

import { test, expect } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo } from './command'

const here = dirname(fileURLToPath(import.meta.url))
const FAST_STUB = resolve(here, 'fixtures', 'stub-opencode.sh')

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

// ----------------------------------------------------------------------------
// User helper: POST /api/users via daemon token + POST /api/auth/login to
// obtain a real session token. The daemon token actor is `__system__`/admin,
// so it can create users for us. Login returns a `sessionToken` plus the
// canonical user row.
// ----------------------------------------------------------------------------

interface SeededUser {
  username: string
  password: string
  role: 'admin' | 'user'
  sessionToken: string
  userId: string
}

async function createUserAndLogin(
  daemon: DaemonHandle,
  opts: { username: string; password: string; role: 'admin' | 'user' },
): Promise<SeededUser> {
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
    throw new Error(
      `createUser ${opts.username}: ${createRes.status} ${await createRes.text().catch(() => '')}`,
    )
  }
  const created = (await createRes.json()) as { id: string }

  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  if (!loginRes.ok) {
    throw new Error(`login ${opts.username}: ${loginRes.status}`)
  }
  const loginBody = (await loginRes.json()) as { sessionToken: string }
  return {
    username: opts.username,
    password: opts.password,
    role: opts.role,
    userId: created.id,
    sessionToken: loginBody.sessionToken,
  }
}

interface RepoFixture {
  repoDir: string
  cleanup: () => void
}

function makeFixtureRepo(): RepoFixture {
  const repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-auth-'))
  writeFileSync(join(repoDir, 'README.md'), '# auth isolation fixture\n', 'utf-8')
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

interface WorkflowFixture {
  agentName: string
  workflowId: string
}

/** Seed an agent + minimal linear workflow via daemon token (admin). */
async function seedWorkflow(daemon: DaemonHandle): Promise<WorkflowFixture> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'auth-isolation-agent'
  const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: agentName,
      description: 'auth-isolation e2e stub',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
  if (!agentRes.ok) throw new Error(`seed agent: ${agentRes.status}`)
  const agent = (await agentRes.json()) as { id: string }
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'auth-isolation-wf',
      description: 'auth-isolation e2e',
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
            promptTemplate: '{{topic}}',
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
  if (!wfRes.ok) throw new Error(`seed workflow: ${wfRes.status}`)
  const wf = (await wfRes.json()) as { id: string }
  return { agentName, workflowId: wf.id }
}

async function launchTaskAs(
  daemon: DaemonHandle,
  sessionToken: string,
  workflowId: string,
  repoPath: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflowId,
      name,
      inputs: { topic: 'auth-isolation' },
      repoUrl: pathToFileURL(repoPath).href,
      ref: 'main',
    }),
  })
  if (!res.ok) {
    throw new Error(`launchTaskAs ${name}: ${res.status} ${await res.text().catch(() => '')}`)
  }
  const body = (await res.json()) as { id: string }
  return body.id
}

async function getTaskAs(
  daemon: DaemonHandle,
  sessionToken: string,
  taskId: string,
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })
}

// ----------------------------------------------------------------------------
// Cases
// ----------------------------------------------------------------------------

// LOCKS: cross-user task visibility (the headline canViewTask gate).
test("regular bob can NOT see admin alice's task → 403 task-not-visible", async () => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const alice = await createUserAndLogin(daemon, {
      username: 'alice',
      password: 'AlicePassword123',
      role: 'admin',
    })
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const wf = await seedWorkflow(daemon)
    const aliceTask = await launchTaskAs(
      daemon,
      alice.sessionToken,
      wf.workflowId,
      repo.repoDir,
      'alice-task',
    )

    const res = await getTaskAs(daemon, bob.sessionToken, aliceTask)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { ok: false; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('task-not-visible')
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: admin sees all (tasks:read:all permission grants cross-user view).
test("admin alice CAN see regular bob's task → 200", async () => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const alice = await createUserAndLogin(daemon, {
      username: 'alice',
      password: 'AlicePassword123',
      role: 'admin',
    })
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const wf = await seedWorkflow(daemon)
    const bobTask = await launchTaskAs(
      daemon,
      bob.sessionToken,
      wf.workflowId,
      repo.repoDir,
      'bob-task',
    )

    const res = await getTaskAs(daemon, alice.sessionToken, bobTask)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.id).toBe(bobTask)
    expect(body.name).toBe('bob-task')
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: cross-regular task visibility (no leakage between same-role users).
test("regular bob can NOT see another regular carol's task → 403", async () => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const carol = await createUserAndLogin(daemon, {
      username: 'carol',
      password: 'CarolPassword123',
      role: 'user',
    })
    const wf = await seedWorkflow(daemon)
    const carolTask = await launchTaskAs(
      daemon,
      carol.sessionToken,
      wf.workflowId,
      repo.repoDir,
      'carol-task',
    )

    const res = await getTaskAs(daemon, bob.sessionToken, carolTask)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-not-visible')
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: own-task visibility (control case — proves the deny path is
// targeted, not a daemon-wide block on every regular user).
test('regular bob CAN see own task → 200 (control)', async () => {
  const repo = makeFixtureRepo()
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const wf = await seedWorkflow(daemon)
    const bobTask = await launchTaskAs(
      daemon,
      bob.sessionToken,
      wf.workflowId,
      repo.repoDir,
      'bob-own-task',
    )

    const res = await getTaskAs(daemon, bob.sessionToken, bobTask)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe(bobTask)
  } finally {
    await daemon.stop()
    repo.cleanup()
  }
})

// LOCKS: admin-only /api/config (settings:read missing on user baseline).
test('regular bob can NOT GET /api/config → 403 forbidden', async () => {
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const res = await fetch(`${daemon.baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${bob.sessionToken}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('forbidden')

    // Sanity counter-check: admin alice CAN read /api/config.
    const alice = await createUserAndLogin(daemon, {
      username: 'alice',
      password: 'AlicePassword123',
      role: 'admin',
    })
    const aliceRes = await fetch(`${daemon.baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${alice.sessionToken}` },
    })
    expect(aliceRes.status).toBe(200)
  } finally {
    await daemon.stop()
  }
})

// LOCKS: admin-only users management (users:write missing on user baseline).
test('regular bob can NOT POST /api/users → 403 forbidden', async () => {
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const bob = await createUserAndLogin(daemon, {
      username: 'bob',
      password: 'BobPassword123',
      role: 'user',
    })
    const res = await fetch(`${daemon.baseUrl}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'mallory',
        displayName: 'Mallory',
        role: 'admin',
        password: 'MalloryPassword123',
      }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('forbidden')
  } finally {
    await daemon.stop()
  }
})

// RFC-221: existing PATs remain revocable, but no browser/session actor may
// mint a new credential. Store-level revocation remains covered by backend
// route and persistence tests.
test('PAT creation remains disabled → 403 pat-creation-disabled', async () => {
  const daemon = await startDaemon({ stubOpencode: FAST_STUB })
  try {
    const alice = await createUserAndLogin(daemon, {
      username: 'alice',
      password: 'AlicePassword123',
      role: 'admin',
    })

    const mintRes = await fetch(`${daemon.baseUrl}/api/auth/pats`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'auth-isolation-pat' }),
    })
    expect(mintRes.status).toBe(403)
    const body = (await mintRes.json()) as { code: string }
    expect(body.code).toBe('pat-creation-disabled')
  } finally {
    await daemon.stop()
  }
})
