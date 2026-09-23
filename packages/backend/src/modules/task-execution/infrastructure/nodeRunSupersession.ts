// RFC-369 —— 「旧代被取代」判据的 SQL 形态，与 `domain/nodeRunSupersession.ts` 的纯函数逐格等价
// （对拍测试锁住）。两个引擎同一份 SQL：NULL 相等写成 `(a = b OR (a IS NULL AND b IS NULL))`。
//
// **只用在 SELECT 的 WHERE 里**：drizzle 在 UPDATE 里渲染外层列可能不带表名限定，相关子查询里的
// 外层列会误绑到内层 alias（设计门 r2 P3-2）。

import { and, eq, exists, gt, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

type QueryBuilder = ProviderNeutralDatabase | DatabaseTransaction

type NodeRunColumns = {
  readonly id: AnyColumn
  readonly taskId: AnyColumn
  readonly nodeId: AnyColumn
  readonly iteration: AnyColumn
  readonly containerRunId: AnyColumn
  readonly shardKey: AnyColumn
}

function nullableEquals(left: AnyColumn, right: AnyColumn): SQL {
  return sql`(${left} = ${right} OR (${left} IS NULL AND ${right} IS NULL))`
}

/** 同帧存在更新一代（design §3 (a) 的 EXISTS 部分），`target` 是被判定的那一行。 */
function newerGenerationExists(db: QueryBuilder, target: NodeRunColumns, aliasName: string): SQL {
  const newer = alias(nodeRuns, aliasName)
  return exists(
    (db as ProviderNeutralDatabase)
      .select({ one: sql`1` })
      .from(newer)
      .where(
        and(
          eq(newer.taskId, target.taskId),
          eq(newer.nodeId, target.nodeId),
          eq(newer.iteration, target.iteration),
          nullableEquals(newer.containerRunId, target.containerRunId),
          gt(newer.id, target.id),
          or(isNull(newer.shardKey), eq(newer.shardKey, target.shardKey)),
        ),
      ),
  )
}

/**
 * 外层 `nodeRuns` 这一行被结构性取代（design §3）：
 *   (a) 它是顶层行且同帧有更新一代；或
 *   (b) 它的父行是顶层行且同帧有更新一代。
 */
export function structurallySupersededCondition(db: QueryBuilder): SQL {
  const parent = alias(nodeRuns, 'nr_superseded_parent')
  return or(
    and(isNull(nodeRuns.parentNodeRunId), newerGenerationExists(db, nodeRuns, 'nr_newer_self')),
    exists(
      (db as ProviderNeutralDatabase)
        .select({ one: sql`1` })
        .from(parent)
        .where(
          and(
            eq(parent.id, nodeRuns.parentNodeRunId),
            isNull(parent.parentNodeRunId),
            newerGenerationExists(db, parent, 'nr_newer_parent'),
          ),
        ),
    ),
  )!
}
