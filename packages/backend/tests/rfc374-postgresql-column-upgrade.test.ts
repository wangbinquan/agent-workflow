// RFC-374 T1: V8 appends compatible columns, replays exact SQL and bridges old rows without widening the index-only API.
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { beforeAll, describe, expect, test } from 'bun:test'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import {
  digestSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import {
  createPostgresqlColumnUpgrade,
  postgresqlMigrationDigest,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlAdditiveRowBridge,
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlMigrationHistory,
  type PostgresqlIndexUpgrade,
} from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'

let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract: buildLogicalSchemaContract() })
})
function edge() {
  const index = history.steps.findIndex((step) => step.id === '0036_rfc374_node_run_seq')
  if (index < 0) throw new Error('missing RFC-374 migration')
  return {
    index,
    step: history.steps[index]!,
    from: history.versions[index]!,
    to: history.versions[index + 1]!,
  }
}
function create(
  transform: (table: LogicalTableContract) => LogicalTableContract = (table) => table,
) {
  const { step, from, to } = edge()
  const { digest: _digest, ...payload } = to.contract
  const body = {
    ...payload,
    tables: payload.tables.map((table) => (table.id === 'node_runs' ? transform(table) : table)),
  }
  const contract = { ...body, digest: digestSchemaContract(body) }
  return createPostgresqlColumnUpgrade({
    from,
    to: { ...to, contract, plan: buildPostgresqlSchemaPlan(contract) },
    id: step.id,
    sequence: step.sequence,
    previousEntryDigest: step.previousEntryDigest,
  })
}
function rehash(step: PostgresqlIndexUpgrade) {
  const { digest: _digest, ...body } = step
  return { ...body, digest: postgresqlMigrationDigest(body) }
}
describe('RFC-374 PostgreSQL V8', () => {
  test('generated append recreates the committed edge and replay reaches the whole head', () => {
    const { step } = edge()
    expect(step.version).toBe(8)
    expect(create()).toEqual(step)
    expect(
      step.logicalColumns?.map((addition) => [addition.tableId, addition.column.name]),
    ).toEqual([['node_runs', 'seq']])
    expect(
      step.executableStatements.some((statement) =>
        statement.sql.includes('ADD COLUMN "seq" BIGINT'),
      ),
    ).toBe(true)
    expect(replayPostgresqlMigrationHistory(history.root, history.steps).head).toEqual(history.head)
  })
  test('executable SQL tampering is rejected even with a recomputed artifact digest', () => {
    const { index, step } = edge()
    const changed = rehash({
      ...step,
      executableStatements: step.executableStatements.map((statement) =>
        statement.sql.includes('ADD COLUMN')
          ? { ...statement, sql: statement.sql + ' DEFAULT 0' }
          : statement,
      ),
    })
    expect(() =>
      replayPostgresqlMigrationHistory(history.root, [...history.steps.slice(0, index), changed]),
    ).toThrow()
  })
  test('a column inserted in the middle is not an append', () => {
    expect(() =>
      create((table) => ({
        ...table,
        columns: [table.columns.at(-1)!, ...table.columns.slice(0, -1)],
      })),
    ).toThrow()
  })
  for (const field of ['not-null', 'primary', 'identity', 'unique', 'expression'] as const) {
    test(`rejects unsupported ${field} column semantics`, () => {
      expect(() =>
        create((table) => ({
          ...table,
          columns: table.columns.map((column) =>
            column.name !== 'seq'
              ? column
              : {
                  ...column,
                  ...(field === 'not-null'
                    ? { nullable: false }
                    : field === 'primary'
                      ? { primary: true }
                      : field === 'identity'
                        ? { identity: true }
                        : field === 'unique'
                          ? { uniqueName: 'unsupported' }
                          : {
                              defaultKind: 'database-expression' as const,
                              hasDefault: true,
                              providerDefault: {
                                sqlite: 'CURRENT_TIMESTAMP',
                                postgresql: 'CURRENT_TIMESTAMP',
                              },
                            }),
                },
          ),
        })),
      ).toThrow()
    })
  }
  test('a new foreign key on the appended column is rejected', () => {
    expect(() =>
      create((table) => ({
        ...table,
        foreignKeys: [
          ...table.foreignKeys,
          {
            name: 'unsupported',
            columns: ['seq'],
            foreignTable: 'node_run_seq_allocations',
            foreignColumns: ['seq'],
            onDelete: 'no action',
            onUpdate: 'no action',
          },
        ],
      })),
    ).toThrow()
  })
  test('a nonnullable literal-default tail column is admitted', () => {
    const step = create((table) => ({
      ...table,
      columns: table.columns.map((column) =>
        column.name === 'seq'
          ? {
              ...column,
              nullable: false,
              hasDefault: true,
              defaultKind: 'literal',
              defaultValue: '7',
              providerDefault: { sqlite: '7', postgresql: '7' },
            }
          : column,
      ),
    }))
    expect(
      step.executableStatements.some(
        (statement) => statement.sql.includes('ADD COLUMN') && statement.sql.includes('DEFAULT 7'),
      ),
    ).toBe(true)
  })
  test('a unique index over only old columns remains forbidden', () => {
    expect(() =>
      create((table) => ({
        ...table,
        indexes: [
          ...table.indexes,
          { name: 'unsupported', unique: true, columns: ['task_id', 'node_id'], where: null },
        ],
        unique: [
          ...table.unique,
          { name: 'unsupported', columns: ['task_id', 'node_id'], expression: null },
        ],
      })),
    ).toThrow()
  })
  test('the additive bridge retains the old column list; index-only stays strict', () => {
    const { from, to } = edge()
    const input = { fromContractDigest: from.contract.digest, toContractDigest: to.contract.digest }
    const bridge = resolvePostgresqlAdditiveRowBridge(history, input)
    expect(bridge.source).toEqual(from.contract)
    expect(bridge.target).toEqual(to.contract)
    expect(
      bridge.source.tables
        .find((table) => table.id === 'node_runs')!
        .columns.some((column) => column.name === 'seq'),
    ).toBe(false)
    expect(() => resolvePostgresqlIndexOnlyRowBridge(history, input)).toThrow(
      'historical row, codec, key or disposition changed',
    )
  })
})
