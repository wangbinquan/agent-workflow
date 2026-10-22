// RFC-395 I-b: schema reflection uses a native handle with the matching table set; it never queries a database.
import { afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { DbClient } from '@/db/client'
import { nativeTableSets } from '@/bootstrap/persistenceSchema'
import { bindDatabaseHandle } from '@/platform/persistence/sessionTables'
import { createSqliteCapabilities } from '@/platform/persistence/capabilities'
let handle: DbClient | undefined
export function schemaFixtureDb(): DbClient {
  return (handle ??= bindDatabaseHandle(
    drizzle(new Database(':memory:'), { schema: nativeTableSets.sqlite }),
    nativeTableSets.sqlite,
    createSqliteCapabilities(),
  ))
}
afterAll(() => {
  handle?.$client.close()
  handle = undefined
})
