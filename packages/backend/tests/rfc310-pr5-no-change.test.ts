// RFC-310 PR-5 T55a —— no-change 人工确认收束（completed-no-change 的唯一入口）。
//
// 锁（§8.2 尾段）：①analyze already-satisfied-candidate / implement
// validated-no-change 且尚无 MR、policy=human-confirmation 时，重派
// request-human-decision → mission awaiting-information + gate cells；
// ②confirmNoChange 是唯一通道：receipt cells + working→completed-no-change
// 两步合法转移 + terminal 列；③upload plan 有 created/replaced entry 时
// gate 不开（seed 必须走发布链）且 confirm 防御复检也拒；④gate 未挂起 /
// 非 awaiting 状态的确认被 typed 拒；⑤program-proof 模式不开人工 gate。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

import { confirmNoChange } from '../src/modules/development-automation/application/commands/confirmNoChange'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type { RepositoryFactsCollectorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { buildPr3Fixture, PR3_JAVA_CELLS } from './helpers/rfc310Pr3Fixture'
import { fakeAgentActionPorts } from './helpers/rfc310AgentPorts'

setDefaultTimeout(120_000)

const repoCollector: RepositoryFactsCollectorPort = {
  async collect() {
    return { cells: structuredClone(PR3_JAVA_CELLS) as never, factsRef: 'probe-1' }
  },
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown'
  }
}

/** 把 mission 摆到「implement 返回 no-change 已结算」的后置态。 */
async function settleNoChange(
  fx: Awaited<ReturnType<typeof buildPr3Fixture>>,
  deps: ReturnType<Awaited<ReturnType<typeof buildPr3Fixture>>['deps']>,
  key: string,
): Promise<string> {
  const missionId = await fx.launchDirect(key)
  await fx.materializer.stashDirectSubmission({
    missionId,
    submission: { title: 'Add feature', body: 'do the thing', uploads: [] },
  })
  await runMissionReconcile(deps, missionId) // materialize
  // 直接注入 no-change 后置 cells（orchestrator 结算路径在 PR-4 测试已锁；
  // 这里聚焦重派与确认命令）。
  const mission = fx.store.getMission(missionId)!
  const base = fx.snapshots.getCells(mission.requirementBundleRef!) ?? {}
  const { createSqliteMissionStore } =
    await import('../src/modules/development-automation/infrastructure/sqliteMissionStore')
  const { canonicalStringify, canonicalDigest } =
    await import('../src/modules/development-automation/domain/canonicalJson')
  const store = createSqliteMissionStore(fx.db)
  const merged = {
    ...base,
    'action.lastOutcome': { state: 'known', value: 'no-change', sourceRevision: 'att-1' },
  }
  store.insertFactSnapshot({
    id: `snap-nc-${key}`,
    missionId,
    missionRevision: mission.revision,
    capturedAt: new Date().toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged as never),
    refsJson: canonicalStringify({ kind: 'test' }),
    digest: canonicalDigest(merged as never),
    now: Date.now(),
  })
  store.occUpdate(mission.id, mission.revision, mission.epoch, {
    requirementBundleRef: `snap-nc-${key}`,
  })
  return missionId
}

