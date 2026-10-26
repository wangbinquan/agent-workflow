// RFC-395 II-b V1: one frozen SQLite replay, every prefix, exact physical identification.
import { Database } from 'bun:sqlite'
import type { DatabaseProvider } from '../databaseProviders'
import { canonicalSchemaJson } from '../schema/canonical'
import {
  collectSqliteHistoryCatalog,
  readPostgresqlMajor,
  type HistoryCatalog,
} from '../schema/history/catalog'
import { postgresqlHistoryConnection } from '../schema/history/connection'
import type { PostgresqlReservedConnection } from '../postgresqlRuntime'
import { executePostgresqlReferenceStatements } from '../postgresql/referenceStatements'
import type { LogicalSchemaContract } from '../schema/contractTypes'
import {
  postgresqlUpgradeReceipt,
  type PostgresqlMigrationVersion,
} from './legacy/postgresqlMigrationSequence'
import {
  loadFrozenEpoch1History,
  epoch1MaintenanceInstruction,
  type FrozenEpoch1History,
} from './epoch1/bundle'
import { applyFrozenSqliteMigrations, createFrozenSqliteJournal } from './epoch1/sqliteChain'
import { LEGACY_MIGRATION_HASHES } from './epoch1/journalAliases'
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
  readonly readMode: 'frozen-codec' | 'upgrade-only'
}
export interface SupportedSourceManifest {
  readonly version: 1
  readonly chainDigest: string
  readonly headDigest: string
  readonly sources: readonly SupportedSourceContract[]
  readonly sqliteJournalAliases: Readonly<Record<string, readonly string[]>>
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
    return [...prefix.filter((entry) => !tables.has(entry.relation)), ...observed].sort((a, b) =>
      canonicalSchemaJson(a).localeCompare(canonicalSchemaJson(b)),
    )
  } finally {
    reference.close()
  }
}
function compileSqlitePrefixes(history: FrozenEpoch1History): readonly SupportedSourceContract[] {
  const cached = sqliteCatalogs.get(history.chainDigest)
  if (cached) return cached
  const database = new Database(':memory:')
  const sources: SupportedSourceContract[] = []
  // Intern unchanged entries: retain prefix arrays without duplicating catalog strings.
  const entries = new Map<string, HistoryCatalog[number]>()
  const head = history.postgresql.head.contract
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    createFrozenSqliteJournal(database)
    for (let through = 1; through <= history.sqlite.length; through += 1) {
      applyFrozenSqliteMigrations(database, [history.sqlite[through - 1]!])
      const catalog = collectSqliteHistoryCatalog(database).map((entry) => {
        const key = canonicalSchemaJson(entry)
        const shared = entries.get(key) ?? entry
        entries.set(key, shared)
        return shared
      })
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
    }
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
