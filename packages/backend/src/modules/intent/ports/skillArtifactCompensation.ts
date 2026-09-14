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
// **为什么是两个端口**：它们不是「两个 provider 的对称两份」——一个是**现行**的工件机制
// （目录 swap + 内容哈希），另一个是**读旧 journal 行**时才走的兼容面。端口按消费者的真实
// 需要划，不按对称美感划。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

/**
 * RFC-359 —— **合一之前**由 SQLite 那台 apply 引擎写下的 journal 工件，前滚时要的原语。
 *
 * 这个端口此前叫 `SqliteSkillArtifactCompensation`，是「SQLite provider 的恢复路径」。
 * 两台引擎合一后不再有「SQLite 的恢复路径」——只有**一条**恢复路径，它偶尔会读到一条
 * 旧词汇的 journal 行。所以这里剩下的只有旧工件前滚真正用得上的那几件；补偿那一侧已经
 * 由 `compensateLegacyArtifact` 用 PG 原语直接做掉了，不再需要 legacy 版本。
 */
export interface LegacyIntentSkillArtifactCompat {
  /** 把一个已提交的技能版本发布成 live files/。 */
  publishStagedSkillVersion(
    db: ProviderNeutralDatabase,
    options: { readonly appHome: string },
    staged: unknown,
  ): void | Promise<void>
  /** 撤销某技能的本次 boot admission（发布前必须撤，见 RC 的 stage/publish 注释）。 */
  unmarkSkillBootVerified(skillId: string): void
  /** 收尾一个 skill operation（在调用方的事务里）。 */
  // RFC-359 W4-D23b：op 原语迁到中立事务后是异步的。
  finishOperation(tx: DatabaseTransaction, operationId: string): void | Promise<void>
  /** 读一个 skill operation 的当前状态；`undefined` = 不存在。 */
  loadSkillOperationState(
    db: ProviderNeutralDatabase,
    operationId: string,
  ):
    | { readonly active: number; readonly phase: string }
    | undefined
    | Promise<{ readonly active: number; readonly phase: string } | undefined>
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
