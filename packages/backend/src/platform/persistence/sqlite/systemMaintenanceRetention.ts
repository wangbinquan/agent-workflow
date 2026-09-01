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

// System Operations SQLite adapter for the shared retention-sweep application contract.

import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import { sql } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'

const log = createLogger('maintenance-retention')

const DAY_MS = 86_400_000
export const RETENTION_DELETE_BATCH = 5_000

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

type RetentionPhase =
  | 'distill-events'
  | 'intent-turn-events'
  | 'mcp-runtime-test-events'
  | 'webhook-trigger-fires'
  | 'done'

export interface RetentionSweepCursorV1 {
  readonly version: 1
  readonly phase: RetentionPhase
  readonly eventCutoff: number | null
  readonly webhookCutoff: number | null
}

export interface RetentionSweepSliceResult {
  readonly done: boolean
  readonly cursor: RetentionSweepCursorV1
  readonly counters: RetentionSweepResult
}

function zeroRetentionResult(): RetentionSweepResult {
  return {
    distillEvents: 0,
    intentTurnEvents: 0,
    mcpRuntimeTestEvents: 0,
    webhookTriggerFires: 0,
    userAccessAudit: 0,
  }
}

function retentionPhases(cursor: RetentionSweepCursorV1): RetentionPhase[] {
  return [
    ...(cursor.eventCutoff === null
      ? []
      : (['distill-events', 'intent-turn-events', 'mcp-runtime-test-events'] as const)),
    ...(cursor.webhookCutoff === null ? [] : (['webhook-trigger-fires'] as const)),
    'done',
  ]
}

function retentionCursor(
  value: unknown,
  config: RetentionConfig,
  now: number,
): RetentionSweepCursorV1 {
  if (value === null || value === undefined) {
    const cursor: RetentionSweepCursorV1 = {
      version: 1,
      phase: 'done',
      eventCutoff:
        config.eventStreamRetentionDays > 0 ? now - config.eventStreamRetentionDays * DAY_MS : null,
      webhookCutoff:
        config.webhookTriggerFiresRetentionDays > 0
          ? now - config.webhookTriggerFiresRetentionDays * DAY_MS
          : null,
    }
    return { ...cursor, phase: retentionPhases(cursor)[0]! }
  }
  const cursor = value as Partial<RetentionSweepCursorV1> | null
  const validCutoff = (cutoff: unknown): cutoff is number | null =>
    cutoff === null || Number.isSafeInteger(cutoff)
  if (
    typeof cursor !== 'object' ||
    cursor === null ||
    cursor.version !== 1 ||
    ![
      'distill-events',
      'intent-turn-events',
      'mcp-runtime-test-events',
      'webhook-trigger-fires',
      'done',
    ].includes(String(cursor.phase)) ||
    !validCutoff(cursor.eventCutoff) ||
    !validCutoff(cursor.webhookCutoff)
  ) {
    throw new Error('maintenance-retention-cursor-invalid')
  }
  const parsed = cursor as RetentionSweepCursorV1
  if (!retentionPhases(parsed).includes(parsed.phase)) {
    throw new Error('maintenance-retention-cursor-phase-invalid')
  }
  return parsed
}

function advanceRetentionPhase(cursor: RetentionSweepCursorV1): RetentionSweepCursorV1 {
  const phases = retentionPhases(cursor)
  const index = phases.indexOf(cursor.phase)
  return { ...cursor, phase: phases[Math.min(phases.length - 1, index + 1)]! }
}

/**
 * One predicate-rechecking DELETE statement. This is the Worker-facing owner
 * contract; it cannot keep SQLite's writer lock across phases or batches.
 */
export async function runRetentionSweepSlice(
  db: DbClient,
  config: RetentionConfig,
  cursorValue: unknown,
  now: number = Date.now(),
  batchSize: number = RETENTION_DELETE_BATCH,
): Promise<RetentionSweepSliceResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('maintenance-retention-batch-invalid')
  }
  const cursor = retentionCursor(cursorValue, config, now)
  const counters = zeroRetentionResult()
  if (cursor.phase === 'done') return { done: true, cursor, counters }

  let deleted: Array<{ id: string }>
  switch (cursor.phase) {
    case 'distill-events':
      deleted = await db.all(sql`
        DELETE FROM memory_distill_events
        WHERE rowid IN (
          SELECT event.rowid FROM memory_distill_events event
          WHERE event.ts < ${cursor.eventCutoff}
            AND EXISTS (
              SELECT 1 FROM memory_distill_jobs job
              WHERE job.id = event.distill_job_id
                AND job.status IN ('done', 'failed', 'canceled')
            )
          ORDER BY event.id
          LIMIT ${batchSize}
        )
        RETURNING id`)
      counters.distillEvents = deleted.length
      break
    case 'intent-turn-events':
      deleted = await db.all(sql`
        DELETE FROM intent_turn_events
        WHERE rowid IN (
          SELECT event.rowid FROM intent_turn_events event
          WHERE event.ts < ${cursor.eventCutoff}
            AND EXISTS (
              SELECT 1 FROM intent_turns turn
              JOIN intent_sessions session ON session.id = turn.session_id
              WHERE turn.id = event.turn_id AND session.status = 'archived'
            )
          ORDER BY event.id
          LIMIT ${batchSize}
        )
        RETURNING id`)
      counters.intentTurnEvents = deleted.length
      break
    case 'mcp-runtime-test-events':
      deleted = await db.all(sql`
        DELETE FROM mcp_runtime_test_events
        WHERE rowid IN (
          SELECT event.rowid FROM mcp_runtime_test_events event
          WHERE event.ts < ${cursor.eventCutoff}
            AND EXISTS (
              SELECT 1 FROM mcp_runtime_test_sessions session
              WHERE session.id = event.test_session_id AND session.status = 'ended'
            )
          ORDER BY event.id
          LIMIT ${batchSize}
        )
        RETURNING id`)
      counters.mcpRuntimeTestEvents = deleted.length
      break
    case 'webhook-trigger-fires':
      deleted = await db.all(sql`
        DELETE FROM webhook_trigger_fires
        WHERE rowid IN (
          SELECT fire.rowid FROM webhook_trigger_fires fire
          WHERE fire.fired_at < ${cursor.webhookCutoff}
            AND NOT EXISTS (
              SELECT 1 FROM tasks task
              WHERE task.id = fire.task_id
                AND task.status NOT IN (${sql.join(
                  TERMINAL_TASK_STATUSES.map((value) => sql`${value}`),
                  sql`, `,
                )})
            )
          ORDER BY fire.id
          LIMIT ${batchSize}
        )
        RETURNING id`)
      counters.webhookTriggerFires = deleted.length
      break
  }
  const next = deleted.length < batchSize ? advanceRetentionPhase(cursor) : cursor
  return { done: next.phase === 'done', cursor: next, counters }
}

/** One hourly retention pass. Every stage is independent and fail-soft. */
export async function runRetentionSweep(
  db: DbClient,
  config: RetentionConfig,
  now: number = Date.now(),
): Promise<RetentionSweepResult> {
  const result = zeroRetentionResult()
  let cursor: RetentionSweepCursorV1 | null = null
  for (;;) {
    const slice = await runRetentionSweepSlice(db, config, cursor, now)
    for (const key of Object.keys(result) as Array<keyof RetentionSweepResult>) {
      result[key] += slice.counters[key]
    }
    if (slice.done) break
    cursor = slice.cursor
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
