// RFC-626 §3.5 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md, "环境前置检查"),
// the source side: is the old database readable, is its structure that of a released
// version, and how much live data does it hold.
//
// The check runs before an automatic upgrade registers anything, so it has two promises to
// keep, and this file locks both:
//   * it does not depend on the amount of data — no row is counted (the counted fingerprint
//     of a freeze issues one `count(*)` per table; an unknown table is told from an empty one
//     with a single-row probe instead), and the space estimate starts from the live pages of
//     the database, not from the size of its file;
//   * it writes nothing — no directory of the operation, no database.
// A refusal has to be something a person can act on: the sentence names every object that is
// unexpected, missing or changed, and the cause of an unreadable source is text, never
// "[object Object]".
import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import { precheckSource } from '@/platform/persistence/migration/freeze/sourcePrecheck'
import {
  measureMigrationCapacity,
  migrationDirectoryBytes,
  sqliteLiveBytes,
} from '@/platform/persistence/migration/freeze/capacity'
import {
  collectSourceFingerprint,
  collectSourceStructure,
} from '@/platform/persistence/migration/sourceCatalog'
import type { SupportedSourceManifest } from '@/platform/persistence/migration/supportedSources'
import { sortHistoryCatalog } from '@/platform/persistence/schema/history/catalogModel'
import type { HistoryConnection } from '@/platform/persistence/schema/history/connection'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'
import { createEpochSourceAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/sourceAdapter'
import { EpochSwitchError } from '@/modules/system-operations/domain/epochSwitch/model'

// Installing the frozen head takes a few seconds on CI; the check itself is immediate.
setDefaultTimeout(60_000)

const COUNTS = /count\s*\(/i
const pragma = (database: Database, name: string) =>
  Number((database.query(`PRAGMA ${name}`).get() as Record<string, number>)[name])
const liveBytesOf = (database: Database) =>
  (pragma(database, 'page_count') - pragma(database, 'freelist_count')) *
  pragma(database, 'page_size')
/** Everything next to the database except what SQLite itself puts there while it is read. */
const neighbours = (path: string) =>
  readdirSync(dirname(path))
    .filter((name) => !/-(wal|shm|journal)$/.test(name))
    .sort()

describeV1Providers('RFC-626 source precheck', (h) => {
  if (h.provider === 'sqlite') {
    const location = () => ({
      kind: 'sqlite-file' as const,
      path: h.sqlitePath,
      pointerPath: join(h.operationRoot, 'missing-pointer.json'),
    })
    /** Opens the database as the check does and records every statement prepared on it. */
    const recording = (statements: string[]) => (path: string) => {
      const database = openSqliteForRead(path)
      const query = database.query.bind(database)
      database.query = ((sql: string) => {
        statements.push(sql)
        return query(sql)
      }) as typeof database.query
      return database
    }

    test('a released database passes, with its live bytes, without a single row being counted', async () => {
      await h.install()
      await h.seed()
      const before = neighbours(h.sqlitePath)
      const statements: string[] = []
      const result = await precheckSource({
        location: location(),
        manifest: await h.manifest(),
        openSqlite: recording(statements),
      })
      expect(result).toEqual({ ok: true, liveBytes: liveBytesOf(h.sqlite) })
      // The catalog and the journal were read, and every table was asked for one row at most.
      expect(statements.length).toBeGreaterThan(100)
      expect(statements.filter((sql) => COUNTS.test(sql))).toEqual([])
      const tables = (
        h.sqlite.query("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
          name: string
        }[]
      ).map((table) => table.name)
      expect(
        statements.filter((sql) => /^SELECT 1 AS present FROM .* LIMIT 1$/.test(sql)),
      ).toHaveLength(tables.length)
      // Nothing was created next to the database, and its bytes are as they were.
      expect(neighbours(h.sqlitePath)).toEqual(before)
      // The counted fingerprint, for contrast, is what the check must not do.
      const counted: string[] = []
      const database = recording(counted)(h.sqlitePath)
      try {
        collectSourceFingerprint(database)
      } finally {
        database.close()
      }
      expect(counted.filter((sql) => COUNTS.test(sql))).toHaveLength(tables.length)
    })

    test('the structure without counts has the catalog and journal of the counted fingerprint', async () => {
      await h.install()
      await h.seed()
      const counted = collectSourceFingerprint(h.sqlite)
      const structure = collectSourceStructure(h.sqlite)
      expect(structure.catalog).toEqual(counted.catalog)
      expect(structure.catalogDigest).toBe(counted.catalogDigest)
      expect(structure.journal).toEqual(counted.journal)
      expect(structure.provider).toBe('sqlite')
      // One for a table with rows, zero for an empty one — presence, not a count.
      expect(structure.tableRows).toEqual(
        Object.fromEntries(
          Object.entries(counted.tableRows).map(([table, rows]) => [table, rows > 0 ? 1 : 0]),
        ),
      )
      expect(counted.tableRows.maintenance_state).toBe(3)
      expect(structure.tableRows.maintenance_state).toBe(1)
      // It is not the fingerprint of the source and must never be taken for it.
      expect(structure.digest).not.toBe(counted.digest)
    })

    test('the live bytes of a sparse database are far below the size of its file', async () => {
      await h.install()
      await h.seed()
      const insert = h.sqlite.query(
        'INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, 1)',
      )
      h.sqlite.exec('BEGIN')
      for (let row = 0; row < 200; row += 1) insert.run(`rfc626-${row}`, 'x'.repeat(8192))
      h.sqlite.exec('COMMIT')
      h.sqlite.exec("DELETE FROM maintenance_state WHERE key LIKE 'rfc626-%'")
      // The rows are gone and their pages are free, but the file keeps its size.
      const fileBytes = statSync(h.sqlitePath).size
      expect(pragma(h.sqlite, 'freelist_count') * pragma(h.sqlite, 'page_size')).toBeGreaterThan(
        1_000_000,
      )
      const result = await precheckSource({ location: location(), manifest: await h.manifest() })
      expect(result).toEqual({ ok: true, liveBytes: liveBytesOf(h.sqlite) })
      expect(result.ok && result.liveBytes).toBeLessThan(fileBytes - 1_000_000)
      expect(sqliteLiveBytes(h.sqlite)).toBe(liveBytesOf(h.sqlite))
      // The plan's capacity measurement starts from the same number.
      const measured = await measureMigrationCapacity(location(), join(h.operationRoot, 'absent'))
      expect(measured.sourceBytes).toBe(liveBytesOf(h.sqlite))
      expect(measured.operationBytes).toBe(0)
      expect(measured.availableBytes).toBeGreaterThan(0)
      expect(existsSync(join(h.operationRoot, 'absent'))).toBe(false)
    })

    test('a structure that is not a released one is refused with every object named', async () => {
      await h.install()
      await h.seed()
      const index = h.sqlite
        .query(
          "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name LIMIT 1",
        )
        .get() as { name: string; tbl_name: string }
      h.sqlite.exec(`
        CREATE TABLE rfc626_extra (id INTEGER PRIMARY KEY, note TEXT);
        INSERT INTO rfc626_extra (note) VALUES ('kept by somebody');
        CREATE TABLE rfc626_empty (id INTEGER PRIMARY KEY);
        ALTER TABLE maintenance_state ADD COLUMN rfc626_note text;
        DROP INDEX "${index.name}";
      `)
      const statements: string[] = []
      const result = await precheckSource({
        location: location(),
        manifest: await h.manifest(),
        openSqlite: recording(statements),
      })
      if (result.ok) throw new Error('expected the structure to be refused')
      expect(result.reason).toBe('structure')
      expect(result.message).toStartWith(
        'The structure of the database is not that of a released version',
      )
      // Added, removed and altered, each by name.
      expect(result.message).toContain('unexpected: ')
      expect(result.message).toContain('table rfc626_extra (holds rows)')
      expect(result.message).toContain('table rfc626_empty (empty)')
      expect(result.message).toContain('column maintenance_state.rfc626_note')
      expect(result.message).toContain(`missing: index ${index.name} on ${index.tbl_name}`)
      expect(result.message).toContain('changed: table maintenance_state')
      // A table that is unexpected as a whole stands for its own columns.
      expect(result.message).not.toContain('column rfc626_extra.')
      expect(result.message).toEndWith('then start again.')
      expect(result.detail).toMatchObject({
        source: h.sqlitePath,
        unexpected: expect.arrayContaining([
          'table rfc626_extra (holds rows)',
          'table rfc626_empty (empty)',
          'column maintenance_state.rfc626_note',
        ]),
        missing: [`index ${index.name} on ${index.tbl_name}`],
        changed: ['table maintenance_state'],
        counts: { unexpected: 3, missing: 1, changed: 1 },
      })
      // Finding that out did not take a count either.
      expect(statements.filter((sql) => COUNTS.test(sql))).toEqual([])
    })

    test('a file that is missing or is not a database is refused as unreadable, with the cause as text', async () => {
      const missing = join(h.operationRoot, 'no-such.sqlite')
      const absent = await precheckSource({
        location: { ...location(), path: missing },
        manifest: await h.manifest(),
      })
      expect(absent).toMatchObject({
        ok: false,
        reason: 'unreadable',
        detail: { source: missing, error: 'the file does not exist' },
      })
      expect(absent.ok ? '' : absent.message).toContain(missing)
      expect(existsSync(missing)).toBe(false)

      const garbage = join(h.operationRoot, 'garbage.sqlite')
      writeFileSync(garbage, Buffer.alloc(8192, 0x61))
      const corrupt = await precheckSource({
        location: { ...location(), path: garbage },
        manifest: await h.manifest(),
      })
      if (corrupt.ok) throw new Error('expected an unreadable source')
      expect(corrupt.reason).toBe('unreadable')
      expect(corrupt.message).toStartWith(
        `The database file ${garbage} cannot be read as a SQLite database: `,
      )
      expect(corrupt.message).not.toContain('[object Object]')
      expect(corrupt.message).toEndWith('then start again.')
      expect(typeof corrupt.detail.error).toBe('string')
      // The same file still has a size for the capacity estimate: that of its bytes.
      expect(
        (await measureMigrationCapacity({ ...location(), path: garbage }, h.operationRoot))
          .sourceBytes,
      ).toBe(8192)
      expect(
        (await measureMigrationCapacity({ ...location(), path: missing }, h.operationRoot))
          .sourceBytes,
      ).toBeNull()
    })

    test('without releases to compare with only readability and size are checked', async () => {
      await h.install()
      h.sqlite.exec('CREATE TABLE rfc626_extra (id INTEGER PRIMARY KEY)')
      const manifest = await h.manifest()
      for (const comparable of [
        null,
        { ...manifest, sources: manifest.sources.filter((source) => source.provider !== 'sqlite') },
      ])
        expect(await precheckSource({ location: location(), manifest: comparable })).toEqual({
          ok: true,
          liveBytes: liveBytesOf(h.sqlite),
        })
      expect((await precheckSource({ location: location(), manifest })).ok).toBe(false)
    })

    test('the adapter asks for what the check needs and leaves the operation directory uncreated', async () => {
      await h.install()
      const manifest = await h.manifest()
      const operationRoot = join(h.operationRoot, 'operation-not-yet-registered')
      const request = { location: location(), emptyTables: [], operationRoot }
      const asked: string[] = []
      const adapter = createEpochSourceAdapter({
        async resolve() {
          asked.push('resolve')
          return { manifest }
        },
        async resolvePrecheck() {
          asked.push('resolvePrecheck')
          return { manifest }
        },
      })
      expect(await adapter.precheck(request)).toEqual({
        ok: true,
        liveBytes: liveBytesOf(h.sqlite),
      })
      // The dedicated resolution is used: the ordinary one may prepare a scratch database.
      expect(asked).toEqual(['resolvePrecheck'])
      expect(existsSync(operationRoot)).toBe(false)
      // Without it the ordinary resolution serves, which is enough for a file source.
      const plain = createEpochSourceAdapter({
        async resolve() {
          asked.push('resolve')
          return { manifest }
        },
      })
      expect((await plain.precheck(request)).ok).toBe(true)
      expect(asked).toEqual(['resolvePrecheck', 'resolve'])
      expect(existsSync(operationRoot)).toBe(false)
    })
  }

  if (h.provider === 'postgresql')
    test('a released PostgreSQL database passes with its size, and an added table is named', async () => {
      await h.install()
      await h.seed()
      const input = {
        location: { kind: 'postgresql-database' as const, profileRef: 'env:RFC626_SOURCE' },
        manifest: await h.manifest(),
        postgresql: () => h.runtime,
      }
      const passed = await precheckSource(input)
      expect(passed.ok).toBe(true)
      expect(passed.ok && passed.liveBytes).toBeGreaterThan(0)
      // The structure without counts identifies like the counted fingerprint.
      const counted = await collectSourceFingerprint(h.native)
      const statements: string[] = []
      const structure = await collectSourceStructure({
        ...h.native,
        async execute(statement, values) {
          statements.push(statement)
          return await h.native.execute(statement, values)
        },
      })
      expect(structure.catalogDigest).toBe(counted.catalogDigest)
      expect(structure.journal).toEqual(counted.journal)
      expect(structure.tableRows).toEqual(
        Object.fromEntries(
          Object.entries(counted.tableRows).map(([table, rows]) => [table, rows > 0 ? 1 : 0]),
        ),
      )
      expect(statements.filter((sql) => COUNTS.test(sql))).toEqual([])

      await h.native.execute('CREATE TABLE agent_workflow.rfc626_extra (id integer PRIMARY KEY)')
      await h.native.execute('INSERT INTO agent_workflow.rfc626_extra VALUES (1)')
      const refused = await precheckSource(input)
      if (refused.ok) throw new Error('expected the structure to be refused')
      expect(refused.reason).toBe('structure')
      expect(refused.message).toContain('table agent_workflow.rfc626_extra (holds rows)')
      // A server major this build has no catalog for is refused by name, before anything else.
      const unsupported = await precheckSource({ ...input, supportedPostgresqlMajors: [1] })
      expect(unsupported).toMatchObject({ ok: false, reason: 'unreadable' })
      expect(unsupported.ok ? '' : unsupported.message).toContain('upgrades from PostgreSQL 1')
    })
})

describe('RFC-626 source precheck on PostgreSQL, statement by statement', () => {
  const location = { kind: 'postgresql-database' as const, profileRef: 'env:RFC626_SOURCE' }
  /** A runtime whose one connection answers from `answer` and records what it was asked. */
  function runtime(
    answer: (sql: string, values?: readonly unknown[]) => readonly Record<string, unknown>[],
    options: { readonly reserve?: () => never } = {},
  ) {
    const statements: string[] = []
    const state = { released: 0 }
    const connection = {
      unsafe: async (sql: string, values?: readonly unknown[]) => {
        statements.push(sql)
        return answer(sql, values)
      },
      release() {
        state.released += 1
      },
    }
    const pool = {
      async reserve() {
        options.reserve?.()
        return connection
      },
      close: async () => {},
    }
    return {
      statements,
      state,
      postgresql: () =>
        ({
          provider: 'postgresql',
          providerPool: () => pool,
        }) as unknown as PostgresqlDatabaseRuntime,
    }
  }
  const basics = (sql: string): readonly Record<string, unknown>[] | null =>
    sql.includes('server_version_num')
      ? [{ version: '160004' }]
      : sql.includes('pg_database_size')
        ? [{ bytes: '123456789' }]
        : null
  const relation = (name: string) => ({
    kind: 'relation',
    relation: `agent_workflow.${name}`,
    name,
    definition: 'r',
  })
  const column = (table: string, name: string) => ({
    kind: 'column',
    relation: `agent_workflow.${table}`,
    name,
    definition: '1|text|true|||',
  })
  const released = [
    relation('tasks'),
    column('tasks', 'id'),
    relation('users'),
    column('users', 'id'),
  ]
  const manifest: SupportedSourceManifest = {
    version: 1,
    chainDigest: 'sha256:chain',
    headDigest: 'sha256:head',
    sqliteJournalAliases: {},
    codecCorrections: [],
    sources: [
      {
        id: 'postgresql:fixture',
        provider: 'postgresql',
        contract: null,
        catalog: sortHistoryCatalog([...released]),
        journal: [],
        sqliteThrough: 1,
        postgresqlVersion: null,
        postgresqlMajor: 16,
        expectedAbsent: [],
        archivedTables: [],
        readMode: 'upgrade-only',
      },
    ],
  }
  /** Answers the catalog, the sequence owners and the single-row probes of `catalog`. */
  const database =
    (catalog: readonly Record<string, unknown>[], holdsRows: readonly string[]) =>
    (sql: string, values?: readonly unknown[]) =>
      basics(sql) ??
      (sql.includes("SELECT 'relation' AS kind")
        ? catalog
        : sql.includes('EXISTS (SELECT 1 FROM')
          ? (values ?? []).map((name) => ({
              relation: name,
              present: holdsRows.includes(String(name)),
            }))
          : [])

  test('readable: one read-only transaction, the server version, the database size, nothing else', async () => {
    const source = runtime((sql) => basics(sql) ?? [])
    expect(
      await precheckSource({ location, manifest: null, postgresql: source.postgresql }),
    ).toEqual({ ok: true, liveBytes: 123456789 })
    expect(source.statements.slice(1)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL search_path TO agent_workflow, public',
      "SELECT current_setting('server_version_num') AS version",
      'SELECT pg_database_size(current_database()) AS bytes',
      'ROLLBACK',
    ])
    expect(source.state.released).toBe(1)
    // Nothing is created, and nothing is counted.
    expect(
      source.statements.filter((sql) => /\b(CREATE|INSERT|UPDATE|DELETE|DROP)\b/.test(sql)),
    ).toEqual([])
    expect(source.statements.filter((sql) => COUNTS.test(sql))).toEqual([])
  })

  test('the structure is identified from the catalog and one single-row probe per table, never a count', async () => {
    const source = runtime(database(released, ['agent_workflow.tasks']))
    expect(await precheckSource({ location, manifest, postgresql: source.postgresql })).toEqual({
      ok: true,
      liveBytes: 123456789,
    })
    expect(source.statements.filter((sql) => COUNTS.test(sql))).toEqual([])
    const probes = source.statements.filter((sql) => sql.includes('EXISTS (SELECT 1 FROM'))
    expect(probes).toHaveLength(1)
    expect(probes[0]).toContain('"agent_workflow"."tasks"')
    expect(probes[0]).toContain('"agent_workflow"."users"')
    expect(source.state.released).toBe(1)
  })

  test('an added table, a missing column and a changed column are each named', async () => {
    const actual = [
      relation('tasks'),
      { ...column('tasks', 'id'), definition: '1|bigint|true|||' },
      relation('users'),
      relation('rfc626_extra'),
      column('rfc626_extra', 'id'),
    ]
    const source = runtime(database(actual, ['agent_workflow.rfc626_extra']))
    const result = await precheckSource({ location, manifest, postgresql: source.postgresql })
    if (result.ok) throw new Error('expected the structure to be refused')
    expect(result.reason).toBe('structure')
    expect(result.message).toContain('unexpected: table agent_workflow.rfc626_extra (holds rows)')
    expect(result.message).toContain('missing: column agent_workflow.users.id')
    expect(result.message).toContain('changed: column agent_workflow.tasks.id')
    expect(result.message).not.toContain('column agent_workflow.rfc626_extra.id')
    expect(result.detail).toMatchObject({
      source: 'env:RFC626_SOURCE',
      counts: { unexpected: 1, missing: 1, changed: 1 },
    })
    expect(source.state.released).toBe(1)
  })

  test('a server version this build cannot upgrade from is refused by number', async () => {
    const source = runtime((sql) => basics(sql) ?? [])
    const result = await precheckSource({
      location,
      manifest,
      postgresql: source.postgresql,
      supportedPostgresqlMajors: [15, 17],
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'unreadable',
      detail: { source: 'env:RFC626_SOURCE', postgresqlMajor: 16, supported: [15, 17] },
    })
    expect(result.ok ? '' : result.message).toContain('is version 16')
    expect(result.ok ? '' : result.message).toContain('PostgreSQL 15, 17')
    // The catalog is not read for a server that is refused anyway, and the connection goes back.
    expect(source.statements.some((sql) => sql.includes("SELECT 'relation' AS kind"))).toBe(false)
    expect(source.statements.at(-1)).toBe('ROLLBACK')
    expect(source.state.released).toBe(1)
    expect(
      await precheckSource({
        location,
        manifest: null,
        postgresql: runtime((sql) => basics(sql) ?? []).postgresql,
        supportedPostgresqlMajors: [16],
      }),
    ).toEqual({ ok: true, liveBytes: 123456789 })
  })

  test('a server that cannot be reached is refused with what the client said, not "[object Object]"', async () => {
    // Database clients throw plain objects, not Error instances.
    const source = runtime(() => [], {
      reserve() {
        throw { message: 'connection refused', code: 'ECONNREFUSED' }
      },
    })
    const result = await precheckSource({ location, manifest, postgresql: source.postgresql })
    if (result.ok) throw new Error('expected an unreadable source')
    expect(result.reason).toBe('unreadable')
    expect(result.message).toBe(
      'The PostgreSQL database (env:RFC626_SOURCE) cannot be read: connection refused; check the ' +
        'connection settings and that the server is running and reachable, then start again.',
    )
    expect(result.detail).toEqual({
      source: 'env:RFC626_SOURCE',
      error: 'connection refused',
      code: 'ECONNREFUSED',
    })
    expect(source.state.released).toBe(0)
  })

  test('a statement that fails ends the check as unreadable and still gives the connection back', async () => {
    const source = runtime((sql) => {
      if (sql.includes('pg_database_size')) throw { message: 'permission denied for database' }
      return basics(sql) ?? []
    })
    const result = await precheckSource({ location, manifest: null, postgresql: source.postgresql })
    expect(result).toMatchObject({
      ok: false,
      reason: 'unreadable',
      detail: { error: 'permission denied for database', code: null },
    })
    expect(source.statements.at(-1)).toBe('ROLLBACK')
    expect(source.state.released).toBe(1)
  })

  test('a PostgreSQL source without its runtime is an assembly error, not a property of the database', async () => {
    await expect(precheckSource({ location, manifest })).rejects.toThrow(
      'postgresql-source-runtime-required',
    )
  })

  test('the structure collector on its own: catalog, journal and presence, with batched probes', async () => {
    const statements: string[] = []
    const many = Array.from({ length: 70 }, (_, index) => relation(`table_${index}`))
    const journalTable = {
      ...relation('schema_migrations'),
      relation: 'agent_workflow_meta.schema_migrations',
    }
    const answer = database([...many, journalTable], ['agent_workflow.table_3'])
    const connection: HistoryConnection = {
      provider: 'postgresql',
      async execute(sql, values) {
        statements.push(sql)
        return answer(sql, values)
      },
    }
    const structure = await collectSourceStructure(connection)
    expect(structure.provider).toBe('postgresql')
    expect(structure.postgresqlMajor).toBe(16)
    expect(Object.keys(structure.tableRows)).toHaveLength(71)
    expect(structure.tableRows['agent_workflow.table_3']).toBe(1)
    expect(structure.tableRows['agent_workflow.table_4']).toBe(0)
    // 71 tables in batches of 64.
    expect(statements.filter((sql) => sql.includes('EXISTS (SELECT 1 FROM'))).toHaveLength(2)
    expect(statements.filter((sql) => COUNTS.test(sql))).toEqual([])
    // The journal table is there, so the journal is read (and is empty here).
    expect(
      statements.filter((sql) =>
        sql.includes('FROM agent_workflow_meta.schema_migrations ORDER BY'),
      ),
    ).toHaveLength(1)
    expect(structure.journal).toEqual([])
    // A probe the server does not answer for is an error, not an empty table.
    await expect(
      collectSourceStructure({
        provider: 'postgresql',
        async execute(sql, values) {
          const rows = database(many, [])(sql, values)
          return sql.includes('EXISTS (SELECT 1 FROM') ? rows.slice(1) : rows
        },
      }),
    ).rejects.toThrow('source table could not be probed')
  })
})

describe('RFC-626 source precheck through the adapter', () => {
  const request = {
    location: { kind: 'postgresql-database' as const, profileRef: 'env:RFC626_SOURCE' },
    emptyTables: [],
    operationRoot: '/nonexistent/rfc626-operation',
  }

  test('a source that cannot be reached while it is resolved is refused with the cause as text', async () => {
    const adapter = createEpochSourceAdapter({
      async resolve() {
        throw { message: 'password authentication failed', code: '28P01' }
      },
    })
    expect(await adapter.precheck(request)).toEqual({
      ok: false,
      reason: 'unreadable',
      message:
        'The old database cannot be reached: password authentication failed; check that it is available, then start again.',
      detail: { error: 'password authentication failed', code: '28P01' },
    })
  })

  test('a failure of the upgrade itself is not turned into a property of the database', async () => {
    const failure = new EpochSwitchError('v3-scratch-required', { category: 'scratch-required' })
    const adapter = createEpochSourceAdapter({
      async resolve() {
        throw failure
      },
    })
    await expect(adapter.precheck(request)).rejects.toBe(failure)
  })

  test('a backup source is an immutable input: only its size is reported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-precheck-'))
    try {
      writeFileSync(join(root, 'db.sqlite'), Buffer.alloc(789))
      expect(
        await precheckSource({
          location: { kind: 'backup', sourceKind: 'sqlite-backup', artifact: root, root },
          manifest: null,
        }),
      ).toEqual({ ok: true, liveBytes: 789 })
      expect(migrationDirectoryBytes(root)).toBe(789)
      expect(readdirSync(root)).toEqual(['db.sqlite'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RFC-626 source precheck on a WAL database without sidecars', () => {
  // RFC-398 §5: a checkpointed WAL database has no -wal / -shm. Every reader of the old
  // database has to open it in that state without changing a byte of it; the check and the
  // capacity measurement are two new readers.
  test('the check and the capacity measurement read it and leave its bytes as they were', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-wal-'))
    const path = join(root, 'db.sqlite')
    const location = { kind: 'sqlite-file' as const, path, pointerPath: join(root, 'pointer.json') }
    try {
      const writer = new Database(path)
      writer.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
      writer.exec("INSERT INTO notes (body) VALUES ('kept')")
      writer.close()
      // Switch the journal mode on a fresh connection, then fold the WAL back into the file.
      const wal = new Database(path)
      wal.exec('PRAGMA journal_mode = WAL')
      wal.exec("INSERT INTO notes (body) VALUES ('written in WAL mode')")
      wal.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      wal.close()
      // macOS's system SQLite keeps an emptied -wal and the -shm after the last connection
      // closes (persistent WAL); elsewhere they go with it. The checkpoint emptied the WAL, so
      // removing them loses nothing and leaves the state this case is about on every platform.
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0)
      for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
      expect(existsSync(`${path}-wal`)).toBe(false)
      expect(existsSync(`${path}-shm`)).toBe(false)
      const bytes = readFileSync(path)
      // SQLite file header read/write versions are both 2 for WAL mode.
      expect([...bytes.subarray(18, 20)]).toEqual([2, 2])

      const result = await precheckSource({ location, manifest: null })
      expect(result).toMatchObject({ ok: true })
      expect(result.ok && result.liveBytes).toBeGreaterThan(0)
      expect(readFileSync(path)).toEqual(bytes)
      const measured = await measureMigrationCapacity(location, join(root, 'operation'))
      expect(measured.sourceBytes).toBe(result.ok ? result.liveBytes : -1)
      expect(readFileSync(path)).toEqual(bytes)
      expect(existsSync(join(root, 'operation'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
