// RFC-359 AC11: the full HTTP profile still materializes 100,000 non-view
// matches before selecting 51 roots. This suite compares the old materialized
// SQL with the actual emitter, on real rows, without measuring latency. The
// original W19 63-filter/full-row/cursor/cycle suite remains the wider oracle.
import { expect, test } from 'bun:test'
import { eq, sql, SQL, StringChunk } from 'drizzle-orm'

import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createDatabaseTaskListPage,
  type TaskListViewer,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import { parseTaskOperationsQuery } from '@/modules/task-execution/infrastructure/taskListPage/filters'
import { fastFilteredRootQuery } from '@/modules/task-execution/infrastructure/taskListPage/query'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const VIEWER: TaskListViewer = { userId: 'w21-owner', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const OLD_HINT = 'non_view_matches AS MATERIALIZED ('
const INLINE_HINT = 'non_view_matches AS NOT MATERIALIZED ('

// Retain every SQL chunk and bound value. Only restore the pre-W21 hint, so
// the old SQL is executed by the selected real provider rather than emulated.
function materializedOracle(query: SQL): SQL {
  let replacements = 0
  const result = new SQL(
    query.queryChunks.map((chunk) => {
      if (!(chunk instanceof StringChunk)) return chunk
      return new StringChunk(
        chunk.value.map((text) =>
          text.replace(/non_view_matches AS (?:NOT )?MATERIALIZED \(/g, () => {
            replacements += 1
            return OLD_HINT
          }),
        ),
      )
    }),
  )
  if (replacements !== 1) throw new Error(`expected one non-view hint, got ${replacements}`)
  return result
}

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'W21 fixture',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'w21-workflow',
    name: 'MiXeD workflow',
    definition: '{ "fixture": true }',
    createdAt: 1,
    updatedAt: 1,
  })
  const rows = [
    { id: 'root-a', root: 'root-a', parent: null, startedAt: 100, status: 'done', name: 'quiet' },
    {
      id: 'root-b',
      root: 'root-b',
      parent: null,
      startedAt: 200,
      status: 'failed',
      name: 'MiXeD root',
    },
    { id: 'root-c', root: 'root-c', parent: null, startedAt: 300, status: 'done', name: 'quiet' },
    {
      id: 'child-a',
      root: 'root-a',
      parent: 'root-a',
      startedAt: 300,
      status: 'running',
      name: 'MiXeD leaf',
    },
    {
      id: 'child-b',
      root: 'root-b',
      parent: 'root-b',
      startedAt: 300,
      status: 'awaiting_review',
      name: 'quiet',
    },
    {
      id: 'child-c',
      root: 'root-c',
      parent: 'root-c',
      startedAt: 250,
      status: 'pending',
      name: 'quiet',
    },
  ] as const
  for (const row of rows) {
    const lineage = [
      { stableNodeKey: 'task-root', frozenOccurrenceKey: row.root, workflowRevision: null },
      ...(row.parent === null
        ? []
        : [{ stableNodeKey: 'child-task', frozenOccurrenceKey: row.id, workflowRevision: null }]),
    ]
    await db.insert(tasks).values({
      id: row.id,
      name: row.name,
      workflowId: 'w21-workflow',
      workflowSnapshot: '{ "v" : 1 }',
      inputs: '{ "raw" : [1, null] }',
      repoPath: '/fixture/percent%_repo',
      repoUrl: null,
      worktreePath: `/fixture/${row.id}`,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.status === 'done' ? row.startedAt + 10 : null,
      parentTaskId: row.parent,
      rootTaskId: row.root,
      branchStartedAt: 300,
      invocationDepth: row.parent === null ? 0 : 1,
      executionLineageId: row.root,
      lineageSlotPathJson: JSON.stringify(lineage),
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      ownerUserId: VIEWER.userId,
    })
  }
  for (const [id, taskId, resolvedAt] of [
    ['open-a', 'root-a', null],
    ['open-a-again', 'root-a', null],
    ['resolved-c', 'root-c', 123],
  ] as const) {
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
}

async function compareSql(
  harness: ProviderHarness,
  db: ProviderNeutralDatabase,
  raw: TaskOperationsRawQuery,
): Promise<readonly Record<string, unknown>[]> {
  const query = fastFilteredRootQuery(
    db,
    VIEWER,
    parseTaskOperationsQuery(VIEWER, raw, OPTIONS),
    OPTIONS.catalogVisibility,
  )
  const recording = harness.recordStatements()
  try {
    const expected = await db.all<Record<string, unknown>>(materializedOracle(query))
    const actual = await db.all<Record<string, unknown>>(query)
    expect(actual).toEqual(expected)
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    expect(recording.statements).toHaveLength(2)
    const [before, after] = recording.statements
    if (before === undefined || after === undefined) throw new Error('missing query pair')
    expect(before.sql).toContain(OLD_HINT)
    expect(after.sql.replace(INLINE_HINT, OLD_HINT)).toBe(before.sql)
    expect(before.params).toBeGreaterThan(0)
    expect(before.values).toHaveLength(before.params)
    expect(after.values).toHaveLength(after.params)
    expect(after.values).toEqual(before.values)
    expect(after.rows).toBe(before.rows)
    return actual
  } finally {
    recording.stop()
  }
}

