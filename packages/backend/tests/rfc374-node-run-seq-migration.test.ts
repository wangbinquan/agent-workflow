// RFC-374 T3/T10: frozen SQLite and PostgreSQL histories upgrade legacy rows before catch-up; fresh schemas preserve nullable uniqueness.
import { frozenTablesOf } from '@/platform/persistence/migration/epoch1/tables'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { compareLegacyNodeRunMintOrder } from '@/modules/task-execution/infrastructure/migration/oracle/legacyOrder'
import { migrateSqlite } from '@/platform/persistence/sqliteMigrator'
import { migratePostgresqlSchema } from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import { replayPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import {
  backfillNodeRunSequences,
  createNodeRunSeqBackfillStore,
} from './helpers/rfc374LegacyBackfill'
import { describeEachProvider } from './helpers/eachProvider'
import { freezeAt, MIGRATIONS } from './migration-freeze'
import { seedSequenceTask, mintSequenceRun } from './helpers/rfc374Fixtures'

const frozen = freezeAt(258)
afterAll(() => rmSync(frozen, { recursive: true, force: true }))

const legacyTask = `INSERT INTO tasks (id,name,workflow_id,workflow_snapshot,repo_path,worktree_path,base_branch,branch,status,inputs,started_at) VALUES ('legacy-task','legacy','legacy-workflow','{}','/tmp/rfc374','/tmp/rfc374/task','main','task','running','{}',1)`
const legacyRuns = `INSERT INTO node_runs (id,task_id,node_id,status) VALUES ('z-legacy','legacy-task','n','done'), ('a-legacy','legacy-task','n','done')`
describeEachProvider('RFC-374 fresh and historical migration', (harness) => {
  test('target schema rejects NULL sequences and duplicate per-task sequences', async () => {
    const taskId = await seedSequenceTask(harness.db)
    const id = await mintSequenceRun(harness.db, taskId)
    const { nodeRuns } = tablesOf(harness.db)
    const [first] = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, id))
    expect(Number.isSafeInteger(first!.seq)).toBe(true)
    await expect(
      (async () => {
        await harness.db
          .update(nodeRuns)
          .set({ seq: sql`NULL` })
          .where(eq(nodeRuns.id, id))
      })(),
    ).rejects.toBeDefined()
    await expect(
      (async () => {
        await harness.db.insert(nodeRuns).values({ ...first!, id: 'duplicate-sequence' })
      })(),
    ).rejects.toBeDefined()
    expect(await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).toEqual([
      first!,
    ])
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
          const { nodeRuns } = frozenTablesOf(db)
          expect((await db.select().from(nodeRuns)).every((row) => row.seq === null)).toBe(true)
          await backfillNodeRunSequences(createNodeRunSeqBackfillStore(db))
          expect(
            (await db.select().from(nodeRuns))
              .sort(compareLegacyNodeRunMintOrder)
              .map((row) => row.id),
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
        const { nodeRuns } = frozenTablesOf(harness.db)
        expect((await harness.db.select().from(nodeRuns)).every((row) => row.seq === null)).toBe(
          true,
        )
        await backfillNodeRunSequences(createNodeRunSeqBackfillStore(harness.db))
        expect(
          (await harness.db.select().from(nodeRuns))
            .sort(compareLegacyNodeRunMintOrder)
            .map((row) => row.id),
        ).toEqual(['a-legacy', 'z-legacy'])
      }
    })
  },
  { sqliteMigrationsFolder: frozen },
)
