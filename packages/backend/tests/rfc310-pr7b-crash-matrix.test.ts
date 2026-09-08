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

import { expect, setDefaultTimeout, test } from 'bun:test'
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
import { createAutomationPolicy, publishAutomationPolicy } from './helpers/digitalEmployeeStore'
import { buildPr3Fixture, type ProviderPr3Fixture as Pr3Fixture } from './helpers/rfc310Pr3Fixture'
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'

setDefaultTimeout(120_000)

const TREE = 'ab'.repeat(20)
const COMMIT = 'cd'.repeat(20)

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'crash-test' }
}

async function fixtureWithNeverPolicy(
  db: ProviderNeutralDatabase,
): Promise<{ fx: Pr3Fixture; policyId: string }> {
  const fx = await buildPr3Fixture({ db: db })
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
  await fx.store.createMission({
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
  await fx.store.createActionRun({
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
  await fx.store.settleActionRun({
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
  await fx.store.claimAttempt({
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
  await fx.store.settleAttempt({
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
  await fx.store.insertFactSnapshot({
    id: snapId,
    missionId,
    missionRevision: 0,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now,
  })
  const mission = (await fx.store.getMission(missionId))!
  await fx.store.occUpdate(missionId, mission.revision, mission.epoch, {
    requirementBundleRef: snapId,
  })
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

describeEachProvider('rfc310 pr7b T83 — crash matrix converges after restart', (harness) => {
  test('commit dispatched → crash → restart replays by idempotency key and the chain reaches MR + watching', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy(harness.db)
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
    const hanging = await fx.store.listUnsettledEffects(missionId)
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
    expect(await fx.store.listUnsettledEffects(missionId)).toEqual([])
    const r2 = await runMissionReconcile(restarted, missionId) // push
    expect(r2).toMatchObject({ kind: 'decided', handled: 'collected' })
    const r3 = await runMissionReconcile(restarted, missionId) // ensure-MR
    expect(r3).toMatchObject({ kind: 'decided', handled: 'collected' })
    const mission = (await fx.store.getMission(missionId))!
    expect(mission.status).toBe('watching')
    expect(mission.mrClaimId).not.toBeNull()
    expect(commits).toHaveLength(1) // crash 轮没打到端口；重放轮恰一次
    expect(pushes).toHaveLength(1)
    expect(ensures).toHaveLength(1)
  })

  // 悬挂 effect 的**第二个**窗口：`prepared`（已预留、markEffectDispatched 之前就死）。
  //
  // 由来：`rfc310-pr3-journey` 的 mission stall 在 2026-09-06/07 跨 5 个 commit、3 个 OS lane
  // 红了 6 次（docs/audit-backlog.md 有完整签名），形态永远是 status 停在 `working`、
  // `blockCode` 为 null、reconcile 不抛错、把**任何**预算耗光。根因在 `commitAndHandle` 的
  // 去重逃生门只认 `state === 'dispatched'`，而 `listUnsettledEffects` 返回的是
  // `prepared ∪ dispatched`：一条停在 `prepared` 的自治 effect 同时满足①被 projectGuards 的
  // filter 排除、不改 guards；②不改 cells；③不满足 `dispatched` ⇒ decisionInputDigest 不变
  // ⇒ 决策被去重 ⇒ handleDecision 不跑 ⇒ 那条 effect 永远等不到派发。
  //
  // 这个窗口在生产里由「预留与派发是**两笔事务**、中间进程死或输掉 OCC」打开——journey 测试
  // 里路由的 fire-and-forget reconcile 与显式泵并发，正是它偶发的来源。这里用一次性错误注入
  // 精确构造那个持久化后态（决策行已在 + effect 停在 prepared），不靠卡时序。
  test('commit prepared（决策已在、尚未 dispatched）→ 下一轮不许被去重吞', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy(harness.db)
    const { missionId } = await seedDeliveredMission(fx, policyId)
    const commits: unknown[] = []
    const pushes: unknown[] = []
    const ensures: unknown[] = []
    const ports = {
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: goodDelivery(commits, pushes),
      repoRemote: { resolve: () => ({ remoteUrl: '/tmp/remote.git', defaultBranch: 'main' }) },
      mrEffects: goodMr(ensures),
    }

    // 第一轮：markEffectDispatched 抛一次 —— 预留已提交、派发标记没提交，进程就此中断。
    const crashDeps = fx.deps(ports)
    let dispatchFaultArmed = true
    const realStore = crashDeps.store
    const faultingStore: typeof realStore = {
      ...realStore,
      markEffectDispatched: async (id: string, now: number) => {
        if (dispatchFaultArmed) {
          dispatchFaultArmed = false
          throw new Error('simulated crash between prepare and dispatch')
        }
        return await realStore.markEffectDispatched(id, now)
      },
    }
    await expect(
      runMissionReconcile({ ...crashDeps, store: faultingStore }, missionId),
    ).rejects.toThrow('simulated crash')

    const hanging = await fx.store.listUnsettledEffects(missionId)
    expect(hanging).toHaveLength(1)
    expect(hanging[0]).toMatchObject({ effectKind: 'candidate-commit', state: 'prepared' })

    // 第二轮：cells/guards 一个没变 ⇒ decisionInputDigest 不变 ⇒ 决策撞回同一行。
    // 逃生门若只认 dispatched，这一轮就是 `deduped`、effect 原地不动、mission 永远停在
    // working —— 那正是线上那条停顿。修复后必须重放并把它推进掉。
    const restarted = fx.deps(ports)
    const r1 = await runMissionReconcile(restarted, missionId)
    expect(r1).not.toMatchObject({ kind: 'deduped' })
    expect(await fx.store.listUnsettledEffects(missionId)).toEqual([])
    expect(commits).toHaveLength(1)
  })

  test('mr-ensure confirmed → crash before claim/cells → restart adopts the same MR (no duplicate)', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy(harness.db)
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
    const mission = (await fx.store.getMission(missionId))!
    const prepared = await fx.store.prepareEffect({
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
    await fx.store.markEffectDispatched(prepared.effect.id, Date.now())
    await fx.store.confirmEffect(prepared.effect.id, 'gitlab:grp/repo!7', Date.now())
    expect((await fx.store.getMission(missionId))!.mrClaimId).toBeNull()

    // 重启轮：claim 撞回 already-confirmed 分派 → ensure 幂等重查（adopt）→
    // claim 消歧落库；不造第二个 MR。
    const r = await runMissionReconcile(deps, missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'collected' })
    const after = (await fx.store.getMission(missionId))!
    expect(after.mrClaimId).not.toBeNull()
    expect(after.status).toBe('watching')
    expect(ensures).toHaveLength(1) // already-confirmed 分派只重查一次
  })

  test('reply dispatched → crash → restart replays once, ledger settles, no duplicate note', async () => {
    const { fx, policyId } = await fixtureWithNeverPolicy(harness.db)
    const missionId = ulid()
    const now = Date.now()
    await fx.store.createMission({
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
    await fx.store.upsertFeedbackObservation({
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
    await fx.store.insertFactSnapshot({
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
      const m = (await fx.store.getMission(missionId))!
      await fx.store.occUpdate(missionId, m.revision, m.epoch, { requirementBundleRef: snapId })
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
      (await fx.store.listUnsettledEffects(missionId)).filter((e) => e.effectKind === 'mr-reply'),
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
    const row = (await fx.store.listFeedback(missionId)).find((x) => x.id === 'fb-z')!
    expect(row.state).toBe('addressed')
    expect(await fx.store.listUnsettledEffects(missionId)).toEqual([])
  })
})
