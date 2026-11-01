/** Offline data preparation only. No imports of the daemon, converter or test harness. */
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { canonical, FIXTURES, REPO_ROOT, sha256 } from './io'
import type { Json, ReleaseEntry, ReleaseRegistry, Row, SqliteReceipt } from './model'
import type {
  BuildCoverage,
  CoverageExemption,
  CoverageLedger,
  RecordedSeedDataset,
  SeedFile,
} from './seed-model'
import { installEpoch2Fixture } from './seed-epoch2'

export const SEEDS = join(FIXTURES, 'seeds')
/** The generated coverage report and the historical draft are never approval authorities. */
export function readApprovedExemptions(fixtures = FIXTURES): CoverageExemption[] {
  const file = JSON.parse(readFileSync(join(fixtures, 'exemptions.json'), 'utf8')) as {
    formatVersion: number
    entries: CoverageExemption[]
  }
  if (file.formatVersion !== 1 || !Array.isArray(file.entries))
    throw new Error('Invalid approved exemptions file')
  const seen = new Set<string>()
  for (const entry of file.entries) {
    const key = `${entry.build}/${entry.table}`
    if (
      entry.status !== 'approved' ||
      entry.approvedBy !== 'user' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.approvedAt ?? '') ||
      !entry.build ||
      canonical(entry.buildKeys) !== canonical([entry.build]) ||
      !entry.reason.trim() ||
      !entry.evidence.length ||
      !['migration-metadata', 'retired-never-written'].includes(entry.category) ||
      seen.has(key)
    )
      throw new Error(`Invalid approved exemption: ${key}`)
    seen.add(key)
  }
  return file.entries
}
/** Optional callers may restrict an approval set, never authorize new entries. */
function approvedFor(fixtures = FIXTURES, requested?: CoverageExemption[]): CoverageExemption[] {
  const approved = existsSync(join(fixtures, 'exemptions.json'))
    ? readApprovedExemptions(fixtures)
    : []
  return requested === undefined
    ? approved
    : approved.filter((entry) =>
        requested.some((candidate) => canonical(candidate) === canonical(entry)),
      )
}
export const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
export interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}
export function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => name)
}
export function columns(db: Database, table: string): ColumnInfo[] {
  return db.query<ColumnInfo, []>(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
}

export function migrationSql(
  release: ReleaseEntry,
  receipt: SqliteReceipt,
  fixtures = FIXTURES,
): string {
  const replacement = release.releasedSql.find(
    (entry) => entry.provider === 'sqlite' && entry.migration === receipt.tag,
  )
  const path = replacement
    ? join(fixtures, replacement.file)
    : join(REPO_ROOT, 'packages/backend/db/migrations', `${receipt.tag}.sql`)
  const bytes = readFileSync(path)
  if (sha256(bytes) !== receipt.hash || (replacement && replacement.sha256 !== receipt.hash))
    throw new Error(`SQL receipt mismatch: ${release.tag}/${receipt.tag} (${path})`)
  return bytes.toString('utf8')
}

/** Bun 1.4.3 supports the original ordered JSON aggregates; use exact released SQL. */
export function applySqliteReceipt(db: Database, sql: string, receipt: SqliteReceipt): void {
  for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
  db.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
    receipt.hash,
    receipt.created_at,
  )
}

export function createJournal(db: Database): void {
  db.exec(
    'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
}

export function sqliteValue(value: Json, home: string): SQLQueryBindings {
  if (value === null) return null
  if (typeof value === 'string') {
    if (!value.includes('<AW_HOME>')) return value
    // Substitute inside JSON string literals without reserializing the payload.
    // A fixture home containing quotes/backslashes must not corrupt stored JSON.
    try {
      JSON.parse(value)
      return value.replaceAll('<AW_HOME>', JSON.stringify(home).slice(1, -1))
    } catch {
      return value.replaceAll('<AW_HOME>', home)
    }
  }
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('Use a tagged bigint for an unsafe integer')
    return value
  }
  if (Array.isArray(value)) throw new Error('JSON database columns must contain raw JSON text')
  const keys = Object.keys(value)
  if (keys.length !== 1) throw new Error('Expected one canonical value tag')
  if (typeof value.$bytes === 'string') {
    const bytes = Buffer.from(value.$bytes, 'base64')
    if (bytes.toString('base64') !== value.$bytes) throw new Error('Non-canonical base64 bytes')
    return bytes
  }
  if (typeof value.$bigint === 'string' && /^-?\d+$/.test(value.$bigint))
    return BigInt(value.$bigint)
  if (typeof value.$timestamp === 'string') {
    const time = Date.parse(value.$timestamp)
    if (Number.isFinite(time)) return time
  }
  if (typeof value.$number === 'string' && ['Infinity', '-Infinity'].includes(value.$number))
    return Number(value.$number)
  throw new Error(`Unsupported logical value ${canonical(value)}`)
}

