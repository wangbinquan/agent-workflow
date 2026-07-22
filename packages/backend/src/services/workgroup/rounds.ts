// RFC-209 — 工作组「回合账本」的单一事实源。
//
// 背景：`countRoundsUsed` 同时扮演两个角色——① `max_rounds` 的**预算表**，
// ② 房间里「第 X 回合」的**显示序数**。这两件事在 free_collab 下根本不是同一个东西
// （fc 分支返回的是成员 run 累计行数，与「回合」无关，见 design/RFC-164 §4.4
// 「硬顶 成员 run 总数 > max_rounds」），于是房间里出现 0→3→5→8 的跳号。
// RFC-209 把推导抽到这里，让三方读同一个数：
//   - 引擎（唤醒判定 / 触顶 / 宽限收尾轮）—— workgroupRunner.countRoundsUsed
//   - 写入侧（消息 round）—— resolveMessageRound
//   - 房间聚合（右栏预算表）—— GET /room 的 roundsUsed
//
// ⚠️ 初始化环（RFC-209 design §2.1）：本模块经
// `workgroupLaunch → services/task → scheduler → workgroupRunner` 处在一个**已存在**的
// import 环里，而 `.dependency-cruiser.cjs` 没有 `no-circular` 规则、`bun test` 与
// typecheck 都抓不到。因此 `WG_*_NODE_ID` 只允许在**函数体内**引用——任何由它派生的
// 顶层 const 都可能在不巧的初始化序下求值成 `undefined`，把账本静默清零
// （RFC-079 先例：这类问题只有 `bun run build:binary` 能抓到）。

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { WorkgroupMode, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import type { EngineDbState } from '@/services/workgroup/state'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { isClarifyRerunCause } from '@/services/nodeRunMint'
import { WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID } from '@/services/workgroup/constants'

/** 账本推导所需的最小 node_runs 投影。 */
export interface RoundLedgerRow {
  id: string
  nodeId: string
  shardKey: string | null
  status: string
  rerunCause: string | null
  wgRound: number | null
}

/**
 * 有回合引擎的两种模式。`dynamic_workflow` 走生成→确认→执行、没有回合账本，
 * 故意排除在外——否则它会静默落进 fc 分支拿到一个成员 run 计数（RFC-209 对抗门 P2）。
 */
export type RoundedWorkgroupMode = 'leader_worker' | 'free_collab'

/**
 * `WorkgroupMode` → 回合账本模式。`dynamic_workflow` 走生成→确认→执行
 * （`dynamicWorkflowRunner`，由 `deriveWorkgroupDispatch` 分流），**没有**回合账本，
 * 故返回 `null` 让调用方显式处理「不适用」——而不是静默落进 fc 分支拿一个
 * 成员 run 计数当回合数（RFC-209 对抗门 P2）。
 */
export function roundedModeOf(mode: WorkgroupMode): RoundedWorkgroupMode | null {
  return mode === 'leader_worker' || mode === 'free_collab' ? mode : null
}

/**
 * RFC-209 T7 —— 已被取代的「被重启杀死的反问续跑」行 id 集合。
 *
 * `reviveKilledClarifyContinuations`（workgroupRunner）会为被重启杀死的反问续跑重铸一行，
 * 但被杀的前身行状态是 `interrupted`（**不是** `canceled`），两行于是同时进账本：
 *   - lw：两行都落进 `max(wg_round)` 之外的 NULL 尾巴 ⇒ 同一逻辑回合被数两次（回合号跳 1）；
 *   - fc：两行都被行计数计入 ⇒ 一个逻辑轮吃掉 2 格预算，而 fc 的 max_rounds 是硬杀。
 *
 * 在**派生层**排除（而不是给行打 `wg_round` 戳）是有意的：fc 分支根本不读 `wg_round`，
 * 打戳对 fc 是 no-op；且往 `__wg_member__` 行写非 NULL 的 `wg_round` 会违反 RFC-189
 * 「fc 成员行 wgRound 恒 NULL」的契约并经 NodeDetailDrawer 显示出来。零写入的排除对两种模式
 * 同时成立，且 NULL 尾巴有多条时也自然正确。
 *
 * 分组键与 `reviveKilledClarifyContinuations` 逐字一致（nodeId + shardKey）：只有**被更晚的行
 * 取代**的才排除；尚未被 revive 的被杀行仍计入，保持既有语义不变。
 */
function supersededKilledClarifyIds(rows: readonly RoundLedgerRow[]): Set<string> {
  const groupKey = (r: RoundLedgerRow): string => `${r.nodeId}\x00${r.shardKey ?? ''}`
  const maxIdByGroup = new Map<string, string>()
  for (const r of rows) {
    const key = groupKey(r)
    const cur = maxIdByGroup.get(key)
    if (cur === undefined || r.id > cur) maxIdByGroup.set(key, r.id)
  }
  const out = new Set<string>()
  for (const r of rows) {
    if (r.status !== 'interrupted' || !isClarifyRerunCause(r.rerunCause)) continue
    if ((maxIdByGroup.get(groupKey(r)) ?? r.id) > r.id) out.add(r.id)
  }
  return out
}

/**
 * 已用回合数 —— 与 `max_rounds` 触顶判据同源。
 *
 * lw：RFC-189 的**已打戳序数**口径 `max(wg_round)` + NULL 尾巴。NULL 尾巴保留是因为引擎
 * **外**铸的 host 行（clarify-answer 续跑 / 崩溃残留）在被领养打戳之前没有序数，每条这样的
 * 合格行就是一个已开始的回合。`wg-gate`（确认门 holder）与 `wg-protocol-retry`（同一逻辑轮的
 * 重试）不算新回合。
 *
 * fc：按设计保持**行计数**（RFC-189 §1 修订：并发 mint 会让序数重复，fc 没有序数可读）。
 * 每个成员 run 消耗一格预算。
 *
 * 除 {@link supersededKilledClarifyIds} 的排除外，返回值与 RFC-209 之前的
 * `countRoundsUsed` 逐值相同（互 oracle 测试锁）。
 */
export function deriveRoundsUsed(
  mode: RoundedWorkgroupMode,
  rows: readonly RoundLedgerRow[],
): number {
  const superseded = supersededKilledClarifyIds(rows)
  if (mode === 'leader_worker') {
    let max = 0
    let nullQualifying = 0
    for (const r of rows) {
      if (r.nodeId !== WG_LEADER_NODE_ID || r.status === 'canceled') continue
      if (superseded.has(r.id)) continue
      if (r.wgRound !== null) {
        if (r.wgRound > max) max = r.wgRound
      } else if (r.rerunCause !== 'wg-gate' && r.rerunCause !== 'wg-protocol-retry') {
        nullQualifying++
      }
    }
    return max + nullQualifying
  }
  return rows.filter(
    (r) =>
      r.nodeId === WG_MEMBER_NODE_ID &&
      r.status !== 'canceled' &&
      // 2026-07-21（T3B 实测回归）—— `interrupted` 的 fc 成员行不计费。
      // orphan reap 自己定义它是「安全默认 → auto-RESUME」（orphanReconcile.ts:8）：
      // 语义上没跑完、注定由重派/重跑行接手，重跑行照常计 1 格；若被杀前身也计入，
      // 同一逻辑消耗就被双重计费。与 `wg-protocol-retry` 的豁免同构（方向相反：
      // 协议重试豁免**重试行**、这里豁免**前身行**——都保证一次逻辑消耗只计一次）。
      // 实测（任务 01KY25DM…10B1）：daemon 反复重启把 33/160 = 20.6% 预算烧在
      // interrupted 前身行上，直接把任务逼进 max-rounds-wrapup 假触顶。
      // lw 分支**故意不动**：lw 走 max(wg_round)+NULL 尾口径，重跑同轮对 max 天然
      // 免疫；NULL 尾的被杀行双计已由 supersededKilledClarifyIds 处理（RFC-209 T7），
      // 「未被取代的 NULL 尾计入」是 rfc209-round-ledger.test.ts 锁定的既有裁定，
      // 改它需要独立的 lw 实测证据。
      r.status !== 'interrupted' &&
      r.rerunCause !== 'wg-protocol-retry' &&
      !superseded.has(r.id),
  ).length
}

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
  return deriveRoundsUsed(mode, await readRoundLedgerRows(db, taskId))
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

/** 引擎侧的账本模式。dynamic_workflow 到不了回合引擎（见 countRoundsUsed 注释）。 */
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

export function countRoundsUsed(state: EngineDbState): number {
  // RFC-217 T3 (AC-5)：经 roundMode fail-loud——误派 dw 任务在这里立刻炸响，
  // 而不是被静默按 fc 计费（旧 `?? 'free_collab'` 兜底已删）。
  return deriveRoundsUsed(roundMode(state.config), state.hostRuns)
}

export function currentRound(state: EngineDbState): number {
  return countRoundsUsed(state)
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
  await db
    .update(nodeRuns)
    .set({ wgRound })
    .where(and(eq(nodeRuns.id, nodeRunId), isNull(nodeRuns.wgRound)))
}
