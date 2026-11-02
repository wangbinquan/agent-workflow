// RFC-401 A1 —— agent 的唯一写入参与者合同（design §9.2）。
//
// 普通 CRUD、Intent、资源包与数字员工模板都经这一个参与者写 agent：校验、规范化、版本 fence 与名称冲突只有一份实现，
// 同一非法输入在各入口得到同一 code / status / message / details（以普通编辑现行行为为准，design §2.2）。
// 场景只保留自己的规则：Intent 的 copy 回填与 owner-only、资源包的引用解析与已选基线、模板的系统所有权。

import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'
import type { ResourceAclActorProjection } from '../../domain/resourceAccess'

/** 写入者：当前用户（引用可见性按其 ACL 判定），或系统内建写入（系统用户所有、public、builtin，不做可见性判定）。 */
export type AgentMutationOwner =
  | Readonly<{ kind: 'actor'; actor: ResourceAclActorProjection }>
  | Readonly<{ kind: 'system'; userId: string }>

export interface AgentMutationFence {
  readonly expectedUpdatedAt: number
  readonly expectedAclRevision: number
}

/** 一次提交多个资源的场景（Intent、资源包）给出的批内事实。 */
export interface AgentMutationBatch {
  /**
   * 本批 agent 的最终 dependsOn；不属于本批的 id 返回 undefined。依赖图校验以它覆盖事务内的读取，
   * 所以批内的环与自依赖在参与者里按普通编辑的判据报出，而不是在排序时抛场景错误。
   */
  pendingDependencies(id: string): readonly string[] | undefined
  /** 本批新建、提交后才发布的 managed skill；RFC-228 闭包校验视为可用。 */
  readonly stagedSkillIds: ReadonlySet<string>
}

export interface AgentCreateMutation {
  readonly id: string
  /** 引用已解析为 id 的定义；规范化（执行合同端口、引用去重）由参与者做。 */
  readonly agent: CreateAgent
  readonly batch?: AgentMutationBatch
}

export interface AgentUpdateMutation {
  readonly id: string
  readonly fence: AgentMutationFence
  /** 场景规则，在 fence 之前对当前行执行（Intent 的 owner-only 与改名限制、模板的系统所有权）。 */
  readonly guard?: (current: Agent) => void
  /** 由场景按当前行生成 patch（Intent 的 sidecar 回填、资源包的引用解析）。 */
  readonly patch: (current: Agent) => UpdateAgent | Promise<UpdateAgent>
  readonly batch?: AgentMutationBatch
}

/** 绑定在调用方事务上的 agent 写入；全部 SQL 在该事务上执行，不另开事务。 */
export interface AgentMutationParticipant {
  create(owner: AgentMutationOwner, input: AgentCreateMutation): Promise<Agent>
  update(owner: AgentMutationOwner, input: AgentUpdateMutation): Promise<Agent>
}
