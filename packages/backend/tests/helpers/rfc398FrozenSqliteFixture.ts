// RFC-615: copy an immutable, genuinely migrated epoch-1 baseline before case-specific writes.
import { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  loadFrozenEpoch1History,
  type FrozenEpoch1History,
} from '@/platform/persistence/migration/epoch1/bundle'
import {
  createFrozenSqliteJournal,
  applyFrozenSqliteMigrations,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import {
  fixtureDigest,
  fixtureFileDigest,
  materializeTestFixture,
  TEST_FIXTURE_CACHE_ENV,
  type FixtureInput,
} from './testFixtureCache'

export interface FrozenSqliteIdentity {
  bunVersion: string
  bunRevision: string
  compilerDigest: string
  platform: string
  architecture: string
  sqliteVersion: string
  sqliteSourceId: string
  compileOptions: string[]
  implementation: Record<string, string>
}

export function frozenSqliteCacheInputs(
  history: Pick<FrozenEpoch1History, 'chainDigest' | 'sqlite' | 'sqliteTags'>,
  identity: FrozenSqliteIdentity,
): FixtureInput {
  return {
    version: 1,
    identity: { ...identity },
    chainDigest: history.chainDigest,
    tags: [...history.sqliteTags],
    migrations: history.sqlite.map((migration) => ({
      sql: [...migration.sql],
      hash: migration.hash,
      folderMillis: migration.folderMillis,
      bps: migration.bps,
    })),
    configuration: { journalMode: 'WAL', foreignKeys: false, checkpoint: 'TRUNCATE' },
  }
}

function buildFrozenSqlite(path: string, history: FrozenEpoch1History, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  const database = new Database(path)
  try {
    database.exec('PRAGMA journal_mode = WAL')
    createFrozenSqliteJournal(database)
    applyFrozenSqliteMigrations(database, history.sqlite)
    const checkpoint = database.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint?.busy !== 0) throw new Error('Frozen SQLite fixture checkpoint remained busy')
    const check = database.query<{ quick_check: string }, []>('PRAGMA quick_check').get()
    if (check?.quick_check !== 'ok') throw new Error('Frozen SQLite fixture integrity check failed')
    signal?.throwIfAborted()
  } finally {
    database.close()
  }
}

async function sqliteIdentity(): Promise<FrozenSqliteIdentity> {
  const probe = new Database(':memory:')
  try {
    const version = probe
      .query<
        { version: string; source: string },
        []
      >('SELECT sqlite_version() AS version, sqlite_source_id() AS source')
      .get()!
    const sources = [
      ['fixture', import.meta.filename],
      ['cache', join(import.meta.dir, 'testFixtureCache.ts')],
      [
        'chain',
        join(import.meta.dir, '../../src/platform/persistence/migration/epoch1/sqliteChain.ts'),
      ],
      [
        'compatibility',
        join(
          import.meta.dir,
          '../../src/platform/persistence/migration/legacy/sqliteCompatibility.ts',
        ),
      ],
      [
        'admission',
        join(import.meta.dir, '../../src/platform/persistence/migration/epoch1/bundle.ts'),
      ],
    ] as const
    return {
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      compilerDigest: await fixtureFileDigest(process.execPath),
      platform: process.platform,
      architecture: process.arch,
      sqliteVersion: version.version,
      sqliteSourceId: version.source,
      compileOptions: probe
        .query<Record<string, string>, []>('PRAGMA compile_options')
        .all()
        .map((row) => Object.values(row)[0]!)
        .sort(),
      implementation: Object.fromEntries(
        await Promise.all(
          sources.map(async ([name, path]) => [name, fixtureDigest(await readFile(path))]),
        ),
      ),
    }
  } finally {
    probe.close()
  }
}

export async function materializeFrozenEpoch1Sqlite(
  destination: string,
  options: {
    cacheRoot?: string | null
    signal?: AbortSignal
    /** Exercise admission failure without mutating the repository's frozen SQL. */
    admitHistory?: typeof loadFrozenEpoch1History
  } = {},
) {
  // Admission verifies actual frozen SQL/provenance on every call, including cache hits.
  const history = await (options.admitHistory ?? loadFrozenEpoch1History)()
  const cacheRoot =
    options.cacheRoot === undefined ? process.env[TEST_FIXTURE_CACHE_ENV] : options.cacheRoot
  if (!cacheRoot) {
    const started = performance.now()
    buildFrozenSqlite(destination, history, options.signal)
    console.info(
      `[fixture-cache] frozen-epoch1-sqlite disabled build=${(performance.now() - started).toFixed(1)}ms`,
    )
    return { path: destination, key: '', cache: 'disabled' as const }
  }
  return await materializeTestFixture({
    kind: 'frozen-epoch1-sqlite',
    inputs: frozenSqliteCacheInputs(history, await sqliteIdentity()),
    destination,
    cacheRoot,
    signal: options.signal,
    async build(path, signal) {
      buildFrozenSqlite(path, history, signal)
    },
  })
}
