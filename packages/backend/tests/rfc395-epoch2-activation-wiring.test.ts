import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, createInMemoryDb, DbCorruptionError } from '@/db/client'
import { prepareDatabaseProviderForBoot } from '@/modules/system-operations/composition'
import { acquireLock } from '@/util/lock'
import { extractTarGz } from '@/util/archive'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import {
  prepareEpoch2DatabaseProviderRuntime,
  resolveDatabaseProviderRuntime,
  currentSqlitePath,
  resolveDatabaseProviderRuntimeForRestore,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  readGenerationPointerV2,
  writeGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import {
  classifyEpochInstallation,
  readEpochBootFacts,
} from '@/modules/system-operations/composition/epochBootAdmission'
import { epochMigrationKeys } from '@/bootstrap/epochMigrationKeys'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  captureEpochMetadata,
  restoreEpochMetadata,
} from '@/platform/persistence/schema/history/metadataSnapshot'
import { sqliteHistoryConnection } from '@/platform/persistence/schema/history/connection'
const homes: string[] = []
const home = () => {
  const value = mkdtempSync(join(tmpdir(), 'aw-epoch2-activation-'))
  homes.push(value)
  return value
}

function preparation(root: string) {
  return {
    config: { provider: 'sqlite' as const },
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
    lockPath: join(root, 'daemon.lock'),
    contract: logicalSchemaContract,
    sqliteOptions: {},
  }
}

test('BF-D3 current installations allow backup/user/auth/package preparation while the daemon owns its lock', async () => {
  const options = preparation(home())
  const installed = await prepareDatabaseProviderForBoot(options)
  await installed.runtime.close()
  const pointer = readFileSync(options.generationPointerPath)
  const daemon = acquireLock(options.lockPath)
  try {
    for (const command of ['backup', 'user', 'auth', 'package']) {
      const prepared = await prepareDatabaseProviderForBoot(options)
      expect(prepared.runtime.provider, command).toBe('sqlite')
      await prepared.runtime.close()
      expect(readFileSync(options.generationPointerPath)).toEqual(pointer)
      expect(existsSync(options.lockPath)).toBeTrue()
    }
  } finally {
    daemon.release()
  }
})

test('BF-D3 fresh installation and unpublished adoption still require the daemon lock', async () => {
  const options = preparation(home())
  const lock = acquireLock(options.lockPath)
  try {
    await expect(prepareDatabaseProviderForBoot(options)).rejects.toThrow('daemon already running')
    expect(existsSync(options.generationPointerPath)).toBeFalse()
  } finally {
    lock.release()
  }
  const installed = await prepareDatabaseProviderForBoot(options)
  await installed.runtime.close()
  rmSync(options.generationPointerPath)
  const daemon = acquireLock(options.lockPath)
  try {
    await expect(prepareDatabaseProviderForBoot(options)).rejects.toThrow('daemon already running')
    expect(existsSync(options.generationPointerPath)).toBeFalse()
  } finally {
    daemon.release()
  }
})

