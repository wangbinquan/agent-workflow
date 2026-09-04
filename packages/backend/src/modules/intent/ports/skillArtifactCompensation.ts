// RFC-355 T6（RFC-294 W4-E4a）—— intent 的 apply 恢复路径需要的**技能工件补偿能力**。
//
// intent 的 `ArtifactLifecycle` 负责「这次 apply 没走完，把已经落地的工件补偿掉 / 前滚完成」。
// 编排是 intent 的，但**被补偿的东西是 resource-catalog 的**：技能的暂存目录、版本的
// staged 记录、boot 校验标记、skill operation 的收尾。此前 intent 直接
// `import { compensateManagedSkillStage } from '@/modules/resource-catalog/infrastructure/legacy/skill'`
// ——RFC-317 R2 禁止的跨 context 内部 import。
//
// 现在 intent 只声明它要的这几件事，实现由 resource-catalog 提供、bootstrap 注入
// （形态与 RFC-353 给 memory / RC 落 participant 一致）。
//
// **为什么按 provider 分两个端口**：两条恢复路径要的原语本就不同（SQLite 走 staged 版本记录 +
// skill operation 账，PostgreSQL 走目录 swap + 内容哈希），硬凑一个「provider 中性」的合同
// 只会得到一个两边都用不满的联合体。端口按消费者的真实需要划，不按对称美感划。

import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'

/** SQLite 恢复路径要的技能工件原语。 */
export interface SqliteSkillArtifactCompensation {
  /** 补偿一个未提交的技能暂存（建/改技能的 staging 目录与候选行）。 */
  compensateManagedSkillStage(db: DbClient, artifact: { readonly [k: string]: unknown }): void
  /** 丢弃一个已 stage 未提交的技能版本。 */
  abortStagedSkillVersion(db: DbClient, staged: unknown): void
  /** 把一个已提交的技能版本发布成 live files/。 */
  publishStagedSkillVersion(
    db: DbClient,
    options: { readonly appHome: string },
    staged: unknown,
  ): void
  /** 撤销某技能的本次 boot admission（发布前必须撤，见 RC 的 stage/publish 注释）。 */
  unmarkSkillBootVerified(skillId: string): void
  /** 收尾一个 skill operation（在调用方的事务里）。 */
  finishOperation(tx: DbTxSync, operationId: string): void
  /** 读一个 skill operation 的当前状态；`undefined` = 不存在。 */
  loadSkillOperationState(
    db: DbClient,
    operationId: string,
  ): { readonly active: number; readonly phase: string } | undefined
}

/** PostgreSQL 恢复路径要的技能工件原语（目录 swap + 内容哈希 + 路径解析）。 */
export interface PostgresqlSkillArtifactCompensation {
  cleanupOpDirs(liveDirectory: string, operationId: string): void
  opCandidateDir(liveDirectory: string, operationId: string): string
  opStagedDir(liveDirectory: string, operationId: string): string
  swapInStaged(liveDirectory: string, operationId: string): void
  hashRegularFileTree(directory: string): string
  skillFilesAbs(appHome: string, skillId: string): string
  skillVersionAbs(appHome: string, skillId: string, version: number): string
  markSkillBootVerified(skillId: string): void
}
