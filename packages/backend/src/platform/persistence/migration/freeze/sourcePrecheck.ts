// RFC-626 §3.5: what can be learned about the old database before an automatic upgrade
// registers anything. The check opens the source for reading, identifies its structure from
// the catalog and the migration journal, and measures its live data. It counts no rows, so it
// takes the same few moments on a database of any size, and it writes nothing: no directory of
// the operation, no scratch database. (Opening a WAL database that has no sidecar files lets
// SQLite create them, as every read of such a database does — RFC-398 §5.)
//
// Its structure result is not a fingerprint: the freeze still identifies the source in full,
// with row counts, before anything is converted.
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import type { JsonObject } from '@/platform/contracts/json'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
} from '../../postgresqlRuntime'
import { readPostgresqlMajor } from '../../schema/history/catalog'
import { postgresqlHistoryConnection } from '../../schema/history/connection'
import { openSqliteForRead } from '../../sqlite/openForRead'
import { errorCode, errorText } from '../errorText'
import type { EpochSourceLocation } from '../run/types'
import { collectSourceStructure } from '../sourceCatalog'
import type { EmptyTableDecision } from '../sourceDispositions'
import { identifySource, type SupportedSourceManifest } from '../supportedSources'
import {
  SourceBlockedError,
  type SourceDifference,
  type SourceFingerprint,
  type SourceTableDisposition,
} from '../sourceTypes'
import { migrationDirectoryBytes, sqliteLiveBytes } from './capacity'
import { migrationPostgresqlRuntime } from './postgresqlDatabases'

export type SourcePrecheckResult =
  | {
      readonly ok: true
      /** Bytes of live data: what every copy of the source costs, unlike the size of its file. */
      readonly liveBytes: number
    }
  | {
      readonly ok: false
      /** `unreadable`: cannot be opened or read. `structure`: not a released structure. */
      readonly reason: 'unreadable' | 'structure'
      /** One sentence a person can act on; names the objects that differ. */
      readonly message: string
      readonly detail: JsonObject
    }
export interface SourcePrecheckInput {
  readonly location: EpochSourceLocation
  /**
   * The releases the structure is compared with. Null, or without an entry for the provider of
   * the source, when they cannot be had without creating something (the catalogs of the
   * PostgreSQL releases are compiled in a scratch database): the structure is then left to the
   * freeze and only readability and size are checked here.
   */
  readonly manifest: SupportedSourceManifest | null
  readonly emptyTables?: readonly EmptyTableDecision[]
  /** The returned runtime is borrowed; the caller owns its pool lifetime. */
  readonly postgresql?: () => PostgresqlDatabaseRuntime
  /** Server majors this build can upgrade from; another major is refused here, by name. */
  readonly supportedPostgresqlMajors?: readonly number[]
  /** Replaceable so tests can observe the statements the check issues. */
  readonly openSqlite?: (path: string) => Database
}

/** Enough to act on; the full lists are in `detail`. */
const LISTED_IN_MESSAGE = 20
const LISTED_IN_DETAIL = 500

function unreadable(
  source: string,
  subject: string,
  error: unknown,
  advice: string,
): SourcePrecheckResult {
  const text = errorText(error)
  return {
    ok: false,
    reason: 'unreadable',
    message: `${subject}: ${text}; ${advice}.`,
    detail: { source, error: text, code: errorCode(error) },
  }
}

/** `kind:relation:name` of a catalog entry, said the way a person would name the object. */
function objectLabel(path: string): { readonly relation: string; readonly label: string } | null {
  const first = path.indexOf(':')
  const second = first < 0 ? -1 : path.indexOf(':', first + 1)
  if (second < 0) return null
  const kind = path.slice(0, first)
  const relation = path.slice(first + 1, second)
  const name = path.slice(second + 1)
  switch (kind) {
    case 'table':
    case 'relation':
      return { relation, label: `table ${relation}` }
    case 'column':
      return { relation, label: `column ${relation}.${name}` }
    case 'index':
    case 'index-shape':
      return { relation, label: `index ${name} on ${relation}` }
    case 'fk':
      return { relation, label: `foreign key ${name} of ${relation}` }
    case 'sequence':
      return { relation, label: `sequence ${relation}` }
    case 'sequence-owner':
      return { relation, label: `owner of sequence ${relation}` }
    default:
      return {
        relation,
        label: relation === name ? `${kind} ${name}` : `${kind} ${name} on ${relation}`,
      }
  }
}
const isWholeTable = (path: string): boolean => /^(?:table|relation):/.test(path)

