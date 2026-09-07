// RFC-359 W7 —— realtime 持久化：一份实现，两个 provider 共用。
//
// 合一前是 `sqliteRealtimeStore.ts` / `postgresqlRealtimeStore.ts` 各 91 行，body **逐字节
// 相同**——只差注释首行、db 类型 import、类名与构造签名。纯重复，留着只会漂。
//
// 可以合成一份，判据与 RFC-350 的 `taskIdleTimeoutPersistence.ts` 同款：本 adapter 的四个方法
// （`findTaskAudience` / `findResource` / `findMemoryScope` / `listTaskEvents`）**全是只读
// select、没有任何事务**，SQLite 的 `dbTxSync` 与 PostgreSQL 的异步事务那道真正的分歧在这里
// 不存在；而 `DbClient` 与 `PostgresqlDatabaseClient` 都是 drizzle 的 `BaseSQLiteDatabase`
// （即 `ProviderNeutralDatabase`），同一套 query builder 在 `await` 下两边行为一致。
//
// 于是 provider 一致性在**结构上**成立，而不是靠纸面对账。行为侧另有
// `tests/rfc359-w7-realtime-store-conformance.test.ts` 把这四个方法在两个引擎上各跑一遍
// ——合一之前这一对是「无对拍」的，那份对拍本身就是合一换来的。

import { and, asc, eq, gt } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  memories,
  nodeRunEvents,
  nodeRuns,
  taskCollaborators,
  tasks,
  workflows,
  workgroups,
} from '@/db/schema'
import type {
  RealtimeAclResourceType,
  RealtimeResourceRow,
  RealtimeStore,
} from '../application/ports/realtimeStore'

export class DrizzleRealtimeStore implements RealtimeStore {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async findTaskAudience(taskId: string, userId: string) {
    const taskRows = await this.db
      .select({ ownerUserId: tasks.ownerUserId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (task === undefined) return null
    const memberships = await this.db
      .select({ userId: taskCollaborators.userId })
      .from(taskCollaborators)
      .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
      .limit(1)
    return { ownerUserId: task.ownerUserId, member: memberships.length > 0 }
  }

  async findResource(
    type: RealtimeAclResourceType,
    resourceId: string,
  ): Promise<RealtimeResourceRow | null> {
    if (type === 'workflow') {
      const rows = await this.db
        .select({
          id: workflows.id,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(eq(workflows.id, resourceId))
        .limit(1)
      return rows[0] ?? null
    }
    const rows = await this.db
      .select({
        id: workgroups.id,
        ownerUserId: workgroups.ownerUserId,
        visibility: workgroups.visibility,
      })
      .from(workgroups)
      .where(eq(workgroups.id, resourceId))
      .limit(1)
    return rows[0] ?? null
  }

  async findMemoryScope(memoryId: string) {
    const rows = await this.db
      .select({ scopeType: memories.scopeType, scopeId: memories.scopeId })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1)
    return rows[0] ?? null
  }

  async listTaskEvents(taskId: string, since: number) {
    return await this.db
      .select({
        id: nodeRunEvents.id,
        nodeRunId: nodeRunEvents.nodeRunId,
        ts: nodeRunEvents.ts,
        kind: nodeRunEvents.kind,
        payload: nodeRunEvents.payload,
      })
      .from(nodeRunEvents)
      .innerJoin(nodeRuns, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
      .where(and(eq(nodeRuns.taskId, taskId), gt(nodeRunEvents.id, since)))
      .orderBy(asc(nodeRunEvents.id))
  }
}
