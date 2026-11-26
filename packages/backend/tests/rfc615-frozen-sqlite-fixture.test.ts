// RFC-615: cache only baseline preparation; mutations, upgrades and process death stay per case.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { autoUpgradeFixture } from './helpers/rfc398AutoUpgrade'
import {
  frozenSqliteCacheInputs,
  materializeFrozenEpoch1Sqlite,
  type FrozenSqliteIdentity,
} from './helpers/rfc398FrozenSqliteFixture'
import { fixtureCacheKey } from './helpers/testFixtureCache'

test('frozen baseline keys include ordered SQL/journal, mechanism, Bun, SQLite and platform identity', () => {
  const history = {
    chainDigest: 'chain',
    sqliteTags: ['one', 'two'],
    sqlite: [
      { sql: ['SELECT 1'], hash: 'first', folderMillis: 1, bps: true },
      { sql: ['SELECT 2'], hash: 'second', folderMillis: 2, bps: true },
    ],
  }
  const identity: FrozenSqliteIdentity = {
    bunVersion: '1.4.3',
    bunRevision: 'revision',
    compilerDigest: 'bun-bytes',
    platform: 'linux',
    architecture: 'x64',
    sqliteVersion: 'sqlite',
    sqliteSourceId: 'source',
    compileOptions: ['ONE'],
    implementation: { fixture: 'v1', compatibility: 'legacy', chain: 'executor' },
  }
  const key = (source = history, engine = identity) =>
    fixtureCacheKey('frozen-epoch1-sqlite', frozenSqliteCacheInputs(source, engine))
  const original = key()
  for (const source of [
    { ...history, chainDigest: 'changed' },
    { ...history, sqliteTags: [...history.sqliteTags].reverse() },
    { ...history, sqlite: [...history.sqlite].reverse() },
    { ...history, sqlite: history.sqlite.map((row) => ({ ...row, sql: ['SELECT 3'] })) },
    { ...history, sqlite: history.sqlite.map((row) => ({ ...row, hash: 'new-hash' })) },
    { ...history, sqlite: history.sqlite.map((row) => ({ ...row, folderMillis: 3 })) },
    { ...history, sqlite: history.sqlite.map((row) => ({ ...row, bps: false })) },
  ])
    expect(key(source)).not.toBe(original)
  for (const field of [
    'bunVersion',
    'bunRevision',
    'compilerDigest',
    'platform',
    'architecture',
    'sqliteVersion',
    'sqliteSourceId',
  ] as const)
    expect(key(history, { ...identity, [field]: 'changed' })).not.toBe(original)
  expect(key(history, { ...identity, compileOptions: ['TWO'] })).not.toBe(original)
  expect(
    key(history, {
      ...identity,
      implementation: { ...identity.implementation, compatibility: 'changed' },
    }),
  ).not.toBe(original)
})

