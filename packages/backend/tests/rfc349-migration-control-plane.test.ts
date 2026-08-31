// RFC-349 T7-A — durable one-click migration operation control plane.
// Locks the closed phase graph, digest chain, idempotent start, one owner,
// crash-safe CAS, cancellation and the first-live-write rollback horizon.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import {
  advanceDatabaseMigration,
  DATABASE_MIGRATION_PHASES,
  DatabaseMigrationStateError,
} from '@/modules/system-operations/domain/databaseMigration'
import {
  createFileDatabaseMigrationStore,
  DatabaseMigrationStoreError,
} from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'

const roots: string[] = []
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`
const TARGET = {
  provider: 'postgresql' as const,
  urlEnv: 'AW_DATABASE_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
}

function fixture(options?: {
  beforeReplaceForTest?: (operationId: string, revision: number) => void
  afterReplaceForTest?: (operationId: string, revision: number) => void
}) {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-operation-'))
  roots.push(root)
  const store = createFileDatabaseMigrationStore({ root, ...options })
  const control = createDatabaseMigrationControlPlane({
    store,
    newOperationId: () => 'dbm_operation_0001',
    newOwnerId: () => 'dbo_owner_0001',
  })
  return { root, store, control }
}

function start(control: ReturnType<typeof createDatabaseMigrationControlPlane>, now = 1000) {
  return control.start({
    idempotencyKey: 'settings-click-0001',
    sourceGenerationId: 'dbg_legacy_sqlite',
    sourceSchemaDigest: SCHEMA_DIGEST,
    sourceDatabaseFingerprint: 'sqlite:fixture',
    target: TARGET,
    tableCounts: { source: 184, active: 178, archiveOnly: 6 },
    ownerLeaseMs: 30_000,
    now,
  })
}

function lease(control: ReturnType<typeof createDatabaseMigrationControlPlane>) {
  return control.readManifest('dbm_operation_0001').payload.owner
}

function advance(
  control: ReturnType<typeof createDatabaseMigrationControlPlane>,
  expectedPhase: (typeof DATABASE_MIGRATION_PHASES)[number],
  nextPhase: (typeof DATABASE_MIGRATION_PHASES)[number],
  now: number,
) {
  const owner = lease(control)
  return control.advance('dbm_operation_0001', {
    expectedPhase,
    nextPhase,
    ownerId: owner.id,
    ownerFence: owner.fence,
    idempotencyKey: `phase-${nextPhase}-0001`,
    now,
    ...(nextPhase === 'preflighted' ? { targetDatabaseFingerprint: 'pg:fixture' } : {}),
    ...(nextPhase === 'backed-up' ? { logicalBackupDigest: ARTIFACT_DIGEST } : {}),
    ...(nextPhase === 'verifying' ? { verificationDigest: ARTIFACT_DIGEST } : {}),
    ...(nextPhase === 'finalized' ? { receiptDigest: ARTIFACT_DIGEST } : {}),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 migration control plane', () => {
  test('Settings/CLI duplicate start is idempotent and a different operation is rejected', () => {
    const { control } = fixture()
    const first = start(control)
    const duplicate = start(control, 2000)
    expect(duplicate).toEqual(first)

    expect(() =>
      control.start({
        idempotencyKey: 'different-request-0002',
        sourceGenerationId: 'dbg_legacy_sqlite',
        sourceSchemaDigest: SCHEMA_DIGEST,
        sourceDatabaseFingerprint: 'sqlite:fixture',
        target: TARGET,
        tableCounts: { source: 184, active: 178, archiveOnly: 6 },
        ownerLeaseMs: 30_000,
        now: 2000,
      }),
    ).toThrow('already active')
    expect(control.list()).toHaveLength(1)
  })

  test('all twelve phases advance once with a revision and previous-digest chain', () => {
    const { control } = fixture()
    start(control)
    for (let index = 0; index < DATABASE_MIGRATION_PHASES.length - 1; index += 1) {
      const expected = DATABASE_MIGRATION_PHASES[index]!
      const next = DATABASE_MIGRATION_PHASES[index + 1]!
      const before = control.readManifest('dbm_operation_0001')
      const status = advance(control, expected, next, 1100 + index)
      const after = control.readManifest('dbm_operation_0001')
      expect(status.phase).toBe(next)
      expect(after.payload.revision).toBe(before.payload.revision + 1)
      expect(after.payload.previousDigest).toBe(before.digest)
      expect(after.payload.checkpoints.at(-1)?.phase).toBe(next)
    }
    const final = control.readManifest('dbm_operation_0001')
    expect(final.payload.phase).toBe('finalized')
    expect(final.payload.revision).toBe(11)
    expect(final.payload.checkpoints).toHaveLength(11)
    expect(final.payload.receiptDigest).toBe(ARTIFACT_DIGEST)
  })

  test('phase skip and stale owner fence fail closed', () => {
    const { control } = fixture()
    start(control)
    const owner = lease(control)
    expect(() =>
      control.advance('dbm_operation_0001', {
        expectedPhase: 'planned',
        nextPhase: 'copying',
        ownerId: owner.id,
        ownerFence: owner.fence,
        idempotencyKey: 'illegal-phase-skip',
        now: 1100,
      }),
    ).toThrow(DatabaseMigrationStateError)

    control.fail('dbm_operation_0001', {
      ownerId: owner.id,
      ownerFence: owner.fence,
      category: 'target-unreachable',
      detailCode: 'target-connect-timeout',
      retryable: true,
      retryCount: 1,
      nextRetryAt: 40_000,
      now: 1200,
    })
    control.resume('dbm_operation_0001', {
      requesterOwnerId: owner.id,
      ownerLeaseMs: 30_000,
      now: 1300,
    })
    expect(() =>
      control.advance('dbm_operation_0001', {
        expectedPhase: 'planned',
        nextPhase: 'preflighted',
        ownerId: owner.id,
        ownerFence: owner.fence,
        idempotencyKey: 'stale-owner-fence',
        now: 1400,
      }),
    ).toThrow('owner fence is stale')
  })

  test('a new owner cannot take over before lease expiry but can resume after expiry', () => {
    const { control } = fixture()
    start(control)
    expect(() =>
      control.resume('dbm_operation_0001', {
        requesterOwnerId: 'dbo_owner_0002',
        ownerLeaseMs: 30_000,
        now: 10_000,
      }),
    ).toThrow('lease is active')
    const resumed = control.resume('dbm_operation_0001', {
      requesterOwnerId: 'dbo_owner_0002',
      ownerLeaseMs: 30_000,
      now: 31_001,
    })
    expect(resumed.revision).toBe(1)
    expect(control.readManifest(resumed.operationId).payload.owner).toEqual({
      id: 'dbo_owner_0002',
      fence: 2,
      leaseExpiresAt: 61_001,
    })
  })

  test('cancel is checkpointed before cutover and rejected once cutover begins', () => {
    const first = fixture()
    start(first.control)
    expect(first.control.requestCancel('dbm_operation_0001', 1100).cancelEligible).toBe(false)
    const cancelled = first.control.settleCancelled('dbm_operation_0001', 1200)
    expect(cancelled.failure?.category).toBe('cancelled')
    expect(cancelled.resumeEligible).toBe(true)

    const second = fixture()
    start(second.control)
    const phases = DATABASE_MIGRATION_PHASES.slice(0, 8)
    for (let index = 0; index < phases.length - 1; index += 1) {
      advance(second.control, phases[index]!, phases[index + 1]!, 2000 + index)
    }
    expect(second.control.get('dbm_operation_0001').phase).toBe('cutover-prepared')
    expect(() => second.control.requestCancel('dbm_operation_0001', 3000)).toThrow(
      'cannot cancel during cutover-prepared',
    )
  })

  test('first PostgreSQL live write permanently closes instant rollback', () => {
    const { control } = fixture()
    start(control)
    for (let index = 0; index < 10; index += 1) {
      advance(
        control,
        DATABASE_MIGRATION_PHASES[index]!,
        DATABASE_MIGRATION_PHASES[index + 1]!,
        2000 + index,
      )
    }
    expect(control.get('dbm_operation_0001').rollback).toEqual({
      eligible: true,
      reason: 'target-has-no-live-write',
    })
    const marked = control.markFirstLiveWrite('dbm_operation_0001', 3000)
    expect(marked.firstLiveWriteAt).toBe(3000)
    expect(marked.rollback).toEqual({
      eligible: false,
      reason: 'reverse-migration-required',
    })
  })

  test('instant rollback is durable, idempotent and terminal for resume/advance', () => {
    const { control } = fixture()
    start(control)
    for (let index = 0; index < 10; index += 1) {
      advance(
        control,
        DATABASE_MIGRATION_PHASES[index]!,
        DATABASE_MIGRATION_PHASES[index + 1]!,
        2000 + index,
      )
    }
    const rolledBack = control.markRolledBack('dbm_operation_0001', ARTIFACT_DIGEST, 3000)
    expect(rolledBack).toMatchObject({
      rolledBackAt: 3000,
      rollbackReceiptDigest: ARTIFACT_DIGEST,
      rollback: { eligible: false, reason: 'operation-rolled-back' },
    })
    expect(control.markRolledBack('dbm_operation_0001', ARTIFACT_DIGEST, 4000)).toEqual(
      rolledBack,
    )
    expect(() =>
      control.resume('dbm_operation_0001', {
        requesterOwnerId: 'dbo_owner_0001',
        ownerLeaseMs: 30_000,
        now: 5000,
      }),
    ).toThrow('rolled-back database migration cannot resume')
    expect(() =>
      advance(control, 'accepting-writes', 'finalized', 5001),
    ).toThrow('rolled-back database migration cannot advance')
  })

  test('file store CAS rejects stale writers and keeps the old revision on a pre-replace crash', () => {
    const initial = fixture()
    start(initial.control)
    const current = initial.control.readManifest('dbm_operation_0001')
    const owner = current.payload.owner
    const next = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase: 'planned',
      nextPhase: 'preflighted',
      ownerId: owner.id,
      ownerFence: owner.fence,
      idempotencyKey: 'preflight-checkpoint-0001',
      now: 1100,
    })
    initial.store.compareAndSwap(
      {
        operationId: current.payload.operationId,
        revision: current.payload.revision,
        digest: current.digest,
      },
      next,
    )
    expect(() =>
      initial.store.compareAndSwap(
        {
          operationId: current.payload.operationId,
          revision: current.payload.revision,
          digest: current.digest,
        },
        next,
      ),
    ).toThrow(DatabaseMigrationStoreError)

    const crashStore = createFileDatabaseMigrationStore({
      root: initial.root,
      beforeReplaceForTest(_operationId, revision) {
        if (revision === 2) throw new Error('crash-before-manifest-replace')
      },
    })
    const atRevisionOne = crashStore.read('dbm_operation_0001')!
    const revisionTwo = advanceDatabaseMigration(atRevisionOne, {
      expectedRevision: 1,
      expectedPhase: 'preflighted',
      nextPhase: 'source-frozen',
      ownerId: owner.id,
      ownerFence: owner.fence,
      idempotencyKey: 'source-freeze-checkpoint-0001',
      now: 1200,
    })
    expect(() =>
      crashStore.compareAndSwap(
        { operationId: 'dbm_operation_0001', revision: 1, digest: atRevisionOne.digest },
        revisionTwo,
      ),
    ).toThrow('crash-before-manifest-replace')
    expect(crashStore.read('dbm_operation_0001')?.payload.revision).toBe(1)
  })

  test('status remains readable without either business DB and manifest never contains a URL secret', () => {
    const { root, control, store } = fixture()
    const secret = 'postgresql://user:password@example.invalid/database'
    process.env.AW_DATABASE_URL = secret
    try {
      start(control)
      expect(control.get('dbm_operation_0001').targetUrlEnv).toBe('AW_DATABASE_URL')
      const bytes = readFileSync(join(root, 'dbm_operation_0001', 'manifest.json'), 'utf8')
      expect(bytes).not.toContain(secret)
      expect(bytes).not.toContain('password')
      expect(store.list()).toHaveLength(1)
    } finally {
      delete process.env.AW_DATABASE_URL
    }
  })

  test('manifest corruption fails closed instead of guessing a phase', () => {
    const { root, control, store } = fixture()
    start(control)
    writeFileSync(join(root, 'dbm_operation_0001', 'manifest.json'), '{broken')
    expect(() => store.read('dbm_operation_0001')).toThrow('manifest is corrupt')
  })
})
