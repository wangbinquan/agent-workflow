import { expect, test } from 'bun:test'
import { createEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  digestGenerationPayload,
  parseDatabaseGenerationText,
} from '@/platform/persistence/generationValidation'
import { makeSwitchFixture, plannedFixture, fixtureDigest } from './helpers/rfc395V3SwitchFixture'

for (const hasPointer of [true, false])
  test(`rollback restores exact previous pointer bytes: ${hasPointer}`, async () => {
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
        JSON.stringify({ payload, digest: digestGenerationPayload(payload) }, null, 3) + '\n',
      )
      if (hasPointer) writeFileSync(f.pointerPath, previous)
      const plan = await f.app.plan({})
      await f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
      expect(() =>
        parseDatabaseGenerationText(readFileSync(f.pointerPath, 'utf8'), 'converted'),
      ).toThrow('generation')
      await f.app.rollback({ operationId: f.operationId })
      expect(f.control.state).toBe('retired')
      if (hasPointer) {
        expect(readFileSync(f.pointerPath)).toEqual(previous)
        expect(
          parseDatabaseGenerationText(readFileSync(f.pointerPath, 'utf8'), 'restored').payload
            .version,
        ).toBe(1)
      } else expect(existsSync(f.pointerPath)).toBe(false)
      expect((await f.app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
      expect(
        await f.deps.journal.readArtifact(f.operationId, 'rollback-receipt.json'),
      ).not.toBeNull()
      expect(existsSync(f.sourcePath)).toBe(true)
    } finally {
      f.close()
    }
  })

test('business writes and completion close rollback; verify is required for complete', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await expect(f.app.complete({ operationId: f.operationId })).rejects.toThrow(
      'requires-verified',
    )
    const pointer = readFileSync(f.pointerPath)
    f.control.firstWrite = 124
    await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(
      'reverse-migration-required',
    )
    expect(readFileSync(f.pointerPath)).toEqual(pointer)
    const verified = await f.app.verify({ operationId: f.operationId })
    expect(verified.phase).toBe('verified')
    expect(verified.firstLiveWriteAt).toBe(124)
    const completed = await f.app.complete({ operationId: f.operationId })
    expect(completed.phase).toBe('completed')
    expect(completed.journal.payload.completion!.retained).toHaveLength(1)
    expect((await f.app.complete({ operationId: f.operationId })).phase).toBe('completed')
    expect((await f.app.verify({ operationId: f.operationId })).phase).toBe('completed')
    await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(
      'reverse-migration-required',
    )
  } finally {
    f.close()
  }
})

