import { expect, test } from 'bun:test'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import {
  captureEpochMetadata,
  restoreEpochMetadata,
  verifyEpochMetadataSnapshot,
} from '@/platform/persistence/schema/history/metadataSnapshot'
import {
  sqliteHistoryConnection,
  postgresqlHistoryConnection,
  parameters,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'
import { column } from '@/platform/persistence/schema/dsl'
import { defineMetaTable } from '@/platform/persistence/schema/history/meta'
import {
  schemaHistoryRuntime,
  registerSchemaHistoryRuntime,
} from '@/platform/persistence/schema/history/runtime'

const bytes = Buffer.from([0, 255, 10, 34, 128, 1])
const epochMs = 1_798_000_000_123

test('BF-D5 every numeric codec has provider-independent bytes, including int8 values beyond i32', async () => {
  const original = schemaHistoryRuntime()
  const table = defineMetaTable({
    name: 'numeric_fixture',
    columns: {
      id: column.id('id'),
      int: column.int('int'),
      bigint: column.bigint('bigint'),
      epochMs: column.epochMs('epoch_ms'),
      durationMs: column.durationMs('duration_ms'),
      seq: column.seq('seq'),
      identity: column.identity('identity'),
      real: column.real('real'),
      text: column.text('text'),
      nullable: column.int('nullable', { nullable: true }),
    },
    primaryKey: ['id'],
  })
  const shared = { id: 'row', text: String(epochMs), nullable: null }
  const sqliteRow = {
    ...shared,
    int: epochMs,
    bigint: 9007199254740993n,
    epoch_ms: epochMs,
    duration_ms: epochMs,
    seq: epochMs,
    identity: epochMs,
    real: 1.25,
  }
  const postgresqlRow = {
    ...shared,
    int: String(epochMs),
    bigint: '9007199254740993',
    epoch_ms: String(epochMs),
    duration_ms: String(epochMs),
    seq: String(epochMs),
    identity: String(epochMs),
    real: '1.25',
  }
  registerSchemaHistoryRuntime({ ...original, metaTables: [table] })
  try {
    const source: HistoryConnection = {
      provider: 'sqlite',
      async execute() {
        return [sqliteRow]
      },
    }
    const target: HistoryConnection = {
      provider: 'postgresql',
      async execute() {
        return [postgresqlRow]
      },
    }
    const fromSqlite = await captureEpochMetadata(source)
    const fromPostgresql = await captureEpochMetadata(target)
    expect(fromSqlite).toEqual(fromPostgresql)
    expect(fromSqlite.payload.tables[0]!.rows[0]).toEqual({
      ...sqliteRow,
      bigint: '9007199254740993',
    })
    await restoreEpochMetadata(target, fromSqlite)
    await restoreEpochMetadata(source, fromPostgresql)
  } finally {
    registerSchemaHistoryRuntime(original)
  }
})
function connection(h: ProviderDatabaseHarness): HistoryConnection {
  const binding = h.applicationBinding
  return binding.provider === 'sqlite'
    ? sqliteHistoryConnection(binding.db.$client)
    : postgresqlHistoryConnection(binding.runtime.providerPool())
}
async function seed(c: HistoryConnection) {
  const table = (name: string) => metaTableName(c.provider, name)
  await c.execute(
    `INSERT INTO ${table('migration_archives')} (run_id,archive_ref,unit_id,kind,source_table,format,rows,byte_size,bytes) VALUES ('frozen-run','archive-1','unit-1','retired-table','code_artifacts','raw-chunk@1',1,${parameters(c, 2)})`,
    [bytes.length, bytes],
  )
  await c.execute(
    `INSERT INTO ${table('migration_history_restrictions')} (task_id,source_table,source_phase,source_key,run_id,ordinal,node_run_id,execution,execution_use,reason,missing_fields_json,decision_code,unit_id) VALUES ('old-task','tasks','current','old-task','frozen-run',0,NULL,'terminal-history','none','required evidence unavailable','["content"]','retain-history','unit-1')`,
  )
  await c.execute(
    `INSERT INTO ${table('activation_receipts')} (generation_id,operation_id,run_id,receipt_json,receipt_digest,previous_pointer_bytes,previous_pointer_digest,prepared_at) VALUES ('dbg_prior_receipt','dbm_prior_receipt','run-1','{}','receipt',${parameters(c, 2).split(', ')[0]},'previous',${parameters(c, 2).split(', ')[1]})`,
    [bytes, epochMs],
  )
  await c.execute(
    `INSERT INTO ${table('migration_receipt_exports')} (run_id,digest,path,bytes) VALUES ('run-1','receipt',NULL,${parameters(c, 1)})`,
    [bytes],
  )
  await c.execute(
    `INSERT INTO ${table('migration_blocks')} (run_id,origin,unit_id,ordinal,code,scope,missing_fields_json,detail_json,acknowledgeable) VALUES ('run-1','plan','unit-1',0,'retained','global','[]','{}',${parameters(c, 1)})`,
    [c.provider === 'sqlite' ? 1 : true],
  )
}
async function roundtrip(source: HistoryConnection, target: HistoryConnection) {
  const sourceGeneration = await source.execute(
    `SELECT generation_id FROM ${metaTableName(source.provider, 'generations')} WHERE state='active'`,
  )
  const targetGeneration = await target.execute(
    `SELECT generation_id FROM ${metaTableName(target.provider, 'generations')} WHERE state='active'`,
  )
  await seed(source)
  const captured = await captureEpochMetadata(source)
  const snapshot = verifyEpochMetadataSnapshot(JSON.parse(JSON.stringify(captured)))
  expect(
    snapshot.payload.tables.find((t) => t.name === 'migration_archives')!.rows[0]!.bytes,
  ).toEqual({ type: 'bytes', base64: bytes.toString('base64') })
  expect(
    snapshot.payload.tables.find((t) => t.name === 'migration_blocks')!.rows[0]!.acknowledgeable,
  ).toBe(true)
  expect(snapshot.payload.tables.map((t) => t.name)).not.toContain('first_write')
  expect(snapshot.payload.tables.map((t) => t.name)).not.toContain('schema_history')
  expect(
    snapshot.payload.tables.find((t) => t.name === 'activation_receipts')!.rows[0]!.prepared_at,
  ).toBe(epochMs)
  await restoreEpochMetadata(target, snapshot)
  await restoreEpochMetadata(target, snapshot)
  for (const [table, column] of [
    ['migration_archives', 'bytes'],
    ['activation_receipts', 'previous_pointer_bytes'],
    ['migration_receipt_exports', 'bytes'],
  ] as const) {
    const rows = await target.execute(
      `SELECT ${column} AS bytes FROM ${metaTableName(target.provider, table)}`,
    )
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0]!.bytes as Uint8Array)).toEqual(bytes)
  }
  const generations = await target.execute(
    `SELECT generation_id FROM ${metaTableName(target.provider, 'generations')} WHERE state='active'`,
  )
  expect(generations).toEqual(targetGeneration)
  expect(
    await target.execute(
      `SELECT state FROM ${metaTableName(target.provider, 'generations')} WHERE generation_id=${parameters(target, 1)}`,
      [sourceGeneration[0]!.generation_id],
    ),
  ).toEqual([{ state: 'retired' }])
  const normalized = await captureEpochMetadata(target)
  expect(normalized.payload.tables.find((t) => t.name === 'migration_blocks')!.rows).toEqual(
    snapshot.payload.tables.find((t) => t.name === 'migration_blocks')!.rows,
  )
  for (const name of [
    'migration_archives',
    'migration_history_restrictions',
    'activation_receipts',
    'migration_receipt_exports',
  ]) {
    const original = snapshot.payload.tables.find((table) => table.name === name)!.rows
    expect(original).toHaveLength(1)
    expect(normalized.payload.tables.find((table) => table.name === name)!.rows).toEqual(original)
  }
  expect(
    normalized.payload.tables.find((table) => table.name === 'migration_archives')!.rows[0],
  ).toMatchObject({
    byte_size: bytes.byteLength,
    rows: 1,
    run_id: 'frozen-run',
  })
  expect(() => verifyEpochMetadataSnapshot({ ...snapshot, digest: 'tampered' })).toThrow(
    'epoch2-metadata-digest-mismatch',
  )
}
describeEachProvider('AF-D2 metadata bytes and boolean normalization', (h) => {
  test('captures the provider and restores SQLite, including nonempty activation receipt bytes', async () => {
    const target = createSqliteBaseline()
    try {
      await roundtrip(connection(h), sqliteHistoryConnection(target))
    } finally {
      target.close()
    }
  })
  test('restores SQLite metadata into the provider and compares normalized cells on replay', async () => {
    const source = createSqliteBaseline()
    try {
      await roundtrip(sqliteHistoryConnection(source), connection(h))
    } finally {
      source.close()
    }
  })
})
