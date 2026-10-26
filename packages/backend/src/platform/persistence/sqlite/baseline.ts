import type { HistoryVersion } from '../schema/history/types'
import type { MetaTableDeclaration } from '../schema/history/meta'
// One synchronous epoch-2 baseline for native SQLite and provider fixtures.
import { Database } from 'bun:sqlite'
import { nativeTransactionSync } from '@/db/txSync'
import { randomUUID } from 'node:crypto'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { quoteSchemaIdentifier as quote } from '@/platform/persistence/schema/expressions'
import { compileMetaTables } from '@/platform/persistence/schema/history/meta'
import { targetSentinelStatements } from '@/platform/persistence/schema/history/markers'
import {
  compileInstallSeeds,
  renderInstallSeedStatements,
} from '@/platform/persistence/schema/seeds'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'

export interface SqliteBaselineOptions {
  readonly bootstrap?: 'ready' | 'required'
  readonly now?: number
  readonly generationId?: string
}
interface BaselineDefinition {
  readonly head: HistoryVersion
  readonly metaTables: readonly MetaTableDeclaration[]
}
const snapshots = new WeakMap<HistoryVersion, Uint8Array>()
const TEMPLATE_GENERATION = 'dbg_sqlite_baseline_template'
function registry(definition: BaselineDefinition): SchemaRegistry {
  const contract = definition.head.contract.contract
  return {
    schemaEpoch: 2,
    tables: contract.tables,
    contributions: contract.contributions.map((entry) => ({
      ...entry,
      tables: contract.tables.filter((table) => table.owner === entry.owner),
    })),
  }
}
/** Install the same baseline into an empty native connection (also used by fixture reset). */
export function installSqliteBaseline(
  definition: BaselineDefinition,
  database: Database,
  options: SqliteBaselineOptions = {},
): void {
  const head = definition.head
  const now = options.now ?? Date.now()
  const generationId = options.generationId ?? `dbg_test_${randomUUID()}`
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!
    .foreign_keys
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    nativeTransactionSync(database, () => {
      for (const statement of head.sqlite.head) database.exec(statement.sql)
      for (const statement of compileMetaTables('sqlite', definition.metaTables))
        database.exec(statement)
      for (const statement of renderInstallSeedStatements(
        compileInstallSeeds(registry(definition), { path: 'test-baseline', installedAt: now }).rows,
        'sqlite',
      ))
        database.exec(statement)
      for (const statement of targetSentinelStatements('sqlite')) database.exec(statement)
      database
        .query(
          'INSERT INTO aw_meta_schema_history (version, contract_digest, sqlite_plan_digest, postgresql_plan_digest, applied_at, artifact_json) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          head.contract.version,
          head.contract.contract.digest,
          head.sqlite.digest,
          head.postgresql.digest,
          now,
          canonicalSchemaJson(head),
        )
      database
        .query(
          'INSERT INTO aw_meta_first_write (generation_id, first_live_write_at) VALUES (?, NULL)',
        )
        .run(generationId)
      database
        .query(
          "INSERT INTO aw_meta_generations (generation_id, schema_epoch, role, state, provider, contract_digest, plan_digest, created_at, activated_at) VALUES (?, 2, 'installed', 'active', 'sqlite', ?, ?, ?, ?)",
        )
        .run(generationId, head.contract.contract.digest, head.sqlite.digest, now, now)
      if (options.bootstrap !== 'required')
        database.exec(
          "UPDATE auth_login_policy SET bootstrap_completed_at = coalesce(bootstrap_completed_at, 0) WHERE id = 'global'",
        )
      if (database.query('PRAGMA foreign_key_check').all().length)
        throw new Error('SQLite baseline contains invalid foreign keys')
    })
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}
function serializedBaseline(definition: BaselineDefinition): Uint8Array {
  const cached = snapshots.get(definition.head)
  if (cached) return cached
  const database = new Database(':memory:')
  try {
    installSqliteBaseline(definition, database, {
      now: 0,
      generationId: TEMPLATE_GENERATION,
      bootstrap: 'required',
    })
    const snapshot = database.serialize()
    snapshots.set(definition.head, snapshot)
    return snapshot
  } finally {
    database.close()
  }
}
/** Deserialize copies the template; connection-local FK enforcement is set on every copy. */
export function createSqliteBaseline(
  definition: BaselineDefinition,
  options: SqliteBaselineOptions = {},
): Database {
  const database = Database.deserialize(serializedBaseline(definition))
  const now = options.now ?? Date.now()
  const generationId = options.generationId ?? `dbg_test_${randomUUID()}`
  try {
    database.exec('PRAGMA foreign_keys = ON')
    nativeTransactionSync(database, () => {
      database.query('UPDATE aw_meta_schema_history SET applied_at = ?').run(now)
      database.query('UPDATE aw_meta_first_write SET generation_id = ?').run(generationId)
      database
        .query('UPDATE aw_meta_generations SET generation_id = ?, created_at = ?, activated_at = ?')
        .run(generationId, now, now)
      // Only install-time cells vary between hydrated copies; keys and literal seeds are fixed.
      for (const contribution of registry(definition).contributions)
        for (const seed of contribution.seeds ?? []) {
          const table = contribution.tables.find((table) => table.id === seed.table)!
          for (const row of seed.rows) {
            const timed = Object.entries(row).filter(
              ([, value]) => typeof value === 'object' && value !== null,
            )
            if (!timed.length) continue
            const keys = table.primaryKey.map((key) => {
              const value = row[key]
              if (value === undefined || typeof value === 'object')
                throw new Error('Install seed requires literal primary keys')
              return typeof value === 'boolean' ? Number(value) : value
            })
            database
              .query(
                `UPDATE ${quote(table.id)} SET ${timed.map(([column]) => `${quote(column)} = ?`).join(', ')} WHERE ${table.primaryKey.map((key) => `${quote(key)} = ?`).join(' AND ')}`,
              )
              .run(...timed.map(() => now), ...keys)
          }
        }
      if (options.bootstrap !== 'required')
        database.exec(
          "UPDATE auth_login_policy SET bootstrap_completed_at = coalesce(bootstrap_completed_at, 0) WHERE id = 'global'",
        )
    })
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
