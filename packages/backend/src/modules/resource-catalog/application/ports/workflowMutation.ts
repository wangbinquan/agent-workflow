// RFC-401 A3 —— workflow 的唯一写入参与者合同（design §9.4）。
//
// 普通 CRUD（新建、复制、保存）、Intent、资源包与内建 workflow 目录都经这一个参与者写 workflow：定义规范化、规范 agent id、
// 脚本 / 代码托管作者门、引用可见性、改名校验、版本 fence 与 already-current 判定只有一份实现，错误以普通编辑现行行为为准
// （design §2.2）。workflow 不判重名，保存时也不做完整图校验（proposal §5 第 2、8 项：草稿可保存，完整校验是显式操作）。
// 场景只保留自己的规则：普通编辑的「编辑者不能改名」、Intent 的 owner-only 与禁止改名、资源包的引用解析与已选基线、
// 复制的命名、内建目录的布局规划。

import type { Workflow, WorkflowDefinition, WorkflowDraftSnapshot } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'

/**
 * 写入者：当前用户（作者门与引用可见性按其权限判定），或系统内建写入（系统用户所有、public、builtin，作者门放行、不做
 * 可见性判定）。
 */
export type WorkflowMutationOwner =
  | Readonly<{ kind: 'actor'; actor: Actor }>
  | Readonly<{ kind: 'system'; userId: string; reason: string }>

export interface WorkflowMutationContent {
  readonly name: string
  readonly description: string
  readonly definition: WorkflowDefinition
}

/** 一次提交多个资源的场景（Intent、资源包）给出的批内事实。 */
export interface WorkflowMutationBatch {
  /** 本批新建的 workflow / workgroup 名称：按名字调用它们视为可见（被调方可能在本批稍后才写入）。 */
  readonly createdNames: Readonly<{
    workflow: ReadonlySet<string>
    workgroup: ReadonlySet<string>
  }>
}

export interface WorkflowCreateMutation {
  readonly id: string
  readonly content: WorkflowMutationContent
  /**
   * `verbatim-copy`：内容是一份已入库修订的原样复制（RFC-231 复制）。作者门放行（D21：不引入平台没接受过的可执行内容），
   * 定义只做版本迁移、不再要求规范 agent id——复制不能因为源行的历史形状而失败。
   */
  readonly provenance?: 'authored' | 'verbatim-copy'
  readonly batch?: WorkflowMutationBatch
}

export interface WorkflowUpdateMutation {
  readonly id: string
  /** 调用方据以编辑的版本（编辑器的 expectedVersion、Intent 的计划修订、资源包的已选版本）。 */
  readonly expectedVersion: number
  /** 由场景按当前行生成提交内容（资源包按当前定义解析引用、保留历史引用）。 */
  readonly patch: (current: Workflow) => WorkflowMutationContent | Promise<WorkflowMutationContent>
  /**
   * 场景规则，返回要写入的名称（缺省为提交的名称）：普通编辑的改名规则（编辑者不能改名、改动后的名称须合法）、Intent 的
   * owner-only 与禁止改名。它在定义规范化与特权节点回填之后、作者门之前执行——普通编辑此前的首错顺序就是「规范 agent id
   * 先于改名校验」（`rfc359-w16-workflow-boundary-conformance` 锁定）。
   */
  readonly guard?: (current: Workflow, submittedName: string) => string | Promise<string>
  readonly batch?: WorkflowMutationBatch
}

export interface WorkflowUpdateResult {
  /** 写入后的行；already-current 时是当前行。 */
  readonly workflow: Workflow
  /** 规范化后的提交内容（特权节点已回填）。 */
  readonly snapshot: WorkflowDraftSnapshot
  readonly outcome: 'committed' | 'already-current'
}

/** 绑定在调用方事务上的 workflow 写入；全部 SQL 在该事务上执行，不另开事务。 */
export interface WorkflowMutationParticipant {
  create(owner: WorkflowMutationOwner, input: WorkflowCreateMutation): Promise<Workflow>
  update(owner: WorkflowMutationOwner, input: WorkflowUpdateMutation): Promise<WorkflowUpdateResult>
}
