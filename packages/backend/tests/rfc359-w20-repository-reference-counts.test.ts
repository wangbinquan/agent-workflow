// RFC-359 W20: the page's legacy reference count changes only its exclusion
// expression. Real catalogs prove the non-null premise; the old SQL remains
// the data oracle. These tiny cases make no PostgreSQL performance claim.
import { expect, test } from 'bun:test'
import { eq, sql, type SQLWrapper } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { scheduledTasks, taskRepos, tasks, users, workflows } from '@/db/schema'
import { RepositoryWorkspaceSqlStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceSqlStore'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const since = 1_700_000_000_000
const repoIds = ['w18-repo-a', 'w18-repo-b', 'w18-repo-c'] as const

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

interface ObservedRead {
  readonly rows: readonly Record<string, unknown>[]
}

function observedStore(db: ProviderNeutralDatabase, reads: ObservedRead[]) {
  return new RepositoryWorkspaceSqlStore(
    {
      async all<T extends Record<string, unknown>>(query: SQLWrapper): Promise<readonly T[]> {
        const rows = await db.all<T>(query)
        reads.push({ rows })
        return rows
      },
      async run() {
        throw new Error('reference-count-unexpected-write')
      },
      async cachedRepoFacets() {
        throw new Error('reference-count-unexpected-facets')
      },
    },
    engineOf(db),
  )
}

// The three original SQL statements are the reference, including the original
// correlated exclusion. Every result below still comes from the selected DB.
function originalCountQueries(ids: readonly string[]): readonly SQLWrapper[] {
  const idSet = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  return [
    sql`
      SELECT ${taskRepos.cachedRepoId} AS cached_repo_id, count(distinct ${taskRepos.taskId}) AS count
      FROM ${taskRepos}
      WHERE ${taskRepos.cachedRepoId} IN (${idSet})
      GROUP BY ${taskRepos.cachedRepoId}
    `,
    sql`
      SELECT ${tasks.cachedRepoId} AS cached_repo_id, count(*) AS count
      FROM ${tasks}
      WHERE ${tasks.cachedRepoId} IN (${idSet})
        AND NOT EXISTS (
          SELECT 1 FROM ${taskRepos} WHERE ${taskRepos.taskId} = ${tasks.id}
        )
      GROUP BY ${tasks.cachedRepoId}
    `,
    sql`
      SELECT ${scheduledTasks.launchPayload} AS launch_payload FROM ${scheduledTasks}
    `,
  ]
}

function statementContract(statement: RecordedStatement) {
  const { sql, params, values, rows } = statement
  return { sql, params, values, rows }
}

function sortedRows(rows: readonly Record<string, unknown>[]) {
  return [...rows].sort((left, right) =>
    String(left.cached_repo_id).localeCompare(String(right.cached_repo_id)),
  )
}

function sortedCounts(counts: ReadonlyMap<string, number>) {
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
}

describeEachProvider('RFC-359 W20 repository reference count exclusion', (harness) => {
  test('actual provider columns enforce both non-null task ID premises', async () => {
    const columns: { table: string; column: string; notNull: boolean }[] = []
    if (harness.capabilities.provider === 'sqlite') {
      for (const [table, column] of [
        ['task_repos', 'task_id'],
        ['tasks', 'id'],
      ] as const) {
        const rows = await harness.db.all<{ name: string; notnull: number }>(
          sql.raw(`PRAGMA table_info('${table}')`),
        )
        const matches = rows.filter((row) => row.name === column)
        expect(matches).toHaveLength(1)
        columns.push({ table, column, notNull: matches[0]!.notnull === 1 })
      }
    } else {
      const rows = await harness.db.all<{
        table_name: string
        column_name: string
        is_nullable: string
      }>(sql`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'agent_workflow'
          AND ((table_name = 'task_repos' AND column_name = 'task_id')
            OR (table_name = 'tasks' AND column_name = 'id'))
        ORDER BY table_name, column_name
      `)
      columns.push(
        ...rows.map((row) => ({
          table: row.table_name,
          column: row.column_name,
          notNull: row.is_nullable === 'NO',
        })),
      )
    }
    expect(columns).toEqual([
      { table: 'task_repos', column: 'task_id', notNull: true },
      { table: 'tasks', column: 'id', notNull: true },
    ])
  })

  test('42 distributions preserve the original counts, three reads and rollback', async () => {
    await seed(harness)
    let comparisons = 0
    async function compare(
      expectedForAllIds: readonly (readonly [string, number])[],
      db: ProviderNeutralDatabase = harness.db,
    ) {
      const selections: readonly (readonly string[])[] = [
        repoIds,
        [repoIds[0]],
        [repoIds[1]],
        [repoIds[2]],
        ['not-listed'],
        [repoIds[0], repoIds[0], repoIds[1]],
        [],
      ]
      for (const ids of selections) {
        const reads: ObservedRead[] = []
        const recording = harness.recordStatements()
        let currentStatements: RecordedStatement[]
        let counts: ReadonlyMap<string, number>
        try {
          counts = await observedStore(db, reads).cachedRepoReferenceCounts(ids)
          currentStatements = [...recording.statements]
        } finally {
          recording.stop()
        }
        const expected = new Map(expectedForAllIds.filter(([id]) => ids.includes(id)))
        expect(sortedCounts(counts)).toEqual(sortedCounts(expected))
        expect(reads).toHaveLength(ids.length === 0 ? 0 : 3)
        expect(currentStatements).toHaveLength(ids.length === 0 ? 0 : 3)
        if (ids.length > 0) {
          const originalReads: (readonly Record<string, unknown>[])[] = []
          const originalRecording = harness.recordStatements()
          try {
            for (const query of originalCountQueries(ids)) {
              originalReads.push(await db.all<Record<string, unknown>>(query))
            }
          } finally {
            originalRecording.stop()
          }
          const originals = originalRecording.statements
          expect(originals).toHaveLength(3)
          for (let index = 0; index < 3; index += 1) {
            expect(sortedRows(reads[index]!.rows)).toEqual(sortedRows(originalReads[index]!))
          }
          // Preserve the first/last SQL bytes, bindings, counts and serial slots.
          expect(statementContract(currentStatements[0]!)).toEqual(statementContract(originals[0]!))
          expect(statementContract(currentStatements[2]!)).toEqual(statementContract(originals[2]!))
          expect(currentStatements[1]!.params).toBe(originals[1]!.params)
          expect(currentStatements[1]!.values).toEqual(originals[1]!.values)
          expect(currentStatements[1]!.rows).toBe(originals[1]!.rows)
        }
        comparisons += 1
      }
    }

    // Goldens captured from the old shared store before changing its SQL.
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 5],
    ])
    await harness.db.delete(taskRepos)
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    await harness.db.insert(taskRepos).values([
      {
        taskId: 'b',
        repoIndex: 0,
        cachedRepoId: null,
        repoPath: '/fixture/one',
        branch: 'main',
        worktreePath: '/fixture/one',
      },
      {
        taskId: 'b',
        repoIndex: 1,
        cachedRepoId: 'outside-selected-ids',
        repoPath: '/fixture/two',
        branch: 'main',
        worktreePath: '/fixture/two',
      },
    ])
    await compare([
      [repoIds[0], 5],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    await harness.db.delete(taskRepos)
    const taskRows = await harness.db
      .select({ id: tasks.id, cachedRepoId: tasks.cachedRepoId })
      .from(tasks)
      .orderBy(tasks.id)
    for (const row of taskRows) {
      await harness.db.insert(taskRepos).values({
        taskId: row.id,
        repoIndex: 0,
        cachedRepoId: row.cachedRepoId,
        repoPath: '/fixture/all',
        branch: 'main',
        worktreePath: `/fixture/${row.id}`,
      })
    }
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    const beforeTasks = await harness.db.select().from(tasks).orderBy(tasks.id)
    const beforeRepos = await harness.db
      .select()
      .from(taskRepos)
      .orderBy(taskRepos.taskId, taskRepos.repoIndex)
    const interruption = new Error('reference count rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.update(tasks).set({ cachedRepoId: repoIds[2] }).where(eq(tasks.id, 'a'))
        await tx.delete(taskRepos).where(eq(taskRepos.taskId, 'a'))
        await compare(
          [
            [repoIds[0], 5],
            [repoIds[1], 4],
            [repoIds[2], 3],
          ],
          tx,
        )
        throw interruption
      }),
    ).rejects.toBe(interruption)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(beforeTasks)
    expect(
      await harness.db.select().from(taskRepos).orderBy(taskRepos.taskId, taskRepos.repoIndex),
    ).toEqual(beforeRepos)
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    expect(comparisons).toBe(42)
  }, 30_000)
})
