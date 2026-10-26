import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  EPOCH_SWITCH_FAULT_POINTS,
  type EpochSwitchFaultPoint,
} from '@/modules/system-operations/domain/epochSwitch/model'
import { parseGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { digestGenerationPayload } from '@/platform/persistence/generationValidation'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { plannedFixture, makeSwitchFixture, fixtureDigest } from './rfc395-v3-switch-domain.test'

const later = new Set<EpochSwitchFaultPoint>([
  'after-switch-receipt',
  'after-retained-source-file',
  'after-restore-file',
  'after-retire',
  'rollback-temp-written',
  'rollback-temp-synced',
  'rollback-renamed',
  'rollback-directory-synced',
  'after-rollback-file',
])
for (const point of EPOCH_SWITCH_FAULT_POINTS.filter((point) => !later.has(point)))
  test(`run recovers a lost acknowledgement at ${point}`, async () => {
    const f = await plannedFixture()
    const clean = await plannedFixture()
    try {
      await clean.app.run({
        operationId: clean.operationId,
        approve: clean.plan.plan.approvalDigest,
      })
      const source = readFileSync(f.sourcePath)
      if (point === 'after-final-backup') {
        const matches = f.deps.backup.matches
        f.deps.backup.matches = (receipt, watermark) =>
          receipt.path?.endsWith('/live') ? Promise.resolve(false) : matches(receipt, watermark)
      }
      let fired = false
      f.control.inject = (seen) => {
        if (!fired && seen === point) {
          fired = true
          throw new Error(`crash:${point}`)
        }
      }
      await expect(
        f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
      ).rejects.toThrow('crash:')
      expect(fired).toBe(true)
      if (point === 'temp-written' || point === 'temp-synced')
        expect(existsSync(f.pointerPath)).toBe(false)
      if (
        point === 'renamed' ||
        point === 'directory-synced' ||
        point === 'after-activated-journal'
      )
        expect(
          parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8')).payload.operationId,
        ).toBe(f.operationId)
      const resumed = await createEpochSwitchApplication(f.deps).run({
        operationId: f.operationId,
        approve: f.plan.plan.approvalDigest,
      })
      expect(resumed.phase).toBe('activated')
      expect(f.control.rows).toBe(1)
      expect(f.control.rows).toBe(clean.control.rows)
      expect(f.control.run!.bindingDigest).toBe(clean.control.run!.bindingDigest)
      expect(f.control.run!.summaryDigest).toBe(clean.control.run!.summaryDigest)
      expect(f.control.run!.receiptExportDigest).toBe(clean.control.run!.receiptExportDigest)
      expect(readFileSync(f.sourcePath)).toEqual(source)
      expect(
        parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8')).payload.generationId,
      ).toBe(resumed.targetGenerationId!)
      const receipt = JSON.parse(
        (await f.app.receipt({ operationId: f.operationId, kind: 'activation' })).json,
      )
      expect(receipt.digest).toBe(f.control.activationDigest)
      expect(
        parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8')).payload.manifestDigest,
      ).toBe(receipt.digest)
    } finally {
      f.close()
      clean.close()
    }
  })

for (const point of [
  'after-retire',
  'rollback-temp-written',
  'rollback-temp-synced',
  'rollback-renamed',
  'rollback-directory-synced',
  'after-rollback-file',
] as const)
  test(`rollback resumes after ${point}`, async () => {
    const f = makeSwitchFixture()
    try {
      const payload = {
        version: 1 as const,
        provider: 'sqlite' as const,
        generationId: 'dbg_source_fixture',
        operationId: null,
        schemaDigest: fixtureDigest,
        manifestDigest: null,
        activatedAt: 1,
      }
      const previous = Buffer.from(
        JSON.stringify({ payload, digest: digestGenerationPayload(payload) }, null, 2),
      )
      writeFileSync(f.pointerPath, previous)
      const plan = await f.app.plan({})
      await f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
      let fired = false
      f.control.inject = (seen) => {
        if (!fired && seen === point) {
          fired = true
          throw new Error(point)
        }
      }
      await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(point)
      expect((await f.app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
      expect(readFileSync(f.pointerPath)).toEqual(previous)
      expect(f.control.state).toBe('retired')
    } finally {
      f.close()
    }
  })

test('verify and retention resume from durable receipts', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    let point: EpochSwitchFaultPoint | null = 'after-switch-receipt'
    f.control.inject = (seen) => {
      if (seen === point) {
        point = null
        throw new Error('lost receipt acknowledgement')
      }
    }
    await expect(f.app.verify({ operationId: f.operationId })).rejects.toThrow('lost receipt')
    await f.app.verify({ operationId: f.operationId })
    point = 'after-retained-source-file'
    await expect(f.app.complete({ operationId: f.operationId })).rejects.toThrow('lost receipt')
    expect((await f.app.complete({ operationId: f.operationId })).phase).toBe('completed')
    expect(existsSync(join(f.deps.journal.operationRoot(f.operationId), 'source/db.sqlite'))).toBe(
      true,
    )
  } finally {
    f.close()
  }
})

test('a killed lock owner is reclaimed with a higher journal fence', async () => {
  const f = await plannedFixture()
  try {
    const script = `import { createFileEpochSwitchJournal } from './src/modules/system-operations/infrastructure/epochSwitch/fileJournal'; import { takeOverEpochSwitch } from './src/modules/system-operations/domain/epochSwitch/transitions'; const s=createFileEpochSwitchJournal({root:process.env.V3_JOURNAL_ROOT}); await s.lockOperation(process.env.V3_OPERATION); const j=await s.read(process.env.V3_OPERATION); await s.compareAndSwap({operationId:j.payload.operationId,revision:j.payload.revision,digest:j.digest},takeOverEpochSwitch(j,'child:'+process.pid,123)); console.log('LOCKED'); await Bun.sleep(60000);`
    const child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        V3_JOURNAL_ROOT: join(f.root, 'database-migrations'),
        V3_OPERATION: f.operationId,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    expect(Buffer.from(ready.value ?? []).toString()).toContain('LOCKED')
    reader.releaseLock()
    const abandoned = (await f.deps.journal.read(f.operationId))!
    child.kill('SIGKILL')
    await child.exited
    const result = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    expect(result.journal.payload.owner.fence).toBeGreaterThan(abandoned.payload.owner.fence)
    expect(result.phase).toBe('activated')
  } finally {
    f.close()
  }
}, 15000)

test('a crash after the first business write cannot return to the source snapshot', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    const pointer = readFileSync(f.pointerPath)
    f.control.firstWrite = 999
    await expect(
      createEpochSwitchApplication(f.deps).rollback({ operationId: f.operationId }),
    ).rejects.toThrow('reverse-migration-required')
    expect(readFileSync(f.pointerPath)).toEqual(pointer)
  } finally {
    f.close()
  }
})

