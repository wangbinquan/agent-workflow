// RFC-310 T31a —— configuration upgrade preview/apply（application 半边；HTTP
// 面随 PR-8）。锁：①noop 幂等不 bump epoch；②apply 原子 repin + epoch+1；
// ③prepared effect 被作废、dispatched 不动（外部真相归 reconciler）；④缺
// published revision 拒绝；⑤active writable action 拒绝；⑥fence 期间拒绝。

import { describe, expect, test } from 'bun:test'

import {
  applyConfigurationUpgrade,
  previewConfigurationUpgrade,
} from '../src/modules/development-automation/application/commands/configurationUpgrade'
import {
  publishAutomationPolicy,
  reviseAutomationPolicyDraft,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import { buildPr2Fixture } from './helpers/rfc310Pr2Fixture'

const now = () => Date.now()

function codeOf(err: unknown): string {
  return (err as { code?: string }).code ?? String(err)
}

describe('rfc310 pr2 configuration upgrade', () => {
  test('noop preview/apply; real apply repins policy and bumps epoch; prepared effects die', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('t31a-main')
    const mission = f.store.getMission(missionId)!

    // 第二个 policy revision 供升级目标。
    await reviseAutomationPolicyDraft(f.db, {
      id: f.policyId,
      draft: defaultAutomationPolicyContent(),
    })
    const receipt2 = await publishAutomationPolicy(f.db, { id: f.policyId, publishedBy: 'admin' })
    expect(receipt2.revision).toBe(2)

    const noop = await applyConfigurationUpgrade(
      { store: f.store, lookup: f.lookup, now },
      { missionId: mission.id, nextEmployee: null, nextPolicy: null },
    )
    expect(noop.noop).toBe(true)
    expect(f.store.getMission(mission.id)!.epoch).toBe(mission.epoch)

    const prepared = f.store.prepareEffect({
      id: '01T31APREPAREDEFFECTXXXXX0',
      missionId: mission.id,
      actionRunId: null,
      effectKind: 'mr.comment.create',
      intentDigest: 'd'.repeat(64),
      idempotencyKey: `t31a:${mission.id}`,
      epoch: mission.epoch,
      now: now(),
    })

    const plan = await previewConfigurationUpgrade(
      { store: f.store, lookup: f.lookup, now },
      { missionId: mission.id, nextEmployee: null, nextPolicy: { id: f.policyId, revision: 2 } },
    )
    expect(plan.noop).toBe(false)
    expect(plan.changes).toHaveLength(1)
    expect(plan.invalidates.pendingDecisionRefs).toContain(prepared.effect.id)

    const applied = await applyConfigurationUpgrade(
      { store: f.store, lookup: f.lookup, now },
      { missionId: mission.id, nextEmployee: null, nextPolicy: { id: f.policyId, revision: 2 } },
    )
    expect(applied.noop).toBe(false)
    const after = f.store.getMission(mission.id)!
    expect(after.epoch).toBe(mission.epoch + 1)
    expect(after.policyRevision).toBe(2)
    const effects = f.store.listUnsettledEffects(mission.id)
    expect(effects.find((e) => e.id === prepared.effect.id)).toBeUndefined()
  })

  test('rejects missing revision, active writable action, and fenced missions', async () => {
    const f = await buildPr2Fixture()
    const missionId = await f.launch('t31a-neg')
    const mission = f.store.getMission(missionId)!

    let missingCode = ''
    try {
      await applyConfigurationUpgrade(
        { store: f.store, lookup: f.lookup, now },
        { missionId: mission.id, nextEmployee: null, nextPolicy: { id: f.policyId, revision: 99 } },
      )
    } catch (e) {
      missingCode = codeOf(e)
    }
    expect(missingCode).toBe('configuration-upgrade-policy-missing')

    f.store.occUpdate(mission.id, mission.revision, mission.epoch, {
      transitionFence: 'cancel-pending',
    })
    let fencedCode = ''
    try {
      await applyConfigurationUpgrade(
        { store: f.store, lookup: f.lookup, now },
        { missionId: mission.id, nextEmployee: null, nextPolicy: { id: f.policyId, revision: 2 } },
      )
    } catch (e) {
      fencedCode = codeOf(e)
    }
    expect(fencedCode.startsWith('configuration-upgrade-')).toBe(true)
  })
})
