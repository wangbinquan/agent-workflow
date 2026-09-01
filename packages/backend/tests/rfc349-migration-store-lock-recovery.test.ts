// RFC-349 T7-A — a process crash may leave the short manifest CAS lock file
// behind. The next owner must recover a dead/stale token without weakening the
// revision+digest+owner fence on the durable manifest itself.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
} from '@/modules/system-operations/domain/databaseMigration'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'

const roots: string[] = []
const DIGEST = `sha256:${'a'.repeat(64)}`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function manifest() {
  return createDatabaseMigrationManifest({
    operationId: 'dbm_lock_recovery_01',
    idempotencyKey: 'lock-recovery-start',
    sourceGenerationId: 'dbg_source_0001',
    sourceSchemaDigest: DIGEST,
    sourceDatabaseFingerprint: 'sqlite:fixture',
    target: {
      provider: 'postgresql',
      urlEnv: 'RFC349_DATABASE_URL',
      poolMax: 4,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    },
    ownerId: 'dbo_owner_0001',
    ownerLeaseExpiresAt: 60_000,
    tableCounts: { source: 1, active: 1, archiveOnly: 0 },
    now: 1,
  })
}

describe('RFC-349 migration manifest lock recovery', () => {
  test('reclaims a dead process lock and preserves manifest CAS', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-lock-'))
    roots.push(root)
    const store = createFileDatabaseMigrationStore({
      root,
      now: () => 10_000,
      isProcessAlive: () => false,
    })
    const current = store.create(manifest())
    const operationRoot = join(root, current.payload.operationId)
    mkdirSync(operationRoot, { recursive: true })
    writeFileSync(
      join(operationRoot, '.manifest.lock'),
      'version=1\npid=999999\ncreatedAt=9999\nnonce=dead-process-token\n',
    )

    const next = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase: 'planned',
      nextPhase: 'preflighted',
      ownerId: current.payload.owner.id,
      ownerFence: current.payload.owner.fence,
      idempotencyKey: 'lock-recovery-preflighted',
      targetDatabaseFingerprint: 'pg:fixture',
      now: 2,
    })
    const committed = store.compareAndSwap(
      { operationId: current.payload.operationId, revision: 0, digest: current.digest },
      next,
    )
    expect(committed.payload).toMatchObject({ revision: 1, phase: 'preflighted' })
    expect(store.read(current.payload.operationId)?.digest).toBe(committed.digest)
  })

  test('does not steal a live lock even after its stale-age threshold', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-lock-'))
    roots.push(root)
    const store = createFileDatabaseMigrationStore({
      root,
      now: () => 10_000,
      isProcessAlive: () => true,
      staleLockMs: 100,
    })
    const current = store.create(manifest())
    writeFileSync(
      join(root, current.payload.operationId, '.manifest.lock'),
      'version=1\npid=1234\ncreatedAt=1\nnonce=live-process-token\n',
    )
    const next = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase: 'planned',
      nextPhase: 'preflighted',
      ownerId: current.payload.owner.id,
      ownerFence: current.payload.owner.fence,
      idempotencyKey: 'lock-recovery-preflighted',
      targetDatabaseFingerprint: 'pg:fixture',
      now: 2,
    })
    expect(() =>
      store.compareAndSwap(
        { operationId: current.payload.operationId, revision: 0, digest: current.digest },
        next,
      ),
    ).toThrow('being updated')
    expect(store.read(current.payload.operationId)?.payload.revision).toBe(0)
  })

  test('reclaims an old corrupt token only after it is observably stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-lock-'))
    roots.push(root)
    const store = createFileDatabaseMigrationStore({
      root,
      now: () => 10_000,
      isProcessAlive: () => {
        throw new Error('a corrupt token must not probe an unknown process')
      },
      staleLockMs: 100,
    })
    const current = store.create(manifest())
    const lockPath = join(root, current.payload.operationId, '.manifest.lock')
    writeFileSync(lockPath, 'partial-lock-record')
    utimesSync(lockPath, 1, 1)
    const next = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase: 'planned',
      nextPhase: 'preflighted',
      ownerId: current.payload.owner.id,
      ownerFence: current.payload.owner.fence,
      idempotencyKey: 'lock-recovery-preflighted',
      targetDatabaseFingerprint: 'pg:fixture',
      now: 2,
    })

    expect(
      store.compareAndSwap(
        { operationId: current.payload.operationId, revision: 0, digest: current.digest },
        next,
      ).payload.revision,
    ).toBe(1)
  })
})
