// RFC-349 — config supplies mechanism settings, while the verified generation
// pointer alone selects the live provider. Drift must fail closed.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DatabaseProviderRuntimeError,
  resolveDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  digestDatabaseArtifact,
  writeDatabaseGenerationAtomic,
} from '@/platform/persistence/generationStore'
import type { PostgresqlPool } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'

const roots: string[] = []
const contract: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 0,
  activeTableCount: 0,
  archiveOnlyTableCount: 0,
  tables: [],
  digest: `sha256:${'a'.repeat(64)}`,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-provider-runtime-'))
  roots.push(root)
  return {
    root,
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
  }
}

describe('RFC-349 database provider runtime resolution', () => {
  test('a missing pointer remains the zero-config SQLite generation', async () => {
    const paths = fixture()
    const resolved = resolveDatabaseProviderRuntime({
      ...paths,
      config: { provider: 'sqlite' },
      contract,
    })
    expect(resolved.provider).toBe('sqlite')
    expect(resolved.generation).toMatchObject({
      source: 'legacy-missing-pointer',
      payload: { provider: 'sqlite', generationId: 'dbg_legacy_sqlite' },
    })
    await resolved.close()
  })

  test('config cannot switch away from the verified generation by itself', () => {
    const paths = fixture()
    expect(() =>
      resolveDatabaseProviderRuntime({
        ...paths,
        config: {
          provider: 'postgresql',
          urlEnv: 'AW_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 1_000,
          statementTimeoutMs: 1_000,
          idleTimeoutMs: 1_000,
        },
        contract,
        env: { AW_DATABASE_URL: 'postgresql://fixture.invalid/database' },
      }),
    ).toThrow(DatabaseProviderRuntimeError)
  })

  test('a verified PostgreSQL generation builds one lazy external runtime', async () => {
    const paths = fixture()
    const operationId = 'dbm_provider_runtime_1234'
    const operationRoot = join(paths.operationsRoot, operationId)
    mkdirSync(operationRoot, { recursive: true })
    const manifest = '{}\n'
    writeFileSync(join(operationRoot, 'manifest.json'), manifest)
    writeDatabaseGenerationAtomic({
      pointerPath: paths.generationPointerPath,
      payload: {
        version: 1,
        generationId: 'dbg_pg_provider_runtime_1234',
        provider: 'postgresql',
        operationId,
        schemaDigest: contract.digest,
        manifestDigest: digestDatabaseArtifact(manifest),
        activatedAt: 1,
      },
    })
    let closed = 0
    const pool = {
      async close() {
        closed += 1
      },
    } as PostgresqlPool
    const resolved = resolveDatabaseProviderRuntime({
      ...paths,
      config: {
        provider: 'postgresql',
        urlEnv: 'AW_DATABASE_URL',
        poolMax: 4,
        connectTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
      },
      contract,
      env: { AW_DATABASE_URL: 'postgresql://fixture.invalid/database' },
      postgresqlPoolFactory: () => pool,
    })
    expect(resolved).toMatchObject({
      provider: 'postgresql',
      generation: { payload: { generationId: 'dbg_pg_provider_runtime_1234' } },
    })
    await resolved.close()
    expect(closed).toBe(1)
  })
})
