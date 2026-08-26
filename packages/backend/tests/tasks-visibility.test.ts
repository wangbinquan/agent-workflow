// RFC-036 — task visibility filter integration.
//
// RFC-099 D20 (2026-06-12 用户调整要求): tasks are PRIVATE BY DEFAULT and
// have no public/private switch — only owner + task users + admin ever see a
// task. RFC-231 later made the six ACL resources private on supported create
// paths too, but tasks still use this separate membership model. The "dave sees nothing" /
// "outsider → 403" cases below are the D20 anchor; do not loosen them by
// folding tasks into the D18 visibility model.
//
// We seed three users (admin alice / user bob / user carol) and two task rows
// — one owned by bob with carol added as a collaborator, and one owned by
// the daemon-token actor (__system__). Then for each actor:
//   - admin → sees both (default scope=all);
//   - bob → sees only his task (scope=mine);
//   - carol → sees only the shared task (scope=mine);
//   - dave (unrelated user) → sees nothing;
//   - GET /api/tasks/:id is gated by canViewTask (third-party → 403).

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  aliceToken: string
  bobToken: string
  carolToken: string
  daveToken: string
  bobTaskId: string
  systemTaskId: string
  carolId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })

  const alice = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const carol = await createUser(db, {
    username: 'carol',
    displayName: 'Carol',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const dave = await createUser(db, {
    username: 'dave',
    displayName: 'Dave',
    role: 'user',
    password: 'longEnoughPassword',
  })

  const aliceToken = (await createSession({ db, userId: alice.id })).token
  const bobToken = (await createSession({ db, userId: bob.id })).token
  const carolToken = (await createSession({ db, userId: carol.id })).token
  const daveToken = (await createSession({ db, userId: dave.id })).token

  // Seed a workflow + two tasks directly via the DB (PR4 wires the launcher).
  const wfId = 'wf01'
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })

  const bobTaskId = 'task-bob'
  const systemTaskId = 'task-system'
  const now = Date.now()
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: bobTaskId,
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    repoUrl: null,
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/task-bob',
    baseCommit: null,
    status: 'done',
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: now,
    finishedAt: now,
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    ownerUserId: bob.id,
  })
  await db.insert(taskCollaborators).values([
    { taskId: bobTaskId, userId: bob.id, role: 'owner', addedBy: bob.id, addedAt: now },
    // RFC-099: the 'reviewer' role tag is gone — plain collaborator membership.
    { taskId: bobTaskId, userId: carol.id, role: 'collaborator', addedBy: bob.id, addedAt: now },
  ])
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: systemTaskId,
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    repoUrl: null,
    worktreePath: '/tmp/wt-system',
    baseBranch: 'main',
    branch: 'agent-workflow/task-system',
    baseCommit: null,
    status: 'done',
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: now,
    finishedAt: now,
    errorSummary: null,
    errorMessage: null,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    ownerUserId: '__system__',
  })

  return {
    db,
    app,
    aliceToken,
    bobToken,
    carolToken,
    daveToken,
    bobTaskId,
    systemTaskId,
    carolId: carol.id,
  }
}

async function reqAs(app: Hono, token: string, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}

