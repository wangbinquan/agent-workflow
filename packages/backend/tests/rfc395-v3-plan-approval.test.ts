import { expect, test } from 'bun:test'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { plannedFixture, makeSwitchFixture, fixtureDigest } from './helpers/rfc395V3SwitchFixture'

test('run requires the material approval digest and numeric drift keeps approval', async () => {
  const f = await plannedFixture()
  try {
    await expect(f.app.run({ operationId: f.operationId })).rejects.toThrow('approval-required')
    await expect(f.app.run({ operationId: f.operationId, approve: fixtureDigest })).rejects.toThrow(
      'approval-digest-mismatch',
    )
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.digest }),
    ).rejects.toThrow('approval-digest-mismatch')
    f.control.actualCount = 900
    const result = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    expect(result.phase).toBe('activated')
    expect(result.journal.payload.plan!.approvalDigest).toBe(f.plan.plan.approvalDigest)
    expect(result.journal.payload.plan!.digest).not.toBe(f.plan.plan.digest)
    expect(f.control.rows).toBe(1)
    expect(f.control.held).toBe(false)
  } finally {
    f.close()
  }
})

test('material restrictions wait at validated and explicit re-approval resumes without conversion', async () => {
  const f = await plannedFixture()
  try {
    f.control.actualRestrictions = [
      {
        sourceTable: 'tasks',
        sourceKey: encodeMigrationKey('tasks', [canonicalValue('task')]),
        class: 'archived',
        kind: 'history-only',
        targets: [],
        archive: null,
        rule: { id: 'task-history', version: 1 },
        history: {
          execution: 'retryable-history',
          taskId: 'task',
          runId: null,
          missingFields: ['workspace'],
        },
        decision: null,
      },
    ]
    const result = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    expect(result.phase).toBe('validated')
    expect(result.status).toBe('awaiting-approval')
    expect((await f.deps.activation.observe(f.operationId)).pointsAt).toBe('none')
    await expect(f.app.run({ operationId: f.operationId })).rejects.toThrow('approval-required')
    const resumed = await f.app.run({
      operationId: f.operationId,
      approve: result.journal.payload.plan!.approvalDigest,
    })
    expect(resumed.phase).toBe('activated')
    expect(f.control.rows).toBe(1)
    const approvals = resumed.journal.payload.approvals!
    expect(approvals).toHaveLength(2)
    expect(f.control.approvals).toEqual(approvals)
    expect(approvals[1]!.payload.previousApprovalDigest).toBe(approvals[0]!.digest)
    const receipt = JSON.parse(
      (await f.app.receipt({ operationId: f.operationId, kind: 'activation' })).json,
    )
    expect(receipt.payload.approvalRecordDigest).toBe(approvals[1]!.digest)
  } finally {
    f.close()
  }
})

test('acknowledgements are item-bound, explicit and reflected in the replacement plan', async () => {
  const f = makeSwitchFixture()
  try {
    f.control.planBlocks = [
      {
        code: 'v2-code-history-unfinished',
        scope: 'row',
        sourceTable: 'code_work_items',
        sourceKey: encodeMigrationKey('code_work_items', [canonicalValue('work')]),
        sourcePhase: 'current',
        taskId: null,
        runId: null,
        missingFields: [],
        detail: { rowDigest: fixtureDigest },
        acknowledgeable: true,
      },
    ]
    const plan = await f.app.plan({})
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('plan-blocked')
    await expect(
      f.app.acknowledge({
        operationId: f.operationId,
        items: ['absent'],
        reason: 'archive',
        by: 'operator',
      }),
    ).rejects.toThrow('item-not-found')
    const updated = await f.app.acknowledge({
      operationId: f.operationId,
      items: [plan.acknowledgeable[0]!.id],
      reason: 'Retired work remains readable as history.',
      by: 'operator',
    })
    expect(updated.plan.payload.operatorDecisions).toMatchObject([
      { rowDigest: fixtureDigest, acknowledgedBy: 'operator', sourceTable: 'code_work_items' },
    ])
    expect(updated.plan.payload.blocks).toEqual([])
    expect(updated.plan.approvalDigest).not.toBe(plan.plan.approvalDigest)
    expect(updated.requiresApproval).toBe(true)
  } finally {
    f.close()
  }
})

