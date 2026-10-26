import type { DatabaseProvider } from '../../databaseProviders'
import { Database } from 'bun:sqlite'
import { assertHistoryRow, readSchemaHistoryRows } from '../../schema/history/apply'
import { verifyHistoryVersion } from '../../schema/history/artifacts'
import { sameHistoryVersion } from '../../schema/history/edgeDiff'
import {
  assertHistoryCatalog,
  collectSqliteHistoryCatalog,
  collectPostgresqlHistoryCatalog,
  readPostgresqlMajor,
  type HistoryCatalogCache,
} from '../../schema/history/catalog'
import type { MetaTableDeclaration } from '../../schema/history/meta'
import type { HistoryVersion } from '../../schema/history/types'
import type { ConversionTargetConnection } from '../run/types'

export async function admitConversionTarget(
  target: ConversionTargetConnection,
  input: {
    head: HistoryVersion
    metaTables: readonly MetaTableDeclaration[]
    catalogCache: HistoryCatalogCache
  },
): Promise<void> {
  verifyHistoryVersion(input.head)
  const history = await readSchemaHistoryRows(target)
  if (history.length !== 1 || !sameHistoryVersion(history[0]!.artifact, input.head))
    throw new Error('v3-target-history-mismatch')
  assertHistoryRow(history[0]!)
  const native = catalogs[target.provider]
  const expected = await input.catalogCache.expected(
    input.head[target.provider],
    input.metaTables,
    await native.major(target),
    input.head.postgresqlCatalog,
  )
  assertHistoryCatalog(expected, await native.collect(target))
}

// Physical catalog access is selected exhaustively; the admission decision above is shared.
const catalogs = {
  sqlite: {
    major: async (_target: ConversionTargetConnection) => undefined,
    collect: async (target: ConversionTargetConnection) => {
      const files = await target.execute('PRAGMA database_list')
      const file = files.find((row) => row.name === 'main')?.file
      if (typeof file !== 'string' || !file) throw new Error('v3-target-file-required')
      const database = new Database(file, { readonly: true })
      try {
        return collectSqliteHistoryCatalog(database)
      } finally {
        database.close()
      }
    },
  },
  postgresql: {
    major: readPostgresqlMajor,
    collect: collectPostgresqlHistoryCatalog,
  },
} satisfies Record<
  DatabaseProvider,
  {
    major(target: ConversionTargetConnection): Promise<number | undefined>
    collect(
      target: ConversionTargetConnection,
    ): Promise<ReturnType<typeof collectSqliteHistoryCatalog>>
  }
>