function listed(labels: readonly string[]): string {
  const shown = labels.slice(0, LISTED_IN_MESSAGE).join(', ')
  return labels.length > LISTED_IN_MESSAGE
    ? `${shown} and ${labels.length - LISTED_IN_MESSAGE} more`
    : shown
}

function structureMismatch(
  source: string,
  differences: readonly SourceDifference[],
  tables: readonly SourceTableDisposition[],
): SourcePrecheckResult {
  const unexpected = new Set<string>()
  const missing = new Set<string>()
  const changed = new Set<string>()
  const other: string[] = []
  // A table that is unexpected or missing as a whole stands for its columns and indexes.
  const wholly = (absent: (difference: SourceDifference) => boolean) =>
    new Set(
      differences
        .filter((difference) => isWholeTable(difference.path) && absent(difference))
        .flatMap((difference) => objectLabel(difference.path)?.relation ?? []),
    )
  const unexpectedTables = wholly((difference) => difference.expected === null)
  const missingTables = wholly((difference) => difference.actual === null)
  const rows = new Map(tables.map((table) => [table.physicalTable, table.rows]))
  for (const difference of differences) {
    const object = objectLabel(difference.path)
    if (!object) {
      other.push(
        difference.path === 'migration-journal.identities'
          ? 'the migration journal does not list the migrations of a released version'
          : difference.path === 'postgresql.server-major'
            ? `the server is PostgreSQL ${difference.actual}, the released structure is for PostgreSQL ${difference.expected}`
            : `${difference.path}: expected ${difference.expected ?? 'nothing'}, found ${difference.actual ?? 'nothing'}`,
      )
      continue
    }
    const whole = isWholeTable(difference.path)
    if (difference.expected === null) {
      if (whole)
        unexpected.add(`${object.label} (${rows.get(object.relation) ? 'holds rows' : 'empty'})`)
      else if (!unexpectedTables.has(object.relation)) unexpected.add(object.label)
    } else if (difference.actual === null) {
      if (whole || !missingTables.has(object.relation)) missing.add(object.label)
    } else changed.add(object.label)
  }
  const parts = [
    unexpected.size ? `unexpected: ${listed([...unexpected])}` : '',
    missing.size ? `missing: ${listed([...missing])}` : '',
    changed.size ? `changed: ${listed([...changed])}` : '',
    ...other,
  ].filter(Boolean)
  return {
    ok: false,
    reason: 'structure',
    message:
      `The structure of the database is not that of a released version — ${parts.join('; ') || 'no released structure matches it'}; ` +
      'remove what was added and restore what is missing or changed (or restore the database ' +
      'from a backup), then start again.',
    detail: {
      source,
      unexpected: [...unexpected].slice(0, LISTED_IN_DETAIL),
      missing: [...missing].slice(0, LISTED_IN_DETAIL),
      changed: [...changed].slice(0, LISTED_IN_DETAIL),
      other,
      counts: { unexpected: unexpected.size, missing: missing.size, changed: changed.size },
    },
  }
}

function identified(
  input: SourcePrecheckInput,
  source: string,
  structure: SourceFingerprint | null,
  liveBytes: number,
): SourcePrecheckResult {
  if (structure && input.manifest)
    try {
      identifySource({
        fingerprint: structure,
        manifest: input.manifest,
        emptyTables: input.emptyTables,
      })
    } catch (error) {
      if (!(error instanceof SourceBlockedError)) throw error
      return structureMismatch(source, error.differences, error.tables)
    }
  return { ok: true, liveBytes }
}
const comparable = (input: SourcePrecheckInput, provider: SourceFingerprint['provider']): boolean =>
  input.manifest?.sources.some((entry) => entry.provider === provider) === true

