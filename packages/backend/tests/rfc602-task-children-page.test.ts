// RFC-602: direct child navigation must not truncate after 500, load unrelated
// task details, or lose same-millisecond siblings at a keyset boundary.
import { describe, expect, test } from 'bun:test'
import { Hono, type Context } from 'hono'
import { TaskChildrenPageSchema, type TaskChildrenPage } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { createTaskChildrenQuery } from '@/modules/task-execution/application/taskChildren'
import { createTaskChildrenRead } from '@/modules/task-execution/infrastructure/taskChildrenRead'
import {
  mountTaskRoutes,
  type TaskRouteDependencies,
} from '@/modules/task-execution/inbound/http/taskRoutes'
import type { TaskChildrenRead } from '@/modules/task-execution/application/ports/taskChildren'
import { errorHandler } from '@/platform/errors/domainErrors'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'

const viewer = { userId: 'children-viewer', canReadAllTasks: true }

async function seed(db: PersistenceDb, size: number, parentTaskId = 'children-parent') {
  const { tasks } = tablesOf(db)
  // This projection owns only task core facts; no definition/owner enrichment
  // is needed. Seed that real core explicitly instead of constructing runtimes.
  await db
    .insert(tasks)
    .values({ id: parentTaskId, name: parentTaskId, status: 'done', startedAt: 1 })
  const ids = Array.from(
    { length: size },
    (_, i) => `${parentTaskId}-${String(i).padStart(5, '0')}`,
  )
  for (let offset = 0; offset < ids.length; offset += 100)
    await db.insert(tasks).values(
      ids.slice(offset, offset + 100).map((id) => ({
        id,
        name: id,
        status: 'done' as const,
        startedAt: 100,
        parentTaskId,
      })),
    )
  return ids.reverse()
}

function http(children: TaskRouteDependencies['children']) {
  const app = new Hono()
  const actor: Actor = {
    user: {
      id: viewer.userId,
      username: 'children',
      displayName: 'Children',
      role: 'admin',
      status: 'active',
    },
    permissions: new Set(['tasks:read', 'tasks:read:all']),
    source: 'session',
  }
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  const unexpected = () => {
    throw new Error('unrelated task route operation')
  }
  // The actual children query and actual route run; only unrelated command
  // handles and the already-tested parent middleware boundary are substituted.
  const operations = new Proxy(
    { assertVisible: async () => {} },
    {
      get(target, key) {
        return key === 'assertVisible' ? target.assertVisible : unexpected
      },
    },
  ) as unknown as TaskRouteDependencies['operations']
  mountTaskRoutes(app, {
    children,
    operations,
    workspaceQueries: new Proxy(
      {},
      { get: () => unexpected },
    ) as TaskRouteDependencies['workspaceQueries'],
    diagnostics: new Proxy({}, { get: () => unexpected }) as TaskRouteDependencies['diagnostics'],
  })
  return app
}

