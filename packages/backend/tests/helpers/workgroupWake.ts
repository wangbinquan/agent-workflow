// RFC-359 W4-D19c-tail —— 唤醒集判据的测试入口。
//
// 合一之前这些套件直接调 `legacy/workgroup/wake.ts` 的 `deriveWakeSet(input: WakeInput)`，
// 而生产（两个 provider）跑的是 `workgroupTurnsDriver.ts` 里那份
// `deriveWakeSet(snapshot, inflight)`——同一条判据的两种写法，套件锁的是**已经没人跑**的那份。
//
// 这个适配器把旧的 `WakeInput` 字面量翻成中立驱动要的 `(snapshot, inflight)`，让既有断言原样
// 接到生产那条路上：
//   * `config` / `assignments` / `messages` / `cursors` 直接过（`WorkgroupTurnAssignment` 只比
//     `WorkgroupAssignment` 多一个 `attemptCount`，缺省 0）；
//   * `inFlight` 逐字段搬进 `InflightTurns`；
//   * `budgetUsed` 在中立驱动里是**从 hostRuns 推**的（`roundBudget`），不是传进来的：
//     leader_worker 取领队 run 的最大 `wgRound`，free-collab 数成员 run。所以这里按模式合成
//     恰好产出该预算的 hostRuns——判据不变，只是从「直接给」变成「按生产的推法给」。
//   * `readonlyMemberIds` 变成 `memberAgents[].readonly`；
//   * `gate` 三个布尔折成 `state.gateStatus`（中立侧是单一状态机，见
//     `WORKGROUP_TURN_GATE_TRANSITIONS`）。

import type {
  WorkgroupAssignment,
  WorkgroupMessage,
  WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  type WorkgroupHostLedgerRun,
} from '@/modules/task-execution/public/commands'
import type {
  InflightTurns,
  WorkgroupTurnMemberAgent,
  WorkgroupTurnsSnapshot,
} from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'

/** 合一前 `legacy/workgroup/wake.ts` 的输入形状，逐字保留，方便既有夹具照抄。 */
export interface LegacyWakeInput {
  config: WorkgroupRuntimeConfig
  assignments: readonly WorkgroupAssignment[]
  messages: readonly WorkgroupMessage[]
  cursors: ReadonlyMap<string, string>
  inFlight: {
    leaderRunning: boolean
    runningAssignmentIds: ReadonlySet<string>
    messageTurnMemberIds: ReadonlySet<string>
    initialPlanningMemberIds?: ReadonlySet<string>
    taskTurnMemberIds?: ReadonlySet<string>
  }
  budgetUsed: number
  readonlyMemberIds?: ReadonlySet<string>
  leaderClarifyParked?: boolean
  gate: {
    declaredDone: boolean
    awaitingConfirmation: boolean
    rejected: boolean
  }
}

function hostRunsForBudget(
  config: WorkgroupRuntimeConfig,
  budgetUsed: number,
): WorkgroupHostLedgerRun[] {
  const base = {
    shardKey: null,
    status: 'done' as const,
    rerunCause: null,
    retryIndex: 0,
    envelopeNonce: '',
  }
  if (config.mode === 'leader_worker') {
    // 领队预算 = 领队 run 的最大 wgRound（未标 round 的另算），一条就够表达。
    if (budgetUsed <= 0) return []
    return [
      {
        ...base,
        id: 'wake-budget-leader',
        nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
        wgRound: budgetUsed,
      },
    ]
  }
  // free-collab 预算 = 成员 run 计数。
  return Array.from({ length: Math.max(0, budgetUsed) }, (_unused, index) => ({
    ...base,
    id: `wake-budget-member-${index}`,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    wgRound: null,
  }))
}

function gateStatusOf(
  gate: LegacyWakeInput['gate'],
): WorkgroupTurnsSnapshot['state']['gateStatus'] {
  if (gate.rejected) return 'rejected'
  if (gate.awaitingConfirmation) return 'awaiting_confirmation'
  if (gate.declaredDone) return 'declared'
  return 'idle'
}

export function wakeSnapshotOf(input: LegacyWakeInput): {
  snapshot: WorkgroupTurnsSnapshot
  inflight: InflightTurns
} {
  const readonlyIds = input.readonlyMemberIds ?? new Set<string>()
  const memberAgents: WorkgroupTurnMemberAgent[] = input.config.members
    .filter((member) => member.memberType === 'agent')
    .map((member) => ({
      memberId: member.id,
      agent: { id: member.agentId ?? member.id, name: member.agentName ?? member.id } as never,
      capabilityCard: '',
      readonly: readonlyIds.has(member.id),
    }))
  return {
    snapshot: {
      taskId: 'task-wake-fixture',
      config: input.config,
      state: {
        gateStatus: gateStatusOf(input.gate),
        gateSummary: null,
        gateRejectedComment: null,
        pauseReason: null,
        dynamicWorkflowState: null,
        resultMessageId: null,
      },
      assignments: input.assignments.map((assignment) => ({ ...assignment, attemptCount: 0 })),
      messages: input.messages,
      cursors: input.cursors,
      memberAgents,
      hostRuns: hostRunsForBudget(input.config, input.budgetUsed),
      leaderClarifyParked: input.leaderClarifyParked ?? false,
    },
    inflight: {
      leaderRunning: input.inFlight.leaderRunning,
      runningAssignmentIds: new Set(input.inFlight.runningAssignmentIds),
      messageTurnMemberIds: new Set(input.inFlight.messageTurnMemberIds),
      initialPlanningMemberIds: new Set(input.inFlight.initialPlanningMemberIds ?? []),
      taskTurnMemberIds: new Set(input.inFlight.taskTurnMemberIds ?? []),
    },
  }
}
