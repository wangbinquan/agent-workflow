// RFC359 W26: preserve the original ordered listActive result and its single
// transaction snapshot while an empty workgroup index can avoid the task scan.
// The earlier W23 predicate/index probes changed nonempty order and were rejected.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { CANCELABLE_TASK_STATUSES, type TaskStatus } from '@agent-workflow/shared'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, users, workflows } from '@/db/schema'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import type { TaskExecutionTransaction } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import type { WorkgroupTaskRoomTaskSnapshot } from '@/modules/task-execution/public/commands'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const ORIGINAL_SOURCE_HASH = '9fae8c66954bdf6dd39d25c452679c081c5f6d830df9ba3beaccf0a793a87492'
const SOURCE_PATH = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts',
)
const PROBE_FROM = [
  '      .from(',
  "        sql`(SELECT 1 AS workgroup_present FROM ${tasks} WHERE ${tasks.workgroupId} >= ${''} LIMIT 1) AS nonempty_workgroup_scan`,",
  '      )',
  '      .crossJoin(tasks)',
].join('\n')

function originalCompiledSql(value: string): string {
  if (!value.includes('nonempty_workgroup_scan')) return value
  const from = value.indexOf(' from ')
  if (from < 0) throw new Error('missing actual outer FROM')
  const probe =
    / from \(SELECT 1 AS workgroup_present FROM ((?:"[^"]+"\.)?"tasks") WHERE \1\."workgroup_id" >= (?:\?|\$\d+) LIMIT 1\) AS nonempty_workgroup_scan cross join \1/.exec(
      value.slice(from),
    )
  const table = probe?.[1]
  if (!probe || !table) throw new Error('unrecognized actual probe SQL')
  const projection = value.slice(0, from).replaceAll(`${table}.`, '').replaceAll('"tasks".', '')
  const tail = value.slice(from).replace(probe[0], () => ` from ${table}`)
  if (tail.includes('nonempty_workgroup_scan')) throw new Error('unrecognized actual probe SQL')
  return (projection + tail).replace(/\$(\d+)/g, (_, ordinal: string) => `$${Number(ordinal) - 1}`)
}

function taskSnapshot(
  row: Omit<WorkgroupTaskRoomTaskSnapshot, 'status'> & { readonly status: string },
): WorkgroupTaskRoomTaskSnapshot {
  return Object.freeze({ ...row, status: row.status as TaskStatus })
}

const taskProjection = {
  id: tasks.id,
  name: tasks.name,
  ownerUserId: tasks.ownerUserId,
  status: tasks.status,
  workgroupId: tasks.workgroupId,
  workgroupConfigJson: tasks.workgroupConfigJson,
  workflowSnapshot: tasks.workflowSnapshot,
  triggerContextJson: tasks.triggerContextJson,
}

// Exact original listActive body, including its projection, predicate and mapper.
async function originalListActive(
  tx: TaskExecutionTransaction,
): Promise<readonly WorkgroupTaskRoomTaskSnapshot[]> {
  const rows = await tx
    .select(taskProjection)
    .from(tasks)
    .where(and(isNotNull(tasks.workgroupId), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES])))
  return Object.freeze(rows.map(taskSnapshot))
}

const observedValues = [
  { id: 'case-k', workgroupId: 'z', offset: 8 },
  { id: 'case-a', workgroupId: '', offset: 3 },
  { id: 'case-r', workgroupId: '重复', offset: 1 },
  { id: 'case-b', workgroupId: 'A', offset: 9 },
  { id: 'case-z', workgroupId: '重复', offset: 0 },
  { id: 'case-c', workgroupId: '😀', offset: 7 },
  { id: 'case-y', workgroupId: 'a', offset: 2 },
  { id: 'case-d', workgroupId: 'é', offset: 6 },
  { id: 'case-x', workgroupId: 'e\u0301', offset: 4 },
  { id: 'case-e', workgroupId: '\u0001', offset: 10 },
  { id: 'case-w', workgroupId: '\u{10ffff}', offset: 5 },
  { id: 'case-f', workgroupId: ' ', offset: 11 },
] as const