test('pre-activation abort leaves source authoritative and explicit discard preserves source', async () => {
  const f = await plannedFixture()
  try {
    const before = readFileSync(f.sourcePath)
    expect((await f.app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
    expect(existsSync(f.pointerPath)).toBe(false)
    expect((await f.app.discard({ operationId: f.operationId, confirm: true })).status).toBe(
      'abandoned',
    )
    expect(readFileSync(f.sourcePath)).toEqual(before)
  } finally {
    f.close()
  }
})

test('abort discovers a target installed before its file checkpoint was acknowledged', async () => {
  const f = await plannedFixture()
  try {
    const create = f.deps.target.create
    f.deps.target.create = async (input) => {
      await create(input)
      throw new Error('install response lost')
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
    ).rejects.toThrow('install response lost')
    expect((await f.app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
    expect(f.control.state).toBe('retired')
    expect(existsSync(f.pointerPath)).toBe(false)
  } finally {
    f.close()
  }
})

test('discard retries its adapter without reopening an already moved rolled-back target', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await f.app.rollback({ operationId: f.operationId })
    let attempts = 0
    f.deps.target.discard = async () => {
      f.control.installed = false
      if (++attempts === 1) throw new Error('discard response lost')
    }
    await expect(f.app.discard({ operationId: f.operationId, confirm: true })).rejects.toThrow(
      'discard response lost',
    )
    expect((await f.app.discard({ operationId: f.operationId, confirm: true })).status).toBe(
      'abandoned',
    )
    expect(attempts).toBe(2)
    expect(existsSync(f.sourcePath)).toBe(true)
  } finally {
    f.close()
  }
})

test('activation file without committed target activation can always finish rollback', async () => {
  const f = await plannedFixture()
  try {
    f.target.prepareActivation = async () => {
      throw new Error('meta commit never happened')
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
    ).rejects.toThrow('meta commit never happened')
    expect(
      await f.deps.journal.readArtifact(f.operationId, 'activation-receipt.json'),
    ).not.toBeNull()
    expect(f.control.activationDigest).toBeNull()
    expect((await f.app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
    const receipt = JSON.parse(
      (await f.app.receipt({ operationId: f.operationId, kind: 'rollback' })).json,
    )
    expect(receipt.payload.activationReceiptDigest).toBeNull()
    expect((await f.app.discard({ operationId: f.operationId, confirm: true })).status).toBe(
      'abandoned',
    )
  } finally {
    f.close()
  }
})

for (const phase of ['discovered', 'planned', 'backed-up'] as const)
  test(`discard at ${phase} never stops the live source daemon`, async () => {
    const f = await plannedFixture()
    try {
      const j = (await f.deps.journal.read(f.operationId))!
      const next = createEpochSwitchJournal({
        ...j.payload,
        phase,
        revision: j.payload.revision + 1,
        previousDigest: j.digest,
        plan:
          phase === 'backed-up'
            ? {
                ...j.payload.plan!,
                approvedDigest: j.payload.plan!.approvalDigest,
                approvedAt: 123,
              }
            : j.payload.plan,
      })
      await f.deps.journal.compareAndSwap(
        { operationId: f.operationId, revision: j.payload.revision, digest: j.digest },
        next,
      )
      expect((await f.app.discard({ operationId: f.operationId, confirm: true })).status).toBe(
        'abandoned',
      )
      expect(f.control.quiesceCalls).toBe(0)
    } finally {
      f.close()
    }
  })

test('first-write rollback refusal leaves daemon and healthy switch status untouched', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    const calls = f.control.quiesceCalls
    f.control.firstWrite = 124
    await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(
      'reverse-migration-required',
    )
    expect(f.control.quiesceCalls).toBe(calls)
    const journal = (await f.deps.journal.read(f.operationId))!
    expect(journal.payload.status).toBe('running')
    expect(journal.payload.failure).toBeNull()
    expect(f.control.state).toBe('active')
  } finally {
    f.close()
  }
})

test('completion checkpoint closes rollback before the first retained source move', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await f.app.verify({ operationId: f.operationId })
    f.control.inject = (point) => {
      if (point === 'after-retained-source-file') throw new Error('retention crash')
    }
    await expect(f.app.complete({ operationId: f.operationId })).rejects.toThrow('retention crash')
    expect(
      await f.deps.journal.readArtifact(f.operationId, 'completion-started.json'),
    ).not.toBeNull()
    const calls = f.control.quiesceCalls
    await expect(f.app.rollback({ operationId: f.operationId })).rejects.toThrow(
      'reverse-migration-required',
    )
    expect(f.control.quiesceCalls).toBe(calls)
    expect((await f.deps.activation.observe(f.operationId)).pointsAt).toBe('target')
    f.control.inject = undefined
    expect((await f.app.complete({ operationId: f.operationId })).phase).toBe('completed')
  } finally {
    f.close()
  }
})

// Sampling trial on real data, 2026-10-24: after a successful rollback the status view still offered rollback, verify and complete.
test('a rolled-back or discarded operation states where the installation stands instead of offering switch steps', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await f.app.rollback({ operationId: f.operationId })
    const rolledBack = await f.app.rollback({ operationId: f.operationId })
    expect(rolledBack.status).toBe('rolled-back')
    expect(rolledBack.rollback).toEqual({ allowed: false, reason: 'already-rolled-back' })
    expect(rolledBack.guidance).toEqual([
      'Rolled back: epoch 1 is active again and its daemon can be started. The target generation and migration metadata are kept.',
      'To switch again, start a new operation: db migration plan',
    ])
    const discarded = await f.app.discard({ operationId: f.operationId, confirm: true })
    expect(discarded.status).toBe('abandoned')
    expect(discarded.rollback).toEqual({ allowed: false, reason: 'operation-abandoned' })
    expect(discarded.guidance).toEqual([
      'Discarded: nothing was switched. To switch, start a new operation: db migration plan',
    ])
  } finally {
    f.close()
  }
})

test('a completed operation refuses rollback and says nothing is deleted automatically', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await f.app.verify({ operationId: f.operationId })
    const completed = await f.app.complete({ operationId: f.operationId })
    expect(completed.status).toBe('completed')
    expect(completed.rollback.allowed).toBe(false)
    expect(completed.guidance).toEqual([
      'Completed: epoch 2 is active. The epoch-1 source, backup and migration metadata are kept; nothing is deleted automatically.',
    ])
  } finally {
    f.close()
  }
})
