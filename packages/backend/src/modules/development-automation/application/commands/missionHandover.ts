// RFC-310 PR-7b T80 —— handoff / attach-MR / resume 三命令（design §4.8 尾段
// / §10.4）。
//
// handoff：bump epoch（一切在途 continuation 过期）+ fence='handoff-pending'
// + 撤销在途 Agent action + 未 dispatch 的 prepared effect invalidate；已
// dispatch/结果未知的外部 effect 不猜结果——保持 fence，由 reconciler 的
// settleFence 按外部真相结算后收口 tracking-only（settleFence 的 handoff 分支
// 已在）；无悬挂 effect 时命令内直接收口。MR claim 保留（tracking 继续）。
//
// attach：handoff 后尚无 MR（waiting-for-mr-attachment 语义）时挂接人工建的
// MR：平台主动 observe 校验其存在与当前 head，唯一 claim 防跨 mission 抢占，
// 转 adopt delivery 后继续 tracking；所挂 MR 已 merged/closed 则同一命令内
// 记录 binding + authoritative terminal（upload fulfillment 如实定格——
// unfulfilled 不是 success，只是生命周期被外部截断）。已有未结算 publish/MR
// intent 时拒绝（不能在 effect 结果未知时绑定另一个 MR）。
//
// resume：tracking-only → active：先把 MR facts 标记过期（cells
// `__mr.factsCollectedAt`='0'，下轮 care 链强制 recollect——「先刷新全部
// facts 再重新决策」的实现面），再 bump epoch + automationMode='active'。

import { ulid } from 'ulid'
import { z } from 'zod'

import { canonicalDigest, canonicalStringify } from '../../domain/canonicalJson'
import type { FactCellValue } from '../../domain/facts'
import type { FactCell } from '../../domain/factCell'
import {
  checkCommandAdmissible,
  terminalStatusForMr,
  type MissionStatus,
} from '../../domain/mission'
import { ConflictError, NotFoundError } from '@/util/errors'
import { invalidateInFlightAction } from '../actionInvalidation'
import type { MissionRow, MissionPersistence } from '../ports/missionStore'
import type { FactSnapshotReader, ReconcilerPorts } from '../ports/reconcilerPorts'

export interface MissionHandoverDeps {
  readonly store: MissionPersistence
  readonly snapshots: FactSnapshotReader
  /** attach 的 observe / handoff 的 agent cancel 走这里；缺席按 typed 409 呈现。 */
  readonly ports?: ReconcilerPorts
  readonly now: () => number
  /** attach 的 claim 键推导（装配点注入 repo→provider/project 解析；入参可覆盖）。 */
  readonly repoBinding?: (repositoryId: string) => {
    readonly codeHostEndpointRef: string
    readonly stableProjectRef: string
  } | null
}

async function loadMission(deps: MissionHandoverDeps, missionId: string): Promise<MissionRow> {
  const mission = await deps.store.getMission(missionId)
  if (mission === null) throw new NotFoundError('mission-not-found', 'mission not found')
  return mission
}

function assertAdmissible(
  mission: MissionRow,
  command: 'handoff' | 'resume-automation' | 'attach-merge-request',
): void {
  const admissible = checkCommandAdmissible({
    command,
    status: mission.status,
    automationMode: mission.automationMode,
    fence: mission.transitionFence,
    hasMergeRequest: mission.mrClaimId !== null,
  })
  if (!admissible.ok) throw new ConflictError(`mission-command-${admissible.code}`, admissible.code)
}

/** 命令层落 cells 的自足通道（confirmNoChange 同款：merge → 新快照 → ref 前移）。 */
async function persistCellsPatch(
  deps: MissionHandoverDeps,
  mission: MissionRow,
  patch: Record<string, FactCell<FactCellValue>>,
  refs: unknown,
): Promise<void> {
  const base =
    mission.requirementBundleRef === null
      ? {}
      : ((await deps.snapshots.getCells(mission.requirementBundleRef)) ?? {})
  const merged = { ...base, ...patch }
  const now = deps.now()
  const snapshotId = ulid()
  await deps.store.insertFactSnapshot({
    id: snapshotId,
    missionId: mission.id,
    missionRevision: mission.revision,
    capturedAt: new Date(now).toISOString().replace('Z', '+00:00'),
    cellsJson: canonicalStringify(merged),
    refsJson: canonicalStringify(refs),
    digest: canonicalDigest(merged),
    now,
  })
  const fresh = await deps.store.getMission(mission.id)
  if (fresh !== null) {
    await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
      requirementBundleRef: snapshotId,
    })
  }
}

// ------------------------------------------------------------------- handoff

export const handoffMissionInputSchema = z
  .object({
    missionId: z.string().min(1),
    reason: z.string().max(2000).optional(),
  })
  .strict()