describeEachProvider('RFC-359 W21 non-view CTE inlining', (harness) => {
  test('the old SQL and actual emitter keep complete rows, facets and every page on a tied tree', async () => {
    await seed(harness.db)
    const storedBefore = await harness.db.select().from(tasks).orderBy(tasks.id)
    const page = createDatabaseTaskListPage(harness.db, composeOwnerIdentityQueries(harness.db))
    const cases: readonly TaskOperationsRawQuery[] = [
      { subject: 'workflow', limit: '1' },
      { view: 'active', limit: '2' },
      { view: 'attention', limit: '1' },
      { view: 'finished', limit: '2' },
      { q: 'MiXeD', limit: '1' },
      { q: 'percent%_', limit: '2' },
      { q: 'absent', limit: '1' },
      { statuses: 'running,done', limit: '2' },
      { subject: 'workgroup', limit: '1' },
    ]
    for (const raw of cases) {
      let cursor: string | undefined
      const seen: string[] = []
      for (;;) {
        const request = { ...raw, ...(cursor === undefined ? {} : { cursor }) }
        await compareSql(harness, harness.db, request)
        const listed = await page.list(VIEWER, request, OPTIONS)
        seen.push(...listed.items.map((item) => item.id))
        expect(new Set(seen).size).toBe(seen.length)
        expect(seen.length).toBeLessThanOrEqual(3)
        if (listed.nextCursor === null) break
        cursor = listed.nextCursor
      }
    }
    const all = await page.list(VIEWER, { limit: '50' }, OPTIONS)
    expect(all.items.map((item) => item.id)).toEqual(['root-c', 'root-b', 'root-a'])
    expect(all.kind).toBe('root')
    if (all.kind !== 'root') throw new Error('unexpected child page')
    expect(all.facets).toEqual({ all: 6, active: 3, attention: 3, finished: 3 })
    expect(all.items.find((item) => item.id === 'root-a')?.openAlertCount).toBe(2)
    expect(all.items.map((item) => item.listContext.matchingDescendantCount)).toEqual([1, 1, 1])
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(storedBefore)
  })

  test('both SQL forms read the transaction row and rollback leaves every stored byte unchanged', async () => {
    await seed(harness.db)
    const before = await harness.db.select().from(tasks).orderBy(tasks.id)
    const expected = await compareSql(harness, harness.db, { q: 'transaction only', limit: '3' })
    expect(expected).toHaveLength(1)
    expect(expected[0]?.id).toBeNull()
    const stop = new Error('rollback task-page fixture')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.update(tasks).set({ name: 'transaction only' }).where(eq(tasks.id, 'child-a'))
        const changed = await compareSql(harness, tx, { q: 'transaction only', limit: '3' })
        expect(changed.map((row) => row.id)).toEqual(['root-a'])
        expect(changed[0]?.match_kind).toBe('context')
        expect(Number(changed[0]?.matching_descendant_count)).toBe(1)
        expect(Number(changed[0]?.facet_all)).toBe(1)
        throw stop
      }),
    ).rejects.toBe(stop)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(before)
    expect(await compareSql(harness, harness.db, { q: 'transaction only', limit: '3' })).toEqual(
      expected,
    )
  })
})

test('the actual PG client compiles the old/new page and EXPLAIN forms with identical bindings', async () => {
  const statements: { sql: string; parameters: readonly unknown[] }[] = []
  const stop = new Error('task-page-stopped-before-postgresql-execution')
  const pool: PostgresqlPool = {
    unsafe(sql, parameters = []) {
      statements.push({ sql, parameters })
      throw stop
    },
    async reserve() {
      throw new Error('task-page-unexpected-reservation')
    },
    async close() {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_TASK_PAGE_PROBE_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
    generationId: 'dbg_rfc359_task_page_probe',
    env: { RFC359_TASK_PAGE_PROBE_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => pool,
  })
  const provider = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(provider)
  const restore = selectDatabaseSchemaProvider('postgresql')
  try {
    const parsed = parseTaskOperationsQuery(VIEWER, { q: 'MiXeD%_', limit: '2' }, OPTIONS)
    for (const cursor of [
      undefined,
      {
        v: 1 as const,
        branchStartedAt: 300,
        taskId: 'root-c',
        filterFingerprint: parsed.filterFingerprint,
      },
    ]) {
      const query = fastFilteredRootQuery(
        db,
        VIEWER,
        { ...parsed, cursor },
        OPTIONS.catalogVisibility,
      )
      const old = materializedOracle(query)
      for (const explain of [false, true]) {
        const pair = explain
          ? [sql`EXPLAIN (FORMAT JSON) ${old}`, sql`EXPLAIN (FORMAT JSON) ${query}`]
          : [old, query]
        const start = statements.length
        for (const statement of pair) {
          // This exercises the production compiler; the pool cannot return a
          // fabricated row, access a network, or execute a PostgreSQL plan.
          await expect(db.all(statement)).rejects.toBe(stop)
        }
        expect(statements).toHaveLength(start + 2)
        const before = statements[start]
        const after = statements[start + 1]
        if (before === undefined || after === undefined) throw new Error('missing PG compilation')
        expect(before.sql).toContain(OLD_HINT)
        expect(after.sql).toContain(INLINE_HINT)
        expect(after.sql.replace(INLINE_HINT, OLD_HINT)).toBe(before.sql)
        expect(after.parameters).toEqual(before.parameters)
        expect(after.sql.startsWith('EXPLAIN (FORMAT JSON)')).toBe(explain)
      }
    }
  } finally {
    restore()
    await runtime.close()
  }
})
