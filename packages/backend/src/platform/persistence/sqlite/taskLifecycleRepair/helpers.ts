// RFC-057 — common SQLite query helpers shared between option modules.
// Living in a sibling file (not the engine entry) avoids cycles.

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import { isTaskActive } from '@/services/task'

import type { PreflightResult, RepairNodeRunRow } from './types'

/** RFC-097 (audit S-23): repair options that flip task status and/or
 * resumeAfterApply must refuse while an in-process scheduler loop owns the
 * task — a repair write would race the live driver (second scheduler kicked
 * under the first, or the live loop's own CAS clobbered). Returns the canned
 * unavailable PreflightResult, or null when no scheduler is attached.
 * Note for tests: harness-built tasks never sit in task.ts's activeTasks map,
 * so this gate only fires when a real runTask is attached (see
 * rfc097-repair-liveness.test.ts). */
export function schedulerLivenessGate(rc: { task: { id: string } }): PreflightResult | null {
  if (!isTaskActive(rc.task.id)) return null
  return {
    available: false,
    unavailableReasonKey: 'diagnose.repair.common.schedulerActive',
    previewSteps: [],
    ctx: {},
  }
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀第 2 步）：**投影在函数体内取**，不在模块顶层缓存。
 *
 * 这里原来是一个模块作用域的常量。它在 SQLite 上一直没事，因为求值时刻（模块加载）拿到的
 * 正好就是 SQLite 的列对象；本刀把这份修复实现放宽成中立句柄、让它也跑在 PostgreSQL 上之后，
 * 那个捕获就成了活风险：顶层常量会把 SQLite 的具体列对象带进 PG 查询，`bigint({mode:'number'})`
 * 的 mapper 整个丢失，数值列以**字符串**回到调用方——**不报错，只是结果错**
 *（RFC-359 W4-B4a / W4-D10 各撞过一次）。判据与守卫见
 * `rfc359-w5-t19f-toplevel-column-capture`。
 */
function nodeRunColumns() {
  return {
    id: nodeRuns.id,
    nodeId: nodeRuns.nodeId,
    status: nodeRuns.status,
    retryIndex: nodeRuns.retryIndex,
    reviewIteration: nodeRuns.reviewIteration,
    shardKey: nodeRuns.shardKey,
    iteration: nodeRuns.iteration,
  }
}

export async function loadNodeRun(
  db: ProviderNeutralDatabase,
  nodeRunId: string,
): Promise<RepairNodeRunRow | null> {
  const rows = await db
    .select(nodeRunColumns())
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  return rows[0] ?? null
}

// RFC-096: `loadNodeRunsForNode` was deleted — a dead export (zero call sites
// since its RFC-057 introduction) whose `desc(retryIndex)` ordering was one of
// the audit S-13 freshest-row forks.

export async function loadAllNodeRunsForTask(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<RepairNodeRunRow[]> {
  return db.select(nodeRunColumns()).from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
}

/** TERMINAL excluding 'done' — used by "the row got force-terminated by orphan
 * reap / shutdown and we want to bring it back to life" preflights. */
export const TERMINAL_NON_DONE = ['failed', 'canceled', 'interrupted', 'exhausted'] as const
export type TerminalNonDoneStatus = (typeof TERMINAL_NON_DONE)[number]

export function isTerminalNonDone(s: string): s is TerminalNonDoneStatus {
  return (TERMINAL_NON_DONE as readonly string[]).includes(s)
}
