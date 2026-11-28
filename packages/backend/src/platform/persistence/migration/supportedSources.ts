// RFC-395 II-b V1: one frozen SQLite replay, every prefix, exact physical identification.
import { Database } from 'bun:sqlite'
import { sortHistoryCatalog, type CatalogEntry } from '../schema/history/catalogModel'
import type { DatabaseProvider } from '../databaseProviders'
import { canonicalSchemaJson } from '../schema/canonical'
import { sqliteCatalogEntries } from '../sqlite/historyCatalog'
import {
  collectSqliteHistoryCatalog,
  readPostgresqlMajor,
  type HistoryCatalog,
} from '../schema/history/catalog'
import { postgresqlHistoryConnection } from '../schema/history/connection'
import type { PostgresqlReservedConnection } from '../postgresqlRuntime'
import { executePostgresqlReferenceStatements } from '../postgresql/referenceStatements'
import type { LogicalSchemaContract, LogicalTableContract } from '../schema/contractTypes'
import {
  postgresqlUpgradeReceipt,
  type LogicalCodecReplacement,
  type PostgresqlMigrationVersion,
} from './legacy/postgresqlMigrationSequence'
import {
  loadFrozenEpoch1History,
  epoch1MaintenanceInstruction,
  type FrozenEpoch1History,
} from './epoch1/bundle'
import { applyFrozenSqliteMigrations, createFrozenSqliteJournal } from './epoch1/sqliteChain'
import { LEGACY_MIGRATION_HASHES } from './epoch1/journalAliases'
import { releasedPostgresqlSources } from './epoch1/releasedPostgresql'
import {
  diffSourceCatalog,
  sameSourceJournal,
  collectEpoch1PostgresqlCatalog,
} from './sourceCatalog'
import {
  sourceTableDispositions,
  sourceTableCatalog,
  type EmptyTableDecision,
} from './sourceDispositions'
import {
  SourceBlockedError,
  type SourceFingerprint,
  type SourceJournalEntry,
  type SourceTableDisposition,
} from './sourceTypes'

export interface SupportedSourceContract {
  readonly id: string
  readonly provider: DatabaseProvider
  readonly contract: LogicalSchemaContract | null
  readonly catalog: HistoryCatalog
  readonly journal: readonly SourceJournalEntry[]
  readonly sqliteThrough: number
  readonly postgresqlVersion: number | null
  readonly postgresqlMajor?: number
  readonly expectedAbsent: readonly string[]
  readonly archivedTables: readonly string[]
  readonly readMode: 'frozen-codec' | 'upgrade-only' | 'logical-bridge'
}
export interface SupportedSourceManifest {
  readonly version: 1
  readonly chainDigest: string
  readonly headDigest: string
  readonly sources: readonly SupportedSourceContract[]
  readonly sqliteJournalAliases: Readonly<Record<string, readonly string[]>>
  /** Every V9 logical codec correction in the frozen history (see withLogicalCodecCorrections). */
  readonly codecCorrections: readonly LogicalCodecReplacement[]
}

/**
 * Codec corrections relabel a column whose storage type is identical before and after (V9,
 * e.g. PostgreSQL 0038 / SQLite 0262: `user_permission_grants.permission` holds plain keys such
 * as `users:presence`, never JSON). They state what every earlier release actually stored, so a
 * reader of an older contract decodes with the corrected codec. The contract and its digest stay
 * untouched: identification and history equality still compare the original contract.
 */
export function withLogicalCodecCorrections(
  table: LogicalTableContract,
  corrections: readonly LogicalCodecReplacement[],
): LogicalTableContract {
  const relevant = corrections.filter((correction) => correction.tableId === table.id)
  if (!relevant.length) return table
  return {
    ...table,
    columns: table.columns.map((column) => {
      const correction = relevant.find(
        (item) => item.column === column.name && item.before === column.logicalCodec,
      )
      return correction ? { ...column, logicalCodec: correction.after } : column
    }),
  }
}
export interface Epoch1PostgresqlCatalog {
  readonly catalog: HistoryCatalog
  readonly postgresqlMajor: number
}
/** Dedicated empty reference engine only. Catalog text is tied to its server major. */
export async function compileEpoch1PostgresqlCatalog(
  reference: PostgresqlReservedConnection,
  version: PostgresqlMigrationVersion,
): Promise<Epoch1PostgresqlCatalog> {
  await reference.unsafe('BEGIN')
  try {
    const rows = await reference.unsafe(
      "SELECT 1 FROM pg_namespace WHERE nspname IN ('agent_workflow','agent_workflow_meta')",
    )
    if (rows.length)
      throw new SourceBlockedError('epoch-1 catalog reference must be an empty database')
    await reference.unsafe('SET LOCAL search_path TO agent_workflow, public')
    await executePostgresqlReferenceStatements(
      reference,
      version.plan.statements.map((statement) => statement.sql),
    )
    const connection = postgresqlHistoryConnection(reference)
    return {
      catalog: await collectEpoch1PostgresqlCatalog(connection),
      postgresqlMajor: await readPostgresqlMajor(connection),
    }
  } finally {
    await reference.unsafe('ROLLBACK')
  }
}
const sqliteCatalogs = new Map<string, readonly SupportedSourceContract[]>()
/** BF-D28: exact RFC-278 observed DDL, including persisted inline comments.
 * Compile only a reference catalog; source repair belongs to frozen 0145 on an offline copy. */
