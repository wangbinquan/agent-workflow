import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { readEpochBootFacts } from '@/modules/system-operations/composition/epochBootAdmission'
import { unpublishedSqliteInstallation } from '@/platform/persistence/unpublishedInstallation'
import { expect, test } from 'bun:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  classifyEpochInstallation,
  epochInstallationGuidance,
  type InstallationFacts,
} from '@/modules/system-operations/domain/epochSwitch/classification'
import { createEpochInstallationProbe } from '@/modules/system-operations/infrastructure/epochSwitch/installationProbe'
import { createEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { parseGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { join } from 'node:path'
import { fixtureDigest, plannedFixture } from './rfc395-v3-switch-domain.test'

test('fresh and epoch-1 installations give the appropriate migration or RFC-349 guidance', () => {
  const base: InstallationFacts = {
    pointer: null,
    provider: 'sqlite',
    sourceExists: false,
    operation: null,
    rfc349Operation: null,
    activationReceiptDigest: null,
    targetState: null,
    rollbackIncomplete: false,
  }
  expect(classifyEpochInstallation(base)).toEqual({ kind: 'fresh' })
  expect(epochInstallationGuidance(classifyEpochInstallation(base))).toBeNull()
  expect(
    epochInstallationGuidance(classifyEpochInstallation({ ...base, sourceExists: true })),
  ).toContain('db migration plan')
  expect(
    epochInstallationGuidance(
      classifyEpochInstallation({
        ...base,
        sourceExists: true,
        rfc349Operation: 'dbm_legacy_operation',
      }),
    ),
  ).toContain('dbm_legacy_operation')
})

test('pointer, activation receipt, journal and retirement determine every recovery classification', async () => {
  const f = await plannedFixture()
  try {
    const activated = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    const pointer = parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8'))
    const facts: InstallationFacts = {
      pointer,
      provider: 'sqlite',
      sourceExists: true,
      operation: activated.journal,
      rfc349Operation: null,
      activationReceiptDigest: activated.journal.payload.activation!.receiptDigest,
      targetState: 'active',
      rollbackIncomplete: false,
    }
    expect(classifyEpochInstallation(facts).kind).toBe('epoch2')
    for (const [patch, reason] of [
      [{ activationReceiptDigest: fixtureDigest }, 'pointer-receipt-mismatch'],
      [{ targetState: 'retired' }, 'target-retired'],
      [{ rollbackIncomplete: true }, 'rollback-incomplete'],
      [{ pointer: null }, 'activation-unreconciled'],
      [
        {
          operation: createEpochSwitchJournal({
            ...activated.journal.payload,
            phase: 'activation-prepared',
          }),
        },
        'activation-unreconciled',
      ],
    ] as const) {
      const state = classifyEpochInstallation({ ...facts, ...patch })
      expect(state).toMatchObject({ kind: 'switch-recovery-required', reason })
      expect(epochInstallationGuidance(state)).toContain('Keep the daemon stopped')
    }
  } finally {
    f.close()
  }
})

test('discovery refuses another active operation before any target is installed', async () => {
  const f = await plannedFixture()
  try {
    await expect(f.app.plan({})).rejects.toThrow('another-operation-active')
    expect(f.control.installed).toBe(false)
  } finally {
    f.close()
  }
})

test('a new restore recovery takes precedence over the previous completed pointer operation', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await f.app.verify({ operationId: f.operationId })
    const completed = await f.app.complete({ operationId: f.operationId })
    const next = createEpochSwitchJournal({
      ...completed.journal.payload,
      operationId: 'dbm_e2_restore_probe',
      approvals: [],
      kind: 'old-epoch-restore',
      role: 'restored',
      phase: 'quiescing',
      status: 'running',
      revision: 0,
      previousDigest: null,
      completion: null,
    })
    await f.deps.journal.create(next)
    const installation = await f.deps.installation()
    expect(installation.facts.operation!.payload.operationId).toBe(next.payload.operationId)
    expect(classifyEpochInstallation(installation.facts)).toMatchObject({
      kind: 'switch-recovery-required',
      reason: 'activation-unreconciled',
    })
  } finally {
    f.close()
  }
})

test('obsolete rollback markers do not block a later active generation, but live retired state does', async () => {
  const f = await plannedFixture()
  try {
    await f.deps.journal.writeOnce(
      f.operationId,
      'rollback-retired.json',
      Buffer.from(JSON.stringify({ generationId: 'dbg_prior_run', runId: 'prior' })),
    )
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    expect(classifyEpochInstallation((await f.deps.installation()).facts).kind).toBe('epoch2')
    const probe = createEpochInstallationProbe({
      pointerPath: f.pointerPath,
      migrationsRoot: join(f.root, 'database-migrations'),
      provider: 'sqlite',
      source: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      journal: f.deps.journal,
      async targetState() {
        return 'retired'
      },
    })
    expect(classifyEpochInstallation((await probe()).facts)).toMatchObject({
      kind: 'switch-recovery-required',
      reason: 'target-retired',
    })
  } finally {
    f.close()
  }
})

test('epoch-one guidance names the existing operation and trace holds the operation lock', async () => {
  const f = await plannedFixture()
  try {
    expect(
      epochInstallationGuidance(classifyEpochInstallation((await f.deps.installation()).facts)),
    ).toContain(`db migration status ${f.operationId}`)
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    f.deps.trace = async () => {
      await expect(f.deps.journal.lockOperation(f.operationId)).rejects.toThrow('operation-locked')
      throw new Error('trace finished under lock')
    }
    await expect(
      f.app.trace({
        operationId: f.operationId,
        table: 'tasks',
        key: [{ type: 'text', value: 'task' }],
        phase: 'current',
        replay: true,
      }),
    ).rejects.toThrow('trace finished under lock')
    const lock = await f.deps.journal.lockOperation(f.operationId)
    await lock.release()
  } finally {
    f.close()
  }
})

for (const state of ['prepared', 'retired'] as const)
  test(`BF-D13 a pointer-less epoch-1 home keeps guidance beside a ${state} switch target`, async () => {
    const f = await plannedFixture()
    try {
      const source = createSqliteBaseline()
      // An epoch-1 source needs only a business table for the boot classifier.
      source.exec('DROP TABLE aw_meta_generations')
      writeFileSync(f.sourcePath, source.serialize())
      source.close()
      if (state === 'retired') {
        await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
        await f.app.rollback({ operationId: f.operationId })
      }
      const journal = (await f.deps.journal.read(f.operationId))!
      const target = journal.payload.target
      if (target.location?.kind !== 'sqlite-file') throw new Error('SQLite fixture required')
      const path = join(f.root, target.location.relativePath)
      mkdirSync(join(path, '..'), { recursive: true })
      const db = createSqliteBaseline({ generationId: target.generationId! })
      db.query('UPDATE aw_meta_generations SET state=?,role=?,operation_id=?').run(
        state,
        'converted',
        f.operationId,
      )
      writeFileSync(path, db.serialize())
      db.close()
      const facts = readEpochBootFacts({ appHome: f.root, provider: 'sqlite' })
      expect(classifyEpochInstallation(facts).kind).toBe('epoch1')
      expect(epochInstallationGuidance(classifyEpochInstallation(facts))).toContain(
        state === 'prepared' ? `db migration status ${f.operationId}` : 'db migration plan',
      )
      expect(() => unpublishedSqliteInstallation(f.root)).toThrow(
        'epoch2-unpublished-installation-not-adoptable',
      )
      expect(unpublishedSqliteInstallation(f.root, { classificationOnly: true })).toBeNull()
    } finally {
      f.close()
    }
  })
