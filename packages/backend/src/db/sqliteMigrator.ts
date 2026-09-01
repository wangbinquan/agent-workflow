// SQLite migration execution with a narrow compatibility shim for historical
// RFC-223 JSON rewrites. SQLite only added ORDER BY inside aggregate argument
// lists in 3.44. Some supported macOS runtimes still expose an older system
// SQLite even when the Bun interpreter itself was built more recently.
//
// Published migration bytes and their Drizzle hashes are immutable. Rather
// than editing those files, this executor keeps the original receipt hash and
// rewrites only the statement presented to an engine that lacks the syntax.

import type { Database } from 'bun:sqlite'
import { readMigrationFiles, type MigrationConfig, type MigrationMeta } from 'drizzle-orm/migrator'

const ORDERED_JSON_AGGREGATE_PATTERN =
  /SELECT json_group_array\(\n(?<value>[\s\S]*?)\n[ \t]+ORDER BY (?<order>[^\n]+)\n[ \t]*\)\n[ \t]*FROM (?<source>json_each\([^\n]+\) AS [^\s;\n]+)/gu
const UNREWRITTEN_ORDERED_JSON_AGGREGATE_PATTERN =
  /SELECT json_group_array\(\n[\s\S]*?\n[ \t]+ORDER BY [^\n]+\n[ \t]*\)\n[ \t]*FROM json_each\([^\n]+\) AS [^\s;\n]+/u

const ORDERED_JSON_AGGREGATE_PROBE = `
  SELECT json_group_array(value ORDER BY key) AS value
  FROM (
    SELECT 1 AS value, 1 AS key
  )
`

export interface SqliteMigrationExecutionOptions {
  /** Test-only override used to exercise the compatibility executor on new SQLite. */
  readonly orderedJsonAggregateSupport?: boolean
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function sqliteSupportsOrderedJsonAggregates(sqlite: Database): boolean {
  try {
    sqlite.query(ORDERED_JSON_AGGREGATE_PROBE).get()
    return true
  } catch {
    return false
  }
}

/**
 * Converts SQLite 3.44's `json_group_array(value ORDER BY key)` spelling into
 * the older, byte-equivalent ordered-subquery form. Every historical use has
 * a single `json_each(...) AS alias` source; unfamiliar shapes are left alone
 * and rejected below instead of being guessed.
 */
export function rewriteLegacyOrderedJsonAggregates(statement: string): string {
  let replacementIndex = 0
  const rewritten = statement.replace(
    ORDERED_JSON_AGGREGATE_PATTERN,
    (_match, ...args: unknown[]) => {
      const groups = args.at(-1) as { value?: string; order?: string; source?: string } | undefined
      const value = groups?.value
      const order = groups?.order
      const source = groups?.source
      if (value === undefined || order === undefined || source === undefined) return _match
      replacementIndex += 1
      const alias = `__aw_ordered_json_${replacementIndex}`
      return [
        `SELECT json_group_array(json(${quoteIdentifier(alias)}.${quoteIdentifier('value')}))`,
        'FROM (',
        `  SELECT ${value.trim()} AS ${quoteIdentifier('value')}`,
        `  FROM ${source}`,
        `  ORDER BY ${order.trim()}`,
        `) AS ${quoteIdentifier(alias)}`,
      ].join('\n')
    },
  )

  if (UNREWRITTEN_ORDERED_JSON_AGGREGATE_PATTERN.test(rewritten)) {
    throw new Error('unsupported historical ordered JSON aggregate migration shape')
  }
  return rewritten
}

function migrationsForEngine(
  migrations: readonly MigrationMeta[],
  supportsOrderedJsonAggregates: boolean,
): MigrationMeta[] {
  if (supportsOrderedJsonAggregates) return [...migrations]
  return migrations.map((migration) => ({
    ...migration,
    sql: migration.sql.map(rewriteLegacyOrderedJsonAggregates),
  }))
}

/**
 * Executes the same receipt protocol as Drizzle's synchronous SQLite
 * migrator, while retaining control of the SQL handed to older engines.
 */
export function migrateSqlite(
  sqlite: Database,
  config: MigrationConfig,
  options: SqliteMigrationExecutionOptions = {},
): void {
  const migrations = migrationsForEngine(
    readMigrationFiles(config),
    options.orderedJsonAggregateSupport ?? sqliteSupportsOrderedJsonAggregates(sqlite),
  )
  const migrationsTable = config.migrationsTable ?? '__drizzle_migrations'
  const table = quoteIdentifier(migrationsTable)
  // Keep the persisted CREATE SQL byte-identical to Drizzle's migration
  // receipt table. Snapshot parity intentionally fingerprints sqlite_schema,
  // including this whitespace.
  sqlite.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			)
		`)
  const last = sqlite
    .query(`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`)
    .get() as { created_at: number | string | null } | null
  const lastAppliedAt = last?.created_at === null || last === null ? null : Number(last.created_at)
  const insertReceipt = sqlite.query(`INSERT INTO ${table} (hash, created_at) VALUES (?, ?)`)

  sqlite.exec('BEGIN')
  try {
    for (const migration of migrations) {
      if (lastAppliedAt !== null && lastAppliedAt >= migration.folderMillis) continue
      for (const statement of migration.sql) sqlite.exec(statement)
      insertReceipt.run(migration.hash, migration.folderMillis)
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}
