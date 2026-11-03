// RFC-401 T5 —— skill 的唯一写入参与者合同（design §10.2）。
//
// 普通 CRUD（新建、保存、文件写删、ZIP、restore、删除）、fusion、Intent 与资源包都经这一个参与者写 `skills` 与 `skill_versions`
// 行：名称冲突、复合前置条件、版本号、metaRevision 规则、内容不变不增版本与删除前的引用复查只有一份实现。内容（文件树或数据库
// 字节）由各场景的工件 owner 暂存与发布，参与者只写行。

import type { SkillVersionSource } from '@agent-workflow/shared'
import type { SkillVersionCompositeExpectation } from '../../domain/skillVersionCommit'

export type SkillContentKind = 'local-file' | 'database-bytes'

export interface SkillCreateMutation {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly ownerUserId: string | null
  readonly contentKind: SkillContentKind
  /** v1 的内容摘要（暂存后得到）。 */
  readonly contentHash: string | null
  /** 内容 owner 给出的 live 与 v1 引用；缺省为本地布局 `skills/{id}/files`、`skills/{id}/versions/v1/files`。 */
  readonly livePath?: string
  readonly versionPath?: string
  readonly authorUserId: string | null
  readonly now: number
}

export interface SkillVersionMutationHooks {
  /** 在复合前置条件之前（fusion 先重验自身状态）。 */
  before?(): Promise<void> | void
  /** 版本行写入之后、同一事务内（restore 退回记忆、fusion 标记已融合并结算）。 */
  after?(versionIndex: number): Promise<void> | void
}

export interface SkillVersionMutation {
  readonly skillId: string
  /** 暂存时据以规划的版本号；必须等于事务里的 contentVersion + 1，否则按 stale 退回。 */
  readonly versionIndex: number
  readonly contentKind: SkillContentKind
  /** 暂存内容的摘要；`null` 只出现在旧格式发布（没有摘要可比，不判不变）。 */
  readonly contentHash: string | null
  /** 内容 owner 给出的 live 与新版本引用；缺省为本地布局。 */
  readonly livePath?: string
  readonly versionPath?: string
  /** 调用方授权那一刻看到的技能形状（六项，未给的项不设栅栏）。 */
  readonly fence: SkillVersionCompositeExpectation
  readonly source: SkillVersionSource
  readonly summary: string | null
  readonly fusionId: string | null
  readonly restoredFromVersion: number | null
  readonly authorUserId: string | null
  /** 写入后的 description；`undefined` = 不变。与当前不同时 metaRevision + 1。 */
  readonly description?: string
  /**
   * `on-change`（缺省）：内容摘要与当前版本相同且 description 不变时不写任何行，返回 `already-current`。`always`：restore 与
   * fusion 总是推进版本。
   */
  readonly advance?: 'on-change' | 'always'
  readonly hooks?: SkillVersionMutationHooks
  readonly now: number
}

export type SkillVersionMutationResult =
  | {
      readonly outcome: 'committed'
      readonly versionIndex: number
      readonly metaRevision: number
      readonly versionRowId: string
    }
  | {
      readonly outcome: 'already-current'
      readonly versionIndex: number
      readonly metaRevision: number
    }

export interface SkillDeleteMutation {
  readonly skillId: string
  /** 删除确认时看到的技能形状；未给 = 不设栅栏。 */
  readonly fence?: SkillVersionCompositeExpectation
}

/** 绑定在调用方事务上的 skill 写入；全部 SQL 在该事务上执行，不另开事务。 */
export interface SkillMutationParticipant {
  /** 新建：同一 owner 下重名 → 409 `skill-name-in-use`；直接写入 ready 行与 v1 版本行。 */
  create(input: SkillCreateMutation): Promise<void>
  version(input: SkillVersionMutation): Promise<SkillVersionMutationResult>
  /** 删除：事务内复查引用，仍被 agent 引用 → `SkillDeleteReferencedError`（场景转成 409 `skill-in-use`）。 */
  delete(input: SkillDeleteMutation): Promise<void>
}
