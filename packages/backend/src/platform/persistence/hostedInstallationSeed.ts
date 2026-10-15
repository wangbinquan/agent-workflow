// RFC-370 M0 — the initial rows of a fresh CrewStation-hosted installation.
//
// The PostgreSQL migrator projects DDL only. The rows that SQLite migrations
// insert (the login policy singleton, framework built-in resources, committed
// event family cutovers, ...) reach a standalone PostgreSQL through the RFC-349
// logical copy from its SQLite source. A hosted installation has no SQLite
// source, so the release migration Job copies the same rows once from a freshly
// migrated in-memory SQLite database — the exact starting point a standalone
// install migrated to PostgreSQL would have. Later rows come from PostgreSQL
// upgrade steps, never from this copy.
import { getTableName, isTable } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import type { ProviderNeutralDatabase } from '@/db/query'
import * as schema from '@/db/schema'
import { authLoginPolicy } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { databaseSessionFor } from './databaseTransaction'

const SEED_MARKER_POLICY_ID = 'global'
const INSERT_CHUNK = 200

interface SeedTable {
  readonly name: string
  readonly table: SQLiteTable
  readonly rows: readonly Record<string, unknown>[]
  readonly references: readonly string[]
}

function readSeedTables(migrationsFolder: string): SeedTable[] {
  const restore = selectDatabaseSchemaProvider('sqlite')
  const source = createInMemoryDb(migrationsFolder, { bootstrap: 'required' })
  try {
    const tables: SeedTable[] = []
    for (const candidate of Object.values(schema)) {
      if (!isTable(candidate)) continue
      const table = candidate as SQLiteTable
      const rows = source.select().from(table).all() as Record<string, unknown>[]
      if (rows.length === 0) continue
      tables.push({
        name: getTableName(table),
        table,
        rows,
        references: getTableConfig(table).foreignKeys.map((fk) =>
          getTableName(fk.reference().foreignTable),
        ),
      })
    }
    return tables
  } finally {
    source.$client.close()
    restore()
  }
}

/** Parents before children; a reference outside the seed set is already satisfied. */
export function orderSeedTables<T extends Pick<SeedTable, 'name' | 'references'>>(
  tables: readonly T[],
): T[] {
  const names = new Set(tables.map((table) => table.name))
  const pending = [...tables]
  const ordered: T[] = []
  const placed = new Set<string>()
  while (pending.length > 0) {
    const ready = pending.filter((table) =>
      table.references.every(
        (reference) => reference === table.name || placed.has(reference) || !names.has(reference),
      ),
    )
    if (ready.length === 0) {
      throw new Error(
        `seed tables form a foreign-key cycle: ${pending.map((table) => table.name).join(', ')}`,
      )
    }
    for (const table of ready) {
      ordered.push(table)
      placed.add(table.name)
      pending.splice(pending.indexOf(table), 1)
    }
  }
  return ordered
}

export interface HostedInstallationSeedReceipt {
  readonly seeded: boolean
  readonly tables: number
  readonly rows: number
}

/**
 * Idempotent: the login policy singleton is inserted by the copy itself, so a
 * committed seed is recognised and a crashed one rolled back and repeated.
 * A hosted installation has no first-administrator bootstrap — administrators
 * come from the platform identity — so the copied policy is marked complete.
 */
export async function seedHostedInstallation(input: {
  readonly target: ProviderNeutralDatabase
  readonly migrationsFolder: string
  readonly now: number
}): Promise<HostedInstallationSeedReceipt> {
  const seededAlready = async (handle: ProviderNeutralDatabase): Promise<boolean> =>
    (
      await handle
        .select({ id: authLoginPolicy.id })
        .from(authLoginPolicy)
        .where(eq(authLoginPolicy.id, SEED_MARKER_POLICY_ID))
        .limit(1)
    ).length > 0
  if (await seededAlready(input.target)) return { seeded: false, tables: 0, rows: 0 }
  const tables = orderSeedTables(readSeedTables(input.migrationsFolder))
  return await databaseSessionFor(input.target).transaction(async (tx) => {
    if (await seededAlready(tx)) return { seeded: false, tables: 0, rows: 0 }
    let rows = 0
    for (const table of tables) {
      for (let offset = 0; offset < table.rows.length; offset += INSERT_CHUNK) {
        await tx.insert(table.table).values(table.rows.slice(offset, offset + INSERT_CHUNK))
      }
      rows += table.rows.length
    }
    await tx
      .update(authLoginPolicy)
      .set({ bootstrapCompletedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(authLoginPolicy.id, SEED_MARKER_POLICY_ID),
          isNull(authLoginPolicy.bootstrapCompletedAt),
        ),
      )
    return { seeded: true, tables: tables.length, rows }
  })
}
