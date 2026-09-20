// RFC-363 T2: existing installations, historical backups and both fresh schemas.
import { expect, test } from 'bun:test'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  createPostgresqlAdditiveUpgrade,
  createPostgresqlIndexUpgrade,
  postgresqlMigrationDigest,
  replayPostgresqlMigrationHistory,
  resolvePostgresqlAdditiveRowBridge,
  type PostgresqlIndexUpgrade,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { digestSchemaContract } from '@/platform/persistence/schemaContract'

const addedTables = [
  'sc_preparation_operations',
  'sc_repository_snapshots',
  'sc_repository_sources',
  'task_workspace_preparations',
]
function rehash(step: PostgresqlIndexUpgrade): PostgresqlIndexUpgrade {
  const { digest: _digest, ...body } = step
  return { ...body, digest: postgresqlMigrationDigest(body) }
}

test('RFC-363 expands the published prefix by exactly four empty active tables', async () => {
  const history = await loadPostgresqlMigrationHistory()
  const index = history.steps.findIndex(
    (step) => step.id === '0003_rfc363_workspace_preparation_journals',
  )
  expect(index).toBeGreaterThanOrEqual(0)
  const step = history.steps[index]!
  const prefix = replayPostgresqlMigrationHistory(history.root, history.steps.slice(0, index))
  const target = history.versions[index + 1]!
  expect(step.version).toBe(2)
  expect(step.logicalTables?.map(({ table }) => table.id).sort()).toEqual(addedTables)
  expect(step.logicalIndexes).toEqual([])
  expect(
    step.executableStatements
      .filter((s) => s.kind === 'table')
      .map((s) => s.logicalId)
      .sort(),
  ).toEqual(addedTables)
  expect(target.contract.activeTableCount - prefix.head.contract.activeTableCount).toBe(4)
  expect(target.contract.archiveOnlyTableCount).toBe(prefix.head.contract.archiveOnlyTableCount)
  const input = {
    from: prefix.head,
    to: target,
    id: step.id,
    sequence: step.sequence,
    previousEntryDigest: step.previousEntryDigest,
  }
  expect(createPostgresqlAdditiveUpgrade(input)).toEqual(step)
  expect(() => createPostgresqlIndexUpgrade(input)).toThrow()
  const bridge = resolvePostgresqlAdditiveRowBridge(history, {
    fromContractDigest: prefix.head.contract.digest,
    toContractDigest: target.contract.digest,
  })
  expect(bridge.steps).toEqual([step])
  for (const table of prefix.head.contract.tables)
    expect(target.contract.tables.find((next) => next.id === table.id)).toEqual(table)

  // A new-table edge cannot also alter the shape of a historical row.
  const { digest: _digest, ...body } = target.contract
  const changedBody = {
    ...body,
    tables: body.tables.map((table) =>
      table.id === 'tasks' ? { ...table, columns: table.columns.slice(1) } : table,
    ),
  }
  const contract = { ...changedBody, digest: digestSchemaContract(changedBody) }
  expect(() =>
    createPostgresqlAdditiveUpgrade({
      ...input,
      to: { ...target, contract, plan: buildPostgresqlSchemaPlan(contract) },
    }),
  ).toThrow()
  // A version discriminator cannot silently reinterpret a published V1 edge.
  expect(() =>
    replayPostgresqlMigrationHistory(history.root, [
      ...prefix.steps,
      rehash({ ...step, version: 1 }),
    ]),
  ).toThrow('table additions do not match its version')
  expect(() =>
    replayPostgresqlMigrationHistory(history.root, [
      ...prefix.steps,
      rehash({ ...step, logicalTables: [{ position: 0, table: prefix.head.contract.tables[0]! }] }),
    ]),
  ).toThrow('duplicates an existing table')
})
