// RFC359 W27: actual W25 PG root_prefix still scanned 100,000 tasks after a 204-row
// physical prefix. Compare exact original SQL and real rows; no latency assertion.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, getTableColumns, SQL, StringChunk } from 'drizzle-orm'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, tasks, users, workflows } from '@/db/schema'
import type {
  TaskListViewer,
  TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import {
  encodeCursor,
  parseTaskOperationsQuery,
} from '@/modules/task-execution/infrastructure/taskListPage/filters'
import { fastFilteredRootQuery } from '@/modules/task-execution/infrastructure/taskListPage/query'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const VIEWER: TaskListViewer = { userId: 'w27-owner', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const ORIGINAL = `    root_prefix AS MATERIALIZED (
      SELECT m.id, m.rid, m.started_at
      FROM physical_prefix p CROSS JOIN matches m WHERE m.id = p.id
    ),
`
const LOOKUP = `    root_prefix_lookup AS MATERIALIZED (
      SELECT p.id, p.started_at,
        (SELECT m.id FROM matches m WHERE m.id = p.id) AS matched_id,
        (SELECT m.rid FROM matches m WHERE m.id = p.id) AS rid
      FROM physical_prefix p
    ),
    root_prefix AS MATERIALIZED (
      SELECT p.id, p.rid, p.started_at FROM root_prefix_lookup p
      WHERE p.matched_id IS NOT NULL
    ),
`
const SOURCE_PATH = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/taskListPage/query.ts',
)
function restoreText(text: string): string {
  return text.replace(LOOKUP, ORIGINAL)
}
// This literal-only span adds no interpolation. Keep all original bound objects.
function originalQuery(query: SQL): SQL {
  return new SQL(
    query.queryChunks.map((chunk) =>
      chunk instanceof StringChunk ? new StringChunk(chunk.value.map(restoreText)) : chunk,
    ),
  )
}
function inspectCte(query: SQL, end: string, select: string): SQL {
  const chunks: SQL['queryChunks'] = []
  for (const chunk of query.queryChunks) {
    if (!(chunk instanceof StringChunk)) {
      chunks.push(chunk)
      continue
    }
    for (const text of chunk.value) {
      const index = text.indexOf(end)
      if (index < 0) {
        chunks.push(new StringChunk(text))
        continue
      }
      chunks.push(new StringChunk(text.slice(0, index).replace(/,\s*$/, '\n') + select))
      return new SQL(chunks)
    }
  }
  throw new Error(`missing CTE boundary: ${end}`)
}
function prefixRows(query: SQL): SQL {
  return inspectCte(
    query,
    '    prefix_roots AS (',
    'SELECT id, rid, started_at FROM root_prefix ORDER BY id',
  )
}
interface FixtureRow {
  id: string
  root?: string | null
  parent?: string | null
  startedAt: number
  name?: string
}
function roots(count = 16): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `root-${String(i).padStart(2, '0')}`,
    startedAt: 1000 - i * 10,
  }))
}
async function seed(db: ProviderNeutralDatabase, rows: readonly FixtureRow[]): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'W27 fixture',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'w27-workflow',
    name: 'W27 workflow',
    definition: '{ "fixture": true }',
    createdAt: 1,
    updatedAt: 1,
  })
  for (const row of rows) {
    const family = row.root === undefined ? row.id : row.root
    await db.insert(tasks).values({
      id: row.id,
      name: row.name ?? 'match',
      workflowId: 'w27-workflow',
      workflowSnapshot: '{ "v" : 1 }',
      inputs: '{ "raw" : [1, null] }',
      repoPath: '/fixture/percent%_repo',
      worktreePath: `/fixture/${row.id}`,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      status: 'done',
      startedAt: row.startedAt,
      finishedAt: row.startedAt + 5,
      parentTaskId: null,
      rootTaskId: family,
      branchStartedAt: row.startedAt,
      executionLineageId: family ?? row.id,
      lineageSlotPathJson: JSON.stringify([
        {
          stableNodeKey: 'task-root',
          frozenOccurrenceKey: family ?? row.id,
          workflowRevision: null,
        },
      ]),
      ownerUserId: VIEWER.userId,
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      repoCount: 1,
    })
  }
  // Establish cycles after every FK target exists. Insert triggers fill NULL
  // roots, so also set intended root bytes explicitly on both real providers.
  for (const row of rows) {
    await db
      .update(tasks)
      .set({
        parentTaskId: row.parent ?? null,
        rootTaskId: row.root === undefined ? row.id : row.root,
      })
      .where(eq(tasks.id, row.id))
  }
}
function withCursor(
  raw: TaskOperationsRawQuery,
  startedAt: number,
  id: string,
): TaskOperationsRawQuery {
  const parsed = parseTaskOperationsQuery(VIEWER, raw, OPTIONS)
  return {
    ...raw,
    cursor: encodeCursor({
      v: 1,
      branchStartedAt: startedAt,
      taskId: id,
      filterFingerprint: parsed.filterFingerprint,
    }),
  }
}
async function storedRows(db: ProviderNeutralDatabase) {
  const rows = {
    tasks: await db.select().from(tasks).orderBy(tasks.id),
    alerts: await db.select().from(lifecycleAlerts).orderBy(lifecycleAlerts.id),
  }
  return rows
}
function queryFor(db: ProviderNeutralDatabase, raw: TaskOperationsRawQuery): SQL {
  return fastFilteredRootQuery(
    db,
    VIEWER,
    parseTaskOperationsQuery(VIEWER, raw, OPTIONS),
    OPTIONS.catalogVisibility,
  )
}
async function compare(
  harness: ProviderHarness,
  db: ProviderNeutralDatabase,
  raw: TaskOperationsRawQuery,
) {
  const before = await storedRows(db)
  const query = queryFor(db, raw)
  const recording = harness.recordStatements()
  try {
    const expected = await db.all<Record<string, unknown>>(originalQuery(query))
    const actual = await db.all<Record<string, unknown>>(query)
    expect(actual).toEqual(expected)
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    expect(recording.statements).toHaveLength(2)
    const [left, right] = recording.statements
    if (!left || !right) throw new Error('missing actual W27 SQL pair')
    expect(restoreText(right.sql)).toBe(left.sql)
    expect(left.params).toBeGreaterThan(0)
    expect(left.values).toHaveLength(left.params)
    expect(right.values).toHaveLength(right.params)
    expect(right.values).toEqual(left.values)
    expect(right.rows).toBe(left.rows)
    return actual
  } finally {
    recording.stop()
    const after = await storedRows(db)
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  }
}
const RAW = { subject: 'workflow', limit: '1' } satisfies TaskOperationsRawQuery

