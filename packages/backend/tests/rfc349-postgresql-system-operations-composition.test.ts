import type { DatabaseConfig } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composePostgresqlSystemOperations } from '@/modules/system-operations/composition'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 PostgreSQL System Operations composition', () => {
  test('mounts one recovery surface and exposes its cold pending-restore hook', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-pg-system-operations-'))
    roots.push(appHome)
    const digest = `sha256:${'a'.repeat(64)}`
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_postgresql_composition_01',
    } as PostgresqlDatabaseRuntime
    const databaseConfig = {
      provider: 'postgresql',
      urlEnv: 'COMPOSITION_DATABASE_URL',
      poolMax: 16,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    } satisfies Extract<DatabaseConfig, { provider: 'postgresql' }>
    const contract = { digest } as LogicalSchemaContract
    const plan = { contractDigest: digest } as PostgresqlSchemaPlan

    const systemOperations = composePostgresqlSystemOperations({
      runtime,
      databaseConfig,
      appHome,
      contract,
      plan,
      repositoryBackupPreparation: {
        async prepare() {
          return { sealed: 0, linked: 0, scrubbed: 0 }
        },
      },
    })

    expect(String(systemOperations.operations.requestBackup.id)).toBe(
      'system-operations.request-backup.v1',
    )
    expect(String(systemOperations.operations.stageRestore.id)).toBe(
      'system-operations.stage-restore.v1',
    )
    await expect(systemOperations.applyPendingRestore()).resolves.toBe(false)
  })

  test('rejects a schema plan from another logical contract', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-pg-system-operations-mismatch-'))
    roots.push(appHome)
    expect(() =>
      composePostgresqlSystemOperations({
        runtime: {
          provider: 'postgresql',
          generationId: 'dbg_postgresql_composition_01',
        } as PostgresqlDatabaseRuntime,
        databaseConfig: {
          provider: 'postgresql',
          urlEnv: 'COMPOSITION_DATABASE_URL',
          poolMax: 16,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
        appHome,
        contract: { digest: `sha256:${'a'.repeat(64)}` } as LogicalSchemaContract,
        plan: { contractDigest: `sha256:${'b'.repeat(64)}` } as PostgresqlSchemaPlan,
        repositoryBackupPreparation: {
          async prepare() {
            return { sealed: 0, linked: 0, scrubbed: 0 }
          },
        },
      }),
    ).toThrow('postgresql-system-operations-schema-plan-mismatch')
  })
})
