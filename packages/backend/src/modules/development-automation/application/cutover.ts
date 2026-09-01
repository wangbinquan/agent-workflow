// RFC-310 PR-9 T98–T103 —— cutover 编排（design §13.3）。
//
// 状态机判定在 domain/cutover.ts；这里是命令执行（读→判→写）与 adoptActiveMr
// 编排。存储经 CutoverStore port——maintenance_state 按 RFC-311 约定只存
// 「维护性水位与一次性闸门」，cutover phase 正属后者（与
// ensureCredentialsSealed 的 sealed 闸门同类）：删表后果只是 admission gate
// 退回 pre（最保守放行面），mission 行零丢失。

import { decideCutoverTransition, type CutoverCommand, type CutoverState } from '../domain/cutover'
import { terminalStatusForMr } from '../domain/mission'
import type { CutoverStore } from './ports/cutoverStore'
import type { MissionPersistence } from './ports/missionStore'
import type { ReconcilerPorts } from './ports/reconcilerPorts'

export interface CutoverDeps {
  readonly cutoverStore: CutoverStore
  readonly now: () => number
  readonly mintId: () => string
}

export type CutoverCommandResult =
  | { readonly ok: true; readonly state: CutoverState }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/** T99 freeze / T101 flip / T102 rollback——读→domain 判→写，typed 拒原样上抛。 */
export async function runCutoverCommand(
  deps: CutoverDeps,
  command: CutoverCommand,
): Promise<CutoverCommandResult> {
  const state = await deps.cutoverStore.readState()
  const now = deps.now()
  const verdict = decideCutoverTransition(state, command, {
    now,
    mintGeneration: deps.mintId,
  })
  if (!verdict.ok) return verdict
  await deps.cutoverStore.writeState(verdict.next, now)
  return { ok: true, state: verdict.next }
}

// ------------------------------------------------------------- T100 adopt

export interface AdoptActiveMrInput {
  readonly repositoryId: string
  readonly mrIid: string
  readonly codeHostEndpointRef: string
  readonly stableProjectRef: string
  readonly employee: { readonly id: string; readonly revision: number } | null
  readonly policy: { readonly id: string; readonly revision: number } | null
  readonly legacyWorkItemId: string | null
  readonly legacyRoundId: string | null
  readonly actorUserId: string | null
}

export type AdoptActiveMrResult =
  | {
      readonly ok: true
      readonly missionId: string
      readonly terminal: 'merged' | 'closed-unmerged' | null
    }
  | { readonly ok: false; readonly code: string; readonly detail: string }

/**
 * 从外部真相建立 Mission（cutover runbook 步骤 4/5）：observe 当前 MR →
 * createMission(adopt) → claimMr（active MR 单占；被别的 mission 占用即拒）→
 * legacy link（cutoverReceiptJson=观察到的外部状态）。旧未发布 workspace 一概
 * 不接管——baseline 就是外部已发布的 head。已 merged/closed 的 MR 同一调用内
 * 记 authoritative terminal（不建 active claim、不启动任何 action）。
 */
export async function adoptActiveMr(
  deps: {
    readonly store: MissionPersistence
    readonly cutoverStore: CutoverStore
    readonly ports: Pick<ReconcilerPorts, 'mrEffects'>
    readonly now: () => number
    readonly mintId: () => string
  },
  input: AdoptActiveMrInput,
): Promise<AdoptActiveMrResult> {
  if (deps.ports.mrEffects === undefined) {
    return { ok: false, code: 'mr-observe-unavailable', detail: 'mrEffects port not wired' }
  }
  const observed = await deps.ports.mrEffects.observe(input.repositoryId, input.mrIid)
  if (!observed.ok) return { ok: false, code: observed.code, detail: observed.detail }
  const observation = observed.observation
  const now = deps.now()
  const missionId = deps.mintId()
  const terminal =
    observation.state === 'merged'
      ? ('merged' as const)
      : observation.state === 'closed'
        ? ('closed-unmerged' as const)
        : null

  const created = await deps.store.createMission({
    id: missionId,
    revision: 0,
    epoch: 0,
    status:
      terminal === null
        ? 'watching'
        : terminalStatusForMr(terminal === 'merged' ? 'merged' : 'closed'),
    automationMode: 'active',
    transitionFence: 'none',
    repositoryId: input.repositoryId,
    sourceKind: 'direct',
    sourceContentDigest: null,
    requestedSourceKey: null,
    externalId: null,
    resolvedSourceKey: null,
    resolvedAdapterId: null,
    resolvedAdapterRevision: null,
    deliveryKind: 'adopt-merge-request',
    deliveryTargetRef: observation.targetBranch,
    deliverySourceBranch: null,
    adoptedMrRef: input.mrIid,
    assignmentId: null,
    employeeId: input.employee?.id ?? null,
    employeeRevision: input.employee?.revision ?? null,
    policyId: input.policy?.id ?? null,
    policyRevision: input.policy?.revision ?? null,
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
    terminalKind: terminal,
    terminalUploadFulfillment: null,
    terminalAt: terminal === null ? null : now,
    launchIdempotencyKey: `cutover:${input.codeHostEndpointRef}:${input.stableProjectRef}:${input.mrIid}`,
    createdBy: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  })
  if (!created.created) {
    // 幂等：同 MR 重复 adopt 返回既有 mission（cutover runbook 可重跑）。
    return { ok: true, missionId: created.mission.id, terminal }
  }

  if (terminal === null) {
    const claimId = deps.mintId()
    const claimed = await deps.store.claimMr({
      id: claimId,
      codeHostEndpointRef: input.codeHostEndpointRef,
      stableProjectRef: input.stableProjectRef,
      mrIid: input.mrIid,
      missionId,
      epoch: 0,
      headSha: observation.sourceSha,
      now,
    })
    let mrClaimId = claimId
    if (!claimed.ok) {
      const existing = await deps.store.findMrClaim({
        codeHostEndpointRef: input.codeHostEndpointRef,
        stableProjectRef: input.stableProjectRef,
        mrIid: input.mrIid,
      })
      if (existing === null || existing.missionId !== missionId) {
        return { ok: false, code: 'mr-owned-by-another-mission', detail: input.mrIid }
      }
      mrClaimId = existing.id
    }
    const fresh = await deps.store.getMission(missionId)
    if (fresh !== null) {
      await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, { mrClaimId })
    }
  }

  await deps.cutoverStore.insertLegacyLink({
    id: deps.mintId(),
    missionId,
    legacyWorkItemId: input.legacyWorkItemId,
    legacyRoundId: input.legacyRoundId,
    cutoverReceiptJson: JSON.stringify({
      observedState: observation.state,
      headSha: observation.sourceSha,
      targetBranch: observation.targetBranch,
      adoptedAt: now,
    }),
    now,
  })
  return { ok: true, missionId, terminal }
}
