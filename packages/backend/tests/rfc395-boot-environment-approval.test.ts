// RFC-395 P-2: approval binds conversion semantics; observations stay in the document.
import { expect, test } from 'bun:test'
import {
  createBootUpgradeFacts,
  canonicalBootUpgradeEffects,
  type BootUpgradeEffect,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { emptyCounts } from '@/platform/persistence/migration/conversion/receipts'
import type { UnitOutput } from '@/platform/persistence/migration/conversion/types'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  migrationPlanApprovalDigest,
  createMigrationPlanDocument,
  MigrationPlanDocumentPayloadSchema,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import { renderEpochPlan } from '@/modules/system-operations/domain/epochSwitch/planDocument'
import { makeSwitchFixture, plannedFixture } from './rfc395-v3-switch-domain.test'

const effect: BootUpgradeEffect = {
  version: 1,
  rule: { id: 'integration/boot-scheduled-payload', version: 1 },
  sourceTable: 'scheduled_tasks',
  sourceKey: encodeMigrationKey('scheduled_tasks', [canonicalValue('schedule')]),
  sourcePhase: 'current',
  sourceRowDigest: valueDigest('row'),
  disposition: 'transformed',
  targets: [
    {
      table: 'scheduled_tasks',
      key: encodeMigrationKey('scheduled_tasks', [canonicalValue('schedule')]),
    },
  ],
  before: { enabled: true },
  after: { enabled: false },
  reason: 'rfc165-local-path-retired',
  factIds: ['local-git:missing'],
}
test('strict schema, renderer and approval bind changed effects and deciding facts, not raw observations', async () => {
  const f = await plannedFixture()
  try {
    const payload = {
      ...f.plan.plan.payload,
      bootUpgradeEffects: [effect],
      bootUpgradeEnvironmentDigest: valueDigest('environment'),
    }
    const plan = createMigrationPlanDocument(payload)
    expect(renderEpochPlan(plan)).toContain('rfc165-local-path-retired')
    expect(renderEpochPlan(plan)).toContain('schedule')
    expect(
      MigrationPlanDocumentPayloadSchema.safeParse({
        ...payload,
        bootUpgradeEffects: [{ ...effect, unexpected: true }],
      }).success,
    ).toBe(false)
    for (const changed of [
      { ...payload, bootUpgradeEnvironmentDigest: valueDigest('changed root/key/config') },
      {
        ...payload,
        bootUpgradeEffects: [
          {
            ...effect,
            sourceKey: encodeMigrationKey('scheduled_tasks', [canonicalValue('other')]),
          },
        ],
      },
      { ...payload, bootUpgradeEffects: [{ ...effect, after: { enabled: true } }] },
    ])
      expect(migrationPlanApprovalDigest(changed)).not.toBe(plan.approvalDigest)
    expect(
      migrationPlanApprovalDigest({
        ...payload,
        estimates: { ...payload.estimates, rehearsalMs: 99999 },
        unfinishedTasks: [{ status: 'pending', count: 999 }],
        bootUpgradeFactsDigest: valueDigest('observation-only change'),
        contentManifestDigest: valueDigest('unread run files and mtimes'),
        bootUpgradeEffects: [
          { ...effect, sourceRowDigest: valueDigest('volatile columns changed') },
          { ...effect, disposition: 'copied', before: { unrelated: 1 }, after: { unrelated: 1 } },
        ],
        createdAt: payload.createdAt + 1,
      }),
    ).toBe(plan.approvalDigest)
    expect(canonicalBootUpgradeEffects([{ ...effect, factIds: ['b', 'a'] }])).toEqual(
      canonicalBootUpgradeEffects([{ ...effect, factIds: ['a', 'b'] }]),
    )
  } finally {
    f.close()
  }
})
test.each(['path', 'bytes', 'key', 'config'] as const)(
  '%s changes require approval before target installation and reuse K-2',
  async (kind) => {
    const f = makeSwitchFixture()
    let material = 'planned'
    f.deps.conversion = {
      ...f.deps.conversion,
      bootUpgradeEnvironment: {
        async capture() {
          return createBootUpgradeFacts([
            {
              id: kind,
              kind:
                kind === 'key'
                  ? 'repository-url-key'
                  : kind === 'config'
                    ? 'runtime-config'
                    : kind === 'bytes'
                      ? 'skill-content'
                      : 'local-git',
              material,
              evidence: null,
            },
          ])
        },
      },
    }
    try {
      const plan = await f.app.plan({})
      material = 'frozen-change'
      const paused = await f.app.run({
        operationId: f.operationId,
        approve: plan.plan.approvalDigest,
      })
      expect(paused.phase).toBe('frozen')
      expect(paused.status).toBe('awaiting-approval')
      expect(f.control.installed).toBe(false)
      expect(f.control.rows).toBe(0)
      expect(paused.journal.payload.plan!.approvalDigest).not.toBe(plan.plan.approvalDigest)
      const resumed = await f.app.run({
        operationId: f.operationId,
        approve: paused.journal.payload.plan!.approvalDigest,
      })
      expect(resumed.phase).toBe('activated')
      expect(resumed.journal.payload.approvals).toHaveLength(2)
    } finally {
      f.close()
    }
  },
)
test('the post-conversion check detects drift before activation, with exactly two run captures', async () => {
  const f = makeSwitchFixture()
  let captures = 0
  f.deps.conversion = {
    ...f.deps.conversion,
    bootUpgradeEnvironment: {
      async capture(input) {
        captures++
        return createBootUpgradeFacts([
          {
            id: 'key',
            kind: 'repository-url-key',
            material: input.stage === 'run' ? 'changed' : 'same',
            evidence: { captures },
          },
        ])
      },
    },
  }
  try {
    const plan = await f.app.plan({})
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('boot-environment-changed-new-run-required')
    expect(f.control.rows).toBe(1)
    expect(f.control.installed).toBe(true)
    expect(f.control.activationDigest).toBeNull()
    expect(captures).toBe(3) // plan, frozen pre-create, post-conversion
  } finally {
    f.close()
  }
})
test('pure observation evidence changes document facts but not material approval', () => {
  const fact = {
    id: 'git',
    kind: 'local-git' as const,
    material: { root: '/same', oid: 'same' },
    evidence: { elapsed: 1 },
  }
  expect(createBootUpgradeFacts([fact]).environmentDigest).toBe(
    createBootUpgradeFacts([{ ...fact, evidence: { elapsed: 99 } }]).environmentDigest,
  )
})

test('unchanged material reaches activation while updated observations change the document digest', async () => {
  const f = makeSwitchFixture()
  let observation = 'planned raw config bytes'
  f.deps.conversion = {
    ...f.deps.conversion,
    bootUpgradeEnvironment: {
      async capture() {
        return createBootUpgradeFacts([
          {
            id: 'runtime-config',
            kind: 'runtime-config',
            material: { opencodePath: '/same/binary' },
            evidence: { rawDigest: valueDigest(observation) },
          },
        ])
      },
    },
  }
  try {
    const plan = await f.app.plan({})
    observation = 'same config semantics with different whitespace'
    const completed = await f.app.run({
      operationId: f.operationId,
      approve: plan.plan.approvalDigest,
    })
    expect(completed.phase).toBe('activated')
    expect(completed.journal.payload.plan!.approvalDigest).toBe(plan.plan.approvalDigest)
    expect(completed.journal.payload.plan!.digest).not.toBe(plan.plan.digest)
    expect(completed.journal.payload.approvals).toHaveLength(1)
  } finally {
    f.close()
  }
})

test('material drift between units is checked once after conversion and blocks a changed resume', async () => {
  const f = makeSwitchFixture()
  let material = 'accepted'
  const committed: string[] = []
  const originalCreate = f.deps.target.create
  f.deps.target = {
    ...f.deps.target,
    async create(input) {
      const target = await originalCreate(input)
      return {
        ...target,
        openRun(init) {
          const sink = target.openRun(init)
          return {
            ...sink,
            async commitUnit(output) {
              await sink.commitUnit(output)
              committed.push(output.receipt.unitId)
            },
          }
        },
      }
    },
  }
  const output = (unitId: string): UnitOutput => ({
    receipt: {
      version: 1,
      unitId,
      unit: {
        kind: 'source-chunk',
        table: 'scheduled_tasks',
        phase: 'current',
        afterKey: null,
        limit: 1,
      },
      sourceVersion: 'epoch1-fixture',
      rule: effect.rule,
      lookups: [],
      sources: [],
      targets: [],
      counts: { ...emptyCounts(), exceptions: 0, historyOnly: 0 },
      digest: valueDigest(unitId),
    },
    rows: [],
    dispositions: [],
    artifacts: [],
    archives: [],
    blocks: [],
    records: [],
  })
  const originalRun = f.deps.conversion.run
  f.deps.conversion = {
    ...f.deps.conversion,
    bootUpgradeEnvironment: {
      async capture() {
        return createBootUpgradeFacts([
          { id: 'git-ref', kind: 'local-git', material, evidence: null },
        ])
      },
    },
    async run(request, sink) {
      return originalRun(request, {
        ...sink,
        async finish(summary) {
          await sink.commitUnit(output('first'))
          material = 'changed'
          await sink.commitUnit(output('second'))
          await sink.finish(summary)
        },
      })
    },
  }
  try {
    const plan = await f.app.plan({})
    await expect(
      f.app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
    ).rejects.toThrow('boot-environment-changed-new-run-required')
    expect(committed).toEqual(['first', 'second'])
    expect(f.control.activationDigest).toBeNull()
    await expect(f.app.run({ operationId: f.operationId })).rejects.toThrow(
      'boot-environment-changed-new-run-required',
    )
    expect(committed).toEqual(['first', 'second'])
  } finally {
    f.close()
  }
})