export function readSeed(path: string, epoch: 1 | 2, after: string): SeedFile {
  const seed = JSON.parse(readFileSync(path, 'utf8')) as SeedFile
  if (seed.formatVersion !== 1 || seed.epoch !== epoch || seed.after !== after)
    throw new Error(`Wrong seed identity: ${path}`)
  if (!Array.isArray(seed.rows) || !seed.provenance?.sources.length)
    throw new Error(`Missing seed rows or provenance: ${path}`)
  if (seed.provenance.kind === 'derived-draft')
    throw new Error(`Review and curate derived draft before use: ${path}`)
  return seed
}

export function insertSeed(db: Database, seed: SeedFile, home: string): void {
  for (const [index, row] of seed.rows.entries()) {
    try {
      const allowed = new Set(columns(db, row.table).map(({ name }) => name))
      if (!allowed.size) throw new Error(`Table does not exist: ${row.table}`)
      const names = Object.keys(row.values)
      if (!names.length) throw new Error('An explicit row is required')
      for (const name of names)
        if (!allowed.has(name)) throw new Error(`Column does not exist: ${row.table}.${name}`)
      db.query(
        `INSERT INTO ${quoteIdentifier(row.table)} (${names.map(quoteIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      ).run(...names.map((name) => sqliteValue(row.values[name]!, home)))
    } catch (error) {
      throw new Error(`${seed.after} row ${index} (${row.table}): ${String(error)}`)
    }
  }
  materializeSeedContent(seed, home)
}

export function materializeSeedContent(seed: SeedFile, home: string): void {
  for (const content of seed.content ?? []) {
    const path = resolve(home, content.path)
    if (!path.startsWith(`${resolve(home)}${sep}`)) throw new Error('Content path escapes home')
    if ((content.utf8 === undefined) === (content.base64 === undefined))
      throw new Error(`Supply exactly one content encoding: ${content.path}`)
    const bytes =
      content.utf8 === undefined
        ? Buffer.from(content.base64!, 'base64')
        : Buffer.from(content.utf8, 'utf8')
    if (sha256(bytes) !== content.sha256) throw new Error(`Content hash mismatch: ${content.path}`)
    if (existsSync(path)) {
      if (!readFileSync(path).equals(bytes)) throw new Error(`Conflicting content: ${content.path}`)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes, { flag: 'wx' })
    }
  }
}

export function installEpoch2Schema(db: Database, release: ReleaseEntry, seeds = SEEDS): void {
  installEpoch2Fixture(db, release, seeds)
}

/** Rebuild one release in a caller-owned disposable home; leaves failure DB for diagnosis. */
export function buildSeedDatabase(
  release: ReleaseEntry,
  home: string,
  options: {
    seeds?: string
    fixtures?: string
    exemptions?: CoverageExemption[]
    contentHome?: string
    beforeMigration?: (db: Database, seed: SeedFile) => () => void
  } = {},
): BuildCoverage {
  mkdirSync(home, { recursive: true })
  const path = join(home, 'db.sqlite')
  if (existsSync(path)) throw new Error(`Refusing to overwrite database: ${path}`)
  const db = new Database(path, { create: true })
  const seeds = options.seeds ?? SEEDS
  const approved = approvedFor(options.fixtures, options.exemptions)
  const report: BuildCoverage = {
    buildKey: release.buildKey,
    tags: [release.tag],
    epoch: release.epoch1 ? 1 : 2,
    tables: [],
    failures: [],
  }
  const sources = new Map<string, Set<string>>()
  const kinds = new Map<string, 'scenario' | 'curated'>()
  const remember = (table: string, source: string, kind: 'scenario' | 'curated' = 'curated') => {
    const found = sources.get(table) ?? new Set<string>()
    found.add(source)
    sources.set(table, found)
    kinds.set(table, kind)
  }
  let phase = 'schema'
  try {
    // Historical rebuild migrations intentionally disable FK enforcement. Validate
    // the complete release snapshot afterwards, including cyclic references.
    db.exec('PRAGMA foreign_keys=OFF')
    const seedAt = (epoch: 1 | 2, after: string, filename = after) => {
      phase = `seed:${after}`
      const file = join(seeds, `epoch${epoch}`, `${filename}.json`)
      if (!existsSync(file)) throw new Error(`Missing seed ledger entry: ${file}`)
      const seed = readSeed(file, epoch, after)
      insertSeed(db, seed, options.contentHome ?? home)
      for (const row of seed.rows)
        remember(
          row.table,
          `epoch${epoch}/${filename}.json`,
          seed.provenance.kind === 'scenario' ? 'scenario' : 'curated',
        )
      for (const effect of seed.migrationEffects ?? []) {
        if (effect.operation !== 'remove')
          remember(effect.table, `epoch${epoch}/${filename}.json#${effect.operation}`)
      }
    }
    if (release.epoch1) {
      createJournal(db)
      remember('__drizzle_migrations', 'releases.json#epoch1.sqlite')
      for (const receipt of release.epoch1.sqlite) {
        phase = `migration:${receipt.tag}`
        // One offline transaction per receipt and its seed. A failed insert cannot
        // leave a receipt claiming that a partially seeded migration succeeded.
        db.exec('PRAGMA foreign_keys=OFF')
        db.exec('BEGIN')
        try {
          const checkEffect = options.beforeMigration?.(
            db,
            readSeed(join(seeds, 'epoch1', `${receipt.tag}.json`), 1, receipt.tag),
          )
          applySqliteReceipt(db, migrationSql(release, receipt, options.fixtures), receipt)
          checkEffect?.()
          seedAt(1, receipt.tag)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }
      phase = 'receipts'
      const actual = db
        .query('SELECT hash,created_at FROM __drizzle_migrations ORDER BY rowid')
        .all()
      const expected = release.epoch1.sqlite.map(({ hash, created_at }) => ({ hash, created_at }))
      if (canonical(actual) !== canonical(expected)) throw new Error('Receipt sequence mismatch')
    } else if (release.epoch2) {
      installEpoch2Schema(db, release, seeds)
      for (const table of [
        '__drizzle_migrations',
        'aw_meta_generations',
        'aw_meta_first_write',
        'aw_meta_schema_history',
      ])
        remember(table, 'epoch2/metadata-0000.json#native-installation-receipts')
      seedAt(2, release.epoch2.history, String(release.epoch2.version).padStart(4, '0'))
    } else throw new Error(`Release has neither epoch: ${release.tag}`)
    phase = 'integrity'
    const foreignKeys = db.query('PRAGMA foreign_key_check').all()
    if (foreignKeys.length) throw new Error(`Foreign key violations: ${canonical(foreignKeys)}`)
    const quick = db.query('PRAGMA quick_check').all()
    if (canonical(quick) !== canonical([{ quick_check: 'ok' }]))
      throw new Error(`SQLite quick_check: ${canonical(quick)}`)
  } catch (error) {
    report.failures.push({ phase, detail: String(error) })
  } finally {
    for (const table of tableNames(db)) {
      if (table === 'sqlite_sequence') remember(table, 'SQLite#AUTOINCREMENT-high-water')
      const count = db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`)
        .get()!.n
      const exemption = approved.find(
        (item) =>
          item.status === 'approved' &&
          item.approvedBy === 'user' &&
          item.build === release.buildKey &&
          item.epoch === report.epoch &&
          item.table === table &&
          item.buildKeys.includes(release.buildKey),
      )
      report.tables.push({
        table,
        rows: count,
        coverage: count > 0 ? (kinds.get(table) ?? 'curated') : exemption ? 'exempt' : 'missing',
        sources: [...(sources.get(table) ?? [])].sort(),
        ...(exemption ? { exemption: exemption.id } : {}),
      })
    }
    db.close()
  }
  return report
}

export function checkSeedLedger(
  registry: ReleaseRegistry,
  options: {
    seeds?: string
    fixtures?: string
    exemptions?: CoverageExemption[]
    keep?: string
    onBuild?: (build: BuildCoverage) => void
  } = {},
): CoverageLedger {
  const approved = approvedFor(options.fixtures, options.exemptions)
  const seen = new Set<string>()
  for (const build of registry.l1Builds) {
    const representative = registry.releases.find((release) => release.tag === build.representative)
    if (!representative || !build.tags.includes(build.representative))
      throw new Error('Missing build representative')
    for (const tag of build.tags) {
      const release = registry.releases.find((item) => item.tag === tag)
      if (!release || release.buildKey !== build.buildKey || seen.has(tag))
        throw new Error(`Invalid build membership: ${tag}`)
      if (
        canonical({ epoch1: release.epoch1?.sqlite ?? null, epoch2: release.epoch2 }) !==
        canonical({ epoch1: representative.epoch1?.sqlite ?? null, epoch2: representative.epoch2 })
      )
        throw new Error(`Build aliases have different receipts: ${tag}`)
      seen.add(tag)
    }
  }
  if (seen.size !== registry.releases.length)
    throw new Error('Registry release omitted from build matrix')
  const buildKeys = new Set(registry.l1Builds.map((build) => build.buildKey))
  for (const exemption of approved) {
    if (
      !['migration-metadata', 'retired-never-written'].includes(exemption.category) ||
      exemption.status !== 'approved' ||
      !exemption.reason ||
      !exemption.evidence.length ||
      !exemption.buildKeys.length ||
      exemption.buildKeys.some((key) => !buildKeys.has(key))
    )
      throw new Error(`Invalid exact-build exemption: ${exemption.id}`)
  }
  const root = options.keep ?? mkdtempSync(join(tmpdir(), 'aw-seed-check-'))
  const builds: BuildCoverage[] = []
  try {
    for (const entry of registry.l1Builds) {
      const release = registry.releases.find((item) => item.tag === entry.representative)
      if (!release || release.buildKey !== entry.buildKey) throw new Error('Invalid build mapping')
      const report = buildSeedDatabase(release, join(root, entry.representative), options)
      report.tags = entry.tags
      builds.push(report)
      options.onBuild?.(report)
    }
  } finally {
    if (!options.keep) rmSync(root, { recursive: true, force: true })
  }
  return {
    formatVersion: 1,
    evidence: 'receipt-and-seed-sqlite-reconstruction',
    exemptions: approved,
    builds,
  }
}

/** Draft only: using columns at the requested receipt, never today's table shape. */
export function deriveSeed(options: {
  dataset: string
  release: ReleaseEntry
  migration: string
  tables?: string[]
  limit?: number
}): SeedFile {
  const manifest = JSON.parse(
    readFileSync(join(options.dataset, 'dataset.json'), 'utf8'),
  ) as RecordedSeedDataset
  if (
    manifest.formatVersion !== 1 ||
    manifest.valueEncoding !== 'json-with-tagged-bigint-bytes-timestamp-v1'
  )
    throw new Error('Unsupported recording format')
  if (!Number.isSafeInteger(options.limit ?? 3) || (options.limit ?? 3) < 1)
    throw new Error('Draft row limit must be a positive integer')
  const db = new Database(':memory:')
  let touched: string[] = []
  try {
    db.exec('PRAGMA foreign_keys=OFF')
    if (options.release.epoch1) {
      createJournal(db)
      let found = false
      for (const receipt of options.release.epoch1.sqlite) {
        const before = new Map(
          tableNames(db).map((table) => [table, canonical(columns(db, table))]),
        )
        applySqliteReceipt(db, migrationSql(options.release, receipt), receipt)
        if (receipt.tag === options.migration) {
          touched = tableNames(db).filter(
            (table) =>
              table !== '__drizzle_migrations' &&
              before.get(table) !== canonical(columns(db, table)),
          )
          found = true
          break
        }
      }
      if (!found) throw new Error(`Migration not in release: ${options.migration}`)
    } else {
      if (options.release.epoch2?.history !== options.migration)
        throw new Error('Wrong history version')
      installEpoch2Schema(db, options.release)
      touched = tableNames(db).filter(
        (table) =>
          !table.startsWith('aw_meta_') &&
          !table.startsWith('sqlite_') &&
          table !== '__drizzle_migrations',
      )
    }
    const rows: SeedFile['rows'] = []
    const selected = options.tables ?? touched
    for (const table of selected) {
      const info = columns(db, table)
      if (!info.length) throw new Error(`No table at this migration: ${table}`)
      const recorded = manifest.tables.find(
        (entry) =>
          entry.name === table && ['main', 'agent_workflow', 'public'].includes(entry.schema),
      )
      if (!recorded) continue
      const bytes = readFileSync(join(options.dataset, recorded.file))
      if (sha256(bytes) !== recorded.sha256) throw new Error(`Recording hash mismatch: ${table}`)
      const lines = bytes.toString('utf8').split('\n').filter(Boolean)
      if (lines.length !== recorded.rowCount)
        throw new Error(`Recording row count mismatch: ${table}`)
      for (const line of lines.slice(0, options.limit ?? 3)) {
        const row = JSON.parse(line) as Row
        const values = Object.fromEntries(
          info.filter(({ name }) => name in row).map(({ name }) => [name, row[name]!]),
        )
        if (!Object.keys(values).length)
          throw new Error(`Recorded row has no creation-time columns: ${table}`)
        rows.push({ table, values })
      }
    }
    return {
      formatVersion: 1,
      epoch: options.release.epoch1 ? 1 : 2,
      after: options.migration,
      provenance: {
        kind: 'derived-draft',
        sources: [
          `record:${manifest.tag}:dataset.json:sha256:${sha256(readFileSync(join(options.dataset, 'dataset.json')))}`,
        ],
        note: 'Projection only. Review era semantics, required creation-time fields, FK closure, content files and CURRENT API expectations before changing kind to curated.',
      },
      rows,
    }
  } finally {
    db.close()
  }
}
