import { TaskOperationsRootPageSchema, type TaskLaunchOrigin } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import { taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { listTaskOperationsPage, parseTaskOperationsQuery } from '../src/services/taskOperations'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedBase(db: Db): Promise<void> {
  const now = 1_788_278_400_000
  await db.insert(users).values([
    {
      id: 'admin',
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'alice',
      username: 'alice',
      displayName: 'Alice',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bob',
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    },
  ])
  await db.insert(workflows).values({
    id: 'wf-rfc244',
    name: 'Operations workflow',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
}

function task(
  id: string,
  ownerUserId: string,
  status: 'pending' | 'running' | 'done' | 'failed' = 'done',
  options: {
    parentTaskId?: string
    startedAt?: number
    name?: string
    workgroupConfigJson?: string
    workgroupId?: string
    sourceAgentName?: string
    sourceAgentId?: string
    scheduledTaskId?: string
    launchOrigin?: TaskLaunchOrigin
    workflowSnapshot?: string
    inputs?: string
    refClosureJson?: string
  } = {},
) {
  return {
    id,
    name: options.name ?? id,
    workflowId: 'wf-rfc244',
    workflowSnapshot: options.workflowSnapshot ?? '{}',
    repoPath: `/tmp/${id}`,
    worktreePath: `/tmp/wt-${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: options.inputs ?? '{}',
    startedAt: options.startedAt ?? 100,
    finishedAt: status === 'done' || status === 'failed' ? 200 : null,
    runningMs: status === 'running' ? 500 : 0,
    runningSince: status === 'running' ? 150 : null,
    ownerUserId,
    parentTaskId: options.parentTaskId,
    invocationDepth: options.parentTaskId === undefined ? 0 : 1,
    workgroupConfigJson: options.workgroupConfigJson,
    workgroupId: options.workgroupId,
    sourceAgentName: options.sourceAgentName,
    sourceAgentId: options.sourceAgentId,
    scheduledTaskId: options.scheduledTaskId,
    launchOrigin:
      options.launchOrigin ?? (options.scheduledTaskId === undefined ? 'manual' : 'scheduled'),
    refClosureJson: options.refClosureJson,
  }
}

describe('RFC-244 task operations query', () => {
  test('deep search returns context ancestry and branch recency; facets ignore view', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db.insert(tasks).values([
      task('root-old', 'alice', 'done', { startedAt: 100 }),
      task('mid', 'alice', 'done', { parentTaskId: 'root-old', startedAt: 200 }),
      task('leaf-target', 'alice', 'running', {
        parentTaskId: 'mid',
        startedAt: 900,
        name: 'Needle execution',
      }),
      task('root-new', 'alice', 'failed', { startedAt: 800 }),
    ])

    const searched = await listTaskOperationsPage(db, actor('alice'), {
      q: ' needle ',
      view: 'active',
    })
    expect(searched.kind).toBe('root')
    if (searched.kind !== 'root') throw new Error('expected root page')
    expect(searched.items.map((item) => item.id)).toEqual(['root-old'])
    expect(searched.items[0]?.listContext).toMatchObject({
      matchKind: 'context',
      qualifyingChildCount: 1,
      matchingDescendantCount: 1,
      branchStartedAt: 900,
    })
    expect(searched.facets).toEqual({ all: 1, active: 1, attention: 0, finished: 0 })

    const unsearched = await listTaskOperationsPage(db, actor('alice'), { view: 'active' })
    expect(unsearched.kind).toBe('root')
    if (unsearched.kind !== 'root') throw new Error('expected root page')
    expect(unsearched.facets).toEqual({ all: 4, active: 1, attention: 1, finished: 3 })
    expect(unsearched.items[0]?.id).toBe('root-old')
  })

  test('ACL boundary promotes visible child to neutral unavailable root', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db.insert(tasks).values([
      task('private-parent', 'bob', 'done', { startedAt: 100 }),
      task('visible-child', 'alice', 'running', {
        parentTaskId: 'private-parent',
        startedAt: 200,
      }),
    ])

    const page = await listTaskOperationsPage(db, actor('alice'), {})
    expect(page.kind).toBe('root')
    if (page.kind !== 'root') throw new Error('expected root page')
    expect(page.items.map((item) => item.id)).toEqual(['visible-child'])
    expect(page.items[0]?.listContext.parentAvailability).toBe('unavailable')
    expect(page.items[0]?.parentTaskId).toBe('private-parent')
  })

  test('child page is subtree-bounded, carries context, and rejects invisible parent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db
      .insert(tasks)
      .values([
        task('parent', 'alice'),
        task('mid', 'alice', 'done', { parentTaskId: 'parent' }),
        task('active-leaf', 'alice', 'running', { parentTaskId: 'mid' }),
        task('private-parent', 'bob'),
        task('private-child', 'bob', 'running', { parentTaskId: 'private-parent' }),
      ])

    const page = await listTaskOperationsPage(db, actor('alice'), {
      parent_id: 'parent',
      view: 'active',
    })
    expect(page.kind).toBe('children')
    if (page.kind !== 'children') throw new Error('expected child page')
    expect(page).not.toHaveProperty('facets')
    expect(page.items.map((item) => [item.id, item.listContext.matchKind])).toEqual([
      ['mid', 'context'],
    ])
    expect(page.items[0]?.listContext.parentAvailability).toBe('visible')

    await expect(
      listTaskOperationsPage(db, actor('alice'), { parent_id: 'private-parent' }),
    ).rejects.toMatchObject({ code: 'task-not-found', status: 404 })
  })

  test('keyset cursor has stable id tie-breaker and is actor/filter bound', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db
      .insert(tasks)
      .values([
        task('task-c', 'alice', 'done', { startedAt: 100 }),
        task('task-b', 'alice', 'done', { startedAt: 100 }),
        task('task-a', 'alice', 'done', { startedAt: 100 }),
      ])

    const first = await listTaskOperationsPage(db, actor('alice'), { limit: '2' })
    expect(first.items.map((item) => item.id)).toEqual(['task-c', 'task-b'])
    expect(first.nextCursor).not.toBeNull()
    const second = await listTaskOperationsPage(db, actor('alice'), {
      limit: '2',
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map((item) => item.id)).toEqual(['task-a'])

    await expect(
      listTaskOperationsPage(db, actor('bob'), {
        limit: '2',
        cursor: first.nextCursor ?? undefined,
      }),
    ).rejects.toMatchObject({ code: 'task-page-cursor-invalid' })
    await expect(
      listTaskOperationsPage(db, actor('alice'), { cursor: 'not_base64url' }),
    ).rejects.toMatchObject({ code: 'task-page-cursor-invalid' })
  })

  test('query canonicalization is strict and corrupt frozen JSON degrades to null', async () => {
    const parsed = parseTaskOperationsQuery(actor('alice'), {
      statuses: 'running,pending,running',
      scope: 'all',
      q: '  hello  ',
    })
    expect(parsed.filters.statuses).toEqual(['pending', 'running'])
    expect(parsed.filters.scope).toBe('mine')
    expect(parsed.filters.q).toBe('hello')
    expect(() => parseTaskOperationsQuery(actor('alice'), { limit: '101' })).toThrow()
    expect(() => parseTaskOperationsQuery(actor('alice'), { statuses: 'running,' })).toThrow()

    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db
      .insert(tasks)
      .values([task('corrupt-json', 'alice', 'done', { workgroupConfigJson: '{broken' })])
    const page = await listTaskOperationsPage(db, actor('alice'), {})
    expect(page.items[0]?.workgroupName).toBeNull()
  })

  test('shared scope uses membership for self-match but retains owned parent context', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db
      .insert(tasks)
      .values([
        task('owned-parent', 'admin'),
        task('shared-child', 'bob', 'running', { parentTaskId: 'owned-parent' }),
      ])
    await db.insert(taskCollaborators).values({
      taskId: 'shared-child',
      userId: 'admin',
      role: 'collaborator',
      addedBy: 'bob',
      addedAt: 100,
    })

    const page = await listTaskOperationsPage(db, actor('admin', 'admin'), {
      scope: 'shared',
      view: 'active',
    })
    expect(page.items.map((item) => item.id)).toEqual(['owned-parent'])
    expect(page.items[0]?.listContext.matchKind).toBe('context')
    expect(page.items[0]?.listContext.parentAvailability).toBe('none')
  })

  test('subject and origin filters stay distinct and large launch JSON never reaches the list wire', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    const forbidden = 'RFC244_FORBIDDEN_LARGE_JSON_SENTINEL'
    await db.insert(tasks).values([
      task('workflow-manual', 'alice', 'done', { startedAt: 100 }),
      task('agent-manual', 'alice', 'running', {
        startedAt: 200,
        sourceAgentName: 'researcher',
        sourceAgentId: 'agent-stable-id',
      }),
      task('workgroup-manual', 'alice', 'done', {
        startedAt: 300,
        workgroupId: 'workgroup-stable-id',
        workgroupConfigJson: JSON.stringify({
          workgroupName: 'Frozen response team',
          privatePayload: forbidden,
        }),
        workflowSnapshot: JSON.stringify({ forbidden }),
        inputs: JSON.stringify({ forbidden }),
        refClosureJson: JSON.stringify({ forbidden }),
      }),
      task('workflow-scheduled', 'alice', 'pending', {
        startedAt: 400,
        scheduledTaskId: 'scheduled-soft-link',
      }),
      task('workflow-webhook', 'alice', 'done', {
        startedAt: 500,
        launchOrigin: 'webhook',
      }),
      task('workflow-api', 'alice', 'done', {
        startedAt: 600,
        launchOrigin: 'api',
      }),
    ])

    const workflow = await listTaskOperationsPage(db, actor('alice'), { subject: 'workflow' })
    expect(workflow.items.map((row) => row.id)).toEqual([
      'workflow-api',
      'workflow-webhook',
      'workflow-scheduled',
      'workflow-manual',
    ])
    const agent = await listTaskOperationsPage(db, actor('alice'), { subject: 'agent' })
    expect(agent.items.map((row) => row.id)).toEqual(['agent-manual'])
    const workgroup = await listTaskOperationsPage(db, actor('alice'), {
      subject: 'workgroup',
    })
    expect(workgroup.items.map((row) => row.id)).toEqual(['workgroup-manual'])
    expect(workgroup.items[0]?.workgroupName).toBe('Frozen response team')
    expect(JSON.stringify(workgroup)).not.toContain(forbidden)

    const scheduled = await listTaskOperationsPage(db, actor('alice'), {
      origin: 'scheduled',
    })
    expect(scheduled.items.map((row) => row.id)).toEqual(['workflow-scheduled'])
    const manual = await listTaskOperationsPage(db, actor('alice'), { origin: 'manual' })
    expect(manual.items.map((row) => row.id)).toEqual([
      'workgroup-manual',
      'agent-manual',
      'workflow-manual',
    ])
    const webhook = await listTaskOperationsPage(db, actor('alice'), { origin: 'webhook' })
    expect(webhook.items.map((row) => row.id)).toEqual(['workflow-webhook'])
    const api = await listTaskOperationsPage(db, actor('alice'), { origin: 'api' })
    expect(api.items.map((row) => row.id)).toEqual(['workflow-api'])
    expect(JSON.stringify(api)).not.toContain('launchOrigin')
  })

  test('a corrupt parent cycle terminates defensively without inventing a root', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedBase(db)
    await db.insert(tasks).values([task('cycle-a', 'alice'), task('cycle-b', 'alice')])
    await db.update(tasks).set({ parentTaskId: 'cycle-b' }).where(eq(tasks.id, 'cycle-a'))
    await db.update(tasks).set({ parentTaskId: 'cycle-a' }).where(eq(tasks.id, 'cycle-b'))

    const page = await listTaskOperationsPage(db, actor('alice'), {})
    expect(page.kind).toBe('root')
    if (page.kind !== 'root') throw new Error('expected root page')
    expect(page.items).toEqual([])
    expect(page.facets).toEqual({ all: 2, active: 0, attention: 0, finished: 2 })
  })

  test('static /api/tasks/page route returns the strict page wire without changing legacy /api/tasks', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await createUser(db, {
      username: 'route-owner',
      displayName: 'Route Owner',
      role: 'user',
      password: 'longEnoughPassword',
    })
    await db.insert(workflows).values({
      id: 'wf-route-rfc244',
      name: 'Route workflow',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })
    await db.insert(tasks).values({
      ...task('route-task', owner.id),
      workflowId: 'wf-route-rfc244',
    })
    const app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc244-route-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const token = (await createSession({ db, userId: owner.id })).token
    const headers = { Authorization: `Bearer ${token}` }

    const pageResponse = await app.request('/api/tasks/page?limit=1', { headers })
    expect(pageResponse.status).toBe(200)
    const page = TaskOperationsRootPageSchema.parse(await pageResponse.json())
    expect(page.items.map((item) => item.id)).toEqual(['route-task'])

    const badResponse = await app.request('/api/tasks/page?limit=101', { headers })
    expect(badResponse.status).toBe(422)
    expect((await badResponse.json()) as { code: string }).toMatchObject({
      code: 'task-page-filter-invalid',
    })

    const legacyResponse = await app.request('/api/tasks', { headers })
    expect(legacyResponse.status).toBe(200)
    const legacy = (await legacyResponse.json()) as unknown
    expect(Array.isArray(legacy)).toBe(true)
  })
})
