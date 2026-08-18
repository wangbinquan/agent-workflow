// RFC-310 PR-7b T83 —— crash matrix：关键外发临界区中断后的收敛（design §11.4）。
//
// 原则：每个外发副作用（commit/push/mr-ensure/reply）都有 durable effect 行，
// crash 重启后按 idempotencyKey 撞回 dispatched 行、按 intent digest 对拍后
// 幂等重放——「本地尚未确认」不当「外部未发生」。本矩阵锁三个此前未覆盖的
// 中断窗：①commit effect dispatched 后进程死（外部 commit 是否已发生由重放
// 的 (tree,parent) 幂等吸收）；②mr-ensure confirmed 后、claim/cells 落库前死
// （重放经先查后建 adopt 回同一 MR，claim 消歧）；③reply dispatched 后死
// （同 key 重放不产生第二条评论——fake 计数锁）。每条都用「第一轮注入
// crash、第二轮换正常端口」模拟 daemon 重启（deps 重建 = 新进程装配）。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type {
  CandidateDeliveryPort,
  MrEffectsPort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/attemptSupport'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const TREE = 'ab'.repeat(20)
const COMMIT = 'cd'.repeat(20)

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'crash-test' }
}

async function fixtureWithNeverPolicy(): Promise<{ fx: Pr3Fixture; policyId: string }> {
  const fx = await buildPr3Fixture()
  const policy = await createAutomationPolicy(fx.db, {
    name: 'pol-crash',
    ownerUserId: 'admin',
    draft: {
      ...defaultAutomationPolicyContent(),
      actionPriority: {
        rules: [
          {
            ruleId: 'never',
            when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: false }],
            capabilityId: 'change.implement',
          },
        ],
      },
    },
  })
  await publishAutomationPolicy(fx.db, { id: policy.id, publishedBy: 'admin' })
  return { fx, policyId: policy.id }
}

async function seedDeliveredMission(
  fx: Pr3Fixture,
  policyId: string,
): Promise<{ missionId: string; runId: string }> {
  const now = Date.now()
  const missionId = ulid()
  const runId = `run-${missionId}`
  const overlayRoot = mkdtempSync(join(tmpdir(), 'rfc310-crash-overlay-'))
  writeFileSync(join(overlayRoot, 'Main.java'), 'class Main {}\n')
  fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'working',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-crash',
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
    employeeId: null,
    employeeRevision: null,
    policyId,
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
    terminalKind: null,
    terminalUploadFulfillment: null,
    terminalAt: null,
    launchIdempotencyKey: `idem-${missionId}`,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  })
  fx.store.createActionRun({
    id: runId,
    missionId,
    missionRevision: 0,
    decisionId: `dec-${missionId}`,
    capabilityId: 'change.implement',
    capabilityContractVersion: 1,
    templateId: null,
    templateRevision: null,
    workSetDigest: null,
    inputFactDigest: 'e'.repeat(64),
    baselineRef: 'base',
    writable: true,
    now,
  })
  fx.store.settleActionRun({
    id: runId,
    status: 'settled',
    resultRef: null,
    failureJson: null,
    now,
  })
  const attemptContext = createAttemptContextStore(fx.evidence)
  const preRef = await attemptContext.save(
    JSON.stringify({
      baselineRepoPath: '/nonexistent/base',
      baselineSha: 'b'.repeat(40),
      workspacePath: overlayRoot,
    }),
  )
  fx.store.claimAttempt({
    id: `att-${missionId}`,
    actionRunId: runId,
    rerunSeq: 0,
    attemptSeq: 0,
    executionRef: null,
    baselineRef: 'base',
    nonceDigest: 'n'.repeat(64),
    inputDigest: 'i'.repeat(64),
    preSnapshotRef: preRef,
    now,
  })
  fx.store.settleAttempt({
    id: `att-${missionId}`,
    status: 'validated',
    rejectionJson: null,
    outcomeRef: 'f'.repeat(64),
    now,
  })
  const cells = {
    'requirement.bundleComplete': cell(true),
    'action.lastOutcome': cell('changed'),
    '__action.candidateState': cell('derived'),
    '__action.candidateTreeOid': cell(TREE),
    '__action.candidateRef': cell('f'.repeat(64)),
    '__action.runId': cell(runId),
  }
  const snapId = ulid()
  fx.store.insertFactSnapshot({
    id: snapId,
    missionId,
    missionRevision: 0,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now,
  })
  const mission = fx.store.getMission(missionId)!
  fx.store.occUpdate(missionId, mission.revision, mission.epoch, { requirementBundleRef: snapId })
  return { missionId, runId }
}

