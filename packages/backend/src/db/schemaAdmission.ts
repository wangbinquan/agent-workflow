// RFC-275 — fail-fast admission for databases whose migration receipts and
// physical SQLite schema no longer describe the same database. Drizzle's
// SQLite migrator only consults the latest timestamp; this layer validates the
// complete receipt prefix before writes and compares the migrated result with
// a fresh replay before the daemon exposes any service.

import { Database } from 'bun:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { migrateSqlite } from './sqliteMigrator'

export type SchemaDriftStage =
  | 'migration-history-preflight'
  | 'migration-history-postflight'
  | 'physical-schema'

export type SchemaDifference =
  | { kind: 'migration-missing'; tag: string; expectedWhen: number }
  | { kind: 'migration-extra'; tag: string; actualWhen: string }
  | {
      kind: 'migration-hash'
      tag: string
      expectedHash: string
      actualHash: string
    }
  | {
      kind: 'migration-order'
      tag: string
      expectedWhen: number
      actualWhen: string
    }
  | { kind: 'object-missing'; objectType: string; name: string }
  | { kind: 'object-extra'; objectType: string; name: string }
  | { kind: 'object-changed'; objectType: string; name: string }
  | { kind: 'column-missing'; table: string; column: string }
  | { kind: 'column-extra'; table: string; column: string }
  | { kind: 'column-changed'; table: string; column: string }
  | { kind: 'foreign-key-changed'; table: string; name: string }
  | { kind: 'index-changed'; table: string; name: string }

const MAX_REPORTED_DIFFERENCES = 50
const MAX_EXPECTED_PHYSICAL_SCHEMA_CACHE_ENTRIES = 8

// RFC-278 — exact receipts observed in the long-lived production database.
// These are closed, full SHA-256 aliases for historical SQL bytes that were
// applied before shared-main migration files reached their canonical form.
// The expected tag and timestamp are still checked at the same chain index;
// all other history edits continue to fail admission.
/**
 * RFC-317 T46（CC-03）—— 导出，并让唯一的消费者与唯一的守卫共用它。
 *
 * 这张表此前在 `tests/rfc278-legacy-schema-reconciliation.test.ts` 里被**手抄了一份**
 * （8 条哈希逐字重写）。手抄的账本必然与生产走散，且走散时**不会红**：生产这边加一条
 * 别名，测试那边照旧只认它自己那 8 条，于是新加的别名从来没有被任何断言看过。
 *
 * 每条别名的存活性有一条**可复核**的判据（见守卫）：别名哈希必须与该 tag 当前规范
 * 文件的哈希**不同**。相同就说明规范文件已经回到了当年被应用的字节，这条别名是死的，
 * 应当删除——比一句散文 `why` 强，因为它会自己过期。
 */
export const LEGACY_MIGRATION_HASHES: Readonly<Record<string, readonly string[]>> = {
  '0052_rfc108_recovery_events': [
    '3b5f02214e1c06a1b05ab2eaef4d1209815d60198850eba9ad4a899fa14c96f0',
  ],
  '0069_rfc129_review_selection_stale': [
    '547c53f30c3a8a8fd4df278ce0310e4a2a89f3683b6336559c31093b669f4e24',
  ],
  '0084_rfc164_workgroup_tasks': [
    '8c9f8244e564b54951c284a5ed7f20f0c9077d621ff7d49465420490182024b7',
  ],
  '0085_rfc165_task_space': ['033da7e58069bce3c90c3f2688f018417fceb5bc0995577ce828a351590800a3'],
  '0095_rfc189_wg_round': ['ae58ca1a757cc36c41af5b1a8a077a3bda436924ae074acf5a408babb5ccdfca'],
  '0107_rfc217_clarify_unify_t17': [
    '7d9cc403ede0aea34d7a6557ff0f10de73a8adb04fad09430e973c94aee2b1b4',
  ],
  '0125_rfc238_mcp_runtime_playground': [
    '475944d58ef1c8341ed86e3c88ce080aebcef8dbc23548ea43345be3a8eee450',
  ],
  '0139_rfc261_webhook_delivery_scale': [
    '1c14427b8a7f740617841f759c302f9efbe0ab611e3dd23b553c4a6a1ded794e',
  ],
}

