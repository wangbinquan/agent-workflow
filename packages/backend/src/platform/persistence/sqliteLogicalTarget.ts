// RFC-349 — SQLite target adapter for provider-neutral logical restore and a
// future explicit PostgreSQL -> SQLite reverse migration. The caller supplies
// an already-created/migrated, inactive database. Archive-only tables may be
// physically present for SQLite history compatibility but must remain empty.

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  encodeLogicalRow,
  writeDurableLogicalArtifact,
  type CanonicalLogicalValue,
  type LogicalTableChunk,
} from './logicalDatabaseArtifact'
import type {
  LogicalDatabaseRestoreTarget,
  LogicalTargetTableVerification,
} from './logicalDatabaseRestore'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from './schemaContract'

export class SqliteLogicalTargetError extends Error {
  constructor(
    public readonly code:
      | 'sqlite-target-schema'
      | 'sqlite-target-not-empty'
      | 'sqlite-target-operation-mismatch'
      | 'sqlite-target-chunk-conflict'
      | 'sqlite-target-integrity',
    message: string,
  ) {
    super(message)
    this.name = 'SqliteLogicalTargetError'
  }
}

export interface SqliteLogicalTarget extends LogicalDatabaseRestoreTarget {
  readonly provider: 'sqlite'
  close(): Promise<void>
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
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

function scalarCount(db: Database, table: string): number {
  const row = db.query(`SELECT count(*) AS count FROM ${quote(table)}`).get() as {
    count: number | bigint
  }
  const value = Number(row.count)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteLogicalTargetError(
      'sqlite-target-integrity',
      `SQLite target returned an invalid row count for ${table}`,
    )
  }
  return value
}

function assertRoster(db: Database, contract: LogicalSchemaContract): void {
  const actual = tableNames(db)
  const expected = contract.tables.map((table) => table.providerTables.sqlite).sort()
  if (expected.some((table) => table === undefined)) {
    throw new SqliteLogicalTargetError(
      'sqlite-target-schema',
      'SQLite target contract is missing a physical table mapping',
    )
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SqliteLogicalTargetError(
      'sqlite-target-schema',
      'SQLite target table roster does not match the logical contract',
    )
  }
}

type SqliteBinding = string | number | bigint | Uint8Array | null

function sqliteValue(value: CanonicalLogicalValue): SqliteBinding {
  switch (value.type) {
    case 'null':
      return null
    case 'boolean':
      return value.value ? 1 : 0
    case 'integer':
      return BigInt(value.value)
    case 'real':
      return Number(value.value)
    case 'text':
      return value.value
    case 'bytes':
      return Buffer.from(value.value, 'base64')
  }
}

function rollback(db: Database): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // The original target error remains authoritative.
  }
}

