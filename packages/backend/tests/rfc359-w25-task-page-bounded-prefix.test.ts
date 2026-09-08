// RFC359 W25: real original SQL, original bindings, complete rows and snapshot.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql, SQL, StringChunk } from 'drizzle-orm'
import { createInMemoryDb } from '@/db/client'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createDatabaseTaskListPage,
  type TaskListViewer,
  type TaskOperationsRawQuery,
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
import { recordStatements } from './helpers/statementRecorder'

const VIEWER: TaskListViewer = { userId: 'w25-owner', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const START = '    root_prefix_budget AS MATERIALIZED ('
const END = '    page_roots AS MATERIALIZED ('
const ORIGINAL_ROOTS = `    roots AS NOT MATERIALIZED (
      SELECT
        m.rid AS rid,
        MAX(m.started_at) AS bsa
      FROM matches m
      GROUP BY m.rid
    ),
`
const SOURCE_PATH = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/taskListPage/query.ts',
)
function restoreText(text: string): string {
  const start = text.indexOf(START)
  if (start < 0) return text
  const end = text.indexOf(END, start)
  if (end < 0) throw new Error('missing original page boundary')
  return text.slice(0, start) + ORIGINAL_ROOTS + text.slice(end)
}
// Remove only the new CTE span and its two interpolation objects. Every old
// interpolation, including the original cursor object, remains in original order.
function originalQuery(query: SQL): SQL {
  const chunks: SQL['queryChunks'] = []
  let dropping = false
  for (const chunk of query.queryChunks) {
    if (!(chunk instanceof StringChunk)) {
      if (!dropping) chunks.push(chunk)
      continue
    }
    for (let text of chunk.value) {
      if (!dropping) {
        const start = text.indexOf(START)
        if (start < 0) {
          chunks.push(new StringChunk(text))
          continue
        }
        chunks.push(new StringChunk(text.slice(0, start)))
        text = text.slice(start)
        dropping = true
      }
      const end = text.indexOf(END)
      if (end >= 0) {
        chunks.push(new StringChunk(ORIGINAL_ROOTS + text.slice(end)))
        dropping = false
      }
    }
  }
  if (dropping) throw new Error('unterminated prefix SQL span')
  return new SQL(chunks)
}
function originalBindings(
  sql: string,
  values: readonly unknown[],
  raw: TaskOperationsRawQuery,
): readonly unknown[] {
  const start = sql.indexOf(START)
  if (start < 0) return values
  const prefix = sql.slice(0, start).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, '')
  const offset = [...prefix.matchAll(/\?|\$\d+/g)].length
  const parsed = parseTaskOperationsQuery(VIEWER, raw, OPTIONS)
  const added = [
    parsed.limit + 1,
    ...(parsed.cursor ? [parsed.cursor.branchStartedAt, parsed.cursor.taskId] : []),
  ]
  expect(values.slice(offset, offset + added.length)).toEqual(added)
  return [...values.slice(0, offset), ...values.slice(offset + added.length)]
}
function originalCompiledText(text: string): string {
  let ordinal = 0
  return restoreText(text).replace(/\$\d+/g, () => `$${++ordinal}`)
}
interface FixtureRow {
  id: string
  root?: string | null
  parent?: string | null
  startedAt: number
  name?: string
}
function independentRoots(count = 16): FixtureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `root-${String(i).padStart(2, '0')}`,
    startedAt: 1000 - i * 10,
  }))
}
function tiedFamilies(): FixtureRow[] {
  return Array.from({ length: 12 }, (_, i) => [
    { id: `root-${String(i).padStart(2, '0')}`, startedAt: 10 },
    {
      id: `child-${String(11 - i).padStart(2, '0')}`,
      root: `root-${String(i).padStart(2, '0')}`,
      parent: `root-${String(i).padStart(2, '0')}`,
      startedAt: 1000,
    },
  ]).flat()
}
function giantFamily(): FixtureRow[] {
  return [
    { id: 'root-00', startedAt: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `child-${i}`,
      root: 'root-00',
      parent: 'root-00',
      startedAt: 1000 - i,
    })),
    ...independentRoots(4)
      .slice(1)
      .map((row) => ({ ...row, startedAt: row.startedAt - 500 })),
  ]
}
async function seed(db: ProviderNeutralDatabase, rows: readonly FixtureRow[]): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'W25 fixture',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'w25-workflow',
    name: 'W25 workflow',
    definition: '{ "fixture": true }',
    createdAt: 1,
    updatedAt: 1,
  })
  for (const row of rows) {
    const family = row.root === undefined ? row.id : row.root
    await db.insert(tasks).values({
      id: row.id,
      name: row.name ?? 'match',
      workflowId: 'w25-workflow',
      workflowSnapshot: '{ "v" : 1 }',
      inputs: '{ "raw" : [1, null] }',
      repoPath: '/fixture/percent%_repo',
      worktreePath: `/fixture/${row.id}`,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      status: 'done',
      startedAt: row.startedAt,
      finishedAt: row.startedAt + 5,
      parentTaskId: row.parent ?? null,
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
async function compare(
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
    const expected = await db.all<Record<string, unknown>>(originalQuery(query))
    const actual = await db.all<Record<string, unknown>>(query)
    expect(actual).toEqual(expected)
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    expect(recording.statements).toHaveLength(2)
    const [before, after] = recording.statements
    if (!before || !after) throw new Error('missing real SQL pair')
    expect(before.sql).not.toContain(START)
    expect(originalCompiledText(after.sql)).toBe(before.sql)
    expect(before.params).toBeGreaterThan(0)
    expect(before.values).toHaveLength(before.params)
    expect(after.values).toHaveLength(after.params)
    expect(originalBindings(after.sql, after.values, raw)).toEqual(before.values)
    expect(after.rows).toBe(before.rows)
    return actual
  } finally {
    recording.stop()
  }
}
const RAW = { subject: 'workflow', limit: '1' } satisfies TaskOperationsRawQuery

describeEachProvider('RFC359 W25 bounded root prefix', (harness) => {
  const cases = [
    { name: 'a strict time gap certifies a bounded page', rows: independentRoots(), raw: RAW },
    {
      name: 'a completely exhausted prefix preserves a short last page',
      rows: independentRoots(3),
      raw: RAW,
    },
    {
      name: 'an empty match set retains the complete facet row',
      rows: independentRoots(),
      raw: { ...RAW, q: 'absent' },
    },
    {
      name: 'filtered newest physical rows cannot pretend that matches are exhausted',
      rows: independentRoots().map((row, i) => ({ ...row, name: i < 12 ? 'outside' : 'wanted' })),
      raw: { ...RAW, q: 'wanted' },
    },
    {
      name: 'physical exhaustion certifies sparse matches only after all tasks fit',
      rows: independentRoots(4).map((row, i) => ({ ...row, name: i === 3 ? 'wanted' : 'outside' })),
      raw: { ...RAW, q: 'wanted' },
    },
    {
      name: 'a cut equal-time bucket falls back before unseen greater roots',
      rows: tiedFamilies(),
      raw: RAW,
    },
    {
      name: 'a giant family cannot certify enough independent roots',
      rows: giantFamily(),
      raw: RAW,
    },
    {
      name: 'a deep cursor falls back when the head prefix has no eligible roots',
      rows: independentRoots(),
      raw: withCursor(RAW, 890, 'root-11'),
    },
    {
      name: 'a cursor never resurrects an older child of an excluded family',
      rows: [
        ...independentRoots(),
        { id: 'old-child', root: 'root-00', parent: 'root-00', startedAt: 875 },
      ],
      raw: withCursor(RAW, 950, 'root-05'),
    },
    {
      name: 'NULL and missing roots retain their original pre-join page slots',
      rows: [
        ...independentRoots(),
        { id: 'null-family', root: null, startedAt: 1100 },
        { id: 'missing-family', root: 'missing-root', startedAt: 1090 },
      ],
      raw: RAW,
    },
  ]
  for (const fixture of cases)
    test(fixture.name, async () => {
      await seed(harness.db, fixture.rows)
      const before = await harness.db.select().from(tasks).orderBy(tasks.id)
      await compare(harness, harness.db, fixture.raw)
      expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(before)
      expect(JSON.stringify(await harness.db.select().from(tasks).orderBy(tasks.id))).toBe(
        JSON.stringify(before),
      )
    })
  test('the actual page facade retains every cursor, complete row and family count', async () => {
    await seed(harness.db, [
      ...independentRoots(12),
      { id: 'same-time-child', root: 'root-00', parent: 'root-00', startedAt: 1000 },
    ])
    const before = await harness.db.select().from(tasks).orderBy(tasks.id)
    const page = createDatabaseTaskListPage(harness.db, composeOwnerIdentityQueries(harness.db))
    let cursor: string | undefined
    const seen: string[] = []
    do {
      const raw = { ...RAW, ...(cursor === undefined ? {} : { cursor }) }
      await compare(harness, harness.db, raw)
      const result = await page.list(VIEWER, raw, OPTIONS)
      seen.push(...result.items.map((item) => item.id))
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen.length).toBeLessThanOrEqual(12)
      cursor = result.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(seen).toEqual(independentRoots(12).map((row) => row.id))
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(before)
  })
  test('a transaction changes the selected path while rollback preserves all stored JSON', async () => {
    await seed(harness.db, independentRoots())
    const before = await harness.db.select().from(tasks).orderBy(tasks.id)
    const original = await compare(harness, harness.db, RAW)
    const stop = new Error('rollback bounded root prefix')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.update(tasks).set({ startedAt: 1000 }).where(eq(tasks.workflowId, 'w25-workflow'))
        const changed = await compare(harness, tx, RAW)
        expect(changed).not.toEqual(original)
        throw stop
      }),
    ).rejects.toBe(stop)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id)).toEqual(before)
    expect(await compare(harness, harness.db, RAW)).toEqual(original)
  })
})

