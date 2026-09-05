// RFC-359 W4-D4 —— 测试用的 memory 目录装配：生产同一份（中立目录 + identity-access 夹具上下文 +
// resource-catalog 的 scope 访问 participant），不是 stub。
//
// 旧的 `services/memory` 函数式面（`createManualCandidate(db, …)` 一类）随 SQLite 专属目录一起退役，
// 用例改经 `MemoryCatalogOperations` 合同——与路由 / MCP 面走的是同一条路。

import type { DbClient } from '../../src/db/client'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import {
  composeMemoryCatalogOperations,
  type MemoryCatalogTestHooks,
} from '../../src/modules/memory/composition'
import type { MemoryCatalogOperations } from '../../src/modules/memory/public/catalog'
import { TEST_RESOURCE_SCOPE_AUTHORIZATION } from './resourceScopeAuthority'

export function memoryCatalogOf(
  db: DbClient,
  testHooks?: MemoryCatalogTestHooks,
): MemoryCatalogOperations {
  return composeMemoryCatalogOperations({
    db,
    contexts: composeIdentityAccess(db).contexts,
    authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
    ...(testHooks === undefined ? {} : { testHooks }),
  })
}
