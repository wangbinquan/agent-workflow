import { createContentPublicationLedger } from '@/platform/content/infrastructure/contentStore'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq, sql } from 'drizzle-orm'
import type { TaskDeletionParticipant } from '../application/ports/taskDeletion'
import { lockTaskAggregateRoots, taskAggregateWrite } from './taskDefinitionWriteParticipant'

export function createTaskDeletionParticipantInTx(tx: PersistenceTx): TaskDeletionParticipant {
  const { tasks } = tablesOf(tx)
  return {
    async status(taskId) {
      return (
        await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
      )[0]
    },
    async cascade(taskId) {
      const rows = (await rawRows(
        tx,
        sql`
        WITH RECURSIVE cascade(id) AS (
          SELECT id FROM tasks WHERE id = ${taskId}
          UNION
          SELECT child.id
          FROM tasks child
          JOIN cascade parent ON child.parent_task_id = parent.id
        )
        SELECT t.id, t.owner_user_id
        FROM tasks t
        JOIN cascade c ON c.id = t.id
      `,
      )) as Array<{ id: string; owner_user_id: string | null }>

      const ancestors = await rawRows<{ id: string }>(
        tx,
        sql`
        WITH RECURSIVE ancestors(id, parent_task_id) AS (
          SELECT id, parent_task_id FROM tasks WHERE id = ${taskId}
          UNION
          SELECT parent.id, parent.parent_task_id FROM tasks parent
            JOIN ancestors child ON parent.id = child.parent_task_id
        ) SELECT id FROM ancestors
      `,
      )
      await lockTaskAggregateRoots(tx, [
        ...rows.map((row) => row.id),
        ...ancestors.map((row) => row.id),
      ])
      return rows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id }))
    },
    async deleteRoot(taskId) {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
      const descendants = await rawRows<{ id: string }>(
        tx,
        sql`
        WITH RECURSIVE deleted_tasks(id) AS (
          SELECT id FROM tasks WHERE id = ${taskId}
          UNION SELECT child.id FROM tasks child JOIN deleted_tasks parent ON child.parent_task_id = parent.id
        ) SELECT id FROM deleted_tasks
      `,
      )
      const publications = createContentPublicationLedger(tx)
      for (const { id } of descendants)
        for (const owner of ['node-run-output', 'node-run-prompt'])
          await publications.release(tx, { owner, scope: id }, Date.now())
      await tx.delete(tasks).where(eq(tasks.id, taskId))
    },
    async recomputeAncestors(parentTaskId) {
      // RFC-311 实现门 P1-6/P2-3:`branch_started_at` 是「子树 max(started_at)」的
      // 物化值,此前只有铸行点向上推进(单调 MAX),删掉一个子任务后父行会**永久**
      // 停在被删子树的时间戳上。可观察后果:同一份数据在默认视图(快路径按物化列
      // 排序)与任一过滤视图(旧管线现算)之间行序不同且永不收敛。
      // 删除是低频操作,在同一事务里沿父链重算即可闭合(链长同 MAX_TREE_DEPTH)。
      // RFC-359 W6-T28：重算是读—改—写（父自己的 started_at + 子树 MAX 算出新值写回同一行），
      // 而每任务写锁按**被删的那个** taskId 分片——同一个父下的两个兄弟被同时删掉时，两笔删除
      // 拿的是两把不同的锁，彼此完全不串行。PG 的 READ COMMITTED 下双方都会读到「对方还在」的
      // 子树 MAX，后写的那笔于是把父行永久停在一个**已删子树**的时间戳上，正是上面这段注释要
      // 闭合的那个 bug 换了个入口复发。先锁住父行：第二笔在锁上等，等到的是对方已提交的视图。
      // cascade 已按 id 排序锁住整棵删除子树与祖先；这里重用那些根锁。
      let cursor: string | null = parentTaskId
      for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
        await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, cursor)
        const parent = (
          await tx
            .select({
              id: tasks.id,
              parentTaskId: tasks.parentTaskId,
              startedAt: tasks.startedAt,
            })
            .from(tasks)
            .where(eq(tasks.id, cursor))
            .limit(1)
        )[0]
        if (parent === undefined) break
        const childMax = (
          await tx
            .select({ v: sql<number>`coalesce(max(${tasks.branchStartedAt}), 0)`.mapWith(Number) })
            .from(tasks)
            .where(eq(tasks.parentTaskId, parent.id))
            .limit(1)
        )[0]
        const recomputed = Math.max(parent.startedAt ?? 0, childMax?.v ?? 0)
        await tx.update(tasks).set({ branchStartedAt: recomputed }).where(eq(tasks.id, parent.id))
        cursor = parent.parentTaskId
      }
    },
  }
}
