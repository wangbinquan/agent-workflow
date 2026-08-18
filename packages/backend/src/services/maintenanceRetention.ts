// RFC-311 PR-3（proposal C6）——无界流水表的保留期清理。
//
// 审计(audit L4/§5)照出一批「零清理无界表」：与 node_run_events 同形的三张
// 事件流水（memory_distill_events / intent_turn_events / mcp_runtime_test_events）、
// webhook_trigger_fires、user_access_audit、mcp_probes。生产按十万级 webhook
// 投递的节奏增长,永不回收。
//
// 判据取舍（proposal C6 已批）：事件三胞胎按**行时间戳**直接过期,不 JOIN 各自
// 宿主的终态——30 天前仍 active 的蒸馏 job / intent turn / runtime-test 会话在
// 本系统不存在（各自的执行窗口都是分钟级）,损失面只是「超期流水的详情回放」。
// ts 列无专用索引:治理生效后各表稳态 = 保留窗口大小,hourly 扫窗口规模可控,
// 不为此再开 migration。删除一律分批（chunkedAll 的 500 上限之下）防长写锁。

import { asc, inArray, lt } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  intentTurnEvents,
  mcpRuntimeTestEvents,
  memoryDistillEvents,
  webhookTriggerFires,
} from '@/db/schema'
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
): Promise<number> {
  let total = 0
  for (;;) {
    const batch = await db
      .select({ id: target.id })
      .from(target)
      .where(lt(target.ts, cutoff))
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
    result.distillEvents = await deleteExpiredByTs(db, memoryDistillEvents, cutoff)
    result.intentTurnEvents = await deleteExpiredByTs(db, intentTurnEvents, cutoff)
    result.mcpRuntimeTestEvents = await deleteExpiredByTs(db, mcpRuntimeTestEvents, cutoff)
  }

  if (config.webhookTriggerFiresRetentionDays > 0) {
    const cutoff = now - config.webhookTriggerFiresRetentionDays * DAY_MS
    for (;;) {
      const batch = await db
        .select({ id: webhookTriggerFires.id })
        .from(webhookTriggerFires)
        .where(lt(webhookTriggerFires.firedAt, cutoff))
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
  intervalMs: number = 3_600_000,
): { stop: () => void } {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    runRetentionSweep(db, loadRetentionConfig())
      .catch((err) => log.warn('retention sweep threw', { error: (err as Error).message }))
      .finally(() => {
        running = false
      })
  }
  const handle = setInterval(tick, intervalMs)
  ;(handle as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(handle) }
}
