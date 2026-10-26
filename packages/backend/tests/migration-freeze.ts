// RFC-217 T8 — freeze the drizzle migrator at a journal idx. Era-locked
// migration tests (asserting a table/column shape that a LATER migration
// destroyed, e.g. the clarify legacy tables dropped by 0107) migrate through
// `freezeAt(idx)` instead of MIGRATIONS so history stays asserted without
// keeping dead surface alive at HEAD.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import type { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate as migrateWithCallerForeignKeys } from 'drizzle-orm/bun-sqlite/migrator'
import { drizzle as postgresqlDrizzle } from 'drizzle-orm/bun-sql'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { verifyFrozenEpoch1Files } from '@/platform/persistence/migration/epoch1/bundle'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import provenance from '@/platform/persistence/migration/epoch1/provenance.json'
import { LEGACY_MIGRATION_HASHES } from '@/platform/persistence/migration/epoch1/journalAliases'
import {
  bindFrozenDatabaseHandle,
  frozenNativeTableSets,
  frozenTablesOf as frozenTables,
} from '@/platform/persistence/migration/epoch1/tables'
export type { FrozenPersistenceTables } from '@/platform/persistence/migration/epoch1/tables'
import {
  createPostgresqlCapabilities,
  createSqliteCapabilities,
} from '@/platform/persistence/capabilities'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlTransactionConnection,
} from '@/platform/persistence/postgresqlRuntime'
import { guardForeignStatements, registerLegacyDaemonTestFixture } from '@/db/client'
import { sha256Hex } from '@/util/hash'
import { rawRows, type RawRowCodecs } from '@/platform/persistence/queryHelpers'

export const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
export const FROZEN_POSTGRESQL_MIGRATIONS = resolve(
  import.meta.dir,
  '..',
  'db',
  'postgresql-migrations',
)

function verifyFrozenChain(): string {
  verifyFrozenEpoch1Files({ sqlite: MIGRATIONS, postgresql: FROZEN_POSTGRESQL_MIGRATIONS })
  return MIGRATIONS
}

/** Historical fixtures opt into V1's hash-verified source, independently of the live schema. */
export const FROZEN_MIGRATIONS = verifyFrozenChain()
export const frozenTableSets = frozenNativeTableSets
export type FrozenDbClient = ReturnType<typeof drizzle<Record<string, never>>>

export function frozenTablesOf(handle: object): typeof frozenTableSets.sqlite {
  const tables = frozenTables(handle)
  if (tables !== frozenTableSets.sqlite)
    throw new Error('Historical fixture requires the SQLite source client')
  return tables as typeof frozenTableSets.sqlite
}

/** Historical raw queries stay synchronous independently of the live provider's schema type. */
export function frozenRawRows<R extends object = Record<string, unknown>>(
  db: FrozenDbClient,
  query: Parameters<typeof rawRows>[1],
  codecs?: RawRowCodecs<R>,
): R[] {
  const result = rawRows<R>(db, query, codecs)
  if (!Array.isArray(result)) throw new Error('Frozen SQLite raw query must be synchronous')
  return result
}

/** A frozen handle is confined to migration fixtures; its types never follow the live registry. */
export function bindFrozenSqliteHandle(database: Database): FrozenDbClient {
  const db = drizzle(database)
  bindFrozenDatabaseHandle(db, createSqliteCapabilities())
  guardForeignStatements(database, db)
  return db
}

/** Source fixtures retain their native schema after A changes the live provider's schema/fence. */
export function createFrozenPostgresqlClient(runtime: PostgresqlDatabaseRuntime) {
  const pool = runtime.providerPool()
  const engine = createPostgresqlCapabilities()
  const bind = <T extends object>(handle: T): T => bindFrozenDatabaseHandle(handle, engine)
  interface Client extends Pick<PostgresqlPool, 'unsafe'> {
    begin<T>(body: (connection: Client) => Promise<T>): Promise<T>
    savepoint<T>(body: (connection: Client) => Promise<T>): Promise<T>
  }
  const clientFor = (
    connection: Pick<PostgresqlPool, 'unsafe'>,
    transaction?: PostgresqlTransactionConnection,
  ): Client => {
    const client: Client = {
      unsafe: (statement, values) => connection.unsafe(statement, values),
      async begin(body) {
        const reserved = await pool.reserve()
        try {
          const result = await reserved.begin(async (tx) => ({
            value: await body(clientFor(tx, tx)),
          }))
          return result.value
        } finally {
          reserved.release()
        }
      },
      async savepoint(body) {
        if (!transaction) throw new Error('Frozen PostgreSQL savepoint requires a transaction')
        const result = await transaction.savepoint(async (tx) => ({
          value: await body(clientFor(tx, tx)),
        }))
        return result.value
      },
    }
    return bind(client)
  }
  return bind(
    Object.assign(postgresqlDrizzle(clientFor(pool) as unknown as SQL), {
      $provider: 'postgresql' as const,
      $generationId: runtime.generationId,
    }),
  )
}

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}
interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

