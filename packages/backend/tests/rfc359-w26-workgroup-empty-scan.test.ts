import { taskReadColumns } from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC359 W26: preserve the original ordered listActive result and its single
// transaction snapshot while an empty workgroup index can avoid the task scan.
// The earlier W23 predicate/index probes changed nonempty order and were rejected.

import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'
import type { TaskExecutionTransaction } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import type { WorkgroupTaskRoomTaskSnapshot } from '@/modules/task-execution/public/commands'
import { taskWorkgroupConfigSelection } from '@/modules/task-execution/public/operations'
import {
  taskSubjectFromDefinition,
  TASK_DEFINITION_HOSTS,
} from '@/modules/task-execution/public/queries'
import type { TaskDefinitionSubject } from '@/modules/task-execution/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'

import { insertOne } from '@/platform/persistence/singleInsert'
import { CANCELABLE_TASK_STATUSES, type TaskStatus } from '@agent-workflow/shared'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  readTaskFixtures,
  taskFixture,
  workflowFixture,
  type TaskFixtureSpec,
} from './helpers/model'
import type { RecordedStatement } from './helpers/statementRecorder'

// RFC-374: the participant's two node-run projections also carry `seq` (outside the probe).
// RFC-395 I-b: one session table destructuring now serves the whole write transaction.
// RFC-395 II-a A2: subject inputs and decoding are mirrored in the former-wiring oracle.
// RFC-395 II-b: the captured pre-T source reproduces 05b89c96. Rebaseline only the
// target task projection, frozen discriminator, and covering-index probe; preserve the inverse and row/byte assertions.
// M-c: include activated nodeRunReadColumns/table-selection and task definition projection; inverse remains exact.
const ORIGINAL_SOURCE_HASH = '94cb2ca3af10e30b2f453c9c7256f147195044c07c6c33b3ff592da1da30bbfe'
const SOURCE_PATH = resolve(
  import.meta.dir,
  '../src/modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts',
)
const PROBE_FROM = [
  '      .from(',
  "        sql`(SELECT 1 AS workgroup_present FROM ${taskDefinitions} WHERE ${taskDefinitions.subjectKind} = 'workgroup' LIMIT 1) AS nonempty_workgroup_scan`,",
  '      )',
  '      .crossJoin(tasks)',
].join('\n')

/**
 * 探针上方那段说明为什么它必须是**常量谓词**的注释（RFC-359 AC-11）。它和 `PROBE_FROM`
 * 一样属于「探针带来的偏离」，所以下面的原文比对要连它一起剥掉——本判据钉的是
 * **除探针之外的参与者逐字未变**，注释不是行为。
 */
const PROBE_DOC_START = '  /**\n   * 空工作组的短路探针'
const PROBE_DOC_END = '   */\n'

