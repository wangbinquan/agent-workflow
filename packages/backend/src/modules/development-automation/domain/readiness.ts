// RFC-310 T29 —— readiness 固定算法（design.md §2.4）。
//
// 纯函数、不可被 policy 覆盖的部分：unknown/partial/unavailable 永不折算
// pass；「最后一次曾经绿色」不适用于新 head；automationReady 先于 host
// mergeability；human hold 只能由 committer 在外部系统解除。readiness receipt
// 绑定 head/target/snapshot/policy revision——任一变化即失效（stale 判定归
// reconciler，本文件只算当下）。

import { gateCountsAsPass, type GateStatus } from './pipelineManifest'

export interface MachineHold {
  readonly kind:
    | 'active-action'
    | 'unconfirmed-effect'
    | 'unhandled-feedback'
    | 'conflict'
    | 'required-gate-not-pass'
    | 'facts-incomplete'
    | 'head-mismatch'
    | 'upload-fulfillment-pending'
  readonly detail: string
}

export interface HumanHold {
  readonly kind: 'approval-required' | 'thread-unresolved' | 'committer-policy-hold'
  readonly detail: string
}

export interface ReadinessInput {
  readonly evaluatedForHead: string | null
  readonly factDigest: string
  readonly activeAction: boolean
  readonly unconfirmedEffects: number
  readonly unhandledFeedback: number
  readonly conflict: boolean
  readonly requiredGates: readonly { readonly gateKey: string; readonly status: GateStatus }[]
  readonly pipelineComplete: boolean
  readonly factsComplete: boolean
  readonly headConsistent: boolean
  readonly uploadFulfillmentPending: boolean
  readonly approvalsOutstanding: number
  readonly unresolvedHumanThreads: number
  readonly committerPolicyHold: boolean
  readonly hostMergeable: 'yes' | 'no' | 'unknown'
}

export interface MissionReadiness {
  readonly evaluatedForHead: string | null
  readonly factDigest: string
  readonly automationReady: boolean
  readonly hostMergeable: 'yes' | 'no' | 'unknown'
  readonly machineHolds: readonly MachineHold[]
  readonly humanHolds: readonly HumanHold[]
  readonly status: 'working' | 'waiting-committer' | 'ready-to-merge'
}

export function computeReadiness(input: ReadinessInput): MissionReadiness {
  const machineHolds: MachineHold[] = []
  if (input.activeAction) machineHolds.push({ kind: 'active-action', detail: 'action running' })
  if (input.unconfirmedEffects > 0) {
    machineHolds.push({
      kind: 'unconfirmed-effect',
      detail: `${input.unconfirmedEffects} effect(s)`,
    })
  }
  if (input.unhandledFeedback > 0) {
    machineHolds.push({
      kind: 'unhandled-feedback',
      detail: `${input.unhandledFeedback} thread(s)`,
    })
  }
  if (input.conflict)
    machineHolds.push({ kind: 'conflict', detail: 'merge conflict against target' })
  for (const gate of input.requiredGates) {
    // unknown/unavailable/partial/queued/running/fail/canceled/skipped 全部不是 pass。
    if (!gateCountsAsPass(gate.status)) {
      machineHolds.push({
        kind: 'required-gate-not-pass',
        detail: `${gate.gateKey}=${gate.status}`,
      })
    }
  }
  if (!input.pipelineComplete) {
    machineHolds.push({ kind: 'facts-incomplete', detail: 'pipeline evidence partial' })
  }
  if (!input.factsComplete) machineHolds.push({ kind: 'facts-incomplete', detail: 'facts missing' })
  if (!input.headConsistent) machineHolds.push({ kind: 'head-mismatch', detail: 'stale head' })
  if (input.uploadFulfillmentPending) {
    machineHolds.push({ kind: 'upload-fulfillment-pending', detail: 'upload plan not published' })
  }

  const humanHolds: HumanHold[] = []
  if (input.approvalsOutstanding > 0) {
    humanHolds.push({
      kind: 'approval-required',
      detail: `${input.approvalsOutstanding} approval(s)`,
    })
  }
  if (input.unresolvedHumanThreads > 0) {
    humanHolds.push({
      kind: 'thread-unresolved',
      detail: `${input.unresolvedHumanThreads} thread(s)`,
    })
  }
  if (input.committerPolicyHold) {
    humanHolds.push({ kind: 'committer-policy-hold', detail: 'committer-only policy' })
  }

  const automationReady = machineHolds.length === 0
  let status: MissionReadiness['status'] = 'working'
  if (automationReady) {
    if (humanHolds.length > 0) status = 'waiting-committer'
    else if (input.hostMergeable === 'yes') status = 'ready-to-merge'
    // hostMergeable no/unknown ⇒ 留在 working（unknown 绝不折算 yes）。
    else status = 'working'
  }
  return {
    evaluatedForHead: input.evaluatedForHead,
    factDigest: input.factDigest,
    automationReady,
    hostMergeable: input.hostMergeable,
    machineHolds,
    humanHolds,
    status,
  }
}
