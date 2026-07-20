// RFC-209 —— `workgroup_messages` 行的**唯一构造点**。
//
// 为什么需要它：房间消息有两个写入层——引擎的 `postMessage`（workgroupRunner）和路由里
// 五处**裸** `insert(workgroupMessages).values({...})`（routes/workgroupTasks.ts）。而
// `db/schema.ts` 上 `round` 是 `.notNull().default(0)`，所以路由那一层**省略 `round` 会静默
// 写 0**——正是 RFC-209 要消灭的那个 bug 本身，且没有任何类型信号，按字面量
// （`round: 0`）做的源码锁也抓不到「省略」这种形态。
//
// 这里把 `round` 定成**必填、无默认**，让「忘了带回合号」变成 typecheck 硬失败。
// 纯函数、无副作用，所以同步事务（确认门 / 取消卡）里也能用——round 在事务**外**
// 先 await 解析好再捕获进闭包即可。

import type { WorkgroupMessage } from '@agent-workflow/shared'
import type { workgroupMessages } from '@/db/schema'

export interface RoomMessageRowArgs {
  id: string
  taskId: string
  /**
   * **必填**：schema 的 `.default(0)` 会把「省略」静默变成 round 0（RFC-209 §1.3）。
   * lw 取写入时刻账本读数（`resolveMessageRound`）；fc 恒 0（该模式无回合语义）；
   * 两族例外——leader 轮自身产出取该轮 `wgRound`、派单卡族取 `assignment.round`。
   */
  round: number
  authorKind: WorkgroupMessage['authorKind']
  authorMemberId?: string | null
  authorUserId?: string | null
  kind: WorkgroupMessage['kind']
  bodyMd: string
  mentionMemberIds?: readonly string[]
  assignmentId?: string | null
  createdAt: number
}

export function buildRoomMessageRow(a: RoomMessageRowArgs): typeof workgroupMessages.$inferInsert {
  return {
    id: a.id,
    taskId: a.taskId,
    round: a.round,
    authorKind: a.authorKind,
    authorMemberId: a.authorMemberId ?? null,
    authorUserId: a.authorUserId ?? null,
    kind: a.kind,
    bodyMd: a.bodyMd,
    mentionsJson: JSON.stringify(a.mentionMemberIds ?? []),
    assignmentId: a.assignmentId ?? null,
    createdAt: a.createdAt,
  }
}