function goodDelivery(commits: unknown[], pushes: unknown[]): CandidateDeliveryPort {
  return {
    async stage() {
      throw new Error('not used')
    },
    async commit(input) {
      commits.push(input)
      // (tree,parent) 幂等：重放返回 reused。
      return { ok: true, commitSha: COMMIT, localRef: 'refs/aw/x', reused: commits.length > 1 }
    },
    async push(input) {
      pushes.push(input)
      return {
        ok: true,
        receipt: {
          remoteRef: `refs/heads/${input.branch}`,
          oldSha: input.expectedRemoteSha,
          newSha: input.commitSha,
          reused: pushes.length > 1,
        },
      }
    },
  }
}

function goodMr(ensures: unknown[]): MrEffectsPort {
  return {
    async ensure(_repo, input) {
      ensures.push(input)
      return {
        ok: true,
        mr: {
          mrRef: '7',
          webUrl: null,
          state: 'opened',
          sourceSha: COMMIT,
          // 先查后建：第二次 ensure adopt 回同一 MR。
          created: ensures.length === 1,
          providerCorrelationRef: 'gitlab:grp/repo!7',
        },
      }
    },
    async reply() {
      return { ok: true, noteRef: 'note-1' }
    },
    async observe() {
      return {
        ok: true,
        observation: {
          mrRef: '7',
          state: 'opened',
          sourceSha: COMMIT,
          targetBranch: 'main',
          webUrl: null,
        },
      }
    },
  }
}

