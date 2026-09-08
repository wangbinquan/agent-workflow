// RFC-359 W18: the original count queries keep their rows and statement
// boundaries when the two additive covering indexes are present. This tiny
// fixture proves results and plans; the original full HTTP gate owns latency.
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { scheduledTasks, taskRepos, tasks, users, workflows } from '@/db/schema'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { createTaskOverviewQuery } from '@/modules/task-execution/infrastructure/taskOverviewQuery'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const since = 1_700_000_000_000
const repoIds = ['w18-repo-a', 'w18-repo-b', 'w18-repo-c'] as const
const indexes = [
  { name: 'idx_tasks_cached_repo_task', columns: ['cached_repo_id', 'id'] },
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
  await db.insert(users).values({
    id: 'w18-user',
    username: 'w18',
    displayName: 'w18',
    role: 'admin',
    status: 'active',
    passwordHash: 'fixture',
    createdAt: since,
    updatedAt: since,
  })
  await db.insert(workflows).values({ id: 'w18-wf', name: 'w18', definition: '{}' })
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
    await db.insert(tasks).values({
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
  await db.insert(taskRepos).values(
    [
      ['b', 0, repoIds[0]],
      ['b', 1, repoIds[0]],
      ['e', 0, repoIds[0]],
      ['f', 0, null],
      ['j', 0, repoIds[1]],
    ].map(([taskId, repoIndex, cachedRepoId]) => ({
      taskId: String(taskId),
      repoIndex: Number(repoIndex),
      cachedRepoId: cachedRepoId === null ? null : String(cachedRepoId),
      repoPath: '/fixture/repo',
      branch: `task/${taskId}`,
      worktreePath: `/fixture/${taskId}`,
    })),
  )
  await db.insert(scheduledTasks).values({
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
      ...(await composeRepositoryWorkspaceStore(harness.db).cachedRepoReferenceCounts(repoIds)),
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
  // Promise.all; the three repository reads start afterwards and are serial.
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
  const explicit = statement('SELECT explicit references', repoIds)
  const legacy = statement('SELECT legacy references', repoIds)
  const scheduled = statement('SELECT scheduled references', [])
  const original = [running, awaiting, done, failed, explicit, legacy, scheduled]
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
          countStatementContract([first, second, third, fourth, explicit, legacy, scheduled]),
        ).toEqual(expected)
      }
    }
  }
  const changed = [
    [running, awaiting, done, done, explicit, legacy, scheduled],
    [running, awaiting, done, failed, explicit, legacy, scheduled, scheduled],
    [running, awaiting, done, failed, explicit, legacy],
    [{ ...running, sql: running.sql + ' LIMIT 1' }, ...original.slice(1)],
    [{ ...running, params: running.params + 1 }, ...original.slice(1)],
    [{ ...running, values: ['done'] }, ...original.slice(1)],
    [running, awaiting, done, failed, legacy, explicit, scheduled],
    [running, awaiting, done, explicit, failed, legacy, scheduled],
  ]
  for (const statements of changed) expect(countStatementContract(statements)).not.toEqual(expected)
  expect(
    countStatementContract([running, running, done, failed, explicit, legacy, scheduled]),
  ).toEqual(countStatementContract([failed, running, done, running, explicit, legacy, scheduled]))
  expect(original).toEqual([running, awaiting, done, failed, explicit, legacy, scheduled])
})

describeEachProvider('RFC-359 W18 count covering indexes', (harness) => {
  test('actual provider catalogs contain both exact column sequences', async () => {
    for (const index of indexes) {
      if (harness.capabilities.provider === 'sqlite') {
        const columns = await harness.db.all<{ name: string }>(
          sql.raw(`PRAGMA index_info('${index.name}')`),
        )
        expect(columns.map((column) => column.name)).toEqual(index.columns)
      } else {
        const rows = await harness.db.all<{ indexdef: string }>(sql`
          SELECT indexdef FROM pg_indexes WHERE schemaname = 'agent_workflow' AND indexname = ${index.name}
        `)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.indexdef).toContain(`(${index.columns.join(', ')})`)
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
    const beforeRows = await harness.db.select().from(tasks).orderBy(tasks.id)
    const withIndexes = await counts(harness)
    expect(withIndexes.overview).toEqual({ running: 3, awaiting: 2, done7d: 1, failed7d: 1 })
    expect(withIndexes.references).toEqual([
      [repoIds[0], 6],
      [repoIds[1], 5],
    ])
    expect(withIndexes.statements).toHaveLength(7)
    const history = await loadPostgresqlMigrationHistory()
    const recreate =
      harness.capabilities.provider === 'sqlite'
        ? indexes.map(
            (index) => `CREATE INDEX ${index.name} ON tasks (${index.columns.join(', ')})`,
          )
        : history.steps[0]!.indexAdditions.map((addition) => addition.statement.sql)
    if (harness.capabilities.provider === 'sqlite') {
      const plans = await Promise.all(
        withIndexes.statements.map((statement) => harness.explain(statement)),
      )
      expect(
        plans
          .slice(0, 4)
          .every((plan) => plan.includes('COVERING INDEX idx_tasks_overview_counts')),
      ).toBe(true)
      expect(plans[5]).toContain('COVERING INDEX idx_tasks_cached_repo_task')
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
      expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(beforeRows)
    } finally {
      for (const statement of recreate.slice(0, removed)) await harness.executeFixtureDdl(statement)
    }
    const interruption = new Error('count mutation rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.update(tasks).set({ status: 'done', finishedAt: since }).where(eq(tasks.id, 'a'))
        expect(await createTaskOverviewQuery(tx).load({ actor, since })).toEqual({
          running: 2,
          awaiting: 2,
          done7d: 2,
          failed7d: 1,
        })
        throw interruption
      }),
    ).rejects.toBe(interruption)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(beforeRows)
    expect((await counts(harness)).overview).toEqual(withIndexes.overview)
    expect(await composeRepositoryWorkspaceStore(harness.db).cachedRepoReferenceCounts([])).toEqual(
      new Map(),
    )
    expect(
      await composeRepositoryWorkspaceStore(harness.db).cachedRepoReferenceCounts(['w18-unknown']),
    ).toEqual(new Map())
  })
})
