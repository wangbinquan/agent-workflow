// RFC-311 PR-3（proposal C6）——无界流水表的保留期清理。
//
// 审计(audit L4/§5)照出一批「零清理无界表」：与 node_run_events 同形的三张
// 事件流水（memory_distill_events / intent_turn_events / mcp_runtime_test_events）、
// webhook_trigger_fires、user_access_audit、mcp_probes。生产按十万级 webhook
// 投递的节奏增长,永不回收。
//
// 判据（design.md §7.2 + 实现门 P2-11 修正）：事件三胞胎按**行时间戳过期 且
// 宿主已终态**才删。首版只看行时间戳,理由是「30 天前仍 active 的宿主不存在」——
// 但宿主行上的计数/状态列并不会跟着消失,于是一个仍在进行(或异常滞留)的会话会
// 呈现成「complete · 42 events」而面板空白;蒸馏详情更会因为标记行被删而把
// 「抓取失败」反转成「没有抓取问题」。宿主终态判据:distill job 三终态 /
// intent session archived / runtime-test session ended。
// ts 列无专用索引:治理生效后各表稳态 = 保留窗口大小,hourly 扫窗口规模可控,
// 不为此再开 migration。删除一律分批（chunkedAll 的 500 上限之下）防长写锁。

import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { and, asc, inArray, lt, sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  intentSessions,
  intentTurnEvents,
  intentTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  memoryDistillEvents,
  memoryDistillJobs,
  webhookTriggerFires,
  tasks,
} from '@/db/schema'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'

const log = createLogger('maintenance-retention')

const DAY_MS = 86_400_000
const DELETE_BATCH = 5_000

export interface RetentionConfig {
  /** 事件流水三胞胎（distill / intent turn / mcp runtime test），0 = off。 */
  eventStreamRetentionDays: number
  /** webhook_trigger_fires 保留天数，0 = off。 */
  webhookTriggerFiresRetentionDays: number
}

export interface RetentionSweepResult {
  distillEvents: number
  intentTurnEvents: number
  mcpRuntimeTestEvents: number
  webhookTriggerFires: number
  userAccessAudit: number
}

async function deleteExpiredByTs(
  db: DbClient,
  target: typeof memoryDistillEvents | typeof intentTurnEvents | typeof mcpRuntimeTestEvents,
  cutoff: number,
  /** 宿主终态判据。design.md §7.2 写的是「宿主终态后 30 天」,而首版实现只看行
   *  时间戳——实现门 P2-11:清掉一个**仍在进行**的会话/任务的事件流,而宿主行上的
   *  计数与状态列还在,UI 就会正面宣称「complete · 42 events」而面板空白,蒸馏
   *  详情页更会把「抓取失败」标记行一并删掉、把诊断信号反转成「没有抓取问题」。 */
  hostSettled: ReturnType<typeof sql>,
): Promise<number> {
  let total = 0
  for (;;) {
    const batch = await db
      .select({ id: target.id })
      .from(target)
      .where(and(lt(target.ts, cutoff), hostSettled))
      .orderBy(asc(target.id))
      .limit(DELETE_BATCH)
    if (batch.length === 0) return total
    await db.delete(target).where(
      inArray(
        target.id,
        batch.map((row) => row.id),
      ),
    )
    total += batch.length
    if (batch.length < DELETE_BATCH) return total
  }
}