describe('rfc310 pr7b T83 — crash matrix converges after restart', () => {
  test('commit dispatched → crash → restart replays by idempotency key and the chain reaches MR + watching', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy()
    const { missionId } = await seedDeliveredMission(fx, policyId)
    const commits: unknown[] = []
    const pushes: unknown[] = []
    const ensures: unknown[] = []

    // 第一轮：commit 端口在外发中途「进程死」（抛出即本轮中断；effect 行留在
    // dispatched——正是 crash 窗口的持久化形态）。
    const crashing: CandidateDeliveryPort = {
      ...goodDelivery(commits, pushes),
      async commit() {
        throw new Error('simulated daemon crash mid-commit')
      },
    }
    const crashDeps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: crashing,
      repoRemote: { resolve: () => ({ remoteUrl: '/tmp/remote.git', defaultBranch: 'main' }) },
      mrEffects: goodMr(ensures),
    })
    await expect(runMissionReconcile(crashDeps, missionId)).rejects.toThrow('simulated daemon')
    const hanging = fx.store.listUnsettledEffects(missionId)
    expect(hanging).toHaveLength(1)
    expect(hanging[0]).toMatchObject({ effectKind: 'candidate-commit', state: 'dispatched' })

    // 「重启」：全新 deps（新进程装配），端口恢复正常。悬挂 dispatched 行按
    // 同 idempotencyKey 撞回、intent digest 对拍后幂等重放。
    const restarted = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: goodDelivery(commits, pushes),
      repoRemote: { resolve: () => ({ remoteUrl: '/tmp/remote.git', defaultBranch: 'main' }) },
      mrEffects: goodMr(ensures),
    })
    const r1 = await runMissionReconcile(restarted, missionId) // commit 重放
    expect(r1).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])
    const r2 = await runMissionReconcile(restarted, missionId) // push
    expect(r2).toMatchObject({ kind: 'decided', handled: 'collected' })
    const r3 = await runMissionReconcile(restarted, missionId) // ensure-MR
    expect(r3).toMatchObject({ kind: 'decided', handled: 'collected' })
    const mission = fx.store.getMission(missionId)!
    expect(mission.status).toBe('watching')
    expect(mission.mrClaimId).not.toBeNull()
    expect(commits).toHaveLength(1) // crash 轮没打到端口；重放轮恰一次
    expect(pushes).toHaveLength(1)
    expect(ensures).toHaveLength(1)
  })

  test('mr-ensure confirmed → crash before claim/cells → restart adopts the same MR (no duplicate)', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy()
    const { missionId } = await seedDeliveredMission(fx, policyId)
    const commits: unknown[] = []
    const pushes: unknown[] = []
    const ensures: unknown[] = []
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: goodDelivery(commits, pushes),
      repoRemote: { resolve: () => ({ remoteUrl: '/tmp/remote.git', defaultBranch: 'main' }) },
      mrEffects: goodMr(ensures),
    })
    await runMissionReconcile(deps, missionId) // commit
    await runMissionReconcile(deps, missionId) // push

    // 手工构造「ensure 已 confirm、claim/cells 未落」的 crash 后态。
    const mission = fx.store.getMission(missionId)!
    const prepared = fx.store.prepareEffect({
      id: ulid(),
      missionId,
      actionRunId: null,
      effectKind: 'mr-ensure',
      intentDigest: canonicalDigest({
        kind: 'mr-ensure',
        missionId,
        branch: mission.deliverySourceBranch,
        targetBranch: 'main',
      }),
      idempotencyKey: `mr:${missionId}:${mission.deliverySourceBranch}`,
      epoch: mission.epoch,
      now: Date.now(),
    })
    fx.store.markEffectDispatched(prepared.effect.id, Date.now())
    fx.store.confirmEffect(prepared.effect.id, 'gitlab:grp/repo!7', Date.now())
    expect(fx.store.getMission(missionId)!.mrClaimId).toBeNull()

    // 重启轮：claim 撞回 already-confirmed 分派 → ensure 幂等重查（adopt）→
    // claim 消歧落库；不造第二个 MR。
    const r = await runMissionReconcile(deps, missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'collected' })
    const after = fx.store.getMission(missionId)!
    expect(after.mrClaimId).not.toBeNull()
    expect(after.status).toBe('watching')
    expect(ensures).toHaveLength(1) // already-confirmed 分派只重查一次
  })

  test('reply dispatched → crash → restart replays once, ledger settles, no duplicate note', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy()
    const missionId = ulid()
    const now = Date.now()
    fx.store.createMission({
      id: missionId,
      revision: 0,
      epoch: 0,
      status: 'watching',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-crash2',
      sourceKind: 'direct',
      sourceContentDigest: 'a'.repeat(64),
      requestedSourceKey: null,
      externalId: null,
      resolvedSourceKey: null,
      resolvedAdapterId: null,
      resolvedAdapterRevision: null,
      deliveryKind: 'create-merge-request',
      deliveryTargetRef: null,
      deliverySourceBranch: 'aw/mission/z',
      adoptedMrRef: null,
      assignmentId: null,
      employeeId: null,
      employeeRevision: null,
      policyId,
      policyRevision: 1,
      requirementBundleRef: null,
      repositoryFactsRef: null,
      uploadPlanRef: null,
      uploadPlacementRef: null,
      uploadPublicationRef: null,
      mrClaimId: 'claim-z',
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
    fx.store.upsertFeedbackObservation({
      id: 'fb-z',
      missionId,
      threadRef: 'th-z',
      revision: '1:5',
      headSha: COMMIT,
      fingerprint: 'f'.repeat(64),
      authorClass: 'human',
      now,
    })
    const cells = {
      'requirement.bundleComplete': cell(true),
      '__mr.ref': cell('7'),
      '__mr.headSha': cell(COMMIT),
      '__mr.factsCollectedAt': cell(String(Date.now() + 3_600_000)),
      '__feedback.lastDispositions': cell(
        JSON.stringify([{ threadRef: 'th-z', revision: '1:5', disposition: 'addressed' }]),
      ),
    }
    const snapId = ulid()
    fx.store.insertFactSnapshot({
      id: snapId,
      missionId,
      missionRevision: 0,
      capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
      cellsJson: canonicalStringify(cells),
      refsJson: '{}',
      digest: canonicalDigest(cells),
      now,
    })
    {
      const m = fx.store.getMission(missionId)!
      fx.store.occUpdate(missionId, m.revision, m.epoch, { requirementBundleRef: snapId })
    }

    const replies: unknown[] = []
    const crashingMr: MrEffectsPort = {
      ...goodMr([]),
      async reply() {
        throw new Error('simulated crash mid-reply')
      },
    }
    const crashDeps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      mrEffects: crashingMr,
    })
    await expect(runMissionReconcile(crashDeps, missionId)).rejects.toThrow('mid-reply')
    expect(
      fx.store.listUnsettledEffects(missionId).filter((e) => e.effectKind === 'mr-reply'),
    ).toHaveLength(1)

    const okMr: MrEffectsPort = {
      ...goodMr([]),
      async reply(_repo, input) {
        replies.push(input)
        return { ok: true, noteRef: 'note-z' }
      },
    }
    const restarted = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      mrEffects: okMr,
    })
    const r = await runMissionReconcile(restarted, missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect(replies).toHaveLength(1)
    const row = fx.store.listFeedback(missionId).find((x) => x.id === 'fb-z')!
    expect(row.state).toBe('addressed')
    expect(fx.store.listUnsettledEffects(missionId)).toEqual([])
  })
})
