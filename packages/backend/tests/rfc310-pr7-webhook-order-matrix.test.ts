// RFC-310 T82 —— webhook 重放 / 乱序 / 迟到的显式矩阵。
//
// design §「直接信 webhook/pipeline callback 状态」被明确否决：**webhook 只唤醒**，
// 状态一律由平台自己采集的 facts 决定。这条不变量此前只有散落的单点断言
// （delivery-key 幂等在 store 层、freshness 失效在 care 链），没有一个把
// 「投递顺序不影响收敛结果」当成矩阵锁住的用例——plan.md §13c 把它记为 T82 遗留。
//
// 本文件用同一个受控 code host（`hostState` 变量 = 外部真相）跑三种投递序：
//   ①按序：评论 → 合并；
//   ②乱序/迟到：外部已经 merged，之后才收到那条**早于合并**的评论投递；
//   ③重放：同一 delivery key 投两次。
// 三种序必须收敛到同一个终态，且第②种绝不能对着陈旧评论派发 reply——那正是
// 「信 payload」会犯的错。

import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type {
  MergeRequestFactsCollectorPort,
  MrEffectsPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/attemptSupport'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'
import { JAVA_CELLS } from './helpers/rfc310Pr2Fixture'

const MR_HEAD = 'ab'.repeat(20)

/** 规则永不匹配 ⇒ 政策链静止在 block，MR care 接管（与发布链测试同款姿势）。 */
const NEVER_MATCH_RULES = [
  {
    ruleId: 'never',
    when: [{ kind: 'boolean-is' as const, fact: 'requirement.bundleComplete', value: false }],
    capabilityId: 'change.implement' as const,
  },
]

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'webhook-order-matrix' }
}

/** 外部真相：受控的 code host 状态机（webhook 投递不会改它，只有它决定收敛结果）。 */
interface HostTruth {
  terminal: 'active' | 'merged'
}

async function seedWatchingMission(fx: Pr3Fixture, missionId: string, now: number): Promise<void> {
  fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'watching',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: `repo-${missionId}`,
    sourceKind: 'direct',
    sourceContentDigest: 'a'.repeat(64),
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: null,
    deliverySourceBranch: `aw/mission/${missionId}`,
    adoptedMrRef: null,
    assignmentId: null,
    employeeId: null,
    employeeRevision: null,
    policyId: fx.policyId,
    policyRevision: 1,
    requirementBundleRef: null,
    repositoryFactsRef: null,
    uploadPlanRef: null,
    uploadPlacementRef: null,
    uploadPublicationRef: null,
    mrClaimId: `claim-${missionId}`,
    currentActionRunId: null,
    readinessJson: null,
    blockCode: null,
    blockDetail: null,
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  })
  const seed = { 'requirement.bundleComplete': cell(true), '__mr.ref': cell('11') }
  const snapId = ulid()
  fx.store.insertFactSnapshot({
    id: snapId,
    missionId,
    missionRevision: 0,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(seed),
    refsJson: '{}',
    digest: canonicalDigest(seed),
    now,
  })
  const mission = fx.store.getMission(missionId)!
  fx.store.occUpdate(missionId, mission.revision, mission.epoch, { requirementBundleRef: snapId })
}

/**
 * 一次「投递 + 驱动到静止」。webhook 只写 wake hint（与生产的 ingress 同形），
 * 随后由 reconcile 自己去采集事实——测试里刻意不把 payload 交给平台。
 */
async function deliverAndDrain(
  fx: Pr3Fixture,
  missionId: string,
  deliveryKey: string,
  deps: Parameters<typeof runMissionReconcile>[0],
  now: number,
): Promise<{ accepted: boolean; rounds: number }> {
  const accepted = fx.store.recordWakeHint({
    id: ulid(),
    missionId,
    source: 'code-host',
    deliveryKey,
    now,
  }).accepted
  let rounds = 0
  for (; rounds < 6; rounds += 1) {
    const outcome = await runMissionReconcile(deps, missionId)
    const kind = (outcome as { kind: string }).kind
    if (kind === 'terminal-noop' || kind === 'deduped' || kind === 'not-found') break
    const mission = fx.store.getMission(missionId)
    if (mission !== null && (mission.status === 'merged' || mission.status === 'closed-unmerged')) {
      break
    }
  }
  return { accepted, rounds }
}

