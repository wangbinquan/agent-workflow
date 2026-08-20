// RFC-310 T81 —— 外部把已关闭的 MR 重新打开（design §10.4）。
//
// 不变量：**终态不逆转**。`closed-unmerged` 那条 Mission 是外部事实的忠实记录，
// 把它翻回 working 等于事后篡改台账——已经结算的 upload fulfillment、已经释放的
// claim、已经写下的 terminalAt 全部会变成谎话。所以 reopen 的处置是**另建一条
// 带链接的新 Mission generation** 去接管当前 MR/head，原来那条原样封存。
//
// 三个刻意的选择，都不是「随手这么写」：
//
// 1. **触发只认外部信号**。终态 Mission 每轮 sweep 都会被扫到，但只有真的收到
//    wake hint（webhook 投递）时才去采集一次 MR facts——否则每条历史 Mission 都会
//    在每个 sweep 周期里对 code host 发一次请求，成本随历史线性增长而收益为零。
//
// 2. **继承原 Mission 钉住的 employee/policy，不重新解析**。同一条 MR 的后续
//    generation 应当由同一套配置继续；重新跑 assignment 选择器意味着一次无关的
//    指派变更可以中途接管一条**正在进行的外部 MR**，那是运维事故而不是特性。
//
// 3. **需求证据按来源分档**：`direct` 的正文只存在于平台自己的 evidence 里，新
//    Mission 必须继承（复制指针行，blob 内容寻址共享），否则它永远物化不出需求；
//    `external-reference` 则**重新采集**——工单在 MR 关闭期间很可能已经变了，
//    照搬旧快照等于让新一轮基于过期需求干活。
//
// 幂等：`launchIdempotencyKey = reopen:{closedMissionId}`。同一条终态 Mission 无论
// 收到多少次 reopen 投递，都只派生一条后继；后继若再次关闭，它自己的 id 又是新的
// 幂等键，链条可以继续。

import { ulid } from 'ulid'

import type { FactCellValue } from '../../domain/facts'
import type { FactCell } from '../../domain/factCell'
import type { MissionRow, MissionStore } from '../ports/missionStore'
import type { ReconcilerPorts } from '../ports/reconcilerPorts'

export interface ReopenDeps {
  readonly store: MissionStore
  readonly ports: ReconcilerPorts
  readonly now: () => number
}

export type ReopenOutcome =
  /** MR 仍是关闭/合入态，或本 Mission 不是 closed-unmerged ⇒ 什么都不做。 */
  | { readonly kind: 'not-reopened' }
  /** 已经派生过后继（幂等命中）。 */
  | { readonly kind: 'already-linked'; readonly missionId: string }
  | { readonly kind: 'created'; readonly missionId: string }
  | { readonly kind: 'blocked'; readonly code: string; readonly detail: string | null }

function knownString(
  cells: Readonly<Record<string, FactCell<FactCellValue>>>,
  id: string,
): string | null {
  const cell = cells[id]
  return cell !== undefined && cell.state === 'known' && typeof cell.value === 'string'
    ? cell.value
    : null
}

export function reopenIdempotencyKey(closedMissionId: string): string {
  return `reopen:${closedMissionId}`
}

