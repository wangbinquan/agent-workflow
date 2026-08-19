// RFC-310 PR-5 T56/T57/T59 —— candidate 发布链（verification → commit/push →
// ensure-MR）的重派与三个 decision arm。
//
// 链的接管信号是 orchestrator 结算落的内部 cells（`__action.candidateState=
// 'derived'` + `__action.candidateTreeOid`）；每个阶段的进度同样以 `__delivery.*`
// 内部 cells 携带，并全部**绑定 treeOid**——repair/重跑产生新 candidate 树时
// 旧的 verification/publish 记录自动失效，链从头重走。外发副作用（commit 落
// 内部 ref、push、MR ensure）逐个走 effects 台账：prepare→dispatch→执行→
// confirm，intent 载荷不落表、以 canonicalDigest 对拍 intent_digest；三个执行
// 体都天然幂等（commit 按 (tree,parent) 身份 reused、push exact-head CAS
// reused、MR 先查后建），dispatched 悬挂行在下一轮按同 idempotencyKey 撞回后
// 安全重放。平台在此**绝不 force push、绝不 merge/approve**（design §3.6）。
//
// verification failed 首版直接 typed block（`verification-failed:<profile>`）；
// `verification.repair` 的规则闭环需要 verification 结果升为 catalog fact 才能
// 被谓词读到，属 PR-6 注记（plan.md 交付注记）。

import { ulid } from 'ulid'

import type { AutomationPolicyContent } from '../domain/automationPolicy'
import { canonicalDigest } from '../domain/canonicalJson'
import type { NextDecision } from '../domain/decision'
import type { FactCellValue } from '../domain/facts'
import type { FactCell } from '../domain/factCell'
import { checkMissionTransition } from '../domain/mission'
import { verificationProfileContentSchema } from '../domain/verificationProfile'
import type { EffectRow, MissionRow, MissionStore } from './ports/missionStore'
import type { ReconcilerPorts } from './ports/reconcilerPorts'

/** 发布链自治的 effect kinds：不进 effect-unsettled guard（链自身是结算者）。 */
export const DELIVERY_EFFECT_KINDS: ReadonlySet<string> = new Set([
  'candidate-commit',
  'candidate-push',
  'mr-ensure',
])

export interface DeliveryChainDeps {
  readonly store: MissionStore
  readonly ports: ReconcilerPorts
  readonly now: () => number
  /** reconciler 的 requirement cells 落盘通道（同一 bundle 快照链）。 */
  persistCells(
    missionId: string,
    patch: Record<string, FactCell<FactCellValue>>,
    refs: unknown,
  ): void
  block(missionId: string, code: string, detail: string | null): void
}

type Cells = Readonly<Record<string, FactCell<FactCellValue>>>

function knownString(cells: Cells, id: string): string | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
    ? cell.value
    : null
}

function knownCell(value: FactCellValue, sourceRevision: string): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision }
}

/** `__delivery.verifiedProfiles`（JSON map，绑定 verifiedTreeOid）读回。 */
function verifiedProfilesOf(cells: Cells, treeOid: string): Record<string, 'passed' | 'failed'> {
  if (knownString(cells, '__delivery.verifiedTreeOid') !== treeOid) return {}
  const raw = knownString(cells, '__delivery.verifiedProfiles')
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, 'passed' | 'failed'> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v === 'passed' || v === 'failed') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

// ------------------------------------------------------------------ redispatch

/**
 * 发布链重派：只接管「candidate 已派生、规则无话可说（block）」的静止态，
 * 依 cells 进度派 verification → commit/publish → ensure-MR。规则选中的动作
 *（如重跑 implement/repair）一律放行——新 candidate 会覆盖 treeOid，链自动
 * 重启。MR 已建立（mrClaimId 非空）后链使命完成；MR care 属 PR-7，block
 * 改写为诚实 wait（webhook/manual 唤醒），不把「在等外部世界」谎报成故障。
 */
