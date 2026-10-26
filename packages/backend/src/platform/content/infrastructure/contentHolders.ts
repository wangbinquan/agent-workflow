import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { sql } from 'drizzle-orm'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { ContentRef } from '../contentRef'
export function createContentHolderQuery(registry: SchemaRegistry) {
  const holders = registry.tables
    .filter((table) => table.owner !== 'platform/content')
    .flatMap((table) =>
      Object.values(table.columns)
        .filter((column) =>
          /(?:^|_)content_ref_json$|^prompt_ref_json$|^evidence_ref_json$/.test(column.name),
        )
        .map((column) => ({ table: table.id, column: column.name })),
    )
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
  return async (tx: PersistenceTx, ref: ContentRef): Promise<boolean> => {
    if (ref.kind === 'inline') return false
    for (const holder of holders) {
      const table = sql.raw(persistenceDialect(engineOf(tx).provider).tableName(holder.table))
      const column = sql.raw(quote(holder.column))
      // The prefilter is only an optimization. Exact decoded contentId is authoritative.
      const rows = await rawRows<{ reference: unknown }>(
        tx,
        sql`SELECT ${column} AS reference FROM ${table} WHERE ${column} LIKE ${'%' + ref.contentId + '%'}`,
      )
      for (const row of rows) {
        const value = JSON.parse(String(row.reference)) as { contentId?: string }
        if (value.contentId === ref.contentId) return true
      }
    }
    return false
  }
}