export async function reopenClosedMission(
  deps: ReopenDeps,
  mission: MissionRow,
): Promise<ReopenOutcome> {
  if (mission.terminalKind !== 'closed-unmerged') return { kind: 'not-reopened' }
  if (mission.mrClaimId === null) return { kind: 'not-reopened' }

  const key = reopenIdempotencyKey(mission.id)
  const existing = deps.store.findByIdempotencyKey(key)
  if (existing !== null) return { kind: 'already-linked', missionId: existing.id }

  const collector = deps.ports.mergeRequestFacts
  if (collector === undefined) {
    return { kind: 'blocked', code: 'collector-not-wired:mr', detail: null }
  }
  const collected = await collector.collect({
    missionId: mission.id,
    mrClaimId: mission.mrClaimId,
  })
  // 外部真相说了算：只有它现在真的 active 才是 reopen。webhook 载荷说什么不作数
  // （与 T82 同一条纪律：投递只唤醒，状态一律自采）。
  if (knownString(collected.cells, 'mr.terminalState') !== 'active') {
    return { kind: 'not-reopened' }
  }

  // MR 身份取自旧 claim 行（终态只把它标 released，行保留），而不是任何 cells
  // 投影——重新 claim 需要的是 exact 三元组，猜不得。
  const priorClaim = deps.store.getMrClaim(mission.mrClaimId)
  if (priorClaim === null) {
    return {
      kind: 'blocked',
      code: 'reopen-mr-claim-missing',
      detail: mission.mrClaimId,
    }
  }
  const mrRef = mission.adoptedMrRef ?? priorClaim.mrIid
  if (mission.employeeId === null || mission.policyId === null) {
    return {
      kind: 'blocked',
      code: 'reopen-pinned-config-missing',
      detail: 'the closed mission has no pinned employee/policy to inherit',
    }
  }

  const now = deps.now()
  const successorId = ulid()
  const created = deps.store.createMission({
    id: successorId,
    revision: 0,
    epoch: 0,
    status: 'watching',
    automationMode: mission.automationMode,
    transitionFence: 'none',
    repositoryId: mission.repositoryId,
    sourceKind: mission.sourceKind,
    sourceContentDigest: mission.sourceContentDigest,
    requestedSourceKey: mission.requestedSourceKey,
    externalId: mission.externalId,
    resolvedSourceKey: mission.resolvedSourceKey,
    resolvedAdapterId: mission.resolvedAdapterId,
    resolvedAdapterRevision: mission.resolvedAdapterRevision,
    // 后继一律 adopt：那条 MR 已经存在，绝不再建第二条。
    deliveryKind: 'adopt-merge-request',
    deliveryTargetRef: mission.deliveryTargetRef,
    deliverySourceBranch: mission.deliverySourceBranch,
    adoptedMrRef: mrRef,
    assignmentId: mission.assignmentId,
    employeeId: mission.employeeId,
    employeeRevision: mission.employeeRevision,
    policyId: mission.policyId,
    policyRevision: mission.policyRevision,
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
    reopenedFromMissionId: mission.id,
    launchIdempotencyKey: key,
    createdBy: mission.createdBy,
    createdAt: now,
    updatedAt: now,
  })
  // 并发两条投递同时到达时 unique 撞回既有行——照样只有一条后继。
  if (!created.created) return { kind: 'already-linked', missionId: created.mission.id }

  const sources = deps.store.listMissionSources(mission.id)
  const generation = sources.reduce((max, row) => Math.max(max, row.generation), 0) + 1
  const latestMaterialized = sources
    .filter((row) => row.state === 'materialized' && row.bundleRef !== null)
    .sort((a, b) => b.generation - a.generation)[0]
  const inheritDirect = mission.sourceKind === 'direct' && latestMaterialized !== undefined
  if (inheritDirect) {
    deps.ports.requirementMaterialize?.carryOverRequirementEvidence({
      fromMissionId: mission.id,
      toMissionId: successorId,
    })
  }
  deps.store.insertMissionSource({
    id: ulid(),
    missionId: successorId,
    generation,
    sourceKind: mission.sourceKind,
    externalId: mission.externalId,
    adapterId: mission.resolvedAdapterId,
    adapterRevision: mission.resolvedAdapterRevision,
    sourceRevision: inheritDirect ? latestMaterialized!.sourceRevision : null,
    bundleRef: inheritDirect ? latestMaterialized!.bundleRef : null,
    manifestDigest: inheritDirect
      ? latestMaterialized!.manifestDigest
      : mission.sourceContentDigest,
    fileCount: inheritDirect ? latestMaterialized!.fileCount : null,
    totalBytes: inheritDirect ? latestMaterialized!.totalBytes : null,
    // direct 继承既有 bundle ⇒ 直接 materialized；external 留 active，由既有链
    // 重新向 adapter 采集（工单可能已经变了，照搬旧快照是错的）。
    state: inheritDirect ? 'materialized' : 'active',
    createdAt: now,
  })

  // 重新 claim 当前 MR：旧 claim 在终态时已 released，而唯一索引是 `state='active'`
  // 的部分索引，所以这里不会撞车。claim 不上（被第三条 Mission 抢了）不算失败——
  // 后继照常存在，MR care 链会以既有的 typed block 呈现。
  const claimId = ulid()
  const claim = deps.store.claimMr({
    id: claimId,
    codeHostEndpointRef: priorClaim.codeHostEndpointRef,
    stableProjectRef: priorClaim.stableProjectRef,
    mrIid: priorClaim.mrIid,
    missionId: successorId,
    epoch: 0,
    headSha: collected.headSha,
    now,
  })
  if (claim.ok) {
    const fresh = deps.store.getMission(successorId)
    if (fresh !== null) {
      deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { mrClaimId: claimId })
    }
  }

  return { kind: 'created', missionId: successorId }
}