for (const caller of ['boot', 'migrate'] as const)
  test(`BF-D4 ${caller} surfaces RFC-213 corruption before history reads and retains a raw safety copy`, async () => {
    const root = home()
    const options = preparation(root)
    const installed = await prepareDatabaseProviderForBoot(options)
    await installed.runtime.close()
    const path = currentSqlitePath(options.generationPointerPath, options.sqlitePath)
    const corrupt = Buffer.from('not a SQLite database: BF-D4')
    writeFileSync(path, corrupt)
    const daemon = caller === 'boot' ? acquireLock(options.lockPath) : undefined
    try {
      await expect(
        prepareDatabaseProviderForBoot({ ...options, lock: daemon }),
      ).rejects.toBeInstanceOf(DbCorruptionError)
      const backups = readdirSync(join(root, 'backups')).filter((name) =>
        name.startsWith('pre-migration-unknown-'),
      )
      expect(backups).toHaveLength(1)
      const extracted = join(root, 'raw-copy')
      mkdirSync(extracted)
      await extractTarGz(join(root, 'backups', backups[0]!), extracted)
      expect(readFileSync(join(extracted, 'db.sqlite'))).toEqual(corrupt)
      expect(readFileSync(path)).toEqual(corrupt)
    } finally {
      daemon?.release()
    }
  })
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
test('fresh installation writes pointer v2 and one active installed generation', async () => {
  const root = home(),
    path = join(root, 'db.sqlite')
  const prepared = await prepareEpoch2DatabaseProviderRuntime({
    config: { provider: 'sqlite' },
    sqlitePath: path,
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
    contract: logicalSchemaContract,
    sqliteOptions: {},
  })
  try {
    const pointer = readGenerationPointerV2(join(root, 'database-generation.json'))
    expect(pointer.payload).toMatchObject({
      version: 2,
      schemaEpoch: 2,
      role: 'installed',
      database: {
        kind: 'sqlite-file',
        relativePath: `databases/${pointer.payload.generationId}/db.sqlite`,
      },
      contractDigest: persistenceHead().contract.contract.digest,
    })
    expect(
      classifyEpochInstallation(readEpochBootFacts({ appHome: root, provider: 'sqlite' })).kind,
    ).toBe('epoch2')
  } finally {
    await prepared.runtime.close()
  }
  const reopened = openDb({ path: currentSqlitePath(join(root, 'database-generation.json'), path) })
  try {
    expect(
      reopened.$client
        .query("SELECT role,state FROM aw_meta_generations WHERE state='active'")
        .all(),
    ).toEqual([{ role: 'installed', state: 'active' }])
  } finally {
    reopened.$client.close()
  }
})
test('an old database is refused without replaying epoch-1 SQL', () => {
  const path = join(home(), 'db.sqlite'),
    native = new Database(path)
  native.exec('CREATE TABLE epoch1_only (id TEXT PRIMARY KEY)')
  native.close()
  expect(() => openDb({ path })).toThrow()
  const check = new Database(path, { readonly: true })
  try {
    expect(check.query("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([
      { name: 'epoch1_only' },
    ])
  } finally {
    check.close()
  }
})
test('first-write marker is atomic with failed and committed business writes', () => {
  const db = createInMemoryDb({ bootstrap: 'required' })
  const marker = () =>
    db.$client.query('SELECT first_live_write_at AS value FROM aw_meta_first_write').get() as {
      value: number | null
    }
  try {
    expect(marker().value).toBeNull()
    expect(() => db.$client.exec("INSERT INTO auth_login_policy (id) VALUES ('global')")).toThrow()
    expect(marker().value).toBeNull()
    db.$client.query("UPDATE auth_login_policy SET updated_at=updated_at+1 WHERE id='global'").run()
    expect(marker().value).not.toBeNull()
  } finally {
    db.$client.close()
  }
})
test('metadata replay retains lineage and retires the previous active generation', async () => {
  const a = openDb({ path: join(home(), 'db.sqlite'), generationId: 'dbg_source_metadata' }),
    b = openDb({ path: join(home(), 'db.sqlite'), generationId: 'dbg_target_metadata' })
  try {
    const snapshot = await captureEpochMetadata(sqliteHistoryConnection(a.$client))
    await restoreEpochMetadata(sqliteHistoryConnection(b.$client), snapshot)
    await restoreEpochMetadata(sqliteHistoryConnection(b.$client), snapshot)
    expect(
      b.$client.query("SELECT count(*) AS n FROM aw_meta_generations WHERE state='retired'").get(),
    ).toEqual({ n: 1 })
    expect(
      b.$client.query("SELECT count(*) AS n FROM aw_meta_generations WHERE state='active'").get(),
    ).toEqual({ n: 1 })
  } finally {
    a.$client.close()
    b.$client.close()
  }
})
test('converter key provider reopens the original backup key and never creates missing keys', async () => {
  const root = home(),
    input = {
      root: { kind: 'backup', root, runsSupplied: false, objects: 'none' },
    } as BootUpgradeCaptureInput
  const provider = epochMigrationKeys()
  expect(await provider.open(input)).toBeNull()
  const key = Buffer.alloc(32, 8)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'secret.key'), key)
  const opened = await provider.open(input)
  expect(opened!.box.unseal(createSecretBoxFromKey(key).seal('original'))).toBe('original')
  const before = readFileSync(join(root, 'secret.key'))
  await provider.open(input)
  expect(readFileSync(join(root, 'secret.key'))).toEqual(before)
  writeFileSync(join(root, 'secret.key'), Buffer.alloc(32, 9))
  expect((await provider.open(input))!.fingerprint).not.toBe(opened!.fingerprint)
})

test('pointer v2 resolves the converted SQLite file rather than the default file', async () => {
  const root = home(),
    file = join(root, 'generations', 'target.sqlite'),
    pointerPath = join(root, 'database-generation.json')
  mkdirSync(join(root, 'generations'), { recursive: true })
  const client = openDb({ path: file, generationId: 'dbg_selected_sqlite' })
  client.$client.close()
  const head = persistenceHead()
  writeGenerationPointerV2({
    pointerPath,
    payload: {
      version: 2,
      schemaEpoch: 2,
      generationId: 'dbg_selected_sqlite',
      provider: 'sqlite',
      role: 'installed',
      database: { kind: 'sqlite-file', relativePath: 'generations/target.sqlite' },
      contractDigest: head.contract.contract.digest,
      planDigest: head.sqlite.digest,
      operationId: null,
      manifestDigest: null,
      activatedAt: 1,
      previous: null,
    },
  })
  expect(currentSqlitePath(pointerPath, join(root, 'db.sqlite'))).toBe(file)
  const runtime = resolveDatabaseProviderRuntime({
    config: { provider: 'sqlite' },
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: pointerPath,
    operationsRoot: join(root, 'database-migrations'),
    contract: logicalSchemaContract,
  })
  try {
    if (runtime.provider !== 'sqlite') throw new Error('fixture provider mismatch')
    expect(runtime.sqlitePath).toBe(file)
    expect(
      runtime.openClient({}).$client.query('SELECT generation_id FROM aw_meta_generations').get(),
    ).toEqual({ generation_id: 'dbg_selected_sqlite' })
  } finally {
    await runtime.close()
  }
})

