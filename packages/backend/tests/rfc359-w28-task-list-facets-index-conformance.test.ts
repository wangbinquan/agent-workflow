// RFC-359 W28: the original full task page and facet SQL keeps its complete
// ordered results when one additive index covers the facet read. Tiny plans
// prove the access mechanism; hosted full HTTP runs retain the latency gate.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'
import {
  createDatabaseTaskListPage,
  type TaskOperationsRawQuery,
} from '@/modules/task-execution/infrastructure/taskListPage'
import { parseTaskOperationsQuery } from '@/modules/task-execution/infrastructure/taskListPage/filters'
import type { OperationsSqlRow } from '@/modules/task-execution/infrastructure/taskListPage/projection'
import { fastFilteredRootQuery } from '@/modules/task-execution/infrastructure/taskListPage/query'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { renderPostgresqlUpgradeSql } from '@/platform/persistence/postgresqlMigrationSequence'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement } from './helpers/statementRecorder'

const INDEX = 'idx_tasks_list_facets_cover'
const COLUMNS = ['catalog_visibility', 'source_agent_name', 'workgroup_id', 'status', 'id']
const UPGRADE = '0002_rfc359_task_list_facets_index'
const SQLITE_MIGRATION = resolve(
  import.meta.dir,
  '../db/migrations/0226_rfc359_task_list_facets_index.sql',
)
const VIEWER = { userId: 'w28-facet-user', canReadAllTasks: true }
const OPTIONS = { catalogVisibility: 'public' } as const
const VIEWS = ['all', 'active', 'attention', 'finished'] as const

async function physicalRows(db: ProviderNeutralDatabase) {
  return {
    tasks: await db.select().from(tasks).orderBy(tasks.id),
    alerts: await db.select().from(lifecycleAlerts).orderBy(lifecycleAlerts.id),
  }
}

async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: VIEWER.userId,
    username: VIEWER.userId,
    displayName: 'W28 facet fixture',
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(workflows).values({
    id: 'w28-facet-workflow',
    name: 'W28 facet workflow',
    definition: '{}',
    createdAt: 1,
    updatedAt: 1,
  })
  const statuses = [
    'running',
    'pending',
    'awaiting_human',
    'awaiting_review',
    'done',
    'failed',
    'canceled',
  ] as const
  for (let index = 0; index < 96; index++) {
    const id = `w28-facet-${String(index).padStart(3, '0')}`
    await db.insert(tasks).values({
      id,
      name: `fixture ${index}`,
      workflowId: 'w28-facet-workflow',
      workflowSnapshot: '{ "fixture": true }',
      inputs: '{ "bytes": [null,1] }',
      repoPath: '/fixture/repo',
      worktreePath: `/fixture/${id}`,
      baseBranch: 'main',
      branch: `task/${id}`,
      status: statuses[index % statuses.length]!,
      startedAt: 10_000 - index,
      finishedAt: 11_000 + index,
      parentTaskId: null,
      rootTaskId: id,
      branchStartedAt: 10_000 - index,
      executionLineageId: id,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
      ]),
      ownerUserId: VIEWER.userId,
      launchOrigin: 'manual',
      catalogVisibility: index % 11 === 0 ? 'internal' : 'public',
      sourceAgentName: index % 3 === 0 ? 'fixture source' : null,
      workgroupId: index % 7 === 0 ? 'fixture-workgroup' : null,
      repoCount: 1,
    })
    if (index % 8 === 0) {
      await db.insert(lifecycleAlerts).values({
        id: `w28-alert-${index}`,
        taskId: id,
        rule: `fixture-${index}`,
        severity: 'warn',
        detail: '{ "bytes": [1,null] }',
        detectedAt: 1,
        resolvedAt: index % 16 === 0 ? null : 2,
      })
    }
  }
}

function statementContract(statements: readonly RecordedStatement[]) {
  return statements.map(({ sql, params, values }) => ({ sql, params, values }))
}

async function observe(
  harness: ProviderHarness,
  db: ProviderNeutralDatabase,
  raw: TaskOperationsRawQuery,
) {
  const recording = harness.recordStatements()
  let rows: OperationsSqlRow[]
  let statements: RecordedStatement[]
  try {
    rows = await db.all<OperationsSqlRow>(
      fastFilteredRootQuery(
        db,
        VIEWER,
        parseTaskOperationsQuery(VIEWER, raw, OPTIONS),
        OPTIONS.catalogVisibility,
      ),
    )
    statements = [...recording.statements]
  } finally {
    recording.stop()
  }
  expect(statements).toHaveLength(1)
  const statement = statements[0]!
  expect(statement.values.length).toBeGreaterThan(0)
  expect(statement.params).toBe(statement.values.length)
  const pageRecording = harness.recordStatements()
  try {
    const page = await createDatabaseTaskListPage(db, composeOwnerIdentityQueries(db)).list(
      VIEWER,
      raw,
      OPTIONS,
    )
    expect(page.kind).toBe('root')
    return {
      raw,
      rows,
      page,
      statements: statementContract(statements),
      pageStatements: statementContract(pageRecording.statements),
    }
  } finally {
    pageRecording.stop()
  }
}

