// RFC-349 — config supplies mechanism settings, while the verified generation
// pointer alone selects the live provider. Drift must fail closed.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveDatabaseProviderRuntime,
  prepareEpoch2DatabaseProviderRuntime,
  resolveDatabaseProviderRuntimeFromArtifacts,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  writeGenerationPointerV2,
  type GenerationPointerV2Payload,
} from '@/platform/persistence/generationPointerV2'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import { logicalSchemaContract as contract } from '@/bootstrap/persistenceSchema'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import type {
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const roots: string[] = []

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

function rows(values: readonly Record<string, unknown>[] = []): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

describe('RFC-349 database provider runtime resolution', () => {
  test('a fresh zero-config installation is admitted before the runtime resolves its pointer', async () => {
    const paths = fixture()
    const options = {
      ...paths,
      config: { provider: 'sqlite' as const },
      contract,
      sqliteOptions: {},
    }
    const prepared = await prepareEpoch2DatabaseProviderRuntime(options)
    await prepared.runtime.close()
    const resolved = resolveDatabaseProviderRuntime(options)
    expect(resolved.provider).toBe('sqlite')
    expect(resolved.generation).toMatchObject({
      source: 'epoch2-pointer',
      payload: { provider: 'sqlite' },
      pointer: { payload: { schemaEpoch: 2, role: 'installed' } },
    })
    await resolved.close()
  })

  test('config cannot switch away from the verified generation by itself', async () => {
    const paths = fixture()
    writeGenerationPointerV2({
      pointerPath: paths.generationPointerPath,
      payload: {
        version: 2,
        schemaEpoch: 2,
        role: 'installed',
        generationId: 'dbg_sqlite_provider_runtime',
        provider: 'sqlite',
        database: { kind: 'sqlite-file', relativePath: 'db.sqlite' },
        contractDigest: persistenceHead().contract.contract.digest,
        planDigest: persistenceHead().sqlite.digest,
        operationId: null,
        manifestDigest: null,
        activatedAt: 1,
        previous: null,
      },
    })
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
    })
    // RFC-395 migration §7: pointer v2 is the provider-selection authority.
    expect(resolved.provider).toBe('sqlite')
    expect(resolved.generation.payload.generationId).toBe('dbg_sqlite_provider_runtime')
    if (resolved.provider !== 'sqlite') throw new Error('config changed the active provider')
    expect(resolved.sqlitePath).toBe(paths.sqlitePath)
    await resolved.close()
  })

  // RFC-370: use this same runtime lifecycle oracle for file and injected
  // artifact sources. The injected arm supplies no local installation paths.
  test('a verified PostgreSQL generation builds one lazy external runtime', async () => {
    for (const source of ['files', 'artifacts'] as const) {
      const paths = fixture()
      const operationId = 'dbm_provider_runtime_1234'
      const payload: GenerationPointerV2Payload = {
        version: 2,
        schemaEpoch: 2,
        role: 'installed',
        database: { kind: 'postgresql-target', profileRef: 'env:AW_DATABASE_URL' },
        previous: null,
        generationId: 'dbg_pg_provider_runtime_1234',
        provider: 'postgresql',
        operationId,
        contractDigest: persistenceHead().contract.contract.digest,
        planDigest: persistenceHead().postgresql.digest,
        manifestDigest: null,
        activatedAt: 1,
      }
      if (source === 'files') {
        writeGenerationPointerV2({ pointerPath: paths.generationPointerPath, payload })
      }
      let closed = 0
      let reserves = 0
      const connection: PostgresqlReservedConnection = withNativeTransactions({
        unsafe() {
          return rows()
        },
        release() {},
      })
      const pool: PostgresqlPool = {
        async reserve() {
          reserves += 1
          return connection
        },
        unsafe() {
          return rows()
        },
        async close() {
          closed += 1
        },
      }
      const options = {
        config: {
          provider: 'postgresql' as const,
          urlEnv: 'AW_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 1_000,
          statementTimeoutMs: 1_000,
          idleTimeoutMs: 1_000,
        },
        contract,
        env: { AW_DATABASE_URL: 'postgresql://fixture.invalid/database' },
        postgresqlPoolFactory: () => pool,
      }
      const resolved =
        source === 'files'
          ? resolveDatabaseProviderRuntime({ ...options, ...paths })
          : resolveDatabaseProviderRuntimeFromArtifacts({
              ...options,
              generationArtifacts: {
                pointerLabel: 'loaded installation',
                readPointer: () =>
                  JSON.stringify({ payload, digest: digestSchemaContract(payload) }),
                readManifest: () => {
                  throw new Error('native pointer must not read an epoch-1 manifest')
                },
              },
            })
      expect(resolved).toMatchObject({
        provider: 'postgresql',
        generation: { payload: { generationId: 'dbg_pg_provider_runtime_1234' } },
      })
      expect(reserves).toBe(0)
      if (resolved.provider !== 'postgresql') throw new Error('wrong runtime')
      expect(resolved.openClient()).toBe(resolved.openClient())
      await resolved.close()
      expect(closed).toBe(1)
      expect(reserves).toBe(0)
    }
  })
})
