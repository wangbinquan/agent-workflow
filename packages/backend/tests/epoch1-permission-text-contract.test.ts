// Released epoch-1 defect: user_permission_grants.permission is plain text, not JSON.
// User decision (2026-10-24): fix epoch 1 now, append history and retain old backup contracts.
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { buildFrozenEpoch1LogicalSchemaContract as buildLogicalSchemaContract } from '@/platform/persistence/migration/epoch1/contract'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/migration/legacy/postgresqlMigrationHistory'
import {
  createPostgresqlCodecUpgrade,
  postgresqlMigrationDigest,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlAdditiveRowBridge,
  resolvePostgresqlHistoricalContract,
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlMigrationHistory,
  type PostgresqlMigrationVersion,
} from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/migration/legacy/postgresqlSchema'
import { encodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import {
  digestSchemaContract,
  type LogicalColumnContract,
} from '@/platform/persistence/schemaContract'

setDefaultTimeout(60_000)
let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract: buildLogicalSchemaContract() })
})

function changedColumn(change: Partial<LogicalColumnContract>): PostgresqlMigrationVersion {
  const { digest: _digest, ...body } = history.head.contract
  const payload = {
    ...body,
    tables: body.tables.map((table) =>
      table.id === 'user_permission_grants'
        ? {
            ...table,
            columns: table.columns.map((column) =>
              column.name === 'permission' ? { ...column, ...change } : column,
            ),
          }
        : table,
    ),
  }
  const contract = { ...payload, digest: digestSchemaContract(payload) }
  return { ...history.head, contract, plan: buildPostgresqlSchemaPlan(contract) }
}

function upgrade(to = history.head) {
  return createPostgresqlCodecUpgrade({
    from: history.versions.at(-2)!,
    to,
    id: '0038_epoch1_permission_text',
    sequence: 38,
    previousEntryDigest: history.steps.at(-2)!.digest,
  })
}

describe('epoch-1 permission text contract correction', () => {
  test('the committed V9 changes only the logical codec and contract row', () => {
    const step = upgrade()
    expect(step).toEqual(history.steps.at(-1)!)
    expect(step.version).toBe(9)
    expect(step.logicalCodecs).toEqual([
      {
        tableId: 'user_permission_grants',
        column: 'permission',
        before: 'json-text',
        after: 'text-identity',
      },
    ])
    expect(step.executableStatements).toHaveLength(1)
    expect(step.executableStatements[0]).toMatchObject({
      kind: 'metadata',
      logicalId: 'advance-contract-row',
    })
    expect(step.executableStatements[0]!.sql).toStartWith(
      'UPDATE "agent_workflow_meta"."schema_contract"',
    )
    expect(step.sqliteMigration.appended.map((entry) => entry.tag)).toEqual([
      '0262_epoch1_permission_text',
    ])
    expect(step.sqliteMigration.to.count).toBe(262)
    const physical = (version: PostgresqlMigrationVersion) =>
      version.plan.statements.filter((statement) => statement.logicalId !== 'contract-row')
    expect(physical(history.head)).toEqual(physical(history.versions.at(-2)!))
  })

  test('historical JSON contracts remain available and bridge into the corrected head', () => {
    const previous = history.versions.at(-2)!.contract
    expect(resolvePostgresqlHistoricalContract(history, previous.digest)).toEqual(previous)
    expect(
      previous.tables
        .find((table) => table.id === 'user_permission_grants')!
        .columns.find((column) => column.name === 'permission')!.logicalCodec,
    ).toBe('json-text')
    const input = {
      fromContractDigest: previous.digest,
      toContractDigest: history.head.contract.digest,
    }
    expect(resolvePostgresqlAdditiveRowBridge(history, input)).toMatchObject({
      source: previous,
      target: history.head.contract,
    })
    expect(() => resolvePostgresqlIndexOnlyRowBridge(history, input)).toThrow(
      'historical row, codec, key or disposition changed',
    )
    const oldTable = previous.tables.find((table) => table.id === 'user_permission_grants')!
    const row = {
      user_id: 'permission-user',
      permission: 'users:presence',
      granted_by_user_id: null,
      granted_at: 1,
    }
    expect(() => encodeLogicalRow(oldTable, row)).toThrow(
      'invalid JSON at user_permission_grants.permission',
    )
    expect(() =>
      encodeLogicalRow(
        history.head.contract.tables.find((table) => table.id === oldTable.id)!,
        row,
      ),
    ).not.toThrow()
  })

  test.each([
    { logicalCodec: 'integer' as const },
    { logicalCodec: 'integer' as const, providerType: { sqlite: 'integer', postgresql: 'bigint' } },
  ])('rejects a codec requiring provider DDL: %j', (change) => {
    expect(() => upgrade(changedColumn(change))).toThrow(
      'logical codec replacement requires provider DDL',
    )
  })

  test('rejects other contract edits and a missing SQLite delta', () => {
    expect(() => upgrade(changedColumn({ nullable: true }))).toThrow(
      'codec-only upgrade changed another contract field',
    )
    const previous = history.versions.at(-2)!
    expect(() =>
      upgrade({
        ...history.head,
        sqliteMigrations: previous.sqliteMigrations,
        sqliteMigration: previous.sqliteMigration,
      }),
    ).toThrow('requires an appended SQLite migration')
  })

  test('replay validates codec source, version and executable statement digests', () => {
    const step = history.steps.at(-1)!
    const replay = (changes: Partial<typeof step>) => {
      const { digest: _digest, ...payload } = { ...step, ...changes }
      return replayPostgresqlMigrationHistory(history.root, [
        ...history.steps.slice(0, -1),
        { ...payload, digest: postgresqlMigrationDigest(payload) },
      ])
    }
    expect(() =>
      replay({ logicalCodecs: [{ ...step.logicalCodecs![0]!, before: 'text' }] }),
    ).toThrow('logical codec replacement source differs')
    expect(() => replay({ version: 8 })).toThrow(
      'logical codec correction does not match upgrade version',
    )
    expect(() => replay({ executableStatements: [] })).toThrow('upgrade executable SQL differs')
  })
})