async function pages(harness: ProviderHarness, db: ProviderNeutralDatabase) {
  const observations = []
  for (const view of VIEWS) {
    const raw = { view, limit: '10' }
    const first = await observe(harness, db, raw)
    observations.push(first)
    if (first.page.nextCursor !== null) {
      observations.push(await observe(harness, db, { ...raw, cursor: first.page.nextCursor }))
    }
  }
  return observations
}

async function indexExists(harness: ProviderHarness): Promise<boolean> {
  const rows =
    harness.capabilities.provider === 'sqlite'
      ? await harness.db.all<{ name: string }>(sql`
          SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${INDEX}
        `)
      : await harness.db.all<{ name: string }>(sql`
          SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = 'agent_workflow' AND indexname = ${INDEX}
        `)
  return rows.length === 1
}

async function createIndexStatement(harness: ProviderHarness): Promise<string> {
  if (harness.capabilities.provider === 'sqlite') {
    return readFileSync(SQLITE_MIGRATION, 'utf8')
  }
  const history = await loadPostgresqlMigrationHistory()
  const step = history.steps.find((candidate) => candidate.id === UPGRADE)
  if (step === undefined || step.indexAdditions.length !== 1) {
    throw new Error('missing exact task facet index upgrade')
  }
  return step.indexAdditions[0]!.statement.sql
}

async function dropIndex(harness: ProviderHarness): Promise<void> {
  const prefix = harness.capabilities.provider === 'postgresql' ? 'agent_workflow.' : ''
  await harness.executeFixtureDdl(`DROP INDEX IF EXISTS ${prefix}${INDEX}`)
}

async function compareIndexStates<T>(
  harness: ProviderHarness,
  read: () => Promise<T>,
): Promise<{ original: T; indexed: T }> {
  const initiallyPresent = await indexExists(harness)
  const recreate = await createIndexStatement(harness)
  let present = initiallyPresent
  try {
    await dropIndex(harness)
    present = false
    const original = await read()
    await harness.executeFixtureDdl(recreate)
    present = true
    const indexed = await read()
    expect(indexed).toEqual(original)
    expect(JSON.stringify(indexed)).toBe(JSON.stringify(original))
    return { original, indexed }
  } finally {
    if (initiallyPresent && !present) await harness.executeFixtureDdl(recreate)
    if (!initiallyPresent && present) await dropIndex(harness)
  }
}

test('the appended history adds exactly the facet index and retains its preceding receipt', async () => {
  const history = await loadPostgresqlMigrationHistory()
  const step = history.steps.find((candidate) => candidate.id === UPGRADE)
  expect(step).toBeDefined()
  if (step === undefined) throw new Error('missing facet index history')
  expect(step.sequence).toBe(2)
  expect(step.previousEntryDigest).toBe(history.steps[0]!.digest)
  expect(step.indexAdditions).toHaveLength(1)
  expect(step.indexAdditions[0]!.statement.logicalId).toBe(`tasks:index:${INDEX}`)
  expect(step.sqliteMigration.from.count).toBe(225)
  expect(step.sqliteMigration.to.count).toBe(226)
  expect(step.sqliteMigration.appended.map((migration) => migration.tag)).toEqual([
    '0226_rfc359_task_list_facets_index',
  ])
  expect(
    readFileSync(resolve(import.meta.dir, '../db/postgresql-migrations', step.sqlFile), 'utf8'),
  ).toBe(renderPostgresqlUpgradeSql(step))
})

