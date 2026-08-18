// RFC-310 PR-5 T56/T57/T59 —— candidate 发布链（missionDeliveryChain）。
//
// 锁：①redispatch 只接管「candidate derived + 规则无话可说」的静止态，进度
// cells 绑定 treeOid（换树自动重启链）；②verification handler 的 stage 重放
// treeOid 对拍 + failed 即 typed block；③commit→push→ensure-MR 单轮一 effect
// 逐轮推进（durable effect 台账 prepared→dispatched→confirmed，intent digest
// 对拍）；④dispatched 悬挂 effect 撞 idempotencyKey 重放而非卡死；⑤intent
// drift 即 fail+block；⑥MR 建立后 block 改写为诚实 wait（MR care 属 PR-7）。
// 注意 bun test --randomize 会打乱同 describe 内 test 顺序：链式推进收在
// 单个 test 内串行走轮。

import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  DELIVERY_EFFECT_KINDS,
  handleRunVerification,
  redispatchDelivery,
  type DeliveryChainDeps,
} from '../src/modules/development-automation/application/missionDeliveryChain'
import { runMissionReconcile } from '../src/modules/development-automation/application/missionReconciler'
import type { MissionRow } from '../src/modules/development-automation/application/ports/missionStore'
import type {
  CandidateDeliveryPort,
  MrEffectsPort,
  ReconcilerPorts,
  RepoRemotePort,
} from '../src/modules/development-automation/application/ports/reconcilerPorts'
import {
  defaultAutomationPolicyContent,
  type AutomationPolicyContent,
} from '../src/modules/development-automation/domain/automationPolicy'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { NextDecision } from '../src/modules/development-automation/domain/decision'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import { createAttemptContextStore } from '../src/modules/development-automation/infrastructure/attemptSupport'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const TREE = 't'.repeat(40)
const COMMIT = 'c'.repeat(40)

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'test' }
}

/** 规则永不匹配（bundleComplete=true vs 要求 false）→ 决策静止在 block。 */
const NEVER_MATCH_RULES = [
  {
    ruleId: 'never',
    when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: false }],
    capabilityId: 'change.implement' as const,
  },
]

function deliveredCells(runId: string): Record<string, FactCell<FactCellValue>> {
  return {
    'requirement.bundleComplete': cell(true),
    'action.lastOutcome': cell('changed'),
    'action.lastCapability': cell('change.implement'),
    '__action.candidateState': cell('derived'),
    '__action.candidateTreeOid': cell(TREE),
    '__action.candidateRef': cell('f'.repeat(64)),
    '__action.runId': cell(runId),
  }
}

function persistCellsSnapshot(
  fx: Pr3Fixture,
  missionId: string,
  cells: Record<string, FactCell<FactCellValue>>,
): void {
  const mission = fx.store.getMission(missionId)!
  const id = ulid()
  fx.store.insertFactSnapshot({
    id,
    missionId,
    missionRevision: mission.revision,
    capturedAt: new Date().toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(cells),
    refsJson: '{}',
    digest: canonicalDigest(cells),
    now: Date.now(),
  })
  fx.store.occUpdate(missionId, mission.revision, mission.epoch, { requirementBundleRef: id })
}

function currentCells(fx: Pr3Fixture, missionId: string): Record<string, FactCell<FactCellValue>> {
  const mission = fx.store.getMission(missionId)!
  return { ...(fx.snapshots.getCells(mission.requirementBundleRef!) ?? {}) }
}

