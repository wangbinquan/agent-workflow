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
// 装配形状本身就是分叉的一部分（SQLite 取 `{db, appHome, restoreMembership}`，PG 还要
// `content` 与 `resourceCatalog`），所以这里按能力矩阵的 `isolation` 分派——`describeEachProvider`
// 有意不把 provider 名交给 body，能力矩阵是唯一合法的分叉依据。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProviderNeutralDatabase } from '@/db/query'
import type { DbClient } from '@/db/client'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  composePostgresqlSkillCatalog,
  composeSkillCatalog,
} from '@/modules/resource-catalog/composition/skillOperations'
import type { SkillCatalogModule } from '@/modules/resource-catalog/public/operations'
import { createPostgresqlSkillContentLifecycle } from '@/modules/resource-catalog/infrastructure/postgresqlSkillContentLifecycle'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

/** 回滚时「哪些记忆退回待用」在一致性场景里不参与判据，两侧都给空实现。 */
const syncRestoreMembership = Object.freeze({
  unfuseForRestore: (): string[] => [],
})
const asyncRestoreMembership = Object.freeze({
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
  const exclusive = databaseSessionFor(db).engine.isolation === 'exclusive'
  if (exclusive) {
    return {
      appHome,
      catalog: composeSkillCatalog({
        db: db as unknown as DbClient,
        appHome,
        restoreMembership: syncRestoreMembership as never,
      }),
    }
  }
  const client = db as unknown as PostgresqlDatabaseClient
  return {
    appHome,
    catalog: composePostgresqlSkillCatalog({
      db: client,
      content: createPostgresqlSkillContentLifecycle({
        db: client,
        appHome,
        restoreMembership: asyncRestoreMembership as never,
      }),
      resourceCatalog: composeResourceCatalogFor({ db: db as never }),
    }),
  }
}
