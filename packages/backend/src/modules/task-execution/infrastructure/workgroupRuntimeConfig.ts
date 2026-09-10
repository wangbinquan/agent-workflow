// RFC-359 W57 —— 工作组运行时配置的构建：**一份**，两个启动臂共用。
//
// 此前 `postgresqlTaskRouteLaunchOperations.ts`（收 `Workgroup` 资源行）与
// `postgresqlChildExecutionLaunchOperations.ts`（收任务快照里的 `FrozenWorkgroupGroup`）
// 各存一份**逐字相同**的实现——连字段顺序都一样，唯一的差别是形参标注。
// 两侧都在往同一个 `WorkgroupRuntimeConfigSchema` 里 parse，分开写只是分开漂的机会：
// 这份配置是引擎**唯一**读的那份（design §8.4，引擎从不读 workgroups 资源行），
// 少填一个字段就是一整类运行时行为在某一条启动路径上悄悄消失。
//
// 落在这个目录而不是 shared：`FrozenWorkgroupGroup` 是 backend 侧的类型
// （`./legacyCallClosure.ts`）；两个调用点也都在本目录，共享它不新增任何一条 import 边。

import {
  WorkgroupRuntimeConfigSchema,
  resolveWorkgroupOutputContract,
  type Workgroup,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'

import type { FrozenWorkgroupGroup } from './legacyCallClosure'

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
