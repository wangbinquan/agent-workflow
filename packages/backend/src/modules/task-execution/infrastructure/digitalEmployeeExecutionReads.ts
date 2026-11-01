// RFC-414 — the digital employee execution's two database reads, moved verbatim from
// composition/digitalEmployeeExecution.ts: the plan human-review gate snapshot (tasks.inputs + the review node run)
// and the execution metadata (round reference, auto-recovery suspension). The composition binds them into the
// execution core's ports.
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DigitalEmployeeHumanReviewCoreSnapshot } from '../application/ports/digitalEmployeeExecutionCore'
import {
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
} from '../domain/digitalEmployeeHost'
import { createNodeRunQueries } from './nodeRunQueries'
import { taskReadColumns } from './taskRepositorySql'

/**
 * 数字员工「计划人审」闸门的对外状态。
 *
 * RFC-359：这一条曾经是**同步**的、且只有 SQLite 那侧的 composition 提供——
 * `composeDigitalEmployeeExecution` 根本没有实现 `inspectHumanReview`，于是
 * PostgreSQL 上这个闸门永远退回按 round 状态推断，**报不出 `waiting`**：同一个案子在 SQLite 上
 * 显示「等待人审」，在 PG 上显示「规划中」。这是用户可见的行为分叉，也正是本 RFC 要消灭的形态。
 * 现在改成 async 的一份中立实现（查的是 `tasks` + `nodeRuns`，本来就没有方言），两侧 composition
 * 都装它。
 */
/**
 * RFC-368 —— 人审闸门的**六态**快照。今天那三个 `null` 来源在这里拆开：
 *   ① 执行行不在 / ② 输入不可解析 ⇒ `unknown`（投影端保留 round-state 回落）；
 *   ③ 输入里没有闸门键 ⇒ `not-applicable`（这个动作没配闸门，投影成 skipped）。
 * 合并的后果：带闸门的动作正常完成、随后任务行被删，闸门会从「已批准」变成「跳过」。
 */
export async function inspectDigitalEmployeeHumanReviewSnapshot(
  db: PersistenceDb,
  executionRef: string,
): Promise<DigitalEmployeeHumanReviewCoreSnapshot> {
  const { tasks } = tablesOf(db)
  const task = await first(
    db
      .select({ inputs: taskReadColumns(db).inputs })
      .from(tasks)
      .where(eq(tasks.id, executionRef)),
  )
  if (task === undefined) return 'unknown'
  let parsedInputs: z.ZodSafeParseResult<Record<string, unknown>>
  try {
    parsedInputs = z.record(z.string(), z.unknown()).safeParse(JSON.parse(task.inputs) as unknown)
  } catch {
    return 'unknown'
  }
  if (!parsedInputs.success) return 'unknown'
  if (typeof parsedInputs.data[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY] !== 'string') {
    return 'not-applicable'
  }
  const reviewRun = (
    await createNodeRunQueries(db).listFields(
      {
        taskId: executionRef,
        nodeId: DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
        order: 'seq-desc',
        limit: 1,
      },
      ['status'],
    )
  )[0]
  if (reviewRun?.status === 'awaiting_review') return 'waiting'
  if (reviewRun?.status === 'done') return 'approved'
  if (
    reviewRun !== undefined &&
    ['failed', 'canceled', 'interrupted', 'skipped', 'exhausted'].includes(reviewRun.status)
  ) {
    return 'failed'
  }
  return 'planning'
}

/** The execution metadata the core inspects: the round it belongs to and whether auto-recovery is suspended. */
export async function readDigitalEmployeeExecutionMetadata(
  db: PersistenceDb,
  taskId: string,
): Promise<{ readonly roundRef: string | null; readonly autoRecoverySuspended: boolean } | null> {
  const { tasks } = tablesOf(db)
  const row = await first(
    db
      .select({
        roundRef: taskReadColumns(db).digitalEmployeeRoundId,
        autoRecoverySuspended: tasks.autoRecoverySuspended,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId)),
  )
  return row ?? null
}
