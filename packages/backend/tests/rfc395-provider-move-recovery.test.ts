// BF-D2: boot never resumes a parked/failed/cancelled move merely because it
// shares the live source. Only a healthy pointer binding or active cutover wins.
import { setDefaultTimeout, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { prepareDatabaseProviderForBoot } from '@/modules/system-operations/composition'
import {
  writeGenerationPointerV2,
  readGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { recoverEpoch2ProviderMove } from '@/modules/system-operations/infrastructure/local/epoch2ProviderMoveRecovery'
import { createDatabaseMigrationCoordinator } from '@/modules/system-operations/infrastructure/databaseMigrationCoordinator'
import {
  DATABASE_MIGRATION_PHASES,
  type DatabaseMigrationPhase,
} from '@/modules/system-operations/domain/databaseMigration'

// Slowest case took 3.08 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const digest = `sha256:${'a'.repeat(64)}`
const operationId = 'dbm_boot_recovery_01'
const sourceGenerationId = 'dbg_boot_source_01'
const targetGenerationId = `dbg_pg_${operationId.slice(4)}`
function fixture(phase: DatabaseMigrationPhase = 'planned', pointerBound = false) {
  const root = mkdtempSync(join(tmpdir(), 'rfc395-move-recovery-'))
  roots.push(root)
  const operationsRoot = join(root, 'database-migrations')
  const generationPointerPath = join(root, 'database-generation.json')
  const control = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: operationsRoot }),
    newOperationId: () => operationId,
    newOwnerId: () => 'dbo_boot_owner_01',
  })
  const target = {
    provider: 'postgresql' as const,
    urlEnv: 'BF_DATABASE_URL',
    poolMax: 1,
    connectTimeoutMs: 5000,
    statementTimeoutMs: 30000,
    idleTimeoutMs: 30000,
  }
  control.start({
    idempotencyKey: 'boot-recovery',
    sourceGenerationId,
    sourceSchemaDigest: logicalSchemaContract.digest,
    sourceDatabaseFingerprint: 'sqlite:source',
    target,
    tableCounts: {
      source: logicalSchemaContract.tables.length,
      active: logicalSchemaContract.activeTableCount,
      archiveOnly: 0,
    },
    ownerLeaseMs: 60000,
    now: 1,
  })
  let now = 2
  const advanceTo = (end: DatabaseMigrationPhase) => {
    const phases = DATABASE_MIGRATION_PHASES
    while (control.get(operationId).phase !== end) {
      const manifest = control.readManifest(operationId)
      const nextPhase = phases[phases.indexOf(manifest.payload.phase) + 1]!
      control.advance(operationId, {
        expectedPhase: manifest.payload.phase,
        nextPhase,
        ownerId: manifest.payload.owner.id,
        ownerFence: manifest.payload.owner.fence,
        idempotencyKey: `boot-${nextPhase}`,
        now: now++,
        sourceBackupDigest: digest,
        logicalBackupDigest: digest,
        legacyArchiveDigest: digest,
        verificationDigest: digest,
      })
    }
  }
  advanceTo(phase)
  const head = persistenceHead()
  const publish = (bound: boolean) =>
    writeGenerationPointerV2({
      pointerPath: generationPointerPath,
      payload: {
        version: 2,
        schemaEpoch: 2,
        generationId: bound ? targetGenerationId : sourceGenerationId,
        provider: bound ? 'postgresql' : 'sqlite',
        role: 'installed',
        database: bound
          ? { kind: 'postgresql-target', profileRef: 'env:BF_DATABASE_URL' }
          : { kind: 'sqlite-file', relativePath: 'retained.sqlite' },
        contractDigest: head.contract.contract.digest,
        planDigest: bound ? head.postgresql.digest : head.sqlite.digest,
        operationId: bound ? operationId : null,
        manifestDigest: bound ? digest : null,
        activatedAt: 1,
        previous: null,
      },
    })
  publish(pointerBound)
  const events: string[] = []
  const options = {
    config: { provider: 'sqlite' as const },
    contract: logicalSchemaContract,
    sqlitePath: join(root, 'retained.sqlite'),
    generationPointerPath,
    operationsRoot,
    lockPath: join(root, 'daemon.lock'),
    sqliteOptions: {},
    env: { BF_DATABASE_URL: 'postgresql://localhost/bf_recovery' },
    requireUpgradeLock() {
      events.push('lock')
    },
  }
  const manifestBytes = () => readFileSync(join(operationsRoot, operationId, 'manifest.json'))
  const resume = async () => {
    events.push('resume')
    publish(true)
    advanceTo('accepting-writes')
    return control.get(operationId)
  }
  const fail = () => {
    const { owner, phase } = control.readManifest(operationId).payload
    control.fail(operationId, {
      ownerId: owner.id,
      ownerFence: owner.fence,
      category: 'target-schema',
      detailCode: `failed-${phase}`,
      retryable: false,
      retryCount: 0,
      nextRetryAt: null,
      now: now++,
    })
  }
  return {
    control,
    options,
    events,
    manifestBytes,
    resume,
    fail,
  }
}