export interface HandoffMissionResult {
  readonly automationMode: 'active' | 'tracking-only'
  readonly status: MissionStatus
  /** true = 有已 dispatch 的外部 effect 未结算，fence 保持、reconciler 收口。 */
  readonly pending: boolean
}

export async function handoffMission(
  deps: MissionHandoverDeps,
  rawInput: unknown,
): Promise<HandoffMissionResult> {
  const input = handoffMissionInputSchema.parse(rawInput)
  const mission = await loadMission(deps, input.missionId)
  assertAdmissible(mission, 'handoff')
  const now = deps.now()

  // fence 先落（bump epoch 使一切在途 continuation 过期）。
  const fenced = await deps.store.bumpEpoch(mission.id, mission.revision, {
    transitionFence: 'handoff-pending',
  })
  if (!fenced.ok) throw new ConflictError(`mission-occ-${fenced.code}`, fenced.code)

  // 在途 Agent action 撤销（cancel 尽力，本地台账权威）。
  const afterFence = await deps.store.getMission(mission.id)
  if (afterFence !== null && afterFence.currentActionRunId !== null) {
    await invalidateInFlightAction(
      {
        store: deps.store,
        ...(deps.ports === undefined ? {} : { ports: deps.ports }),
        now: deps.now,
      },
      afterFence,
      'input-invalidated',
    )
    const cleared = await deps.store.getMission(mission.id)
    if (cleared !== null && cleared.currentActionRunId !== null) {
      await deps.store.occUpdate(cleared.id, cleared.revision, cleared.epoch, {
        currentActionRunId: null,
      })
    }
  }

  // 未 dispatch 的 intent 作废；已 dispatch 的必须按外部真相结算（settleFence）。
  for (const effect of await deps.store.listUnsettledEffects(mission.id)) {
    if (effect.state === 'prepared') await deps.store.invalidateEffect(effect.id, now)
  }
  const remaining = (await deps.store.listUnsettledEffects(mission.id)).filter(
    (e) => e.state === 'dispatched',
  )
  if (remaining.length > 0) {
    return { automationMode: mission.automationMode, status: mission.status, pending: true }
  }

  const fresh = await deps.store.getMission(mission.id)
  if (fresh === null) throw new NotFoundError('mission-not-found', 'mission not found')
  const settled = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
    automationMode: 'tracking-only',
    transitionFence: 'none',
  })
  if (!settled.ok) throw new ConflictError(`mission-occ-${settled.code}`, settled.code)
  return { automationMode: 'tracking-only', status: fresh.status, pending: false }
}

// ------------------------------------------------------------------- attach

export const attachMergeRequestInputSchema = z
  .object({
    missionId: z.string().min(1),
    mrIid: z.string().min(1).max(64),
    /** 缺省从 repo binding 推导；显式入参可覆盖（自建实例多 provider 场景）。 */
    codeHostEndpointRef: z.enum(['gitlab', 'github']).optional(),
    stableProjectRef: z.string().min(1).max(500).optional(),
  })
  .strict()

export interface AttachMergeRequestResult {
  readonly status: MissionStatus
  readonly deliveryKind: 'adopt-merge-request'
  readonly mrClaimId: string
  /** 所挂 MR 已 merged/closed 时为对应终态（命令内 authoritative terminal）。 */
  readonly terminal: 'merged' | 'closed-unmerged' | null
}