function readTargetRow(
  db: Database,
  table: LogicalTableContract,
  row: LogicalTableChunk['payload']['rows'][number],
): Readonly<Record<string, unknown>> | null {
  const where = table.migrationKey.map((column) => `${quote(column)} = ?`).join(' AND ')
  const statement = db.query(
    `SELECT ${table.columns.map((column) => quote(column.name)).join(', ')} FROM ${quote(
      table.providerTables.sqlite!,
    )} WHERE ${where}`,
  )
  ;(statement as typeof statement & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
  return statement.get(...row.key.map(sqliteValue)) as Readonly<Record<string, unknown>> | null
}

function assertChunkRows(
  db: Database,
  table: LogicalTableContract,
  chunk: LogicalTableChunk,
): void {
  for (const sourceRow of chunk.payload.rows) {
    const targetRow = readTargetRow(db, table, sourceRow)
    if (
      targetRow === null ||
      canonicalSchemaJson(encodeLogicalRow(table, targetRow)) !== canonicalSchemaJson(sourceRow)
    ) {
      throw new SqliteLogicalTargetError(
        'sqlite-target-chunk-conflict',
        `SQLite target row differs for ${table.id} chunk ${chunk.payload.chunkIndex}`,
      )
    }
  }
}

function hasMatchingCheckpoint(
  path: string,
  expected: Readonly<Record<string, string | number>>,
  detail: string,
): boolean {
  if (!existsSync(path)) return false
  let raw: string
  let value: unknown
  try {
    raw = readFileSync(path, 'utf8')
    value = JSON.parse(raw)
  } catch {
    throw new SqliteLogicalTargetError(
      'sqlite-target-operation-mismatch',
      `SQLite ${detail} checkpoint is unreadable`,
    )
  }
  if (
    raw !== canonicalSchemaJson(value) ||
    typeof value !== 'object' ||
    value === null ||
    Object.entries(expected).some(
      ([key, expectedValue]) => (value as Readonly<Record<string, unknown>>)[key] !== expectedValue,
    )
  ) {
    throw new SqliteLogicalTargetError(
      'sqlite-target-operation-mismatch',
      `SQLite ${detail} checkpoint belongs to another operation or payload`,
    )
  }
  return true
}

export function createSqliteLogicalTarget(input: {
  readonly database: Database
  readonly operationId: string
  readonly contract: LogicalSchemaContract
  readonly checkpointRoot: string
  /** A newly migrated SQLite generation can contain migration seed rows. */
  readonly initialState?: 'empty' | 'fresh-migrated'
  readonly ownsDatabase?: boolean
}): SqliteLogicalTarget {
  const identityPath = join(input.checkpointRoot, 'sqlite-restore-target.json')
  let closed = false

  const target: SqliteLogicalTarget = {
    provider: 'sqlite',
    operationId: input.operationId,
    async prepare(now) {
      if (closed) {
        throw new SqliteLogicalTargetError('sqlite-target-integrity', 'SQLite target is closed')
      }
      const quick = input.database.query('PRAGMA quick_check').all() as { quick_check: string }[]
      if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
        throw new SqliteLogicalTargetError(
          'sqlite-target-integrity',
          'SQLite target failed quick_check before restore',
        )
      }
      assertRoster(input.database, input.contract)
      const identity = {
        version: 1,
        operationId: input.operationId,
        schemaDigest: input.contract.digest,
      }
      const resuming = hasMatchingCheckpoint(identityPath, identity, 'restore target identity')
      if (!resuming) {
        if (input.initialState === 'fresh-migrated') {
          input.database.exec('PRAGMA foreign_keys = OFF')
          input.database.exec('BEGIN IMMEDIATE')
          try {
            for (const table of [...input.contract.tables].reverse()) {
              input.database.exec(`DELETE FROM ${quote(table.providerTables.sqlite!)}`)
            }
            input.database.exec('COMMIT')
          } catch (error) {
            rollback(input.database)
            throw error
          }
        }
        for (const table of input.contract.tables) {
          if (scalarCount(input.database, table.providerTables.sqlite!) !== 0) {
            throw new SqliteLogicalTargetError(
              'sqlite-target-not-empty',
              `SQLite restore target contains rows before operation ${input.operationId}`,
            )
          }
        }
      }
      for (const table of input.contract.tables.filter(
        (candidate) => candidate.disposition === 'ARCHIVE_THEN_OMIT',
      )) {
        if (scalarCount(input.database, table.providerTables.sqlite!) !== 0) {
          throw new SqliteLogicalTargetError(
            'sqlite-target-not-empty',
            `SQLite archive-only table ${table.id} is not empty`,
          )
        }
      }
      if (!resuming) {
        writeDurableLogicalArtifact(identityPath, { ...identity, createdAt: now })
      }
      input.database.exec('PRAGMA foreign_keys = OFF')
    },

    async copyChunk(table, chunk, now) {
      if (
        table.disposition === 'ARCHIVE_THEN_OMIT' ||
        chunk.payload.operationId !== input.operationId ||
        chunk.payload.schemaDigest !== input.contract.digest ||
        chunk.payload.table !== table.id ||
        chunk.payload.disposition !== table.disposition
      ) {
        throw new SqliteLogicalTargetError(
          'sqlite-target-operation-mismatch',
          `SQLite target rejected an invalid chunk for ${table.id}`,
        )
      }
      const checkpointPath = join(
        input.checkpointRoot,
        'sqlite-restore-chunks',
        table.id,
        `chunk-${String(chunk.payload.chunkIndex).padStart(8, '0')}.json`,
      )
      const checkpoint = {
        version: 1,
        operationId: input.operationId,
        schemaDigest: input.contract.digest,
        table: table.id,
        chunkIndex: chunk.payload.chunkIndex,
        chunkDigest: chunk.digest,
        rowCount: chunk.payload.rows.length,
      }
      const checkpointExists = hasMatchingCheckpoint(checkpointPath, checkpoint, 'restore chunk')
      input.database.exec('BEGIN IMMEDIATE')
      try {
        if (chunk.payload.rows.length > 0) {
          const statement = input.database.prepare(
            `INSERT OR IGNORE INTO ${quote(table.providerTables.sqlite!)} (${table.columns
              .map((column) => quote(column.name))
              .join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`,
          )
          for (const row of chunk.payload.rows) {
            statement.run(...row.values.map(sqliteValue))
          }
        }
        assertChunkRows(input.database, table, chunk)
        input.database.exec('COMMIT')
      } catch (error) {
        rollback(input.database)
        throw error
      }
      if (!checkpointExists) {
        writeDurableLogicalArtifact(checkpointPath, { ...checkpoint, committedAt: now })
      }
    },

    async finalizeSchema(now, expectedTables) {
      input.database.exec('PRAGMA foreign_keys = ON')
      const expectedByTable = new Map<string, LogicalTargetTableVerification>()
      for (const expected of expectedTables) {
        if (expectedByTable.has(expected.table)) {
          throw new SqliteLogicalTargetError(
            'sqlite-target-integrity',
            `SQLite target verification repeats ${expected.table}`,
          )
        }
        expectedByTable.set(expected.table, expected)
      }
      if (expectedByTable.size !== input.contract.tables.length) {
        throw new SqliteLogicalTargetError(
          'sqlite-target-integrity',
          'SQLite target verification table roster is incomplete',
        )
      }
      for (const table of input.contract.tables) {
        const expected = expectedByTable.get(table.id)
        if (expected === undefined || expected.disposition !== table.disposition) {
          throw new SqliteLogicalTargetError(
            'sqlite-target-integrity',
            `SQLite target verification contract differs for ${table.id}`,
          )
        }
        const expectedRowCount = table.disposition === 'ARCHIVE_THEN_OMIT' ? 0 : expected.rowCount
        if (scalarCount(input.database, table.providerTables.sqlite!) !== expectedRowCount) {
          throw new SqliteLogicalTargetError(
            'sqlite-target-integrity',
            `SQLite restored row count differs for ${table.id}`,
          )
        }
      }
      const foreignKeys = input.database.query('PRAGMA foreign_key_check').all()
      const quick = input.database.query('PRAGMA quick_check').all() as { quick_check: string }[]
      if (foreignKeys.length !== 0 || quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
        throw new SqliteLogicalTargetError(
          'sqlite-target-integrity',
          'SQLite restored target failed foreign-key or integrity verification',
        )
      }
      const receiptPath = join(input.checkpointRoot, 'sqlite-restore-receipt.json')
      const receipt = {
        version: 1,
        operationId: input.operationId,
        schemaDigest: input.contract.digest,
      }
      if (!hasMatchingCheckpoint(receiptPath, receipt, 'restore receipt')) {
        writeDurableLogicalArtifact(receiptPath, { ...receipt, completedAt: now })
      }
    },

    async close() {
      if (closed) return
      closed = true
      if (input.ownsDatabase === true) input.database.close()
    },
  }
  return Object.freeze(target)
}
