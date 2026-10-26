// Epoch-1 PostgreSQL installations received SQLite migration seeds through the
// logical copy or the hosted install Job. Frozen PostgreSQL DDL alone is not an installation.
import { Database } from 'bun:sqlite'
import { orderSeedTables } from '@/platform/persistence/hostedInstallationSeed'
import type { PostgresqlMigrationVersion } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import {
  decodeLogicalRow,
  encodeLogicalRow,
} from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { quoteSchemaIdentifier as quote } from '@/platform/persistence/schema/expressions'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { installFrozenSqlite } from '../rfc395V1Harness'
import type { V2Harness } from '../rfc395V2Harness'

export async function seedFrozenPostgresqlSource(
  source: V2Harness,
  version: PostgresqlMigrationVersion,
): Promise<void> {
  const database = new Database(':memory:')
  try {
    await installFrozenSqlite(database, version.sqliteMigrations.length)
    const tables = version.contract.tables.flatMap((table) => {
      if (!table.providerTables.postgresql) return []
      const rows = database.query(`SELECT * FROM ${quote(table.sourceTable)}`).all()
      return rows.length
        ? [
            {
              name: table.id,
              references: table.foreignKeys.map((key) => key.foreignTable),
              table,
              rows,
            },
          ]
        : []
    })
    for (const { table, rows } of orderSeedTables(tables)) {
      const names = table.columns.map((column) => column.name)
      for (const row of rows) {
        const decoded = decodeLogicalRow(
          table,
          encodeLogicalRow(table, row as Record<string, unknown>),
        )
        // Existing upgrade seeds belong to the frozen PostgreSQL chain; never overwrite them.
        await source.sourceHarness.native.execute(
          `INSERT INTO ${source.sourceHarness.table(table.id)} (${names.map(quote).join(',')}) VALUES (${parameters(source.sourceHarness.native, names.length)}) ON CONFLICT DO NOTHING`,
          names.map((name) => decoded[name]),
        )
      }
    }
  } finally {
    database.close()
  }
}