test('a new run changes deterministic ids, preserves old evidence and requires a new approval', async () => {
  const f = await plannedFixture()
  try {
    const before = (await f.deps.journal.read(f.operationId))!
    f.control.watermark = fixtureDigest.replace(/^sha256:./, 'sha256:0')
    const after = await f.app.run({ operationId: f.operationId, newRun: true })
    expect(after.phase).toBe('planned')
    expect(after.status).toBe('awaiting-approval')
    expect(after.journal.payload.run!.ordinal).toBe(1)
    expect(after.targetGenerationId).not.toBe(before.payload.target.generationId)
    expect(
      await f.deps.journal.readArtifact(f.operationId, `plans/${f.plan.plan.digest}.json`),
    ).not.toBeNull()
    await expect(
      createEpochSwitchApplication(f.deps).run({
        operationId: f.operationId,
        approve: f.plan.plan.approvalDigest,
      }),
    ).rejects.toThrow('approval-digest-mismatch')
  } finally {
    f.close()
  }
})

test('a changed frozen source refuses resume and cannot produce an activation receipt', async () => {
  const f = await plannedFixture()
  try {
    let fired = false
    f.control.inject = (point) => {
      if (point === 'after-frozen-preflight' && !fired) {
        fired = true
        throw new Error('frozen crash')
      }
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
    ).rejects.toThrow('frozen crash')
    f.control.watermark = `sha256:${'a'.repeat(64)}`
    await expect(f.app.run({ operationId: f.operationId })).rejects.toThrow('source-changed')
    expect(await f.deps.journal.readArtifact(f.operationId, 'activation-receipt.json')).toBeNull()
    const replanned = await f.app.run({ operationId: f.operationId, newRun: true })
    expect(replanned.status).toBe('awaiting-approval')
    expect(replanned.journal.payload.run!.ordinal).toBe(1)
  } finally {
    f.close()
  }
})

test('new-run refuses an activated generation before retiring any target', async () => {
  const f = await plannedFixture()
  try {
    await f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest })
    await expect(f.app.run({ operationId: f.operationId, newRun: true })).rejects.toThrow(
      'new-run-after-activation',
    )
    expect(f.control.state).toBe('active')
    expect((await f.deps.activation.observe(f.operationId)).pointsAt).toBe('target')
  } finally {
    f.close()
  }
})

test('hosted plans describe the concrete backup adapter rather than a retention receipt', async () => {
  const f = makeSwitchFixture()
  try {
    f.deps.defaultContentRoot = { ...f.deps.defaultContentRoot, objects: 'crewstation' }
    const plan = await f.app.plan({ target: { provider: 'postgresql', urlEnv: 'TARGET_URL' } })
    expect(plan.plan.payload.deployment).toBe('crewstation')
    expect(plan.plan.payload.backup.kind).toBe('sqlite-vacuum')
  } finally {
    f.close()
  }
})

test('obsolete acknowledgements can be withdrawn before running and revoke prior approval', async () => {
  const f = makeSwitchFixture()
  try {
    f.control.planBlocks = [
      {
        code: 'v2-code-history-unfinished',
        scope: 'row',
        sourceTable: 'code_work_items',
        sourceKey: encodeMigrationKey('code_work_items', [canonicalValue('removed')]),
        sourcePhase: 'current',
        taskId: null,
        runId: null,
        missingFields: [],
        detail: { rowDigest: fixtureDigest },
        acknowledgeable: true,
      },
    ]
    await f.app.plan({})
    const acknowledged = await f.app.acknowledge({
      operationId: f.operationId,
      items: 'all-unfinished-legacy-code-work',
      reason: 'Archive retired work',
      by: 'operator',
    })
    expect(acknowledged.plan.payload.operatorDecisions).toHaveLength(1)
    f.control.planBlocks = []
    const plan = await f.app.withdrawAcknowledgements({
      operationId: f.operationId,
      decisions: 'all',
    })
    expect(plan.plan.payload.operatorDecisions).toEqual([])
    expect(plan.requiresApproval).toBe(true)
    await f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest })
    await expect(
      f.app.withdrawAcknowledgements({ operationId: f.operationId, decisions: 'all' }),
    ).rejects.toThrow('requires-new-run')
  } finally {
    f.close()
  }
})

