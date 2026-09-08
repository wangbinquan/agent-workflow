// RFC-359 AC11: the filtered-root SQL keeps one statement snapshot while
// matches/roots stop materializing and the recursive seed becomes page-local.
// This small default-provider suite exercises real DB rows and the production
// page factory. It does not measure latency or change the HTTP acceptance budget.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, taskRepos, tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createDatabaseTaskListPage,
  type TaskListViewer,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import { parseTaskOperationsQuery } from '@/modules/task-execution/infrastructure/taskListPage/filters'
import {
  fastFilteredRootQuery,
  rootQuery,
} from '@/modules/task-execution/infrastructure/taskListPage/query'
import { describeEachProvider } from './helpers/eachProvider'

const VIEWER: TaskListViewer = { userId: 'fixture-owner', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const MATRIX_TIMEOUT_MS = 30_000
const STATUSES = [
  'done',
  'running',
  'failed',
  'awaiting_review',
  'pending',
  'canceled',
  'interrupted',
  'awaiting_human',
] as const

type TaskInsert = typeof tasks.$inferInsert

function fixtureTasks(): TaskInsert[] {
  const rows: TaskInsert[] = []
  const lineagePaths = new Map<
    string,
    readonly {
      stableNodeKey: string
      frozenOccurrenceKey: string
      workflowRevision: number | null
    }[]
  >()
  function add(
    id: string,
    root: string,
    parent: string | null,
    startedAt: number,
    extra: Partial<TaskInsert> = {},
  ): void {
    const index = rows.length
    // Match the original SQLite 0210 trigger, including JSON property order.
    const lineagePath = [
      ...(parent === null ? [] : (lineagePaths.get(parent) ?? [])),
      {
        stableNodeKey: parent === null ? 'task-root' : 'child-task',
        frozenOccurrenceKey: id,
        workflowRevision: extra.workflowVersion ?? null,
      },
    ]
    lineagePaths.set(id, lineagePath)
    rows.push({
      id,
      name: index % 3 === 0 ? `MiXeD ${id}` : `quiet ${id}`,
      workflowId: index % 2 ? 'wf01' : 'wf02',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: index % 5 === 0 ? '/fixture/percent%_repo' : `/fixture/${id}`,
      repoUrl: index % 4 === 0 ? 'https://example.invalid/mixed' : null,
      cachedRepoId: index % 2 ? `cache-${index}` : null,
      worktreePath: `/fixture/worktree/${id}`,
      baseBranch: 'main',
      branch: `task/${id}`,
      status: STATUSES[index % STATUSES.length]!,
      startedAt,
      runningMs: index * 7,
      runningSince: index % 2 ? startedAt : null,
      finishedAt: index % 2 ? null : startedAt + 17,
      errorSummary: index % 3 ? null : `error-${id}`,
      failedNodeId: index % 4 ? null : `node-${index}`,
      repoCount: (index % 4) + 1,
      scheduledTaskId: index % 4 ? null : `schedule-${index}`,
      launchOrigin: index % 3 === 0 ? 'webhook' : index % 3 === 1 ? 'manual' : 'event',
      workgroupId: null,
      workgroupConfigJson: null,
      spaceKind: index % 2 ? 'remote' : 'local',
      parentTaskId: parent,
      invocationDepth: parent ? 1 : 0,
      sourceAgentName: null,
      sourceAgentId: null,
      ownerUserId: VIEWER.userId,
      rootTaskId: root,
      branchStartedAt: startedAt,
      catalogVisibility: 'public',
      executionLineageId: root,
      lineageSlotPathJson: JSON.stringify(lineagePath),
      ...extra,
    })
  }
  add('r01', 'r01', null, 100)
  add('r02', 'r02', null, 120, {
    status: 'done',
    workgroupId: 'wg02',
    workgroupConfigJson: '{ "workgroupName" : "Mixed Group", "n":1 }',
  })
  add('r03', 'r03', null, 120, { sourceAgentName: 'MiXeD Agent', sourceAgentId: 'agent03' })
  add('r04', 'r04', null, 140, { workgroupId: 'wg04', workgroupConfigJson: '{broken' })
  add('r05', 'r05', null, 140, {
    workgroupId: 'wg05',
    workgroupConfigJson: '{"workgroupName":null}',
  })
  add('r06', 'r06', null, 160, { workgroupId: 'wg06', workgroupConfigJson: '{"workgroupName":17}' })
  add('r07', 'r07', null, 180, {
    launchOrigin: 'scheduled',
    workgroupId: 'wg07',
    workgroupConfigJson: '{"workgroupName":""}',
  })
  add('c01', 'r01', 'r01', 300, { status: 'done' })
  add('c02', 'r01', 'r01', 290, { status: 'awaiting_review' })
  add('g01', 'r01', 'c01', 500, { status: 'running', name: 'NEEDLE leaf', invocationDepth: 2 })
  add('c03', 'r02', 'r02', 500, {
    workgroupId: 'wg02',
    workgroupConfigJson: '{"workgroupName":"Mixed Group"}',
  })
  add('c04', 'r02', 'r02', 490, { status: 'done' })
  add('c05', 'r03', 'r03', 480, { status: 'done' })
  add('g02', 'r03', 'c05', 510, { status: 'running', name: 'needle leaf', invocationDepth: 2 })
  add('c06', 'r04', 'r04', 460, { sourceAgentName: 'Worker', sourceAgentId: 'agent04' })
  add('c07', 'r05', 'r05', 460, {
    workgroupId: 'wg05',
    workgroupConfigJson: '{"workgroupName":["ignored"]}',
  })
  add('c08', 'r06', 'r06', 460, {
    launchOrigin: 'api',
    name: 'raw percent%_ name',
    status: 'pending',
  })
  add('c09', 'r07', 'r07', 450, { name: 'cycle leaf', status: 'running' })
  return rows.map((row) => ({
    ...row,
    branchStartedAt: Math.max(
      ...rows
        .filter((child) => child.rootTaskId === row.rootTaskId)
        .map((child) => child.startedAt),
    ),
  }))
}

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'Fixture owner',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values([
    { id: 'wf01', name: 'Mixed Workflow', definition: '{}', createdAt: 1, updatedAt: 1 },
    { id: 'wf02', name: 'Quiet Flow', definition: '{}', createdAt: 1, updatedAt: 1 },
  ])
  for (const row of fixtureTasks()) await db.insert(tasks).values(row)
  const alerts: ReadonlyArray<readonly [string, string, number | null]> = [
    ['a01', 'r01', null],
    ['a02', 'r01', null],
    ['a03', 'c01', null],
    ['a04', 'c03', 123],
    ['a05', 'r04', null],
    ['a06', 'g02', null],
  ]
  for (const [id, taskId, resolvedAt] of alerts) {
    await db.insert(lifecycleAlerts).values({
      id,
      taskId,
      rule: `fixture-${id}`,
      severity: 'warn',
      detail: '{}',
      detectedAt: 1,
      resolvedAt,
    })
  }
  await db.insert(taskRepos).values({
    taskId: 'c04',
    repoIndex: 0,
    repoPath: '/fixture/sidecar',
    repoUrl: 'https://example.invalid/NEEDLE',
    worktreePath: '/fixture/worktree/c04',
    baseBranch: 'main',
    branch: 'task/c04',
  })
}

