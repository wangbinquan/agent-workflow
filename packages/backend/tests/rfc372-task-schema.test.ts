// RFC-372 lightweight revision: obsolete tables retire through official forward migrations.
import { describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInMemoryDb } from '@/db/client'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  postgresqlMigrationDigest,
  postgresqlUpgradeStatementSql,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlAdditiveRowBridge,
  resolvePostgresqlIndexOnlyRowBridge,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { freezeAt, MIGRATIONS } from './migration-freeze'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import { restoreLogicalDatabaseBackup } from '@/platform/persistence/logicalDatabaseRestore'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import { describeEachProvider } from './helpers/eachProvider'

const retired = [
  'clarify_mindmap_command_receipts',
  'clarify_mindmap_node_revisions',
  'clarify_mindmap_nodes',
  'clarify_mindmap_sessions',
  'clarify_mindmap_snapshots',
  'task_clarify_channels',
  'task_clarify_consumptions',
  'task_clarify_entries',
  'task_clarify_host_runs',
  'task_clarify_materials',
]

describeEachProvider('RFC-372 retained clarify backup sources', (h) => {
  test('both active providers export original round rows after companion retirement', async () => {
    await h.executeFixtureDdl(
      "INSERT INTO tasks (id,name,workflow_id,workflow_snapshot,repo_path,worktree_path,base_branch,branch,status,inputs,started_at) VALUES ('keep','keep','wf','{}','/r','','main','main','awaiting_human','{}',1)",
    )
    await h.executeFixtureDdl(
      "INSERT INTO node_runs (id,task_id,node_id,status,iteration) VALUES ('ask','keep','ask','done',0),('gate','keep','gate','awaiting_human',0)",
    )
    await h.executeFixtureDdl(
      "INSERT INTO clarify_rounds (id,task_id,kind,asking_node_id,asking_node_run_id,intermediary_node_id,intermediary_node_run_id,iteration,status,questions_json,created_at) VALUES ('round','keep','self','ask','ask','gate','gate',0,'awaiting_human','[{\"id\":\"original\"}]',1)",
    )
    const contract = buildLogicalSchemaContract()
    const binding = h.applicationBinding
    const root = mkdtempSync(join(tmpdir(), 'rfc372-source-parity-'))
    const { source, snapshot, assertUnchanged } = await (async () => {
      if (binding.provider === 'postgresql') {
        await binding.runtime
          .providerPool()
          .unsafe(
            'UPDATE "agent_workflow_meta"."database_generations" SET contract_digest = $1 WHERE generation_id = $2',
            [contract.digest, binding.runtime.generationId],
          )
        const source = await openPostgresqlLogicalSource({
          runtime: binding.runtime,
          generationId: binding.runtime.generationId,
          contract,
        })
        const snapshot = await source.preflight()
        return { source, snapshot, assertUnchanged: () => source.assertUnchanged(snapshot) }
      }
      const path = join(root, 'current.sqlite')
      writeFileSync(path, (Reflect.get(binding.db, '$client') as Database).serialize())
      const source = openSqliteLogicalSource({ path, contract })
      const snapshot = await source.preflight()
      return { source, snapshot, assertUnchanged: () => source.assertUnchanged(snapshot) }
    })()
    try {
      for (const id of retired) expect(snapshot.tableRows[id]).toBeUndefined()
      expect(snapshot.tableRows.clarify_rounds).toBe(1)
      const table = contract.tables.find((t) => t.id === 'clarify_rounds')!
      const rows = await source.readChunk(table, null, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.key).toEqual([{ type: 'text', value: 'round' }])
      const questions = table.columns.findIndex((column) => column.name === 'questions_json')
      expect(rows[0]!.values[questions]).toEqual({ type: 'text', value: '[{"id":"original"}]' })
      expect(await source.readChunk(table, rows[0]!.key, 10)).toEqual([])
      await assertUnchanged()
    } finally {
      await source.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RFC-372 companion retirement', () => {
  test('SQLite forward migration preserves original tasks, rounds and answer JSON', () => {
    const prefix = freezeAt(246)
    const db = createInMemoryDb(prefix)
    const native = Reflect.get(db, '$client') as Database
    try {
      native.exec(
        "INSERT INTO tasks (id,name,workflow_id,workflow_snapshot,repo_path,worktree_path,base_branch,branch,status,inputs,started_at) VALUES ('keep','keep','wf','{}','/r','','main','main','awaiting_human','{}',1)",
      )
      native.exec(
        "INSERT INTO node_runs (id,task_id,node_id,status,iteration) VALUES ('ask','keep','ask','done',0),('gate','keep','gate','awaiting_human',0)",
      )
      native.exec(
        "INSERT INTO clarify_rounds (id,task_id,kind,asking_node_id,asking_node_run_id,intermediary_node_id,intermediary_node_run_id,iteration,status,questions_json,created_at) VALUES ('round','keep','self','ask','ask','gate','gate',0,'awaiting_human','[{\"id\":\"original\"}]',1)",
      )
      const before = native.query('SELECT * FROM clarify_rounds').all()
      for (const id of retired)
        expect(
          native.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(id),
        ).not.toBeNull()
      native.exec(readFileSync(resolve(MIGRATIONS, '0248_rfc372_light_clarify.sql'), 'utf8'))
      expect(native.query('SELECT * FROM clarify_rounds').all()).toEqual(before)
      expect(native.query("SELECT id FROM tasks WHERE id='keep'").get()).toEqual({ id: 'keep' })
      for (const id of retired)
        expect(
          native.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(id),
        ).toBeNull()
    } finally {
      native.close()
      rmSync(prefix, { recursive: true, force: true })
    }
  })
  test('PostgreSQL V4 replays the exact removal and concurrent additions, admitting only the verified row bridge', async () => {
    const history = await loadPostgresqlMigrationHistory()
    const step = history.steps.find((x) => x.id === '0024_rfc372_light_clarify')!
    expect(step.version).toBe(4)
    expect([...step.retiredTables!].sort()).toEqual(retired)
    expect(step.logicalTables).toHaveLength(14)
    expect(step.executableStatements.filter((s) => s.sql.startsWith('DROP TABLE'))).toHaveLength(10)
    expect(step.executableStatements.every((s) => !/\bCASCADE\b/.test(s.sql))).toBe(true)
    expect(history.head.contract).toEqual(buildLogicalSchemaContract())
    const before = history.versions[history.steps.indexOf(step)]!
    const longForeignKey = step.executableStatements.find((statement) =>
      statement.logicalId.startsWith('retire:clarify_mindmap_command_receipts:'),
    )!
    const physicalSql = postgresqlUpgradeStatementSql(before, longForeignKey)
    expect(physicalSql).not.toBe(longForeignKey.sql)
    const constraint = /DROP CONSTRAINT "([^"]+)"$/.exec(physicalSql)![1]!
    expect(Buffer.byteLength(constraint)).toBeLessThanOrEqual(63)
    expect(
      before.plan.statements.some((statement) =>
        statement.sql.includes(`ADD CONSTRAINT "${constraint}" FOREIGN KEY`),
      ),
    ).toBe(true)
    expect(() =>
      postgresqlUpgradeStatementSql(before, {
        ...longForeignKey,
        logicalId: 'retire:clarify_rounds:missing_fk',
      }),
    ).toThrow('retired foreign key is absent')
    expect(
      resolvePostgresqlAdditiveRowBridge(history, {
        fromContractDigest: before.contract.digest,
        toContractDigest: history.head.contract.digest,
      }).target,
    ).toEqual(history.head.contract)
    expect(() =>
      resolvePostgresqlIndexOnlyRowBridge(history, {
        fromContractDigest: before.contract.digest,
        toContractDigest: history.head.contract.digest,
      }),
    ).toThrow()
    const { digest: _digest, ...bad } = {
      ...step,
      retiredTables: [...step.retiredTables!, 'clarify_rounds'],
    }
    expect(() =>
      replayPostgresqlMigrationHistory(history.root, [
        ...history.steps.slice(0, history.steps.indexOf(step)),
        { ...bad, digest: postgresqlMigrationDigest(bad) },
      ]),
    ).toThrow()
  })
  test('a historical backup restores retained rows, skips retired rows and preserves the original artifact', async () => {
    const history = await loadPostgresqlMigrationHistory()
    const previous =
      history.versions[history.steps.findIndex((step) => step.id === '0024_rfc372_light_clarify')]!
    const prefix = freezeAt(previous.sqliteMigration.last.index)
    const root = mkdtempSync(join(tmpdir(), 'rfc372-retired-backup-'))
    const db = createInMemoryDb(prefix)
    const native = Reflect.get(db, '$client') as Database
    try {
      native.exec(
        "INSERT INTO tasks (id,name,workflow_id,workflow_snapshot,repo_path,worktree_path,base_branch,branch,status,inputs,started_at) VALUES ('keep','keep','wf','{}','/r','','main','main','awaiting_human','{}',1)",
      )
      native.exec(
        "INSERT INTO node_runs (id,task_id,node_id,status,iteration) VALUES ('ask','keep','ask','done',0),('gate','keep','gate','awaiting_human',0)",
      )
      native.exec(
        "INSERT INTO clarify_rounds (id,task_id,kind,asking_node_id,asking_node_run_id,intermediary_node_id,intermediary_node_run_id,iteration,status,questions_json,created_at) VALUES ('round','keep','self','ask','ask','gate','gate',0,'awaiting_human','[]',1)",
      )
      native.exec(
        "INSERT INTO clarify_mindmap_sessions VALUES ('retire','keep','round','entry',1,'{}','{}',1,1)",
      )
      const sourcePath = join(root, 'old.sqlite')
      writeFileSync(sourcePath, native.serialize())
      const source = openSqliteLogicalSource({ path: sourcePath, contract: previous.contract })
      try {
        const snapshot = await source.preflight()
        const artifactRoot = join(root, 'artifact')
        const exported = await exportLogicalDatabaseArtifact({
          operationId: 'dbm_rfc372_old',
          sourceProvider: 'sqlite',
          sourceGenerationId: 'dbg_rfc372_old',
          source: {
            provider: 'sqlite',
            assertUnchanged: () => source.assertUnchanged(snapshot),
            readChunk: (table, key, limit) => source.readChunk(table, key, limit),
          },
          expectedTableRows: snapshot.tableRows,
          contract: previous.contract,
          artifactRoot,
        })
        const originalManifest = readFileSync(join(artifactRoot, 'logical-manifest.json'), 'utf8')
        const copied: string[] = []
        const progress: { chunksRestored: number; chunksTotal: number }[] = []
        const receipt = await restoreLogicalDatabaseBackup({
          artifactRoot,
          expectedEnvelopeFileDigest: exported.envelopeFileDigest,
          restoreOperationId: 'dbm_rfc372_restore',
          contract: previous.contract,
          targetContract: history.head.contract,
          target: {
            provider: 'sqlite',
            operationId: 'dbm_rfc372_restore',
            async prepare() {},
            async copyChunk(table) {
              copied.push(table.id)
            },
            async finalizeSchema(_now, tables) {
              expect(tables.some((table) => retired.includes(table.table))).toBe(false)
              expect(tables.find((table) => table.table === 'tasks')?.rowCount).toBe(1)
            },
          },
          onProgress: (value) => progress.push(value),
        })
        expect(copied).toContain('clarify_rounds')
        expect(copied).toContain('tasks')
        expect(copied.some((id) => retired.includes(id))).toBe(false)
        expect(receipt.rowsRestored).toBe(exported.envelope.payload.activeRows - 1)
        expect(progress.at(-1)?.chunksRestored).toBe(progress.at(-1)?.chunksTotal)
        expect(readFileSync(join(artifactRoot, 'logical-manifest.json'), 'utf8')).toBe(
          originalManifest,
        )
      } finally {
        await source.close()
      }
    } finally {
      native.close()
      rmSync(prefix, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
