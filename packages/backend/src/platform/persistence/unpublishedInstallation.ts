import { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Only a head committed by a fresh installer can be adopted without an operation. */
export function unpublishedSqliteInstallation(
  appHome: string,
  options: { classificationOnly?: boolean; excludedPaths?: readonly string[] } = {},
): { generationId: string; path: string } | null {
  const root = join(appHome, 'databases')
  const paths = [
    join(appHome, 'db.sqlite'),
    ...(existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, entry.name, 'db.sqlite'))
      : []),
  ]
  const installed = []
  const excluded = new Set(options.excludedPaths?.map((path) => resolve(path)))
  for (const path of paths.filter((path) => existsSync(path) && !excluded.has(resolve(path)))) {
    let db: Database | undefined
    try {
      db = new Database(path, { readonly: true })
      if (!db.query("SELECT 1 FROM sqlite_schema WHERE name = 'aw_meta_generations'").get())
        continue
      const active = db
        .query(
          "SELECT g.generation_id, g.role, g.operation_id, w.generation_id AS marker, w.first_live_write_at FROM aw_meta_generations g LEFT JOIN aw_meta_first_write w ON w.generation_id = g.generation_id WHERE g.state = 'active'",
        )
        .all() as {
        generation_id: string
        role: string
        operation_id: string | null
        marker: string | null
        first_live_write_at: number | null
      }[]
      if (
        active.length !== 1 ||
        active[0]!.role !== 'installed' ||
        active[0]!.operation_id !== null ||
        active[0]!.marker === null ||
        active[0]!.first_live_write_at !== null
      ) {
        if (options.classificationOnly) continue
        throw new Error('epoch2-unpublished-installation-not-adoptable')
      }
      installed.push({ generationId: active[0]!.generation_id, path })
    } catch (error) {
      if (!options.classificationOnly) throw error
    } finally {
      db?.close()
    }
  }
  if (installed.length > 1) {
    if (options.classificationOnly) return null
    throw new Error('epoch2-unpublished-installation-ambiguous')
  }
  return installed[0] ?? null
}