interface FixtureRow {
  readonly id: string
  readonly workgroupId: string | null
  readonly offset: number
  readonly status?: TaskStatus
}

function ordinaryRows(): readonly FixtureRow[] {
  return Array.from({ length: 128 }, (_, i) => ({
    id: `ordinary-${i}`,
    workgroupId: null,
    offset: i,
  }))
}

async function seed(db: ProviderNeutralDatabase, values: readonly FixtureRow[]): Promise<void> {
  await db.insert(users).values({
    id: 'wg-index-user',
    username: 'wg-index-user',
    displayName: 'fixture',
    role: 'admin',
    status: 'active',
    passwordHash: 'fixture',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'wg-index-workflow',
    name: 'fixture',
    definition: '{}',
    createdAt: 1,
    updatedAt: 1,
  })
  if (values.length === 0) return
  const rows: (typeof tasks.$inferInsert)[] = values.map((row, i) => ({
    id: row.id,
    name: `name:${row.id}`,
    ownerUserId: 'wg-index-user',
    workflowId: 'wg-index-workflow',
    workflowSnapshot: JSON.stringify({ row: row.id, sequence: i }),
    inputs: '{}',
    repoPath: '/fixture/repository',
    worktreePath: `/fixture/${row.id}`,
    baseBranch: 'main',
    branch: `task/${row.id}`,
    status: row.status ?? CANCELABLE_TASK_STATUSES[0]!,
    startedAt: 1000 + row.offset,
    branchStartedAt: 1000 + row.offset,
    workgroupId: row.workgroupId,
    workgroupConfigJson: JSON.stringify({ slot: i, label: row.id }),
    triggerContextJson: JSON.stringify({ sequence: i, marker: '原样' }),
    executionLineageId: row.id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: row.id, workflowRevision: null },
    ]),
  }))
  await db.insert(tasks).values(rows)
}

const factory = composeWorkgroupTaskRoomTaskParticipantFactory({
  collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
})

async function recorded(
  harness: ProviderHarness,
  run: () => Promise<readonly WorkgroupTaskRoomTaskSnapshot[]>,
): Promise<{
  readonly rows: readonly WorkgroupTaskRoomTaskSnapshot[]
  readonly statement: RecordedStatement
}> {
  const recording = harness.recordStatements()
  try {
    const rows = await run()
    expect(recording.statements).toHaveLength(1)
    const statement = recording.statements[0]
    if (statement === undefined) throw new Error('expected the real listActive statement')
    expect(statement.params).toBe(statement.values.length)
    expect(statement.params).toBeGreaterThan(0)
    return { rows, statement }
  } finally {
    recording.stop()
  }
}

async function compareInTransaction(harness: ProviderHarness, tx: TaskExecutionTransaction) {
  const before = await tx.select().from(tasks)
  const original = await recorded(harness, () => originalListActive(tx))
  const actual = await recorded(harness, () => factory.inTransaction(tx).listActive())
  expect(actual.rows).toEqual(original.rows)
  expect(JSON.stringify(actual.rows)).toBe(JSON.stringify(original.rows))
  expect(Object.isFrozen(actual.rows)).toBe(true)
  expect(actual.rows.every(Object.isFrozen)).toBe(true)
  const after = await tx.select().from(tasks)
  expect(after).toEqual(before)
  expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  expect(originalCompiledSql(actual.statement.sql)).toBe(original.statement.sql)
  if (actual.statement.sql.includes('nonempty_workgroup_scan')) {
    expect(actual.statement.values[0]).toBe('')
    const retained: readonly unknown[] = actual.statement.values.slice(1)
    expect(retained).toEqual(original.statement.values)
  } else {
    expect(actual.statement.values).toEqual(original.statement.values)
  }
  return { original, actual }
}

function nativeSqlite(harness: ProviderHarness): Database {
  const native: unknown = Reflect.get(harness.db, '$client')
  if (!(native instanceof Database)) throw new Error('expected the actual SQLite client')
  return native
}

function sqliteValues(statement: RecordedStatement): string[] {
  return statement.values.map((value) => {
    if (typeof value !== 'string')
      throw new Error('listActive binds only the probe and status text')
    return value
  })
}