function observed0141Catalog(prefix: HistoryCatalog): HistoryCatalog {
  const reference = new Database(':memory:')
  try {
    reference.exec(`
      CREATE TABLE recovery_events (
        id text PRIMARY KEY NOT NULL,
        task_id text,
        node_run_id text,
        actor text NOT NULL, -- 'system' or a user id
        kind text NOT NULL,  -- legacy inline event catalog
        reason text,
        before_json text,
        after_json text,
        created_at integer NOT NULL
      );
      CREATE TABLE mcp_runtime_test_create_receipts (
        mcp_id text NOT NULL,
        owner_user_id text NOT NULL,
        client_create_id text NOT NULL,
        request_digest text NOT NULL,
        session_id text NOT NULL,
        accepted_turn_id text NOT NULL,
        created_at integer NOT NULL,
        expires_at integer NOT NULL,
        PRIMARY KEY (mcp_id, owner_user_id, client_create_id)
      );
      CREATE INDEX idx_mcp_runtime_test_create_receipts_expiry
        ON mcp_runtime_test_create_receipts (expires_at);
      CREATE TABLE recent_repos (
        path text PRIMARY KEY NOT NULL,
        last_used_at integer NOT NULL,
        default_branch text
      );
    `)
    const observed = collectSqliteHistoryCatalog(reference)
    const tables = new Set(observed.map((entry) => entry.relation))
    return sortHistoryCatalog([
      ...prefix.filter((entry) => !tables.has(entry.relation)),
      ...observed,
    ])
  } finally {
    reference.close()
  }
}
/** A row of `sqlite_schema`, and whether the history catalog lists it. */
interface SqliteSchemaRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
  /** The history catalog's own filter, evaluated by SQLite: 1 when it lists the row. */
  readonly listed: number
}
/** Every schema row, in the history catalog's order. */
const SQLITE_SCHEMA_ROWS =
  "SELECT type, name, tbl_name, sql, name NOT LIKE 'sqlite_%' AS listed FROM sqlite_schema ORDER BY type, name"
/**
 * Runs one statement without `Database.query`'s statement cache. The prefix compiler applies
 * DDL after every read, and a connection holding a thousand cached statements runs that DDL
 * about ten times slower (measured: 6.9 s against 0.6 s for the frozen chain).
 */
function readOnce(database: Database, sql: string): Record<string, unknown>[] {
  const statement = database.prepare(sql)
  try {
    return statement.all() as Record<string, unknown>[]
  } finally {
    statement.finalize()
  }
}
/**
 * The catalog entries of one relation — every schema row whose `tbl_name` it is, and for a table
 * its columns, foreign keys and indexes — read exactly as `collectSqliteHistoryCatalog` reads them
 * for the whole database. Unsorted. `rows` are the relation's schema rows.
 */
