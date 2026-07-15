// RFC-190 — GET /api/overview (homepage capability portal aggregate).
//
// Why this file exists (design.md §4.1): it locks
//   1. the ORACLE — per actor, every overview count equals the row count the
//      same actor gets from the corresponding LIST endpoint, so the aggregate
//      can never drift from what the list pages show (D1);
//   2. the tasks permission truth table (design gate P1-2): tasks:read:all →
//      unscoped, tasks:read:own → owner∨collaborator, neither → null;
//   3. per-key null gating for coarse-gated resources vs always-numbers for
//      the gate-less workgroups/scheduled keys (D2 / design gate P1-3);
//   4. the fixed-clock 7-day window boundary (D10 / design gate P2-1);
//   5. the response contract (OverviewResponseSchema + generatedAt).

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import {
  OverviewResponseSchema,
  type OverviewResponse,
  type Permission,
} from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  cachedRepos,
  memories,
  scheduledTasks,
  taskCollaborators,
  tasks,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { buildOverview } from '../src/services/overview'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string } // creator / task owner
  bob: { id: string; token: string } // grantee / second owner
  carol: { id: string; token: string } // stranger
  admin: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc190-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  async function mkUser(username: string, role: 'admin' | 'user') {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    db,
    app,
    alice: await mkUser('alice', 'user'),
    bob: await mkUser('bob', 'user'),
    carol: await mkUser('carol', 'user'),
    admin: await mkUser('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function agentBody(name: string) {
  return {
    name,
    description: '',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'noop',
  }
}

async function getOverview(h: Harness, token: string): Promise<OverviewResponse> {
  const res = await req(h.app, token, '/api/overview')
  expect(res.status).toBe(200)
  return OverviewResponseSchema.parse(await res.json())
}

/**
 * Mixed-visibility seed across every countable resource kind:
 * agents ×5 (1 private, 1 private-granted-to-bob), workflows ×2 (1 private),
 * workgroups ×2 (1 private), cached repos ×2 (global), scheduled ×2 (alice/bob
 * owned), memories ×4 (global approved / global candidate / approved on the
 * PRIVATE agent / approved on the PRIVATE workflow).
 */
async function seedResources(h: Harness): Promise<void> {
  for (const name of ['pub-agent', 'priv-agent', 'granted-agent', 'planner-agent', 'coder-a']) {
    const res = await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(agentBody(name)),
    })
    expect(res.status).toBe(201)
  }
  for (const name of ['priv-agent', 'granted-agent']) {
    const res = await req(h.app, h.alice.token, `/api/agents/${name}/acl`, {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(res.status).toBe(200)
  }
  expect(
    (
      await req(h.app, h.alice.token, '/api/agents/granted-agent/acl', {
        method: 'PUT',
        body: JSON.stringify({ userIds: [h.bob.id] }),
      })
    ).status,
  ).toBe(200)

  const mkFlow = async (name: string) => {
    const res = await req(h.app, h.alice.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: '',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }
  await mkFlow('pub-flow')
  const privFlowId = await mkFlow('priv-flow')
  expect(
    (
      await req(h.app, h.alice.token, `/api/workflows/${privFlowId}/acl`, {
        method: 'PUT',
        body: JSON.stringify({ visibility: 'private' }),
      })
    ).status,
  ).toBe(200)

  const wgBody = (name: string) => ({
    name,
    description: 'strike team',
    instructions: 'ship it',
    mode: 'leader_worker',
    leaderDisplayName: 'planner',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    members: [
      { memberType: 'agent', agentName: 'planner-agent', displayName: 'planner', roleDesc: '协调' },
      { memberType: 'agent', agentName: 'coder-a', displayName: 'coder', roleDesc: '实现' },
    ],
  })
  for (const name of ['pub-squad', 'secret-squad']) {
    const res = await req(h.app, h.alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(wgBody(name)),
    })
    expect(res.status).toBe(201)
  }
  expect(
    (
      await req(h.app, h.alice.token, '/api/workgroups/secret-squad/acl', {
        method: 'PUT',
        body: JSON.stringify({ visibility: 'private' }),
      })
    ).status,
  ).toBe(200)

  const now = Date.now()
  await h.db.insert(cachedRepos).values([
    {
      id: 'repo-1',
      urlHash: 'aaaa1111',
      url: 'https://example.com/a.git',
      localPath: '/tmp/aw-repos/a',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    },
    {
      id: 'repo-2',
      urlHash: 'bbbb2222',
      url: 'https://example.com/b.git',
      localPath: '/tmp/aw-repos/b',
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    },
  ])

  await h.db.insert(scheduledTasks).values([
    {
      id: 'sched-alice',
      name: 'alice schedule',
      ownerUserId: h.alice.id,
      launchKind: 'workflow' as const,
      launchPayload: '{}',
      scheduleSpec: JSON.stringify({ kind: 'interval', every: 1, unit: 'hours' }),
      enabled: true,
      nextRunAt: now + 3_600_000,
    },
    {
      id: 'sched-bob',
      name: 'bob schedule',
      ownerUserId: h.bob.id,
      launchKind: 'workflow' as const,
      launchPayload: '{}',
      scheduleSpec: JSON.stringify({ kind: 'interval', every: 1, unit: 'hours' }),
      enabled: true,
      nextRunAt: now + 3_600_000,
    },
  ])

  const privAgentId = (
    (await (await req(h.app, h.alice.token, '/api/agents/priv-agent')).json()) as {
      id: string
    }
  ).id
  await h.db.insert(memories).values([
    {
      id: 'mem-global-approved',
      scopeType: 'global' as const,
      scopeId: null,
      title: 'global fact',
      bodyMd: 'x',
      status: 'approved' as const,
      sourceKind: 'manual' as const,
      createdAt: now,
    },
    {
      id: 'mem-global-candidate',
      scopeType: 'global' as const,
      scopeId: null,
      title: 'pending fact',
      bodyMd: 'x',
      status: 'candidate' as const,
      sourceKind: 'manual' as const,
      createdAt: now,
    },
    {
      id: 'mem-priv-agent',
      scopeType: 'agent' as const,
      scopeId: privAgentId,
      title: 'private-agent fact',
      bodyMd: 'x',
      status: 'approved' as const,
      sourceKind: 'manual' as const,
      createdAt: now,
    },
    {
      id: 'mem-priv-flow',
      scopeType: 'workflow' as const,
      scopeId: privFlowId,
      title: 'private-flow fact',
      bodyMd: 'x',
      status: 'approved' as const,
      sourceKind: 'manual' as const,
      createdAt: now,
    },
  ])
}

function taskRow(
  id: string,
  owner: string,
  status: string,
  opts: { startedAt?: number; finishedAt?: number | null; workflowId?: string } = {},
) {
  return {
    id,
    name: `fixture-${id}`,
    workflowId: opts.workflowId ?? 'wf-ov',
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    repoUrl: null,
    worktreePath: `/tmp/wt-${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    status: status as 'running',
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: opts.startedAt ?? Date.now(),
    finishedAt: opts.finishedAt ?? null,
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    ownerUserId: owner,
  }
}

/**
 * Task fleet (relative to seed-time now):
 *   t1 running (alice) · t2 awaiting_review (alice) · t3 awaiting_human (bob,
 *   alice collaborator) · t4 done@now (alice) · t5 failed@now (alice) ·
 *   t6 done@now-8d (alice, outside window) · t7 done@now (bob, alice NOT a
 *   member) · t8 canceled@now (alice — must count nowhere).
 */
async function seedTasks(h: Harness): Promise<void> {
  const now = Date.now()
  await h.db.insert(workflows).values({
    id: 'wf-ov',
    name: 'wf-ov',
    description: '',
    definition: JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] }),
  })
  await h.db
    .insert(tasks)
    .values([
      taskRow('t1', h.alice.id, 'running'),
      taskRow('t2', h.alice.id, 'awaiting_review'),
      taskRow('t3', h.bob.id, 'awaiting_human'),
      taskRow('t4', h.alice.id, 'done', { finishedAt: now }),
      taskRow('t5', h.alice.id, 'failed', { finishedAt: now }),
      taskRow('t6', h.alice.id, 'done', { finishedAt: now - 8 * 86_400_000 }),
      taskRow('t7', h.bob.id, 'done', { finishedAt: now }),
      taskRow('t8', h.alice.id, 'canceled', { finishedAt: now }),
    ])
  await h.db.insert(taskCollaborators).values([
    { taskId: 't3', userId: h.bob.id, role: 'owner', addedBy: h.bob.id, addedAt: now },
    { taskId: 't3', userId: h.alice.id, role: 'collaborator', addedBy: h.bob.id, addedAt: now },
  ])
}

function sessionActor(userId: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id: userId, username: 'u', displayName: 'u', role, status: 'active' },
    source: 'session',
  })
}

function patActor(
  userId: string,
  role: 'admin' | 'user',
  scopes: ReadonlyArray<Permission>,
): Actor {
  return buildActor({
    user: { id: userId, username: 'u', displayName: 'u', role, status: 'active' },
    source: 'pat',
    patScopes: scopes,
  })
}

describe('RFC-190 /api/overview — 口径 oracle（逐 actor 与列表接口相等）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
    await seedResources(h)
    await seedTasks(h)
  })

  test('resources 各 key == 对应列表接口行数（alice/bob/carol/admin）', async () => {
    for (const who of [h.alice, h.bob, h.carol, h.admin]) {
      const ov = await getOverview(h, who.token)
      const listLen = async (path: string) =>
        ((await (await req(h.app, who.token, path)).json()) as unknown[]).length
      const itemsLen = async (path: string) =>
        ((await (await req(h.app, who.token, path)).json()) as { items: unknown[] }).items.length

      expect(ov.resources.agents).toBe(await listLen('/api/agents'))
      expect(ov.resources.skills).toBe(await listLen('/api/skills'))
      expect(ov.resources.mcps).toBe(await listLen('/api/mcps'))
      expect(ov.resources.plugins).toBe(await listLen('/api/plugins'))
      expect(ov.resources.workflows).toBe(await listLen('/api/workflows'))
      expect(ov.resources.workgroups).toBe(await listLen('/api/workgroups'))
      expect(ov.resources.scheduled).toBe(await listLen('/api/scheduled-tasks'))
      expect(ov.resources.repos).toBe(await itemsLen('/api/cached-repos'))
      expect(ov.resources.memories).toBe(await itemsLen('/api/memories?status=approved'))
    }
  })

  test('ACL 真差异化：私有资源只对 owner/grantee/admin 计数', async () => {
    const a = await getOverview(h, h.alice.token)
    const b = await getOverview(h, h.bob.token)
    const c = await getOverview(h, h.carol.token)
    const adm = await getOverview(h, h.admin.token)
    // agents: alice 5 (all hers) / bob 4 (public 3 + granted) / carol 3 (public only)
    expect(a.resources.agents).toBe(5)
    expect(b.resources.agents).toBe(4)
    expect(c.resources.agents).toBe(3)
    expect(adm.resources.agents).toBe(5)
    // workgroups: private one hidden from non-owners
    expect(a.resources.workgroups).toBe(2)
    expect(c.resources.workgroups).toBe(1)
    expect(adm.resources.workgroups).toBe(2)
    // scheduled: owner-only rows (admin sees both)
    expect(a.resources.scheduled).toBe(1)
    expect(b.resources.scheduled).toBe(1)
    expect(c.resources.scheduled).toBe(0)
    expect(adm.resources.scheduled).toBe(2)
    // repos: global — same number for everyone
    expect(a.resources.repos).toBe(2)
    expect(c.resources.repos).toBe(2)
    // memories: approved only + scope visibility (candidate never counted;
    // private-agent/-workflow rows only for alice + admin)
    expect(a.resources.memories).toBe(3)
    expect(b.resources.memories).toBe(1)
    expect(c.resources.memories).toBe(1)
    expect(adm.resources.memories).toBe(3)
  })

  test('tasks 统计（HTTP，member 口径 + 7d 窗口 + canceled 不计）', async () => {
    const a = await getOverview(h, h.alice.token)
    expect(a.tasks).toEqual({ running: 1, awaiting: 2, done7d: 1, failed7d: 1 })
    const b = await getOverview(h, h.bob.token)
    expect(b.tasks).toEqual({ running: 0, awaiting: 1, done7d: 1, failed7d: 0 })
    const c = await getOverview(h, h.carol.token)
    expect(c.tasks).toEqual({ running: 0, awaiting: 0, done7d: 0, failed7d: 0 })
    const adm = await getOverview(h, h.admin.token)
    // t8 canceled + t6 done@-8d prove the exclusions (else done7d would be 3+).
    expect(adm.tasks).toEqual({ running: 1, awaiting: 2, done7d: 2, failed7d: 1 })
  })

  test('响应过 shared schema，generatedAt 可解析', async () => {
    const ov = await getOverview(h, h.alice.token)
    expect(Number.isFinite(Date.parse(ov.generatedAt))).toBe(true)
  })
})

describe('RFC-190 buildOverview — 权限真值表 + 固定时钟 7d 边界（单元）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('权限真值表：read:all 全量 / read:own mine / 皆无 null；粗门 key 置 null；无粗门 key 恒数字', async () => {
    await seedResources(h)
    await seedTasks(h)

    // admin PAT scoped to tasks:read:all ONLY (design gate P1-2 scenario):
    // tasks must be the UNSCOPED numbers even though tasks:read:own is absent.
    const readAllOnly = patActor('ghost-admin', 'admin', ['tasks:read:all'])
    const ovAll = await buildOverview(h.db, readAllOnly)
    expect(ovAll.tasks).toEqual({ running: 1, awaiting: 2, done7d: 2, failed7d: 1 })
    // …and every coarse-gated resource key is null (scope stripped them)…
    expect(ovAll.resources.agents).toBeNull()
    expect(ovAll.resources.skills).toBeNull()
    expect(ovAll.resources.mcps).toBeNull()
    expect(ovAll.resources.plugins).toBeNull()
    expect(ovAll.resources.workflows).toBeNull()
    expect(ovAll.resources.repos).toBeNull()
    expect(ovAll.resources.memories).toBeNull()
    // …while the gate-less keys stay numbers (admin role → sees all rows).
    expect(ovAll.resources.workgroups).toBe(2)
    expect(ovAll.resources.scheduled).toBe(2)

    // user PAT scoped to tasks:read:own only → mine numbers (alice's view).
    const ownOnly = patActor(h.alice.id, 'user', ['tasks:read:own'])
    const ovOwn = await buildOverview(h.db, ownOnly)
    expect(ovOwn.tasks).toEqual({ running: 1, awaiting: 2, done7d: 1, failed7d: 1 })

    // neither read permission → tasks null; gate-less keys STILL numbers
    // (user role, no owned rows → 0, public workgroups only).
    const noTaskRead = patActor(h.carol.id, 'user', ['account:self'])
    const ovNone = await buildOverview(h.db, noTaskRead)
    expect(ovNone.tasks).toBeNull()
    expect(ovNone.resources.workgroups).toBe(1)
    expect(ovNone.resources.scheduled).toBe(0)
    expect(ovNone.resources.agents).toBeNull()

    // single-key null: everything except repos:read granted → only repos null.
    const noRepos = patActor(h.alice.id, 'user', [
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'memory:read',
      'tasks:read:own',
    ])
    const ovNoRepos = await buildOverview(h.db, noRepos)
    expect(ovNoRepos.resources.repos).toBeNull()
    expect(ovNoRepos.resources.agents).toBe(5)
    expect(ovNoRepos.resources.memories).toBe(3)
  })

  test('7d 边界（注入时钟）：cutoff-1ms 不计 / 恰好 cutoff 计 / cutoff+1ms 计', async () => {
    const T0 = 1_900_000_000_000 // fixed, far from wall-clock seed noise
    const cutoff = T0 - 7 * 86_400_000
    await h.db.insert(workflows).values({
      id: 'wf-bd',
      name: 'wf-bd',
      description: '',
      definition: JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] }),
    })
    await h.db.insert(tasks).values([
      taskRow('bd-out', h.alice.id, 'done', {
        startedAt: cutoff - 10,
        finishedAt: cutoff - 1,
        workflowId: 'wf-bd',
      }),
      taskRow('bd-exact', h.alice.id, 'done', {
        startedAt: cutoff - 10,
        finishedAt: cutoff,
        workflowId: 'wf-bd',
      }),
      taskRow('bd-in', h.alice.id, 'done', {
        startedAt: cutoff - 10,
        finishedAt: cutoff + 1,
        workflowId: 'wf-bd',
      }),
    ])
    const ov = await buildOverview(h.db, sessionActor(h.alice.id, 'user'), () => T0)
    expect(ov.tasks?.done7d).toBe(2)
    expect(ov.tasks?.failed7d).toBe(0)
    expect(ov.generatedAt).toBe(new Date(T0).toISOString())
  })
})