test('AF-D6 adopts the exact installed SQLite head left before pointer publication', async () => {
  const root = home(),
    generationId = 'dbg_unpublished_native_head'
  const path = join(root, 'databases', generationId, 'db.sqlite')
  const created = openDb({ path, generationId })
  created.$client.close()
  expect(
    classifyEpochInstallation(readEpochBootFacts({ appHome: root, provider: 'sqlite' })).kind,
  ).toBe('fresh')
  const prepared = await prepareEpoch2DatabaseProviderRuntime({
    config: { provider: 'sqlite' },
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
    contract: logicalSchemaContract,
    sqliteOptions: {},
  })
  try {
    expect(prepared.runtime.generation.payload.generationId).toBe(generationId)
    expect(
      readGenerationPointerV2(join(root, 'database-generation.json')).payload.database,
    ).toEqual({ kind: 'sqlite-file', relativePath: `databases/${generationId}/db.sqlite` })
    expect(readdirSync(join(root, 'databases'))).toEqual([generationId])
    expect(existsSync(join(root, 'db.sqlite'))).toBeFalse()
    expect(prepared.describeSchemaOutcome()).toBe(`migrations applied (database: ${path})\n`)
  } finally {
    await prepared.runtime.close()
  }
})
test('AF-D6 refuses an unpublished SQLite head that has already accepted business writes', async () => {
  const root = home(),
    path = join(root, 'databases/dbg_unpublished_used/db.sqlite')
  const db = openDb({ path, generationId: 'dbg_unpublished_used' })
  db.$client.exec('UPDATE auth_login_policy SET updated_at=3')
  db.$client.close()
  await expect(
    prepareEpoch2DatabaseProviderRuntime({
      config: { provider: 'sqlite' },
      sqlitePath: join(root, 'db.sqlite'),
      generationPointerPath: join(root, 'database-generation.json'),
      operationsRoot: join(root, 'database-migrations'),
      contract: logicalSchemaContract,
      sqliteOptions: {},
    }),
  ).rejects.toThrow('epoch2-unpublished-installation-not-adoptable')
  expect(existsSync(join(root, 'database-generation.json'))).toBeFalse()
})
test('AF-D13 a maintenance skipMigrations connection has the same generation fence', () => {
  const path = join(home(), 'db.sqlite'),
    initial = openDb({ path })
  initial.$client.close()
  const worker = openDb({ path, skipMigrations: true }),
    metadata = new Database(path)
  try {
    metadata.exec("UPDATE aw_meta_generations SET state='retired'")
    expect(() => worker.$client.exec('UPDATE auth_login_policy SET updated_at=8')).toThrow(
      'sqlite-generation-fence-rejected',
    )
    expect(metadata.query('SELECT first_live_write_at FROM aw_meta_first_write').get()).toEqual({
      first_live_write_at: null,
    })
  } finally {
    worker.$client.close()
    metadata.close()
  }
})
test('AF-D8 empty-home restore selection creates neither database nor pointer during planning', async () => {
  const root = home()
  const runtime = resolveDatabaseProviderRuntimeForRestore({
    config: { provider: 'sqlite' },
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
    contract: logicalSchemaContract,
  })
  try {
    if (runtime.provider !== 'sqlite') throw new Error('fixture')
    expect(runtime.sqlitePath).toBe(
      join(root, 'databases', runtime.generation.payload.generationId, 'db.sqlite'),
    )
    expect(existsSync(runtime.sqlitePath)).toBeFalse()
    expect(existsSync(join(root, 'database-generation.json'))).toBeFalse()
  } finally {
    await runtime.close()
  }
})

test('AF-D8 a backup uses its own key or an installation key that decrypts the sealed source', async () => {
  const backupRoot = home(),
    installationRoot = home(),
    key = Buffer.alloc(32, 7),
    wrong = Buffer.alloc(32, 9)
  const sealed = createSecretBoxFromKey(key).seal('https://fixture.invalid/repo')
  const input = {
    root: { kind: 'backup', root: backupRoot, runsSupplied: false, objects: 'none' },
    source: {
      preflight: { tables: [{ table: 'cached_repos' }], expectedAbsent: [] },
      reader: {
        async readChunk() {
          return { rows: [], decodedRows: [{ url_enc: sealed }], lastKey: null }
        },
      },
    },
  } as unknown as BootUpgradeCaptureInput
  writeFileSync(join(installationRoot, 'secret.key'), key)
  const selected = await epochMigrationKeys(undefined, installationRoot).open(input)
  expect(selected!.box.unseal(sealed)).toBe('https://fixture.invalid/repo')
  writeFileSync(join(installationRoot, 'secret.key'), wrong)
  await expect(epochMigrationKeys(undefined, installationRoot).open(input)).rejects.toThrow()
  writeFileSync(join(backupRoot, 'secret.key'), key)
  expect((await epochMigrationKeys(undefined, installationRoot).open(input))!.identity).toBe(
    join(backupRoot, 'secret.key'),
  )
})