test('every journal CAS occurrence resumes with the same approve argument', async () => {
  const clean = await plannedFixture()
  let occurrences = 0
  try {
    clean.control.inject = (point) => {
      if (point === 'after-journal-cas') occurrences++
    }
    await clean.app.run({ operationId: clean.operationId, approve: clean.plan.plan.approvalDigest })
  } finally {
    clean.close()
  }
  expect(occurrences).toBeGreaterThan(8)
  for (let occurrence = 1; occurrence <= occurrences; occurrence++) {
    const f = await plannedFixture()
    try {
      let seen = 0
      f.control.inject = (point) => {
        if (point === 'after-journal-cas' && ++seen === occurrence)
          throw new Error(`cas-${occurrence}`)
      }
      await expect(
        f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
      ).rejects.toThrow(`cas-${occurrence}`)
      f.control.clock += 5000
      const approval = (await f.deps.journal.read(f.operationId))!.payload.approvals?.[0]
      const result = await f.app.run({
        operationId: f.operationId,
        approve: f.plan.plan.approvalDigest,
      })
      expect(result.phase).toBe('activated')
      expect(f.control.rows).toBe(1)
      if (approval) expect(result.journal.payload.approvals![0]).toEqual(approval)
    } finally {
      f.close()
    }
  }
})

test('repeated failures after the same quiesce receipt keep its original bytes and timestamp', async () => {
  const f = await plannedFixture()
  try {
    const cas = f.deps.journal.compareAndSwap
    let failures = 0
    f.deps.journal.compareAndSwap = async (expected, next) => {
      if (next.payload.phase === 'quiescing' && failures++ < 2)
        throw new Error('quiescing journal lost')
      return cas(expected, next)
    }
    const request = { operationId: f.operationId, approve: f.plan.plan.approvalDigest }
    await expect(f.app.run(request)).rejects.toThrow('quiescing journal lost')
    const j = (await f.deps.journal.read(f.operationId))!
    const name = `runs/${j.payload.run!.runId}/quiesce.json`
    const bytes = await f.deps.journal.readArtifact(f.operationId, name)
    f.control.clock += 1000
    await expect(f.app.run(request)).rejects.toThrow('quiescing journal lost')
    f.control.clock += 1000
    expect((await f.app.run(request)).phase).toBe('activated')
    expect(await f.deps.journal.readArtifact(f.operationId, name)).toEqual(bytes)
    expect(f.control.quiesceCalls).toBe(3)
  } finally {
    f.close()
  }
})