describeEachProvider('RFC-602 bounded direct child pages', (harness) => {
  test.each([0, 1, 100, 101, 500, 501, 1201])(
    'returns all %i siblings exactly once with bounded pages',
    async (size) => {
      const expected = await seed(harness.db, size)
      const query = createTaskChildrenQuery(createTaskChildrenRead(harness.db))
      const ids: string[] = []
      let cursor: string | undefined
      let pages = 0
      const record = harness.recordStatements()
      try {
        do {
          const page = await query.list(viewer, { parentTaskId: 'children-parent', cursor })
          expect(TaskChildrenPageSchema.safeParse(page).success).toBe(true)
          expect(page.items.length).toBeLessThanOrEqual(100)
          expect(page.items.every((row) => Object.keys(row).sort().join(',') === 'id,status')).toBe(
            true,
          )
          ids.push(...page.items.map((row) => row.id))
          cursor = page.nextCursor ?? undefined
          pages++
        } while (cursor !== undefined)
      } finally {
        record.stop()
      }
      expect(ids).toEqual(expected)
      expect(new Set(ids).size).toBe(size)
      expect(pages).toBe(Math.max(1, Math.ceil(size / 100)))
      expect(record.selects()).toHaveLength(pages)
      for (const statement of record.selects()) {
        expect(statement.rows).toBeLessThanOrEqual(101)
        expect(statement.params).toBeLessThanOrEqual(5)
        expect(statement.sql).not.toMatch(
          /\b(?:task_definitions|node_runs|workflows?|users)\b|WITH\s+RECURSIVE/i,
        )
      }
    },
    30_000,
  )

  test('only direct public children participate, and different timestamps/ties share one descending order', async () => {
    await seed(harness.db, 3)
    await seed(harness.db, 1201, 'unrelated-parent')
    const { tasks } = tablesOf(harness.db)
    await dbInsert([
      { id: 'newest', startedAt: 101, parentTaskId: 'children-parent' },
      { id: 'oldest', startedAt: 99, parentTaskId: 'children-parent' },
      { id: 'grandchild', startedAt: 999, parentTaskId: 'children-parent-00000' },
      {
        id: 'internal-child',
        startedAt: 999,
        parentTaskId: 'children-parent',
        catalogVisibility: 'internal',
      },
    ])
    async function dbInsert(
      rows: {
        id: string
        startedAt: number
        parentTaskId: string
        catalogVisibility?: 'internal'
      }[],
    ) {
      await harness.db
        .insert(tasks)
        .values(rows.map((row) => ({ name: row.id, status: 'running' as const, ...row })))
    }
    // Each randomized case restores different cardinalities. Refresh statistics
    // so the plan reflects this fixture, not a previous case's parent selectivity.
    await harness.executeFixtureDdl('ANALYZE')
    const query = createTaskChildrenQuery(createTaskChildrenRead(harness.db))
    const record = harness.recordStatements()
    let page: TaskChildrenPage
    try {
      page = await query.list(viewer, { parentTaskId: 'children-parent', limit: '200' })
    } finally {
      record.stop()
    }
    expect(page.items.map((row) => row.id)).toEqual([
      'newest',
      'children-parent-00002',
      'children-parent-00001',
      'children-parent-00000',
      'oldest',
    ])
    expect(page.nextCursor).toBeNull()
    expect(record.selects()).toHaveLength(1)
    expect(record.selects()[0]?.rows).toBe(5)
    const plan = await harness.explain(record.selects()[0]!)
    expect(plan).toContain('idx_tasks_list_parent_started_id')
  }, 30_000)

  test('the real HTTP route preserves the page envelope and reports invalid limits/cursors', async () => {
    const expected = await seed(harness.db, 3)
    const app = http(createTaskChildrenQuery(createTaskChildrenRead(harness.db)))
    const first = await app.request('/api/tasks/children-parent/children?limit=2')
    expect(first.status).toBe(200)
    const page = TaskChildrenPageSchema.parse(await first.json())
    expect(page.items.map((row) => row.id)).toEqual(expected.slice(0, 2))
    const tail = await app.request(
      `/api/tasks/children-parent/children?limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`,
    )
    expect(tail.status).toBe(200)
    expect(TaskChildrenPageSchema.parse(await tail.json()).items.map((row) => row.id)).toEqual(
      expected.slice(2),
    )
    for (const search of ['limit=201', 'limit=0', 'limit=1.5', 'cursor=broken']) {
      const response = await app.request(`/api/tasks/children-parent/children?${search}`)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        ok: false,
        code: search.startsWith('cursor') ? 'task-children-cursor-invalid' : 'task-filter-invalid',
      })
    }
  })

  test('the maximum page uses one 201-row lookahead and terminates on its remaining row', async () => {
    const expected = await seed(harness.db, 201)
    const query = createTaskChildrenQuery(createTaskChildrenRead(harness.db))
    const recording = harness.recordStatements()
    try {
      const first = await query.list(viewer, { parentTaskId: 'children-parent', limit: '200' })
      expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 200))
      expect(first.nextCursor).not.toBeNull()
      const last = await query.list(viewer, {
        parentTaskId: 'children-parent',
        limit: '200',
        cursor: first.nextCursor!,
      })
      expect(last.items.map((row) => row.id)).toEqual(expected.slice(200))
      expect(last.nextCursor).toBeNull()
    } finally {
      recording.stop()
    }
    expect(recording.selects().map((statement) => statement.rows)).toEqual([201, 1])
  })

  test('mixed task subjects and every lifecycle status share the same narrow child projection', async () => {
    await seed(harness.db, 0)
    const { tasks, taskDefinitions } = tablesOf(harness.db)
    const cases = [
      ['workflow', 'pending'],
      ['workgroup', 'running'],
      ['agent', 'awaiting_review'],
      ['digital-employee', 'awaiting_human'],
      ['code-round', 'done'],
      ['unknown', 'failed'],
      ['workflow', 'canceled'],
      ['workgroup', 'interrupted'],
    ] as const
    const expected = cases.map(([subjectKind, status], index) => ({
      id: `mixed-${index}`,
      subjectKind,
      status,
      startedAt: index + 10,
    }))
    await harness.db.insert(tasks).values(
      expected.map(({ id, status, startedAt }) => ({
        id,
        name: id,
        status,
        startedAt,
        parentTaskId: 'children-parent',
      })),
    )
    await harness.db.insert(taskDefinitions).values(
      expected.map(({ id, subjectKind }) => ({
        taskId: id,
        subjectKind,
        definitionOrigin: 'authored' as const,
        engineKind: subjectKind === 'workgroup' ? 'workgroup' : 'workflow',
        workflowSnapshot: '{}',
        inputs: '{}',
      })),
    )
    const query = createTaskChildrenQuery(createTaskChildrenRead(harness.db))
    const recording = harness.recordStatements()
    try {
      const result = await query.list(viewer, { parentTaskId: 'children-parent' })
      expect(result.items).toEqual(
        [...expected].reverse().map(({ id, status }) => ({ id, status })),
      )
      expect(result.nextCursor).toBeNull()
      expect(recording.selects()).toHaveLength(1)
      expect(recording.selects()[0]?.rows).toBe(8)
      expect(recording.selects()[0]?.sql).not.toMatch(
        /\b(?:task_definitions|workflows?|workgroups?)\b/i,
      )
    } finally {
      recording.stop()
    }
  })

  test('keyset continuation crosses timestamp ties and inclusive numeric boundary values without gaps', async () => {
    const tied = await seed(harness.db, 3)
    const { tasks } = tablesOf(harness.db)
    await harness.db.insert(tasks).values([
      {
        id: 'latest-safe-time',
        name: 'latest',
        status: 'running',
        startedAt: Number.MAX_SAFE_INTEGER,
        parentTaskId: 'children-parent',
      },
      {
        id: 'epoch-zero',
        name: 'oldest',
        status: 'done',
        startedAt: 0,
        parentTaskId: 'children-parent',
      },
    ])
    const query = createTaskChildrenQuery(createTaskChildrenRead(harness.db))
    const first = await query.list(viewer, { parentTaskId: 'children-parent', limit: '1' })
    expect(first.items.map((row) => row.id)).toEqual(['latest-safe-time'])
    const second = await query.list(viewer, {
      parentTaskId: 'children-parent',
      limit: '2',
      cursor: first.nextCursor!,
    })
    expect(second.items.map((row) => row.id)).toEqual(tied.slice(0, 2))
    const last = await query.list(viewer, {
      parentTaskId: 'children-parent',
      limit: '2',
      cursor: second.nextCursor!,
    })
    expect(last.items.map((row) => row.id)).toEqual([tied[2]!, 'epoch-zero'])
    expect(last.nextCursor).toBeNull()
  })
})