test('real frozen migrations produce WAL copies with complete receipts and independent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-frozen-sqlite-cache-'))
  try {
    const cacheRoot = join(root, 'cache'),
      first = join(root, 'first.sqlite'),
      second = join(root, 'second.sqlite')
    const history = await loadFrozenEpoch1History()
    expect((await materializeFrozenEpoch1Sqlite(first, { cacheRoot })).cache).toBe('miss')
    expect((await materializeFrozenEpoch1Sqlite(second, { cacheRoot })).cache).toBe('hit')
    const initial = await readFile(first)
    expect(await readFile(second)).toEqual(initial)
    expect([...initial.subarray(18, 20)]).toEqual([2, 2])
    expect(existsSync(`${second}-wal`)).toBe(false)
    expect(existsSync(`${second}-shm`)).toBe(false)
    const one = new Database(first),
      two = new Database(second)
    try {
      expect(
        one.query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all(),
      ).toEqual(
        history.sqlite.map((migration) => ({
          hash: migration.hash,
          created_at: migration.folderMillis,
        })),
      )
      const seeds = two.query('SELECT * FROM auth_login_policy ORDER BY id').all()
      expect(seeds.length).toBeGreaterThan(0)
      one.exec('UPDATE auth_login_policy SET password_login_enabled = 0')
      one.exec('CREATE TABLE case_private (value TEXT)')
      expect(two.query("SELECT name FROM sqlite_schema WHERE name = 'case_private'").all()).toEqual(
        [],
      )
      expect(two.query('SELECT * FROM auth_login_policy ORDER BY id').all()).toEqual(seeds)
    } finally {
      one.close()
      two.close()
    }
    await rm(second)
    const third = join(root, 'third.sqlite')
    expect((await materializeFrozenEpoch1Sqlite(third, { cacheRoot })).cache).toBe('hit')
    expect(await readFile(third)).toEqual(initial)
    const cold = join(root, 'cold.sqlite')
    expect((await materializeFrozenEpoch1Sqlite(cold, { cacheRoot: null })).cache).toBe('disabled')
    const fresh = new Database(cold),
      cached = new Database(third)
    try {
      const schema = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name'
      expect(fresh.query(schema).all()).toEqual(cached.query(schema).all())
      expect(
        fresh.query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all(),
      ).toEqual(
        cached.query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid').all(),
      )
    } finally {
      fresh.close()
      cached.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

test('a hot cache does not suppress a later frozen-history admission failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-frozen-sqlite-admission-'))
  try {
    let admissions = 0
    const admitHistory = async () => {
      admissions++
      if (admissions === 2) throw new Error('Frozen migration bytes differ: test admission')
      return await loadFrozenEpoch1History()
    }
    const options = { cacheRoot: join(root, 'cache'), admitHistory }
    expect((await materializeFrozenEpoch1Sqlite(join(root, 'first.sqlite'), options)).cache).toBe(
      'miss',
    )
    await expect(
      materializeFrozenEpoch1Sqlite(join(root, 'second.sqlite'), options),
    ).rejects.toThrow('Frozen migration bytes differ')
    expect(admissions).toBe(2)
    expect(existsSync(join(root, 'second.sqlite'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

test('autoUpgradeFixture adds blocked rows and manual settings only after making its private copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-frozen-sqlite-cases-'))
  const previous = process.env.AW_TEST_FIXTURE_CACHE_DIR
  process.env.AW_TEST_FIXTURE_CACHE_DIR = join(root, 'cache')
  const fixtures: Awaited<ReturnType<typeof autoUpgradeFixture>>[] = []
  try {
    const blocked = await autoUpgradeFixture({ blocked: true })
    fixtures.push(blocked)
    const manual = await autoUpgradeFixture({ manual: true })
    fixtures.push(manual)
    expect(blocked.home).not.toBe(manual.home)
    const one = new Database(join(blocked.home, 'db.sqlite'))
    const two = new Database(join(manual.home, 'db.sqlite'))
    try {
      const query = "SELECT id FROM code_work_items WHERE id = 'rfc398-stranded-work'"
      expect(one.query(query).all()).toHaveLength(1)
      expect(two.query(query).all()).toEqual([])
    } finally {
      one.close()
      two.close()
    }
    expect(
      JSON.parse(await readFile(join(blocked.home, 'config.json'), 'utf8')).autoEpochMigration,
    ).toBe(true)
    expect(
      JSON.parse(await readFile(join(manual.home, 'config.json'), 'utf8')).autoEpochMigration,
    ).toBe(false)
    blocked.barriers(['one-private-point'])
    expect(existsSync(join(manual.hooks, 'barriers.json'))).toBe(false)
    expect(blocked.env.AGENT_WORKFLOW_HOME).toBe(blocked.home)
    expect(manual.env.AGENT_WORKFLOW_HOME).toBe(manual.home)
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()))
    if (previous === undefined) delete process.env.AW_TEST_FIXTURE_CACHE_DIR
    else process.env.AW_TEST_FIXTURE_CACHE_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