describe('GET /api/tasks visibility filter', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('admin sees both tasks by default (scope=all)', async () => {
    const res = await reqAs(h.app, h.aliceToken, '/api/tasks')
    expect(res.status).toBe(200)
    const list = (await res.json()) as { id: string }[]
    expect(list.map((t) => t.id).sort()).toEqual([h.bobTaskId, h.systemTaskId].sort())
  })

  test('default wire stays TaskSummary-only; list projection is explicit opt-in', async () => {
    const defaults = (await (await reqAs(h.app, h.aliceToken, '/api/tasks')).json()) as Array<
      Record<string, unknown>
    >
    expect(defaults.length).toBe(2)
    for (const row of defaults) {
      expect(row).not.toHaveProperty('ownerUserId')
      expect(row).not.toHaveProperty('owner')
      // RFC-243 follow-up: childCount costs an extra grouped query, so it rides
      // the LIST projection only — the default wire (shared with the WS task
      // payloads) must stay a plain TaskSummary.
      expect(row).not.toHaveProperty('childCount')
    }

    for (const enabled of ['true', '1']) {
      const rows = (await (
        await reqAs(h.app, h.aliceToken, `/api/tasks?include_owner=${enabled}`)
      ).json()) as Array<Record<string, unknown>>
      // Stripping exactly the list-projection fields must recover the default
      // wire byte-for-byte: opting in adds these and NOTHING else.
      expect(
        rows.map(
          ({ owner: _owner, ownerUserId: _ownerUserId, childCount: _childCount, ...row }) => row,
        ),
      ).toEqual(defaults)
      expect(rows.every((row) => typeof row['childCount'] === 'number')).toBe(true)
      const bob = rows.find((row) => row['id'] === h.bobTaskId)
      expect(bob?.['owner']).toEqual({
        id: expect.any(String),
        username: 'bob',
        displayName: 'Bob',
      })
      expect(Object.keys(bob?.['owner'] as object).sort()).toEqual([
        'displayName',
        'id',
        'username',
      ])
      expect(bob).toHaveProperty('ownerUserId', (bob?.['owner'] as { id: string }).id)

      const system = rows.find((row) => row['id'] === h.systemTaskId)
      expect(system).toMatchObject({ ownerUserId: '__system__', owner: null })
    }

    for (const disabled of ['false', '0']) {
      const rows = (await (
        await reqAs(h.app, h.aliceToken, `/api/tasks?include_owner=${disabled}`)
      ).json()) as Array<Record<string, unknown>>
      expect(rows.every((row) => !('owner' in row) && !('ownerUserId' in row))).toBe(true)
    }
  })

  test('include_owner rejects unknown boolean spellings', async () => {
    const res = await reqAs(h.app, h.aliceToken, '/api/tasks?include_owner=yes')
    expect(res.status).toBe(422)
    expect((await res.json()) as unknown).toMatchObject({ code: 'invalid-bool-query' })
  })

  test('bob (owner) sees only his task by default', async () => {
    const res = await reqAs(h.app, h.bobToken, '/api/tasks')
    const list = (await res.json()) as { id: string }[]
    expect(list.map((t) => t.id)).toEqual([h.bobTaskId])
  })

  test("carol (collaborator only) sees the shared task via 'mine'", async () => {
    const res = await reqAs(h.app, h.carolToken, '/api/tasks')
    const list = (await res.json()) as { id: string }[]
    expect(list.map((t) => t.id)).toEqual([h.bobTaskId])
  })

  test('owner projection does not widen task visibility', async () => {
    const collaborator = (await (
      await reqAs(h.app, h.carolToken, '/api/tasks?include_owner=true')
    ).json()) as Array<{ id: string; owner: { username: string } | null }>
    expect(collaborator).toHaveLength(1)
    expect(collaborator[0]).toMatchObject({
      id: h.bobTaskId,
      owner: { username: 'bob' },
    })

    const outsider = (await (
      await reqAs(h.app, h.daveToken, '/api/tasks?include_owner=true')
    ).json()) as unknown[]
    expect(outsider).toEqual([])
  })

  test('dave (unrelated) sees nothing', async () => {
    const res = await reqAs(h.app, h.daveToken, '/api/tasks')
    const list = (await res.json()) as { id: string }[]
    expect(list).toEqual([])
  })

  test('user asking for scope=all gets coerced to mine', async () => {
    const res = await reqAs(h.app, h.bobToken, '/api/tasks?scope=all')
    const list = (await res.json()) as { id: string }[]
    expect(list.map((t) => t.id)).toEqual([h.bobTaskId])
  })

  test('scope=shared excludes self-owned rows', async () => {
    const res = await reqAs(h.app, h.bobToken, '/api/tasks?scope=shared')
    const list = (await res.json()) as { id: string }[]
    expect(list).toEqual([])
  })

  test('scope=shared keeps null-owner tasks I collaborate on（RFC-330 缺口 2）', async () => {
    // `owner_user_id IS NULL`（系统发起 / 存量）对 `<>` 不为真：修前这条任务在 carol 的
    // 「我的任务」里有、「与我共享」里没有——两档语义本该是「我参与的」⊇「参与但非我所有」。
    const now = Date.now()
    await h.db.insert(tasks).values({
      name: 'fixture-task',
      id: 'task-null-owner',
      workflowId: 'wf01',
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      repoUrl: null,
      worktreePath: '/tmp/wt-null-owner',
      baseBranch: 'main',
      branch: 'agent-workflow/task-null-owner',
      baseCommit: null,
      status: 'done',
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: now,
      finishedAt: now,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      ownerUserId: null,
    })
    await h.db.insert(taskCollaborators).values([
      {
        taskId: 'task-null-owner',
        userId: h.carolId,
        role: 'collaborator',
        addedBy: h.carolId,
        addedAt: now,
      },
    ])
    const shared = (await (await reqAs(h.app, h.carolToken, '/api/tasks?scope=shared')).json()) as {
      id: string
    }[]
    expect(shared.map((t) => t.id).sort()).toEqual([h.bobTaskId, 'task-null-owner'].sort())
    const mine = (await (await reqAs(h.app, h.carolToken, '/api/tasks?scope=mine')).json()) as {
      id: string
    }[]
    expect(mine.map((t) => t.id).sort()).toEqual([h.bobTaskId, 'task-null-owner'].sort())
    // bob 与它无关：两档都不该出现
    const bobShared = (await (
      await reqAs(h.app, h.bobToken, '/api/tasks?scope=shared')
    ).json()) as { id: string }[]
    expect(bobShared).toEqual([])
  })

  test('daemon token actor sees everything', async () => {
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/tasks')
    const list = (await res.json()) as { id: string }[]
    expect(list.length).toBe(2)
  })
})