// Depend on the real right-hand task row, so prepare cannot evaluate or fold
// this error. A zero-row left input must prevent that task expression executing.
function poisonTaskScan(statement: RecordedStatement): string {
  const needle = '"tasks"."workgroup_id" is not null'
  expect(statement.sql.split(needle)).toHaveLength(2)
  return statement.sql.replace(
    needle,
    () =>
      `CASE WHEN json_extract('W26 task row visited ' || "tasks"."id", '$') IS NULL THEN (${needle}) ELSE 0 END`,
  )
}

describeEachProvider('RFC359 W26 workgroup empty scan', (harness) => {
  test('an empty physical task table keeps the complete empty result', async () => {
    expect(await harness.db.select().from(tasks)).toEqual([])
    await harness.session.transaction(async (tx) => {
      const { actual } = await compareInTransaction(harness, tx)
      expect(actual.rows).toEqual([])
    })
  })

  test('128 ordinary NULL rows keep an empty result in the actual participant', async () => {
    await seed(harness.db, ordinaryRows())
    await harness.executeFixtureDdl('ANALYZE')
    await harness.session.transaction(async (tx) => {
      const { original, actual } = await compareInTransaction(harness, tx)
      expect(actual.rows).toEqual([])
      if (harness.capabilities.isolation === 'exclusive') {
        const native = nativeSqlite(harness)
        const poisonedOriginal = poisonTaskScan(original.statement)
        const poisonedActual = poisonTaskScan(actual.statement)
        expect(() =>
          native.query(poisonedOriginal).all(...sqliteValues(original.statement)),
        ).toThrow('malformed JSON')
        expect(() =>
          native.query(poisonedActual).all(...sqliteValues(actual.statement)),
        ).not.toThrow()
        expect(native.query(poisonedActual).all(...sqliteValues(actual.statement))).toEqual([])
        const originalPlan = await harness.explain(original.statement)
        const candidatePlan = await harness.explain(actual.statement)
        console.log(
          '[W26 workgroup empty plans]',
          JSON.stringify({
            original: original.statement,
            actual: actual.statement,
            originalPlan,
            candidatePlan,
          }),
        )
        expect(originalPlan).toContain('SCAN tasks')
        expect(candidatePlan).toContain('USING COVERING INDEX idx_tasks_workgroup (workgroup_id>?)')
        expect(candidatePlan).toContain('SCAN nonempty_workgroup_scan')
        expect(candidatePlan.lastIndexOf('SCAN tasks')).toBeGreaterThan(
          candidatePlan.indexOf('SCAN nonempty_workgroup_scan'),
        )
      }
    })
  })

  test('the original 140 rows retain unsorted duplicate empty and Unicode workgroups', async () => {
    await seed(harness.db, [...ordinaryRows(), ...observedValues])
    await harness.executeFixtureDdl('ANALYZE')
    expect(tasks.workgroupId.getSQLType()).toBe('text')
    expect(tasks.workgroupId.notNull).toBe(false)
    await harness.session.transaction(async (tx) => {
      const { original, actual } = await compareInTransaction(harness, tx)
      expect(actual.rows).toHaveLength(12)
      expect(actual.rows.filter((row) => row.workgroupId === '重复')).toHaveLength(2)
      expect(actual.rows.some((row) => row.workgroupId === '')).toBe(true)
      if (harness.capabilities.isolation === 'exclusive') {
        expect(actual.rows.map((row) => row.id)).toEqual(observedValues.map((row) => row.id))
        const native = nativeSqlite(harness)
        const stored = native
          .query<
            { storage_type: string; workgroup_id: string | null },
            []
          >('SELECT typeof(workgroup_id) AS storage_type, workgroup_id FROM tasks')
          .all()
        expect(stored).toHaveLength(140)
        for (const row of stored) {
          expect(row.storage_type).toBe(row.workgroup_id === null ? 'null' : 'text')
        }
        expect(() =>
          native.query(poisonTaskScan(original.statement)).all(...sqliteValues(original.statement)),
        ).toThrow('malformed JSON')
        expect(() =>
          native.query(poisonTaskScan(actual.statement)).all(...sqliteValues(actual.statement)),
        ).toThrow('malformed JSON')
      }
    })
  })

  test('only empty-string workgroups still qualify and retain the original status filter', async () => {
    await seed(harness.db, [
      { id: 'empty-z', workgroupId: '', offset: 2 },
      { id: 'empty-a', workgroupId: '', offset: 1, status: 'done' },
    ])
    await harness.session.transaction(async (tx) => {
      const { actual } = await compareInTransaction(harness, tx)
      expect(actual.rows).toHaveLength(1)
      expect(actual.rows[0]?.id).toBe('empty-z')
      expect(actual.rows[0]?.workgroupId).toBe('')
    })
  })

  test('adding the first workgroup in a transaction is visible and rollback restores all rows', async () => {
    await seed(harness.db, ordinaryRows())
    const before = await harness.db.select().from(tasks)
    const rollback = new Error('rollback first workgroup')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx.update(tasks).set({ workgroupId: '' }).where(eq(tasks.id, 'ordinary-37'))
        const { actual } = await compareInTransaction(harness, tx)
        expect(actual.rows).toHaveLength(1)
        expect(actual.rows[0]?.id).toBe('ordinary-37')
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(JSON.stringify(await harness.db.select().from(tasks))).toBe(JSON.stringify(before))
    await harness.session.transaction(async (tx) => {
      expect((await compareInTransaction(harness, tx)).actual.rows).toEqual([])
    })
  })

  test('deleting the last workgroup in a transaction is visible and rollback restores its JSON', async () => {
    await seed(harness.db, [...ordinaryRows(), observedValues[0]])
    const before = await harness.db.select().from(tasks)
    const rollback = new Error('rollback last workgroup deletion')
    await expect(
      harness.session.transaction(async (tx) => {
        expect((await compareInTransaction(harness, tx)).actual.rows).toHaveLength(1)
        await tx.delete(tasks).where(eq(tasks.id, observedValues[0].id))
        expect((await compareInTransaction(harness, tx)).actual.rows).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(JSON.stringify(await harness.db.select().from(tasks))).toBe(JSON.stringify(before))
    await harness.session.transaction(async (tx) => {
      expect((await compareInTransaction(harness, tx)).actual.rows).toHaveLength(1)
    })
  })
})

test('the original complete participant is retained outside its listActive FROM expression', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const original = source
    .replace(PROBE_FROM, '      .from(tasks)')
    .replace(
      "import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'",
      "import { and, eq, inArray, isNotNull } from 'drizzle-orm'",
    )
  expect(createHash('sha256').update(original).digest('hex')).toBe(ORIGINAL_SOURCE_HASH)
})

test('the actual PostgreSQL client preserves original SQL and every original binding', async () => {
  const statements: { sql: string; values: readonly unknown[] }[] = []
  const stop = new Error('W26 stopped at actual PostgreSQL client boundary')
  const pool: PostgresqlPool = {
    unsafe(sql, values = []) {
      statements.push({ sql, values })
      throw stop
    },
    async reserve() {
      throw new Error('unexpected PostgreSQL reservation')
    },
    async close() {},
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_W26_PG_URL',
      poolMax: 1,
      connectTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    },
    generationId: 'dbg_w26_workgroup_compiler',
    env: { RFC359_W26_PG_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => pool,
  })
  const previous = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(previous)
  const restore = selectDatabaseSchemaProvider('postgresql')
  async function rejectsAtClient(run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
      throw new Error('expected the actual client boundary failure')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw error
      expect(error.cause).toBe(stop)
    }
  }
  try {
    await rejectsAtClient(() => originalListActive(db))
    await rejectsAtClient(() => factory.inTransaction(db).listActive())
    expect(statements).toHaveLength(2)
    const original = statements[0]
    const actual = statements[1]
    if (!original || !actual) throw new Error('missing actual compiler statements')
    expect(actual.sql).toContain('nonempty_workgroup_scan')
    expect(originalCompiledSql(actual.sql)).toBe(original.sql)
    expect(original.values).toEqual([...CANCELABLE_TASK_STATUSES])
    expect(actual.values).toEqual(['', ...CANCELABLE_TASK_STATUSES])
  } finally {
    restore()
    await runtime.close()
  }
})
