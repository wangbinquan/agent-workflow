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
import { monotonicFactory } from 'ulid'
import type { DbClient } from '@/db/client'
import type { WorkgroupAssignment } from '@agent-workflow/shared'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import {
  resolveMessageRound,
  roundMode,
  type RoundedWorkgroupMode,
} from '@/services/workgroup/rounds'
import { memberDisplayName } from '@/services/workgroup/context'
import type { WgMessageItem, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { workgroupMessages } from '@/db/schema'

const nextMessageId = monotonicFactory()

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

// ---------------------------------------------------------------------------
// RFC-217 T3 — engine-side room message IO (moved verbatim from runner.ts).
// ---------------------------------------------------------------------------

export interface PostMessageArgs {
  /**
   * RFC-209 §2.3 —— **省略 = 写入时刻实时解析**（lw 取账本读数、fc 恒 0）。极性是有意的：
   * 默认就是正确行为，漏改点得到的是对的值而不是 round 0 那种硬错。
   * 只有两族显式传值：leader 轮自身产出（用该轮 `wgRound`——这一轮由它定义，账本此刻
   * 还没计入它）与派单卡族（走 {@link postAssignmentMessage}，用 `assignment.round`）。
   */
  round?: number
  authorKind: 'member' | 'human' | 'system'
  authorMemberId?: string | null
  kind: WorkgroupMessage['kind']
  bodyMd: string
  mentionMemberIds?: string[]
  assignmentId?: string | null
}

export async function postMessage(
  db: DbClient,
  taskId: string,
  mode: RoundedWorkgroupMode,
  m: PostMessageArgs,
): Promise<string> {
  // RFC-209 §2.3-2 —— round 必须在 nextMessageId() **之前**解析。在铸 id 与 insert 之间
  // 新增一个 await 会加宽「同毫秒两条消息按 ULID 乱序」的窗口，而上面的 monotonicFactory
  // 正是 RFC-186 §3-4 为消除它才引入的。顺序恒为：解析 round → 铸 id → 插入。
  const round = m.round ?? (await resolveMessageRound(db, taskId, mode))
  const id = nextMessageId()
  await db.insert(workgroupMessages).values(
    buildRoomMessageRow({
      id,
      taskId,
      round,
      authorKind: m.authorKind,
      authorMemberId: m.authorMemberId ?? null,
      authorUserId: null,
      kind: m.kind,
      bodyMd: m.bodyMd,
      mentionMemberIds: m.mentionMemberIds,
      assignmentId: m.assignmentId ?? null,
      createdAt: Date.now(),
    }),
  )
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'wg.message.created',
    messageId: id,
    kind: m.kind,
  })
  return id
}

/**
 * 派单卡族（结果 / 失败 / 交付 / 取消）专用入口：`round` 恒取 `assignment.round`，
 * **不接受省略**。这一族的账本读数在定义上就是错答案——轮 2 派出、轮 7 才收工的长跑
 * worker，其结果消息若标成 round 7 就与它的派单卡脱钩，还会抢在 leader 轮 7 自己的产出
 * 之前插一条「第 7 回合」。所以它不适用 {@link PostMessageArgs.round} 的「省略即兜底」极性
 * （RFC-209 D13）。
 */
export async function postAssignmentMessage(
  db: DbClient,
  taskId: string,
  mode: RoundedWorkgroupMode,
  assignment: Pick<WorkgroupAssignment, 'id' | 'round'>,
  m: Omit<PostMessageArgs, 'round' | 'assignmentId'>,
): Promise<string> {
  return postMessage(db, taskId, mode, {
    ...m,
    round: assignment.round,
    assignmentId: assignment.id,
  })
}

/**
 * RFC-209 §2.3-1 —— `round` 在这里**必填**（它是中间位参，`round?: number` 后跟必填参数
 * 是 TS1016）。同一轮产出的 N 条消息必须共享同一个回合号，所以由调用方解析一次传进来，
 * 而不是逐条走 `postMessage` 的省略路径（那会变成每条一次 SELECT，且可能拿到不同的值）。
 */
export async function persistWgMessages(
  db: DbClient,
  taskId: string,
  config: WorkgroupRuntimeConfig,
  round: number,
  authorMemberId: string,
  items: readonly WgMessageItem[],
  allow: { allowDirect: boolean; allowBlackboard: boolean },
): Promise<void> {
  const mode = roundMode(config)
  let dropped = 0
  for (const item of items) {
    if (item.to === null) {
      if (!allow.allowBlackboard && !allow.allowDirect) {
        dropped++
        continue
      }
      await postMessage(db, taskId, mode, {
        round,
        authorKind: 'member',
        authorMemberId,
        kind: 'chat',
        bodyMd: item.body,
      })
      continue
    }
    if (!allow.allowDirect) {
      dropped++
      continue
    }
    const target = config.members.find((m) => m.displayName === item.to)
    if (target === undefined) {
      dropped++
      continue
    }
    await postMessage(db, taskId, mode, {
      round,
      authorKind: 'member',
      authorMemberId,
      kind: 'chat',
      bodyMd: `@${item.to} ${item.body}`,
      mentionMemberIds: [target.id],
    })
  }
  if (dropped > 0) {
    await postMessage(db, taskId, mode, {
      round,
      authorKind: 'system',
      kind: 'system',
      bodyMd: `${dropped} message(s) from @${memberDisplayName(config, authorMemberId)} dropped (visibility switches)`,
    })
  }
}

/** RFC-182 D6 — pending visibility: a mint alone broadcasts nothing (the first
 *  frame used to be runNode's `running`), so a turn queued behind the global
 *  semaphore was invisible to the room — presence said "idle" while work was
 *  already committed. One frame per FRESH mint (adopted rows were announced at
 *  their own mint site — taskQuestionDispatch); `node.status` already
 *  invalidates the room key client-side (f55ede4b), zero new WS rules. */
export function broadcastPendingMint(taskId: string, nodeRunId: string, nodeId: string): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status: 'pending',
  })
}
