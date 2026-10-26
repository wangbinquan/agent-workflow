import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { taskReadColumns } from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { createTaskRepositoryUsageQueries } from '@/modules/task-execution/infrastructure/taskRepositoryUsage'
import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC-359 W20: the page's legacy reference count changes only its exclusion
// expression. Real catalogs prove the non-null premise; the old SQL remains
// the data oracle. These tiny cases make no PostgreSQL performance claim.
import { RepositoryWorkspaceSqlStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceSqlStore'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { rawRows } from '@/platform/persistence/queryHelpers'

import { insertOne } from '@/platform/persistence/singleInsert'
import { expect, test } from 'bun:test'
import { eq, sql, type SQLWrapper } from 'drizzle-orm'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  patchTaskFixture,
  readTaskFixtures,
  readTaskRepoFixtures,
  taskFixture,
  taskRepoFixture,
  workflowFixture,
} from './helpers/model'
import type { RecordedStatement } from './helpers/statementRecorder'

const since = 1_700_000_000_000
const repoIds = ['w18-repo-a', 'w18-repo-b', 'w18-repo-c'] as const

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

interface ObservedRead {
  readonly rows: readonly Record<string, unknown>[]
}

function observedStore(db: PersistenceDb, reads: ObservedRead[]) {
  const all = async <T extends Record<string, unknown>>(
    query: SQLWrapper,
  ): Promise<readonly T[]> => {
    const rows = await rawRows<T>(db, query)
    reads.push({ rows })
    return rows
  }
  return new RepositoryWorkspaceSqlStore(
    {
      db,
      all,
      async run() {
        throw new Error('reference-count-unexpected-write')
      },
    },
    engineOf(db),
    { ...composeSourceControlTaskPorts(db), taskUsage: createTaskRepositoryUsageQueries(db, all) },
  )
}