test('a failed validation is retried on the same run and mirrored approvals replay unchanged', async () => {
  const f = await plannedFixture()
  try {
    const validate = f.target.validate
    let calls = 0
    f.target.validate = async (input) => {
      const report = await validate(input)
      calls++
      const actual =
        calls === 1
          ? {
              ...report,
              passed: false,
              checks: report.checks.map((c) => ({ ...c, passed: false })),
            }
          : report
      f.control.run = { ...f.control.run!, validation: actual }
      return actual
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: f.plan.plan.approvalDigest }),
    ).rejects.toThrow('validation-failed')
    f.control.clock += 1000
    const result = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    expect(result.phase).toBe('activated')
    expect(calls).toBe(2)
    expect(f.control.rows).toBe(1)
    expect(f.control.approvals).toHaveLength(1)
    expect(result.journal.payload.approvals).toEqual(f.control.approvals)
  } finally {
    f.close()
  }
})

test('missing PostgreSQL scratch produces a reviewable blocked plan before conversion', async () => {
  const f = makeSwitchFixture()
  try {
    const source = await f.deps.source.discover({
      location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      emptyTables: [],
      operationRoot: f.root,
    })
    const pending = {
      ...source,
      preflight: {
        ...source.preflight,
        kind: 'postgresql-database' as const,
        requiresOfflineUpgrade: true,
        fingerprint: { ...source.preflight.fingerprint, provider: 'postgresql' as const },
      },
    }
    const installation = f.deps.installation
    f.deps.installation = async () => ({
      ...(await installation()),
      source: { kind: 'postgresql-database', profileRef: 'env:SOURCE_URL' },
      facts: { ...(await installation()).facts, provider: 'postgresql' },
    })
    f.deps.source.discover = async () => pending
    f.deps.content.capture = async () => {
      throw new Error('content codecs must await source upgrade')
    }
    f.deps.conversion.dryRun = async () => {
      throw new Error('conversion must await the scratch database')
    }
    const plan = await f.app.plan({ target: { provider: 'postgresql', urlEnv: 'TARGET_URL' } })
    expect(plan.plan.payload.blocks.map((b) => b.block.code)).toContain('v3-scratch-required')
    expect(plan.plan.payload.conversionPlan.coverage).toBe('partial')
    expect(plan.plan.payload.requiresOfflineUpgrade).toBe(true)
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('plan-blocked')
    expect(f.control.quiesceCalls).toBe(0)
  } finally {
    f.close()
  }
})

test('discovery-file interruption reuses its original time and journal envelope', async () => {
  const f = makeSwitchFixture()
  try {
    const create = f.deps.journal.create
    f.deps.journal.create = async () => {
      throw new Error('lost discovery acknowledgement')
    }
    await expect(f.app.plan({})).rejects.toThrow('lost discovery acknowledgement')
    const original = await f.deps.journal.readArtifact(f.operationId, 'discovery.json')
    f.control.clock += 10000
    f.deps.journal.create = create
    const plan = await f.app.plan({})
    expect(plan.operationId).toBe(f.operationId)
    expect(await f.deps.journal.readArtifact(f.operationId, 'discovery.json')).toEqual(original)
    expect((await f.deps.journal.read(f.operationId))!.payload.createdAt).toBe(123)
  } finally {
    f.close()
  }
})
