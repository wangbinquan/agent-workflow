// RFC-625: share complete, immutable source catalogs across one job's Bun isolates.
import { serialize, deserialize } from 'bun:jsc'
import { Database } from 'bun:sqlite'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { PostgresqlPool } from '@/platform/persistence/postgresqlRuntime'
import {
  loadFrozenEpoch1History,
  type FrozenEpoch1History,
} from '@/platform/persistence/migration/epoch1/bundle'
import { releasedPostgresqlSources } from '@/platform/persistence/migration/epoch1/releasedPostgresql'
import {
  compileEpoch1PostgresqlCatalog,
  loadSupportedSourceManifest,
  type SupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { readPostgresqlMajor } from '@/platform/persistence/schema/history/catalog'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import {
  fixtureCacheKey,
  fixtureDigest,
  fixtureFileDigest,
  materializeTestFixture,
  TEST_FIXTURE_CACHE_ENV,
  type FixtureInput,
} from './testFixtureCache'

export const SOURCE_MANIFEST_PREPARE_MS = 90_000
const kind = 'rfc395-source-manifest'
const repositoryRoot = join(import.meta.dir, '../../../..')

export interface SourceManifestRuntimeIdentity {
  bunVersion: string
  bunRevision: string
  executableDigest: string
  platform: string
  architecture: string
  sqliteVersion: string
  sqliteSourceId: string
  sqliteCompileOptions: string[]
}
export interface SourceManifestPostgresqlIdentity {
  version: number
  major: number
  encoding: string
  collation: string
  ctype: string
  settings: Record<string, string>
}
export interface SourceManifestIdentity {
  runtime: SourceManifestRuntimeIdentity
  implementationDigest: string
  releasedFiles: Record<string, string>
}
export interface SourceManifestAdmission {
  history: FrozenEpoch1History
  postgresqlMajor: number
  cacheKey?: string
}
export interface SourceManifestFixtureOptions {
  provider: DatabaseProvider
  referencePool?: PostgresqlPool
  cacheRoot?: string | null
  signal?: AbortSignal
  /** Includes admission and key hashing, not just materialization. Never exceeds beforeAll. */
  timeoutMs?: number
  /** These seams wrap the actual preparation path in lifecycle/admission regressions. */
  admitHistory?: typeof loadFrozenEpoch1History
  identity?: (signal: AbortSignal) => Promise<SourceManifestIdentity>
  build?: (
    original: () => Promise<SupportedSourceManifest>,
    admitted: SourceManifestAdmission,
    signal: AbortSignal,
  ) => Promise<SupportedSourceManifest>
}

async function sourceFiles(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)))
    else if (entry.isFile()) paths.push(path)
    else throw new Error(`Unsupported source manifest input: ${path}`)
  }
  return paths
}

/** Actual file contents, including untracked source files; never a Git/mtime identity. */
export async function sourceManifestImplementationDigest(
  root = repositoryRoot,
  signal?: AbortSignal,
): Promise<string> {
  const paths = [
    ...(await sourceFiles(join(root, 'packages/backend/src'))),
    ...(await sourceFiles(join(root, 'packages/shared/src'))),
    join(root, 'packages/backend/tests/helpers/rfc395SourceManifestFixture.ts'),
    join(root, 'packages/backend/tests/helpers/testFixtureCache.ts'),
    join(root, 'packages/backend/tests/helpers/rfc395V1Harness.ts'),
    ...[
      'package.json',
      'packages/backend/package.json',
      'packages/shared/package.json',
      'bun.lock',
      'tsconfig.base.json',
      'packages/backend/tsconfig.json',
      'packages/shared/tsconfig.json',
    ].map((path) => join(root, path)),
  ].sort()
  const entries: [string, string][] = []
  // Bound open files, and yield between groups so the whole-prepare deadline remains observable.
  for (let offset = 0; offset < paths.length; offset += 16) {
    signal?.throwIfAborted()
    entries.push(
      ...(await Promise.all(
        paths
          .slice(offset, offset + 16)
          .map(
            async (path): Promise<[string, string]> => [
              relative(root, path).replaceAll('\\', '/'),
              await fixtureFileDigest(path),
            ],
          ),
      )),
    )
  }
  signal?.throwIfAborted()
  return fixtureDigest(JSON.stringify(entries))
}