for (const state of ['copying', 'failed', 'cancelled', 'cancellation-requested'] as const)
  test(`a source-bound ${state} move is left unchanged and does not inspect the target`, async () => {
    const f = fixture('copying')
    if (state === 'failed') f.fail()
    if (state === 'cancelled' || state === 'cancellation-requested')
      f.control.requestCancel(operationId, 20)
    if (state === 'cancelled') f.control.settleCancelled(operationId, 21)
    const before = f.manifestBytes()
    await recoverEpoch2ProviderMove({ ...f.options, env: {} }, f.resume)
    expect(f.events).toEqual([])
    expect(f.manifestBytes()).toEqual(before)
    expect(readGenerationPointerV2(f.options.generationPointerPath).payload.generationId).toBe(
      sourceGenerationId,
    )
    const source = createSqliteBaseline({ generationId: sourceGenerationId })
    try {
      writeFileSync(f.options.sqlitePath, source.serialize())
    } finally {
      source.close()
    }
    const prepared = await prepareDatabaseProviderForBoot({ ...f.options, env: {} })
    try {
      expect(prepared.runtime.provider).toBe('sqlite')
    } finally {
      await prepared.runtime.close()
    }
    expect(f.manifestBytes()).toEqual(before)
  })

for (const state of ['failed', 'cancelled', 'cancellation-requested'] as const)
  test(`a pointer-bound ${state} move refuses boot without clearing its manifest`, async () => {
    const f = fixture(state === 'failed' ? 'switched' : 'copying', true)
    if (state === 'failed') f.fail()
    else {
      f.control.requestCancel(operationId, 20)
      if (state === 'cancelled') f.control.settleCancelled(operationId, 21)
    }
    const before = f.manifestBytes()
    await expect(recoverEpoch2ProviderMove(f.options, f.resume)).rejects.toMatchObject({
      code: 'database-migration-resume-required',
    })
    expect(f.events).toEqual([])
    expect(f.manifestBytes()).toEqual(before)
  })

test('a healthy pointer-bound move is settled under the lock', async () => {
  const f = fixture('switched', true)
  await recoverEpoch2ProviderMove(f.options, f.resume)
  expect(f.events).toEqual(['lock', 'resume'])
  expect(f.control.get(operationId).phase).toBe('accepting-writes')
})

test('an accepting-writes pointer needs no recovery lock, but a recorded failure still refuses boot', async () => {
  const f = fixture('accepting-writes', true)
  await recoverEpoch2ProviderMove(f.options, f.resume)
  expect(f.events).toEqual([])
  f.fail()
  const before = f.manifestBytes()
  await expect(recoverEpoch2ProviderMove(f.options, f.resume)).rejects.toMatchObject({
    code: 'database-migration-resume-required',
  })
  expect(f.manifestBytes()).toEqual(before)
  expect(f.events).toEqual([])
})

