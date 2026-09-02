// RFC-349 — read-only, lossless SQLite source used by the logical migration
// worker. Every integer query opts into Bun SQLite safeIntegers so a value is
// rejected or copied exactly instead of first passing through a JS double.

import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { sha256Hex } from '@/util/hash'
import {
  decodeLogicalValue,
  encodeLogicalRow,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
} from './logicalDatabaseArtifact'
import {
  assertExactSchemaRoster,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'

export interface SqliteLogicalSourceSnapshot {
  readonly databaseFingerprint: string
  readonly dataVersion: number
  readonly pageCount: number
  readonly pageSize: number
  readonly fileBytes: number
  readonly totalRows: number
  readonly tableRows: Readonly<Record<string, number>>
}

export interface SqliteLogicalSource {
  readonly provider: 'sqlite'
  readonly path: string
  preflight(): Promise<SqliteLogicalSourceSnapshot>
  assertUnchanged(snapshot: SqliteLogicalSourceSnapshot): Promise<void>
  readChunk(
    table: LogicalTableContract,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<readonly CanonicalLogicalRow[]>
  close(): Promise<void>
}

/**
 * The one signal that moved, carried in the error CODE rather than only in the
 * message: the durable failure record is a closed shape whose only free field
 * is a `detailCode` slug, so a hosted `postgresql-evidence` failure otherwise
 * reads as a bare `sqlite-source-mutated` with nothing to act on. `data-version`
 * means another connection committed (a bare `PRAGMA wal_checkpoint` is enough);
 * `page-count` / `file-bytes` mean the file itself grew or was rewritten.
 */
export type SqliteLogicalSourceMutationCode =
  | 'sqlite-source-mutated'
  | 'sqlite-source-mutated.data-version'
  | 'sqlite-source-mutated.page-count'
  | 'sqlite-source-mutated.file-bytes'

export class SqliteLogicalSourceError extends Error {
  constructor(
    public readonly code:
      | 'sqlite-source-integrity'
      | 'sqlite-source-schema'
      | SqliteLogicalSourceMutationCode
      | 'sqlite-source-read',
    message: string,
  ) {
    super(message)
    this.name = 'SqliteLogicalSourceError'
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function scalarNumber(db: Database, sql: string): number {
  const row = db.query(sql).get() as Record<string, unknown> | null
  const value = row === null ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SqliteLogicalSourceError(
      'sqlite-source-read',
      'SQLite source returned an invalid numeric diagnostic',
    )
  }
  return value
}

function sqliteKeyValue(value: CanonicalLogicalValue): unknown {
  const decoded = decodeLogicalValue(value)
  return typeof decoded === 'boolean' ? (decoded ? 1 : 0) : decoded
}

function tableNames(db: Database): string[] {
  return (
    db
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => name !== '__drizzle_migrations' && name !== '_drizzle_migrations')
}

export function openSqliteLogicalSource(input: {
  readonly path: string
  readonly contract: LogicalSchemaContract
}): SqliteLogicalSource {
  const db = new Database(input.path, { readonly: true })
  let closed = false

  const snapshot = (): SqliteLogicalSourceSnapshot => {
    if (closed) {
      throw new SqliteLogicalSourceError('sqlite-source-read', 'SQLite logical source is closed')
    }
    const quick = db.query('PRAGMA quick_check').all() as { quick_check: string }[]
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
      throw new SqliteLogicalSourceError(
        'sqlite-source-integrity',
        'SQLite source failed quick_check',
      )
    }
    const foreignKeys = db.query('PRAGMA foreign_key_check').all()
    if (foreignKeys.length !== 0) {
      throw new SqliteLogicalSourceError(
        'sqlite-source-integrity',
        `SQLite source has ${foreignKeys.length} foreign-key violation(s)`,
      )
    }
    try {
      assertExactSchemaRoster(
        tableNames(db),
        input.contract.tables.map((table) => table.sourceTable),
      )
    } catch {
      throw new SqliteLogicalSourceError(
        'sqlite-source-schema',
        'SQLite source table roster does not match the RFC-349 schema contract',
      )
    }

    const tableRows: Record<string, number> = {}
    let totalRows = 0
    for (const table of input.contract.tables) {
      const count = scalarNumber(db, `SELECT count(*) AS count FROM ${quote(table.sourceTable)}`)
      tableRows[table.id] = count
      totalRows += count
    }
    const dataVersion = scalarNumber(db, 'PRAGMA data_version')
    const pageCount = scalarNumber(db, 'PRAGMA page_count')
    const pageSize = scalarNumber(db, 'PRAGMA page_size')
    const fileBytes = input.path === ':memory:' ? pageCount * pageSize : statSync(input.path).size
    const fingerprintPayload = JSON.stringify({
      schemaDigest: input.contract.digest,
      dataVersion,
      pageCount,
      pageSize,
      fileBytes,
      tableRows,
    })
    return {
      databaseFingerprint: `sqlite:${sha256Hex(fingerprintPayload).slice(0, 24)}`,
      dataVersion,
      pageCount,
      pageSize,
      fileBytes,
      totalRows,
      tableRows: Object.freeze(tableRows),
    }
  }

  const source: SqliteLogicalSource = {
    provider: 'sqlite' as const,
    path: input.path,
    async preflight() {
      return snapshot()
    },
    async assertUnchanged(expected) {
      const dataVersion = scalarNumber(db, 'PRAGMA data_version')
      const pageCount = scalarNumber(db, 'PRAGMA page_count')
      const fileBytes =
        input.path === ':memory:' ? pageCount * expected.pageSize : statSync(input.path).size
      // Name the exact signal that moved. A bare "generation changed" verdict is
      // unactionable on a multi-GB hosted migration: `data_version` flips on any
      // *other connection writing the file at all* (a bare
      // `PRAGMA wal_checkpoint` bumps it with zero logical change), whereas
      // page_count/fileBytes only move when the file itself grows or is
      // rewritten. Which of the three fired is what tells the operator whether a
      // writer escaped the freeze or the file was merely checkpointed.
      const drift: { readonly code: SqliteLogicalSourceMutationCode; readonly detail: string }[] = [
        ...(dataVersion === expected.dataVersion
          ? []
          : [
              {
                code: 'sqlite-source-mutated.data-version' as const,
                detail: `data_version ${expected.dataVersion} -> ${dataVersion}`,
              },
            ]),
        ...(pageCount === expected.pageCount
          ? []
          : [
              {
                code: 'sqlite-source-mutated.page-count' as const,
                detail: `page_count ${expected.pageCount} -> ${pageCount}`,
              },
            ]),
        ...(fileBytes === expected.fileBytes
          ? []
          : [
              {
                code: 'sqlite-source-mutated.file-bytes' as const,
                detail: `file_bytes ${expected.fileBytes} -> ${fileBytes}`,
              },
            ]),
      ]
      if (drift.length > 0) {
        // The first entry is the most diagnostic one (see the type doc); the
        // message still lists every signal that moved.
        throw new SqliteLogicalSourceError(
          drift[0]!.code,
          `SQLite source generation changed after the migration freeze (${drift
            .map((entry) => entry.detail)
            .join(', ')})`,
        )
      }
    },
    async readChunk(table, afterKey, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new SqliteLogicalSourceError(
          'sqlite-source-read',
          'SQLite logical chunk limit must be between 1 and 10000',
        )
      }
      if (afterKey !== null && afterKey.length !== table.migrationKey.length) {
        throw new SqliteLogicalSourceError(
          'sqlite-source-read',
          `SQLite logical cursor shape does not match ${table.id}`,
        )
      }
      const columns = table.columns.map((column) => quote(column.name)).join(', ')
      const order = table.migrationKey.map(quote).join(', ')
      const where =
        afterKey === null ? '' : ` WHERE (${order}) > (${afterKey.map(() => '?').join(', ')})`
      const query = db.query(
        `SELECT ${columns} FROM ${quote(table.sourceTable)}${where} ORDER BY ${order} LIMIT ${limit}`,
      )
      ;(query as typeof query & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
      let rows: readonly Record<string, unknown>[]
      try {
        rows = (
          query as unknown as { all(...parameters: unknown[]): Record<string, unknown>[] }
        ).all(...(afterKey?.map(sqliteKeyValue) ?? []))
      } catch {
        throw new SqliteLogicalSourceError(
          'sqlite-source-read',
          `SQLite logical read failed for ${table.id}`,
        )
      }
      return rows.map((row) => encodeLogicalRow(table, row))
    },
    async close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
  return Object.freeze(source)
}
