// RFC-310 PR-7b T78 —— conflict repair 的收口与发布（design §8.5 步骤 5-6）。
//
// repair Agent 只在一个**没有 Git**的冲突现场里解 marker；merge commit 由
// source-control 用它自己的 index 产出，push 是对着 `S`（launch 时冻结的 MR
// source head）的 exact-head CAS。这两步都在 orchestrator 收口的同一轮里做，
// 因为它们要么一起成立、要么整个现场作废——不存在「合了但没推」的中间态可
// 以留给下一轮决策。
//
// 与普通发布链的差别只有一处：这里的 commit 有两个 parent，不是 baseline 上
// 的 overlay，所以走不了 stage/commit 那条路。push 仍复用同一个 exact-head
// CAS 面与同一套 effects 台账（`conflict-push` 已在 DELIVERY_EFFECT_KINDS
// 里，悬挂行按 idempotencyKey 撞回重放）。平台在此绝不 force、绝不改方向。

import {
  claimDeliveryEffect,
  missionPublicationSubject,
  type DeliveryChainDeps,
} from './missionDeliveryChain'
import type { MissionRow } from './ports/missionStore'

export interface ConflictRepairPublishInput {
  readonly actionRunId: string
  readonly workspacePath: string
  readonly sourceSha: string
  readonly targetSha: string
  readonly conflictPaths: readonly string[]
}

export type ConflictRepairPublishResult =
  | {
      readonly ok: true
      readonly mergeCommitSha: string
      readonly treeOid: string
      readonly pushedSha: string
      readonly branch: string
    }
  | {
      readonly ok: false
      /** boundary = Agent 越界（禁区写入，整树废弃）；protocol = 现场与声称不符。 */
      readonly kind: 'boundary' | 'protocol'
      readonly code: string
      readonly detail: string
    }

export async function publishConflictRepair(
  deps: DeliveryChainDeps,
  mission: MissionRow,
  input: ConflictRepairPublishInput,
): Promise<ConflictRepairPublishResult> {
  const ports = deps.ports
  if (ports.conflictMerge === undefined) {
    return { ok: false, kind: 'protocol', code: 'conflict-merge-not-wired', detail: 'no port' }
  }
  if (ports.candidateDelivery === undefined || ports.repoRemote === undefined) {
    return {
      ok: false,
      kind: 'protocol',
      code: 'conflict-delivery-not-wired',
      detail: 'candidateDelivery/repoRemote not wired',
    }
  }
  // 推回的是 MR 的 source 分支——它就是本次 merge 的 `S` 所在的 ref。Mission
  // 没记住这条 ref 时诚实停住：靠 policy 的命名模板猜一条分支去推，等于对着
  // 一个平台没确认过的 ref 做写操作。
  const branch = mission.deliverySourceBranch
  if (branch === null) {
    return {
      ok: false,
      kind: 'protocol',
      code: 'conflict-source-branch-unknown',
      detail: 'mission has no recorded delivery source branch to publish the merge onto',
    }
  }

  const finished = await ports.conflictMerge.finish({
    workspacePath: input.workspacePath,
    sourceSha: input.sourceSha,
    targetSha: input.targetSha,
    conflictPaths: input.conflictPaths,
    missionId: mission.id,
  })
  if (!finished.ok) {
    return {
      ok: false,
      // 冲突集之外的改动是越界（Agent 被明确告知只能动冲突集），未解决的
      // marker 只是「没干完」——分级不同，处置也不同（前者整树废弃）。
      kind: finished.code === 'conflict-extra-changes' ? 'boundary' : 'protocol',
      code: finished.code,
      detail: finished.detail,
    }
  }

  const remote = ports.repoRemote.resolve(mission.repositoryId)
  if (remote === null) {
    return {
      ok: false,
      kind: 'protocol',
      code: 'repo-remote-unresolved',
      detail: mission.repositoryId,
    }
  }

  const claim = claimDeliveryEffect(deps, mission, {
    actionRunId: input.actionRunId,
    effectKind: 'conflict-push',
    idempotencyKey: `conflict-push:${mission.id}:${input.sourceSha}:${finished.treeOid}`,
    intent: {
      kind: 'conflict-push',
      missionId: mission.id,
      commitSha: finished.mergeCommitSha,
      branch,
      expectedRemoteSha: input.sourceSha,
      treeOid: finished.treeOid,
    },
  })
  if (claim.disposition === 'refused') {
    return { ok: false, kind: 'protocol', code: claim.code, detail: 'effect refused' }
  }
  if (claim.disposition === 'already-confirmed') {
    if (claim.receiptRef === null) {
      return {
        ok: false,
        kind: 'protocol',
        code: 'delivery-effect-receipt-missing:conflict-push',
        detail: 'confirmed effect carries no receipt',
      }
    }
    return {
      ok: true,
      mergeCommitSha: finished.mergeCommitSha,
      treeOid: finished.treeOid,
      pushedSha: claim.receiptRef,
      branch,
    }
  }

  const pushed = await ports.candidateDelivery.push({
    // 现场本身就是一个含该 merge commit 的 clone——push 从它发起，不需要把
    // commit 先搬回 baseline 缓存。
    baselineRepoPath: input.workspacePath,
    commitSha: finished.mergeCommitSha,
    remoteUrl: remote.remoteUrl,
    branch,
    // design §8.5 步骤 5：CAS against S。S 变了就是「现场已过期」，
    // 步骤 6 要求废弃重采，绝不覆盖。
    expectedRemoteSha: input.sourceSha,
    expectedTreeOid: finished.treeOid,
    baselineSha: input.sourceSha,
    publicationSubject: missionPublicationSubject(mission),
  })
  const now = deps.now()
  if (!pushed.ok) {
    deps.store.failEffect(
      claim.effectId,
      JSON.stringify({ code: pushed.code, detail: pushed.detail }),
      now,
    )
    return {
      ok: false,
      kind: 'protocol',
      code: pushed.code === 'remote-head-changed' ? 'conflict-head-changed' : pushed.code,
      detail: pushed.detail,
    }
  }
  deps.store.confirmEffect(claim.effectId, pushed.receipt.newSha, now)
  return {
    ok: true,
    mergeCommitSha: finished.mergeCommitSha,
    treeOid: finished.treeOid,
    pushedSha: pushed.receipt.newSha,
    branch,
  }
}
