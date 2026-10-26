// RFC-369 —— 「旧代被取代」判据的 SQL 形态，与 `domain/nodeRunSupersession.ts` 的纯函数逐格等价
// （对拍测试锁住）。两个引擎同一份 SQL：NULL 相等写成 `(a = b OR (a IS NULL AND b IS NULL))`。
//
// **只用在 SELECT 的 WHERE 里**：drizzle 在 UPDATE 里渲染外层列可能不带表名限定，相关子查询里的
// 外层列会误绑到内层 alias（设计门 r2 P3-2）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, exists, gt, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { alias } from '@/platform/persistence/tableAlias'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
type QueryBuilder = PersistenceDb | PersistenceTx

type NodeRunColumns = {
  readonly id: AnyColumn
  readonly seq: AnyColumn
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
  const { nodeRuns } = tablesOf(db)
  const newer = alias(nodeRuns, aliasName)
  return exists(
    (db as PersistenceDb)
      .select({ one: sql`1` })
      .from(newer)
      .where(
        and(
          eq(newer.recordMode, sql.raw("'executable'")),
          eq(newer.taskId, target.taskId),
          eq(newer.nodeId, target.nodeId),
          eq(newer.iteration, target.iteration),
          nullableEquals(newer.containerRunId, target.containerRunId),
          gt(newer.seq, target.seq),
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
  const { nodeRuns } = tablesOf(db)
  const parent = alias(nodeRuns, 'nr_superseded_parent')
  return or(
    and(isNull(nodeRuns.historicalParentId), newerGenerationExists(db, nodeRuns, 'nr_newer_self')),
    exists(
      (db as PersistenceDb)
        .select({ one: sql`1` })
        .from(parent)
        .where(
          and(
            eq(parent.id, nodeRuns.historicalParentId),
            isNull(parent.historicalParentId),
            newerGenerationExists(db, parent, 'nr_newer_parent'),
          ),
        ),
    ),
  )!
}
