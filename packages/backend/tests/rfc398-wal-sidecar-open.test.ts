// RFC-398-T1 / §5 and §7.6: every disk reader handles missing WAL sidecars without changing source bytes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { composeLocalEpochSwitchDependencies } from '@/bootstrap/epochMigration'
import { classifyRestoreArtifact } from '@/bootstrap/epochMigrationEntry'
import { openSqliteForRead } from '@/platform/persistence/sqlite/openForRead'
import { openReadonlySqliteDatabase } from '@/platform/persistence/sqlite/readonlySqliteDatabase'
import { quickCheckDbFile } from '@/db/integrity'
import { installSqliteBaseline } from '@/platform/persistence/sqlite/baseline'
import { schemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
import { HistoryCatalogCache } from '@/platform/persistence/schema/history/catalog'
import { sqliteHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  applyFrozenSqliteMigrations,
  createFrozenSqliteJournal,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import {
  loadSupportedSourceManifest,
  type SupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import {
  captureEpoch1SqliteEvidence,
  verifyEpoch1SqliteEvidence,
} from '@/platform/persistence/migration/auditSourceEvidence'
import {
  openFrozenSource,
  frozenSourceDetails,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import { createSwitchBackup } from '@/platform/persistence/migration/freeze/backup'
import {
  vacuumSqliteInto,
  quickCheckSqlite,
} from '@/platform/persistence/migration/legacy/sqliteSnapshot'
import {
  vacuumSqliteInto as systemVacuum,
  quickCheckSqlite as systemQuickCheck,
} from '@/platform/persistence/sqlite/systemBackupVacuum'
import { readDbMigrationIdentity as legacyIdentity } from '@/platform/persistence/migration/legacy/backupManifest'
import { readDbMigrationIdentity as systemIdentity } from '@/platform/persistence/sqlite/systemBackupManifest'
import { createSqliteDatabaseOperationalAdapter } from '@/platform/persistence/databaseOperationalAdapter'
import { unpublishedSqliteInstallation } from '@/platform/persistence/unpublishedInstallation'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { sqliteTargetIsEmpty } from '@/platform/persistence/migration/target/connection'
import { admitConversionTarget } from '@/platform/persistence/migration/target/admission'
import type { ConversionTargetConnection } from '@/platform/persistence/migration/run/types'
import { prepareEpoch2DatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { writeGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { maybePreMigrationBackup } from '@/platform/background/providerBackupScheduler'
import {
  planRestore,
  validateBackupForStage,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import { createSqliteMigrationSafetyBackup } from '@/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup'
import { readEpochBootFacts } from '@/modules/system-operations/infrastructure/epochSwitch/bootAdmission'
import {
  checkConfiguredDatabase,
  checkDbIntegrity,
  checkSealedCredentials,
} from '@/modules/system-operations/infrastructure/local/doctorDiagnostics'
import { tarGz } from '@/util/archive'

const generationId = 'dbg_rfc398_wal_fixture'
const directories: string[] = []
let templates: string
let manifest: SupportedSourceManifest
const previousHome = process.env.AGENT_WORKFLOW_HOME

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'aw-rfc398-wal-'))
  directories.push(path)
  return path
}
function noSidecars(path: string) {
  expect(existsSync(`${path}-wal`)).toBe(false)
  expect(existsSync(`${path}-shm`)).toBe(false)
  // SQLite file header read/write versions are both 2 for WAL mode.
  expect([...readFileSync(path).subarray(18, 20)]).toEqual([2, 2])
}
function fixture(kind: 'epoch1' | 'epoch2' = 'epoch1') {
  const home = directory()
  const path = join(home, 'db.sqlite')
  copyFileSync(join(templates, kind), path)
  noSidecars(path)
  const bytes = readFileSync(path)
  return { home, path, bytes, unchanged: () => expect(readFileSync(path)).toEqual(bytes) }
}
function publish(home: string) {
  const head = persistenceHead()
  writeGenerationPointerV2({
    pointerPath: join(home, 'database-generation.json'),
    payload: {
      version: 2,
      schemaEpoch: 2,
      generationId,
      provider: 'sqlite',
      role: 'installed',
      database: { kind: 'sqlite-file', relativePath: 'db.sqlite' },
      contractDigest: head.contract.contract.digest,
      planDigest: head.sqlite.digest,
      operationId: null,
      manifestDigest: null,
      activatedAt: 1,
      previous: null,
    },
  })
}
function composition(home: string) {
  return composeLocalEpochSwitchDependencies({
    appHome: home,
    config: DEFAULT_CONFIG,
    env: {},
    head: persistenceHead(),
    catalogArtifacts: persistencePostgresqlCatalogs(),
    sourceManifest: async () => manifest,
  })
}
beforeAll(async () => {
  templates = mkdtempSync(join(tmpdir(), 'aw-rfc398-templates-'))
  const history = await loadFrozenEpoch1History()
  const legacy = new Database(join(templates, 'epoch1'))
  try {
    createFrozenSqliteJournal(legacy)
    applyFrozenSqliteMigrations(legacy, history.sqlite)
    legacy.exec(
      "INSERT INTO maintenance_state (key, value, updated_at) VALUES ('rfc398', 'retained payload', 1)",
    )
  } finally {
    legacy.close()
  }
  // Switch journal mode on a fresh connection: the frozen-chain helper leaves cached statements
  // on the migrating connection, and changing journal_mode there fails with SQLITE_LOCKED.
  const walLegacy = new Database(join(templates, 'epoch1'))
  try {
    walLegacy.exec('PRAGMA journal_mode = WAL')
    walLegacy.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    walLegacy.close()
  }
  const current = new Database(join(templates, 'epoch2'))
  try {
    const history = schemaHistoryRuntime()
    installSqliteBaseline({ head: history.head(), metaTables: history.metaTables }, current, {
      generationId,
    })
    current.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    current.close()
  }
  manifest = await loadSupportedSourceManifest()
}, 90_000)
afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => {
  if (templates) rmSync(templates, { recursive: true, force: true })
})

describe('WAL open semantics', () => {
  test('helper reads a WAL database without sidecars; the old strict open is the negative control', () => {
    const f = fixture()
    expect(() => {
      const old = new Database(f.path, { readonly: true })
      try {
        old.query('SELECT count(*) FROM maintenance_state').get()
      } finally {
        old.close()
      }
    }).toThrow()
    f.unchanged()
    const db = openSqliteForRead(f.path)
    try {
      expect(db.query("SELECT value FROM maintenance_state WHERE key='rfc398'").get()).toEqual({
        value: 'retained payload',
      })
    } finally {
      db.close()
    }
    f.unchanged()
  })
  test('missing files are never created, including by quick_check', () => {
    const path = join(directory(), 'absent.sqlite')
    expect(() => openSqliteForRead(path)).toThrow()
    expect(quickCheckDbFile(path).ok).toBe(false)
    expect(existsSync(path)).toBe(false)
  })
  test('existing WAL stays read-only and its committed frames are not checkpointed on reader close', () => {
    const f = fixture()
    const writer = new Database(f.path)
    try {
      writer.exec('PRAGMA wal_autocheckpoint=0')
      writer.exec("UPDATE maintenance_state SET value='committed WAL bytes' WHERE key='rfc398'")
      const main = readFileSync(f.path)
      const wal = readFileSync(`${f.path}-wal`)
      expect(wal.length).toBeGreaterThan(0)
      const db = openSqliteForRead(f.path)
      try {
        expect(db.query("SELECT value FROM maintenance_state WHERE key='rfc398'").get()).toEqual({
          value: 'committed WAL bytes',
        })
        expect(() =>
          db.exec("UPDATE maintenance_state SET value='must fail' WHERE key='rfc398'"),
        ).toThrow()
      } finally {
        db.close()
      }
      for (const options of [
        undefined,
        { allowWalSidecarCreation: true },
        { allowWalSidecarCreation: false },
      ])
        expect(quickCheckDbFile(f.path, options).ok).toBe(true)
      expect(readFileSync(f.path)).toEqual(main)
      expect(readFileSync(`${f.path}-wal`)).toEqual(wal)
    } finally {
      writer.close()
    }
  })
})

const simpleReaders: readonly [
  string,
  (f: ReturnType<typeof fixture>) => unknown | Promise<unknown>,
][] = [
  [
    'db/integrity default',
    (f) => expect(quickCheckDbFile(f.path)).toEqual({ ok: true, errors: [] }),
  ],
  [
    'db/integrity explicit sidecar permission',
    (f) => expect(quickCheckDbFile(f.path, { allowWalSidecarCreation: true }).ok).toBe(true),
  ],
  [
    'sqlite/readonlySqliteDatabase',
    (f) => {
      const db = openReadonlySqliteDatabase(f.path)
      try {
        expect(
          db
            .query<{ value: string }, []>("SELECT value FROM maintenance_state WHERE key='rfc398'")
            .get()?.value,
        ).toBe('retained payload')
      } finally {
        db.close()
      }
    },
  ],
  [
    'migration/legacy/sqliteSnapshot VACUUM',
    (f) => {
      const dest = join(f.home, 'vacuum.sqlite')
      vacuumSqliteInto({ dbPath: f.path, dest })
      expect(quickCheckDbFile(dest).ok).toBe(true)
    },
  ],
  ['migration/legacy/sqliteSnapshot quick_check', (f) => quickCheckSqlite({ dbPath: f.path })],
  [
    'sqlite/systemBackupVacuum VACUUM',
    (f) => {
      const dest = join(f.home, 'vacuum.sqlite')
      systemVacuum({ dbPath: f.path, dest })
      expect(quickCheckDbFile(dest).ok).toBe(true)
    },
  ],
  ['sqlite/systemBackupVacuum quick_check', (f) => systemQuickCheck({ dbPath: f.path })],
  ['migration/legacy/backupManifest', (f) => expect(legacyIdentity(f.path)?.lastHash).toBeString()],
  ['sqlite/systemBackupManifest', (f) => expect(systemIdentity(f.path)?.lastHash).toBeString()],
  [
    'databaseOperationalAdapter doctor',
    async (f) =>
      expect(
        (await createSqliteDatabaseOperationalAdapter({ path: f.path, generationId }).doctor()).ok,
      ).toBe(true),
  ],
  [
    'epochSwitch/bootAdmission',
    (f) =>
      expect(readEpochBootFacts({ appHome: f.home, provider: 'sqlite' }).sourceExists).toBe(true),
  ],
  ['migration/target/connection', (f) => expect(sqliteTargetIsEmpty(f.path)).toBe(false)],
  [
    'bootstrap/epochMigrationEntry',
    async (f) => expect(await classifyRestoreArtifact(f.home)).toBe('epoch1'),
  ],
  [
    'migration/auditSourceEvidence allow-listed snapshot',
    (f) => {
      const evidence = captureEpoch1SqliteEvidence({
        sourcePath: f.path,
        operationRoot: join(f.home, 'audit'),
      })
      verifyEpoch1SqliteEvidence(evidence)
      expect(evidence.tableRows.maintenance_state).toBeGreaterThan(0)
      expect(evidence.pragmas.journal_mode).toEqual([{ journal_mode: 'delete' }])
    },
  ],
  [
    'sqliteMigrationSafetyBackup',
    async (f) => {
      const backup = await createSqliteMigrationSafetyBackup().create({
        operationId: 'dbm_rfc398_safety',
        sourcePath: f.path,
        operationRoot: join(f.home, 'safety'),
      })
      expect(quickCheckDbFile(backup.path).ok).toBe(true)
    },
  ],
]
for (const [name, read] of simpleReaders)
  test(`${name}: no sidecars, unchanged source`, async () => {
    const f = fixture()
    await read(f)
    f.unchanged()
  }, 30_000)

test('migration/sqliteSourceReader reads the live digest and a non-WAL private snapshot', async () => {
  const f = fixture()
  const reader = openEpoch1SqliteSource({
    path: f.path,
    manifest,
    operationRoot: join(f.home, 'read'),
  })
  try {
    const before = await reader.preflight()
    expect(before.fingerprint.tableRows.maintenance_state).toBeGreaterThan(0)
    expect((await reader.readChunk('maintenance_state', null, 100)).rows.length).toBeGreaterThan(0)
    await reader.assertUnchanged(before)
    const snapshot = new Database(reader.offlinePath(), { readonly: true })
    try {
      expect(snapshot.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    } finally {
      snapshot.close()
    }
  } finally {
    await reader.close()
  }
  f.unchanged()
}, 30_000)

test('migration/freeze/backup reads a missing-sidecar source and compares its private VACUUM copies', async () => {
  const f = fixture()
  const source = await openFrozenSource({
    manifest,
    emptyTables: [],
    operationRoot: join(f.home, 'source'),
    location: { kind: 'sqlite-file', path: f.path, pointerPath: join(f.home, 'pointer.json') },
  })
  try {
    // sourceAccess's sqlitePath is always this process's new non-WAL snapshot.
    const original = frozenSourceDetails(source).sqlitePath!
    const originalBytes = readFileSync(original)
    expect([...originalBytes.subarray(18, 20)]).toEqual([1, 1])
    const backup = await createSwitchBackup({
      sourcePath: f.path,
      destination: join(f.home, 'backups'),
      frozen: source,
      contentManifest: null,
    })
    expect(backup.kind).toBe('sqlite-vacuum')
    expect(quickCheckDbFile(join(backup.path!, 'db.sqlite')).ok).toBe(true)
    expect(readFileSync(original)).toEqual(originalBytes)
  } finally {
    await source.close()
  }
  f.unchanged()
}, 30_000)

test('unpublishedInstallation recognizes a WAL installed generation without sidecars', () => {
  const f = fixture('epoch2')
  expect(unpublishedSqliteInstallation(f.home)).toEqual({ generationId, path: f.path })
  f.unchanged()
})

test('databaseProviderRuntime quick_check and history read finish before the first write open', async () => {
  const f = fixture('epoch2')
  publish(f.home)
  const beforeWrite = new Error('rfc398-read-phases-complete')
  await expect(
    prepareEpoch2DatabaseProviderRuntime({
      config: { provider: 'sqlite' },
      sqlitePath: f.path,
      generationPointerPath: join(f.home, 'database-generation.json'),
      operationsRoot: join(f.home, 'database-migrations'),
      contract: logicalSchemaContract,
      sqliteOptions: {},
      backupOnMigration: false,
      beforeSqliteOpen() {
        throw beforeWrite
      },
    }),
  ).rejects.toBe(beforeWrite)
  f.unchanged()
})

test('doctorDiagnostics credentials, integrity and lifecycle readers use the published WAL database', async () => {
  const f = fixture('epoch2')
  publish(f.home)
  process.env.AGENT_WORKFLOW_HOME = f.home
  expect(checkSealedCredentials()).toMatchObject({ ok: true, message: 'no sealed credentials' })
  expect(checkDbIntegrity()).toMatchObject({ ok: true, message: 'quick_check ok' })
  let lifecycleRead = false
  const checks = await checkConfiguredDatabase(logicalSchemaContract, {
    async countLifecycleStates(source) {
      expect(source.provider).toBe('sqlite')
      if (source.provider !== 'sqlite') throw new Error('expected SQLite')
      expect(source.db.query('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 0 })
      lifecycleRead = true
      return { interrupted: 0, failed: 0, awaitingReview: 0, awaitingHuman: 0, quarantined: 0 }
    },
  })
  expect(lifecycleRead).toBe(true)
  expect(checks.map((check) => check.name)).toEqual([
    'database provider',
    'lifecycle',
    'repo credentials',
  ])
  expect(checks.every((check) => check.ok && !check.message.includes('unavailable'))).toBe(true)
  f.unchanged()
})

test('providerBackupScheduler reads the current history and does not create a spurious backup', async () => {
  const f = fixture('epoch2')
  expect(
    await maybePreMigrationBackup({ appHome: f.home, dbPath: f.path, enabled: true }),
  ).toBeNull()
  expect(existsSync(join(f.home, 'backups'))).toBe(false)
  f.unchanged()
})

test('sqliteLogicalSource opens and preflights a WAL file without sidecars', async () => {
  const f = fixture('epoch2')
  const source = openSqliteLogicalSource({ path: f.path, contract: logicalSchemaContract })
  try {
    const snapshot = await source.preflight()
    await source.assertUnchanged(snapshot)
    expect(snapshot.totalRows).toBeGreaterThan(0)
  } finally {
    await source.close()
  }
  f.unchanged()
})

test('systemProviderRestore history and skill-row probes accept a missing-sidecar backup', async () => {
  const f = fixture('epoch2')
  const archive = join(directory(), 'backup.tar.gz')
  await tarGz(f.home, archive)
  expect((await planRestore(archive, { appHome: directory() })).direction).toBe('same')
  // No skills directory: stage validation must query the empty skills table.
  expect(
    (
      await validateBackupForStage(archive, {
        appHome: directory(),
        contract: logicalSchemaContract,
      })
    ).direction,
  ).toBe('same')
  f.unchanged()
}, 30_000)

test('migration/target/admission reads the physical catalog without opening a write target', async () => {
  const f = fixture('epoch2')
  const target: ConversionTargetConnection = {
    provider: 'sqlite',
    async execute(sql, values) {
      // Readers opened by this fake may leave transient sidecars until Bun finalizes them, so
      // the no-sidecar precondition is asserted before admission and the bytes after it.
      if (sql === 'PRAGMA database_list') return [{ name: 'main', file: f.path }]
      const db = openSqliteForRead(f.path)
      try {
        return await sqliteHistoryConnection(db).execute(sql, values)
      } finally {
        db.close()
      }
    },
    async transaction() {
      throw new Error('catalog admission must only read')
    },
    async close() {},
  }
  noSidecars(f.path)
  await admitConversionTarget(target, {
    head: persistenceHead(),
    metaTables: schemaHistoryRuntime().metaTables,
    catalogCache: new HistoryCatalogCache(),
  })
  f.unchanged()
}, 30_000)

test('bootstrap/epochMigration targetEvidence reads the target and empty-table decisions read a private snapshot', async () => {
  const current = fixture('epoch2')
  const deps = composition(current.home)
  expect(
    await deps.targetEvidence!(generationId, { kind: 'sqlite-file', relativePath: 'db.sqlite' }),
  ).toEqual({ state: 'active', activationReceiptDigest: null })
  current.unchanged()
  const legacy = fixture()
  const decisions = await composition(legacy.home).resolveEmptyTables!({
    source: {
      kind: 'sqlite-file',
      path: legacy.path,
      pointerPath: join(legacy.home, 'pointer.json'),
    },
    decisions: [{ table: 'tasks', reason: 'RFC-398 empty-table read regression' }],
    operationRoot: join(legacy.home, 'decision'),
  })
  expect(decisions).toHaveLength(1)
  expect(decisions[0]?.table).toBe('tasks')
  legacy.unchanged()
}, 30_000)

// Exact expressions, not whole-file exemptions: a second unsafe open in any
// allow-listed file still fails. Each copy exception is exercised above.
const readOnlyAllowList = [
  {
    path: 'platform/persistence/sqlite/openForRead.ts',
    expression: 'new Database(path, { readonly: true })',
    reason: 'Existing -wal must not be checkpointed by a reader.',
  },
  {
    path: 'db/integrity.ts',
    expression: 'new Database(dbPath, { readonly: true })',
    reason:
      'Explicit allowWalSidecarCreation:false preserves strict reads of copied WAL; the default uses the helper.',
  },
  {
    path: 'platform/persistence/migration/sqliteSourceReader.ts',
    expression: 'new Database(copyPath, { readonly: true })',
    reason: 'copyPath was just produced by VACUUM INTO in this preflight.',
  },
  {
    path: 'platform/persistence/migration/auditSourceEvidence.ts',
    expression: 'new Database(path, { readonly: true })',
    reason: 'evidence.sqlite was just produced by VACUUM INTO in this call.',
  },
  {
    path: 'platform/persistence/migration/freeze/backup.ts',
    expression: 'new Database(target, { readonly: true })',
    reason: "target is this call's new VACUUM INTO backup.",
  },
  {
    path: 'platform/persistence/migration/freeze/backup.ts',
    expression: 'new Database(original, { readonly: true })',
    reason:
      'sourceAccess.sqlitePath is sqliteSourceReader.offlinePath(), a new VACUUM INTO snapshot.',
  },
  {
    path: 'bootstrap/epochMigration.ts',
    expression: 'new Database(snapshot.path, { readonly: true })',
    reason: 'captureLiveSqliteSnapshot just produced a non-WAL VACUUM INTO snapshot.',
  },
] as const
function strictOpenTexts(text: string): string[] {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true)
  const result: string[] = []
  function visit(node: ts.Node) {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'Database' &&
      /\breadonly\s*:\s*true\b/.test(node.arguments?.[1]?.getText(source) ?? '')
    )
      result.push(node.getText(source).replace(/\s+/g, ' '))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('source-text guard: strict Database opens occur only at documented exact allow-list sites', () => {
  const root = resolve(import.meta.dir, '../src')
  const paths = [...new Bun.Glob('**/*.ts').scanSync({ cwd: root })].sort()
  expect(paths.length).toBeGreaterThan(1000)
  const actual = paths.flatMap((path) =>
    strictOpenTexts(readFileSync(join(root, path), 'utf8')).map((expression) => ({
      path,
      expression,
    })),
  )
  const bySite = (
    a: { path: string; expression: string },
    b: { path: string; expression: string },
  ) => a.path.localeCompare(b.path) || a.expression.localeCompare(b.expression)
  expect(actual.sort(bySite)).toEqual(
    readOnlyAllowList.map(({ path, expression }) => ({ path, expression })).sort(bySite),
  )
  for (const entry of readOnlyAllowList) expect(entry.reason.length).toBeGreaterThan(20)
  // Scanner negative controls include multiline calls and nested path expressions.
  expect(
    strictOpenTexts("const a = new Database(join(root, 'db.sqlite'), {\n readonly: true,\n});"),
  ).toHaveLength(1)
  const extra = strictOpenTexts(
    'new Database(path, { readonly: true }); new Database(other, { readonly: true })',
  )
  expect(extra).toHaveLength(2)
  expect(extra[1]).not.toBe(readOnlyAllowList[0].expression)
  expect(
    strictOpenTexts(
      '// new Database(path, { readonly: true })\nconst db = new Database(path, { readwrite: true, create: false })',
    ),
  ).toEqual([])
})
