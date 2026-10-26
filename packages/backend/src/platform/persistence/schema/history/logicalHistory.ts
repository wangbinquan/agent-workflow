import { registryFromContract } from '../contract'
import type { LogicalSchemaContract } from '../../schemaContract'
import type { PostgresqlSchemaPlan } from '../../postgresqlSchema'
import type {
  PostgresqlMigrationHistory,
  PostgresqlMigrationVersion,
} from '../../postgresqlMigrationSequence'
import { schemaHistoryRuntime } from './runtime'
import { projectLogicalSchemaContract } from '../logicalContract'
import { digestSchemaContract } from '../canonical'
export async function loadPostgresqlMigrationHistory(input: {
  headContract: LogicalSchemaContract
  plan?: PostgresqlSchemaPlan
  migrationsFolder?: string
}): Promise<PostgresqlMigrationHistory> {
  const binding = schemaHistoryRuntime()
  const versions: PostgresqlMigrationVersion[] = (binding.history?.() ?? [binding.head()]).map(
    (version) => {
      const schema = version.contract.contract
      const contract = projectLogicalSchemaContract(registryFromContract(schema))
      const plan: PostgresqlSchemaPlan = {
        version: 1,
        baselineId: '0000_rfc395_epoch2',
        schemaEpoch: 2,
        contractDigest: contract.digest,
        activeTableCount: schema.tables.length,
        archiveOnlyTableCount: 0,
        statements: version.postgresql.head.map((statement) => ({
          ...statement,
          kind: statement.kind as PostgresqlSchemaPlan['statements'][number]['kind'],
        })),
        digest: version.postgresql.digest,
      }
      const marker = {
        index: 0,
        tag: 'epoch2-schema-history',
        hash: 'RFC395_SCHEMA_EPOCH_2_REQUIRES_TARGET_BINARY',
        folderMillis: -395,
      }
      return {
        contract,
        plan,
        sqliteMigrations: [marker],
        sqliteMigration: { count: 1, last: marker, chainDigest: digestSchemaContract([marker]) },
      }
    },
  )
  const head = versions.at(-1)!
  if (head.contract.digest !== input.headContract.digest)
    throw new Error('live-logical-history-contract-mismatch')
  return {
    head,
    versions,
    steps: [],
    root: {
      ...versions[0]!,
      version: 1,
      baselineSqlDigest: versions[0]!.plan.digest,
      legacyJournalDigest: versions[0]!.sqliteMigration.chainDigest,
    },
  }
}
export async function verifyPostgresqlMigrationHistory(input: {
  headContract: LogicalSchemaContract
  plan: PostgresqlSchemaPlan
  migrationsFolder?: string
}): Promise<void> {
  const history = await loadPostgresqlMigrationHistory(input)
  if (
    !history.versions.some(
      (version) =>
        version.plan.digest === input.plan.digest &&
        version.contract.digest === input.plan.contractDigest,
    )
  )
    throw new Error('epoch2-logical-copy-head-mismatch')
}

export async function recordedLiveLogicalContract(
  digest: string,
  current: LogicalSchemaContract,
): Promise<LogicalSchemaContract | null> {
  if (digest === current.digest) return current
  const history = await loadPostgresqlMigrationHistory({ headContract: current })
  return history.versions.find((version) => version.contract.digest === digest)?.contract ?? null
}