export function redispatchDelivery(
  mission: MissionRow,
  cells: Cells,
  policy: AutomationPolicyContent,
  selected: NextDecision,
): NextDecision {
  if (selected.kind !== 'block') {
    // claim 存在时把非本链的 block 静止态交给 care（下方 return 分支处理）；
    // 非 block 决策一律不动。
    return selected
  }
  const treeOid = knownString(cells, '__action.candidateTreeOid')
  const hasDerivedCandidate =
    knownString(cells, '__action.candidateState') === 'derived' && treeOid !== null

  // MR 已建立且没有待发布的 candidate 进度 → 静止态属 care 链（PR-7）。
  // T109 抓出：不能对「claim 非空」无条件短路——feedback 修复轮（apply
  // validated 产生新 treeOid）需要发布链在 watching 阶段再次工作，把修复
  // verify → commit → push 到 MR 分支；否则 reply 会在修复从未到达 remote
  // 的情况下发出（reviewer 看到「已解决」但分支纹丝不动）。
  const deliveryComplete =
    hasDerivedCandidate &&
    knownString(cells, '__delivery.publishedTreeOid') === treeOid &&
    knownString(cells, '__delivery.publishState') === 'pushed'
  if (mission.mrClaimId !== null && (!hasDerivedCandidate || deliveryComplete)) {
    return {
      kind: 'wait',
      reason: 'mr-care-not-wired',
      resumeAt: null,
      wakeSources: ['webhook', 'manual'],
      attemptOrdinal: 0,
    }
  }
  if (!hasDerivedCandidate || treeOid === null) return selected

  // 1) verification：policy 要求的 profile 逐个跑齐（treeOid 绑定的进度表）。
  const verified = verifiedProfilesOf(cells, treeOid)
  const required = policy.verification.requiredProfileRefs
  const failed = required.find((r) => verified[r] === 'failed')
  if (failed !== undefined) return { kind: 'block', reason: `verification-failed:${failed}` }
  const next = required.find((r) => verified[r] !== 'passed')
  if (next !== undefined) return { kind: 'run-verification', profileRef: next }

  // 2) commit + push（单轮一 effect，handler 内按 cells 进度分阶段）。
  if (
    knownString(cells, '__delivery.publishedTreeOid') !== treeOid ||
    knownString(cells, '__delivery.publishState') !== 'pushed'
  ) {
    return {
      kind: 'commit-and-publish-candidate',
      publicationMode: mission.deliverySourceBranch === null ? 'new-branch' : 'fast-forward',
    }
  }

  // 3) MR（adopt-merge-request 的接管属 PR-7；create 之外不派）。
  if (mission.deliveryKind !== 'create-merge-request') return selected
  if (mission.mrClaimId !== null) return selected
  return { kind: 'ensure-merge-request' }
}

// ------------------------------------------------------- candidate 上下文重建

interface CandidateContext {
  readonly treeOid: string
  readonly runId: string
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly overlayRoot: string
  readonly uploadPlan: {
    readonly entries: readonly {
      readonly targetPath: string
      readonly disposition: 'create' | 'replace' | 'already-present'
      readonly fileMode: 'regular' | 'executable'
    }[]
  } | null
}

/**
 * 从 cells（runId/treeOid）→ attempt 台账 → pre-state blob 重建发布链需要的
 * candidate 上下文。pre-state 是 launch 时冻结的内容寻址 JSON（Agent 不可达），
 * 其 workspacePath 即 candidate overlay 的真身。
 */