export async function attachMergeRequest(
  deps: MissionHandoverDeps,
  rawInput: unknown,
): Promise<AttachMergeRequestResult> {
  const input = attachMergeRequestInputSchema.parse(rawInput)
  const mission = await loadMission(deps, input.missionId)
  assertAdmissible(mission, 'attach-merge-request')

  // effect 结果未知时不许绑定另一个 MR（§4.8）。
  if ((await deps.store.listUnsettledEffects(mission.id)).length > 0) {
    throw new ConflictError(
      'mission-effects-unsettled',
      'publish/MR intents must settle before attaching a merge request',
    )
  }

  // 平台主动校验 MR 存在与当前 head（不信入参自述）。
  const observePort = deps.ports?.mrEffects
  if (observePort === undefined) {
    throw new ConflictError('mr-observe-unavailable', 'code-host observe port is not wired')
  }
  const observed = await observePort.observe(mission.repositoryId, input.mrIid)
  if (!observed.ok) {
    throw new ConflictError('mr-observe-unavailable', `${observed.code}: ${observed.detail}`)
  }
  const mr = observed.observation

  // claim 键：入参覆盖 > repo binding 推导；两者皆缺是配置问题，typed 409。
  const derived = deps.repoBinding?.(mission.repositoryId) ?? null
  const codeHostEndpointRef = input.codeHostEndpointRef ?? derived?.codeHostEndpointRef
  const stableProjectRef = input.stableProjectRef ?? derived?.stableProjectRef
  if (codeHostEndpointRef === undefined || stableProjectRef === undefined) {
    throw new ConflictError(
      'mr-binding-unresolved',
      'cannot derive the code-host claim key for this repository; pass codeHostEndpointRef/stableProjectRef explicitly',
    )
  }

  const now = deps.now()
  const claimId = ulid()
  const claimed = await deps.store.claimMr({
    id: claimId,
    codeHostEndpointRef,
    stableProjectRef,
    mrIid: input.mrIid,
    missionId: mission.id,
    epoch: mission.epoch,
    headSha: mr.sourceSha,
    now,
  })
  let mrClaimId = claimId
  if (!claimed.ok) {
    // 撞唯一 ≠ 一定是别人（重试重放撞回自己的行）；消歧后异主才拒。
    const existing = await deps.store.findMrClaim({
      codeHostEndpointRef,
      stableProjectRef,
      mrIid: input.mrIid,
    })
    if (existing === null || existing.missionId !== mission.id) {
      throw new ConflictError('mr-owned-by-another-mission', claimed.code)
    }
    mrClaimId = existing.id
  }

  const bound = await deps.store.occUpdate(mission.id, mission.revision, mission.epoch, {
    deliveryKind: 'adopt-merge-request',
    adoptedMrRef: input.mrIid,
    mrClaimId,
  })
  if (!bound.ok) throw new ConflictError(`mission-occ-${bound.code}`, bound.code)

  // 所挂 MR 已终结：同一命令内记录 binding + authoritative terminal receipt；
  // 不要求 source branch 仍可写，也不启动任何 action（§4.8）。
  if (mr.state === 'merged' || mr.state === 'closed') {
    const terminalKind = mr.state === 'merged' ? ('merged' as const) : ('closed-unmerged' as const)
    const to = terminalStatusForMr(mr.state === 'merged' ? 'merged' : 'closed')
    const uploadFulfillment =
      mission.uploadPlanRef === null
        ? null
        : mission.uploadPublicationRef !== null
          ? 'fulfilled'
          : 'unfulfilled'
    const fresh = await deps.store.getMission(mission.id)
    if (fresh !== null) {
      const settled = await deps.store.occUpdate(fresh.id, fresh.revision, fresh.epoch, {
        status: to,
        terminalKind,
        terminalAt: now,
        currentActionRunId: null,
        terminalUploadFulfillment: uploadFulfillment,
      })
      if (settled.ok) await deps.store.releaseMr(mrClaimId, now)
    }
    await persistCellsPatch(
      deps,
      await loadMission(deps, mission.id),
      {
        '__mr.ref': { state: 'known', value: input.mrIid, sourceRevision: mrClaimId },
        '__mr.state': { state: 'known', value: mr.state, sourceRevision: mrClaimId },
      },
      { kind: 'attach-terminal', mrIid: input.mrIid },
    )
    return { status: to, deliveryKind: 'adopt-merge-request', mrClaimId, terminal: terminalKind }
  }

  await persistCellsPatch(
    deps,
    await loadMission(deps, mission.id),
    {
      '__mr.ref': { state: 'known', value: input.mrIid, sourceRevision: mrClaimId },
      '__mr.headSha': {
        state: 'known',
        value: mr.sourceSha ?? '',
        sourceRevision: mrClaimId,
      },
    },
    { kind: 'attach-binding', mrIid: input.mrIid },
  )
  const after = await loadMission(deps, mission.id)
  return {
    status: after.status,
    deliveryKind: 'adopt-merge-request',
    mrClaimId,
    terminal: null,
  }
}

// -------------------------------------------------------------------- resume

export const resumeMissionInputSchema = z.object({ missionId: z.string().min(1) }).strict()

export interface ResumeMissionResult {
  readonly automationMode: 'active'
  readonly status: MissionStatus
}

export async function resumeMission(
  deps: MissionHandoverDeps,
  rawInput: unknown,
): Promise<ResumeMissionResult> {
  const input = resumeMissionInputSchema.parse(rawInput)
  const mission = await loadMission(deps, input.missionId)
  assertAdmissible(mission, 'resume-automation')

  // 先刷新 facts：MR facts 标记过期（'0' 恒 stale），下轮 care 链强制 recollect
  // 后才会重新选动作——「resume 先刷新全部 facts/budgets 再决策」的实现面。
  await persistCellsPatch(
    deps,
    mission,
    {
      '__mr.factsCollectedAt': { state: 'known', value: '0', sourceRevision: 'resume' },
      '__pipeline.collectedAt': { state: 'known', value: '0', sourceRevision: 'resume' },
    },
    { kind: 'resume-refresh' },
  )
  const fresh = await loadMission(deps, input.missionId)
  const resumed = await deps.store.bumpEpoch(fresh.id, fresh.revision, {
    automationMode: 'active',
  })
  if (!resumed.ok) throw new ConflictError(`mission-occ-${resumed.code}`, resumed.code)
  const after = await loadMission(deps, input.missionId)
  return { automationMode: 'active', status: after.status }
}