describeV3Providers('provider move recovery probes a real target generation', (h) => {
  if (h.targetProvider !== 'postgresql') return
  for (const state of ['prepared', 'active'] as const)
    test(`a crash before pointer publication resumes only the matching active target: ${state}`, async () => {
      const f = fixture('switched')
      await h.installHead()
      const pool = h.runtime.providerPool()
      await pool.unsafe(
        "INSERT INTO agent_workflow_meta.generations (generation_id,schema_epoch,role,state,provider,operation_id,source_generation_id,contract_digest,plan_digest,created_at) VALUES ($1,2,'converted',$2,'postgresql',$3,$4,$5,$6,1)",
        [
          targetGenerationId,
          state,
          operationId,
          sourceGenerationId,
          h.head.contract.contract.digest,
          h.head.postgresql.digest,
        ],
      )
      await pool.unsafe(
        "INSERT INTO agent_workflow_meta.generations (generation_id,schema_epoch,role,state,provider,operation_id,contract_digest,plan_digest,created_at) VALUES ('dbg_unrelated_active',2,'converted','active','postgresql','dbm_unrelated_operation',$1,$2,1)",
        [h.head.contract.contract.digest, h.head.postgresql.digest],
      )
      const before = f.manifestBytes()
      await recoverEpoch2ProviderMove({ ...f.options, postgresqlPoolFactory: () => pool }, f.resume)
      // The production probe owns and closes the actual target pool on both outcomes.
      await expect(pool.reserve()).rejects.toThrow()
      expect(f.events).toEqual(state === 'active' ? ['lock', 'resume'] : [])
      if (state === 'prepared') expect(f.manifestBytes()).toEqual(before)
      expect(readGenerationPointerV2(f.options.generationPointerPath).payload.generationId).toBe(
        state === 'active' ? targetGenerationId : sourceGenerationId,
      )
      expect(f.control.get(operationId).phase).toBe(
        state === 'active' ? 'accepting-writes' : 'switched',
      )
    })
})

test('invalid target environment is rejected before retained-source access or any admission effect', async () => {
  const f = fixture('switched', true)
  const calls: string[] = []
  const coordinator = createDatabaseMigrationCoordinator({
    ...f.options,
    headContract: logicalSchemaContract,
    env: {},
    interruptedOperationId: operationId,
    admission: {
      async freezeAndDrain() {
        calls.push('freeze')
      },
      async reopenSqlite() {
        calls.push('source')
      },
      async activatePostgresql() {
        calls.push('target')
      },
      async openPostgresqlAdmission() {
        calls.push('open')
      },
    },
    async activateTargetConfig() {
      calls.push('config')
    },
    async activateSourceConfig() {
      calls.push('config')
    },
  })
  expect(existsSync(f.options.sqlitePath)).toBeFalse()
  await expect(
    coordinator.resumeInterrupted(f.control.get(operationId).target),
  ).rejects.toMatchObject({ code: 'postgresql-url-env-missing' })
  expect(calls).toEqual([])
  expect(existsSync(f.options.sqlitePath)).toBeFalse()
})

test('the coordinator itself never clears a failed move during automatic recovery', async () => {
  const f = fixture('switched', true)
  f.fail()
  const before = f.manifestBytes()
  const coordinator = createDatabaseMigrationCoordinator({
    ...f.options,
    headContract: logicalSchemaContract,
    interruptedOperationId: operationId,
    admission: {
      async freezeAndDrain() {
        throw new Error('unexpected admission')
      },
      async reopenSqlite() {},
      async activatePostgresql() {},
      async openPostgresqlAdmission() {},
    },
    async activateTargetConfig() {},
    async activateSourceConfig() {},
  })
  await expect(
    coordinator.resumeInterrupted(f.control.get(operationId).target),
  ).rejects.toMatchObject({ code: 'database-migration-resume-required' })
  expect(f.manifestBytes()).toEqual(before)
})