function loadCandidateContext(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  cells: Cells,
): CandidateContext | { readonly failCode: string } {
  const treeOid = knownString(cells, '__action.candidateTreeOid')
  const runId = knownString(cells, '__action.runId')
  if (treeOid === null || runId === null) return { failCode: 'candidate-context-missing:cells' }
  if (deps.ports.attemptContext === undefined) {
    return { failCode: 'delivery-port-missing:attemptContext' }
  }
  const attempts = deps.store.listAttempts(runId)
  const validated = [...attempts].reverse().find((a) => a.status === 'validated')
  if (validated === undefined || validated.preSnapshotRef === null) {
    return { failCode: 'candidate-context-missing:attempt' }
  }
  const raw = deps.ports.attemptContext.load(validated.preSnapshotRef)
  if (raw === null) return { failCode: 'candidate-context-missing:pre-state' }
  let pre: { baselineRepoPath?: unknown; baselineSha?: unknown; workspacePath?: unknown }
  try {
    pre = JSON.parse(raw) as typeof pre
  } catch {
    return { failCode: 'candidate-context-missing:pre-state-json' }
  }
  if (
    typeof pre.baselineRepoPath !== 'string' ||
    typeof pre.baselineSha !== 'string' ||
    typeof pre.workspacePath !== 'string'
  ) {
    return { failCode: 'candidate-context-missing:pre-state-fields' }
  }
  const uploadPlan =
    mission.uploadPlanRef !== null
      ? (deps.ports.uploadPlanReader?.read(mission.uploadPlanRef) ?? null)
      : null
  return {
    treeOid,
    runId,
    baselineRepoPath: pre.baselineRepoPath,
    baselineSha: pre.baselineSha,
    overlayRoot: pre.workspacePath,
    uploadPlan,
  }
}

// --------------------------------------------------------------- effect 台账

type EffectClaim =
  | { readonly disposition: 'execute'; readonly effectId: string }
  | { readonly disposition: 'already-confirmed'; readonly receiptRef: string | null }
  | { readonly disposition: 'refused'; readonly code: string }

/**
 * prepare（撞 idempotencyKey 取回既有行）→ 按行状态分派：confirmed 直接推进
 * （crash 于 confirm 之后、cells 之前的修复轮）；failed/invalidated 是人工介入
 * 面不自动复活；prepared/dispatched 校验 intent digest（载荷不落表，重建后
 * 对拍——漂移即 fail）后（重）执行。
 */
export function claimDeliveryEffect(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  input: {
    readonly actionRunId: string | null
    readonly effectKind: string
    readonly idempotencyKey: string
    readonly intent: unknown
  },
): EffectClaim {
  const now = deps.now()
  const intentDigest = canonicalDigest(input.intent)
  const prepared = deps.store.prepareEffect({
    id: ulid(),
    missionId: mission.id,
    actionRunId: input.actionRunId,
    effectKind: input.effectKind,
    intentDigest,
    idempotencyKey: input.idempotencyKey,
    epoch: mission.epoch,
    now,
  })
  const effect: EffectRow = prepared.effect
  if (effect.state === 'confirmed') {
    return { disposition: 'already-confirmed', receiptRef: effect.receiptRef }
  }
  if (effect.state === 'failed' || effect.state === 'invalidated') {
    return { disposition: 'refused', code: `delivery-effect-${effect.state}:${input.effectKind}` }
  }
  if (effect.intentDigest !== intentDigest) {
    deps.store.failEffect(
      effect.id,
      JSON.stringify({ code: 'intent-drift', expected: effect.intentDigest, got: intentDigest }),
      now,
    )
    return { disposition: 'refused', code: `delivery-intent-drift:${input.effectKind}` }
  }
  if (effect.state === 'prepared') deps.store.markEffectDispatched(effect.id, now)
  return { disposition: 'execute', effectId: effect.id }
}

function occPatch(
  deps: DeliveryChainDeps,
  missionId: string,
  patch: Parameters<MissionStore['occUpdate']>[3],
): void {
  const fresh = deps.store.getMission(missionId)
  if (fresh === null) return
  deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, patch)
}

function tryStatus(
  deps: DeliveryChainDeps,
  missionId: string,
  to: 'publishing' | 'watching',
): void {
  const fresh = deps.store.getMission(missionId)
  if (fresh === null || fresh.status === to) return
  const verdict = checkMissionTransition({
    from: fresh.status,
    to,
    fence: fresh.transitionFence,
  })
  if (!verdict.ok) return
  deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { status: to })
}