/** working mission + settled writable run + validated attempt + pre-state blob。 */
async function seedDeliveredMission(fx: Pr3Fixture): Promise<{
  readonly missionId: string
  readonly runId: string
  readonly overlayRoot: string
}> {
  const now = Date.now()
  const missionId = ulid()
  const runId = `run-${missionId}`
  const overlayRoot = mkdtempSync(join(tmpdir(), 'rfc310-dc-overlay-'))
  writeFileSync(join(overlayRoot, 'Main.java'), 'class Main {}\n')
  fx.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status: 'working',
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: 'repo-dc',
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
    baselineRef: 'base-dc',
    writable: true,
    now,
  })
  fx.store.settleActionRun({
    id: runId,
    status: 'settled',
    resultRef: 'f'.repeat(64),
    failureJson: null,
    now,
  })
  const attemptContext = createAttemptContextStore(fx.evidence)
  const preRef = await attemptContext.save(
    JSON.stringify({
      baselineRepoPath: '/nonexistent/base-dc',
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
    baselineRef: 'base-dc',
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
  persistCellsSnapshot(fx, missionId, deliveredCells(runId))
  return { missionId, runId, overlayRoot }
}

function fakeDelivery(overrides: Partial<CandidateDeliveryPort> = {}): CandidateDeliveryPort {
  return {
    async stage(input) {
      const parent = mkdtempSync(join(tmpdir(), 'rfc310-dc-stage-'))
      const ws = join(parent, 'ws')
      mkdirSync(ws)
      writeFileSync(join(ws, 'Main.java'), 'class Main {}\n')
      void input
      return {
        ok: true,
        ws,
        treeOid: TREE,
        cleanup: () => rmSync(parent, { recursive: true, force: true }),
      }
    },
    async commit() {
      return { ok: true, commitSha: COMMIT, localRef: 'refs/aw/mission/x/candidate', reused: false }
    },
    async push(input) {
      return {
        ok: true,
        receipt: {
          remoteRef: `refs/heads/${input.branch}`,
          oldSha: input.expectedRemoteSha,
          newSha: input.commitSha,
          reused: false,
        },
      }
    },
    ...overrides,
  }
}

const fakeRemote: RepoRemotePort = {
  resolve: () => ({ remoteUrl: 'https://git.example.com/grp/repo.git', defaultBranch: 'main' }),
}

function fakeMr(created = true): MrEffectsPort {
  return {
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
    async ensure(_repositoryId, _input) {
      return {
        ok: true,
        mr: {
          mrRef: '7',
          webUrl: 'https://git.example.com/grp/repo/-/merge_requests/7',
          state: 'opened',
          sourceSha: COMMIT,
          created,
          providerCorrelationRef: `gitlab:grp/repo!7`,
        },
      }
    },
  }
}

// -------------------------------------------------------------- ① redispatch

describe('rfc310 pr5 — delivery chain redispatch (pure)', () => {
  const policy = defaultAutomationPolicyContent()
  const mission = {
    mrClaimId: null,
    deliverySourceBranch: null,
    deliveryKind: 'create-merge-request',
  } as MissionRow
  const block: NextDecision = { kind: 'block', reason: 'no-rule-matched' }

  test('decision matrix: takeover conditions, verification ordering, treeOid rebinding', () => {
    // 无 candidate → 不接管。
    expect(redispatchDelivery(mission, {}, policy, block)).toEqual(block)
    // 非 block（规则选中动作 / wait）→ 放行。
    const cells = deliveredCells('run-1')
    const action: NextDecision = {
      kind: 'run-agent-action',
      capabilityId: 'change.implement',
      templateRef: 'tpl@1',
      workSetRef: 'none',
    }
    expect(redispatchDelivery(mission, cells, policy, action)).toEqual(action)

    // requiredProfileRefs 空 → 直接 commit/publish（new-branch：无既有分支）。
    expect(redispatchDelivery(mission, cells, policy, block)).toEqual({
      kind: 'commit-and-publish-candidate',
      publicationMode: 'new-branch',
    })
    // 分支已在 → fast-forward。
    expect(
      redispatchDelivery(
        { ...mission, deliverySourceBranch: 'aw/mission/x' },
        cells,
        policy,
        block,
      ),
    ).toMatchObject({ publicationMode: 'fast-forward' })

    // verification 要求两个 profile：逐个派、failed 即 block、全过進 publish。
    const vp: AutomationPolicyContent = {
      ...policy,
      verification: { requiredProfileRefs: ['unit@1', 'lint@1'], stopPolicy: 'first-failure' },
    }
    expect(redispatchDelivery(mission, cells, vp, block)).toEqual({
      kind: 'run-verification',
      profileRef: 'unit@1',
    })
    const oneDone = {
      ...cells,
      '__delivery.verifiedTreeOid': cell(TREE),
      '__delivery.verifiedProfiles': cell(JSON.stringify({ 'unit@1': 'passed' })),
    }
    expect(redispatchDelivery(mission, oneDone, vp, block)).toEqual({
      kind: 'run-verification',
      profileRef: 'lint@1',
    })
    const oneFailed = {
      ...cells,
      '__delivery.verifiedTreeOid': cell(TREE),
      '__delivery.verifiedProfiles': cell(JSON.stringify({ 'unit@1': 'failed' })),
    }
    expect(redispatchDelivery(mission, oneFailed, vp, block)).toEqual({
      kind: 'block',
      reason: 'verification-failed:unit@1',
    })
    // treeOid 换了 → 旧 verification 记录失效，从头验证。
    const stale = {
      ...cells,
      '__delivery.verifiedTreeOid': cell('x'.repeat(40)),
      '__delivery.verifiedProfiles': cell(
        JSON.stringify({ 'unit@1': 'passed', 'lint@1': 'passed' }),
      ),
    }
    expect(redispatchDelivery(mission, stale, vp, block)).toEqual({
      kind: 'run-verification',
      profileRef: 'unit@1',
    })

    // 已 push（同树）→ ensure-merge-request；换树 → 重新 publish。
    const pushed = {
      ...cells,
      '__delivery.publishedTreeOid': cell(TREE),
      '__delivery.publishState': cell('pushed'),
    }
    expect(redispatchDelivery(mission, pushed, policy, block)).toEqual({
      kind: 'ensure-merge-request',
    })
    const pushedStale = {
      ...pushed,
      '__delivery.publishedTreeOid': cell('x'.repeat(40)),
    }
    expect(redispatchDelivery(mission, pushedStale, policy, block)).toMatchObject({
      kind: 'commit-and-publish-candidate',
    })
    // adopt-merge-request 不派 ensure（PR-7）。
    expect(
      redispatchDelivery(
        { ...mission, deliveryKind: 'adopt-merge-request' } as MissionRow,
        pushed,
        policy,
        block,
      ),
    ).toEqual(block)

    // MR 已建立：block → 诚实 wait；非 block 保持原样。
    const claimed = { ...mission, mrClaimId: 'claim-1' } as MissionRow
    expect(redispatchDelivery(claimed, pushed, policy, block)).toMatchObject({
      kind: 'wait',
      reason: 'mr-care-not-wired',
    })
    expect(redispatchDelivery(claimed, pushed, policy, action)).toEqual(action)
  })
})

// ----------------------------------------------- ② verification handler 直调

describe('rfc310 pr5 — verification arm', () => {
  const PROFILE = {
    schemaVersion: 1,
    steps: [
      {
        stepId: 'unit',
        programRef: 'repo:verify.sh',
        argsRef: null,
        timeoutMs: 10_000,
        networkProfileRef: 'none@1',
        successExitCodes: [0],
        evidenceSelectors: [],
      },
    ],
    stopPolicy: 'first-failure',
    maxParallel: 1,
  }

  async function runArm(
    fx: Pr3Fixture,
    missionId: string,
    opts: {
      readonly verifyOk: boolean
      readonly stagedTree?: string
      readonly profileRef?: string
    },
  ): Promise<{
    blocks: { code: string; detail: string | null }[]
    outcome: 'collected' | 'blocked'
  }> {
    const blocks: { code: string; detail: string | null }[] = []
    const ports: ReconcilerPorts = {
      requirementMaterialize: fx.materializer,
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: fakeDelivery({
        async stage() {
          const parent = mkdtempSync(join(tmpdir(), 'rfc310-dc-vstage-'))
          const ws = join(parent, 'ws')
          mkdirSync(ws)
          return {
            ok: true,
            ws,
            treeOid: opts.stagedTree ?? TREE,
            cleanup: () => rmSync(parent, { recursive: true, force: true }),
          }
        },
      }),
      verificationProfiles: { content: () => PROFILE },
      verificationExecution: {
        async run() {
          return {
            ok: opts.verifyOk,
            receiptDigest: 'd'.repeat(64),
            steps: [
              {
                stepId: 'unit',
                ok: opts.verifyOk,
                exitCode: opts.verifyOk ? 0 : 1,
                timedOut: false,
                outputTailRef: null,
              },
            ],
          }
        },
      },
    }
    const chainDeps: DeliveryChainDeps = {
      store: fx.store,
      ports,
      now: () => Date.now(),
      persistCells: (id, patch) => {
        persistCellsSnapshot(fx, id, { ...currentCells(fx, id), ...patch })
      },
      block: (id, code, detail) => {
        blocks.push({ code, detail })
        const mission = fx.store.getMission(id)!
        fx.store.occUpdate(id, mission.revision, mission.epoch, {
          status: 'blocked',
          blockCode: code,
          blockDetail: detail,
        })
      },
    }
    const mission = fx.store.getMission(missionId)!
    const outcome = await handleRunVerification(
      chainDeps,
      mission,
      currentCells(fx, missionId),
      opts.profileRef ?? 'unit@1',
    )
    return { blocks, outcome }
  }

  test('pass records treeOid-bound progress; fail blocks typed; tree drift blocks', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })

    // pass → cells 进度 + collected（不 block）。
    const a = await seedDeliveredMission(fx)
    const passed = await runArm(fx, a.missionId, { verifyOk: true })
    expect(passed.outcome).toBe('collected')
    expect(passed.blocks).toEqual([])
    const cellsA = currentCells(fx, a.missionId)
    expect(cellsA['__delivery.verifiedTreeOid']).toMatchObject({ value: TREE })
    expect(
      JSON.parse(
        cellsA['__delivery.verifiedProfiles']!.state === 'known'
          ? String(cellsA['__delivery.verifiedProfiles']!.value)
          : '{}',
      ),
    ).toEqual({ 'unit@1': 'passed' })

    // fail → verification-failed:<ref> + failed 进度（redispatch 不再重派同 profile）。
    const b = await seedDeliveredMission(fx)
    const failed = await runArm(fx, b.missionId, { verifyOk: false })
    expect(failed.outcome).toBe('blocked')
    expect(failed.blocks[0]!.code).toBe('verification-failed:unit@1')
    expect(fx.store.getMission(b.missionId)!.status).toBe('blocked')

    // stage 出来的树与记录不符 → candidate-tree-drift（绝不验证错误的树）。
    const c = await seedDeliveredMission(fx)
    const drift = await runArm(fx, c.missionId, { verifyOk: true, stagedTree: 'x'.repeat(40) })
    expect(drift.outcome).toBe('blocked')
    expect(drift.blocks[0]!.code).toBe('candidate-tree-drift')

    // 非法 profileRef（无修订）→ typed block。
    const d = await seedDeliveredMission(fx)
    const badRef = await runArm(fx, d.missionId, { verifyOk: true, profileRef: 'unit' })
    expect(badRef.blocks[0]!.code).toBe('verification-profile-ref-invalid:unit')
  })
})

