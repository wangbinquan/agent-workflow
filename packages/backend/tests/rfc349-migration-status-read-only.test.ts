// RFC-349 —— 迁移状态是只读的，不许因为读一次状态就去开一个 target runtime。
//
// 由来是真外置 PostgreSQL 的托管取证跑：割接完成到 finalize 之间，
// `GET /api/database/migrations/:id` 与 `GET /api/database` 都会走
// coordinator 的 `withRunner`，而 `withRunner` 会
//   1) `createPostgresqlDatabaseRuntime(...)` —— 新建一个 poolMax 条连接的连接池；
//   2) `openPostgresqlLogicalTarget(...)` —— 抢 operation 级 advisory lock。
// 8 个并发轮询于是互相抢锁（`another process owns the PostgreSQL logical
// migration target`），并把服务端连接打爆（`sorry, too many clients already`），
// 随后整条 PostgreSQL 面级联失败：`SET TRANSACTION ISOLATION LEVEL must be called
// before any query`、`Failed query: commit`……全是与调用方无关的 500。
//
// 判据用「目标环境变量根本不存在」当探针：真去开 runtime 就会以
// `postgresql-url-env-missing` 失败，不去开就安静返回 manifest。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import {
  createDatabaseMigrationCoordinator,
  isDatabaseMigrationTargetProbeUnavailable,
} from '@/modules/system-operations/infrastructure/databaseMigrationCoordinator'
import { PostgresqlLogicalTargetError } from '@/platform/persistence/postgresqlLogicalTarget'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { DATABASE_MIGRATION_PHASES } from '@/modules/system-operations/domain/databaseMigration'

const roots: string[] = []
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`
const OPERATION_ID = 'dbm_operation_0001'
const TARGET = {
  provider: 'postgresql' as const,
  // Deliberately absent from `env` below: opening a target runtime fails loudly.
  urlEnv: 'RFC349_STATUS_READ_ONLY_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function acceptingWrites(): {
  readonly root: string
  readonly operationsRoot: string
  readonly control: ReturnType<typeof createDatabaseMigrationControlPlane>
} {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-status-read-only-'))
  roots.push(root)
  const operationsRoot = join(root, 'database-migrations')
  const control = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: operationsRoot }),
    newOperationId: () => OPERATION_ID,
    newOwnerId: () => 'dbo_owner_0001',
  })
  control.start({
    idempotencyKey: 'settings-click-0001',
    sourceGenerationId: 'dbg_legacy_sqlite',
    sourceSchemaDigest: SCHEMA_DIGEST,
    sourceDatabaseFingerprint: 'sqlite:fixture',
    target: TARGET,
    tableCounts: { source: 184, active: 178, archiveOnly: 6 },
    ownerLeaseMs: 30_000,
    now: 1_000,
  })
  for (const [index, phase] of DATABASE_MIGRATION_PHASES.entries()) {
    const next = DATABASE_MIGRATION_PHASES[index + 1]
    if (next === undefined) break
    const owner = control.readManifest(OPERATION_ID).payload.owner
    control.advance(OPERATION_ID, {
      expectedPhase: phase,
      nextPhase: next,
      ownerId: owner.id,
      ownerFence: owner.fence,
      idempotencyKey: `phase-${next}-0001`,
      now: 1_100 + index,
      ...(next === 'preflighted' ? { targetDatabaseFingerprint: 'pg:fixture' } : {}),
      ...(next === 'backed-up' ? { logicalBackupDigest: ARTIFACT_DIGEST } : {}),
      ...(next === 'verifying' ? { verificationDigest: ARTIFACT_DIGEST } : {}),
      ...(next === 'finalized' ? { receiptDigest: ARTIFACT_DIGEST } : {}),
    })
    if (next === 'accepting-writes') break
  }
  expect(control.get(OPERATION_ID).phase).toBe('accepting-writes')
  return { root, operationsRoot, control }
}

function coordinatorOn(root: string, operationsRoot: string) {
  return createDatabaseMigrationCoordinator({
    sqlitePath: join(root, 'db.sqlite'),
    operationsRoot,
    generationPointerPath: join(root, 'database-generation.json'),
    env: {},
    admission: {
      async freezeAndDrain() {},
      async reopenSqlite() {},
      async activatePostgresql() {},
      async openPostgresqlAdmission() {},
    },
    activateTargetConfig() {},
    activateSourceConfig() {},
  })
}

describe('RFC-349 migration status stays read-only', () => {
  test('a recorded first live write means status never opens a target runtime again', async () => {
    const { root, operationsRoot, control } = acceptingWrites()
    control.markFirstLiveWrite(OPERATION_ID, 2_000)
    const coordinator = coordinatorOn(root, operationsRoot)

    // Concurrent pollers, exactly what the hosted evidence run does.
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () => coordinator.get({ operationId: OPERATION_ID })),
    )
    for (const status of statuses) {
      expect(status.phase).toBe('accepting-writes')
      expect(status.firstLiveWriteAt).toBe(2_000)
    }
    const [listed] = await coordinator.list()
    expect(listed?.firstLiveWriteAt).toBe(2_000)
  })

  test('a held operation lock is "probe later", every other failure still propagates', () => {
    // The daemon composes one coordinator per provider composition, so the
    // runner that owns the operation-scoped advisory lock during a migration is
    // routinely a different instance from the one answering status polls. The
    // hosted evidence run showed every concurrent poller taking the same
    // `another process owns the PostgreSQL logical migration target` as a 500.
    expect(
      isDatabaseMigrationTargetProbeUnavailable(
        new PostgresqlLogicalTargetError(
          'postgresql-target-lock-held',
          'another process owns the PostgreSQL logical migration target',
        ),
      ),
    ).toBe(true)
    expect(
      isDatabaseMigrationTargetProbeUnavailable(
        new PostgresqlLogicalTargetError('postgresql-target-generation-fence', 'fenced'),
      ),
    ).toBe(false)
    expect(isDatabaseMigrationTargetProbeUnavailable(new Error('boom'))).toBe(false)

    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'system-operations',
        'infrastructure',
        'databaseMigrationCoordinator.ts',
      ),
      'utf8',
    )
    expect(source).toContain('if (isDatabaseMigrationTargetProbeUnavailable(error)) return status')
  })

  test('an unrecorded first live write still probes the target, and only once at a time', async () => {
    const { root, operationsRoot } = acceptingWrites()
    const coordinator = coordinatorOn(root, operationsRoot)

    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => coordinator.get({ operationId: OPERATION_ID })),
    )
    // The probe is real: with no target URL in the environment it fails, and it
    // fails the same way for every caller because they share the one attempt.
    expect(settled.every((entry) => entry.status === 'rejected')).toBe(true)
    for (const entry of settled) {
      expect((entry as PromiseRejectedResult).reason).toMatchObject({
        code: 'postgresql-url-env-missing',
      })
    }
  })
})
