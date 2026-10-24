// RFC-359 W7 —— realtime 持久化：一份实现，两个 provider 共用。
//
// 合一前是 `sqliteRealtimeStore.ts` / `postgresqlRealtimeStore.ts` 各 91 行，body **逐字节
// 相同**——只差注释首行、db 类型 import、类名与构造签名。纯重复，留着只会漂。
//
// 可以合成一份，判据与 RFC-350 的 `taskIdleTimeoutPersistence.ts` 同款：本 adapter 的四个方法
// （`findTaskAudience` / `findResource` / `findMemoryScope` / `listTaskEvents`）**全是只读
// select、没有任何事务**，SQLite 的 `dbTxSync` 与 PostgreSQL 的异步事务那道真正的分歧在这里
// 不存在；而 `DbClient` 与 `PostgresqlDatabaseClient` 都是 drizzle 的 `PersistenceDb`
// （即 `PersistenceDb`），同一套 query builder 在 `await` 下两边行为一致。
//
// 于是 provider 一致性在**结构上**成立，而不是靠纸面对账。行为侧另有
// `tests/rfc359-w7-realtime-store-conformance.test.ts` 把这四个方法在两个引擎上各跑一遍
// ——合一之前这一对是「无对拍」的，那份对拍本身就是合一换来的。

import { isTaskDefinitionHostId } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { RealtimeTaskFactsPort, RealtimeResourceAclPort } from '../composition/required-ports'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  RealtimeAclResourceType,
  RealtimeResourceRow,
  RealtimeStore,
} from '../application/ports/realtimeStore'

export class DrizzleRealtimeStore implements RealtimeStore {
  constructor(
    private readonly db: PersistenceDb,
    private readonly taskFacts: RealtimeTaskFactsPort,
    private readonly resources: RealtimeResourceAclPort,
  ) {}

  findTaskAudience(taskId: string, userId: string) {
    return this.taskFacts.taskAudience(taskId, userId)
  }

  async findResource(
    type: RealtimeAclResourceType,
    resourceId: string,
  ): Promise<RealtimeResourceRow | null> {
    if (type === 'workflow' && isTaskDefinitionHostId(resourceId)) return null
    return this.resources.find(type, resourceId)
  }

  async findMemoryScope(memoryId: string) {
    const { memories } = tablesOf(this.db)
    const rows = await this.db
      .select({ scopeType: memories.scopeType, scopeId: memories.scopeId })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1)
    return rows[0] ?? null
  }

  listTaskEvents(taskId: string, since: number) {
    return this.taskFacts.taskEventsSince(taskId, since)
  }
}
