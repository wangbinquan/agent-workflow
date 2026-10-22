// RFC-395 I-a: semantic and physical inventory, including the formerly unmeasured FK/column surface.
import type { Database } from 'bun:sqlite'
import { migratedProtections, normalizeSqlText, readSqliteMaster } from './schemaReconciliation'

export function sqliteManifest(db: Database) {
  const master = readSqliteMaster(db)
  const protections = migratedProtections(db, master)
  return Object.fromEntries(
    master
      .filter(
        (row) =>
          row.type === 'table' &&
          !row.name.startsWith('sqlite_') &&
          row.name !== '__drizzle_migrations',
      )
      .map((table) => {
        const columns = db
          .query<
            { name: string; type: string; notnull: number; dflt_value: string | null; pk: number },
            []
          >(`PRAGMA table_info("${table.name}")`)
          .all()
          .map((c) => ({
            name: c.name,
            type: c.type.toUpperCase(),
            nullable: c.notnull === 0,
            default: c.dflt_value === null ? null : normalizeSqlText(c.dflt_value, table.name),
            primary: c.pk,
          }))
        const fks = db
          .query<
            {
              id: number
              seq: number
              table: string
              from: string
              to: string
              on_update: string
              on_delete: string
              match: string
            },
            []
          >(`PRAGMA foreign_key_list("${table.name}")`)
          .all()
        const foreignKeys = [...new Set(fks.map((fk) => fk.id))]
          .map((id) => {
            const parts = fks.filter((fk) => fk.id === id).sort((a, b) => a.seq - b.seq)
            const first = parts[0]!
            return {
              columns: parts.map((fk) => fk.from),
              foreignTable: first.table,
              foreignColumns: parts.map((fk) => fk.to),
              onUpdate: first.on_update,
              onDelete: first.on_delete,
            }
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        const uniqueRepresentations = db
          .query<{ name: string; origin: string; unique: number; partial: number }, []>(
            `PRAGMA index_list("${table.name}")`,
          )
          .all()
          .filter((i) => i.unique === 1 && i.origin !== 'pk')
          .map((i) => {
            const columns = db
              .query<{ name: string | null }, []>(`PRAGMA index_info("${i.name}")`)
              .all()
              .map((c) => c.name)
            return { columns, origin: i.origin, partial: i.partial }
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        return [
          table.name,
          {
            columns,
            foreignKeys,
            protections: [
              ...new Set(protections.filter((p) => p.table === table.name).map((p) => p.def)),
            ].sort(),
            uniqueRepresentations,
          },
        ]
      }),
  )
}
export function manifestDifferences(
  replay: ReturnType<typeof sqliteManifest>,
  declared: ReturnType<typeof sqliteManifest>,
) {
  const differences: { table: string; kind: string; replay?: unknown; declared?: unknown }[] = []
  for (const table of [...new Set([...Object.keys(replay), ...Object.keys(declared)])].sort()) {
    const a = replay[table]
    const b = declared[table]
    if (!a || !b) {
      differences.push({ table, kind: 'table', replay: a ?? null, declared: b ?? null })
      continue
    }
    const ac = new Map(a.columns.map((c) => [c.name, c]))
    const bc = new Map(b.columns.map((c) => [c.name, c]))
    for (const name of [...new Set([...ac.keys(), ...bc.keys()])].sort()) {
      if (JSON.stringify(ac.get(name)) !== JSON.stringify(bc.get(name)))
        differences.push({
          table,
          kind: `column:${name}`,
          replay: ac.get(name) ?? null,
          declared: bc.get(name) ?? null,
        })
    }
    const orderA = a.columns.map((c) => c.name)
    const orderB = b.columns.map((c) => c.name)
    if (JSON.stringify(orderA) !== JSON.stringify(orderB))
      differences.push({ table, kind: 'column-order' })
    for (const key of ['foreignKeys', 'protections', 'uniqueRepresentations'] as const) {
      const left = a[key].filter(
        (x) => !b[key].some((y) => JSON.stringify(x) === JSON.stringify(y)),
      )
      const right = b[key].filter(
        (x) => !a[key].some((y) => JSON.stringify(x) === JSON.stringify(y)),
      )
      if (left.length || right.length)
        differences.push({ table, kind: key, replay: left, declared: right })
    }
  }
  return differences
}
