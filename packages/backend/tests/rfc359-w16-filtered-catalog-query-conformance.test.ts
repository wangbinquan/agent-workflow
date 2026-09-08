// RFC-359 AC11: full HTTP run 34196371681 showed 100,000 correlated alert
// lookups and a whole-task scan for a 51-root family. Keep the complete
// catalog-filtered page, cursor and facet contract while changing that SQL.
import { expect, test } from 'bun:test'
import type { TaskOperationsPage } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createDatabaseTaskListPage,
  taskListViewerOf,
  type TaskOperationsPageOptions,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import { describeEachProvider } from './helpers/eachProvider'
import { computeForestBackfill } from './helpers/taskForestBackfill'

interface SeedTask {
  id: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  parent?: string
  internal?: boolean
  workgroup?: string
  agent?: string
}

const ROWS: readonly SeedTask[] = [
  { id: 'a', status: 'done', startedAt: 500 },
  { id: 'a-mid', parent: 'a', status: 'done', startedAt: 400 },
  { id: 'a-leaf', parent: 'a-mid', status: 'running', startedAt: 300 },
  { id: 'a-side', parent: 'a', status: 'done', startedAt: 600 },
  { id: 'b', status: 'running', startedAt: 700 },
  { id: 'c', status: 'done', startedAt: 700 },
  { id: 'd', status: 'failed', startedAt: 100 },
  { id: 'workgroup', status: 'running', startedAt: 900, workgroup: 'wg' },
  { id: 'agent', status: 'running', startedAt: 1000, agent: 'worker' },
  { id: 'internal', status: 'failed', startedAt: 1100, internal: true },
  {
    id: 'internal-child',
    parent: 'internal',
    status: 'running',
    startedAt: 1200,
    internal: true,
  },
]

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'admin',
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({ id: 'wf', name: '雪 workflow', definition: '{}' })
  const backfill = computeForestBackfill(
    ROWS.map((row) => ({ ...row, parentTaskId: row.parent ?? null })),
  )
  for (const row of ROWS) {
    await db.insert(tasks).values({
      id: row.id,
      name: `task ${row.id}`,
      workflowId: 'wf',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '/repos/catalog',
      worktreePath: `/workspaces/${row.id}`,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      status: row.status,
      startedAt: row.startedAt,
      runningMs: 0,
      ownerUserId: 'admin',
      parentTaskId: row.parent ?? null,
      rootTaskId: backfill.rootTaskId.get(row.id) ?? row.id,
      branchStartedAt: backfill.branchStartedAt.get(row.id) ?? row.startedAt,
      catalogVisibility: row.internal === true ? 'internal' : 'public',
      workgroupId: row.workgroup ?? null,
      workgroupConfigJson:
        row.workgroup === undefined ? null : JSON.stringify({ workgroupName: 'Squad' }),
      sourceAgentName: row.agent ?? null,
    })
  }
}

async function addAlerts(db: ProviderNeutralDatabase): Promise<void> {
  for (const [taskId, open, resolved] of [
    ['a-leaf', 3, 1],
    ['a-mid', 0, 2],
    ['b', 1, 0],
  ] as const) {
    for (let index = 0; index < open + resolved; index += 1) {
      await db.insert(lifecycleAlerts).values({
        id: `alert-${taskId}-${index}`,
        taskId,
        rule: 'stuck',
        severity: 'warn',
        detail: 'catalog query fixture',
        detectedAt: 1,
        resolvedAt: index < open ? null : 2,
      })
    }
  }
}

function catalog(db: ProviderNeutralDatabase) {
  const page = createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db))
  const viewer = taskListViewerOf(
    buildActor({
      user: {
        id: 'admin',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    }),
  )
  return async (
    query: TaskOperationsRawQuery,
    pipeline: 'auto' | 'exhaustive',
    visibility: TaskOperationsPageOptions['catalogVisibility'] = 'public',
  ) => {
    const pages: TaskOperationsPage[] = []
    let cursor: string | undefined
    for (let count = 0; count < ROWS.length + 1; count += 1) {
      const result = await page.list(
        viewer,
        { ...query, limit: '2', ...(cursor === undefined ? {} : { cursor }) },
        { pipeline, catalogVisibility: visibility },
      )
      pages.push(result)
      if (result.nextCursor === null) return pages
      cursor = result.nextCursor
    }
    throw new Error('catalog fixture pagination did not terminate')
  }
}

describeEachProvider('RFC-359 filtered catalog query contract', (harness) => {
  test('catalog options preserve complete pages, cursors, ties, ancestors and nonempty facets', async () => {
    const db = harness.db
    await seed(db)
    await addAlerts(db)
    const collect = catalog(db)
    const matrix: TaskOperationsRawQuery[] = [
      { subject: 'workflow' },
      { subject: 'workflow', view: 'attention' },
      { subject: 'workflow', view: 'active' },
      { subject: 'workflow', view: 'finished' },
      { subject: 'workflow', statuses: 'running' },
      { subject: 'workflow', q: 'a-leaf' },
      { subject: 'workflow', q: '雪' },
      { subject: 'workflow', q: 'absent' },
      { subject: 'workgroup' },
      { subject: 'agent' },
      { subject: 'workflow', parent_id: 'a' },
      { subject: 'workflow', parent_id: 'a', view: 'attention' },
    ]
    for (const query of matrix) {
      expect(await collect(query, 'auto'), JSON.stringify(query)).toEqual(
        await collect(query, 'exhaustive'),
      )
    }
    const all = await collect({ subject: 'workflow' }, 'auto')
    expect(all).toHaveLength(2)
    expect(all.flatMap((page) => page.items.map((item) => item.id))).toEqual(['c', 'b', 'a', 'd'])
    expect(all[0]?.nextCursor).toBeString()
    expect(all[0]).toMatchObject({
      kind: 'root',
      facets: { all: 7, active: 2, attention: 3, finished: 5 },
    })
    expect(all[1]?.items[0]?.listContext).toMatchObject({
      matchKind: 'self',
      branchStartedAt: 600,
      matchingDescendantCount: 3,
      qualifyingChildCount: 2,
    })
    const attention = await collect({ subject: 'workflow', view: 'attention' }, 'auto')
    expect(attention.flatMap((page) => page.items.map((item) => item.id))).toEqual(['b', 'a', 'd'])
    expect(attention[0]?.items[1]?.listContext).toMatchObject({
      matchKind: 'context',
      branchStartedAt: 300,
      matchingDescendantCount: 1,
      qualifyingChildCount: 1,
    })
    expect(await collect({ subject: 'workflow' }, 'auto', 'internal')).toEqual(
      await collect({ subject: 'workflow' }, 'exhaustive', 'internal'),
    )
  })

  test('an empty alert table and an unmatched filter preserve the original facet contract', async () => {
    const db = harness.db
    await seed(db)
    const collect = catalog(db)
    for (const query of [
      { subject: 'workflow' },
      { subject: 'workflow', view: 'attention' },
      { subject: 'workflow', q: 'absent' },
    ]) {
      expect(await collect(query, 'auto')).toEqual(await collect(query, 'exhaustive'))
    }
    const all = await collect({ subject: 'workflow' }, 'auto')
    expect(all[0]).toMatchObject({ facets: { all: 7, active: 2, attention: 1, finished: 5 } })
    expect(all.flatMap((page) => page.items)).toHaveLength(4)
  })
})
