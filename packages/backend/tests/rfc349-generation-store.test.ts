// RFC-349 T3 — the live database provider is selected only by a durable,
// digest-verified generation pointer. These cases lock legacy SQLite fallback,
// fail-closed corruption behavior, manifest binding and crash-safe replacement.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DatabaseGenerationError,
  digestDatabaseArtifact,
  digestGenerationPayload,
  readDatabaseGeneration,
  writeDatabaseGenerationAtomic,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationStore'

const roots: string[] = []
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-generation-'))
  roots.push(root)
  return {
    root,
    pointerPath: join(root, 'database-generation.json'),
    migrationsDir: join(root, 'database-migrations'),
  }
}

function postgresqlPayload(
  overrides: Partial<DatabaseGenerationPayload> = {},
): DatabaseGenerationPayload {
  return {
    version: 1,
    generationId: 'dbg_postgresql_01',
    provider: 'postgresql',
    operationId: 'dbm_operation_01',
    schemaDigest: SCHEMA_DIGEST,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    activatedAt: 1_788_000_000_000,
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 database generation store', () => {
  test('missing pointer resolves to the backwards-compatible SQLite generation', () => {
    const paths = fixture()
    expect(readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toEqual({
      source: 'legacy-missing-pointer',
      payload: {
        version: 1,
        generationId: 'dbg_legacy_sqlite',
        provider: 'sqlite',
        operationId: null,
        schemaDigest: SCHEMA_DIGEST,
        manifestDigest: null,
        activatedAt: 0,
      },
    })
  })

  test('atomically writes, read-backs and verifies a PostgreSQL manifest binding', () => {
    const paths = fixture()
    const manifest = '{"operationId":"dbm_operation_01","phase":"switched"}\n'
    const manifestDir = join(paths.migrationsDir, 'dbm_operation_01')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'manifest.json'), manifest)
    const payload = postgresqlPayload({ manifestDigest: digestDatabaseArtifact(manifest) })

    writeDatabaseGenerationAtomic({ pointerPath: paths.pointerPath, payload })

    expect(readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toEqual({
      source: 'verified-pointer',
      payload,
    })
    const onDisk = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as {
      payload: DatabaseGenerationPayload
      digest: string
    }
    expect(onDisk.payload).toEqual(payload)
    expect(onDisk.digest).toBe(digestGenerationPayload(payload))
    if (process.platform !== 'win32') expect(statSync(paths.pointerPath).mode & 0o777).toBe(0o600)
  })

  test('corrupt pointer, payload digest and binary schema drift fail closed', () => {
    const paths = fixture()
    writeFileSync(paths.pointerPath, '{broken')
    expect(() => readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toThrow(
      DatabaseGenerationError,
    )

    const sqlitePayload: DatabaseGenerationPayload = {
      version: 1,
      generationId: 'dbg_sqlite_0001',
      provider: 'sqlite',
      operationId: null,
      schemaDigest: SCHEMA_DIGEST,
      manifestDigest: null,
      activatedAt: 1,
    }
    writeDatabaseGenerationAtomic({ pointerPath: paths.pointerPath, payload: sqlitePayload })
    const file = JSON.parse(readFileSync(paths.pointerPath, 'utf8')) as Record<string, unknown>
    file.digest = `sha256:${'0'.repeat(64)}`
    writeFileSync(paths.pointerPath, JSON.stringify(file))
    expect(() => readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toThrow(
      'pointer digest mismatch',
    )

    writeDatabaseGenerationAtomic({ pointerPath: paths.pointerPath, payload: sqlitePayload })
    expect(() =>
      readDatabaseGeneration({
        ...paths,
        expectedSchemaDigest: `sha256:${'c'.repeat(64)}`,
      }),
    ).toThrow('schema digest does not match')
  })

  test('missing or changed referenced manifest fails closed', () => {
    const paths = fixture()
    const payload = postgresqlPayload()
    writeDatabaseGenerationAtomic({ pointerPath: paths.pointerPath, payload })
    expect(() => readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toThrow(
      'manifest is missing',
    )

    const manifestDir = join(paths.migrationsDir, payload.operationId!)
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(join(manifestDir, 'manifest.json'), '{}')
    expect(() => readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST })).toThrow(
      'manifest digest mismatch',
    )
  })

  test('crash before replace preserves the old generation; crash after replace leaves the new one readable', () => {
    const paths = fixture()
    const oldPayload: DatabaseGenerationPayload = {
      version: 1,
      generationId: 'dbg_sqlite_old_01',
      provider: 'sqlite',
      operationId: null,
      schemaDigest: SCHEMA_DIGEST,
      manifestDigest: null,
      activatedAt: 1,
    }
    const newPayload = { ...oldPayload, generationId: 'dbg_sqlite_new_01', activatedAt: 2 }
    writeDatabaseGenerationAtomic({ pointerPath: paths.pointerPath, payload: oldPayload })

    expect(() =>
      writeDatabaseGenerationAtomic({
        pointerPath: paths.pointerPath,
        payload: newPayload,
        beforeReplaceForTest: () => {
          throw new Error('crash-before-replace')
        },
      }),
    ).toThrow('crash-before-replace')
    expect(
      readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST }).payload,
    ).toEqual(oldPayload)

    expect(() =>
      writeDatabaseGenerationAtomic({
        pointerPath: paths.pointerPath,
        payload: newPayload,
        afterReplaceForTest: () => {
          throw new Error('crash-after-replace')
        },
      }),
    ).toThrow('crash-after-replace')
    expect(
      readDatabaseGeneration({ ...paths, expectedSchemaDigest: SCHEMA_DIGEST }).payload,
    ).toEqual(newPayload)
  })

  test('strict payload rejects secret-shaped or unknown connection fields', () => {
    const paths = fixture()
    expect(() =>
      writeDatabaseGenerationAtomic({
        pointerPath: paths.pointerPath,
        payload: {
          ...postgresqlPayload(),
          url: 'postgresql://user:secret@example.invalid/database',
        } as DatabaseGenerationPayload,
      }),
    ).toThrow()
  })
})