function collectSqliteRelation(
  database: Database,
  rows: readonly SqliteSchemaRow[],
): CatalogEntry[] {
  return sqliteCatalogEntries(
    rows.filter((row) => row.listed),
    (sql) => readOnce(database, sql),
  )
}
/** The catalog of one prefix and what it was read from. */
interface PrefixCatalog {
  readonly catalog: HistoryCatalog
  /** Per relation (`tbl_name`): the type, name and stored SQL text of each of its schema rows. */
  readonly definitions: ReadonlyMap<string, string>
  /** No two entries compare equal: the order is the only one the collector's sort can give. */
  readonly strict: boolean
}
/**
 * The catalog after every prefix of the frozen SQLite chain. RFC-626 §3.5: the precheck that
 * refuses a database with a structure no release wrote took more than ten seconds, most of them
 * here, when every prefix was collected and normalised in full.
 *
 * Every entry the history catalog holds for a relation — its schema rows, and for a table the
 * columns, foreign keys and indexes SQLite reports — follows from the SQL text SQLite stores for
 * that relation's own schema rows (the table, its indexes, triggers and automatic indexes): a
 * change elsewhere that touches it (renaming a table it references, say) rewrites that text too.
 * So after each migration only the relations whose stored text changed are read again; every
 * other relation keeps the entries, and the very entry objects, of the prefix before.
 *
 * The result is the one `collectSqliteHistoryCatalog` gives after each prefix, entry for entry,
 * in its order, with every equal entry shared across prefixes. The collector sorts by
 * `localeCompare` of the canonical text, which may call two different texts equal; the
 * incremental order is used only while no two entries compare equal — then it is the only
 * possible order — and a prefix where two do is collected in full by the collector itself.
 * `tests/rfc626-source-catalog-prefixes.test.ts` compares every prefix with a full collection.
 *
 * `database` is an empty connection with the migration journal; `each` is told the catalog
 * after the first `through` migrations, for every prefix in turn.
 */