let runtimeIdentity: Promise<SourceManifestRuntimeIdentity> | undefined
function sourceManifestRuntimeIdentity(): Promise<SourceManifestRuntimeIdentity> {
  return (runtimeIdentity ??= (async () => {
    const probe = new Database(':memory:')
    try {
      const row = probe
        .query<
          { version: string; source: string },
          []
        >('SELECT sqlite_version() AS version, sqlite_source_id() AS source')
        .get()!
      return {
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        executableDigest: await fixtureFileDigest(process.execPath),
        platform: process.platform,
        architecture: process.arch,
        sqliteVersion: row.version,
        sqliteSourceId: row.source,
        sqliteCompileOptions: probe
          .query<Record<string, string>, []>('PRAGMA compile_options')
          .all()
          .map((value) => Object.values(value)[0]!)
          .sort(),
      }
    } finally {
      probe.close()
    }
  })().catch((error: unknown) => {
    runtimeIdentity = undefined
    throw error
  }))
}

async function sourceManifestIdentity(signal: AbortSignal): Promise<SourceManifestIdentity> {
  const directory = join(
    repositoryRoot,
    'packages/backend/src/platform/persistence/migration/epoch1/released-postgresql',
  )
  const releasedFiles: Record<string, string> = {}
  for (const release of releasedPostgresqlSources)
    for (const name of [
      'contract.json',
      'plan.json',
      'sqlite-receipts.json',
      'catalog.json',
      'provenance.json',
    ]) {
      signal.throwIfAborted()
      releasedFiles[`${release.tag}/${name}`] = await fixtureFileDigest(
        join(directory, release.tag, name),
      )
    }
  // Only engine identity is memoized. Source/released bytes are read on each preparation.
  return {
    runtime: await sourceManifestRuntimeIdentity(),
    implementationDigest: await sourceManifestImplementationDigest(repositoryRoot, signal),
    releasedFiles,
  }
}

async function postgresqlIdentity(
  pool: PostgresqlPool,
  signal: AbortSignal,
): Promise<SourceManifestPostgresqlIdentity> {
  const connection = await pool.reserve({ signal })
  try {
    signal.throwIfAborted()
    // The original compiler uses PL/pgSQL DO blocks. Register its lazy pg_settings
    // before sampling the key, so its first execution cannot change that key.
    await connection.unsafe('DO $rfc625$ BEGIN NULL; END $rfc625$ LANGUAGE plpgsql')
    signal.throwIfAborted()
    const rows = await connection.unsafe(
      `SELECT current_setting('server_version_num') AS version,
            current_setting('server_encoding') AS encoding,
            datcollate AS collation, datctype AS ctype
       FROM pg_database WHERE datname = current_database()`,
    )
    signal.throwIfAborted()
    // The fixture assigns a random application_name for cancellation ownership. It does not
    // change DDL/catalog output; retain every other setting, including SQL parser options.
    const settingsRows = await connection.unsafe(
      "SELECT name, setting FROM pg_settings WHERE name <> 'application_name' ORDER BY name",
    )
    signal.throwIfAborted()
    const row = rows[0]
    const version = Number(row?.version)
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(version) ||
      version < 100000 ||
      typeof row?.encoding !== 'string' ||
      typeof row.collation !== 'string' ||
      typeof row.ctype !== 'string' ||
      !settingsRows.length ||
      settingsRows.some(
        (setting) => typeof setting.name !== 'string' || typeof setting.setting !== 'string',
      )
    )
      throw new Error('Invalid PostgreSQL source manifest environment')
    return {
      version,
      major: Math.floor(version / 10000),
      encoding: row.encoding,
      collation: row.collation,
      ctype: row.ctype,
      settings: Object.fromEntries(
        settingsRows.map((setting) => [String(setting.name), String(setting.setting)]),
      ),
    }
  } finally {
    connection.release()
  }
}

export function sourceManifestCacheInputs(
  provider: DatabaseProvider,
  history: FrozenEpoch1History,
  identity: SourceManifestIdentity,
  postgresql: SourceManifestPostgresqlIdentity | null,
): FixtureInput {
  if ((provider === 'postgresql') !== (postgresql !== null))
    throw new Error('Source manifest provider identity mismatch')
  return {
    format: 'bun-jsc-v1',
    provider,
    chainDigest: history.chainDigest,
    headDigest: history.postgresql.head.contract.digest,
    versions: history.postgresql.versions.map((version) => ({
      plan: version.plan.digest,
      contract: version.contract.digest,
      sqliteThrough: version.sqliteMigrations.length,
    })),
    // Include actual parsed SQL and its order, not only the hash recorded in the journal.
    sqliteInputDigest: fixtureDigest(
      JSON.stringify({ tags: history.sqliteTags, migrations: history.sqlite }),
    ),
    released: releasedPostgresqlSources.map((release) => ({
      tag: release.tag,
      contract: release.contract.digest,
      plan: release.plan.digest,
      sqliteThrough: release.sqliteMigrations.length,
    })),
    identity: {
      runtime: { ...identity.runtime },
      implementationDigest: identity.implementationDigest,
      releasedFiles: { ...identity.releasedFiles },
    },
    postgresql: postgresql ? { ...postgresql } : null,
  }
}