function normalizedQualification(value: string): string {
  return value.replace(
    /(?:"agent_workflow"\.)?"(?:tasks|task_definitions|task_launch_contexts|task_workspaces|task_repository_mounts|workgroup_task_state)"\./g,
    '',
  )
}
function originalCompiledSql(value: string): string {
  if (!value.includes('nonempty_workgroup_scan')) return normalizedQualification(value)
  const probe =
    / from \(SELECT 1 AS workgroup_present FROM ((?:"[^" ]+"\.)?"task_definitions") WHERE \1\."subject_kind" = 'workgroup' LIMIT 1\) AS nonempty_workgroup_scan cross join ((?:"[^" ]+"\.)?"tasks")/.exec(
      value,
    )
  if (!probe) throw new Error('unrecognized actual target probe SQL')
  const original = value.replace(probe[0], ` from ${probe[2]}`)
  if (original.includes('nonempty_workgroup_scan')) throw new Error('unrecognized actual probe SQL')
  return normalizedQualification(original)
}

function taskSnapshot(
  row: Omit<WorkgroupTaskRoomTaskSnapshot, 'status' | 'subject'> &
    TaskDefinitionSubject & { readonly status: string },
): WorkgroupTaskRoomTaskSnapshot {
  return Object.freeze({
    ...row,
    subject: taskSubjectFromDefinition(row),
    status: row.status as TaskStatus,
  })
}

const taskProjection = (db: object) => {
  const { tasks } = tablesOf(db)
  return {
    id: tasks.id,
    name: tasks.name,
    ownerUserId: tasks.ownerUserId,
    status: tasks.status,
    workgroupId: taskReadColumns(db).workgroupId,
    workflowId: taskReadColumns(db).workflowId,
    subjectKind: taskReadColumns(db).subjectKind,
    sourceId: taskReadColumns(db).sourceId,
    sourceName: taskReadColumns(db).sourceName,
    codeRoundId: taskReadColumns(db).codeRoundId,
    sourceAgentId: taskReadColumns(db).sourceAgentId,
    sourceAgentName: taskReadColumns(db).sourceAgentName,
    workgroupConfig: taskWorkgroupConfigSelection(db),
    workflowSnapshot: taskReadColumns(db).workflowSnapshot,
    triggerContextJson: taskReadColumns(db).triggerContextJson,
  }
}

// Exact original listActive body, including its projection, predicate and mapper.
async function originalListActive(
  tx: TaskExecutionTransaction,
): Promise<readonly WorkgroupTaskRoomTaskSnapshot[]> {
  const { tasks } = tablesOf(tx)
  const rows = await tx
    .select(taskProjection(tx))
    .from(tasks)
    .where(
      and(
        isNotNull(taskReadColumns(tx).workgroupId),
        inArray(tasks.status, [...CANCELABLE_TASK_STATUSES]),
      ),
    )
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

async function seed(db: PersistenceDb, values: readonly FixtureRow[]): Promise<void> {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
    id: 'wg-index-user',
    username: 'wg-index-user',
    displayName: 'fixture',
    role: 'admin',
    status: 'active',
    passwordHash: 'fixture',
    createdAt: 1,
    updatedAt: 1,
  })
  await workflowFixture(db, {
    id: 'wg-index-workflow',
    name: 'fixture',
    definition: '{}',
    createdAt: 1,
    updatedAt: 1,
  })
  if (values.length === 0) return
  const rows: TaskFixtureSpec[] = values.map((row, i) => ({
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
  await taskFixture(db, rows)
  for (const row of values) {
    if (row.workgroupId !== null) await setWorkgroupSubject(db, row.id, row.workgroupId)
  }
}

async function setWorkgroupSubject(
  db: PersistenceDb | TaskExecutionTransaction,
  id: string,
  sourceId: string,
) {
  const { taskDefinitions } = tablesOf(db)
  // This oracle deliberately exercises a non-NULL empty source id. The legacy
  // fixture decoder treats empty ids as absent, so seed the target discriminator explicitly.
  await db
    .update(taskDefinitions)
    .set({ subjectKind: 'workgroup', sourceId, definitionOrigin: 'platform' })
    .where(eq(taskDefinitions.taskId, id))
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
  const before = await readTaskFixtures(tx)
  const original = await recorded(harness, () => originalListActive(tx))
  const actual = await recorded(harness, () => factory.inTransaction(tx).listActive())
  expect(actual.rows).toEqual(original.rows)
  expect(JSON.stringify(actual.rows)).toBe(JSON.stringify(original.rows))
  expect(Object.isFrozen(actual.rows)).toBe(true)
  expect(actual.rows.every(Object.isFrozen)).toBe(true)
  const after = await readTaskFixtures(tx)
  expect(after).toEqual(before)
  expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  expect(originalCompiledSql(actual.statement.sql)).toBe(
    normalizedQualification(original.statement.sql),
  )
  // RFC-359 AC-11 —— 探针是常量谓词，**一个绑定值都不占**（旧写法 `>= ${''}` 会占掉第一个）。
  // 于是不论探针在不在，绑定值都必须与原始查询**逐字相同**；这比原先「切掉第一个再比」更强。
  expect(actual.statement.values).toEqual(original.statement.values)
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
  // The status predicate occurs only in the outer WHERE, after the correlated projections.
  const status = /(?:"agent_workflow"\.)?"tasks"\."status" in \([^)]*\)/i.exec(statement.sql)
  if (!status) throw new Error('missing outer target status predicate')
  return statement.sql.replace(
    status[0],
    () =>
      `CASE WHEN json_extract('W26 task row visited ' || "tasks"."id", '$') IS NULL THEN (${status[0]}) ELSE 0 END`,
  )
}

describeEachProvider('RFC359 W26 workgroup empty scan', (harness) => {
  test('an empty physical task table keeps the complete empty result', async () => {
    expect(await readTaskFixtures(harness.db)).toEqual([])
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
        expect(candidatePlan).toMatch(
          /SEARCH task_definitions USING COVERING INDEX task_definitions_(?:subject_task|source_name) \(subject_kind=\?\)/,
        )
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
    const { taskDefinitions } = tablesOf(harness.db)
    expect(taskDefinitions.sourceId.getSQLType()).toBe('text')
    expect(taskDefinitions.sourceId.notNull).toBe(false)
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
          >("SELECT typeof(CASE WHEN subject_kind = 'workgroup' THEN source_id END) AS storage_type, CASE WHEN subject_kind = 'workgroup' THEN source_id END AS workgroup_id FROM task_definitions")
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
    const before = await readTaskFixtures(harness.db)
    const rollback = new Error('rollback first workgroup')
    await expect(
      harness.session.transaction(async (tx) => {
        await setWorkgroupSubject(tx, 'ordinary-37', '')
        const { actual } = await compareInTransaction(harness, tx)
        expect(actual.rows).toHaveLength(1)
        expect(actual.rows[0]?.id).toBe('ordinary-37')
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(JSON.stringify(await readTaskFixtures(harness.db))).toBe(JSON.stringify(before))
    await harness.session.transaction(async (tx) => {
      expect((await compareInTransaction(harness, tx)).actual.rows).toEqual([])
    })
  })

  test('deleting the last workgroup in a transaction is visible and rollback restores its JSON', async () => {
    await seed(harness.db, [...ordinaryRows(), observedValues[0]])
    const before = await readTaskFixtures(harness.db)
    const rollback = new Error('rollback last workgroup deletion')
    await expect(
      harness.session.transaction(async (tx) => {
        expect((await compareInTransaction(harness, tx)).actual.rows).toHaveLength(1)
        const { tasks } = tablesOf(tx)
        await tx.delete(tasks).where(eq(tasks.id, observedValues[0].id))
        expect((await compareInTransaction(harness, tx)).actual.rows).toEqual([])
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(JSON.stringify(await readTaskFixtures(harness.db))).toBe(JSON.stringify(before))
    await harness.session.transaction(async (tx) => {
      expect((await compareInTransaction(harness, tx)).actual.rows).toHaveLength(1)
    })
  })
})

// RFC-395 II-a A2: the inverse retains the definition writer/config port wiring; query/result comparisons remain.
test('the original complete participant is retained outside its listActive FROM expression', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const docStart = source.indexOf(PROBE_DOC_START)
  if (docStart < 0) throw new Error('missing the probe explanation comment')
  const docEnd = source.indexOf(PROBE_DOC_END, docStart)
  if (docEnd < 0) throw new Error('unterminated probe explanation comment')
  const original = source
    .slice(0, docStart)
    .concat(source.slice(docEnd + PROBE_DOC_END.length))
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
  const db = createPostgresqlDatabaseClient(runtime)
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
    expect(originalCompiledSql(actual.sql)).toBe(normalizedQualification(original.sql))
    expect(original.values).toEqual([
      TASK_DEFINITION_HOSTS.agent.id,
      TASK_DEFINITION_HOSTS.workgroup.id,
      TASK_DEFINITION_HOSTS['digital-employee'].id,
      TASK_DEFINITION_HOSTS['code-round'].id,
      ...CANCELABLE_TASK_STATUSES,
    ])
    // 探针不再绑定任何值，所以 actual 与 original 的绑定逐字相同。
    expect(actual.values).toEqual(original.values)
  } finally {
    await runtime.close()
  }
})