describeEachProvider('RFC-359 W28 task list facet covering index', (harness) => {
  test('actual catalogs expose the exact five-column non-unique non-partial index', async () => {
    if (harness.capabilities.provider === 'sqlite') {
      const columns = await harness.db.all<{ name: string }>(
        sql.raw(`PRAGMA index_info('${INDEX}')`),
      )
      expect(columns.map((column) => column.name)).toEqual(COLUMNS)
      const indexes = await harness.db.all<{ name: string; unique: number; partial: number }>(
        sql.raw('PRAGMA index_list(tasks)'),
      )
      const actual = indexes.find((index) => index.name === INDEX)
      expect(actual?.unique).toBe(0)
      expect(actual?.partial).toBe(0)
    } else {
      const rows = await harness.db.all<{ indexdef: string }>(sql`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'agent_workflow' AND indexname = ${INDEX}
      `)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.indexdef).toContain(`(${COLUMNS.join(', ')})`)
      expect(rows[0]!.indexdef).not.toContain('UNIQUE')
      expect(rows[0]!.indexdef).not.toContain(' WHERE ')
    }
  })

  test('empty full pages and all four facet results retain every SQL binding', async () => {
    const result = await compareIndexStates(harness, async () => ({
      observations: await pages(harness, harness.db),
      physical: await physicalRows(harness.db),
    }))
    expect(result.original.observations).toHaveLength(4)
    for (const observed of result.original.observations) {
      expect(observed.page.items).toEqual([])
      expect(observed.page.nextCursor).toBeNull()
      expect(observed.rows).toHaveLength(1)
    }
  })

  test('96 tasks and 12 alerts retain full rows, ordered pages, facets and real cursors', async () => {
    await seed(harness.db)
    const result = await compareIndexStates(harness, async () => ({
      observations: await pages(harness, harness.db),
      physical: await physicalRows(harness.db),
    }))
    expect(result.original.physical.tasks).toHaveLength(96)
    expect(result.original.physical.alerts).toHaveLength(12)
    expect(result.original.observations).toHaveLength(8)
    for (let index = 0; index < result.original.observations.length; index += 2) {
      const first = result.original.observations[index]!
      const second = result.original.observations[index + 1]!
      expect(first.page.items).toHaveLength(10)
      expect(first.page.nextCursor).toBe(second.raw.cursor!)
      expect(second.page.items).toHaveLength(10)
      const ids = [...first.page.items, ...second.page.items].map((item) => item.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('transactional task and alert changes are visible before identical full rollback', async () => {
    await seed(harness.db)
    const before = await physicalRows(harness.db)
    const first = await observe(harness, harness.db, { view: 'all', limit: '10' })
    await compareIndexStates(harness, async () => {
      const sentinel = new Error('facet index transaction rollback')
      let changed: { observation: Awaited<ReturnType<typeof observe>>; physical: typeof before }
      await expect(
        harness.session.transaction(async (tx) => {
          await tx
            .update(tasks)
            .set({ status: 'done', name: 'changed inside transaction' })
            .where(eq(tasks.id, 'w28-facet-001'))
          await tx
            .update(lifecycleAlerts)
            .set({ resolvedAt: null })
            .where(eq(lifecycleAlerts.id, 'w28-alert-8'))
          const observation = await observe(harness, tx, { view: 'all', limit: '10' })
          const physical = await physicalRows(tx)
          expect(observation.page).not.toEqual(first.page)
          expect(physical).not.toEqual(before)
          changed = { observation, physical }
          throw sentinel
        }),
      ).rejects.toBe(sentinel)
      expect(await physicalRows(harness.db)).toEqual(before)
      expect(JSON.stringify(await physicalRows(harness.db))).toBe(JSON.stringify(before))
      expect((await observe(harness, harness.db, { view: 'all', limit: '10' })).page).toEqual(
        first.page,
      )
      return changed!
    })
  })

  test('the actual facet read uses coverage only when the complete index is present', async () => {
    await seed(harness.db)
    const initiallyPresent = await indexExists(harness)
    const recreate = await createIndexStatement(harness)
    const raw = { view: 'all', limit: '10' } as const
    try {
      await dropIndex(harness)
      const original = await observe(harness, harness.db, raw)
      const originalStatement = original.statements[0]!
      const originalPlan = await harness.explain({
        ...originalStatement,
        rows: original.rows.length,
      })
      await harness.executeFixtureDdl(recreate)
      const indexed = await observe(harness, harness.db, raw)
      expect(indexed).toEqual(original)
      expect(JSON.stringify(indexed)).toBe(JSON.stringify(original))
      const indexedStatement = indexed.statements[0]!
      const indexedPlan = await harness.explain({ ...indexedStatement, rows: indexed.rows.length })
      expect(originalPlan.length).toBeGreaterThan(0)
      expect(indexedPlan.length).toBeGreaterThan(0)
      if (harness.capabilities.provider === 'sqlite') {
        const facetPrefix = (plan: string) => plan.split('MATERIALIZE paged')[0]!
        expect(facetPrefix(originalPlan)).toContain('CO-ROUTINE facet_values')
        expect(facetPrefix(originalPlan)).toContain('SCAN t')
        expect(facetPrefix(originalPlan)).not.toContain(`COVERING INDEX ${INDEX}`)
        expect(facetPrefix(indexedPlan)).toContain(`USING COVERING INDEX ${INDEX}`)
        // A real but incomplete physical index must preserve query rows while
        // failing to cover the facet projection. No query rows are substituted.
        await dropIndex(harness)
        await harness.executeFixtureDdl(`CREATE INDEX ${INDEX} ON tasks (catalog_visibility)`)
        const incomplete = await observe(harness, harness.db, raw)
        expect(incomplete).toEqual(original)
        const incompleteStatement = incomplete.statements[0]!
        const incompletePlan = await harness.explain({
          ...incompleteStatement,
          rows: incomplete.rows.length,
        })
        expect(facetPrefix(incompletePlan)).not.toContain(`COVERING INDEX ${INDEX}`)
      }
    } finally {
      await dropIndex(harness)
      if (initiallyPresent) await harness.executeFixtureDdl(recreate)
    }
  })
})