// ----------------------------------------------------------------- arm 1/3：
// run-verification —— stage 重放 candidate 树（treeOid 对拍）后跑受管 profile。

export async function handleRunVerification(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  cells: Cells,
  profileRef: string,
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (
    ports.candidateDelivery === undefined ||
    ports.verificationProfiles === undefined ||
    ports.verificationExecution === undefined
  ) {
    deps.block(mission.id, 'delivery-port-missing:verification', null)
    return 'blocked'
  }
  const ctx = loadCandidateContext(deps, mission, cells)
  if ('failCode' in ctx) {
    deps.block(mission.id, ctx.failCode, null)
    return 'blocked'
  }
  const at = profileRef.lastIndexOf('@')
  const profileId = at > 0 ? profileRef.slice(0, at) : profileRef
  const revision = at > 0 ? Number.parseInt(profileRef.slice(at + 1), 10) : Number.NaN
  if (!Number.isInteger(revision) || revision < 1) {
    deps.block(mission.id, `verification-profile-ref-invalid:${profileRef}`, null)
    return 'blocked'
  }
  const content = ports.verificationProfiles.content(profileId, revision)
  const parsed = verificationProfileContentSchema.safeParse(content)
  if (content === null || !parsed.success) {
    deps.block(
      mission.id,
      content === null
        ? `verification-profile-missing:${profileRef}`
        : `verification-profile-invalid:${profileRef}`,
      null,
    )
    return 'blocked'
  }

  const staged = await ports.candidateDelivery.stage({
    baselineRepoPath: ctx.baselineRepoPath,
    baselineSha: ctx.baselineSha,
    overlayRoot: ctx.overlayRoot,
    uploadPlan: ctx.uploadPlan,
  })
  if (!staged.ok) {
    deps.block(mission.id, staged.code, staged.detail)
    return 'blocked'
  }
  let receipt: Awaited<ReturnType<NonNullable<ReconcilerPorts['verificationExecution']>['run']>>
  try {
    if (staged.treeOid !== ctx.treeOid) {
      deps.block(
        mission.id,
        'candidate-tree-drift',
        `staged ${staged.treeOid} != recorded ${ctx.treeOid}`,
      )
      return 'blocked'
    }
    receipt = await ports.verificationExecution.run({
      workspacePath: staged.ws,
      profile: parsed.data,
    })
  } finally {
    staged.cleanup()
  }

  const verified = verifiedProfilesOf(cells, ctx.treeOid)
  verified[profileRef] = receipt.ok ? 'passed' : 'failed'
  deps.persistCells(
    mission.id,
    {
      '__delivery.verifiedTreeOid': knownCell(ctx.treeOid, receipt.receiptDigest),
      '__delivery.verifiedProfiles': knownCell(JSON.stringify(verified), receipt.receiptDigest),
      '__delivery.verificationReceiptRef': knownCell(receipt.receiptDigest, receipt.receiptDigest),
    },
    { kind: 'delivery-verification', profileRef, treeOid: ctx.treeOid },
  )
  if (!receipt.ok) {
    const failedSteps = receipt.steps
      .filter((s) => !s.ok)
      .map((s) => `${s.stepId}(exit=${s.exitCode ?? 'none'}${s.timedOut ? ',timeout' : ''})`)
      .join(', ')
    deps.block(mission.id, `verification-failed:${profileRef}`, failedSteps)
    return 'blocked'
  }
  return 'collected'
}

// ----------------------------------------------------------------- arm 2/3：
// commit-and-publish-candidate —— 单轮一 effect：先 commit（durable 内部 ref，
// (tree,parent) 幂等），下一轮 push（exact-head CAS，普通 push 无 force 形态）。