// The three original SQL statements are the reference, including the original
// correlated exclusion. Every result below still comes from the selected DB.
function originalCountQueries(db: object, ids: readonly string[]): readonly SQLWrapper[] {
  const idSet = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const { scheduledTasks } = tablesOf(db)
  const { taskRepositoryMounts: taskRepos, tasks } = tablesOf(db)
  return [
    sql`
      SELECT ${taskRepos.cachedRepoId} AS cached_repo_id, count(distinct ${taskRepos.taskId}) AS count
      FROM ${taskRepos}
      WHERE ${taskRepos.cachedRepoId} IN (${idSet})
      GROUP BY ${taskRepos.cachedRepoId}
    `,
    sql`
      SELECT ${taskReadColumns(db).cachedRepoId} AS cached_repo_id, count(*) AS count
      FROM ${tasks}
      WHERE ${taskReadColumns(db).cachedRepoId} IN (${idSet})
        AND NOT EXISTS (
          SELECT 1 FROM ${taskRepos} WHERE ${taskRepos.taskId} = ${tasks.id}
        )
      GROUP BY ${taskReadColumns(db).cachedRepoId}
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
        ['task_repository_mounts', 'task_id'],
        ['tasks', 'id'],
      ] as const) {
        const rows = await rawRows<{ name: string; notnull: number }>(
          harness.db,
          sql.raw(`PRAGMA table_info('${table}')`),
          { notnull: 'int' },
        )
        const matches = rows.filter((row) => row.name === column)
        expect(matches).toHaveLength(1)
        columns.push({ table, column, notNull: matches[0]!.notnull === 1 })
      }
    } else {
      const rows = await rawRows<{
        table_name: string
        column_name: string
        is_nullable: string
      }>(
        harness.db,
        sql`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'agent_workflow'
          AND ((table_name = 'task_repository_mounts' AND column_name = 'task_id')
            OR (table_name = 'tasks' AND column_name = 'id'))
        ORDER BY table_name, column_name
      `,
      )
      columns.push(
        ...rows.map((row) => ({
          table: row.table_name,
          column: row.column_name,
          notNull: row.is_nullable === 'NO',
        })),
      )
    }
    expect(columns).toEqual([
      { table: 'task_repository_mounts', column: 'task_id', notNull: true },
      { table: 'tasks', column: 'id', notNull: true },
    ])
  })

  test('42 distributions preserve the original counts, bounded owner probes, schedule read and rollback', async () => {
    await seed(harness)
    let comparisons = 0
    async function compare(
      expectedForAllIds: readonly (readonly [string, number])[],
      db: PersistenceDb = harness.db,
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
        expect(reads).toHaveLength(ids.length === 0 ? 0 : 2)
        expect(currentStatements).toHaveLength(ids.length === 0 ? 0 : 2)
        if (ids.length > 0) {
          const originalReads: (readonly Record<string, unknown>[])[] = []
          const originalRecording = harness.recordStatements()
          try {
            for (const query of originalCountQueries(db, [...new Set(ids)])) {
              originalReads.push(await rawRows<Record<string, unknown>>(db, query))
            }
          } finally {
            originalRecording.stop()
          }
          const originals = originalRecording.statements
          expect(originals).toHaveLength(3)
          const originalTaskCounts = new Map<string, number>()
          for (const row of [...originalReads[0]!, ...originalReads[1]!]) {
            const id = String(row.cached_repo_id)
            originalTaskCounts.set(id, (originalTaskCounts.get(id) ?? 0) + Number(row.count))
          }
          expect(
            sortedRows(
              reads[0]!.rows
                .filter((row) => Number(row.count) > 0)
                .map((row) => ({ cached_repo_id: row.cached_repo_id, count: Number(row.count) })),
            ),
          ).toEqual(
            sortedRows(
              [...originalTaskCounts].map(([cached_repo_id, count]) => ({ cached_repo_id, count })),
            ),
          )
          expect(sortedRows(reads[1]!.rows)).toEqual(sortedRows(originalReads[2]!))
          // RFC-395 II-b O1: candidate-bounded scalar probes use the owner indexes.
          const probe = currentStatements[0]!
          expect(probe.sql).toMatch(/WITH candidates\(id\) AS \(VALUES/i)
          expect(probe.sql).toMatch(/count\(distinct/i)
          expect(probe.sql).toMatch(/NOT EXISTS/i)
          expect(probe.sql).not.toContain('cached_repos')
          expect(probe.values).toEqual([...new Set(ids)])
          expect(probe.rows).toBe(new Set(ids).size)
          expect(statementContract(currentStatements[1]!)).toEqual(statementContract(originals[2]!))
        }
        comparisons += 1
      }
    }

    // Goldens captured from the old shared store before changing its SQL.
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 5],
    ])
    const { taskRepositoryMounts: taskRepos } = tablesOf(harness.db)
    await harness.db.delete(taskRepos)
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    await taskRepoFixture(harness.db, [
      {
        taskId: 'b',
        repoIndex: 0,
        mountPath: 'repo-0',
        cachedRepoId: null,
        repoPath: '/fixture/one',
        branch: 'main',
        worktreePath: '/fixture/one',
      },
      {
        taskId: 'b',
        repoIndex: 1,
        mountPath: 'repo-1',
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
    const taskRows = await readTaskFixtures(harness.db, undefined, {
      orderBy: [{ field: 'id', direction: 'asc' }],
    }).then((rows) => rows.map((row) => ({ id: row.id, cachedRepoId: row.cachedRepoId })))
    for (const row of taskRows) {
      await taskRepoFixture(harness.db, {
        taskId: row.id,
        repoIndex: 0,
        mountPath: 'repo-0',
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
    const beforeTasks = await readTaskFixtures(harness.db, undefined, {
      orderBy: [{ field: 'id' }],
    })
    const beforeRepos = await readTaskRepoFixtures(harness.db, undefined, {
      orderBy: [
        { field: 'taskId', direction: 'asc' },
        { field: 'repoIndex', direction: 'asc' },
      ],
    })
    const interruption = new Error('reference count rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const { taskRepositoryMounts: taskRepos } = tablesOf(tx)
        await patchTaskFixture(tx, { id: 'a' }, { cachedRepoId: repoIds[2] })
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
    expect(
      await readTaskFixtures(harness.db, undefined, {
        orderBy: [{ field: 'id', direction: 'asc' }],
      }),
    ).toEqual(beforeTasks)
    expect(
      await readTaskRepoFixtures(harness.db, undefined, {
        orderBy: [
          { field: 'taskId', direction: 'asc' },
          { field: 'repoIndex', direction: 'asc' },
        ],
      }),
    ).toEqual(beforeRepos)
    await compare([
      [repoIds[0], 6],
      [repoIds[1], 4],
      [repoIds[2], 2],
    ])
    expect(comparisons).toBe(42)
  }, 30_000)
})
