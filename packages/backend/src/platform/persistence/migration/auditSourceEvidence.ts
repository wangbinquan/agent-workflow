// RFC-395: capture evidence only. Capture never adds an audit sample to the supported manifest.
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { digestSchemaContract } from '../schema/canonical'
import { collectSqliteHistoryCatalog } from '../schema/history/catalog'
import { vacuumSqliteInto } from './legacy/sqliteSnapshot'
import { collectSourceFingerprint } from './sourceCatalog'
import { rawSourceCell, sqliteIdentityHighWater } from './rawSourceReader'
import { SourceBlockedError, sourceFailure } from './sourceTypes'

export function captureEpoch1SqliteEvidence(input: {
  readonly sourcePath: string
  readonly operationRoot: string
  readonly appliedBy?: {
    readonly revision: string
    readonly unknownMigrationSql: Readonly<Record<string, string>>
  }
}) {
  mkdirSync(input.operationRoot, { recursive: true })
  const directory = mkdtempSync(join(input.operationRoot, 'epoch1-evidence-'))
  let database: Database | undefined
  try {
    const path = join(directory, 'evidence.sqlite')
    vacuumSqliteInto({ dbPath: input.sourcePath, dest: path })
    database = new Database(path, { readonly: true })
    const schema = database
      .query('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name')
      .all()
    const fingerprint = collectSourceFingerprint(database)
    const journalQuery = Object.hasOwn(fingerprint.tableRows, '__drizzle_migrations')
      ? database.query(
          'SELECT id,hash,created_at FROM __drizzle_migrations ORDER BY created_at,id,rowid',
        )
      : null
    if (journalQuery)
      (journalQuery as typeof journalQuery & { safeIntegers(enabled: boolean): void }).safeIntegers(
        true,
      )
    const journal = (journalQuery?.all() ?? []).map((row) =>
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([name, value]) => [
          name,
          rawSourceCell('journal', value).value,
        ]),
      ),
    )
    const payload = {
      version: 1 as const,
      schema,
      catalog: collectSqliteHistoryCatalog(database),
      journal,
      tableRows: fingerprint.tableRows,
      sqliteSequence: sqliteIdentityHighWater(database),
      pragmas: Object.fromEntries(
        [
          'page_size',
          'user_version',
          'application_id',
          'journal_mode',
          'encoding',
          'quick_check',
          'integrity_check',
          'foreign_key_check',
        ].map((name) => [name, database!.query(`PRAGMA ${name}`).all()]),
      ),
      sqliteVersion: database.query('SELECT sqlite_version() AS version').get(),
      appliedBy: input.appliedBy ?? null,
    }
    return { ...payload, digest: digestSchemaContract(payload) }
  } catch (error) {
    throw sourceFailure(error)
  } finally {
    database?.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
export type Epoch1SqliteEvidence = ReturnType<typeof captureEpoch1SqliteEvidence>
export function verifyEpoch1SqliteEvidence(evidence: Epoch1SqliteEvidence): void {
  const { digest, ...payload } = evidence
  if (digestSchemaContract(payload) !== digest)
    throw new SourceBlockedError('Frozen audit-sample evidence digest differs')
}