export function readFrozenMigrationFiles(
  input: string | { readonly migrationsFolder: string } = FROZEN_MIGRATIONS,
) {
  const migrationsFolder = typeof input === 'string' ? input : input.migrationsFolder
  verifyFrozenChain()
  const full = JSON.parse(
    readFileSync(join(FROZEN_MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as Journal
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as Journal
  if (
    journal.version !== full.version ||
    journal.dialect !== full.dialect ||
    journal.entries.length > full.entries.length ||
    JSON.stringify(journal.entries) !==
      JSON.stringify(full.entries.slice(0, journal.entries.length))
  )
    throw new Error('Historical fixture must be an exact frozen epoch-1 journal prefix')
  for (const entry of journal.entries) {
    const key = `sqlite/${entry.tag}.sql`
    const expected = (provenance.migrationFiles as Readonly<Record<string, string>>)[key]
    if (sha256Hex(readFileSync(join(migrationsFolder, `${entry.tag}.sql`))) !== expected)
      throw new Error(`Historical fixture changed frozen migration bytes: ${key}`)
  }
  return readMigrationFiles({ migrationsFolder })
}

/** Frozen replay defaults to V1's FK-off protocol; historical tests can opt into the caller's mode. */
export function migrateFrozenSqlite(
  handle: Database | { readonly $client: Database },
  options: { readonly migrationsFolder: string; readonly preserveForeignKeys?: boolean },
): number {
  const database = handle instanceof Database ? handle : handle.$client
  const chain = readFrozenMigrationFiles(options.migrationsFolder)
  const journal = JSON.parse(
    readFileSync(join(options.migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as Journal
  createFrozenSqliteJournal(database)
  const applied = database
    .query<
      { hash: string; created_at: number },
      []
    >('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all()
  if (
    applied.length > chain.length ||
    applied.some(
      (row, index) =>
        (row.hash !== chain[index]?.hash &&
          !LEGACY_MIGRATION_HASHES[journal.entries[index]!.tag]?.includes(row.hash)) ||
        Number(row.created_at) !== chain[index]?.folderMillis,
    )
  )
    throw new Error('Historical fixture receipts differ from the frozen epoch-1 prefix')
  const pending = chain.slice(applied.length)
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!
    .foreign_keys
  try {
    if (pending.length) {
      if (options.preserveForeignKeys)
        migrateWithCallerForeignKeys(drizzle(database), {
          migrationsFolder: options.migrationsFolder,
        })
      else applyFrozenSqliteMigrations(database, pending)
    }
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
  return pending.length
}

export function openFrozenEpoch1Db(options: {
  readonly path: string
  readonly migrationsFolder: string
}): FrozenDbClient {
  const database = new Database(options.path, { create: true })
  try {
    migrateFrozenSqlite(database, options)
    database.exec('PRAGMA foreign_keys = ON')
    return bindFrozenSqliteHandle(database)
  } catch (error) {
    database.close()
    throw error
  }
}

const frozenSnapshots = new Map<string, Uint8Array>()

export function createFrozenEpoch1Db(
  migrationsFolder = FROZEN_MIGRATIONS,
  options: { readonly bootstrap?: 'ready' | 'required' } = {},
): FrozenDbClient {
  const chain = readFrozenMigrationFiles(migrationsFolder)
  const key = chain.map((entry) => `${entry.folderMillis}:${entry.hash}`).join('\n')
  let snapshot = frozenSnapshots.get(key)
  if (!snapshot) {
    const source = openFrozenEpoch1Db({ path: ':memory:', migrationsFolder })
    try {
      snapshot = source.$client.serialize()
      frozenSnapshots.set(key, snapshot)
    } finally {
      source.$client.close()
    }
  }
  const database = Database.deserialize(snapshot)
  database.exec('PRAGMA foreign_keys = ON')
  const db = bindFrozenSqliteHandle(database)
  if (options.bootstrap !== 'required') {
    if (db.$client.query("SELECT 1 FROM sqlite_schema WHERE name = 'auth_login_policy'").get())
      db.$client.exec(
        "UPDATE auth_login_policy SET bootstrap_completed_at = coalesce(bootstrap_completed_at, 0) WHERE id = 'global'",
      )
    registerLegacyDaemonTestFixture(db)
  }
  return db
}

/** Copy migrations 0..idx (inclusive) into a temp folder with a truncated journal. */
export function freezeAt(idx: number): string {
  verifyFrozenChain()
  const full = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= full.entries.length)
    throw new RangeError(`Frozen epoch-1 journal index out of range: ${idx}`)
  const dir = mkdtempSync(join(tmpdir(), `aw-mig-freeze-${idx}-`))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const partial: Journal = { ...full, entries: full.entries.slice(0, idx + 1) }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(partial, null, 2), 'utf-8')
  for (const e of partial.entries) {
    copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    const snap = `${String(e.idx).padStart(4, '0')}_snapshot.json`
    if (existsSync(join(MIGRATIONS, 'meta', snap))) {
      copyFileSync(join(MIGRATIONS, 'meta', snap), join(dir, 'meta', snap))
    }
  }
  return dir
}

/** Last journal idx where the clarify legacy tables still exist (0106; 0107 drops them). */
export const LAST_LEGACY_CLARIFY_IDX = 105
