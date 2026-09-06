import type { ProviderNeutralDatabase } from '@/db/query'
import { createSkillCatalogBootParticipant } from '../application/skills/skillCatalogBootParticipant'
import { createSkillCatalogBootAdapter } from '../infrastructure/skillCatalogBootAdapter'
import type { SkillCatalogBootParticipant } from '../public/participants'

/**
 * RFC-359 W4-D23c —— 技能目录启动：一份装配，两个数据库共用。
 *
 * 此前是 21 行薄适配器（SQLite，套 `legacy/skill*` 的崩溃安全状态机）对 1418 行原生重写
 * （PostgreSQL）。两侧同名的五个启动阶段里，PostgreSQL 那份**整条略过**了身份迁移屏障末尾的
 * 引用完整性复核——正是「一个好一个不好」。合一后两个数据库跑同一份状态机，PG 侧因此补齐了
 * 那道屏障（见 `legacy/skillIdentityMigration.ts` 的孤儿行查询）。
 */
export function composeSkillCatalogBoot(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
}): SkillCatalogBootParticipant {
  return createSkillCatalogBootParticipant(createSkillCatalogBootAdapter(input))
}
