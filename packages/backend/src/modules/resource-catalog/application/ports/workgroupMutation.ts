// RFC-401 A3b —— workgroup 的唯一写入参与者合同（design §9.5）。
//
// 普通 CRUD（新建、复制、保存）、Intent 与资源包都经这一个参与者写 workgroup 与成员行：人类成员有效性、agent 成员的可见性与
// 存在性、版本 fence 与 already-current、名称冲突、成员行的重建只有一份实现，错误与首错顺序以普通编辑现行行为为准
// （design §2.2）。场景只保留自己的规则：普通编辑的编辑权与改名权限、复制命名；Intent 的 owner-only 与禁止改名；资源包的
// 人类成员映射、包内引用解析与已选基线。

import type { Workgroup, WorkgroupDraftSnapshot } from '@agent-workflow/shared'
import type { ResourceAclActorProjection } from '../../domain/resourceAccess'

export interface WorkgroupCreateMutation {
  readonly id: string
  /** 规范化后的快照（输出合同已解析、缺省值已填）。 */
  readonly snapshot: WorkgroupDraftSnapshot
  /**
   * `copy`：快照来自一个已有 workgroup 的复制（RFC-231）。agent 成员不存在与不可见同样报 `acl-missing-refs`（普通编辑复制
   * 此前的 fail-closed 判据）；新建（`authored`，缺省）对不存在的 agent 报 `workgroup-member-agent-invalid`。
   */
  readonly provenance?: 'authored' | 'copy'
}

export interface WorkgroupUpdateMutation {
  readonly id: string
  /** 调用方据以编辑的版本（编辑器的 expectedVersion、Intent 的计划修订、资源包的已选版本）。 */
  readonly expectedVersion: number
  /** 由场景按当前行生成提交的快照（普通编辑以当前输出合同补缺省、资源包按当前快照补缺省字段）。 */
  readonly patch: (
    current: Workgroup,
    currentSnapshot: WorkgroupDraftSnapshot,
  ) => WorkgroupDraftSnapshot | Promise<WorkgroupDraftSnapshot>
  /**
   * 场景规则，返回要写入的名称：普通编辑的改名权限（编辑者不能改名）、Intent 的 owner-only 与禁止改名。时机取普通编辑此前的
   * 首错顺序——成员校验与版本 fence 之后、名称冲突之前。
   */
  readonly guard?: (current: Workgroup, submittedName: string) => string | Promise<string>
}

export interface WorkgroupUpdateResult {
  /** 写入后的 workgroup；already-current 时是当前的。 */
  readonly workgroup: Workgroup
  /** 写入后（或当前）的快照。 */
  readonly snapshot: WorkgroupDraftSnapshot
  readonly outcome: 'committed' | 'already-current'
}

/** 绑定在调用方事务上的 workgroup 写入；全部 SQL 在该事务上执行，不另开事务。 */
export interface WorkgroupMutationParticipant {
  create(actor: ResourceAclActorProjection, input: WorkgroupCreateMutation): Promise<Workgroup>
  update(
    actor: ResourceAclActorProjection,
    input: WorkgroupUpdateMutation,
  ): Promise<WorkgroupUpdateResult>
}
