// RFC-310 T81 —— 外部 reopen 已关闭的 MR（design §10.4）。
//
// 这条链的全部意义在一句不变量上：**终态不逆转**。`closed-unmerged` 那条 Mission
// 是外部事实的忠实记录，把它翻回 working 等于事后篡改台账（已结算的 upload
// fulfillment、已释放的 claim、已写下的 terminalAt 全都会变成谎话）。所以正解是
// 另建一条**带链接的新 Mission generation** 去接管当前 MR/head。
//
// 锁六件事：
//   ①原 Mission 终态字段逐个不动；②后继带 `reopenedFromMissionId` 链接、以 adopt
//   模式指向同一条 MR、继承钉住的 employee/policy；③后继重新 claim 到同一条 MR
//   （旧 claim 已 released，唯一索引是 `state='active'` 的部分索引，所以能重新
//   claim）；④幂等——同一条终态 Mission 收多少次投递都只派生一条后继；⑤MR 仍是
//   closed/merged 时**什么都不发生**（状态一律自采，不信投递载荷）；⑥来源分档：
//   direct 继承需求证据并直接 materialized，external 留 active 交给既有链重采。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type { MergeRequestFactsCollectorPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import { shouldWakeForWebhook } from '../src/modules/development-automation/domain/webhookWake'
import { createSqliteMissionCodeHostEventContinuation } from '../src/modules/development-automation/composition'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

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
  fx.store.createMission({
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
  const claimed = fx.store.claimMr({
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
  fx.store.releaseMr(claimId, now)
  {
    const m = fx.store.getMission(missionId)!
    fx.store.occUpdate(m.id, m.revision, m.epoch, { mrClaimId: claimId })
  }

  fx.store.insertMissionSource({
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

describe('rfc310 pr7b T81 — the reopen signal actually reaches the probe', () => {
  // 这一组锁的是**接线**而不是逻辑：reopen 探针只在收到 wake hint 时才跑，而
  // webhook 入口原先只对 `active` 的 claim 落 hint。MR 关闭时平台释放了 claim，
  // 于是「外部重开」这件事在生产上永远产生不了 hint——整条链会是死代码。
  test('a released claim on a closed-unmerged mission still wakes; other released ones do not', () => {
    // active：正常在跑，照常唤醒。
    expect(shouldWakeForWebhook({ claimState: 'active', missionTerminalKind: null })).toBe(true)
    // released + closed-unmerged：这就是 reopen 信号，必须唤醒。
    expect(
      shouldWakeForWebhook({ claimState: 'released', missionTerminalKind: 'closed-unmerged' }),
    ).toBe(true)
    // released + merged：终态不接受重开。
    expect(shouldWakeForWebhook({ claimState: 'released', missionTerminalKind: 'merged' })).toBe(
      false,
    )
    // released 但 Mission 未终态（handoff 后 tracking-only 之类）：不该被 webhook 拽回来。
    expect(shouldWakeForWebhook({ claimState: 'released', missionTerminalKind: null })).toBe(false)
    // 平台根本不认识这条 MR。
    expect(shouldWakeForWebhook({ claimState: null, missionTerminalKind: null })).toBe(false)
  })

  test('the Event Center continuation owns the predicate and the Webhook route stays decoupled', () => {
    // 纯函数好断言，但它得真的被调用。现在该职责属于 Event Center 的消费者
    // adapter；Webhook ingress 只发布事件，不能重新跨界写 Mission 表。
    const route = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'webhooks.ts'),
      'utf8',
    )
    const continuation = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'development-automation',
        'infrastructure',
        'missionCodeHostEventContinuation.ts',
      ),
      'utf8',
    )
    expect(route).not.toContain('development-automation')
    expect(continuation).toContain('shouldWakeForWebhook({')
    expect(continuation).not.toContain("claim !== null && claim.state === 'active'")
    const at = continuation.indexOf('shouldWakeForWebhook({')
    const record = continuation.indexOf('recordWakeHint({', at)
    expect(record).toBeGreaterThan(at)
    expect(record - at).toBeLessThan(1_000)
  })

  test('a matching Event Center continuation records one idempotent wake hint', async () => {
    const fx = await buildPr3Fixture()
    const missionId = 'm-event-center-reopen-wake'
    await seedClosedMission(fx, missionId)
    const continuation = createSqliteMissionCodeHostEventContinuation(fx.db)

    expect(
      await continuation.match({ provider: 'endpoint-1', repoPath: 'project-1', mrIid: '77' }),
    ).toMatchObject({ continuationRef: missionId })
    await continuation.consume({
      continuationRef: missionId,
      eventDeliveryId: 'event-delivery-reopen-1',
      occurredAt: 30_000_001,
    })
    await continuation.consume({
      continuationRef: missionId,
      eventDeliveryId: 'event-delivery-reopen-1',
      occurredAt: 30_000_002,
    })
    expect(fx.store.consumeWakeHints(missionId, 30_000_003)).toBe(1)
  })
})

describe('rfc310 pr7b T81 — external reopen creates a linked successor generation', () => {
  test('reopened MR spawns one adopt-mode successor; the closed mission stays terminal', async () => {
    const fx = await buildPr3Fixture()
    const missionId = 'm-reopen-happy'
    const { claimId } = await seedClosedMission(fx, missionId)
    const collector = collectorFor('active')
    const deps = fx.deps({ mergeRequestFacts: collector.port })

    // 没有投递时不探外部：终态 Mission 只增不减，每轮都探等于成本随历史线性增长。
    expect(await runMissionReconcile(deps, missionId)).toEqual({ kind: 'terminal-noop' })
    expect(collector.calls()).toBe(0)

    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:reopened',
      now: 30_000_100,
    })
    const outcome = await runMissionReconcile(deps, missionId)
    expect(outcome.kind).toBe('mission-reopened')
    if (outcome.kind !== 'mission-reopened') return
    expect(collector.calls()).toBe(1)

    // ①原 Mission 终态逐字不动。
    const closed = fx.store.getMission(missionId)!
    expect({
      status: closed.status,
      terminalKind: closed.terminalKind,
      terminalAt: closed.terminalAt,
    }).toEqual({
      status: 'closed-unmerged',
      terminalKind: 'closed-unmerged',
      terminalAt: 30_000_000,
    })

    // ②后继带链接、adopt 模式、继承钉住的配置。
    const successor = fx.store.getMission(outcome.successorMissionId)!
    expect({
      reopenedFromMissionId: successor.reopenedFromMissionId,
      status: successor.status,
      deliveryKind: successor.deliveryKind,
      adoptedMrRef: successor.adoptedMrRef,
      employeeId: successor.employeeId,
      policyId: successor.policyId,
      terminalKind: successor.terminalKind,
    }).toEqual({
      reopenedFromMissionId: missionId,
      status: 'watching',
      deliveryKind: 'adopt-merge-request',
      adoptedMrRef: '77',
      employeeId: fx.employeeId,
      policyId: fx.policyId,
      terminalKind: null,
    })

    // ③重新 claim 到同一条 MR：旧 claim 仍是 released，新的是 active。
    expect(successor.mrClaimId).not.toBeNull()
    expect(successor.mrClaimId).not.toBe(claimId)
    expect(fx.store.getMrClaim(claimId)!.state).toBe('released')
    const freshClaim = fx.store.getMrClaim(successor.mrClaimId!)!
    expect({
      state: freshClaim.state,
      missionId: freshClaim.missionId,
      mrIid: freshClaim.mrIid,
      endpoint: freshClaim.codeHostEndpointRef,
      project: freshClaim.stableProjectRef,
    }).toEqual({
      state: 'active',
      missionId: successor.id,
      mrIid: '77',
      endpoint: 'endpoint-1',
      project: 'project-1',
    })

    // ⑥direct：继承需求证据，来源直接 materialized 且指向同一个 bundle。
    const successorSources = fx.store.listMissionSources(successor.id)
    expect(successorSources).toHaveLength(1)
    expect({
      generation: successorSources[0]!.generation,
      state: successorSources[0]!.state,
      bundleRef: successorSources[0]!.bundleRef,
    }).toEqual({ generation: 2, state: 'materialized', bundleRef: 'bundle-old' })

    // ④幂等：再来一次投递不会派生第二条。
    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:reopened-again',
      now: 30_000_200,
    })
    expect(await runMissionReconcile(deps, missionId)).toEqual({ kind: 'terminal-noop' })
    expect(fx.store.findByIdempotencyKey(`reopen:${missionId}`)!.id).toBe(successor.id)
  })

  test('a delivery that is not actually a reopen changes nothing', async () => {
    const fx = await buildPr3Fixture()
    const missionId = 'm-reopen-still-closed'
    await seedClosedMission(fx, missionId)
    // 外部真相仍是 closed —— 投递说了不算（与 T82 的「webhook 只唤醒」同一条纪律）。
    const collector = collectorFor('closed')
    const deps = fx.deps({ mergeRequestFacts: collector.port })

    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:noise',
      now: 30_000_100,
    })
    expect(await runMissionReconcile(deps, missionId)).toEqual({ kind: 'terminal-noop' })
    expect(collector.calls()).toBe(1)
    expect(fx.store.findByIdempotencyKey(`reopen:${missionId}`)).toBeNull()
  })

  test('external-reference successors re-collect instead of inheriting a stale snapshot', async () => {
    const fx = await buildPr3Fixture()
    const missionId = 'm-reopen-external'
    await seedClosedMission(fx, missionId, { sourceKind: 'external-reference' })
    const deps = fx.deps({ mergeRequestFacts: collectorFor('active').port })

    fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:reopened',
      now: 30_000_100,
    })
    const outcome = await runMissionReconcile(deps, missionId)
    expect(outcome.kind).toBe('mission-reopened')
    if (outcome.kind !== 'mission-reopened') return

    const sources = fx.store.listMissionSources(outcome.successorMissionId)
    expect(sources).toHaveLength(1)
    // 工单在 MR 关闭期间很可能已经变了：留 active、由既有链重新向 adapter 采集，
    // **绝不**照搬旧 bundle（那等于让新一轮基于过期需求干活）。
    expect({
      state: sources[0]!.state,
      bundleRef: sources[0]!.bundleRef,
      externalId: sources[0]!.externalId,
      adapterId: sources[0]!.adapterId,
    }).toEqual({
      state: 'active',
      bundleRef: null,
      externalId: 'TICKET-9',
      adapterId: 'adapter-1',
    })
  })
})