describeEachProvider('RFC359 W27 bounded task prefix lookup', (harness) => {
  test('the original matches remain unique with multiple open alerts for one task', async () => {
    await seed(harness.db, roots())
    for (const [id, resolvedAt] of [
      ['open-a', null],
      ['open-b', null],
      ['resolved-c', 2],
    ] as const)
      await harness.db.insert(lifecycleAlerts).values({
        id,
        taskId: 'root-00',
        rule: `fixture-${id}`,
        severity: 'warn',
        detail: '{ "bytes" : [1,null] }',
        detectedAt: 1,
        resolvedAt,
      })
    expect(getTableColumns(tasks).id.primary).toBe(true)
    for (const raw of [RAW, { ...RAW, view: 'attention' }]) {
      const query = queryFor(harness.db, raw)
      expect(
        await harness.db.all(
          inspectCte(
            query,
            '    root_prefix_budget AS MATERIALIZED (',
            'SELECT id FROM matches GROUP BY id HAVING COUNT(*) <> 1',
          ),
        ),
      ).toEqual([])
      await compare(harness, harness.db, raw)
    }
    const matching = await harness.db.all<{ id: string; rid: string | null; started_at: number }>(
      prefixRows(queryFor(harness.db, { ...RAW, view: 'attention' })),
    )
    expect(matching).toEqual([{ id: 'root-00', rid: 'root-00', started_at: 1000 }])
  })
  const cases = [
    { name: 'strict gap with a small bounded prefix', rows: roots(), raw: RAW },
    { name: 'no physical rows and the complete empty facet row', rows: [], raw: RAW },
    {
      name: 'filtered newest rows still require the original fallback',
      rows: roots().map((row, i) => ({ ...row, name: i < 12 ? 'outside' : 'wanted' })),
      raw: { ...RAW, q: 'wanted' },
    },
    {
      name: 'a deep cursor retains the original fallback page',
      rows: roots(),
      raw: withCursor(RAW, 890, 'root-11'),
    },
    {
      name: 'equal-time children and parent cycles retain complete family counts',
      rows: [
        ...roots(),
        { id: 'cycle-a', root: 'root-00', parent: 'cycle-b', startedAt: 1000 },
        { id: 'cycle-b', root: 'root-00', parent: 'cycle-a', startedAt: 1000 },
        { id: 'direct-child', root: 'root-00', parent: 'root-00', startedAt: 1000 },
      ],
      raw: RAW,
    },
  ]
  for (const fixture of cases)
    test(fixture.name, async () => {
      await seed(harness.db, fixture.rows)
      await compare(harness, harness.db, fixture.raw)
      const query = queryFor(harness.db, fixture.raw)
      const oldPrefix = await harness.db.all<Record<string, unknown>>(
        prefixRows(originalQuery(query)),
      )
      const newPrefix = await harness.db.all<Record<string, unknown>>(prefixRows(query))
      expect(newPrefix).toEqual(oldPrefix)
      expect(JSON.stringify(newPrefix)).toBe(JSON.stringify(oldPrefix))
      expect(newPrefix.length).toBeLessThanOrEqual(4 * (Number(fixture.raw.limit) + 1))
    })
  test('a matching NULL rid remains distinct from a missing match and retains its page slot', async () => {
    await seed(harness.db, [
      ...roots(),
      { id: 'null-family', root: null, startedAt: 1200 },
      { id: 'missing-family', root: 'missing-root', startedAt: 1100 },
      { id: 'outside-newest', name: 'outside', startedAt: 1300 },
    ])
    const raw = { ...RAW, q: 'match' }
    const query = queryFor(harness.db, raw)
    const prefix = await harness.db.all<{ id: string; rid: string | null; started_at: number }>(
      prefixRows(query),
    )
    expect(prefix.find((row) => row.id === 'null-family')).toEqual({
      id: 'null-family',
      rid: null,
      started_at: 1200,
    })
    expect(prefix.find((row) => row.id === 'missing-family')?.rid).toBe('missing-root')
    expect(prefix.some((row) => row.id === 'outside-newest')).toBe(false)
    expect(prefix).toEqual(
      await harness.db.all<{ id: string; rid: string | null; started_at: number }>(
        prefixRows(originalQuery(query)),
      ),
    )
    await compare(harness, harness.db, raw)
  })
  test('transaction-local changes and rollback preserve the same statement snapshot and row bytes', async () => {
    await seed(harness.db, roots())
    const before = await storedRows(harness.db)
    const initial = await compare(harness, harness.db, RAW)
    const stop = new Error('rollback W27 prefix fixture')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(tasks)
          .set({ startedAt: 1500, inputs: '{ "changed" : [null,2] }', rootTaskId: null })
          .where(eq(tasks.id, 'root-15'))
        expect(await compare(harness, tx, RAW)).not.toEqual(initial)
        throw stop
      }),
    ).rejects.toBe(stop)
    expect(await storedRows(harness.db)).toEqual(before)
    expect(JSON.stringify(await storedRows(harness.db))).toBe(JSON.stringify(before))
    expect(await compare(harness, harness.db, RAW)).toEqual(initial)
  })
})
test('the inverse retains the complete W26 source and all original interpolation sites', () => {
  expect(
    createHash('sha256')
      .update(restoreText(readFileSync(SOURCE_PATH, 'utf8')))
      .digest('hex'),
  ).toBe('37cc4ba229d6197d3fcb1d1256eb06a0edb7a09b3d7f910cb4630ea31db19324')
})
test('the actual PG compiler preserves original SQL and bindings without executing PG', async () => {
  const statements: { sql: string; values: readonly unknown[] }[] = []
  const stop = new Error('W27 stopped at actual PG client boundary')
  const pool: PostgresqlPool = {
    unsafe(sql, values = []) {
      statements.push({ sql, values })
      throw stop
    },
    async reserve() {
      throw new Error('unexpected PG reservation')
    },
    async close() {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_W27_PG_URL',
      poolMax: 1,
      connectTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    },
    generationId: 'dbg_w27_compiler',
    env: { RFC359_W27_PG_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => pool,
  })
  const provider = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(provider)
  const restore = selectDatabaseSchemaProvider('postgresql')
  try {
    for (const raw of [RAW, { ...RAW, q: 'percent%_' }, withCursor(RAW, 890, 'root-11')]) {
      const query = fastFilteredRootQuery(
        db,
        VIEWER,
        parseTaskOperationsQuery(VIEWER, raw, OPTIONS),
        OPTIONS.catalogVisibility,
      )
      const start = statements.length
      for (const item of [originalQuery(query), query])
        await expect(db.all(item)).rejects.toBe(stop)
      expect(statements).toHaveLength(start + 2)
      const before = statements[start],
        after = statements[start + 1]
      if (!before || !after) throw new Error('missing actual compiler pair')
      expect(restoreText(after.sql)).toBe(before.sql)
      expect(before.values.length).toBeGreaterThan(0)
      expect(after.values).toEqual(before.values)
    }
  } finally {
    restore()
    await runtime.close()
  }
})
