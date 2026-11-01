// Independent released roots, never inserted as neighbours of the frozen PG history.
import c18 from './released-postgresql/v0.18.18/contract.json'
import p18 from './released-postgresql/v0.18.18/plan.json'
import s18 from './released-postgresql/v0.18.18/sqlite-receipts.json'
import k18 from './released-postgresql/v0.18.18/catalog.json'
import c19 from './released-postgresql/v0.18.19/contract.json'
import p19 from './released-postgresql/v0.18.19/plan.json'
import s19 from './released-postgresql/v0.18.19/sqlite-receipts.json'
import k19 from './released-postgresql/v0.18.19/catalog.json'
import type { LogicalSchemaContract } from '../../schema/contractTypes'
import type { HistoryCatalog } from '../../schema/history/catalog'
import {
  postgresqlSqliteMigrationIdentity,
  type PostgresqlMigrationVersion,
} from '../legacy/postgresqlMigrationSequence'
import { loadFrozenEpoch1History } from './bundle'

export interface ReleasedPostgresqlSource extends PostgresqlMigrationVersion {
  readonly tag: string
  readonly sqliteCatalog: HistoryCatalog
}
export const releasedPostgresqlSources: readonly ReleasedPostgresqlSource[] = [
  {
    tag: 'v0.18.18',
    contract: c18 as LogicalSchemaContract,
    plan: p18 as PostgresqlMigrationVersion['plan'],
    sqliteMigrations: s18,
    sqliteMigration: postgresqlSqliteMigrationIdentity(s18),
    sqliteCatalog: k18,
  },
  {
    tag: 'v0.18.19',
    contract: c19 as LogicalSchemaContract,
    plan: p19 as PostgresqlMigrationVersion['plan'],
    sqliteMigrations: s19,
    sqliteMigration: postgresqlSqliteMigrationIdentity(s19),
    sqliteCatalog: k19,
  },
]

export async function resolveEpoch1PostgresqlVersion(
  digest: string,
): Promise<PostgresqlMigrationVersion | null> {
  return (
    releasedPostgresqlSources.find((source) => source.contract.digest === digest) ??
    (await loadFrozenEpoch1History()).postgresql.versions.find(
      (source) => source.contract.digest === digest,
    ) ??
    null
  )
}