/** One hourly retention pass. Every stage is independent and fail-soft. */
export async function runRetentionSweep(
  db: DbClient,
  config: RetentionConfig,
  now: number = Date.now(),
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = {
    distillEvents: 0,
    intentTurnEvents: 0,
    mcpRuntimeTestEvents: 0,
    webhookTriggerFires: 0,
    userAccessAudit: 0,
  }

  if (config.eventStreamRetentionDays > 0) {
    const cutoff = now - config.eventStreamRetentionDays * DAY_MS
    result.distillEvents = await deleteExpiredByTs(
      db,
      memoryDistillEvents,
      cutoff,
      sql`exists (
        select 1 from ${memoryDistillJobs} j
        where j.id = ${memoryDistillEvents.distillJobId}
          and j.status in ('done', 'failed', 'canceled')
      )`,
    )
    result.intentTurnEvents = await deleteExpiredByTs(
      db,
      intentTurnEvents,
      cutoff,
      sql`exists (
        select 1 from ${intentTurns} t
        join ${intentSessions} s on s.id = t.session_id
        where t.id = ${intentTurnEvents.turnId} and s.status = 'archived'
      )`,
    )
    result.mcpRuntimeTestEvents = await deleteExpiredByTs(
      db,
      mcpRuntimeTestEvents,
      cutoff,
      sql`exists (
        select 1 from ${mcpRuntimeTestSessions} s
        where s.id = ${mcpRuntimeTestEvents.testSessionId} and s.status = 'ended'
      )`,
    )
  }

  if (config.webhookTriggerFiresRetentionDays > 0) {
    const cutoff = now - config.webhookTriggerFiresRetentionDays * DAY_MS
    for (;;) {
      const batch = await db
        .select({ id: webhookTriggerFires.id })
        .from(webhookTriggerFires)
        .where(
          and(
            lt(webhookTriggerFires.firedAt, cutoff),
            // 实现门 P1-3:这张表是 webhook supersede(D8/D21「同流最近一次
            // launched 的任务未终态 ⇒ 取消」)的**唯一事实源**,没有任何回退。
            // 一个卡在 awaiting_human 的任务超过保留期后,它的 fire 行被删 ⇒
            // 下一次同流触发不再取消它,同一 MR 上两个活任务在同一分支上互相踩。
            // 保留期不得吃掉仍未终态的那一行。
            sql`not exists (
              select 1 from ${tasks} t
              where t.id = ${webhookTriggerFires.taskId}
                and t.status not in (${sql.join(
                  TERMINAL_TASK_STATUSES.map((v) => sql`${v}`),
                  sql`, `,
                )})
            )`,
          ),
        )
        .orderBy(asc(webhookTriggerFires.id))
        .limit(DELETE_BATCH)
      if (batch.length === 0) break
      await db.delete(webhookTriggerFires).where(
        inArray(
          webhookTriggerFires.id,
          batch.map((row) => row.id),
        ),
      )
      result.webhookTriggerFires += batch.length
      if (batch.length < DELETE_BATCH) break
    }
  }

  // user_access_audit 有 append-only 触发器（user_access_audit_append_only，
  // RFC-305 防篡改审计设计）——保留清理与之冲突,落地裁决:尊重既有安全设计、
  // 不清理该表。其增长驱动是人工权限变更,量级与「无界流水」不同档。
  // （proposal C6 的该项按此勘误;RetentionSweepResult 字段保留恒 0。）

  // mcp_probes 有 UNIQUE(mcp_id)——它是「每 MCP 最新一次探测」的 upsert 单行
  // 表,不是历史流水;审计把它列为无界表属误报,无需清理。

  const totalDeleted = Object.values(result).reduce((a, b) => a + b, 0)
  if (totalDeleted > 0) log.info('retention sweep', { ...result })
  return result
}

/** RFC-311 — hourly ticker; config re-read each tick via the injected loader. */
export function startRetentionSweeper(
  db: DbClient,
  loadRetentionConfig: () => RetentionConfig,
  intervalMs: number = HOUR_MS,
  // RFC-322：相位由 daemonCadence 的注册表给，避免与其它 hourly 维护同刻引爆。
  phaseOffsetMs: number = MAINTENANCE_PHASE.retentionSweep,
): { stop: () => void } {
  return startMaintenanceTicker({
    job: 'retentionSweep',
    intervalMs,
    phaseOffsetMs,
    onTick: () =>
      runRetentionSweep(db, loadRetentionConfig()).catch((err) =>
        log.warn('retention sweep threw', { error: (err as Error).message }),
      ),
  })
}
