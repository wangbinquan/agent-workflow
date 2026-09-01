// RFC-209 — 工作组「回合账本」的单一事实源。
//
// 背景：`countBudgetUsed` 同时扮演两个角色——① `max_rounds` 的**预算表**，
// ② 房间里「第 X 回合」的**显示序数**。这两件事在 free_collab 下根本不是同一个东西
// （fc 分支返回的是成员 run 累计行数，与「回合」无关，见 design/RFC-164 §4.4
// 「硬顶 成员 run 总数 > max_rounds」），于是房间里出现 0→3→5→8 的跳号。
// RFC-209 把推导抽到这里，让三方读同一个数：
//   - 引擎（唤醒判定 / 触顶 / 宽限收尾轮）—— workgroupRunner.countBudgetUsed
//   - 写入侧（消息 round）—— resolveMessageRound
//   - 房间聚合（右栏预算表）—— GET /room 的 budgetUsed
//
// ⚠️ 初始化环（RFC-209 design §2.1）：本模块经
// `workgroupLaunch → services/task → scheduler → workgroupRunner` 处在一个**已存在**的
// import 环里，而 `.dependency-cruiser.cjs` 没有 `no-circular` 规则、`bun test` 与
// typecheck 都抓不到。因此 `WG_*_NODE_ID` 只允许在**函数体内**引用——任何由它派生的
// 顶层 const 都可能在不巧的初始化序下求值成 `undefined`，把账本静默清零
// （RFC-079 先例：这类问题只有 `bun run build:binary` 能抓到）。

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { WorkgroupMode, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import type { EngineDbState } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/state'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { withTaskExecutionMutation } from '@/services/taskExecutionParticipants'
import {
  deriveBudgetUsed,
  roundedModeOf,
  type RoundLedgerRow,
  type RoundedWorkgroupMode,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
export {
  deriveBudgetUsed,
  roundedModeOf,
  type RoundLedgerRow,
  type RoundedWorkgroupMode,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
import {
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroup/constants'

/**
 * 账本行的轻量读取（六列投影）。过滤条件与引擎 `loadDbState` 的 host-run 加载逐字相同
 * （task + `nodeId IN (leader, member)`），所以路由侧与引擎侧读到的是同一个数。
 */
export async function readRoundLedgerRows(db: DbClient, taskId: string): Promise<RoundLedgerRow[]> {
  return db
    .select({
      id: nodeRuns.id,
      nodeId: nodeRuns.nodeId,
      shardKey: nodeRuns.shardKey,
      status: nodeRuns.status,
      rerunCause: nodeRuns.rerunCause,
      wgRound: nodeRuns.wgRound,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        inArray(nodeRuns.nodeId, [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID]),
      ),
    )
}

/**
 * 一条消息**写入时刻**应带的 `round`。
 *
 * lw：账本读数。注意这是**正在进行的那一轮**而非已完成轮数——`driveLeaderTurn` 在
 * `runHostNode` 之前就把本轮的行连 `wgRound` 落库了（RFC-209 design §1.8）。房间里的人在
 * leader 跑动中发言，消息就该落在这一轮下面，正是想要的语义。
 *
 * fc：**恒 0，且不查库**（RFC-209 D10）。自由协作没有全局回合，把预算计数器写进 `round` 列
 * 等于把本 RFC 自己认定的类别错误存进库；恒 0 即「此模式无回合」。
 */
export async function resolveMessageRound(
  db: DbClient,
  taskId: string,
  mode: RoundedWorkgroupMode,
): Promise<number> {
  if (mode === 'free_collab') return 0
  return deriveBudgetUsed(mode, await readRoundLedgerRows(db, taskId))
}

/**
 * 路由层入口：直接吃完整的 `WorkgroupMode`。`dynamic_workflow` 没有回合账本（也没有聊天室），
 * 返回 0 而不是让它落进某个回合分支。
 */
export async function resolveRoomMessageRound(
  db: DbClient,
  taskId: string,
  mode: WorkgroupMode,
): Promise<number> {
  const rounded = roundedModeOf(mode)
  return rounded === null ? 0 : resolveMessageRound(db, taskId, rounded)
}

/** 引擎侧的账本模式。dynamic_workflow 到不了回合引擎（见 countBudgetUsed 注释）。 */
/**
 * RFC-217 T3 (AC-5) — the round-engine mode, FAIL-LOUD. dynamic_workflow can
 * never reach the round engine (scheduler dispatches it to the dw engines);
 * the old `?? 'free_collab'` silently mis-billed a mis-dispatched dw task as
 * fc. Throwing surfaces the dispatch bug at its first touch instead.
 */
export function roundMode(config: WorkgroupRuntimeConfig): RoundedWorkgroupMode {
  const mode = roundedModeOf(config.mode)
  if (mode === null) {
    throw new Error(`round engine reached with non-rounded mode '${config.mode}' (dispatch bug)`)
  }
  return mode
}

export function countBudgetUsed(state: EngineDbState): number {
  // RFC-217 T3 (AC-5)：经 roundMode fail-loud——误派 dw 任务在这里立刻炸响，
  // 而不是被静默按 fc 计费（旧 `?? 'free_collab'` 兜底已删）。
  return deriveBudgetUsed(roundMode(state.config), state.hostRuns)
}

export function currentRound(state: EngineDbState): number {
  return countBudgetUsed(state)
}

/**
 * RFC-189 — stamp an ADOPTED host row's round in place (rows minted outside the
 * engine — clarify-answer reruns / crash leftovers — carry no ordinal). Plain
 * column update: wg_round is accounting metadata, not a lifecycle column (no
 * CAS surface); `WHERE wg_round IS NULL` keeps re-drives idempotent.
 */
export async function stampWgRound(
  db: DbClient,
  nodeRunId: string,
  wgRound: number,
): Promise<void> {
  const taskId = db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .get()?.taskId
  if (taskId === undefined) return
  withTaskExecutionMutation({
    db,
    taskId,
    run: (tx) =>
      tx
        .update(nodeRuns)
        .set({ wgRound })
        .where(and(eq(nodeRuns.id, nodeRunId), isNull(nodeRuns.wgRound)))
        .run(),
  })
}
