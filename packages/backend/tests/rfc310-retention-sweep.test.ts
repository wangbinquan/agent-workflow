// RFC-310 T71 —— retention 终于有了消费者。
//
// 在此之前 `AutomationPolicy.retention.*TtlDays` 是一个**零消费者**的策略字段：
// schema 里有、设置页能改、文档写着「按保留期保留」，而终态 Mission 的 attempt
// 台账与证据指针只增不减。零消费者的策略比没有策略更坏——它让人以为清理在发生。
//
// 这组用例锁四条边界，每一条都对应一种「清多了」或「清少了」的真实事故：
//   ①终态 + 过期 ⇒ 已结算 attempt 真删、bundle 指针标 expired；
//   ②终态但**未到期** ⇒ 一个字节都不动（TTL 不是摆设）；
//   ③**非终态** ⇒ 无论多老都不动（在跑的任务的台账是它自己的回退基准）；
//   ④终态过期但 attempt **未结算** ⇒ 不删。终态 Mission 理论上不该还有在途行，
//     真有就是需要有人看的异常，不该被保留期顺手抹掉。
//
// 另锁一条口径：**不删 evidence blob**。这一版只标记，因为本仓没有覆盖全部生产者
// 的引用索引（pipeline bundle 根本没有 DB 指针行），删 blob 等于按猜测删证据。

import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import { developmentAgentAttempts, developmentBundleRefs } from '../src/db/schema'
import {
  sweepDevelopmentRetention,
  type RetentionPolicyReader,
} from '../src/modules/development-automation/infrastructure/retentionSweeper'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function readerWith(ttlDays: { bundles: number; attempts: number }): RetentionPolicyReader {
  const base = defaultAutomationPolicyContent()
  return {
    async getPolicyRevisionContent() {
      return {
        ...base,
        retention: {
          ...base.retention,
          requirementBundleTerminalTtlDays: ttlDays.bundles,
          attemptLedgerTtlDays: ttlDays.attempts,
        },
      }
    },
  }
}

interface SeedOptions {
  readonly terminalAt: number | null
  readonly settleAttempt?: boolean
}

async function seedMission(
  fx: Pr3Fixture,
  missionId: string,
  options: SeedOptions,
): Promise<{ attemptId: string; bundleRefId: string }> {
  fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: options.terminalAt === null ? 'watching' : 'merged',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-1',
    sourceKind: 'direct',
    sourceContentDigest: 'a'.repeat(64),
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'create-merge-request',
    deliveryTargetRef: null,
    deliverySourceBranch: null,
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
    terminalKind: options.terminalAt === null ? null : 'merged',
    terminalUploadFulfillment: null,
    terminalAt: options.terminalAt,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
  })

  const runId = `run-${missionId}`
  fx.store.createActionRun({
    id: runId,
    missionId,
    missionRevision: 0,
    decisionId: `dec-${missionId}`,
    capabilityId: 'change.implement',
    capabilityContractVersion: 1,
    templateId: 'tpl',
    templateRevision: 1,
    workSetDigest: null,
    inputFactDigest: 'b'.repeat(64),
    baselineRef: null,
    writable: true,
    now: 0,
  })
  const attemptId = ulid()
  fx.db
    .insert(developmentAgentAttempts)
    .values({
      id: attemptId,
      actionRunId: runId,
      rerunSeq: 0,
      attemptSeq: 0,
      executionRef: 'exec-1',
      baselineRef: 'base',
      nonceDigest: 'c'.repeat(64),
      inputDigest: 'd'.repeat(64),
      status: options.settleAttempt === false ? 'running' : 'validated',
      createdAt: 0,
      settledAt: options.settleAttempt === false ? null : 1,
    })
    .run()

  const bundleRefId = ulid()
  fx.db
    .insert(developmentBundleRefs)
    .values({
      id: bundleRefId,
      missionId,
      purpose: 'requirement-bundle',
      evidenceRef: 'bundle-1',
      manifestDigest: 'e'.repeat(64),
      fileCount: 1,
      totalBytes: 10,
      retentionState: 'active',
      createdAt: 0,
    })
    .run()
  return { attemptId, bundleRefId }
}

function attemptExists(fx: Pr3Fixture, id: string): boolean {
  return fx.db
    .select()
    .from(developmentAgentAttempts)
    .all()
    .some((row) => row.id === id)
}

function bundleState(fx: Pr3Fixture, id: string): string | undefined {
  return fx.db
    .select()
    .from(developmentBundleRefs)
    .all()
    .find((row) => row.id === id)?.retentionState
}

describe('RFC-310 T71 —— 终态 Mission 的 retention 执行', () => {
  test('terminal + expired: settled attempts are pruned and bundle pointers marked', async () => {
    const fx = await buildPr3Fixture()
    const seeded = await seedMission(fx, 'm-expired', { terminalAt: NOW - 40 * DAY })
    const result = await sweepDevelopmentRetention(
      fx.db,
      readerWith({ bundles: 30, attempts: 30 }),
      NOW,
    )
    expect({
      pruned: result.prunedAttempts,
      marked: result.markedBundleRefs,
      pending: result.expiredBundleRefsPending,
    }).toEqual({ pruned: 1, marked: 1, pending: 1 })
    expect(attemptExists(fx, seeded.attemptId)).toBe(false)
    // 标记而非删除：可逆、可见，等引用索引到位才谈得上清 blob。
    expect(bundleState(fx, seeded.bundleRefId)).toBe('expired')
  })

  test('terminal but inside the TTL: nothing is touched', async () => {
    const fx = await buildPr3Fixture()
    const seeded = await seedMission(fx, 'm-fresh', { terminalAt: NOW - 5 * DAY })
    const result = await sweepDevelopmentRetention(
      fx.db,
      readerWith({ bundles: 30, attempts: 30 }),
      NOW,
    )
    expect({ pruned: result.prunedAttempts, marked: result.markedBundleRefs }).toEqual({
      pruned: 0,
      marked: 0,
    })
    expect(attemptExists(fx, seeded.attemptId)).toBe(true)
    expect(bundleState(fx, seeded.bundleRefId)).toBe('active')
  })

  test('a live mission is never swept, however old', async () => {
    const fx = await buildPr3Fixture()
    const seeded = await seedMission(fx, 'm-live', { terminalAt: null })
    const result = await sweepDevelopmentRetention(
      fx.db,
      readerWith({ bundles: 1, attempts: 1 }),
      NOW,
    )
    // 在跑任务的 attempt 台账是它自己的回退基准，保留期与它无关。
    expect({ scanned: result.missionsScanned, pruned: result.prunedAttempts }).toEqual({
      scanned: 0,
      pruned: 0,
    })
    expect(attemptExists(fx, seeded.attemptId)).toBe(true)
  })

  test('an unsettled attempt on a terminal mission survives the sweep', async () => {
    const fx = await buildPr3Fixture()
    const seeded = await seedMission(fx, 'm-unsettled', {
      terminalAt: NOW - 40 * DAY,
      settleAttempt: false,
    })
    const result = await sweepDevelopmentRetention(
      fx.db,
      readerWith({ bundles: 30, attempts: 30 }),
      NOW,
    )
    // 终态 Mission 上还有在途 attempt 是需要有人看的异常，不该被保留期抹掉。
    expect(result.prunedAttempts).toBe(0)
    expect(attemptExists(fx, seeded.attemptId)).toBe(true)
    expect(bundleState(fx, seeded.bundleRefId)).toBe('expired')
  })
})
