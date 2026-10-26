import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-359 W18: the original count queries keep their rows and statement
// boundaries when the two additive covering indexes are present. This tiny
// fixture proves results and plans; the original full HTTP gate owns latency.
import {
  patchTaskFixture,
  taskFixture,
  taskRepoFixture,
  workflowFixture,
  readTaskFixtures,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { createTaskOverviewQuery } from '@/modules/task-execution/infrastructure/taskOverviewQuery'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const since = 1_700_000_000_000
const repoIds = ['w18-repo-a', 'w18-repo-b', 'w18-repo-c'] as const
const indexes = [
  {
    name: 'task_workspaces_requested_cached_repo',
    columns: [null, 'task_id'],
    expression: 'requested_source',
  },
  { name: 'task_repository_mounts_cached_repo_task', columns: ['cached_repo_id', 'task_id'] },
  {
    name: 'idx_tasks_overview_counts',
    columns: ['status', 'parent_task_id', 'catalog_visibility', 'finished_at'],
  },
]
const actor = buildActor({
  user: { id: 'w18-user', username: 'w18', displayName: 'w18', role: 'admin', status: 'active' },
  source: 'session',
})

async function seed(harness: ProviderHarness) {
  const db = harness.db
  const { users, scheduledTasks } = tablesOf(db)
  await insertOne(db, users, {
    id: 'w18-user',
    username: 'w18',
    displayName: 'w18',
    role: 'admin',
    status: 'active',
    passwordHash: 'fixture',
    createdAt: since,
    updatedAt: since,
  })
  await workflowFixture(db, { id: 'w18-wf', name: 'w18', definition: '{}' })
  const seeds = [
    { id: 'a', status: 'running', cachedRepoId: repoIds[0] },
    { id: 'b', status: 'running', cachedRepoId: repoIds[0] },
    { id: 'c', status: 'running', parentTaskId: 'a', cachedRepoId: repoIds[1] },
    { id: 'd', status: 'running', catalogVisibility: 'internal', cachedRepoId: repoIds[1] },
    { id: 'e', status: 'awaiting_review', cachedRepoId: repoIds[2] },
    { id: 'f', status: 'awaiting_human', cachedRepoId: repoIds[0] },
    { id: 'g', status: 'done', finishedAt: since, cachedRepoId: repoIds[0] },
    { id: 'h', status: 'done', finishedAt: since - 1, cachedRepoId: repoIds[1] },
    { id: 'i', status: 'failed', finishedAt: since, cachedRepoId: repoIds[1] },
    { id: 'j', status: 'failed', cachedRepoId: repoIds[2] },
    { id: 'k', status: 'pending', cachedRepoId: repoIds[0] },
    { id: 'l', status: 'running' },
  ] as const
  // Parent a must exist before its child c on both providers.
  for (const item of seeds) {
    await taskFixture(db, {
      workflowId: 'w18-wf',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '/fixture/repo',
      worktreePath: `/fixture/${item.id}`,
      name: item.id,
      baseBranch: 'main',
      branch: `task/${item.id}`,
      startedAt: since,
      branchStartedAt: since,
      rootTaskId: item.id,
      catalogVisibility: 'public',
      ...item,
    })
  }
  await taskRepoFixture(
    db,
    [
      ['b', 0, repoIds[0]],
      ['b', 1, repoIds[0]],
      ['e', 0, repoIds[0]],
      ['f', 0, null],
      ['j', 0, repoIds[1]],
    ].map(([taskId, repoIndex, cachedRepoId]) => ({
      taskId: String(taskId),
      repoIndex: Number(repoIndex),
      mountPath: `repo-${repoIndex}`,
      cachedRepoId: cachedRepoId === null ? null : String(cachedRepoId),
      repoPath: '/fixture/repo',
      branch: `task/${taskId}`,
      worktreePath: `/fixture/${taskId}`,
    })),
  )
  await insertOne(db, scheduledTasks, {
    id: 'w18-schedule',
    name: 'w18',
    ownerUserId: 'w18-user',
    launchKind: 'workflow',
    launchPayload: JSON.stringify({
      repos: [{ cachedRepoId: repoIds[0] }, { cachedRepoId: repoIds[0] }],
    }),
    scheduleSpec: JSON.stringify({ kind: 'cron', cron: '0 0 * * *', tz: 'UTC' }),
    enabled: true,
    createdAt: since,
    updatedAt: since,
  })
}

async function counts(harness: ProviderHarness) {
  const recording = harness.recordStatements()
  try {
    const overview = await createTaskOverviewQuery(harness.db).load({ actor, since })
    const references = [
      ...(await composeRepositoryWorkspaceStore(
        harness.db,
        composeSourceControlTaskPorts(harness.db),
      ).cachedRepoReferenceCounts(repoIds)),
    ].sort(([left], [right]) => left.localeCompare(right))
    return { overview, references, statements: [...recording.statements] }
  } finally {
    recording.stop()
  }
}

function countStatementContract(
  statements: readonly Pick<RecordedStatement, 'sql' | 'params' | 'values'>[],
) {
  const projected = statements.map(({ sql, params, values }) => ({ sql, params, values }))
  // PG records completion order. Only the first four overview reads run in
  // Promise.all; the owner reference count and schedule read follow serially.
  const overview = projected.slice(0, 4).sort((left, right) => {
    const leftKey = JSON.stringify(left)
    const rightKey = JSON.stringify(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  return [...overview, ...projected.slice(4)]
}

test('count statement comparison ignores only concurrent completion order', () => {
  const statement = (sql: string, values: readonly unknown[]) => ({
    sql,
    params: values.length,
    values,
  })
  const running = statement('SELECT count(*) FROM tasks WHERE status = ?', ['running'])
  const awaiting = statement('SELECT count(*) FROM tasks WHERE status IN (?, ?)', [
    'awaiting_review',
    'awaiting_human',
  ])
  const done = statement('SELECT count(*) FROM tasks WHERE status = ? AND finished_at >= ?', [
    'done',
    since,
  ])
  const failed = statement('SELECT count(*) FROM tasks WHERE status = ? AND finished_at >= ?', [
    'failed',
    since,
  ])
  const references = statement('SELECT mounted and requested-only references', repoIds)
  const scheduled = statement('SELECT scheduled references', [])
  const original = [running, awaiting, done, failed, references, scheduled]
  const expected = countStatementContract(original)

  for (const first of [running, awaiting, done, failed]) {
    for (const second of [running, awaiting, done, failed].filter((item) => item !== first)) {
      for (const third of [running, awaiting, done, failed].filter(
        (item) => item !== first && item !== second,
      )) {
        const fourth = [running, awaiting, done, failed].find(
          (item) => item !== first && item !== second && item !== third,
        )!
        expect(
          countStatementContract([first, second, third, fourth, references, scheduled]),
        ).toEqual(expected)
      }
    }
  }
  const changed = [
    [running, awaiting, done, done, references, scheduled],
    [running, awaiting, done, failed, references, scheduled, scheduled],
    [running, awaiting, done, failed, references],
    [{ ...running, sql: running.sql + ' LIMIT 1' }, ...original.slice(1)],
    [{ ...running, params: running.params + 1 }, ...original.slice(1)],
    [{ ...running, values: ['done'] }, ...original.slice(1)],
    [running, awaiting, done, failed, scheduled, references],
    [running, awaiting, done, references, failed, scheduled],
  ]
  for (const statements of changed) expect(countStatementContract(statements)).not.toEqual(expected)
  expect(countStatementContract([running, running, done, failed, references, scheduled])).toEqual(
    countStatementContract([failed, running, done, running, references, scheduled]),
  )
  expect(original).toEqual([running, awaiting, done, failed, references, scheduled])
})

describeEachProvider('RFC-359 W18 count covering indexes', (harness) => {
  test('actual provider catalogs contain the overview and both repository-reference indexes', async () => {
    for (const index of indexes) {
      if (harness.capabilities.provider === 'sqlite') {
        const columns = await rawRows<{ name: string | null }>(
          harness.db,
          sql.raw(`PRAGMA index_info('${index.name}')`),
        )
        expect(columns.map((column) => column.name)).toEqual(index.columns)
      } else {
        const rows = await rawRows<{ indexdef: string }>(
          harness.db,
          sql`
          SELECT indexdef FROM pg_indexes WHERE schemaname = 'agent_workflow' AND indexname = ${index.name}
        `,
        )
        expect(rows).toHaveLength(1)
        if ('expression' in index) {
          expect(rows[0]!.indexdef).toContain('requested_source')
          expect(rows[0]!.indexdef).toContain('cachedRepoId')
          expect(rows[0]!.indexdef).toContain('task_id')
        } else expect(rows[0]!.indexdef).toContain(`(${index.columns.join(', ')})`)
        expect(rows[0]!.indexdef).not.toContain(' WHERE ')
      }
    }
  })

  test('old and indexed count reads are identical across empty, boundary and rollback states', async () => {
    expect((await counts(harness)).overview).toEqual({
      running: 0,
      awaiting: 0,
      done7d: 0,
      failed7d: 0,
    })
    await seed(harness)
    const beforeRows = await readTaskFixtures(harness.db, undefined, { orderBy: [{ field: 'id' }] })
    const withIndexes = await counts(harness)
    expect(withIndexes.overview).toEqual({ running: 3, awaiting: 2, done7d: 1, failed7d: 1 })
    expect(withIndexes.references).toEqual([
      [repoIds[0], 6],
      [repoIds[1], 5],
    ])
    // RFC-395 O1 M12/M25: mounted and requested-only counts share one indexed owner query.
    expect(withIndexes.statements).toHaveLength(6)
    const statements = persistenceHead()[harness.capabilities.provider].head
    const recreate = indexes.map((index) => {
      const declaration = statements.find(
        (statement) =>
          statement.kind === 'index' && statement.logicalId.endsWith(`:index:${index.name}`),
      )
      if (!declaration) throw new Error(`missing target index ${index.name}`)
      return declaration.sql
    })
    if (harness.capabilities.provider === 'sqlite') {
      const plans = await Promise.all(
        withIndexes.statements.map((statement) => harness.explain(statement)),
      )
      expect(
        plans
          .slice(0, 4)
          .every((plan) => plan.includes('COVERING INDEX idx_tasks_overview_counts')),
      ).toBe(true)
      expect(plans[4]).toContain('COVERING INDEX task_workspaces_requested_cached_repo')
      expect(plans[4]).toContain('COVERING INDEX task_repository_mounts_cached_repo_task')
    }
    let removed = 0
    try {
      for (const index of indexes) {
        const prefix = harness.capabilities.provider === 'postgresql' ? 'agent_workflow.' : ''
        await harness.executeFixtureDdl(`DROP INDEX ${prefix}${index.name}`)
        removed += 1
      }
      const original = await counts(harness)
      expect(original.overview).toEqual(withIndexes.overview)
      expect(original.references).toEqual(withIndexes.references)
      expect(countStatementContract(original.statements)).toEqual(
        countStatementContract(withIndexes.statements),
      )
      expect(
        await readTaskFixtures(harness.db, undefined, {
          orderBy: [{ field: 'id', direction: 'asc' }],
        }),
      ).toEqual(beforeRows)
    } finally {
      for (const statement of recreate.slice(0, removed)) await harness.executeFixtureDdl(statement)
    }
    const interruption = new Error('count mutation rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        await patchTaskFixture(tx, { id: 'a' }, { status: 'done', finishedAt: since })
        expect(await createTaskOverviewQuery(tx).load({ actor, since })).toEqual({
          running: 2,
          awaiting: 2,
          done7d: 2,
          failed7d: 1,
        })
        throw interruption
      }),
    ).rejects.toBe(interruption)
    expect(
      await readTaskFixtures(harness.db, undefined, {
        orderBy: [{ field: 'id', direction: 'asc' }],
      }),
    ).toEqual(beforeRows)
    expect((await counts(harness)).overview).toEqual(withIndexes.overview)
    expect(
      await composeRepositoryWorkspaceStore(
        harness.db,
        composeSourceControlTaskPorts(harness.db),
      ).cachedRepoReferenceCounts([]),
    ).toEqual(new Map())
    expect(
      await composeRepositoryWorkspaceStore(
        harness.db,
        composeSourceControlTaskPorts(harness.db),
      ).cachedRepoReferenceCounts(['w18-unknown']),
    ).toEqual(new Map())
  })
})