describe('rfc310 pr5 T55a — no-change human gate', () => {
  test('human-confirmation policy: gate redispatch → awaiting-information → confirm → completed-no-change', async () => {
    // 规则用默认链形态（implement 读 scopeDisposition）：no-change 后该 fact
    // 缺席 ⇒ fact-unavailable block ⇒ gate 重派可拦（COLLECT 类决策不拦）。
    const fx = await buildPr3Fixture({
      noChangeConfirmation: 'human-confirmation',
      rules: [
        {
          ruleId: 'implement-when-ready',
          when: [{ kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' }],
          capabilityId: 'change.implement',
        },
      ],
    })
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db }),
    })
    const missionId = await settleNoChange(fx, deps, 'nc-happy-1')

    // no-change 形态 + 规则无匹配 ⇒ 重派 human gate。
    const gateRound = await runMissionReconcile(deps, missionId)
    expect(gateRound.kind === 'decided' && gateRound.selected.kind).toBe('request-human-decision')
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('awaiting-information')
    const cells = fx.snapshots.getCells(mission.requirementBundleRef!)!
    expect(cells['__gate.pendingHumanDecision']).toMatchObject({
      state: 'known',
      value: 'no-change-confirmation',
    })

    // 确认 = 唯一进入 completed-no-change 的通道。
    const confirmed = await confirmNoChange(deps, {
      missionId,
      receiptNote: 'verified manually: repo already satisfies the demand',
    })
    expect(confirmed.status).toBe('completed-no-change')
    expect(confirmed.receiptRef).toMatch(/^[0-9a-f]{64}$/)
    const terminal = fx.store.getMission(missionId)!
    expect(terminal.status).toBe('completed-no-change')
    expect(terminal.terminalKind).toBe('no-change-confirmed')
    expect(terminal.terminalAt).not.toBeNull()
    const receiptCells = fx.snapshots.getCells(terminal.requirementBundleRef!)!
    expect(receiptCells['__gate.noChangeReceipt']).toMatchObject({ state: 'known' })

    // 终态吸收：再次 reconcile 是 noop。
    const after = await runMissionReconcile(deps, missionId)
    expect(after.kind).toBe('terminal-noop')
  })

  test('program-proof policy (default) never opens the human gate', async () => {
    const fx = await buildPr3Fixture({
      rules: [
        {
          ruleId: 'implement-when-ready',
          when: [{ kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' }],
          capabilityId: 'change.implement',
        },
      ],
    })
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db }),
    })
    const missionId = await settleNoChange(fx, deps, 'nc-program-1')
    const round = await runMissionReconcile(deps, missionId)
    expect(round.kind === 'decided' && round.selected.kind).not.toBe('request-human-decision')
    expect(fx.store.getMission(missionId)!.status).not.toBe('awaiting-information')
  })

  test('created/replaced upload entries keep the gate shut and the confirm command refuses', async () => {
    const fx = await buildPr3Fixture({
      noChangeConfirmation: 'human-confirmation',
      rules: [
        {
          ruleId: 'implement-when-ready',
          when: [{ kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' }],
          capabilityId: 'change.implement',
        },
      ],
    })
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db }),
    })
    const missionId = await settleNoChange(fx, deps, 'nc-upload-1')
    // 模拟带 created entry 的 plan：uploadPlanReader fake + mission 指针。
    const mission = fx.store.getMission(missionId)!
    fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
      uploadPlanRef: 'plan-1',
    })
    const depsWithPlan = {
      ...deps,
      ports: {
        ...deps.ports,
        uploadPlanReader: {
          read: () => ({
            planDigest: 'p'.repeat(64),
            baselineSha: 'a'.repeat(40),
            entries: [
              {
                ordinal: 0,
                fileId: 'f1',
                targetPath: 'docs/spec.md',
                contentPolicy: 'preserve-upload' as const,
                fileMode: 'regular' as const,
                disposition: 'create' as const,
                uploadSha256: 'e'.repeat(64),
              },
            ],
          }),
        },
      },
    }
    const round = await runMissionReconcile(depsWithPlan, missionId)
    expect(round.kind === 'decided' && round.selected.kind).not.toBe('request-human-decision')

    // 防御复检：即使 gate cells 被人为摆上，confirm 也拒。
    const { createSqliteMissionStore } =
      await import('../src/modules/development-automation/infrastructure/sqliteMissionStore')
    const { canonicalStringify, canonicalDigest } =
      await import('../src/modules/development-automation/domain/canonicalJson')
    const store = createSqliteMissionStore(fx.db)
    const fresh = fx.store.getMission(missionId)!
    const base = fx.snapshots.getCells(fresh.requirementBundleRef!) ?? {}
    const merged = {
      ...base,
      '__gate.pendingHumanDecision': {
        state: 'known',
        value: 'no-change-confirmation',
        sourceRevision: 'forged',
      },
    }
    store.insertFactSnapshot({
      id: 'snap-forged-gate',
      missionId,
      missionRevision: fresh.revision,
      capturedAt: new Date().toISOString().replace('Z', '+00:00'),
      cellsJson: canonicalStringify(merged as never),
      refsJson: canonicalStringify({ kind: 'test' }),
      digest: canonicalDigest(merged as never),
      now: Date.now(),
    })
    store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      requirementBundleRef: 'snap-forged-gate',
      status: 'awaiting-information',
    })
    expect(
      await codeOf(
        depsWithPlan.ports.uploadPlanReader !== undefined
          ? confirmNoChange(depsWithPlan, { missionId, receiptNote: 'try to skip seed' })
          : Promise.reject(new Error('unreachable')),
      ),
    ).toBe('no-change-uploads-pending')
  })

  test('confirm without a pending gate / outside awaiting-information is typed-refused', async () => {
    const fx = await buildPr3Fixture({
      noChangeConfirmation: 'human-confirmation',
      rules: [
        {
          ruleId: 'implement-when-ready',
          when: [{ kind: 'enum-equals', fact: 'requirement.scopeDisposition', value: 'ready' }],
          capabilityId: 'change.implement',
        },
      ],
    })
    const deps = fx.deps({
      repositoryFacts: repoCollector,
      ...fakeAgentActionPorts({ db: fx.db }),
    })
    const missionId = await settleNoChange(fx, deps, 'nc-refuse-1')

    // working 状态：admissibility 拒。
    expect(await codeOf(confirmNoChange(deps, { missionId, receiptNote: 'x' }))).toBe(
      'mission-command-not-awaiting-information',
    )

    // awaiting-information 但无 gate：cells 复核拒。
    const mission = fx.store.getMission(missionId)!
    fx.store.occUpdate(mission.id, mission.revision, mission.epoch, {
      status: 'awaiting-information',
    })
    expect(await codeOf(confirmNoChange(deps, { missionId, receiptNote: 'x' }))).toBe(
      'no-change-gate-not-pending',
    )
  })
})
