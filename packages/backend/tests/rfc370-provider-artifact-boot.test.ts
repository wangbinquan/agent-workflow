// RFC-370 A-T2: a host-supplied generation snapshot must pass the same provider
// selection as standalone files, without inventing local paths for PostgreSQL.
import { describe, expect, test } from 'bun:test'
import {
  DatabaseProviderRuntimeError,
  resolveDatabaseProviderRuntimeFromArtifacts,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  DatabaseGenerationError,
  digestDatabaseArtifact,
  digestGenerationPayload,
  type DatabaseGenerationArtifactReader,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'

const contract: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 0,
  activeTableCount: 0,
  archiveOnlyTableCount: 0,
  tables: [],
  digest: `sha256:${'a'.repeat(64)}`,
}
const config: DatabaseConfig = {
  provider: 'postgresql',
  urlEnv: 'AW_ARTIFACT_BOOT_URL',
  poolMax: 4,
  connectTimeoutMs: 1_000,
  statementTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
}
const env = { AW_ARTIFACT_BOOT_URL: 'postgresql://fixture.invalid/artifact_boot' }
const manifest = Buffer.from('{"phase":"finalized"}\n')
const generation: DatabaseGenerationPayload = {
  version: 1,
  generationId: 'dbg_hosted_artifact_fixture',
  provider: 'postgresql',
  operationId: 'dbm_hosted_artifact_fixture',
  schemaDigest: contract.digest,
  manifestDigest: digestDatabaseArtifact(manifest),
  activatedAt: 5,
}

function artifacts(
  value: DatabaseGenerationPayload | null = generation,
  manifestBytes: Uint8Array | null = manifest,
): DatabaseGenerationArtifactReader {
  return {
    pointerLabel: 'host installation snapshot',
    readPointer: () =>
      value === null
        ? null
        : JSON.stringify({ payload: value, digest: digestGenerationPayload(value) }),
    readManifest: (operationId) => (operationId === value?.operationId ? manifestBytes : null),
  }
}

describe('RFC-370 provider bootstrap from installation artifacts', () => {
  test.each([
    ['missing installation pointer', artifacts(null), DatabaseProviderRuntimeError],
    ['missing manifest', artifacts(generation, null), DatabaseGenerationError],
    ['wrong manifest', artifacts(generation, Buffer.from('wrong')), DatabaseGenerationError],
    [
      'older schema is not an admitted runtime',
      artifacts({ ...generation, schemaDigest: `sha256:${'b'.repeat(64)}` }),
      DatabaseGenerationError,
    ],
  ] as const)('%s fails before any external pool is created', (_label, source, errorType) => {
    let created = 0
    expect(() =>
      resolveDatabaseProviderRuntimeFromArtifacts({
        config,
        contract,
        env,
        generationArtifacts: source,
        postgresqlPoolFactory: () => {
          created += 1
          throw new Error('must not reach pool creation')
        },
      }),
    ).toThrow(errorType)
    expect(created).toBe(0)
  })

  test('a valid generation still cannot disagree with configured provider', () => {
    expect(() =>
      resolveDatabaseProviderRuntimeFromArtifacts({
        config: { provider: 'sqlite' },
        contract,
        generationArtifacts: artifacts(),
      }),
    ).toThrow(DatabaseProviderRuntimeError)
  })

  test('legacy SQLite remains available only with its actual local path', async () => {
    const input = {
      config: { provider: 'sqlite' } as const,
      contract,
      generationArtifacts: artifacts(null),
    }
    try {
      resolveDatabaseProviderRuntimeFromArtifacts(input)
      throw new Error('expected missing SQLite path to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseProviderRuntimeError)
      expect((error as DatabaseProviderRuntimeError).code).toBe(
        'database-provider-local-path-missing',
      )
    }
    const runtime = resolveDatabaseProviderRuntimeFromArtifacts({
      ...input,
      sqlitePath: ':memory:',
    })
    expect(runtime.generation.source).toBe('legacy-missing-pointer')
    expect(runtime.provider).toBe('sqlite')
    await runtime.close()
  })
})
