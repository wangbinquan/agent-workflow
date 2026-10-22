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
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { getTableName, type Table } from 'drizzle-orm'
import { createInMemoryDb } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { persistenceSchema } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { databaseSessionFor, engineOf } from './databaseTransaction'
import type { LogicalSchemaContract } from './schemaContract'

const SEED_MARKER_POLICY_ID = 'global'
const INSERT_CHUNK = 200

interface SeedTable {
  readonly name: string
  readonly table: Table
  readonly rows: readonly Record<string, unknown>[]
  readonly references: readonly string[]
}

/**
 * The rows of a freshly migrated SQLite installation. The schema exports
 * resolve to whichever provider the process selected, so the source is always
 * read through the SQLite projection; tables the target never creates
 * (PostgreSQL omits the archive-only ones) are left out.
 */
function readSeedTables(
  target: PersistenceDb,
  migrationsFolder: string,
  omitted: ReadonlySet<string>,
): SeedTable[] {
  const source = createInMemoryDb(migrationsFolder, { bootstrap: 'required' })
  try {
    const tables: SeedTable[] = []
    const sourceTables = tablesOf(source)
    const targetTables = tablesOf(target)
    for (const definition of persistenceSchema.tables) {
      const sqliteTable = sourceTables[definition.schemaSymbol]
      const table = targetTables[definition.schemaSymbol]
      const name = getTableName(sqliteTable)
      if (omitted.has(name)) continue
      const rows = queryRows(source.select().from(sqliteTable)) as Record<string, unknown>[]
      if (rows.length === 0) continue
      tables.push({
        name,
        table,
        rows,
        references: definition.foreignKeys.map((key) => key.foreignTable),
      })
    }
    return tables
  } finally {
    source.$client.close()
  }
}

/** Source tables the target provider does not hold. */
function tablesOmittedOn(
  target: PersistenceDb,
  contract: LogicalSchemaContract,
): ReadonlySet<string> {
  if (engineOf(target).provider !== 'postgresql') return new Set()
  return new Set(
    contract.tables.flatMap((table) =>
      table.providerTables.postgresql === undefined ? [table.sourceTable] : [],
    ),
  )
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
  readonly contract: LogicalSchemaContract
  readonly target: PersistenceDb
  readonly migrationsFolder: string
  readonly now: number
}): Promise<HostedInstallationSeedReceipt> {
  const seededAlready = async (handle: PersistenceDb): Promise<boolean> => {
    const { authLoginPolicy } = tablesOf(handle)
    return (
      (
        await handle
          .select({ id: authLoginPolicy.id })
          .from(authLoginPolicy)
          .where(eq(authLoginPolicy.id, SEED_MARKER_POLICY_ID))
          .limit(1)
      ).length > 0
    )
  }
  if (await seededAlready(input.target)) return { seeded: false, tables: 0, rows: 0 }
  const tables = orderSeedTables(
    readSeedTables(
      input.target,
      input.migrationsFolder,
      tablesOmittedOn(input.target, input.contract),
    ),
  )
  return await databaseSessionFor(input.target).transaction(async (tx) => {
    if (await seededAlready(tx)) return { seeded: false, tables: 0, rows: 0 }
    let rows = 0
    for (const table of tables) {
      const target = table.table
      for (let offset = 0; offset < table.rows.length; offset += INSERT_CHUNK) {
        await tx.insert(target).values(table.rows.slice(offset, offset + INSERT_CHUNK))
      }
      rows += table.rows.length
    }
    const { authLoginPolicy } = tablesOf(tx)
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