function precheckFile(
  input: SourcePrecheckInput,
  location: Extract<EpochSourceLocation, { kind: 'sqlite-file' }>,
): SourcePrecheckResult {
  const subject = `The database file ${location.path} cannot be read as a SQLite database`
  const advice =
    'check that it is the database of this installation and that the file is intact, then start again'
  if (!existsSync(location.path))
    return unreadable(location.path, subject, new Error('the file does not exist'), advice)
  let database: Database | undefined
  let structure: SourceFingerprint | null = null
  let liveBytes: number
  try {
    database = (input.openSqlite ?? openSqliteForRead)(location.path)
    // The catalog is read even when there is nothing to compare it with: a file that is not a
    // database fails here, by its first read.
    const collected = collectSourceStructure(database)
    structure = comparable(input, 'sqlite') ? collected : null
    liveBytes = sqliteLiveBytes(database)
  } catch (error) {
    return unreadable(location.path, subject, error, advice)
  } finally {
    database?.close()
  }
  return identified(input, location.path, structure, liveBytes)
}

async function precheckDatabase(
  input: SourcePrecheckInput,
  location: Extract<EpochSourceLocation, { kind: 'postgresql-database' }>,
): Promise<SourcePrecheckResult> {
  if (!input.postgresql) throw new Error('postgresql-source-runtime-required')
  const subject = `The PostgreSQL database (${location.profileRef}) cannot be read`
  const advice =
    'check the connection settings and that the server is running and reachable, then start again'
  let structure: SourceFingerprint | null = null
  let liveBytes: number
  let connection: PostgresqlReservedConnection
  try {
    connection = await migrationPostgresqlRuntime(input.postgresql()).providerPool().reserve()
  } catch (error) {
    return unreadable(location.profileRef, subject, error, advice)
  }
  try {
    await connection.unsafe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await connection.unsafe('SET LOCAL search_path TO agent_workflow, public')
    const history = postgresqlHistoryConnection(connection)
    const major = await readPostgresqlMajor(history)
    const supported = input.supportedPostgresqlMajors
    if (supported && !supported.includes(major))
      return {
        ok: false,
        reason: 'unreadable',
        message:
          `The PostgreSQL server (${location.profileRef}) is version ${major}; this release ` +
          `upgrades from PostgreSQL ${supported.join(', ')}. Move the database to a supported ` +
          'server version, then start again.',
        detail: { source: location.profileRef, postgresqlMajor: major, supported: [...supported] },
      }
    if (comparable(input, 'postgresql')) structure = await collectSourceStructure(history)
    const rows = await connection.unsafe('SELECT pg_database_size(current_database()) AS bytes')
    liveBytes = Number(rows[0]?.bytes)
    if (!Number.isSafeInteger(liveBytes) || liveBytes < 0)
      throw new Error('the server did not report the size of the database')
  } catch (error) {
    return unreadable(location.profileRef, subject, error, advice)
  } finally {
    try {
      await connection.unsafe('ROLLBACK')
    } catch {
      // A failed statement may already have ended the transaction; the release below is what counts.
    } finally {
      connection.release()
    }
  }
  return identified(input, location.profileRef, structure, liveBytes)
}

export async function precheckSource(input: SourcePrecheckInput): Promise<SourcePrecheckResult> {
  const { location } = input
  if (location.kind === 'sqlite-file') return precheckFile(input, location)
  if (location.kind === 'postgresql-database') return precheckDatabase(input, location)
  // A backup is an immutable input that is unpacked and verified when it is opened; there is
  // no live database to open here, only its size to report.
  return { ok: true, liveBytes: migrationDirectoryBytes(location.root) }
}
