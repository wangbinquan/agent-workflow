// RFC-626 §4.6 / §3.3 regression locks for the copy of a PostgreSQL source into its scratch
// database (the offline upgrade). No database is needed: the target runs over a scripted
// connection that records every statement.
//
// Why these tests exist:
//   - One chunk used to be one INSERT of all its rows and columns. `tasks` has 70 columns, so a
//     1000-row chunk carried 70 000 bind parameters, above the protocol's 65 535; an instance
//     with 937 or more tasks failed at "copy to scratch" (proposal R4①, M5). Every statement now
//     stays at or below 60 000 parameters, and the copy reads wide tables in smaller chunks.
//   - The automatic upgrade moves values only the strict value rule refuses (JSON text that is
//     not JSON, NaN / ±Infinity in a real column) through the copy and its read-back; the manual
//     upgrade still refuses them.
//   - The automatic upgrade does not hold its private scratch copy to the cross-table business
//     oracle (`committed-event-head` and the rest); the manual upgrade still does. Indexes and
//     constraints are installed either way.
import { describe, expect, test } from 'bun:test'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import {
  LogicalDatabaseCodecError,
  createLogicalTableChunk,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
  type LogicalValueRule,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import {
  POSTGRESQL_STATEMENT_PARAMETERS,
  openPostgresqlLogicalTarget,
  postgresqlCopyBatchRows,
} from '@/platform/persistence/migration/legacy/postgresqlLogicalTarget'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { copyTableToScratch } from '@/platform/persistence/migration/offlineSourceUpgrade'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import type {
  LogicalColumnContract,
  LogicalTableContract,
} from '@/platform/persistence/schema/contractTypes'
import type { VersionedSourceReader } from '@/platform/persistence/migration/sourceTypes'

const OPERATION = 'dbm_rfc626_scratch_copy'
const PROTOCOL_LIMIT = 65_535
const contract = frozenEpoch1Contract
const table = (id: string): LogicalTableContract =>
  contract.tables.find((entry) => entry.id === id)!
const physical = (entry: LogicalTableContract) =>
  `"agent_workflow"."${entry.providerTables.postgresql!}"`

function cell(column: LogicalColumnContract, index: number): CanonicalLogicalValue {
  switch (column.logicalCodec) {
    case 'boolean':
      return { type: 'boolean', value: index % 2 === 0 }
    case 'integer':
    case 'epoch-milliseconds':
      return { type: 'integer', value: String(1_700_000_000_000 + index) }
    case 'real':
      return { type: 'real', value: '1.5' }
    case 'json-text':
      return { type: 'text', value: `{"n":${index}}` }
    case 'opaque-bytes':
      return { type: 'bytes', value: 'AA==' }
    case 'text':
    case 'text-identity':
      return { type: 'text', value: `${column.name}-${String(index).padStart(6, '0')}` }
  }
}
/** Rows every rule accepts; `override` replaces named cells of each row. */
function rowsOf(
  entry: LogicalTableContract,
  count: number,
  override: (index: number) => Readonly<Record<string, CanonicalLogicalValue>> = () => ({}),
): CanonicalLogicalRow[] {
  return Array.from({ length: count }, (_, index) => {
    const replaced = override(index)
    const values = entry.columns.map((column) => replaced[column.name] ?? cell(column, index))
    const key = entry.migrationKey.map(
      (name) => values[entry.columns.findIndex((column) => column.name === name)]!,
    )
    return { key, values }
  })
}
const plan = (statements: PostgresqlSchemaPlan['statements'] = []): PostgresqlSchemaPlan =>
  ({
    version: 1,
    baselineId: '0000_rfc349_baseline_v1',
    contractDigest: contract.digest,
    activeTableCount: contract.activeTableCount,
    archiveOnlyTableCount: contract.archiveOnlyTableCount,
    statements,
    digest: `sha256:${'6'.repeat(64)}`,
  }) as PostgresqlSchemaPlan

interface Statement {
  readonly sql: string
  readonly parameters: readonly unknown[]
}
/**
 * A scripted target database: it keeps the rows the copy inserts and returns them to the
 * read-back, answers the coverage census for an empty copy, and reports one violated business
 * invariant when asked to.
 */
function scriptedTarget(
  options: {
    readonly violation?: string
    readonly finalizedBaseline?: boolean
  } = {},
) {
  const statements: Statement[] = []
  const stored = new Map<string, Map<string, Record<string, unknown>>>()
  const byPhysical = new Map(
    contract.tables
      .filter((entry) => entry.providerTables.postgresql !== undefined)
      .map((entry) => [physical(entry), entry] as const),
  )
  const keyOf = (values: readonly unknown[]) => JSON.stringify(values.map((value) => String(value)))
  const answer = (sql: string, parameters: readonly unknown[]): Record<string, unknown>[] => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('ANALYZE ')) return []
    if (sql.startsWith('SELECT set_config(')) return [{}]
    if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }]
    if (sql.includes('pg_advisory_unlock')) return []
    if (sql.startsWith('CREATE ')) return []
    if (sql.startsWith('SELECT stage FROM "agent_workflow_meta"."logical_copy_operations"'))
      return [{ stage: options.finalizedBaseline ? 'verified' : 'prepared' }]
    if (sql.startsWith('SELECT chunk_digest, row_count FROM')) return []
    if (sql.startsWith('SELECT table_id, chunk_index, row_count FROM')) return []
    if (sql.startsWith('INSERT INTO "agent_workflow_meta".')) return []
    if (sql.startsWith('UPDATE "agent_workflow_meta"."logical_copy_operations"'))
      return [{ operation_id: OPERATION }]
    if (sql.startsWith('SELECT contract_digest, plan_digest FROM'))
      return options.finalizedBaseline
        ? [{ contract_digest: contract.digest, plan_digest: plan().digest }]
        : []
    if (sql.startsWith('SELECT table_name FROM information_schema.tables'))
      return parameters[0] === 'agent_workflow'
        ? contract.tables
            .filter((entry) => entry.disposition !== 'ARCHIVE_THEN_OMIT')
            .map((entry) => ({ table_name: entry.providerTables.postgresql }))
        : []
    if (sql.startsWith('SELECT count(*) AS count FROM')) return [{ count: 0 }]
    if (sql.startsWith('SELECT setval(')) return []
    if (sql.startsWith('SELECT pg_get_serial_sequence('))
      return [{ sequence_name: 'agent_workflow.rfc626_probe_seq' }]
    if (sql.startsWith('SELECT last_value, is_called FROM'))
      return [{ last_value: '1', is_called: false }]
    if (sql.startsWith('SELECT MAX(')) return [{ max_value: null }]
    if (sql.startsWith('SELECT nextval(')) return [{ next_value: '1' }]
    if (sql.includes('/* rfc349-invariant:'))
      return options.violation && sql.includes(`/* rfc349-invariant:${options.violation} */`)
        ? [{ invariant_table: 'committed_event_aggregate_heads', invariant_key: 'rfc626-head' }]
        : []
    const insert = /^INSERT INTO ("agent_workflow"\."[^"]+") /.exec(sql)
    if (insert) {
      const entry = byPhysical.get(insert[1]!)!
      const rows = stored.get(entry.id) ?? new Map<string, Record<string, unknown>>()
      stored.set(entry.id, rows)
      const width = entry.columns.length
      expect(parameters.length % width).toBe(0)
      for (let offset = 0; offset < parameters.length; offset += width) {
        const row = Object.fromEntries(
          entry.columns.map((column, index) => [column.name, parameters[offset + index]]),
        )
        const key = keyOf(entry.migrationKey.map((name) => row[name]))
        if (!rows.has(key)) rows.set(key, row)
      }
      return []
    }
    const select = /^SELECT .+ FROM ("agent_workflow"\."[^"]+") WHERE /.exec(sql)
    if (select) {
      const entry = byPhysical.get(select[1]!)!
      const rows = stored.get(entry.id) ?? new Map()
      const width = entry.migrationKey.length
      const found: Record<string, unknown>[] = []
      for (let offset = 0; offset < parameters.length; offset += width) {
        const row = rows.get(keyOf(parameters.slice(offset, offset + width)))
        if (row) found.push({ ...row })
      }
      return found
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 160)}`)
  }
  const connection = {
    unsafe(sql: string, parameters: readonly unknown[] = []): SqlRows {
      statements.push({ sql, parameters })
      const promise = Promise.resolve().then(() => answer(sql, parameters))
      return Object.assign(promise, {
        values: async () => (await promise).map((row) => Object.values(row)),
      })
    },
    release() {},
    async begin() {
      throw new Error('the logical target drives its own transactions')
    },
  } as unknown as PostgresqlReservedConnection
  const runtime = {
    provider: 'postgresql',
    providerPool: () => ({ reserve: async () => connection }),
  } as unknown as PostgresqlDatabaseRuntime
  return {
    runtime,
    statements,
    stored: (id: string) => stored.get(id)?.size ?? 0,
    storedRows: (id: string) => [...(stored.get(id)?.values() ?? [])],
  }
}
async function openTarget(
  fake: ReturnType<typeof scriptedTarget>,
  options: {
    readonly valueRule?: LogicalValueRule
    readonly businessInvariants?: boolean
    readonly statements?: PostgresqlSchemaPlan['statements']
  } = {},
) {
  return openPostgresqlLogicalTarget({
    runtime: fake.runtime,
    operationId: OPERATION,
    sourceGenerationId: 'dbg_rfc626_scratch_source',
    headContract: contract,
    contract,
    plan: plan(options.statements),
    verifyMigrationHistory: async () => {},
    ...(options.valueRule ? { valueRule: options.valueRule } : {}),
    ...(options.businessInvariants === undefined
      ? {}
      : { businessInvariants: options.businessInvariants }),
  })
}
const chunkOf = (
  entry: LogicalTableContract,
  rows: readonly CanonicalLogicalRow[],
  valueRule?: LogicalValueRule,
) =>
  createLogicalTableChunk({
    operationId: OPERATION,
    contract,
    table: entry,
    chunkIndex: 0,
    rows,
    ...(valueRule ? { valueRule } : {}),
  })

describe('RFC-626 §4.6 statement size of the scratch copy', () => {
  test('rows per statement follow the parameter ceiling and never exceed 1000', () => {
    expect(POSTGRESQL_STATEMENT_PARAMETERS).toBe(60_000)
    expect(postgresqlCopyBatchRows(70)).toBe(857)
    expect(postgresqlCopyBatchRows(60)).toBe(1000)
    expect(postgresqlCopyBatchRows(61)).toBe(983)
    expect(postgresqlCopyBatchRows(1)).toBe(1000)
    expect(postgresqlCopyBatchRows(0)).toBe(1000)
    expect(postgresqlCopyBatchRows(70_000)).toBe(1)
    for (const width of [1, 3, 7, 59, 60, 61, 70, 120, 999])
      expect(postgresqlCopyBatchRows(width) * width).toBeLessThanOrEqual(
        POSTGRESQL_STATEMENT_PARAMETERS,
      )
  })

  for (const count of [1000, 2000])
    test(`a ${count}-row tasks chunk is written in statements under the protocol limit`, async () => {
      const tasks = table('tasks')
      // The regression is about exactly this: one statement for the chunk would not fit.
      expect(tasks.columns.length * 1000).toBeGreaterThan(PROTOCOL_LIMIT)
      const fake = scriptedTarget()
      const target = await openTarget(fake)
      try {
        await target.copyChunk(tasks, chunkOf(tasks, rowsOf(tasks, count)), 1)
      } finally {
        await target.close()
      }
      for (const statement of fake.statements) {
        expect(statement.parameters.length).toBeLessThanOrEqual(POSTGRESQL_STATEMENT_PARAMETERS)
        expect(statement.parameters.length).toBeLessThan(PROTOCOL_LIMIT)
      }
      const inserts = fake.statements.filter((statement) =>
        statement.sql.startsWith(`INSERT INTO ${physical(tasks)} `),
      )
      expect(inserts).toHaveLength(Math.ceil(count / postgresqlCopyBatchRows(tasks.columns.length)))
      expect(fake.stored('tasks')).toBe(count)
      // The chunk is still one unit: one transaction, one receipt for all of its rows.
      expect(fake.statements.filter((statement) => statement.sql === 'BEGIN')).toHaveLength(1)
      expect(fake.statements.filter((statement) => statement.sql === 'COMMIT')).toHaveLength(1)
      const receipt = fake.statements.find((statement) =>
        statement.sql.startsWith('INSERT INTO "agent_workflow_meta"."logical_copy_chunks"'),
      )!
      expect(receipt.parameters[4]).toBe(count)
    })

  test('a narrow table keeps its single INSERT and single read-back per chunk', async () => {
    const narrow = table('maintenance_state')
    const fake = scriptedTarget()
    const target = await openTarget(fake)
    try {
      await target.copyChunk(narrow, chunkOf(narrow, rowsOf(narrow, 1000)), 1)
    } finally {
      await target.close()
    }
    expect(
      fake.statements.filter((statement) =>
        statement.sql.startsWith(`INSERT INTO ${physical(narrow)} `),
      ),
    ).toHaveLength(1)
    const columns = narrow.columns.map((column) => `"${column.name}"`).join(', ')
    expect(
      fake.statements.filter((statement) =>
        statement.sql.startsWith(`SELECT ${columns} FROM ${physical(narrow)} WHERE `),
      ),
    ).toHaveLength(1)
    expect(fake.stored('maintenance_state')).toBe(1000)
  })

  for (const count of [1000, 2000])
    test(`the copy reads a ${count}-row tasks table in chunks that fit one statement`, async () => {
      const tasks = table('tasks')
      const all = rowsOf(tasks, count)
      const limits: number[] = []
      const source = {
        async readChunk(
          id: string,
          afterKey: readonly CanonicalLogicalValue[] | null,
          limit: number,
        ) {
          expect(id).toBe('tasks')
          limits.push(limit)
          const start =
            afterKey === null
              ? 0
              : all.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(afterKey)) + 1
          const rows = all.slice(start, start + limit)
          return { rows, lastKey: rows.at(-1)?.key ?? null }
        },
      } as unknown as VersionedSourceReader
      const fake = scriptedTarget()
      const target = await openTarget(fake)
      const copied = await copyTableToScratch({
        source,
        target,
        operationId: OPERATION,
        contract,
        table: tasks,
        valueRule: 'strict',
      }).finally(() => target.close())
      const batch = postgresqlCopyBatchRows(tasks.columns.length)
      expect(batch).toBe(857)
      expect(new Set(limits)).toEqual(new Set([batch]))
      expect(copied).toEqual({
        table: 'tasks',
        disposition: tasks.disposition,
        rowCount: count,
        chunkCount: Math.ceil(count / batch),
      })
      expect(fake.stored('tasks')).toBe(count)
      for (const statement of fake.statements)
        expect(statement.parameters.length).toBeLessThanOrEqual(POSTGRESQL_STATEMENT_PARAMETERS)
      const receipts = fake.statements
        .filter((statement) =>
          statement.sql.startsWith('INSERT INTO "agent_workflow_meta"."logical_copy_chunks"'),
        )
        .map((statement) => statement.parameters[4])
      expect(receipts).toEqual(
        Array.from({ length: Math.ceil(count / batch) }, (_, index) =>
          Math.min(batch, count - index * batch),
        ),
      )
    })

  test('a narrow table is still read 1000 rows at a time', async () => {
    const narrow = table('maintenance_state')
    const all = rowsOf(narrow, 2000)
    const limits: number[] = []
    const source = {
      async readChunk(
        _id: string,
        afterKey: readonly CanonicalLogicalValue[] | null,
        limit: number,
      ) {
        limits.push(limit)
        const start =
          afterKey === null
            ? 0
            : all.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(afterKey)) + 1
        const rows = all.slice(start, start + limit)
        return { rows, lastKey: rows.at(-1)?.key ?? null }
      },
    } as unknown as VersionedSourceReader
    const fake = scriptedTarget()
    const target = await openTarget(fake)
    try {
      const copied = await copyTableToScratch({
        source,
        target,
        operationId: OPERATION,
        contract,
        table: narrow,
        valueRule: 'strict',
      })
      expect(copied.chunkCount).toBe(2)
    } finally {
      await target.close()
    }
    expect(new Set(limits)).toEqual(new Set([1000]))
  })
})

describe('RFC-626 §3.3 transport value rule in the scratch copy', () => {
  const runtimes = table('runtimes')
  const nonFinite = ['NaN', 'Infinity', '-Infinity']
  const refused = rowsOf(runtimes, 3, (index) => ({
    temperature: { type: 'real', value: nonFinite[index]! },
    extra_args_json: { type: 'text', value: index === 0 ? 'not json' : '[' },
  }))

  test('the strict rule refuses to build such a chunk at all', () => {
    expect(() => chunkOf(runtimes, refused)).toThrow()
    expect(() => chunkOf(runtimes, refused, 'transport')).not.toThrow()
  })

  test('automatic: the copy writes and reads back NaN, ±Infinity and invalid JSON text', async () => {
    const fake = scriptedTarget()
    const target = await openTarget(fake, { valueRule: 'transport' })
    try {
      await target.copyChunk(runtimes, chunkOf(runtimes, refused, 'transport'), 1)
    } finally {
      await target.close()
    }
    const temperatures = fake.storedRows('runtimes').map((row) => row.temperature)
    expect(temperatures.some((value) => Number.isNaN(value))).toBe(true)
    expect(temperatures).toContain(Infinity)
    expect(temperatures).toContain(-Infinity)
    expect(fake.storedRows('runtimes').map((row) => row.extra_args_json)).toContain('not json')
    expect(
      fake.statements.some((statement) =>
        statement.sql.startsWith('INSERT INTO "agent_workflow_meta"."logical_copy_chunks"'),
      ),
    ).toBe(true)
  })

  test('manual: the read-back of the same rows still fails under the strict rule', async () => {
    const fake = scriptedTarget()
    const target = await openTarget(fake)
    try {
      await expect(
        target.copyChunk(runtimes, chunkOf(runtimes, refused, 'transport'), 1),
      ).rejects.toBeInstanceOf(LogicalDatabaseCodecError)
    } finally {
      await target.close()
    }
    expect(fake.statements.some((statement) => statement.sql === 'ROLLBACK')).toBe(true)
    expect(fake.statements.some((statement) => statement.sql === 'COMMIT')).toBe(false)
  })

  test('rows both rules accept produce the same chunk and the same statements', async () => {
    const accepted = rowsOf(runtimes, 25)
    expect(chunkOf(runtimes, accepted, 'transport')).toEqual(chunkOf(runtimes, accepted))
    const strict = scriptedTarget()
    const transport = scriptedTarget()
    for (const [fake, valueRule] of [
      [strict, undefined],
      [transport, 'transport'],
    ] as const) {
      const target = await openTarget(fake, valueRule ? { valueRule } : {})
      try {
        await target.copyChunk(runtimes, chunkOf(runtimes, accepted, valueRule), 1)
      } finally {
        await target.close()
      }
    }
    expect(transport.statements).toEqual(strict.statements)
  })

  test('the copy loop reads through the transport channel only under the transport rule', async () => {
    const reads: string[] = []
    const source = {
      async readChunk() {
        reads.push('strict')
        throw new Error(
          'logical database codec rejected runtimes.temperature: expected a finite real',
        )
      },
      async readTransportChunk(_id: string, afterKey: readonly CanonicalLogicalValue[] | null) {
        reads.push('transport')
        return afterKey === null
          ? { rows: refused, lastKey: refused.at(-1)!.key }
          : { rows: [], lastKey: null }
      },
    } as unknown as VersionedSourceReader
    const fake = scriptedTarget()
    const target = await openTarget(fake, { valueRule: 'transport' })
    try {
      const copied = await copyTableToScratch({
        source,
        target,
        operationId: OPERATION,
        contract,
        table: runtimes,
        valueRule: 'transport',
      })
      expect(copied.rowCount).toBe(3)
      await expect(
        copyTableToScratch({
          source,
          target,
          operationId: OPERATION,
          contract,
          table: runtimes,
          valueRule: 'strict',
        }),
      ).rejects.toThrow('expected a finite real')
    } finally {
      await target.close()
    }
    expect(reads).toEqual(['transport', 'transport', 'strict'])
  })
})

describe('RFC-626 §3.3 business invariants of the scratch copy', () => {
  const expected = contract.tables.map((entry) => ({
    table: entry.id,
    disposition: entry.disposition,
    rowCount: 0,
    chunkCount: 0,
  }))
  const ddl: PostgresqlSchemaPlan['statements'] = [
    { kind: 'index', logicalId: 'rfc626:index', sql: 'CREATE INDEX rfc626_probe_index ON t (c)' },
    {
      kind: 'constraint',
      logicalId: 'rfc626:constraint',
      sql: 'CREATE UNIQUE INDEX rfc626_probe_unique ON t (c)',
    },
  ]
  const invariantQueries = (fake: ReturnType<typeof scriptedTarget>) =>
    fake.statements.filter((statement) => statement.sql.includes('/* rfc349-invariant:'))

  test('manual: a head without events still fails the copy with its invariant', async () => {
    const fake = scriptedTarget({ violation: 'committed-event-head' })
    const target = await openTarget(fake, { statements: ddl })
    try {
      await expect(target.finalizeSchema(1, expected)).rejects.toMatchObject({
        code: 'postgresql-target-verification.committed-event-head',
      })
    } finally {
      await target.close()
    }
    expect(invariantQueries(fake).length).toBeGreaterThan(0)
  })

  test('automatic: the oracle is not consulted, indexes and constraints are still installed', async () => {
    const fake = scriptedTarget({ violation: 'committed-event-head' })
    const target = await openTarget(fake, { statements: ddl, businessInvariants: false })
    try {
      await target.finalizeSchema(1, expected)
    } finally {
      await target.close()
    }
    expect(invariantQueries(fake)).toEqual([])
    for (const statement of ddl)
      expect(fake.statements.some((recorded) => recorded.sql === statement.sql)).toBe(true)
    expect(
      fake.statements.some((recorded) =>
        recorded.sql.startsWith('INSERT INTO "agent_workflow_meta"."schema_migrations"'),
      ),
    ).toBe(true)
    // Identity sequences are verified either way.
    expect(fake.statements.some((recorded) => recorded.sql.startsWith('SELECT nextval('))).toBe(
      contract.tables.some((entry) => entry.columns.some((column) => column.identity)),
    )
  })

  test('the resumed finalization follows the same rule in both modes', async () => {
    const manual = scriptedTarget({ violation: 'committed-event-head', finalizedBaseline: true })
    const manualTarget = await openTarget(manual)
    try {
      await expect(manualTarget.finalizeSchema(1, expected)).rejects.toMatchObject({
        code: 'postgresql-target-verification.committed-event-head',
      })
    } finally {
      await manualTarget.close()
    }
    const automatic = scriptedTarget({ violation: 'committed-event-head', finalizedBaseline: true })
    const automaticTarget = await openTarget(automatic, { businessInvariants: false })
    try {
      await automaticTarget.finalizeSchema(1, expected)
    } finally {
      await automaticTarget.close()
    }
    expect(invariantQueries(automatic)).toEqual([])
  })
})