function plainData(value: unknown, seen = new Set<object>()): void {
  if (value === null || value === undefined || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new Error('Source manifest must contain only plain data')
  if (seen.has(value)) return
  seen.add(value)
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Source manifest must contain only plain data')
  for (const child of Object.values(value)) plainData(child, seen)
}

function validateManifest(
  value: unknown,
  provider: DatabaseProvider,
  history: FrozenEpoch1History,
  major: number,
): asserts value is SupportedSourceManifest {
  plainData(value)
  const manifest = value as SupportedSourceManifest | null
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.chainDigest !== history.chainDigest ||
    manifest.headDigest !== history.postgresql.head.contract.digest ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.codecCorrections) ||
    !manifest.sqliteJournalAliases ||
    typeof manifest.sqliteJournalAliases !== 'object'
  )
    throw new Error('Source manifest identity or shape mismatch')
  const expected = history.sqliteTags.flatMap((tag) => [
    `sqlite:${tag}`,
    ...(tag === '0141_rfc271_resource_bundle_applies' ? [`sqlite:${tag}:observed-rfc278`] : []),
  ])
  if (provider === 'postgresql') {
    expected.push(
      ...releasedPostgresqlSources.map((release) => `postgresql:released:${release.tag}`),
    )
    for (let version = 0; version < history.postgresql.versions.length; version++)
      for (let baseline = 0; baseline <= version; baseline++)
        expected.push(`postgresql:${version}:baseline:${baseline}`)
  }
  if (
    manifest.sources.length !== expected.length ||
    manifest.sources.some((source, index) => source?.id !== expected[index])
  )
    throw new Error('Source manifest population or order mismatch')
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  const catalogs = new Set<object>()
  for (const source of manifest.sources) {
    if (
      source.provider !== (source.id.startsWith('sqlite:') ? 'sqlite' : 'postgresql') ||
      (source.provider === 'postgresql' && source.postgresqlMajor !== major) ||
      !Number.isSafeInteger(source.sqliteThrough) ||
      source.sqliteThrough < 1 ||
      (source.postgresqlVersion !== null && !Number.isSafeInteger(source.postgresqlVersion)) ||
      !['frozen-codec', 'upgrade-only', 'logical-bridge'].includes(source.readMode) ||
      !strings(source.expectedAbsent) ||
      !strings(source.archivedTables) ||
      !Array.isArray(source.catalog) ||
      !Array.isArray(source.journal) ||
      (source.contract !== null &&
        (!source.contract ||
          typeof source.contract.digest !== 'string' ||
          !Array.isArray(source.contract.tables)))
    )
      throw new Error('Source manifest source shape mismatch')
    if (!catalogs.has(source.catalog)) {
      catalogs.add(source.catalog)
      if (
        source.catalog.some(
          (entry: SupportedSourceManifest['sources'][number]['catalog'][number]) =>
            ['kind', 'relation', 'name', 'definition'].some(
              (field) => typeof entry?.[field as keyof typeof entry] !== 'string',
            ),
        )
      )
        throw new Error('Source manifest catalog shape mismatch')
    }
    if (
      source.journal.some(
        (entry: SupportedSourceManifest['sources'][number]['journal'][number]) =>
          typeof entry?.identity !== 'string' ||
          typeof entry.digest !== 'string' ||
          (entry.planDigest !== undefined && typeof entry.planDigest !== 'string'),
      )
    )
      throw new Error('Source manifest journal shape mismatch')
  }
  if (Object.values(manifest.sqliteJournalAliases).some((aliases) => !strings(aliases)))
    throw new Error('Source manifest journal aliases shape mismatch')
}

