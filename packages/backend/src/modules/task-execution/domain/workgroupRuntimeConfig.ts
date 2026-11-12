// RFC-359 W57 —— 工作组运行时配置的构建：**一份**，两个启动臂共用。
//
// 此前 `taskRouteLaunchOperations.ts`（收 `Workgroup` 资源行）与
// `childExecutionLaunchOperations.ts`（收任务快照里的 `FrozenWorkgroupGroup`）
// 各存一份**逐字相同**的实现——连字段顺序都一样，唯一的差别是形参标注。
// 两侧都在往同一个 `WorkgroupRuntimeConfigSchema` 里 parse，分开写只是分开漂的机会：
// 这份配置是引擎**唯一**读的那份（design §8.4，引擎从不读 workgroups 资源行），
// 少填一个字段就是一整类运行时行为在某一条启动路径上悄悄消失。
//
// 落在 task-execution 而不是 shared：`FrozenWorkgroupGroup` 是 backend 侧的类型（RFC-454 起在 resource-catalog 的
// `domain/callClosure.ts`，经其 `public/types` 取）。RFC-486：纯函数，从 infrastructure 迁入 domain，两个调用点是 application 的
// 工作组启动臂与 infrastructure 的子任务启动。

import {
  WorkgroupRuntimeConfigSchema,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  buildClarifyEdges,
  type WorkflowDefinition,
  resolveWorkgroupOutputContract,
  type Workgroup,
  type WorkgroupRuntimeConfig,
  WORKGROUP_TURN_CLARIFY_NODE_ID as WG_CLARIFY_NODE_ID,
  WORKGROUP_TURN_LEADER_NODE_ID as WG_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID as WG_MEMBER_NODE_ID,
} from '@agent-workflow/shared'

import type { FrozenWorkgroupGroup } from '@/modules/resource-catalog/public/types'

/** 资源行与冻结副本两种来源；构建只读两者共有的那些字段。 */
export type WorkgroupRuntimeConfigSource = Workgroup | FrozenWorkgroupGroup

export function buildWorkgroupRuntimeConfig(
  group: WorkgroupRuntimeConfigSource,
  goal: string,
): WorkgroupRuntimeConfig {
  return WorkgroupRuntimeConfigSchema.parse({
    workgroupId: group.id,
    workgroupName: group.name,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    leaderMemberId: group.leaderMemberId,
    switches: group.switches,
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget,
    fanOut: group.fanOut,
    instructions: group.instructions,
    goal,
    members: group.members.map((member) => ({
      id: member.id,
      memberType: member.memberType,
      agentName: member.agentName,
      agentId: member.agentId ?? null,
      userId: member.userId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })),
  })
}

// RFC-395 II-a: production and fixtures share the parsed host snapshot and group projection.
// The workgroup host node ids are wire-frozen in task snapshots and node-run identities; RFC-454 takes them from
// shared's single source (they used to be repeated here so this file would not import resource-catalog's
// provider-private workgroup infrastructure).

export function buildWorkgroupHostSnapshot(config: WorkgroupRuntimeConfig): WorkflowDefinition {
  const leaderMember = config.members.find((member) => member.id === config.leaderMemberId)
  const firstAgent = config.members.find((member) => member.memberType === 'agent')
  const leaderAgentName = leaderMember?.agentName ?? firstAgent?.agentName ?? 'workgroup-member'
  const memberAgentName = firstAgent?.agentName ?? 'workgroup-member'
  return WorkflowDefinitionSchema.parse({
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [
      { id: WG_LEADER_NODE_ID, kind: 'agent-single', agentName: leaderAgentName },
      { id: WG_MEMBER_NODE_ID, kind: 'agent-single', agentName: memberAgentName },
      { id: WG_CLARIFY_NODE_ID, kind: 'clarify', sessionMode: 'isolated' },
    ],
    edges: [
      ...buildClarifyEdges(WG_LEADER_NODE_ID, WG_CLARIFY_NODE_ID),
      ...buildClarifyEdges(WG_MEMBER_NODE_ID, WG_CLARIFY_NODE_ID),
    ],
  })
}

export function resolveWorkgroupCollaborators(
  explicit: readonly string[] | undefined,
  group: Workgroup,
): readonly string[] {
  const humanUserIds = group.members.flatMap((member) =>
    member.memberType === 'human' && member.userId !== null ? [member.userId] : [],
  )
  return [...new Set([...(explicit ?? []), ...humanUserIds])]
}
