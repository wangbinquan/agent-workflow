// RFC-398 S1: executable interpretation of the seed ledger's authored migration effects.
import type { Database } from 'bun:sqlite'
import type { SeedFile } from '../../../../../scripts/release-upgrade/lib/seed-model'
import { equal, invariant, q, sortedRows, type Row } from './data'

export function migrationExpectations(db: Database, seed: SeedFile): () => void {
  const expectations = (seed.migrationEffects ?? [])
    .filter((e) => e.projection)
    .map((effect) => {
      const projection = effect.projection!
      const wanted: Row[] = []
      if (projection.cardinality !== 'zero rows before the post-migration seed') {
        invariant(
          [
            'UNION ALL of both prior tables; keep each original id',
            'one row per pre-migration task',
          ].includes(projection.cardinality),
          `unimplemented migration cardinality: ${projection.cardinality}`,
        )
        for (const table of projection.sourceTables)
          for (const row of db.query<Row, []>(`SELECT * FROM ${q(table)}`).all()) {
            wanted.push(
              Object.fromEntries(
                Object.entries(projection.values).map(([name, expression]) => {
                  if (expression === '0') return [name, 0]
                  if (expression === 'clarify_sessions -> self; cross_clarify_sessions -> cross')
                    return [name, table === 'clarify_sessions' ? 'self' : 'cross']
                  const match = /^(?:source|tasks)\.([a-z_]+)(?: \(exact text\))?$/.exec(expression)
                  invariant(match, `unimplemented migration value: ${expression}`)
                  return [name, row[match[1]!]]
                }),
              ),
            )
          }
      }
      return { table: effect.table, columns: Object.keys(projection.values), wanted }
    })
  return () => {
    for (const { table, columns, wanted } of expectations) {
      const actual = db
        .query<
          Row,
          []
        >(`SELECT ${columns.length ? columns.map(q).join(',') : '*'} FROM ${q(table)}`)
        .all()
      equal(
        sortedRows(actual),
        sortedRows(wanted),
        `S1 declared migration effect ${seed.after}/${table}`,
      )
    }
  }
}
