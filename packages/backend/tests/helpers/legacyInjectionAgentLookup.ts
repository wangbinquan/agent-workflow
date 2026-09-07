// RFC-359 W8 —— `legacyTaskExecutionInjectionResolver.ts` 这份 RFC-349 行为神谕的 agent 查询绑定。
//
// 它此前住在被神谕的那个 src 文件里，叫 `createSqliteLegacyAgentDependencyLookup`，并自陈
// 「Explicit SQLite test/compatibility binding. Production provider sessions inject their
// Resource Catalog lookup instead of reaching this factory.」——也就是说它**从来只有测试在调**：
// 生产的注入解析走 `services/execution/taskExecutionResources.ts::resolveTaskExecutionInjection`
// （具名 Resource Catalog participant）。`tests/architecture/rfc359-w5-adapter-production-consumer.test.ts`
// 把它记成零生产消费者的 provider 适配器，本波按「适配器不许留在 src 装成 provider 对等」清理：
// 神谕本体（`resolveInjection`）仍在 src 等它整体退役，这个纯测试绑定搬到测试侧。
//
// 行为逐字不变：同一条 `select … from agents where id = ? limit 1` + 同一个行映射器。

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { agents as agentRows } from '@/db/schema'
import type { AgentDependencyLookup } from '@/services/agentDeps'
import { taskExecutionResourceDependencies } from '@/services/execution/taskExecutionResourceDependencies'

export function legacyInjectionAgentLookup(db: DbClient): AgentDependencyLookup {
  return Object.freeze({
    async get(id: string) {
      const rows = await db.select().from(agentRows).where(eq(agentRows.id, id)).limit(1)
      return rows[0] === undefined ? null : taskExecutionResourceDependencies.rowToAgent(rows[0])
    },
  })
}