describe('GET /api/tasks/:id visibility gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('admin → 200 on either task', async () => {
    expect((await reqAs(h.app, h.aliceToken, `/api/tasks/${h.bobTaskId}`)).status).toBe(200)
    expect((await reqAs(h.app, h.aliceToken, `/api/tasks/${h.systemTaskId}`)).status).toBe(200)
  })

  // RFC-285 B1：外人得到与「任务不存在」逐字节同形的 404——错误码探测不出存在性。
  test('owner / collaborator → 200; outsider → 404 与不存在逐字节同形（B1 oracle）', async () => {
    expect((await reqAs(h.app, h.bobToken, `/api/tasks/${h.bobTaskId}`)).status).toBe(200)
    expect((await reqAs(h.app, h.carolToken, `/api/tasks/${h.bobTaskId}`)).status).toBe(200)
    const invisible = await reqAs(h.app, h.daveToken, `/api/tasks/${h.bobTaskId}`)
    expect(invisible.status).toBe(404)
    // oracle 消除：同一调用方打「存在但无权」与「真不存在」两个 id，除 id 文本
    // 外响应体逐字节相等（把 id 归一后直接比对整个 body 字符串）。
    const missingId = 'no-such-task-id-b1'
    const missing = await reqAs(h.app, h.daveToken, `/api/tasks/${missingId}`)
    expect(missing.status).toBe(404)
    const normalize = (s: string, id: string): string => s.replaceAll(id, '<ID>')
    expect(normalize(await invisible.text(), h.bobTaskId)).toBe(
      normalize(await missing.text(), missingId),
    )
  })

  test('outsider → 404 on system task as well（B1 同形）', async () => {
    expect((await reqAs(h.app, h.daveToken, `/api/tasks/${h.systemTaskId}`)).status).toBe(404)
  })
})