// -------------------------------------- ③ 完整轮次：commit → push → MR → wait

describe('rfc310 pr5 — publish chain through reconcile rounds', () => {
  test('commit, push, ensure-MR advance one effect per round; MR claim ends the chain in wait', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
    const seeded = await seedDeliveredMission(fx)
    const pushes: unknown[] = []
    const delivery = fakeDelivery({
      async push(input) {
        pushes.push(input)
        return {
          ok: true,
          receipt: {
            remoteRef: `refs/heads/${input.branch}`,
            oldSha: input.expectedRemoteSha,
            newSha: input.commitSha,
            reused: false,
          },
        }
      },
    })
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: delivery,
      repoRemote: fakeRemote,
      mrEffects: fakeMr(),
    })

    // 轮 1：commit（effect confirmed；publishState=committed；working→publishing）。
    const r1 = await runMissionReconcile(deps, seeded.missionId)
    expect(r1).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect((r1 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'commit-and-publish-candidate',
      publicationMode: 'new-branch',
    })
    let cells = currentCells(fx, seeded.missionId)
    expect(cells['__delivery.commitSha']).toMatchObject({ value: COMMIT })
    expect(cells['__delivery.publishState']).toMatchObject({ value: 'committed' })
    expect(fx.store.getMission(seeded.missionId)!.status).toBe('publishing')

    // 轮 2：push（CAS null=分支必须缺席；deliverySourceBranch 落行）。
    const r2 = await runMissionReconcile(deps, seeded.missionId)
    expect(r2).toMatchObject({ kind: 'decided', handled: 'collected' })
    cells = currentCells(fx, seeded.missionId)
    expect(cells['__delivery.publishState']).toMatchObject({ value: 'pushed' })
    const mission2 = fx.store.getMission(seeded.missionId)!
    expect(mission2.deliverySourceBranch).toBe(`aw/mission/${seeded.missionId}`)
    expect(pushes[0]).toMatchObject({ expectedRemoteSha: null, commitSha: COMMIT })

    // 轮 3：ensure-MR（claim 落行 + __mr cells + publishing→watching）。
    const r3 = await runMissionReconcile(deps, seeded.missionId)
    expect(r3).toMatchObject({ kind: 'decided', handled: 'collected' })
    const mission3 = fx.store.getMission(seeded.missionId)!
    expect(mission3.mrClaimId).not.toBeNull()
    expect(mission3.status).toBe('watching')
    cells = currentCells(fx, seeded.missionId)
    expect(cells['__mr.ref']).toMatchObject({ value: '7' })

    // 轮 4：发布链使命完成 → PR-7 care 链接管（MR facts 尚未采集 → 派
    // collect-mr-facts；care 自身链路由 pr7 测试锁，这里只断言交接发生）。
    const r4 = await runMissionReconcile(deps, seeded.missionId)
    expect(r4).toMatchObject({ kind: 'decided' })
    expect((r4 as { selected: NextDecision }).selected).toMatchObject({
      kind: 'collect-mr-facts',
    })
    // collector 未注入 → 诚实 typed block（接线缺席可见，不静默）。
    expect(fx.store.getMission(seeded.missionId)!.blockCode).toBe(
      'collector-not-wired:merge-request',
    )

    // effect 台账：全部 confirmed（无悬挂），且只有发布链三类。
    expect(fx.store.listUnsettledEffects(seeded.missionId)).toEqual([])
  })

  test('dispatched effect from a crashed round is replayed by idempotency key, not stuck', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
    const seeded = await seedDeliveredMission(fx)
    // 模拟上一轮 crash：commit effect 已 dispatched、cells 未推进。
    const mission = fx.store.getMission(seeded.missionId)!
    const intent = {
      kind: 'candidate-commit',
      missionId: seeded.missionId,
      treeOid: TREE,
      baselineSha: 'b'.repeat(40),
      summarySource: seeded.missionId,
    }
    const prepared = fx.store.prepareEffect({
      id: ulid(),
      missionId: seeded.missionId,
      actionRunId: seeded.runId,
      effectKind: 'candidate-commit',
      intentDigest: canonicalDigest(intent),
      idempotencyKey: `commit:${seeded.missionId}:${TREE}`,
      epoch: mission.epoch,
      now: Date.now(),
    })
    fx.store.markEffectDispatched(prepared.effect.id, Date.now())
    expect(DELIVERY_EFFECT_KINDS.has('candidate-commit')).toBe(true)

    const commits: unknown[] = []
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: fakeDelivery({
        async commit(input) {
          commits.push(input)
          return { ok: true, commitSha: COMMIT, localRef: 'refs/aw/x', reused: true }
        },
      }),
      repoRemote: fakeRemote,
      mrEffects: fakeMr(),
    })
    // guard 不因 dispatched delivery effect 而 wait；同 key 撞回同一 effect 行重放。
    const r = await runMissionReconcile(deps, seeded.missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'collected' })
    expect(commits).toHaveLength(1)
    expect(fx.store.getEffect(prepared.effect.id)!.state).toBe('confirmed')
    expect(currentCells(fx, seeded.missionId)['__delivery.publishState']).toMatchObject({
      value: 'committed',
    })
  })

  test('intent drift on an existing effect row fails the effect and blocks the mission', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
    const seeded = await seedDeliveredMission(fx)
    const mission = fx.store.getMission(seeded.missionId)!
    // 同 idempotencyKey、不同 intent digest 的悬挂行（载荷漂移）。
    const prepared = fx.store.prepareEffect({
      id: ulid(),
      missionId: seeded.missionId,
      actionRunId: seeded.runId,
      effectKind: 'candidate-commit',
      intentDigest: 'deadbeef'.repeat(8),
      idempotencyKey: `commit:${seeded.missionId}:${TREE}`,
      epoch: mission.epoch,
      now: Date.now(),
    })
    fx.store.markEffectDispatched(prepared.effect.id, Date.now())
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: fakeDelivery(),
      repoRemote: fakeRemote,
      mrEffects: fakeMr(),
    })
    const r = await runMissionReconcile(deps, seeded.missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'blocked' })
    const after = fx.store.getMission(seeded.missionId)!
    expect(after.status).toBe('blocked')
    expect(after.blockCode).toBe('delivery-intent-drift:candidate-commit')
    expect(fx.store.getEffect(prepared.effect.id)!.state).toBe('failed')
  })

  test('push CAS refusal (remote-head-changed) fails the effect and blocks typed', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
    const seeded = await seedDeliveredMission(fx)
    const deps = fx.deps({
      attemptContext: createAttemptContextStore(fx.evidence),
      candidateDelivery: fakeDelivery({
        async push() {
          return { ok: false, code: 'remote-head-changed', detail: 'head moved' }
        },
      }),
      repoRemote: fakeRemote,
      mrEffects: fakeMr(),
    })
    const r1 = await runMissionReconcile(deps, seeded.missionId) // commit
    expect(r1).toMatchObject({ kind: 'decided', handled: 'collected' })
    const r2 = await runMissionReconcile(deps, seeded.missionId) // push → CAS 拒
    expect(r2).toMatchObject({ kind: 'decided', handled: 'blocked' })
    const after = fx.store.getMission(seeded.missionId)!
    expect(after.status).toBe('blocked')
    expect(after.blockCode).toBe('remote-head-changed')
    // push effect 落 failed（不 confirmed、不悬挂）。
    expect(
      fx.store.listUnsettledEffects(seeded.missionId).filter((e) => e.state === 'dispatched'),
    ).toEqual([])
  })

  test('missing delivery ports stay honest: typed block, no silent skip', async () => {
    const fx = await buildPr3Fixture({ rules: NEVER_MATCH_RULES })
    const seeded = await seedDeliveredMission(fx)
    const deps = fx.deps({ attemptContext: createAttemptContextStore(fx.evidence) })
    const r = await runMissionReconcile(deps, seeded.missionId)
    expect(r).toMatchObject({ kind: 'decided', handled: 'blocked' })
    expect(fx.store.getMission(seeded.missionId)!.blockCode).toBe(
      'delivery-port-missing:candidateDelivery',
    )
  })
})