async function fixtureRowsDigest(db: ProviderNeutralDatabase): Promise<string> {
  const rows = await db.select().from(tasks).orderBy(tasks.id)
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function scenarios(): TaskOperationsRawQuery[] {
  const rows: TaskOperationsRawQuery[] = []
  for (const view of ['all', 'active', 'attention', 'finished']) {
    for (const subject of ['all', 'workflow', 'workgroup', 'agent']) {
      for (const limit of ['1', '3']) rows.push({ view, subject, limit, scope: 'all' })
    }
  }
  for (const q of ['mixed', 'NEEDLE', 'percent%_', 'sidecar', 'no match']) {
    for (const view of ['all', 'attention']) rows.push({ view, q, limit: '3', scope: 'all' })
  }
  for (const statuses of [
    'running',
    'done,failed',
    'awaiting_review,awaiting_human',
    'canceled,interrupted',
  ]) {
    for (const subject of ['all', 'workflow'])
      rows.push({ statuses, subject, limit: '1', scope: 'all' })
  }
  for (const origin of ['all', 'manual', 'scheduled', 'event', 'webhook', 'api']) {
    for (const view of ['all', 'attention']) rows.push({ origin, view, limit: '3', scope: 'all' })
  }
  rows.push({ subject: 'workflow', scope: 'all', limit: '50' })
  return rows
}

async function storedJson(db: ProviderNeutralDatabase): Promise<string> {
  return JSON.stringify(
    await db
      .select({
        id: tasks.id,
        workflowSnapshot: tasks.workflowSnapshot,
        inputs: tasks.inputs,
        workgroupConfigJson: tasks.workgroupConfigJson,
      })
      .from(tasks)
      .orderBy(asc(tasks.id)),
  )
}

describeEachProvider('RFC-359 W19 — filtered task page CTE range', (harness) => {
  test(
    '63 product filters keep full rows, pages, cursors and counts equal to the exhaustive query',
    async () => {
      await seed(harness.db)
      // Full rows captured from the original SQLite fixture and its 0210 trigger.
      expect(await fixtureRowsDigest(harness.db)).toBe(
        '1a1adb9d2976c02170e8c54828832c739329ad27dc046e36071440ee81406cc6',
      )
      const rawJsonBefore = await storedJson(harness.db)
      const page = createDatabaseTaskListPage(harness.db, composeOwnerIdentityQueries(harness.db))
      const matrix = scenarios()
      expect(matrix).toHaveLength(63)
      let nonEmptyScenarios = 0
      for (const raw of matrix) {
        let cursor: string | undefined
        const seen: string[] = []
        let pages = 0
        for (;;) {
          const request = { ...raw, ...(cursor === undefined ? {} : { cursor }) }
          const parsed = parseTaskOperationsQuery(VIEWER, request, OPTIONS)
          const expectedRows = await harness.db.all(
            rootQuery(harness.db, VIEWER, parsed, OPTIONS.catalogVisibility),
          )
          const actualRows = await harness.db.all(
            fastFilteredRootQuery(harness.db, VIEWER, parsed, OPTIONS.catalogVisibility),
          )
          expect(actualRows, JSON.stringify(request)).toEqual(expectedRows)
          expect(JSON.stringify(actualRows)).toBe(JSON.stringify(expectedRows))
          const expected = await page.list(VIEWER, request, { ...OPTIONS, pipeline: 'exhaustive' })
          const actual = await page.list(VIEWER, request, OPTIONS)
          expect(actual, JSON.stringify(request)).toEqual(expected)
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
          seen.push(...actual.items.map((item) => item.id))
          expect(new Set(seen).size).toBe(seen.length)
          pages += 1
          expect(pages).toBeLessThanOrEqual(18)
          if (actual.nextCursor === null) break
          const parsedNext = parseTaskOperationsQuery(
            VIEWER,
            { ...raw, cursor: actual.nextCursor },
            OPTIONS,
          )
          expect(typeof parsedNext.cursor?.branchStartedAt).toBe('number')
          expect(parsedNext.cursor?.taskId).toBe(actual.items.at(-1)?.id)
          cursor = actual.nextCursor
        }
        if (seen.length > 0) nonEmptyScenarios += 1
      }
      expect(nonEmptyScenarios).toBeGreaterThan(40)
      expect(await storedJson(harness.db)).toBe(rawJsonBefore)

      const all = await page.list(VIEWER, { limit: '50' }, OPTIONS)
      expect(all.kind).toBe('root')
      if (all.kind !== 'root') throw new Error('root fixture returned a child page')
      expect(all.facets).toEqual({ all: 18, active: 8, attention: 8, finished: 10 })
      expect(all.items.map((item) => item.id)).toEqual([
        'r03',
        'r02',
        'r01',
        'r06',
        'r05',
        'r04',
        'r07',
      ])
      expect(all.items.find((item) => item.id === 'r01')?.openAlertCount).toBe(2)
      expect(all.items.find((item) => item.id === 'r02')?.workgroupName).toBe('Mixed Group')
      for (const id of ['r04', 'r05', 'r06', 'r07']) {
        expect(all.items.find((item) => item.id === id)?.workgroupName).toBeNull()
      }
      const needle = await page.list(VIEWER, { q: 'needle', limit: '50' }, OPTIONS)
      expect(needle.items.map((item) => item.id)).toEqual(['r03', 'r01', 'r02'])
      expect(needle.items.map((item) => item.listContext)).toEqual([
        {
          matchKind: 'context',
          parentAvailability: 'none',
          branchStartedAt: 510,
          qualifyingChildCount: 1,
          matchingDescendantCount: 1,
        },
        {
          matchKind: 'context',
          parentAvailability: 'none',
          branchStartedAt: 500,
          qualifyingChildCount: 1,
          matchingDescendantCount: 1,
        },
        {
          matchKind: 'context',
          parentAvailability: 'none',
          branchStartedAt: 490,
          qualifyingChildCount: 1,
          matchingDescendantCount: 1,
        },
      ])
    },
    MATRIX_TIMEOUT_MS,
  )

  test('the actual page statement seeds qualified from page family and removes the two full spools', async () => {
    await seed(harness.db)
    const page = createDatabaseTaskListPage(harness.db, composeOwnerIdentityQueries(harness.db))
    const recording = harness.recordStatements()
    try {
      const actual = await page.list(VIEWER, { subject: 'workflow', limit: '3' }, OPTIONS)
      expect(actual.items).toHaveLength(3)
    } finally {
      recording.stop()
    }
    const statements = recording.statements.filter((statement) =>
      statement.sql.includes('non_view_matches AS MATERIALIZED'),
    )
    expect(statements).toHaveLength(1)
    const statement = statements[0]!
    expect(statement.rows).toBe(4)
    expect(statement.sql).toContain('matches AS NOT MATERIALIZED')
    expect(statement.sql).toContain('roots AS NOT MATERIALIZED')
    expect(statement.sql).toContain('SELECT f.id FROM fam f WHERE f.is_match = 1')
    expect(statement.sql).not.toContain('SELECT m.id FROM matches m JOIN page_roots')
    const plan = await harness.explain(statement)
    expect(plan.length).toBeGreaterThan(0)
    expect(plan).not.toMatch(/\bMATERIALIZE matches\b|\bCTE matches\b/)
    expect(plan).not.toMatch(/\bMATERIALIZE roots\b|\bCTE roots\b/)
    expect(plan).toContain('qualified')
  })

  test('the retained recursive UNION terminates a repeated parent and counts each matched row once', async () => {
    await seed(harness.db)
    await harness.db.update(tasks).set({ parentTaskId: 'c09' }).where(eq(tasks.id, 'c09'))
    expect(await fixtureRowsDigest(harness.db)).toBe(
      'd7ace4653b9b868b0ba5e78b9d30a7031be13115a4f858925e75b13736e57498',
    )
    const page = createDatabaseTaskListPage(harness.db, composeOwnerIdentityQueries(harness.db))
    const actual = await page.list(VIEWER, { statuses: 'running', limit: '50' }, OPTIONS)
    expect(actual.items.map((item) => item.id)).toEqual(['r03', 'r01', 'r07'])
    expect(actual.items.find((item) => item.id === 'r07')?.listContext).toEqual({
      matchKind: 'context',
      parentAvailability: 'none',
      branchStartedAt: 450,
      qualifyingChildCount: 0,
      matchingDescendantCount: 1,
    })
  })
})