export async function handleCommitAndPublish(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  cells: Cells,
  policy: AutomationPolicyContent,
  publicationMode: 'new-branch' | 'fast-forward',
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.candidateDelivery === undefined) {
    deps.block(mission.id, 'delivery-port-missing:candidateDelivery', null)
    return 'blocked'
  }
  const ctx = loadCandidateContext(deps, mission, cells)
  if ('failCode' in ctx) {
    deps.block(mission.id, ctx.failCode, null)
    return 'blocked'
  }
  const summarySource =
    ports.requirementMaterialize?.getRequirementManifest(mission.id)?.title ?? mission.id

  const committedSha = knownString(cells, '__delivery.commitSha')
  const committedTree = knownString(cells, '__delivery.publishedTreeOid')

  // ---- 阶段 A：commit（cells 尚无当前树的 commitSha）。
  if (committedTree !== ctx.treeOid || committedSha === null) {
    const claim = claimDeliveryEffect(deps, mission, {
      actionRunId: ctx.runId,
      effectKind: 'candidate-commit',
      idempotencyKey: `commit:${mission.id}:${ctx.treeOid}`,
      intent: {
        kind: 'candidate-commit',
        missionId: mission.id,
        treeOid: ctx.treeOid,
        baselineSha: ctx.baselineSha,
        summarySource,
      },
    })
    if (claim.disposition === 'refused') {
      deps.block(mission.id, claim.code, null)
      return 'blocked'
    }
    let commitSha: string
    if (claim.disposition === 'already-confirmed') {
      if (claim.receiptRef === null) {
        deps.block(mission.id, 'delivery-effect-receipt-missing:candidate-commit', null)
        return 'blocked'
      }
      commitSha = claim.receiptRef
    } else {
      const out = await ports.candidateDelivery.commit({
        baselineRepoPath: ctx.baselineRepoPath,
        baselineSha: ctx.baselineSha,
        overlayRoot: ctx.overlayRoot,
        expectedTreeOid: ctx.treeOid,
        missionId: mission.id,
        summarySource,
        uploadPlan: ctx.uploadPlan,
      })
      const now = deps.now()
      if (!out.ok) {
        deps.store.failEffect(
          claim.effectId,
          JSON.stringify({ code: out.code, detail: out.detail }),
          now,
        )
        deps.block(mission.id, out.code, out.detail)
        return 'blocked'
      }
      deps.store.confirmEffect(claim.effectId, out.commitSha, now)
      commitSha = out.commitSha
    }
    deps.persistCells(
      mission.id,
      {
        '__delivery.commitSha': knownCell(commitSha, commitSha),
        '__delivery.publishedTreeOid': knownCell(ctx.treeOid, commitSha),
        '__delivery.publishState': knownCell('committed', commitSha),
      },
      { kind: 'delivery-commit', treeOid: ctx.treeOid, commitSha },
    )
    tryStatus(deps, mission.id, 'publishing')
    return 'collected' // push 下一轮（单轮一 effect）
  }

  // ---- 阶段 B：push（committed → pushed）。
  if (ports.repoRemote === undefined) {
    deps.block(mission.id, 'delivery-port-missing:repoRemote', null)
    return 'blocked'
  }
  const remote = ports.repoRemote.resolve(mission.repositoryId)
  if (remote === null) {
    deps.block(mission.id, 'repo-remote-unresolved', mission.repositoryId)
    return 'blocked'
  }
  const branch =
    mission.deliverySourceBranch ?? `${policy.delivery.sourceBranchPrefix}/${mission.id}`
  const priorPushedSha = knownString(cells, '__delivery.pushedSha')
  if (publicationMode === 'fast-forward' && priorPushedSha === null) {
    deps.block(mission.id, 'publish-state-inconsistent', 'fast-forward without prior push sha')
    return 'blocked'
  }
  const expectedRemoteSha = publicationMode === 'fast-forward' ? priorPushedSha : null
  const claim = claimDeliveryEffect(deps, mission, {
    actionRunId: ctx.runId,
    effectKind: 'candidate-push',
    idempotencyKey: `push:${mission.id}:${ctx.treeOid}`,
    intent: {
      kind: 'candidate-push',
      missionId: mission.id,
      commitSha: committedSha,
      branch,
      expectedRemoteSha,
      treeOid: ctx.treeOid,
    },
  })
  if (claim.disposition === 'refused') {
    deps.block(mission.id, claim.code, null)
    return 'blocked'
  }
  let pushedSha: string
  if (claim.disposition === 'already-confirmed') {
    if (claim.receiptRef === null) {
      deps.block(mission.id, 'delivery-effect-receipt-missing:candidate-push', null)
      return 'blocked'
    }
    pushedSha = claim.receiptRef
  } else {
    const out = await ports.candidateDelivery.push({
      baselineRepoPath: ctx.baselineRepoPath,
      commitSha: committedSha,
      remoteUrl: remote.remoteUrl,
      branch,
      expectedRemoteSha,
      expectedTreeOid: ctx.treeOid,
      baselineSha: ctx.baselineSha,
    })
    const now = deps.now()
    if (!out.ok) {
      deps.store.failEffect(
        claim.effectId,
        JSON.stringify({ code: out.code, detail: out.detail }),
        now,
      )
      deps.block(mission.id, out.code, out.detail)
      return 'blocked'
    }
    deps.store.confirmEffect(claim.effectId, out.receipt.newSha, now)
    pushedSha = out.receipt.newSha
  }
  occPatch(deps, mission.id, { deliverySourceBranch: branch })
  deps.persistCells(
    mission.id,
    {
      '__delivery.publishState': knownCell('pushed', pushedSha),
      '__delivery.pushedSha': knownCell(pushedSha, pushedSha),
      '__delivery.sourceBranch': knownCell(branch, pushedSha),
    },
    { kind: 'delivery-push', treeOid: ctx.treeOid, pushedSha, branch },
  )

  // upload plan 的 publication receipt：orchestrator 结算时把 candidate lineage
  // 的 finalDigests 冻结在 cells（`__delivery.uploadLineage`），push 即 published。
  if (mission.uploadPlanRef !== null && ports.uploadPublication !== undefined) {
    const lineageRaw = knownString(cells, '__delivery.uploadLineage')
    if (lineageRaw !== null) {
      try {
        const lineage = JSON.parse(lineageRaw) as {
          readonly finalDigests?: readonly {
            readonly targetPath: string
            readonly sha256: string
          }[]
        }
        if (Array.isArray(lineage.finalDigests)) {
          const receipt = ports.uploadPublication.record({
            planId: mission.uploadPlanRef,
            baselineSnapshotRef: ctx.baselineSha,
            seedChangeRef: null,
            seedTreeDigest: mission.uploadPlacementRef,
            commitSha: pushedSha,
            entries: lineage.finalDigests,
            now: deps.now(),
          })
          occPatch(deps, mission.id, { uploadPublicationRef: receipt.receiptId })
        }
      } catch {
        // lineage cells 损坏不阻断 push 成功事实；receipt 缺席由 uploadSeed
        // guard 如实呈现（'seeded' 不谎报 'published'）。
      }
    }
  }
  return 'collected'
}

