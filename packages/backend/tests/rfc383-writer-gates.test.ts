// RFC-383: former PostgreSQL wiring reproduced against both databases before the shared writer gates.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { developmentMissions, developmentWakeHints } from '@/db/schema'
import { composeDigitalEmployeeWriterCutoverFor } from '@/modules/digital-employee/composition'
import {
  sweepWakesWhileDraining,
  recoverWhileDraining,
} from '@/modules/development-automation/application/writerCutoverGates'
import { sweepMissionWakes } from '@/modules/development-automation/application/missionWakeSweep'
import { recoverMissions } from '@/modules/development-automation/application/missionRecovery'
import {
  listFencedMissionIds,
  listPreparedEffectRows,
  missionEpochsOf,
  listUnconsumedWakeHintMissionIds,
} from '@/modules/development-automation/infrastructure/reconcilerReaders'
import type { MergeRequestFactsCollectorPort } from '@/modules/development-automation/application/ports/reconcilerPorts'
import type { FactCellValue } from '@/modules/development-automation/domain/facts'
import type { FactCell } from '@/modules/development-automation/domain/factCell'
import { buildPr3Fixture, type ProviderPr3Fixture as Pr3Fixture } from './helpers/rfc310Pr3Fixture'
import { buildPr2Fixture } from './helpers/rfc310Pr2Fixture'
import { describeEachProvider } from './helpers/eachProvider'
const log = { warn() {}, info() {} }
const MR_HEAD = 'ef'.repeat(20)

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'reopen-test' }
}

/** 受控 code host：terminalState 由测试拨动，不由投递载荷决定。 */
function collectorFor(state: 'active' | 'closed' | 'merged'): {
  port: MergeRequestFactsCollectorPort
  calls: () => number
} {
  let calls = 0
  return {
    calls: () => calls,
    port: {
      async collect() {
        calls += 1
        return {
          cells: {
            'mr.exists': cell(true),
            'mr.draft': cell(false),
            'mr.mergeable': cell('unknown'),
            'mr.terminalState': cell(state),
          },
          snapshotRef: 'a'.repeat(64),
          headSha: MR_HEAD,
          targetSha: null,
          threads: [],
        }
      },
    },
  }
}

interface SeedOptions {
  readonly sourceKind?: 'direct' | 'external-reference'
  readonly materializedSource?: boolean
}

async function seedClosedMission(
  fx: Pr3Fixture,
  missionId: string,
  options: SeedOptions = {},
): Promise<{ claimId: string }> {
  const now = 30_000_000
  const sourceKind = options.sourceKind ?? 'direct'
  await fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'closed-unmerged',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-1',
    sourceKind,
    sourceContentDigest: sourceKind === 'direct' ? 'b'.repeat(64) : null,
    requestedSourceKey: sourceKind === 'external-reference' ? 'sys-a' : null,
    externalId: sourceKind === 'external-reference' ? 'TICKET-9' : null,
    resolvedSourceKey: sourceKind === 'external-reference' ? 'sys-a' : null,
    resolvedAdapterId: sourceKind === 'external-reference' ? 'adapter-1' : null,
    resolvedAdapterRevision: sourceKind === 'external-reference' ? 3 : null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: 'refs/heads/main',
    deliverySourceBranch: `aw/mission/${missionId}`,
    adoptedMrRef: null,
    assignmentId: null,
    employeeId: fx.employeeId,
    employeeRevision: 1,
    policyId: fx.policyId,
    policyRevision: 1,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: null,
    currentActionRunId: null,
    readinessJson: null,
    blockCode: null,
    blockDetail: null,
    terminalKind: 'closed-unmerged',
    terminalUploadFulfillment: null,
    terminalAt: now,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  })

  const claimId = `claim-${missionId}`
  const claimed = await fx.store.claimMr({
    id: claimId,
    codeHostEndpointRef: 'endpoint-1',
    stableProjectRef: 'project-1',
    mrIid: '77',
    missionId,
    epoch: 0,
    headSha: MR_HEAD,
    now,
  })
  expect(claimed.ok).toBe(true)
  // 终态时释放 claim（与 mark-terminal arm 同款），reopen 必须能在这之后重新 claim。
  await fx.store.releaseMr(claimId, now)
  {
    const m = (await fx.store.getMission(missionId))!
    await fx.store.occUpdate(m.id, m.revision, m.epoch, { mrClaimId: claimId })
  }

  await fx.store.insertMissionSource({
    id: ulid(),
    missionId,
    generation: 1,
    sourceKind,
    externalId: sourceKind === 'external-reference' ? 'TICKET-9' : null,
    adapterId: sourceKind === 'external-reference' ? 'adapter-1' : null,
    adapterRevision: sourceKind === 'external-reference' ? 3 : null,
    sourceRevision: 'rev-1',
    bundleRef: options.materializedSource === false ? null : 'bundle-old',
    manifestDigest: 'c'.repeat(64),
    fileCount: 2,
    totalBytes: 512,
    state: options.materializedSource === false ? 'active' : 'materialized',
    createdAt: now,
  })
  return { claimId }
}