async function runOrder(
  order: readonly { readonly key: string; readonly mergeBefore?: boolean }[],
): Promise<{
  status: string
  blockCode: string | null
  replies: unknown[]
  collectCount: number
}> {
  const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
  const missionId = `m-${Math.random().toString(36).slice(2, 10)}`
  const now = 20_000_000
  await seedWatchingMission(fx, missionId, now)

  const truth: HostTruth = { terminal: 'active' }
  let collectCount = 0
  const collector: MergeRequestFactsCollectorPort = {
    async collect() {
      collectCount += 1
      return {
        cells: {
          'mr.exists': cell(true),
          'mr.draft': cell(false),
          'mr.mergeable': cell('yes'),
          // 关键：外部真相，不是投递顺序。
          'mr.terminalState': cell(truth.terminal),
          '__mr.factsCollectedAt': cell(String(Date.now())),
        },
        snapshotRef: 's'.repeat(64),
        headSha: MR_HEAD,
        targetSha: null,
        threads: [
          {
            threadRef: 'th-human',
            revision: '1:20',
            authorClass: 'human',
            resolved: false,
            bodyDigest: 'd'.repeat(64),
            body: 'Please document the public behavior.',
            path: 'src/App.java',
          },
        ],
      }
    },
  }
  const replies: unknown[] = []
  const mrEffects: MrEffectsPort = {
    async reply(_repo, input) {
      replies.push(input)
      return { ok: true, noteRef: 'note-1' }
    },
    async observe() {
      throw new Error('not used')
    },
    async ensure() {
      throw new Error('not used')
    },
  }
  const deps = fx.deps({
    attemptContext: createAttemptContextStore(fx.evidence),
    // 仓库事实是 mission 推进的前置（与 webhook 顺序无关）；给一个固定探针即可。
    repositoryFacts: {
      async collect() {
        return { cells: structuredClone(JAVA_CELLS) as never, factsRef: 'probe-order-matrix' }
      },
    },
    mergeRequestFacts: collector,
    mrEffects,
  })

  for (const [index, step] of order.entries()) {
    if (step.mergeBefore === true) truth.terminal = 'merged'
    await deliverAndDrain(fx, missionId, step.key, deps, now + index + 1)
  }
  const m = fx.store.getMission(missionId)!
  // blockCode 一并回传：收敛失败时最想知道的就是"停在哪条 typed block 上"。
  return { status: m.status, blockCode: m.blockCode, replies, collectCount }
}

describe('RFC-310 T82 — webhook replay / out-of-order / late delivery matrix', () => {
  test('in-order and out-of-order deliveries converge on the same collected truth', async () => {
    // ①按序：先来评论（外部仍 active），随后外部合并、合并事件到达。
    const inOrder = await runOrder([{ key: 'wh:comment' }, { key: 'wh:merged', mergeBefore: true }])
    expect({ status: inOrder.status, blockCode: inOrder.blockCode }).toEqual({
      status: 'merged',
      blockCode: null,
    })
    expect(inOrder.collectCount).toBeGreaterThan(0)

    // ②乱序 / 迟到：外部**先**合并，那条早于合并的评论投递才姗姗来迟。
    //    平台重新采集 ⇒ 看到 merged ⇒ 直接收终态；绝不能对着陈旧评论派 reply。
    const outOfOrder = await runOrder([{ key: 'wh:comment-late', mergeBefore: true }])
    expect({ status: outOfOrder.status, blockCode: outOfOrder.blockCode }).toEqual({
      status: 'merged',
      blockCode: null,
    })
    expect(outOfOrder.replies).toEqual([])
    expect(outOfOrder.collectCount).toBeGreaterThan(0)

    // 两条序列的终态一致 —— 这正是「webhook 只唤醒」的可执行判据。
    expect(outOfOrder.status).toBe(inOrder.status)
  })

  test('a replayed delivery key is accepted once and changes nothing the second time', async () => {
    const fx = await buildPr3Fixture()
    const missionId = 'm-replay-matrix'
    const now = 20_000_000
    await seedWatchingMission(fx, missionId, now)

    const first = fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:same-delivery',
      now,
    })
    const second = fx.store.recordWakeHint({
      id: ulid(),
      missionId,
      source: 'code-host',
      deliveryKey: 'wh:same-delivery',
      now: now + 1,
    })
    expect(first.accepted).toBe(true)
    // 重放不是"再唤醒一次"，是同一次投递 —— 幂等键挡住，消费面只见一条。
    expect(second.accepted).toBe(false)
    expect(fx.store.consumeWakeHints(missionId, now + 2)).toBe(1)
    expect(fx.store.consumeWakeHints(missionId, now + 3)).toBe(0)
  })
})
