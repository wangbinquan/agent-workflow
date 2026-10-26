import { bindSchemaRowRuleErrors } from '@/platform/persistence/schema/rowRules'
// RFC-395 I-b: compile-only provider fixtures use native Drizzle objects and their own session tables.
import { afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle as sqliteDrizzle } from 'drizzle-orm/bun-sqlite'
import { drizzle as pgDrizzle } from 'drizzle-orm/bun-sql'
import { nativeTableSets, rowRuleCodes } from '@/bootstrap/persistenceSchema'
import {
  createPostgresqlCapabilities,
  createSqliteCapabilities,
} from '@/platform/persistence/capabilities'
import {
  bindDatabaseHandle,
  tablesOf,
  type PersistenceTables,
} from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/querySurface'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
const clients: Database[] = []
const fixtures = new Map<DatabaseProvider, { db: PersistenceDb; tables: PersistenceTables }>()
export function nativeQueryFixture(provider: DatabaseProvider): {
  db: PersistenceDb
  tables: PersistenceTables
} {
  const existing = fixtures.get(provider)
  if (existing) return existing
  let db: PersistenceDb
  if (provider === 'sqlite') {
    const client = new Database(':memory:')
    clients.push(client)
    db = bindDatabaseHandle(
      sqliteDrizzle(client, { schema: nativeTableSets.sqlite }),
      nativeTableSets.sqlite,
      createSqliteCapabilities(),
    )
  } else {
    db = bindDatabaseHandle(
      pgDrizzle.mock({ schema: nativeTableSets.postgresql }),
      nativeTableSets.postgresql,
      createPostgresqlCapabilities(),
    )
  }
  bindSchemaRowRuleErrors(db, rowRuleCodes)
  const fixture = { db, tables: tablesOf(db) }
  fixtures.set(provider, fixture)
  return fixture
}
afterAll(() => {
  for (const client of clients) client.close()
  fixtures.clear()
})