describeEachProvider('RFC-383 writer gates and former wiring', (harness) => {
  for (const former of [true, false]) {
    test(`${former ? 'former PG' : 'shared gate'}: migration mode and drain total follow the next wake period`, async () => {
      const writerCutover = composeDigitalEmployeeWriterCutoverFor(harness.db)
      await harness.db.insert(developmentMissions).values({
        id: 'drain',
        status: 'running',
        repositoryId: 'repo',
        sourceKind: 'direct',
        deliveryKind: 'merge-request',
        createdAt: 1,
        updatedAt: 1,
      })
      await writerCutover.activate({ legacyAdmissionsEnabled: false })
      await harness.db
        .update(developmentMissions)
        .set({ status: 'completed', terminalAt: 2 })
        .where(eq(developmentMissions.id, 'drain'))
      const automation = { sweepWakes: async () => ({ reconciled: 0 }) }
      if (former) await automation.sweepWakes()
      else await sweepWakesWhileDraining({ writerCutover, automation, log })
      expect(await writerCutover.read()).toMatchObject({
        mode: former ? 'legacy-draining' : 'os-active',
        legacyOpenMissionCount: former ? 1 : 0,
      })
      expect((await writerCutover.analyze()).draining).toEqual([])
    })
    test(`${former ? 'former PG' : 'shared gate'}: closed MR reopen ${former ? 'creates a successor and claim' : 'retains the hint without new legacy work'}`, async () => {
      const fx = await buildPr3Fixture({ db: harness.db })
      const missionId = 'closed-mr'
      await seedClosedMission(fx, missionId)
      const collector = collectorFor('active')
      const writerCutover = composeDigitalEmployeeWriterCutoverFor(harness.db)
      await writerCutover.activate({ legacyAdmissionsEnabled: false })
      await fx.store.recordWakeHint({
        id: ulid(),
        missionId,
        source: 'code-host',
        deliveryKey: 'reopened',
        now: Date.now(),
      })
      const automation = {
        sweepWakes: () =>
          sweepMissionWakes(fx.deps({ mergeRequestFacts: collector.port }), {
            listUnconsumedWakeHintMissionIds: () => listUnconsumedWakeHintMissionIds(harness.db),
          }),
      }
      if (former) await automation.sweepWakes()
      else await sweepWakesWhileDraining({ writerCutover, automation, log })
      const successor = await fx.store.findByIdempotencyKey(`reopen:${missionId}`)
      expect(successor === null).toBe(!former)
      expect(collector.calls()).toBe(former ? 1 : 0)
      const hints = await harness.db
        .select()
        .from(developmentWakeHints)
        .where(eq(developmentWakeHints.missionId, missionId))
      expect(hints[0]!.consumedAt === null).toBe(!former)
      if (successor) expect((await fx.store.getMrClaim(successor.mrClaimId!))!.state).toBe('active')
    })
    test(`${former ? 'former PG skipped boot step' : 'shared recovery'}: fenced cancellation, stale effects and due wakes`, async () => {
      const f = await buildPr2Fixture(harness.db)
      const missionId = await f.launch('recovery')
      const mission = (await f.store.getMission(missionId))!
      const effect = await f.store.prepareEffect({
        id: ulid(),
        missionId,
        actionRunId: null,
        effectKind: 'mr.ensure',
        intentDigest: 'b'.repeat(64),
        idempotencyKey: 'stale',
        epoch: mission.epoch,
        now: Date.now(),
      })
      await f.store.bumpEpoch(mission.id, mission.revision, { transitionFence: 'cancel-pending' })
      const wakeMissionId = await f.launch('wake-recovery')
      await f.store.armWake({
        id: ulid(),
        missionId: wakeMissionId,
        decisionId: ulid(),
        reason: 'recovery-test',
        resumeAt: Date.now() - 1000,
        wakeSources: ['timer'],
        attemptOrdinal: 4,
        now: Date.now(),
      })
      const writerCutover = composeDigitalEmployeeWriterCutoverFor(harness.db)
      await writerCutover.activate({ legacyAdmissionsEnabled: false })
      const automation = {
        recover: () =>
          recoverMissions(f.deps({}), {
            listFencedMissionIds: () => listFencedMissionIds(harness.db),
            listPreparedEffectRows: () => listPreparedEffectRows(harness.db),
            missionEpochsOf: (ids: readonly string[]) => missionEpochsOf(harness.db, ids),
          }),
      }
      // DLP previously excluded PostgreSQL, so neither recovery nor an equivalent call ran.
      if (!former) await recoverWhileDraining({ writerCutover, automation, log })
      expect((await f.store.getEffect(effect.effect.id))!.state).toBe(
        former ? 'prepared' : 'invalidated',
      )
      expect((await f.store.getMission(missionId))!.transitionFence).toBe(
        former ? 'cancel-pending' : 'none',
      )
      if (!former) expect((await f.store.getMission(missionId))!.status).toBe('canceled')
      expect(await f.store.listDueWakes(Date.now())).toHaveLength(former ? 1 : 0)
      expect((await f.store.getMission(wakeMissionId))!.readinessJson === null).toBe(former)
    })
  }
  test('draining still sweeps, recovery reads current writer state instead of a saved boot value', async () => {
    const writerCutover = composeDigitalEmployeeWriterCutoverFor(harness.db)
    await writerCutover.activate({ legacyAdmissionsEnabled: false })
    let wakes = 0,
      recoveries = 0
    const automation = {
      sweepWakes: async () => ({ reconciled: ++wakes }),
      recover: async () => ({
        settledFences: ++recoveries,
        pendingFences: 0,
        invalidatedEffects: 0,
        firedWakes: 0,
      }),
    }
    await recoverWhileDraining({ writerCutover, automation, log })
    expect(recoveries).toBe(0)
    await harness.db.insert(developmentMissions).values({
      id: 'adopted',
      status: 'running',
      repositoryId: 'repo',
      sourceKind: 'direct',
      deliveryKind: 'merge-request',
      createdAt: 1,
      updatedAt: 1,
    })
    await sweepWakesWhileDraining({ writerCutover, automation, log })
    await recoverWhileDraining({ writerCutover, automation, log })
    expect(wakes).toBe(1)
    expect(recoveries).toBe(1)
  })
  test('writer refresh and wake failures retain separate best-effort diagnostics', async () => {
    const messages: string[] = []
    const failures = {
      warn(message: string) {
        messages.push(message)
      },
    }
    const writerCutover = composeDigitalEmployeeWriterCutoverFor(harness.db)
    await sweepWakesWhileDraining({
      writerCutover: {
        ...writerCutover,
        refresh: async () => {
          throw new Error('refresh')
        },
      },
      automation: {
        sweepWakes: async () => {
          throw new Error('must not sweep')
        },
      },
      log: failures,
    })
    await sweepWakesWhileDraining({
      writerCutover,
      automation: {
        sweepWakes: async () => {
          throw new Error('wake')
        },
      },
      log: failures,
    })
    expect(messages).toEqual(['development writer refresh failed', 'development wake sweep failed'])
  })
})
