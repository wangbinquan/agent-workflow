// RFC-395 postgresql-evidence (runs 40893688180, 40909853901): the epoch-2 PostgreSQL logical
// target wrote and read back every copied row with its own statement. Each statement is a network
// round trip, so the weekly provider move took 708 s instead of 255-359 s in epoch 1 and then ran
// past its 30 min deadline in `copying`. A chunk is now written with one multi-row INSERT per
// batch and read back with one keyed SELECT per batch, and the read-back still proves that every
// source row arrived exactly once and unchanged.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createPostgresqlCapabilities } from '@/platform/persistence/capabilities'
import {
  createLogicalTableChunk,
  encodeLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import type { LogicalTableContract } from '@/platform/persistence/schemaContract'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'

// Native target installation takes a few seconds per case on CI.
setDefaultTimeout(20_000)

const OPERATION_ID = 'dbm_batched_copy_0001'
const PLAN = buildPostgresqlSchemaPlan(logicalSchemaContract)
const SINGLE_KEY = logicalSchemaContract.tables.find((table) => table.id === 'maintenance_state')!
const COMPOSITE_KEY = logicalSchemaContract.tables.find(
  (table) => table.id === 'committed_event_aggregate_heads',
)!
const capabilities = createPostgresqlCapabilities()

function physical(table: LogicalTableContract): string {
  return `"agent_workflow"."${table.providerTables.postgresql}"`
}

function chunkOf(table: LogicalTableContract, rows: readonly Record<string, unknown>[]) {
  return createLogicalTableChunk({
    operationId: OPERATION_ID,
    contract: logicalSchemaContract,
    table,
    chunkIndex: 0,
    rows: rows.map((row) => encodeLogicalRow(table, row)),
  })
}

function settingRows(count: number) {
  return Array.from({ length: count }, (_, n) => ({
    key: `setting-${String(n).padStart(5, '0')}`,
    value: `value-${n}`,
    updated_at: n + 1,
  }))
}

async function recordingTarget(h: V3Harness) {
  await h.target.execute('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
  await h.target.execute('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
  const statements: string[] = []
  const pool = h.runtime.providerPool()
  // Every SQL call still reaches the real harness database; the recorder only lists the text.
  const recordedPool: PostgresqlPool = {
    async reserve(options) {
      const connection = await pool.reserve(options)
      return {
        begin: (body) => connection.begin(body),
        unsafe(sql, values) {
          statements.push(sql)
          return connection.unsafe(sql, values)
        },
        release: () => connection.release(),
      }
    },
    unsafe: (sql, values) => pool.unsafe(sql, values),
    close: (options) => pool.close(options),
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: PostgresqlDatabaseConfigSchema.parse({
      provider: 'postgresql',
      urlEnv: 'LIVE_TARGET_URL',
    }),
    generationId: h.generationId,
    env: { LIVE_TARGET_URL: 'postgresql://localhost/recorded_target' },
    poolFactory: () => recordedPool,
  })
  const target = await openPostgresqlLogicalTarget({
    runtime,
    operationId: OPERATION_ID,
    sourceGenerationId: 'dbg_batched_copy_source',
    headContract: logicalSchemaContract,
    contract: logicalSchemaContract,
    plan: PLAN,
  })
  await target.prepare(1)
  statements.length = 0
  return { target, statements }
}

describeV3Providers('RFC-395 epoch-2 logical copy writes and verifies a chunk in batches', (h) => {
  if (h.targetProvider !== 'postgresql') return

  test('a chunk takes one multi-row INSERT and one keyed read-back per batch', async () => {
    const { target, statements } = await recordingTarget(h)
    try {
      // 1,201 rows cross two batch boundaries on both the write and the read-back.
      const rows = settingRows(1_201)
      await target.copyChunk(SINGLE_KEY, chunkOf(SINGLE_KEY, rows), 2)
      const writes = statements.filter((sql) =>
        sql.startsWith(`INSERT INTO ${physical(SINGLE_KEY)}`),
      )
      const reads = statements.filter(
        (sql) => sql.startsWith('SELECT ') && sql.includes(`FROM ${physical(SINGLE_KEY)} WHERE`),
      )
      expect(writes).toHaveLength(
        Math.ceil(rows.length / capabilities.batchInsertMax(SINGLE_KEY.columns.length)),
      )
      expect(reads).toHaveLength(
        Math.ceil(rows.length / capabilities.batchInsertMax(SINGLE_KEY.migrationKey.length)),
      )
      expect(writes.length + reads.length).toBe(6)
      const copied = await h.target.execute(
        `SELECT key, value, updated_at FROM ${physical(SINGLE_KEY)} ORDER BY key`,
      )
      expect(copied.map((row) => [row.key, row.value, Number(row.updated_at)])).toEqual(
        rows.map((row) => [row.key, row.value, row.updated_at]),
      )
    } finally {
      await target.close()
    }
  })

  test('a composite migration key is read back in batches too', async () => {
    const { target, statements } = await recordingTarget(h)
    try {
      const rows = Array.from({ length: 501 }, (_, n) => ({
        producer: 'task-execution',
        family: 'task-lifecycle',
        aggregate_kind: 'task',
        aggregate_id: `task-${String(n).padStart(5, '0')}`,
        last_seq: n + 1,
        updated_at: 7,
      }))
      const chunk = chunkOf(COMPOSITE_KEY, rows)
      await target.copyChunk(COMPOSITE_KEY, chunk, 2)
      expect(
        statements.filter(
          (sql) =>
            sql.startsWith('SELECT ') && sql.includes(`FROM ${physical(COMPOSITE_KEY)} WHERE`),
        ),
      ).toHaveLength(2)
      expect(
        await h.target.execute(`SELECT count(*)::int AS count FROM ${physical(COMPOSITE_KEY)}`),
      ).toEqual([{ count: 501 }])
      // The resumed chunk is verified again; one changed column fails it.
      await target.copyChunk(COMPOSITE_KEY, chunk, 3)
      await h.target.execute(
        `UPDATE ${physical(COMPOSITE_KEY)} SET last_seq = 9999 WHERE aggregate_id = 'task-00500'`,
      )
      await expect(target.copyChunk(COMPOSITE_KEY, chunk, 4)).rejects.toMatchObject({
        code: 'postgresql-target-chunk-mismatch',
      })
    } finally {
      await target.close()
    }
  })

  test('the batched read-back still rejects a changed or missing row', async () => {
    const { target } = await recordingTarget(h)
    try {
      const chunk = chunkOf(SINGLE_KEY, settingRows(3))
      await target.copyChunk(SINGLE_KEY, chunk, 2)
      await h.target.execute(
        `UPDATE ${physical(SINGLE_KEY)} SET value = 'drifted' WHERE key = 'setting-00001'`,
      )
      await expect(target.copyChunk(SINGLE_KEY, chunk, 3)).rejects.toMatchObject({
        code: 'postgresql-target-chunk-mismatch',
      })
      await h.target.execute(
        `UPDATE ${physical(SINGLE_KEY)} SET value = 'value-1' WHERE key = 'setting-00001'`,
      )
      await target.copyChunk(SINGLE_KEY, chunk, 4)
      await h.target.execute(`DELETE FROM ${physical(SINGLE_KEY)} WHERE key = 'setting-00002'`)
      await expect(target.copyChunk(SINGLE_KEY, chunk, 5)).rejects.toMatchObject({
        code: 'postgresql-target-chunk-mismatch',
      })
    } finally {
      await target.close()
    }
  })

  test('a row changed on the way in fails the chunk and commits nothing', async () => {
    const { target } = await recordingTarget(h)
    try {
      await h.target.execute(
        `CREATE FUNCTION agent_workflow.rfc395_batched_copy_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'setting-00001' THEN NEW.value := 'drifted'; END IF; RETURN NEW; END $$`,
      )
      await h.target.execute(
        `CREATE TRIGGER rfc395_batched_copy_drift BEFORE INSERT ON ${physical(SINGLE_KEY)} FOR EACH ROW EXECUTE FUNCTION agent_workflow.rfc395_batched_copy_drift()`,
      )
      await expect(
        target.copyChunk(SINGLE_KEY, chunkOf(SINGLE_KEY, settingRows(3)), 2),
      ).rejects.toMatchObject({ code: 'postgresql-target-chunk-mismatch' })
      expect(
        await h.target.execute(`SELECT count(*)::int AS count FROM ${physical(SINGLE_KEY)}`),
      ).toEqual([{ count: 0 }])
      expect(
        await h.target.execute(
          `SELECT count(*)::int AS count FROM "agent_workflow_meta"."migration_units" WHERE run_id = $1`,
          [OPERATION_ID],
        ),
      ).toEqual([{ count: 0 }])
    } finally {
      await target.close()
    }
  })
})
