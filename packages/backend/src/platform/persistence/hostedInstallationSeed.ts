// Epoch-2 head installation owns all seed rows on both providers.
import { tablesOf } from './sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from './persistenceDb'
import type { LogicalSchemaContract } from './schemaContract'
interface SeedTable {
  readonly name: string
  readonly references: readonly string[]
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
export async function seedHostedInstallation(input: {
  readonly contract: LogicalSchemaContract
  readonly target: PersistenceDb
  readonly migrationsFolder?: string
  readonly now: number
  readonly installed?: { readonly tables: number; readonly rows: number }
}): Promise<HostedInstallationSeedReceipt> {
  const { authLoginPolicy } = tablesOf(input.target)
  const rows = await input.target
    .select()
    .from(authLoginPolicy)
    .where(eq(authLoginPolicy.id, 'global'))
    .limit(1)
  if (!rows.length) throw new Error('epoch2-head-seed-login-policy-missing')
  return input.installed
    ? { seeded: true, ...input.installed }
    : { seeded: false, tables: 0, rows: 0 }
}