// ----------------------------------------------------------------- arm 3/3：
// ensure-merge-request —— 先查后建（幂等）+ claimMr 跨 mission 防重。

export async function handleEnsureMergeRequest(
  deps: DeliveryChainDeps,
  mission: MissionRow,
): Promise<'collected' | 'blocked'> {
  const ports = deps.ports
  if (ports.mrEffects === undefined || ports.repoRemote === undefined) {
    deps.block(mission.id, 'delivery-port-missing:mrEffects', null)
    return 'blocked'
  }
  const branch = mission.deliverySourceBranch
  if (branch === null) {
    deps.block(mission.id, 'publish-state-inconsistent', 'ensure-mr without source branch')
    return 'blocked'
  }
  const remote = ports.repoRemote.resolve(mission.repositoryId)
  if (remote === null) {
    deps.block(mission.id, 'repo-remote-unresolved', mission.repositoryId)
    return 'blocked'
  }
  const targetBranch = mission.deliveryTargetRef ?? remote.defaultBranch ?? 'main'
  const title =
    ports.requirementMaterialize?.getRequirementManifest(mission.id)?.title ??
    `AW mission ${mission.id}`

  const claim = claimDeliveryEffect(deps, mission, {
    actionRunId: null,
    effectKind: 'mr-ensure',
    idempotencyKey: `mr:${mission.id}:${branch}`,
    intent: { kind: 'mr-ensure', missionId: mission.id, branch, targetBranch },
  })
  if (claim.disposition === 'refused') {
    deps.block(mission.id, claim.code, null)
    return 'blocked'
  }
  let mr: {
    readonly mrRef: string
    readonly webUrl: string | null
    readonly state: 'opened' | 'merged' | 'closed'
    readonly sourceSha: string | null
    readonly providerCorrelationRef: string
  }
  if (claim.disposition === 'already-confirmed') {
    // confirm 之后 crash 于 claim/cells 之前：ensure 幂等（先查后建），重放取回。
    const out = await ports.mrEffects.ensure(mission.repositoryId, {
      missionId: mission.id,
      sourceBranch: branch,
      targetBranch,
      title,
    })
    if (!out.ok) {
      deps.block(mission.id, out.code, out.detail)
      return 'blocked'
    }
    mr = out.mr
  } else {
    const out = await ports.mrEffects.ensure(mission.repositoryId, {
      missionId: mission.id,
      sourceBranch: branch,
      targetBranch,
      title,
    })
    const now = deps.now()
    if (!out.ok) {
      deps.store.failEffect(
        claim.effectId,
        JSON.stringify({ code: out.code, detail: out.detail }),
        now,
      )
      deps.block(mission.id, out.code, out.detail)
      return 'blocked'
    }
    deps.store.confirmEffect(claim.effectId, out.mr.providerCorrelationRef, now)
    mr = out.mr
  }

  // providerCorrelationRef 形如 `provider:project!mrRef`（integration correlationRef）。
  const corr = mr.providerCorrelationRef
  const bang = corr.lastIndexOf('!')
  const head = bang > 0 ? corr.slice(0, bang) : corr
  const colon = head.indexOf(':')
  const claimKey = {
    codeHostEndpointRef: colon > 0 ? head.slice(0, colon) : head,
    stableProjectRef: colon > 0 ? head.slice(colon + 1) : head,
    mrIid: mr.mrRef,
  }
  const claimId = ulid()
  const claimed = deps.store.claimMr({
    id: claimId,
    ...claimKey,
    missionId: mission.id,
    epoch: mission.epoch,
    headSha: mr.sourceSha,
    now: deps.now(),
  })
  let mrClaimId = claimId
  if (!claimed.ok) {
    // 撞唯一 ≠ 一定是别人：confirm→claim 之间 crash 的重放会撞回自己的行。
    const existing = deps.store.findMrClaim(claimKey)
    if (existing === null || existing.missionId !== mission.id) {
      deps.block(mission.id, claimed.code, corr)
      return 'blocked'
    }
    mrClaimId = existing.id
  }
  occPatch(deps, mission.id, { mrClaimId })
  deps.persistCells(
    mission.id,
    {
      '__mr.ref': knownCell(mr.mrRef, corr),
      '__mr.webUrl': knownCell(mr.webUrl ?? '', corr),
      '__mr.state': knownCell(mr.state, corr),
      '__mr.headSha': knownCell(mr.sourceSha ?? '', corr),
    },
    { kind: 'delivery-mr-ensure', mrRef: mr.mrRef, correlationRef: corr },
  )
  tryStatus(deps, mission.id, 'watching')
  return 'collected'
}
