import type { DatabaseConfig } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composePostgresqlSystemOperations } from '@/modules/system-operations/composition'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import type { AdminBackupCoordinatorPort } from '@/modules/system-operations/application/ports/adminBackupCoordinator'

const roots: string[] = []
// Shared by the composition cases below; the runtime is an opaque identity — no case issues SQL through it.
const RUNTIME = {
  provider: 'postgresql',
  generationId: 'dbg_postgresql_composition_01',
} as PostgresqlDatabaseRuntime
const DATABASE_CONFIG = {
  provider: 'postgresql',
  urlEnv: 'COMPOSITION_DATABASE_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
} satisfies Extract<DatabaseConfig, { provider: 'postgresql' }>
const DIGEST = `sha256:${'a'.repeat(64)}`

function composeFixture(input: {
  readonly backup?: AdminBackupCoordinatorPort
  readonly prepare: () => Promise<{ sealed: number; linked: number; scrubbed: number }>
}) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc426-pg-system-operations-'))
  roots.push(appHome)
  return composePostgresqlSystemOperations({
    headContract: logicalSchemaContract,
    runtime: RUNTIME,
    db: {} as PersistenceDb,
    ...(input.backup === undefined ? {} : { backup: input.backup }),
    databaseConfig: DATABASE_CONFIG,
    appHome,
    contract: { digest: DIGEST } as LogicalSchemaContract,
    plan: { contractDigest: DIGEST } as PostgresqlSchemaPlan,
    repositoryBackupPreparation: { prepare: input.prepare },
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 PostgreSQL System Operations composition', () => {
  test('mounts one recovery surface and exposes its cold pending-restore hook', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-pg-system-operations-'))
    roots.push(appHome)
    const contract = { digest: DIGEST } as LogicalSchemaContract
    const plan = { contractDigest: DIGEST } as PostgresqlSchemaPlan

    const systemOperations = composePostgresqlSystemOperations({
      headContract: logicalSchemaContract,
      runtime: RUNTIME,
      db: {} as PersistenceDb,
      databaseConfig: DATABASE_CONFIG,
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
        headContract: logicalSchemaContract,
        runtime: {
          provider: 'postgresql',
          generationId: 'dbg_postgresql_composition_01',
        } as PostgresqlDatabaseRuntime,
        db: {} as PersistenceDb,
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

  // RFC-426: a scheduled backup is the deployment's backup coordinator asked for `{ includeWorktrees: false, kind:
  // 'scheduled' }`. Before RFC-426 the provider adapter table sent standalone PostgreSQL through the manual backup
  // command, which drops the kind, so those scheduled backups were written as manual `agent-workflow-*` archives.
  test('RFC-426 hosted: the scheduled backup reaches the selected platform backup once; manual input unchanged', async () => {
    const requests: unknown[] = []
    const systemOperations = composeFixture({
      backup: {
        async request(input) {
          requests.push(input)
          return {
            path: 'object-reference',
            sizeBytes: 1,
            contents: { workflows: 0, skills: 0, db: true, config: true },
          }
        },
      },
      prepare: async () => ({ sealed: 0, linked: 0, scrubbed: 0 }),
    })

    await systemOperations.scheduledBackup()
    expect(requests).toEqual([{ includeWorktrees: false, kind: 'scheduled' }])
    await systemOperations.application.commands.requestBackup.execute(
      systemOperations.localContext,
      { includeWorktrees: true },
    )
    expect(requests).toEqual([
      { includeWorktrees: false, kind: 'scheduled' },
      { includeWorktrees: true },
    ])
  })

  test('RFC-426 standalone: without a selected platform backup the local PostgreSQL coordinator runs it', async () => {
    const marker = new Error('rfc426-local-coordinator-entered')
    const systemOperations = composeFixture({
      prepare: async () => {
        throw marker
      },
    })
    // The local coordinator's first step is its preparation; reaching it proves the path.
    await expect(systemOperations.scheduledBackup()).rejects.toBe(marker)
  })
})