export function compileSqlitePrefixCatalogs(
  database: Database,
  migrations: readonly FrozenEpoch1History['sqlite'][number][],
  each: (through: number, catalog: HistoryCatalog) => void,
): void {
  // Intern unchanged entries: retain prefix arrays without duplicating catalog strings.
  const entries = new Map<string, CatalogEntry>()
  const keys = new Map<CatalogEntry, string>()
  const intern = (entry: CatalogEntry): CatalogEntry => {
    const key = canonicalSchemaJson(entry)
    const shared = entries.get(key)
    if (shared) return shared
    entries.set(key, entry)
    keys.set(entry, key)
    return entry
  }
  // The comparison `sortHistoryCatalog` sorts by.
  const order = (a: CatalogEntry, b: CatalogEntry) => keys.get(a)!.localeCompare(keys.get(b)!)
  const strictlyOrdered = (catalog: HistoryCatalog) =>
    catalog.every((entry, index) => index === 0 || order(catalog[index - 1]!, entry) < 0)
  /** The catalog when only `changed` relations differ from `previous`; null on a tie. */
  const incremental = (
    previous: PrefixCatalog,
    relations: ReadonlyMap<string, readonly SqliteSchemaRow[]>,
    changed: ReadonlySet<string>,
  ): HistoryCatalog | null => {
    if (!changed.size) return [...previous.catalog]
    const kept = previous.catalog.filter((entry) => !changed.has(entry.relation))
    const added = [...changed]
      .flatMap((name) => {
        const rows = relations.get(name)
        return rows ? collectSqliteRelation(database, rows).map(intern) : []
      })
      .sort(order)
    if (!strictlyOrdered(added)) return null
    // Each new entry goes where a binary search puts it among the kept ones. The kept entries are
    // strictly ordered, so a search that never meets an equal entry proves the whole result is.
    const catalog: CatalogEntry[] = []
    let from = 0
    for (const entry of added) {
      let low = from
      let high = kept.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const compared = order(kept[middle]!, entry)
        if (compared === 0) return null
        if (compared < 0) low = middle + 1
        else high = middle
      }
      while (from < low) catalog.push(kept[from++]!)
      catalog.push(entry)
    }
    while (from < kept.length) catalog.push(kept[from++]!)
    return catalog
  }
  let previous: PrefixCatalog = { catalog: [], definitions: new Map(), strict: true }
  for (let through = 1; through <= migrations.length; through += 1) {
    applyFrozenSqliteMigrations(database, [migrations[through - 1]!])
    const relations = new Map<string, SqliteSchemaRow[]>()
    for (const row of readOnce(database, SQLITE_SCHEMA_ROWS) as unknown as SqliteSchemaRow[]) {
      const rows = relations.get(row.tbl_name)
      if (rows) rows.push(row)
      else relations.set(row.tbl_name, [row])
    }
    const definitions = new Map(
      [...relations].map(([name, rows]) => [
        name,
        JSON.stringify(rows.map((row) => [row.type, row.name, row.sql])),
      ]),
    )
    const changed = new Set<string>()
    for (const [name, definition] of definitions)
      if (previous.definitions.get(name) !== definition) changed.add(name)
    for (const name of previous.definitions.keys()) if (!definitions.has(name)) changed.add(name)
    const quick = previous.strict ? incremental(previous, relations, changed) : null
    const catalog = quick ?? collectSqliteHistoryCatalog(database).map(intern)
    previous = { catalog, definitions, strict: quick !== null || strictlyOrdered(catalog) }
    each(through, catalog)
  }
}
function compileSqlitePrefixes(history: FrozenEpoch1History): readonly SupportedSourceContract[] {
  const cached = sqliteCatalogs.get(history.chainDigest)
  if (cached) return cached
  const database = new Database(':memory:')
  const sources: SupportedSourceContract[] = []
  const head = history.postgresql.head.contract
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    createFrozenSqliteJournal(database)
    compileSqlitePrefixCatalogs(database, history.sqlite, (through, catalog) => {
      const versionIndex = history.postgresql.versions.findIndex(
        (version) => version.sqliteMigrations.length === through,
      )
      const contract = history.postgresql.versions[versionIndex]?.contract ?? null
      const physical = catalog
        .filter((entry) => entry.kind === 'table')
        .map((entry) => entry.relation)
      const source: SupportedSourceContract = {
        id: `sqlite:${history.sqliteTags[through - 1]!}`,
        provider: 'sqlite',
        contract,
        catalog,
        journal: history.sqlite
          .slice(0, through)
          .map((entry) => ({ identity: String(entry.folderMillis), digest: entry.hash })),
        sqliteThrough: through,
        postgresqlVersion: versionIndex < 0 ? null : versionIndex,
        readMode: contract ? 'frozen-codec' : 'upgrade-only',
        expectedAbsent: head.tables
          .filter((table) => !physical.includes(table.id))
          .map((table) => table.id),
        archivedTables: physical.filter(
          (name) =>
            name !== '__drizzle_migrations' && !head.tables.some((table) => table.id === name),
        ),
      }
      sources.push(source)
      if (history.sqliteTags[through - 1] === '0141_rfc271_resource_bundle_applies')
        sources.push({
          ...source,
          id: `${source.id}:observed-rfc278`,
          catalog: observed0141Catalog(catalog),
          contract: null,
          readMode: 'upgrade-only',
          archivedTables: [
            ...source.archivedTables,
            'recent_repos',
            'mcp_runtime_test_create_receipts',
          ],
        })
    })
  } finally {
    database.close()
  }
  sqliteCatalogs.clear()
  sqliteCatalogs.set(history.chainDigest, sources)
  return sources
}
/** PG catalogs may be cached by the caller using chain digest and server major. */
export async function loadSupportedSourceManifest(
  input: {
    readonly postgresqlCatalog?: (
      version: PostgresqlMigrationVersion,
    ) => Promise<Epoch1PostgresqlCatalog>
  } = {},
): Promise<SupportedSourceManifest> {
  const history = await loadFrozenEpoch1History()
  const sources = [...compileSqlitePrefixes(history)]
  if (input.postgresqlCatalog) {
    for (const release of releasedPostgresqlSources) {
      const { catalog, postgresqlMajor } = await input.postgresqlCatalog(release)
      sources.push({
        id: `postgresql:released:${release.tag}`,
        provider: 'postgresql',
        contract: release.contract,
        catalog,
        postgresqlMajor,
        journal: [
          {
            identity: release.plan.baselineId,
            digest: release.contract.digest,
            planDigest: release.plan.digest,
          },
        ],
        sqliteThrough: release.sqliteMigrations.length,
        postgresqlVersion: null,
        readMode: 'logical-bridge',
        expectedAbsent: history.postgresql.head.contract.tables
          .filter(
            (table) =>
              !release.contract.tables.some(
                (old) => old.id === table.id && old.providerTables.postgresql,
              ),
          )
          .map((table) => table.id),
        archivedTables: release.contract.tables
          .filter(
            (table) =>
              !history.postgresql.head.contract.tables.some((head) => head.id === table.id),
          )
          .map((table) => table.id),
      })
    }
    for (const [versionIndex, version] of history.postgresql.versions.entries()) {
      const { catalog, postgresqlMajor } = await input.postgresqlCatalog(version)
      for (let baselineIndex = 0; baselineIndex <= versionIndex; baselineIndex += 1) {
        const first = history.postgresql.versions[baselineIndex]!
        const receipts = history.postgresql.steps.slice(baselineIndex, versionIndex).map((step) => {
          const receipt = postgresqlUpgradeReceipt(step)
          return {
            identity: receipt.baselineId,
            digest: receipt.contractDigest,
            planDigest: receipt.planDigest,
          }
        })
        sources.push({
          id: `postgresql:${versionIndex}:baseline:${baselineIndex}`,
          provider: 'postgresql',
          contract: version.contract,
          catalog,
          postgresqlMajor,
          journal: [
            {
              identity: first.plan.baselineId,
              digest: first.contract.digest,
              planDigest: first.plan.digest,
            },
            ...receipts,
          ],
          sqliteThrough: version.sqliteMigrations.length,
          postgresqlVersion: versionIndex,
          readMode: 'frozen-codec',
          expectedAbsent: history.postgresql.head.contract.tables
            .filter(
              (table) =>
                !version.contract.tables.some(
                  (old) => old.id === table.id && old.providerTables.postgresql,
                ),
            )
            .map((table) => table.id),
          archivedTables: version.contract.tables
            .filter(
              (table) =>
                !history.postgresql.head.contract.tables.some((head) => head.id === table.id),
            )
            .map((table) => table.id),
        })
      }
    }
  }
  return {
    version: 1,
    chainDigest: history.chainDigest,
    headDigest: history.postgresql.head.contract.digest,
    sources,
    sqliteJournalAliases: Object.fromEntries(
      history.sqlite.map((entry, index) => [
        String(entry.folderMillis),
        LEGACY_MIGRATION_HASHES[history.sqliteTags[index]!] ?? [],
      ]),
    ),
    codecCorrections: history.postgresql.steps.flatMap((step) => step.logicalCodecs ?? []),
  }
}
export function identifySource(input: {
  readonly fingerprint: SourceFingerprint
  readonly manifest: SupportedSourceManifest
  readonly emptyTables?: readonly EmptyTableDecision[]
  readonly postgresqlMajor?: number
}): {
  readonly source: SupportedSourceContract
  readonly tables: readonly SourceTableDisposition[]
} {
  if (input.fingerprint.evidence !== 'physical-catalog-and-journal')
    throw new SourceBlockedError('Physical identification requires a physical catalog and journal')
  const providerSources = input.manifest.sources.filter(
    (source) => source.provider === input.fingerprint.provider,
  )
  // Journal length only prunes comparisons; every admission still compares all receipt identities and the full catalog.
  const sameLength = providerSources.filter(
    (source) => source.journal.length === input.fingerprint.journal.length,
  )
  const candidates = sameLength.length ? sameLength : providerSources
  let nearest:
    | {
        differences: ReturnType<typeof diffSourceCatalog>
        tables: readonly SourceTableDisposition[]
      }
    | undefined
  for (const source of candidates) {
    const tables = sourceTableDispositions({
      source: input.fingerprint,
      contract: source.contract,
      knownTables: source.catalog
        .filter((row) => row.kind === 'table' || row.kind === 'relation')
        .map((row) => row.relation),
      archivedTables: source.archivedTables,
      emptyTables: input.emptyTables,
    })
    const admittedExtras = tables.filter(
      (table) =>
        table.disposition !== 'blocked' &&
        !source.catalog.some((entry) => entry.relation === table.physicalTable),
    )
    const ignored = new Set(
      admittedExtras.flatMap((table) =>
        sourceTableCatalog(input.fingerprint, table.physicalTable).map((entry) =>
          canonicalSchemaJson(entry),
        ),
      ),
    )
    const actual = input.fingerprint.catalog.filter(
      (entry) => !ignored.has(canonicalSchemaJson(entry)),
    )
    const differences = diffSourceCatalog(source.catalog, actual)
    if (
      source.postgresqlMajor !== undefined &&
      source.postgresqlMajor !== (input.postgresqlMajor ?? input.fingerprint.postgresqlMajor)
    )
      differences.push({
        path: 'postgresql.server-major',
        expected: String(source.postgresqlMajor),
        actual: String(
          input.postgresqlMajor ?? input.fingerprint.postgresqlMajor ?? 'not-captured',
        ),
      })
    const journal = input.fingerprint.journal.map((entry) => {
      const known = source.journal.find((expected) => expected.identity === entry.identity)
      return known && input.manifest.sqliteJournalAliases[entry.identity]?.includes(entry.digest)
        ? known
        : entry
    })
    if (!sameSourceJournal(source.journal, journal))
      differences.push({
        path: 'migration-journal.identities',
        expected: canonicalSchemaJson(source.journal),
        actual: canonicalSchemaJson(input.fingerprint.journal),
      })
    if (!differences.length && !tables.some((table) => table.disposition === 'blocked'))
      return { source, tables }
    if (!nearest || differences.length < nearest.differences.length)
      nearest = { differences, tables }
  }
  throw new SourceBlockedError(
    `Unknown source fingerprint. ${epoch1MaintenanceInstruction}`,
    nearest?.differences ?? [
      {
        path: 'provider',
        expected: 'supported physical catalog',
        actual: input.fingerprint.provider,
      },
    ],
    nearest?.tables,
  )
}
