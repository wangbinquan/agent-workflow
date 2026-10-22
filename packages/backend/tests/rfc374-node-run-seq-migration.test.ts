// RFC-374 T3/T10: frozen SQLite and PostgreSQL histories upgrade legacy rows before catch-up; fresh schemas preserve nullable uniqueness.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { compareNodeRunMintOrder } from '@agent-workflow/shared'
import { migrateSqlite } from '@/platform/persistence/sqliteMigrator'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { replayPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { backfillNodeRunSequences } from '@/modules/task-execution/application/nodeRunSeqBackfill'
import { createNodeRunSeqBackfillStore } from '@/modules/task-execution/infrastructure/nodeRunSeqBackfillStore'
import { describeEachProvider } from './helpers/eachProvider'
import { freezeAt, MIGRATIONS } from './migration-freeze'
import { seedSequenceTask } from './helpers/rfc374Fixtures'

const frozen = freezeAt(258)
afterAll(() => rmSync(frozen, { recursive: true, force: true }))

const legacyTask = `INSERT INTO tasks (id,name,workflow_id,workflow_snapshot,repo_path,worktree_path,base_branch,branch,status,inputs,started_at) VALUES ('legacy-task','legacy','legacy-workflow','{}','/tmp/rfc374','/tmp/rfc374/task','main','task','running','{}',1)`
const legacyRuns = `INSERT INTO node_runs (id,task_id,node_id,status) VALUES ('z-legacy','legacy-task','n','done'), ('a-legacy','legacy-task','n','done')`
describeEachProvider('RFC-374 fresh and historical migration', (harness) => {
  test('fresh schema accepts multiple NULLs but enforces allocated per-task uniqueness', async () => {
    const taskId = await seedSequenceTask(harness.db)
    const { nodeRuns } = tablesOf(harness.db)
    await harness.db.insert(nodeRuns).values([
      { id: 'null-a', taskId, nodeId: 'n', status: 'done' },
      { id: 'null-b', taskId, nodeId: 'n', status: 'done' },
    ])
    await insertOne(harness.db, nodeRuns, {
      id: 'one',
      taskId,
      nodeId: 'n',
      status: 'done',
      seq: 4,
    })
    // Native SQLite throws synchronously; normalize only the fixture invocation.
    await expect(
      (async () => {
        await insertOne(harness.db, nodeRuns, {
          id: 'two',
          taskId,
          nodeId: 'n',
          status: 'done',
          seq: 4,
        })
      })(),
    ).rejects.toBeDefined()
    expect(
      (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (row) => row.seq === null,
      ),
    ).toHaveLength(2)
  })
})

describeEachProvider(
  'RFC-374 frozen history upgrade',
  (harness) => {
    test('the actual frozen history upgrades and preserves the legacy ID oracle after catch-up', async () => {
      if (harness.applicationBinding.provider === 'sqlite') {
        const db = harness.db
        const sqlite: unknown = Reflect.get(db, '$client')
        if (!(sqlite instanceof Database)) throw new Error('expected sqlite')
        try {
          // Frozen tables must use an explicit column list, never HEAD drizzle inserts.
          sqlite.exec(legacyTask)
          sqlite.exec(legacyRuns)
          expect(
            sqlite
              .query('PRAGMA table_info(node_runs)')
              .all()
              .some((row) => (row as { name: string }).name === 'seq'),
          ).toBe(false)
          migrateSqlite(sqlite, { migrationsFolder: MIGRATIONS })
          const { nodeRuns } = tablesOf(db)
          expect((await db.select().from(nodeRuns)).every((row) => row.seq === null)).toBe(true)
          await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))
          expect(
            (await db.select().from(nodeRuns)).sort(compareNodeRunMintOrder).map((row) => row.id),
          ).toEqual(['a-legacy', 'z-legacy'])
        } finally {
          sqlite.close()
        }
      } else {
        const runtime = harness.applicationBinding.runtime,
          pool = runtime.providerPool()
        const history = await loadPostgresqlMigrationHistory({
            headContract: buildLogicalSchemaContract(),
          }),
          prefix = replayPostgresqlMigrationHistory(
            history.root,
            history.steps.slice(
              0,
              history.steps.findIndex((step) => step.id === '0036_rfc374_node_run_seq'),
            ),
          )
        expect(prefix.steps.at(-1)!.id).toBe('0035_rfc370_hosted_deployment')
        await pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
        await migratePostgresqlSchema({
          headContract: buildLogicalSchemaContract(),
          runtime,
          history: prefix,
        })
        await pool.unsafe(legacyTask.replace('INTO tasks', 'INTO agent_workflow.tasks'))
        await pool.unsafe(legacyRuns.replace('INTO node_runs', 'INTO agent_workflow.node_runs'))
        await migratePostgresqlSchema({
          headContract: buildLogicalSchemaContract(),
          runtime,
          history,
        })
        await pool.unsafe(
          `INSERT INTO agent_workflow_meta.logical_copy_operations (operation_id,source_generation_id,contract_digest,plan_digest,stage,created_at,updated_at) VALUES ('dbm_rfc374_upgrade','dbg_rfc374_source','digest','plan','prepared',1,1)`,
        )
        await pool.unsafe(
          `INSERT INTO agent_workflow_meta.database_generations (generation_id,operation_id,source_generation_id,contract_digest,state,activated_at,first_live_write_at) VALUES ($1,'dbm_rfc374_upgrade','dbg_rfc374_source','digest','active',1,1)`,
          [runtime.generationId],
        )
        const { nodeRuns } = tablesOf(harness.db)
        expect((await harness.db.select().from(nodeRuns)).every((row) => row.seq === null)).toBe(
          true,
        )
        await backfillNodeRunSequences(createNodeRunSeqBackfillStore(harness.db))
        expect(
          (await harness.db.select().from(nodeRuns))
            .sort(compareNodeRunMintOrder)
            .map((row) => row.id),
        ).toEqual(['a-legacy', 'z-legacy'])
      }
    })
  },
  { sqliteMigrationsFolder: frozen },
)
