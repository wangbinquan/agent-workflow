// RFC-374 T10: real SQLite logical copying preserves run seq and the pruned allocation high-water row; PostgreSQL identity continues above it.
// RFC-395: both sources and targets use the installed epoch-2 head, including
// native schema-history admission and the original allocator continuity checks.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { taskFixture, workflowFixture, nodeRunFixture } from './helpers/model'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ulid } from 'ulid'
import { first } from '@/platform/persistence/queryHelpers'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, lt } from 'drizzle-orm'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/schema/history/logicalHistory'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import { restoreLogicalDatabaseBackup } from '@/platform/persistence/logicalDatabaseRestore'
import { describeEachProvider } from './helpers/eachProvider'
async function seedSequenceTask(db: PersistenceDb): Promise<string> {
  const id = ulid()
  await workflowFixture(db, { id, name: id, definition: '{}' })
  await taskFixture(db, {
    id,
    name: id,
    workflowId: id,
    workflowSnapshot: '{}',
    repoPath: '/rfc374/repo',
    worktreePath: '/rfc374/task',
    baseBranch: 'main',
    branch: id,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
  })
  return id
}
async function mintSequenceRun(
  db: PersistenceDb,
  taskId: string,
  input: { id: string },
): Promise<string> {
  return databaseSessionFor(db).transaction(async (tx) => {
    const { nodeRunSeqAllocations } = tablesOf(tx)
    const [run] = await nodeRunFixture(tx, {
      id: input.id,
      taskId,
      nodeId: 'n',
      status: 'done',
      startedAt: 1,
    })
    if (!run) throw new Error('node-run-seq-allocation-missing')
    await tx.delete(nodeRunSeqAllocations).where(lt(nodeRunSeqAllocations.seq, run.seq))
    return input.id
  })
}

describeEachProvider(
  'RFC-374 SQLite copy source',
  (sourceHarness) => {
    describeEachProvider('RFC-374 logical copy sequence continuity', (harness) => {
      test('copied seq and allocator stay equal to source, and the next identity is newer', async () => {
        const root = mkdtempSync(join(tmpdir(), 'rfc374-copy-')),
          path = join(root, 'source.sqlite'),
          artifactRoot = join(root, 'artifact')
        const sourceDb = sourceHarness.db,
          sqlite: unknown = Reflect.get(sourceDb, '$client')
        if (!(sqlite instanceof Database)) throw new Error('expected sqlite source')
        let taskId: string,
          runs: PersistenceTables['nodeRuns']['$inferSelect'][],
          allocations: PersistenceTables['nodeRunSeqAllocations']['$inferSelect'][]
        try {
          taskId = await seedSequenceTask(sourceDb)
          await mintSequenceRun(sourceDb, taskId, { id: 'z-old' })
          await mintSequenceRun(sourceDb, taskId, { id: 'a-new' })
          const { nodeRuns, nodeRunSeqAllocations } = tablesOf(sourceDb)
          await sourceDb
            .update(tablesOf(sourceDb).tasks)
            .set({ status: 'done', finishedAt: 2 })
            .where(eq(tablesOf(sourceDb).tasks.id, taskId))
          runs = await sourceDb.select().from(nodeRuns)
          allocations = await sourceDb.select().from(nodeRunSeqAllocations)
          writeFileSync(path, sqlite.serialize())
        } finally {
          sqlite.close()
        }
        const history = await loadPostgresqlMigrationHistory({
            headContract: logicalSchemaContract,
          }),
          source = openSqliteLogicalSource({ path, contract: history.head.contract })
        try {
          const snapshot = await source.preflight()
          const exported = await exportLogicalDatabaseArtifact({
            operationId: 'dbm_rfc374_source_copy',
            sourceProvider: 'sqlite',
            sourceGenerationId: 'dbg_rfc374_source_copy',
            contract: history.head.contract,
            artifactRoot,
            expectedTableRows: snapshot.tableRows,
            source: {
              provider: 'sqlite',
              assertUnchanged: () => source.assertUnchanged(snapshot),
              readChunk: (table, after, limit) => source.readChunk(table, after, limit),
              readMetadata: () => source.readMetadata!(),
            },
            now: () => 10,
          })
          expect(snapshot.tableRows.node_runs).toBe(runs.length)
          expect(snapshot.tableRows.node_run_seq_allocations).toBe(allocations.length)
          if (harness.applicationBinding.provider === 'postgresql') {
            const runtime = harness.applicationBinding.runtime,
              pool = runtime.providerPool()
            await pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
            await pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
            const target = await openPostgresqlLogicalTarget({
              headContract: logicalSchemaContract,
              runtime,
              operationId: 'dbm_rfc374_target_copy',
              sourceGenerationId: 'dbg_rfc374_source_copy',
              contract: history.head.contract,
              plan: history.head.plan,
            })
            try {
              await restoreLogicalDatabaseBackup({
                headContract: logicalSchemaContract,
                artifactRoot,
                expectedEnvelopeFileDigest: exported.envelopeFileDigest,
                restoreOperationId: 'dbm_rfc374_target_copy',
                contract: history.head.contract,
                target,
              })
              await target.prepareGeneration({
                generationId: runtime.generationId,
                sourceGenerationId: 'dbg_rfc374_source_copy',
              })
              await target.activateGeneration(runtime.generationId, 20)
              await target.assertReady(runtime.generationId)
              await target.markFinalized(20)
            } finally {
              await target.close()
            }
            const { nodeRuns, nodeRunSeqAllocations } = tablesOf(harness.db)
            expect(
              (await harness.db.select().from(nodeRuns))
                .map(({ id, seq }) => ({ id, seq }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            ).toEqual(
              runs.map(({ id, seq }) => ({ id, seq })).sort((a, b) => a.id.localeCompare(b.id)),
            )
            expect(await harness.db.select().from(nodeRunSeqAllocations)).toEqual(allocations)
            // Read the copied generation through the PG logical source as well, so both
            // provider adapters prove the same portable seq and allocator representation.
            const copied = await openPostgresqlLogicalSource({
              runtime,
              generationId: runtime.generationId,
              contract: history.head.contract,
            })
            try {
              const copiedSnapshot = await copied.preflight()
              expect(copiedSnapshot.tableRows.node_runs).toBe(runs.length)
              expect(copiedSnapshot.tableRows.node_run_seq_allocations).toBe(allocations.length)
              for (const name of ['node_runs', 'node_run_seq_allocations']) {
                const table = history.head.contract.tables.find(
                  (entry) => entry.sourceTable === name,
                )!
                expect(await copied.readChunk(table, null, 100)).toEqual(
                  await source.readChunk(table, null, 100),
                )
              }
            } finally {
              await copied.close()
            }
            const next = await mintSequenceRun(harness.db, taskId, { id: '0-next' })
            expect(
              (await first(harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, next))))!.seq!,
            ).toBeGreaterThan(allocations[0]!.seq)
          }
        } finally {
          await source.close()
          rmSync(root, { recursive: true, force: true })
        }
      }, 60000)
    })
  },
  { providers: ['sqlite'] },
)