test('SIGKILL after quiesce file but before journal CAS survives a fresh process owner', async () => {
  const f = await plannedFixture()
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  try {
    f.control.inject = (point) => {
      if (point === 'after-backup-file') throw new Error('stop before quiesce')
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
    ).rejects.toThrow('stop before quiesce')
    const j = (await f.deps.journal.read(f.operationId))!
    const script = `import { createFileEpochSwitchJournal } from './src/modules/system-operations/infrastructure/epochSwitch/fileJournal'; import { reviseEpochSwitch,takeOverEpochSwitch } from './src/modules/system-operations/domain/epochSwitch/transitions'; import { valueDigest } from './src/platform/persistence/migration/conversion/digest'; const s=createFileEpochSwitchJournal({root:process.env.V3_ROOT}); const op=process.env.V3_OP; await s.lockOperation(op); let j=await s.read(op); const owned=takeOverEpochSwitch(j,'child:'+process.pid,124); await s.compareAndSwap({operationId:op,revision:j.payload.revision,digest:j.digest},owned); j=owned; const next=reviseEpochSwitch(j,{phase:'backed-up',status:'running',failure:null},125); await s.compareAndSwap({operationId:op,revision:j.payload.revision,digest:j.digest},next); const receipt={version:1,operationId:op,deployment:'standalone',kind:'daemon-stopped',stoppedAt:126,freezeReference:null}; await s.writeOnce(op,'runs/'+next.payload.run.runId+'/quiesce.json',Buffer.from(JSON.stringify({...receipt,digest:valueDigest(receipt)}))); console.log('DURABLE'); await Bun.sleep(60000);`
    child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, V3_ROOT: join(f.root, 'database-migrations'), V3_OP: f.operationId },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    expect(Buffer.from((await reader.read()).value ?? []).toString()).toContain('DURABLE')
    reader.releaseLock()
    child.kill('SIGKILL')
    await child.exited
    const name = `runs/${j.payload.run!.runId}/quiesce.json`
    const durable = await f.deps.journal.readArtifact(f.operationId, name)
    f.control.inject = undefined
    f.control.clock = 1000
    expect(
      (
        await createEpochSwitchApplication(f.deps).run({
          operationId: f.operationId,
          approve: f.plan.plan.approvalDigest,
        })
      ).phase,
    ).toBe('activated')
    expect(await f.deps.journal.readArtifact(f.operationId, name)).toEqual(durable)
  } finally {
    child?.kill()
    if (child) await child.exited
    f.close()
  }
}, 15000)

test('quiescing refreshes pointer evidence after the epoch-one daemon rewrites its v1 pointer', async () => {
  const f = makeSwitchFixture()
  try {
    const pointer = (activatedAt: number) => {
      const payload = {
        version: 1 as const,
        provider: 'sqlite' as const,
        generationId: 'dbg_source_fixture',
        operationId: null,
        schemaDigest: fixtureDigest,
        manifestDigest: null,
        activatedAt,
      }
      return Buffer.from(JSON.stringify({ payload, digest: digestGenerationPayload(payload) }))
    }
    writeFileSync(f.pointerPath, pointer(1))
    const plan = await f.app.plan({})
    const quiesce = f.deps.quiesce.quiesce
    const latest = pointer(2)
    f.deps.quiesce.quiesce = async (input) => {
      writeFileSync(f.pointerPath, latest)
      return quiesce(input)
    }
    await f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
    const activation = JSON.parse(
      (await f.app.receipt({ operationId: f.operationId, kind: 'activation' })).json,
    )
    expect(Buffer.from(activation.payload.previousPointer.bytesBase64, 'base64')).toEqual(latest)
    f.deps.quiesce.quiesce = quiesce
    await f.app.rollback({ operationId: f.operationId })
    expect(readFileSync(f.pointerPath)).toEqual(latest)
  } finally {
    f.close()
  }
})