test('the inverse retains the exact complete W23 source', () => {
  expect(
    createHash('sha256')
      .update(restoreText(readFileSync(SOURCE_PATH, 'utf8')))
      .digest('hex'),
  ).toBe('bdb4e8fd0b84a2f1efbfbf51260ecc692cf392f30e673102a28462d6c68f7d48')
})
test('the real PG compiler retains the original SQL and explains every additional binding', async () => {
  const statements: { sql: string; values: readonly unknown[] }[] = []
  const stop = new Error('W25 stopped at actual PG client boundary')
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
      urlEnv: 'RFC359_W25_PG_URL',
      poolMax: 1,
      connectTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    },
    generationId: 'dbg_w25_compiler',
    env: { RFC359_W25_PG_URL: 'postgresql://fixture:fixture@localhost/fixture' },
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
      expect(originalCompiledText(after.sql)).toBe(before.sql)
      expect(before.values.length).toBeGreaterThan(0)
      expect(originalBindings(after.sql, after.values, raw)).toEqual(before.values)
    }
  } finally {
    restore()
    await runtime.close()
  }
})

// Row-dependent malformed JSON cannot be constant-folded during prepare. The
// real SQLite engine evaluates it if and only if that aggregate consumes a row.
function poisonFullAggregate(query: SQL): SQL {
  return new SQL(
    query.queryChunks.map((chunk) =>
      chunk instanceof StringChunk
        ? new StringChunk(
            chunk.value.map((text) =>
              text.replace(
                'MAX(m.started_at) AS bsa',
                () => "MAX(json_extract('w25 fallback evaluated ' || m.started_at, '$')) AS bsa",
              ),
            ),
          )
        : chunk,
    ),
  )
}

