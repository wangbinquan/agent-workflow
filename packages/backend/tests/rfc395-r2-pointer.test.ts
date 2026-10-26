// RFC-395 II-b R2: v2-only runtime reads, single-commit-point crash oracles and byte-exact pre-write rollback.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  parseGenerationPointerV2,
  readGenerationPointerV2,
  restorePreviousPointerBytes,
  writeGenerationPointerV2,
  type GenerationPointerV2Payload,
  type PointerCrashPoint,
} from '@/platform/persistence/generationPointerV2'
import { readMigrationSourcePointer } from '@/platform/persistence/migration/generationPointerSource'
import {
  digestGenerationPayload,
  parseDatabaseGenerationText,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import {
  installSqliteGeneration,
  resolveSqliteGenerationDatabase,
  retainCompletedSqliteSource,
  sqliteGenerationLayout,
} from '@/platform/persistence/sqliteGenerationDirectory'

const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'rfc395-r2-pointer-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
const hash = digestSchemaContract('fixture')
function payload(): GenerationPointerV2Payload {
  return {
    version: 2,
    schemaEpoch: 2,
    generationId: 'dbg_rfc395_pointer',
    provider: 'sqlite',
    role: 'installed',
    database: { kind: 'sqlite-file', relativePath: 'databases/dbg_rfc395_pointer/db.sqlite' },
    contractDigest: hash,
    planDigest: hash,
    operationId: null,
    manifestDigest: null,
    activatedAt: 1,
    previous: null,
  }
}
describe('RFC-395 R2 generation pointer', () => {
  test('round trip keeps the exact v2 payload and provider-specific database location', () => {
    const path = join(root(), 'database-generation.json')
    expect(writeGenerationPointerV2({ pointerPath: path, payload: payload() })).toEqual(
      readGenerationPointerV2(path),
    )
    const pg: GenerationPointerV2Payload = {
      ...payload(),
      provider: 'postgresql',
      database: { kind: 'postgresql-target', profileRef: 'target-database' },
      previous: { generationId: 'dbg_prior_generation', pointerDigest: hash },
    }
    writeGenerationPointerV2({ pointerPath: path, payload: pg })
    expect(readGenerationPointerV2(path).payload).toEqual(pg)
    const text = readFileSync(path, 'utf8').replace('target-database', 'changed-database')
    expect(() => parseGenerationPointerV2(text)).toThrow('generation-pointer-digest-mismatch')
  })
  test('runtime v2 rejects v1; migration reader accepts it and rollback preserves every byte', () => {
    const path = join(root(), 'database-generation.json')
    const v1: DatabaseGenerationPayload = {
      version: 1,
      generationId: 'dbg_old_generation',
      provider: 'sqlite',
      operationId: null,
      schemaDigest: hash,
      manifestDigest: null,
      activatedAt: 0,
    }
    const bytes = Buffer.from(
      `  ${JSON.stringify({ digest: digestGenerationPayload(v1), payload: v1 }, null, 4)}\n\n`,
    )
    writeFileSync(path, bytes)
    expect(() => readGenerationPointerV2(path)).toThrow()
    const source = readMigrationSourcePointer(path)
    expect(source.pointer!.payload.version).toBe(1)
    writeGenerationPointerV2({ pointerPath: path, payload: payload() })
    expect(() => parseDatabaseGenerationText(readFileSync(path, 'utf8'), path)).toThrow(
      'failed validation',
    )
    restorePreviousPointerBytes({
      pointerPath: path,
      previousBytes: source.bytes,
      firstLiveWriteAt: null,
    })
    expect(readFileSync(path)).toEqual(bytes)
    writeGenerationPointerV2({ pointerPath: path, payload: payload() })
    expect(() =>
      restorePreviousPointerBytes({
        pointerPath: path,
        previousBytes: bytes,
        firstLiveWriteAt: 12,
      }),
    ).toThrow('after-first-write')
    expect(readGenerationPointerV2(path).payload.version).toBe(2)
  })
  test('a source with no pointer rolls back to no pointer', () => {
    const path = join(root(), 'database-generation.json')
    const source = readMigrationSourcePointer(path)
    expect(source).toEqual({ bytes: null, pointer: null })
    writeGenerationPointerV2({ pointerPath: path, payload: payload() })
    restorePreviousPointerBytes({
      pointerPath: path,
      previousBytes: source.bytes,
      firstLiveWriteAt: null,
    })
    expect(existsSync(path)).toBe(false)
  })
  for (const point of [
    'temp-written',
    'temp-synced',
    'renamed',
    'directory-synced',
  ] satisfies PointerCrashPoint[])
    test(`crash at ${point} leaves one complete old or new authority`, () => {
      const path = join(root(), 'database-generation.json')
      writeGenerationPointerV2({ pointerPath: path, payload: payload() })
      const previous = readFileSync(path)
      const next = { ...payload(), activatedAt: 2 }
      expect(() =>
        writeGenerationPointerV2({
          pointerPath: path,
          payload: next,
          onCrashPoint: (at) => {
            if (at === point) throw new Error('crash')
          },
        }),
      ).toThrow('crash')
      if (point === 'temp-written' || point === 'temp-synced')
        expect(readFileSync(path)).toEqual(previous)
      else expect(readGenerationPointerV2(path).payload).toEqual(next)
    })
  for (const role of ['converted', 'restored'] as const)
    test(`${role} requires an operation, independently of provider`, () => {
      const path = join(root(), 'database-generation.json')
      expect(() =>
        writeGenerationPointerV2({ pointerPath: path, payload: { ...payload(), role } }),
      ).toThrow('requires operationId')
      writeGenerationPointerV2({
        pointerPath: path,
        payload: { ...payload(), role, operationId: 'dbm_rfc395_operation' },
      })
      expect(readGenerationPointerV2(path).payload.role).toBe(role)
    })
  test('new install uses the generation directory and always publishes v2 after the database exists', async () => {
    const directory = root()
    const installed = await installSqliteGeneration({
      root: directory,
      generationId: payload().generationId,
      schemaEpoch: 2,
      contractDigest: hash,
      planDigest: hash,
      activatedAt: 4,
      initialize: (path) => {
        // SQLite generation installation must create the actual on-disk database at the chosen path.
        const db = new Database(path)
        db.exec('CREATE TABLE example (id TEXT PRIMARY KEY)')
        db.close()
      },
    })
    expect(installed.databasePath).toBe(
      join(directory, 'databases', payload().generationId, 'db.sqlite'),
    )
    expect(installed.pointer.payload.role).toBe('installed')
    expect(readGenerationPointerV2(installed.pointerPath)).toEqual(installed.pointer)
    expect(resolveSqliteGenerationDatabase(directory, installed.pointer.payload)).toBe(
      installed.databasePath,
    )
    expect(sqliteGenerationLayout(payload().generationId, directory).relativePath).toBe(
      payload().database.kind === 'sqlite-file' ? 'databases/dbg_rfc395_pointer/db.sqlite' : '',
    )
  })
  test('source and WAL/SHM move only at completed and remain byte-identical', () => {
    const directory = root()
    const source = join(directory, 'old.sqlite')
    // SQLite source retention moves the database bytes together with its WAL/SHM sidecars.
    const db = new Database(source)
    db.exec('CREATE TABLE kept (id TEXT PRIMARY KEY)')
    db.close()
    writeFileSync(`${source}-wal`, 'wal-fixture')
    writeFileSync(`${source}-shm`, 'shm-fixture')
    const original = ['', '-wal', '-shm'].map((suffix) => readFileSync(`${source}${suffix}`))
    const input = {
      root: directory,
      operationId: 'dbm_rfc395_operation',
      sourceDatabasePath: source,
    }
    expect(() => retainCompletedSqliteSource({ ...input, phase: 'verified' })).toThrow(
      'requires-completed',
    )
    expect(readFileSync(source)).toEqual(original[0]!)
    const targets = retainCompletedSqliteSource({ ...input, phase: 'completed' })
    expect(targets.map((path) => readFileSync(path))).toEqual(original)
    expect(targets[0]).toBe(
      join(directory, 'database-migrations', input.operationId, 'source', 'db.sqlite'),
    )
    expect(existsSync(source)).toBe(false)
    expect(retainCompletedSqliteSource({ ...input, phase: 'completed' })).toEqual(targets)
  })
})

test('writer verifies readback and rejects operation IDs outside the v1 format', () => {
  const path = join(root(), 'database-generation.json')
  for (const operationId of ['arbitrary', 'dbm_short', 'dbm_bad space 123'])
    expect(() =>
      writeGenerationPointerV2({
        pointerPath: path,
        payload: { ...payload(), role: 'converted', operationId },
      }),
    ).toThrow()
  expect(() =>
    writeGenerationPointerV2({
      pointerPath: path,
      payload: payload(),
      onCrashPoint(point) {
        if (point === 'directory-synced') {
          const changed = { ...payload(), activatedAt: 99 }
          writeFileSync(
            path,
            JSON.stringify({ payload: changed, digest: digestSchemaContract(changed) }),
          )
        }
      },
    }),
  ).toThrow('generation-pointer-readback-mismatch')
})
