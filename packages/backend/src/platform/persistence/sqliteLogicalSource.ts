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

export class SqliteLogicalSourceError extends Error {
  constructor(
    public readonly code:
      | 'sqlite-source-integrity'
      | 'sqlite-source-schema'
      | 'sqlite-source-mutated'
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
      if (
        dataVersion !== expected.dataVersion ||
        pageCount !== expected.pageCount ||
        fileBytes !== expected.fileBytes
      ) {
        throw new SqliteLogicalSourceError(
          'sqlite-source-mutated',
          'SQLite source generation changed after the migration freeze',
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
