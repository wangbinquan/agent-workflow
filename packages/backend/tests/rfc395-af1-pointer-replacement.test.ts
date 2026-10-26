import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { plannedFixture } from './rfc395-v3-switch-domain.test'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { openDb } from '@/db/client'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { sqliteHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { parseSwitchReceipt } from '@/modules/system-operations/domain/epochSwitch/switchReceipt'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  writeGenerationPointerV2,
  readGenerationPointerV2,
} from '@/platform/persistence/generationPointerV2'
import { settleEpochSwitchBeforePointerReplacement } from '@/modules/system-operations/infrastructure/epochSwitch/pointerReplacement'
import {
  classifyEpochInstallation,
  readEpochBootFacts,
} from '@/modules/system-operations/composition/epochBootAdmission'

test('AF-D7 refuses an open rollback window, then completes and records a used switch before pointer replacement', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    const pointer = readGenerationPointerV2(f.pointerPath)
    if (pointer.payload.database.kind !== 'sqlite-file') throw new Error('SQLite fixture required')
    const targetPath = join(f.root, pointer.payload.database.relativePath)
    mkdirSync(dirname(targetPath), { recursive: true })
    // The application fixture supplies the durable switch journal; a real native
    // head supplies the runtime catalog and transactional first-write authority.
    const baseline = createSqliteBaseline({ generationId: pointer.payload.generationId })
    const run = f.control.run!
    await createMigrationMetaStore({
      target: sqliteHistoryConnection(baseline),
      registry: persistenceSchema,
    }).openRun(run, run.binding)
    writeFileSync(targetPath, baseline.serialize())
    writeFileSync(f.sourcePath, baseline.serialize())
    baseline.close()
    const before = readFileSync(f.pointerPath)
    await expect(settleEpochSwitchBeforePointerReplacement({ appHome: f.root })).rejects.toThrow(
      'complete or roll back',
    )
    expect(readFileSync(f.pointerPath)).toEqual(before)
    expect((await f.deps.journal.read(f.operationId))!.payload.status).toBe('running')
    const db = openDb({ path: targetPath, generationId: pointer.payload.generationId })
    db.$client.exec('UPDATE auth_login_policy SET updated_at=updated_at+1')
    db.$client.close()
    await settleEpochSwitchBeforePointerReplacement({ appHome: f.root })
    const completed = (await f.deps.journal.read(f.operationId))!
    expect(completed.payload).toMatchObject({
      phase: 'completed',
      status: 'completed',
      firstLiveWriteAt: expect.any(Number),
    })
    expect(
      existsSync(join(f.root, 'database-migrations', f.operationId, 'pointer-replacement.json')),
    ).toBeTrue()
    expect(
      existsSync(join(f.root, 'database-migrations', f.operationId, 'source/db.sqlite')),
    ).toBeTrue()
    expect(
      classifyEpochInstallation(readEpochBootFacts({ appHome: f.root, provider: 'sqlite' })).kind,
    ).toBe('epoch2')
    const receipt = await f.deps.journal.readArtifact(f.operationId, 'completion-receipt.json')
    const completion = parseSwitchReceipt(Buffer.from(receipt!).toString('utf8'))
    expect(completion.payload.health).toMatchObject({
      passed: false,
      catalogAdmitted: true,
      probes: [{ id: 'runtime-admission-only', passed: true, detail: { acceptance: 'not-run' } }],
    })
    expect(await f.deps.journal.readArtifact(f.operationId, 'switch-receipt.json')).toBeNull()
    const native = openDb({ path: targetPath, generationId: pointer.payload.generationId })
    try {
      expect(
        native.$client
          .query('SELECT completed_at FROM aw_meta_migration_runs WHERE run_id=?')
          .get(run.runId),
      ).toEqual({ completed_at: completion.payload.recordedAt })
      expect(native.$client.query('SELECT kind FROM aw_meta_switch_receipts').all()).toEqual([
        { kind: 'completed' },
      ])
    } finally {
      native.$client.close()
    }
    await settleEpochSwitchBeforePointerReplacement({ appHome: f.root })
    expect(await f.deps.journal.readArtifact(f.operationId, 'completion-receipt.json')).toEqual(
      receipt,
    )
  } finally {
    f.close()
  }
})

// BF-D11: replacement must preserve the planner's actionable operation conflict.
test('BF-D11 a never-activated restore plan names its discard and continuation commands', async () => {
  const f = await plannedFixture()
  try {
    const head = persistenceHead()
    writeGenerationPointerV2({
      pointerPath: f.pointerPath,
      payload: {
        version: 2,
        schemaEpoch: 2,
        generationId: 'dbg_existing',
        provider: 'sqlite',
        role: 'installed',
        database: { kind: 'sqlite-file', relativePath: 'databases/dbg_existing/db.sqlite' },
        contractDigest: head.contract.contract.digest,
        planDigest: head.sqlite.digest,
        operationId: null,
        manifestDigest: null,
        activatedAt: 1,
        previous: null,
      },
    })
    const before = readFileSync(f.pointerPath)
    const journal = await f.deps.journal.read(f.operationId)
    await expect(settleEpochSwitchBeforePointerReplacement({ appHome: f.root })).rejects.toThrow(
      `discard with db migration discard ${f.operationId} --confirm`,
    )
    await expect(settleEpochSwitchBeforePointerReplacement({ appHome: f.root })).rejects.toThrow(
      `continue with db migration plan ${f.operationId}`,
    )
    expect(await f.deps.journal.read(f.operationId)).toEqual(journal)
    expect(readFileSync(f.pointerPath)).toEqual(before)
  } finally {
    f.close()
  }
})

for (const passed of [false, true])
  test(`BF-D12 automatic completion preserves actual acceptance passed=${passed}`, async () => {
    const f = await plannedFixture()
    try {
      await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
      const payload = {
        version: 1 as const,
        checkedAt: 123,
        catalogAdmitted: true,
        probes: [{ id: 'acceptance-fixture', passed, detail: { rows: 7 } }],
        passed,
      }
      const health = { ...payload, digest: digestSchemaContract(payload) }
      const open = f.deps.target.open.bind(f.deps.target)
      f.deps.target.open = async (input) => ({
        ...(await open(input)),
        async healthCheck() {
          return health
        },
      })
      if (passed) await f.app.verify({ operationId: f.operationId })
      else
        await expect(f.app.verify({ operationId: f.operationId })).rejects.toThrow(
          'v3-acceptance-failed',
        )
      const pointer = readGenerationPointerV2(f.pointerPath)
      if (pointer.payload.database.kind !== 'sqlite-file')
        throw new Error('SQLite fixture required')
      const path = join(f.root, pointer.payload.database.relativePath)
      mkdirSync(dirname(path), { recursive: true })
      const baseline = createSqliteBaseline({ generationId: pointer.payload.generationId })
      baseline.query('UPDATE aw_meta_first_write SET first_live_write_at=123').run()
      writeFileSync(path, baseline.serialize())
      baseline.close()
      await settleEpochSwitchBeforePointerReplacement({ appHome: f.root })
      const bytes = await f.deps.journal.readArtifact(f.operationId, 'completion-receipt.json')
      expect(parseSwitchReceipt(Buffer.from(bytes!).toString('utf8')).payload.health).toEqual(
        health,
      )
      expect((await f.deps.journal.read(f.operationId))!.payload.status).toBe('completed')
      if (!passed)
        expect(await f.deps.journal.readArtifact(f.operationId, 'switch-receipt.json')).toBeNull()
    } finally {
      f.close()
    }
  })