export class DbSchemaDriftError extends Error {
  public readonly differences: readonly SchemaDifference[]
  public readonly totalDifferences: number

  constructor(
    public readonly dbPath: string,
    public readonly stage: SchemaDriftStage,
    allDifferences: readonly SchemaDifference[],
  ) {
    const sorted = [...allDifferences].sort((left, right) =>
      differenceSortKey(left).localeCompare(differenceSortKey(right)),
    )
    const first = sorted[0]
    super(
      `database schema drift detected at ${stage}: ` +
        (first === undefined ? 'unknown difference' : formatSchemaDifference(first)) +
        (sorted.length > 1 ? ` (+${sorted.length - 1} more)` : ''),
    )
    this.name = 'DbSchemaDriftError'
    this.differences = sorted.slice(0, MAX_REPORTED_DIFFERENCES)
    this.totalDifferences = sorted.length
  }
}

export interface ExpectedMigration {
  index: number
  folderMillis: number
  hash: string
  tag: string
}

interface JournalFile {
  entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>
}

/** Reads the same SQL bytes as Drizzle and cross-checks journal identity. */
export function readExpectedMigrationChain(migrationsFolder: string): ExpectedMigration[] {
  const folder = resolve(migrationsFolder)
  const migrations = readMigrationFiles({ migrationsFolder: folder })
  const journal = JSON.parse(
    readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as JournalFile
  if (!Array.isArray(journal.entries) || journal.entries.length !== migrations.length) {
    throw new Error('migration journal does not match the migration file chain')
  }
  return migrations.map((migration, index) => {
    const entry = journal.entries[index]
    if (
      entry === undefined ||
      entry.idx !== index ||
      entry.when !== migration.folderMillis ||
      typeof entry.tag !== 'string' ||
      entry.tag.length === 0
    ) {
      throw new Error(`migration journal entry ${index} does not match its SQL file`)
    }
    return {
      index,
      folderMillis: migration.folderMillis,
      hash: migration.hash,
      tag: entry.tag,
    }
  })
}

interface ActualMigration {
  id: unknown
  hash: unknown
  created_at: unknown
}

function actualMigrationRows(sqlite: Database): ActualMigration[] {
  const receiptTable = sqlite
    .query(
      "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='__drizzle_migrations'",
    )
    .get()
  if (receiptTable === null) return []
  return sqlite
    .query('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, id ASC')
    .all() as ActualMigration[]
}

/** Preflight accepts an exact prefix; postflight requires the complete chain. */
export function assertMigrationHistory(
  sqlite: Database,
  input: {
    dbPath: string
    expected: readonly ExpectedMigration[]
    stage: Extract<SchemaDriftStage, 'migration-history-preflight' | 'migration-history-postflight'>
    allowPrefix: boolean
  },
): void {
  const actual = actualMigrationRows(sqlite)
  const differences: SchemaDifference[] = []
  const sharedLength = Math.min(actual.length, input.expected.length)

  for (let index = 0; index < sharedLength; index += 1) {
    const expected = input.expected[index]!
    const receipt = actual[index]!
    const actualWhen = normalizeReceiptWhen(receipt.created_at)
    const actualHash = typeof receipt.hash === 'string' ? receipt.hash : String(receipt.hash)
    if (actualWhen !== String(expected.folderMillis)) {
      differences.push({
        kind: 'migration-order',
        tag: expected.tag,
        expectedWhen: expected.folderMillis,
        actualWhen,
      })
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(actualHash) || !migrationHashMatches(expected, actualHash)) {
      differences.push({
        kind: 'migration-hash',
        tag: expected.tag,
        expectedHash: expected.hash,
        actualHash,
      })
    }
  }

  for (let index = input.expected.length; index < actual.length; index += 1) {
    const receipt = actual[index]!
    differences.push({
      kind: 'migration-extra',
      tag: `receipt-${String(receipt.id)}`,
      actualWhen: normalizeReceiptWhen(receipt.created_at),
    })
  }
  if (!input.allowPrefix) {
    for (let index = actual.length; index < input.expected.length; index += 1) {
      const expected = input.expected[index]!
      differences.push({
        kind: 'migration-missing',
        tag: expected.tag,
        expectedWhen: expected.folderMillis,
      })
    }
  }
  if (differences.length > 0) {
    throw new DbSchemaDriftError(input.dbPath, input.stage, differences)
  }
}

function migrationHashMatches(expected: ExpectedMigration, actualHash: string): boolean {
  return (
    actualHash === expected.hash ||
    LEGACY_MIGRATION_HASHES[expected.tag]?.includes(actualHash) === true
  )
}

function normalizeReceiptWhen(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return String(Number(value))
  return `<invalid:${typeof value}>`
}

interface SchemaObject {
  type: string
  name: string
  tableName: string
  sql: string
}

interface ColumnShape {
  cid: number
  name: string
  type: string
  notnull: number
  defaultValue: unknown
  pk: number
  hidden: number
}

interface ForeignKeyShape {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  onUpdate: string
  onDelete: string
  match: string
}

interface IndexShape {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
  columns: Array<{
    seqno: number
    cid: number
    name: string | null
    desc: number
    coll: string | null
    key: number
  }>
}

export interface PhysicalSchemaManifest {
  objects: SchemaObject[]
  tables: Record<
    string,
    { columns: ColumnShape[]; foreignKeys: ForeignKeyShape[]; indexes: IndexShape[] }
  >
}

// Replaying the full migration chain is deliberately stronger than comparing
// against the TypeScript schema, but doing that work for every openDb() made
// admission dominate daemon restarts and highly parallel test runs. The
// expected manifest is a pure function of the exact ordered migration chain,
// so cache only that side; every database still has its live schema collected
// and compared on every open. The small FIFO bound avoids retaining manifests
// for an unbounded number of edited/test migration chains.
const expectedPhysicalSchemaCache = new Map<string, PhysicalSchemaManifest>()

function expectedPhysicalSchemaCacheKey(expected: readonly ExpectedMigration[]): string {
  return JSON.stringify(
    expected.map((migration) => [
      migration.index,
      migration.folderMillis,
      migration.hash,
      migration.tag,
    ]),
  )
}

function expectedPhysicalSchemaManifest(
  migrationsFolder: string,
  expectedMigrations: readonly ExpectedMigration[],
): PhysicalSchemaManifest {
  const cacheKey = expectedPhysicalSchemaCacheKey(expectedMigrations)
  const cached = expectedPhysicalSchemaCache.get(cacheKey)
  if (cached !== undefined) return cached

  const reference = new Database(':memory:')
  let manifest: PhysicalSchemaManifest
  try {
    reference.exec('PRAGMA foreign_keys = OFF;')
    migrateSqlite(reference, { migrationsFolder: resolve(migrationsFolder) })
    reference.exec('PRAGMA foreign_keys = ON;')
    manifest = collectPhysicalSchemaManifest(reference)
  } finally {
    reference.close()
  }

  if (expectedPhysicalSchemaCache.size >= MAX_EXPECTED_PHYSICAL_SCHEMA_CACHE_ENTRIES) {
    const oldest = expectedPhysicalSchemaCache.keys().next().value
    if (oldest !== undefined) expectedPhysicalSchemaCache.delete(oldest)
  }
  expectedPhysicalSchemaCache.set(cacheKey, manifest)
  return manifest
}

/** Collects metadata only; no table rows, counts or WAL/page state are read. */
export function collectPhysicalSchemaManifest(sqlite: Database): PhysicalSchemaManifest {
  const objectRows = sqlite
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  const objects = objectRows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: normalizeSchemaSql(row.sql),
  }))
  // SQLite identifiers are data. A null-prototype dictionary keeps legal
  // names such as "__proto__" from mutating the collector's object prototype.
  const tables: PhysicalSchemaManifest['tables'] = Object.create(
    null,
  ) as PhysicalSchemaManifest['tables']
  for (const object of objects) {
    if (object.type !== 'table') continue
    const quoted = quoteSqliteIdentifier(object.name)
    const columns = (
      sqlite.query(`PRAGMA table_xinfo(${quoted})`).all() as Array<{
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: unknown
        pk: number
        hidden: number
      }>
    )
      .map((column) => ({
        cid: column.cid,
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        defaultValue: column.dflt_value,
        pk: column.pk,
        hidden: column.hidden,
      }))
      .sort((left, right) => left.cid - right.cid || left.name.localeCompare(right.name))
    const foreignKeys = (
      sqlite.query(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        to: string | null
        on_update: string
        on_delete: string
        match: string
      }>
    )
      .map((foreignKey) => ({
        id: foreignKey.id,
        seq: foreignKey.seq,
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
        match: foreignKey.match,
      }))
      .sort((left, right) => left.id - right.id || left.seq - right.seq)
    const indexes = (
      sqlite.query(`PRAGMA index_list(${quoted})`).all() as Array<{
        seq: number
        name: string
        unique: number
        origin: string
        partial: number
      }>
    )
      .map((index) => {
        const indexQuoted = quoteSqliteIdentifier(index.name)
        const columns = (
          sqlite.query(`PRAGMA index_xinfo(${indexQuoted})`).all() as Array<{
            seqno: number
            cid: number
            name: string | null
            desc: number
            coll: string | null
            key: number
          }>
        )
          .map((column) => ({
            seqno: column.seqno,
            cid: column.cid,
            name: column.name,
            desc: column.desc,
            coll: column.coll,
            key: column.key,
          }))
          .sort((left, right) => left.seqno - right.seqno)
        return { ...index, columns }
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    tables[object.name] = { columns, foreignKeys, indexes }
  }
  return { objects, tables }
}

/** Full replay is the canonical schema for the exact migration bytes in this binary. */
export function assertPhysicalSchema(
  sqlite: Database,
  input: {
    dbPath: string
    migrationsFolder: string
    expectedMigrations: readonly ExpectedMigration[]
  },
): void {
  const expected = expectedPhysicalSchemaManifest(input.migrationsFolder, input.expectedMigrations)
  const actual = collectPhysicalSchemaManifest(sqlite)
  const differences = diffPhysicalSchema(expected, actual)
  if (differences.length > 0) {
    throw new DbSchemaDriftError(input.dbPath, 'physical-schema', differences)
  }
}

export function diffPhysicalSchema(
  expected: PhysicalSchemaManifest,
  actual: PhysicalSchemaManifest,
): SchemaDifference[] {
  const differences: SchemaDifference[] = []
  const expectedObjects = new Map(expected.objects.map((object) => [objectKey(object), object]))
  const actualObjects = new Map(actual.objects.map((object) => [objectKey(object), object]))
  for (const [key, object] of expectedObjects) {
    if (!actualObjects.has(key)) {
      differences.push({ kind: 'object-missing', objectType: object.type, name: object.name })
    }
  }
  for (const [key, object] of actualObjects) {
    if (!expectedObjects.has(key)) {
      differences.push({ kind: 'object-extra', objectType: object.type, name: object.name })
    }
  }
  for (const [key, expectedObject] of expectedObjects) {
    const actualObject = actualObjects.get(key)
    if (actualObject === undefined) continue
    if (expectedObject.type !== 'table') {
      if (expectedObject.sql !== actualObject.sql) {
        differences.push({
          kind: 'object-changed',
          objectType: expectedObject.type,
          name: expectedObject.name,
        })
      }
      continue
    }
    const before = differences.length
    diffTable(
      expectedObject.name,
      expected.tables[expectedObject.name],
      actual.tables[actualObject.name],
      differences,
    )
    if (before === differences.length && expectedObject.sql !== actualObject.sql) {
      differences.push({
        kind: 'object-changed',
        objectType: 'table',
        name: expectedObject.name,
      })
    }
  }
  return differences
}

function diffTable(
  table: string,
  expected: PhysicalSchemaManifest['tables'][string] | undefined,
  actual: PhysicalSchemaManifest['tables'][string] | undefined,
  differences: SchemaDifference[],
): void {
  if (expected === undefined || actual === undefined) return
  const expectedColumns = new Map(expected.columns.map((column) => [column.name, column]))
  const actualColumns = new Map(actual.columns.map((column) => [column.name, column]))
  for (const [name, column] of expectedColumns) {
    const other = actualColumns.get(name)
    if (other === undefined) differences.push({ kind: 'column-missing', table, column: name })
    else if (JSON.stringify(column) !== JSON.stringify(other)) {
      differences.push({ kind: 'column-changed', table, column: name })
    }
  }
  for (const name of actualColumns.keys()) {
    if (!expectedColumns.has(name)) differences.push({ kind: 'column-extra', table, column: name })
  }

  const expectedForeignKeys = new Map(
    expected.foreignKeys.map((foreignKey) => [foreignKeyKey(foreignKey), foreignKey]),
  )
  const actualForeignKeys = new Map(
    actual.foreignKeys.map((foreignKey) => [foreignKeyKey(foreignKey), foreignKey]),
  )
  for (const key of new Set([...expectedForeignKeys.keys(), ...actualForeignKeys.keys()])) {
    if (
      JSON.stringify(expectedForeignKeys.get(key)) !== JSON.stringify(actualForeignKeys.get(key))
    ) {
      differences.push({ kind: 'foreign-key-changed', table, name: key })
    }
  }

  const expectedIndexes = new Map(expected.indexes.map((index) => [index.name, index]))
  const actualIndexes = new Map(actual.indexes.map((index) => [index.name, index]))
  for (const name of new Set([...expectedIndexes.keys(), ...actualIndexes.keys()])) {
    if (JSON.stringify(expectedIndexes.get(name)) !== JSON.stringify(actualIndexes.get(name))) {
      differences.push({ kind: 'index-changed', table, name })
    }
  }
}

function normalizeSchemaSql(value: string | null): string {
  if (value === null) return ''
  return value
    .trim()
    .replace(/`([^`]*)`/g, '"$1"')
    .replace(/\[([^\]]+)\]/g, '"$1"')
    .replace(/\s+/g, ' ')
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function objectKey(object: Pick<SchemaObject, 'type' | 'name'>): string {
  return `${object.type}\u0000${object.name}`
}

function foreignKeyKey(foreignKey: ForeignKeyShape): string {
  return `${foreignKey.id}:${foreignKey.seq}:${foreignKey.from}:${foreignKey.to ?? ''}`
}

function differenceSortKey(difference: SchemaDifference): string {
  if ('tag' in difference) {
    return `${difference.kind}\u0000${difference.tag}`
  }
  if ('objectType' in difference) {
    return `${difference.kind}\u0000${difference.objectType}\u0000${difference.name}`
  }
  if ('table' in difference) {
    return `${difference.kind}\u0000${difference.table}\u0000${
      'column' in difference ? difference.column : difference.name
    }`
  }
  return ''
}

export function formatSchemaDifference(difference: SchemaDifference): string {
  switch (difference.kind) {
    case 'migration-missing':
      return `missing migration receipt ${difference.tag}`
    case 'migration-extra':
      return `unexpected migration receipt ${difference.tag} at ${difference.actualWhen}`
    case 'migration-hash':
      return `migration ${difference.tag} hash differs (${difference.actualHash.slice(0, 12)} != ${difference.expectedHash.slice(0, 12)})`
    case 'migration-order':
      return `migration ${difference.tag} expected timestamp ${difference.expectedWhen}, found ${difference.actualWhen}`
    case 'object-missing':
      return `missing ${difference.objectType} ${difference.name}`
    case 'object-extra':
      return `unexpected ${difference.objectType} ${difference.name}`
    case 'object-changed':
      return `${difference.objectType} ${difference.name} definition differs`
    case 'column-missing':
      return `missing column ${difference.table}.${difference.column}`
    case 'column-extra':
      return `unexpected column ${difference.table}.${difference.column}`
    case 'column-changed':
      return `column ${difference.table}.${difference.column} definition differs`
    case 'foreign-key-changed':
      return `foreign key ${difference.table}.${difference.name} differs`
    case 'index-changed':
      return `index ${difference.table}.${difference.name} differs`
  }
}