describe('RFC-602 child cursor and failure semantics', () => {
  test('invalid page inputs are rejected before reading and cursors stay bound to their query', async () => {
    let reads = 0
    const query = createTaskChildrenQuery({
      async page() {
        reads++
        return [
          { id: 'b', status: 'done', startedAt: 10 },
          { id: 'a', status: 'done', startedAt: 10 },
        ]
      },
    })
    for (const limit of ['0', '-1', '201', '1.5', 'NaN', 'Infinity', '1e2', ' 1'])
      await expect(query.list(viewer, { parentTaskId: 'p', limit })).rejects.toMatchObject({
        code: 'task-filter-invalid',
      })
    for (const cursor of ['', 'garbage', Buffer.from('{}').toString('base64url')])
      await expect(query.list(viewer, { parentTaskId: 'p', cursor })).rejects.toMatchObject({
        code: 'task-children-cursor-invalid',
      })
    expect(reads).toBe(0)
    const first = await query.list(viewer, { parentTaskId: 'p', limit: '1' })
    expect(reads).toBe(1)
    await expect(
      query.list(viewer, { parentTaskId: 'other', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'task-children-cursor-invalid' })
    await expect(
      query.list({ ...viewer, userId: 'other' }, { parentTaskId: 'p', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'task-children-cursor-invalid' })
    await expect(
      query.list(
        { ...viewer, canReadAllTasks: false },
        { parentTaskId: 'p', cursor: first.nextCursor! },
      ),
    ).rejects.toMatchObject({ code: 'task-children-cursor-invalid' })
    expect(reads).toBe(1)
  })

  test('storage failure propagates and a later independent request recovers', async () => {
    const error = new Error('children-store-unavailable')
    let fail = true
    const read: TaskChildrenRead = {
      async page() {
        if (fail) throw error
        return []
      },
    }
    const query = createTaskChildrenQuery(read)
    await expect(query.list(viewer, { parentTaskId: 'p' })).rejects.toBe(error)
    fail = false
    expect(await query.list(viewer, { parentTaskId: 'p' })).toEqual({
      schemaVersion: 1,
      parentTaskId: 'p',
      items: [],
      nextCursor: null,
    })
  })

  test('unsupported cursor versions and malformed ordering boundaries fail before a storage read', async () => {
    let reads = 0
    const query = createTaskChildrenQuery({
      async page() {
        reads++
        return []
      },
    })
    const valid = { v: 1, parentTaskId: 'p', ...viewer, startedAt: 0, id: 'child' }
    const invalid = [
      { ...valid, v: 2 },
      { ...valid, startedAt: -1 },
      { ...valid, startedAt: 1.5 },
      { ...valid, startedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, startedAt: '1' },
      { ...valid, id: '' },
      { ...valid, id: 1 },
      { ...valid, extra: true },
    ]
    for (const payload of invalid) {
      const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url')
      await expect(query.list(viewer, { parentTaskId: 'p', cursor })).rejects.toMatchObject({
        code: 'task-children-cursor-invalid',
      })
    }
    await expect(query.list(viewer, { parentTaskId: '' })).rejects.toMatchObject({
      code: 'task-filter-invalid',
    })
    expect(reads).toBe(0)
  })
})