test('SQLite runtime skips the full aggregate after a certified page and executes it on fallback', async () => {
  const db = createInMemoryDb(resolve(import.meta.dir, '../db/migrations'))
  const sqlite = db.$client
  try {
    await seed(db, independentRoots())
    const query = fastFilteredRootQuery(
      db,
      VIEWER,
      parseTaskOperationsQuery(VIEWER, RAW, OPTIONS),
      OPTIONS.catalogVisibility,
    )
    const expected = await db.all<Record<string, unknown>>(originalQuery(query))
    const recording = recordStatements(sqlite)
    try {
      const actual = await db.all<Record<string, unknown>>(query)
      expect(actual).toEqual(expected)
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
      const statement = recording.statements[0]
      if (!statement) throw new Error('missing actual page SQL')
      expect(() => db.all(poisonFullAggregate(query))).not.toThrow()
      expect(() => db.all(poisonFullAggregate(originalQuery(query)))).toThrow('malformed JSON')
      const plan = await db.all<{ id: number; parent: number; detail: string }>(
        sql`EXPLAIN QUERY PLAN ${query}`,
      )
      const physical = plan.find((row) => row.detail === 'MATERIALIZE physical_prefix')
      const matching = plan.find((row) => row.detail === 'MATERIALIZE root_prefix')
      const lookup = plan.find((row) => row.detail === 'MATERIALIZE root_prefix_lookup')
      if (!physical || !matching || !lookup) throw new Error('missing bounded prefix plan')
      expect(plan.filter((row) => row.parent === physical.id).map((row) => row.detail)).toContain(
        'SCAN t USING COVERING INDEX idx_tasks_list_started_id',
      )
      expect(
        plan
          .filter(
            (row) => row.parent === matching.id && /^(?:SCAN|SEARCH) [pt](?: |$)/.test(row.detail),
          )
          .map((row) => row.detail),
      ).toEqual(['SCAN p'])
      const probes = plan.filter(
        (row) => row.parent === lookup.id && row.detail.startsWith('CORRELATED SCALAR SUBQUERY '),
      )
      expect(probes).toHaveLength(2)
      for (const probe of probes)
        expect(
          plan
            .filter(
              (row) => row.parent === probe.id && /^(?:SCAN|SEARCH) t(?: |$)/.test(row.detail),
            )
            .map((row) => row.detail),
        ).toEqual(['SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)'])
      const lookupDescendants = new Set([lookup.id])
      for (const row of plan) if (lookupDescendants.has(row.parent)) lookupDescendants.add(row.id)
      expect(
        plan
          .filter(
            (row) => lookupDescendants.has(row.id) && /^(?:SCAN|SEARCH) t(?: |$)/.test(row.detail),
          )
          .map((row) => row.detail),
      ).toEqual([
        'SCAN t USING COVERING INDEX idx_tasks_list_started_id',
        'SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)',
        'SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)',
      ])
      const deep = withCursor(RAW, 890, 'root-11')
      const deepQuery = fastFilteredRootQuery(
        db,
        VIEWER,
        parseTaskOperationsQuery(VIEWER, deep, OPTIONS),
        OPTIONS.catalogVisibility,
      )
      const deepExpected = await db.all<Record<string, unknown>>(originalQuery(deepQuery))
      expect(await db.all<Record<string, unknown>>(deepQuery)).toEqual(deepExpected)
      expect(() => db.all(poisonFullAggregate(deepQuery))).toThrow('malformed JSON')
    } finally {
      recording.stop()
    }
  } finally {
    sqlite.close()
  }
})