export async function prepareRfc395SourceManifest(
  options: SourceManifestFixtureOptions,
): Promise<SupportedSourceManifest> {
  const started = performance.now()
  const timeoutMs = options.timeoutMs ?? SOURCE_MANIFEST_PREPARE_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SOURCE_MANIFEST_PREPARE_MS)
    throw new Error('Source manifest preparation must fit the 90s beforeAll budget')
  const deadline = started + timeoutMs
  const controller = new AbortController()
  const expired = () => controller.abort(new Error('Source manifest preparation deadline exceeded'))
  const abort = () => controller.abort(options.signal!.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(expired, timeoutMs)
  const signal = controller.signal
  const checkpoint = () => {
    if (performance.now() >= deadline) expired()
    signal.throwIfAborted()
  }
  let destination: string | undefined
  let state = 'disabled'
  let admissionMs = 0
  let identityMs = 0
  let deserializeMs = 0
  let bytes = 0
  try {
    checkpoint()
    // Keep the original admission before every preparation, including artifact hits.
    const history = await (options.admitHistory ?? loadFrozenEpoch1History)()
    checkpoint()
    admissionMs = performance.now() - started
    const root =
      options.cacheRoot === undefined ? process.env[TEST_FIXTURE_CACHE_ENV] : options.cacheRoot
    if (options.provider === 'postgresql' && !options.referencePool)
      throw new Error('PostgreSQL source manifest requires its owned reference pool')
    const pg =
      root && options.provider === 'postgresql'
        ? await postgresqlIdentity(options.referencePool!, signal)
        : null
    const major =
      pg?.major ??
      (options.provider === 'postgresql'
        ? await readPostgresqlMajor(postgresqlHistoryConnection(options.referencePool!))
        : 0)
    checkpoint()
    const original = async () => {
      checkpoint()
      const result = await loadSupportedSourceManifest(
        options.provider === 'sqlite'
          ? {}
          : {
              async postgresqlCatalog(version) {
                checkpoint()
                const connection = await options.referencePool!.reserve()
                try {
                  checkpoint()
                  const catalog = await compileEpoch1PostgresqlCatalog(connection, version)
                  checkpoint()
                  return catalog
                } finally {
                  connection.release()
                }
              },
            },
      )
      checkpoint()
      return result
    }
    const build = (cacheKey?: string) =>
      options.build
        ? options.build(original, { history, postgresqlMajor: major, cacheKey }, signal)
        : original()
    if (!root) {
      const result = await build()
      checkpoint()
      return result
    }
    const keyStarted = performance.now()
    const identity = await (options.identity ?? sourceManifestIdentity)(signal)
    checkpoint()
    const inputs = sourceManifestCacheInputs(options.provider, history, identity, pg)
    const key = fixtureCacheKey(kind, inputs)
    identityMs = performance.now() - keyStarted
    destination = await mkdtemp(join(tmpdir(), 'aw-r395-source-manifest-'))
    checkpoint()
    const materialized = await materializeTestFixture({
      kind,
      inputs,
      cacheRoot: root,
      destination: join(destination, 'manifest.bin'),
      signal,
      timeoutMs: Math.max(1, deadline - performance.now()),
      async build(path, artifactSignal) {
        const manifest = await build(key)
        checkpoint()
        artifactSignal.throwIfAborted()
        validateManifest(manifest, options.provider, history, major)
        const data = serialize(
          { version: 1, key, provider: options.provider, manifest },
          { binaryType: 'nodebuffer' },
        )
        checkpoint()
        artifactSignal.throwIfAborted()
        await writeFile(path, data)
        checkpoint()
        artifactSignal.throwIfAborted()
      },
    })
    state = materialized.cache
    checkpoint()
    const data = await readFile(materialized.path)
    bytes = data.byteLength
    checkpoint()
    const decoding = performance.now()
    const envelope = deserialize(data) as {
      version?: unknown
      key?: unknown
      provider?: unknown
      manifest?: unknown
    } | null
    if (
      !envelope ||
      envelope.version !== 1 ||
      envelope.key !== key ||
      envelope.provider !== options.provider
    )
      throw new Error('Source manifest artifact envelope mismatch')
    validateManifest(envelope.manifest, options.provider, history, major)
    deserializeMs = performance.now() - decoding
    checkpoint()
    return envelope.manifest
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (destination) await rm(destination, { recursive: true, force: true })
    console.info(
      `[fixture-cache] source-manifest provider=${options.provider} ${state} admission=${admissionMs.toFixed(1)}ms identity=${identityMs.toFixed(1)}ms deserialize=${deserializeMs.toFixed(1)}ms bytes=${bytes} total=${(performance.now() - started).toFixed(1)}ms`,
    )
  }
}
