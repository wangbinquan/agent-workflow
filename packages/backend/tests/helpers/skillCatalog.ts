// RFC-359 W4-D23a —— 技能目录的双引擎一致性夹具。
//
// 技能是剩余最大的一块 provider 分叉：SQLite 侧是薄适配器套成熟的崩溃安全机器
// （`legacy/skill*` 共 5882 行、45 处 `dbTxSync`），PostgreSQL 侧是 3342 行原生重写，
// 归一化相似度只有 7%，而测试覆盖 52 : 6 倒挂——也就是说 PG 那份几乎没有行为覆盖。
//
// 合一之前先把**同一个端口**（`SkillRepository` / `SkillCatalogModule`）在两个引擎上跑同一批
// 场景，用实测差异代替纸面对账：D19b/D19c 的经验是「按端口数覆盖、不是按实现数」，一跑就照出
// 用户可见的分叉。这个夹具只负责把两侧装配成同一个模块面；分叉本身留给断言去照。
//
// RFC-359 W4-D23c 起分叉没有了：装配只剩一份 `composeSkillCatalog({db, appHome, restoreMembership})`，
// 两个引擎同一个入口——这个夹具因此不再需要按能力矩阵分派。它照到的分叉正是被合掉的那些。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import type { SkillCatalogModule } from '@/modules/resource-catalog/public/operations'

/** 回滚时「哪些记忆退回待用」在一致性场景里不参与判据，给空实现。 */
const restoreMembership = Object.freeze({
  unfuseForRestore: async (): Promise<readonly string[]> => [],
})

export interface SkillCatalogFixture {
  readonly catalog: SkillCatalogModule
  readonly appHome: string
}

const roots: string[] = []

/** 夹具建的受管根目录在进程退出时一并清掉（用例之间互不影响，不必逐条清）。 */
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

export function composeTestSkillCatalog(db: ProviderNeutralDatabase): SkillCatalogFixture {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-skill-conformance-'))
  roots.push(appHome)
  return {
    appHome,
    catalog: composeSkillCatalog({ db, appHome, restoreMembership }),
  }
}
