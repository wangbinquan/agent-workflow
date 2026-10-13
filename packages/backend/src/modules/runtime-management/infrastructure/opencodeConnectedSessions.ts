import { Database } from 'bun:sqlite'

/** Original indexed session relationships, including ancestors that a
 * root-relative usage pass cannot discover. No conversation or usage is read. */
export function opencodeConnectedSessions(
  path: string,
  roots: readonly string[],
): readonly string[] | null {
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true })
    db.exec('BEGIN')
    const selected = new Set(roots),
      pending = [...selected]
    const parent = db.query<{ id: string; parent_id: string | null }, [string]>(
      'SELECT id,parent_id FROM session WHERE id = ?',
    )
    const children = db.query<{ id: string }, [string]>(
      'SELECT id FROM session WHERE parent_id = ? ORDER BY id',
    )
    for (let at = 0; at < pending.length; at++) {
      const id = pending[at]!,
        original = parent.get(id)
      for (const next of [original?.parent_id, ...children.all(id).map((row) => row.id)])
        if (next && !selected.has(next)) {
          selected.add(next)
          pending.push(next)
        }
    }
    db.exec('ROLLBACK')
    return [...selected].sort()
  } catch {
    return null
  } finally {
    db?.close()
  }
}
