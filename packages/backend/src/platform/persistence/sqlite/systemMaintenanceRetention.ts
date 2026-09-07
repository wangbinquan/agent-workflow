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
import { sql, type SQL } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  intentSessions,
  intentTurnEvents,
  intentTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  memoryDistillEvents,
  memoryDistillJobs,
  tasks,
  webhookTriggerFires,
} from '@/db/schema'
import { BOUNDED_DELETE_MAX_ROWS } from '@/platform/persistence/capabilities'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'

const log = createLogger('maintenance-retention')

const DAY_MS = 86_400_000

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

// RFC-359 W6-T25 —— 四条清扫语句的**候选集**。谓词与 LIMIT 在这里；「候选集怎么变成一条 DELETE」
// 是方言，归能力矩阵的 `deleteByCandidates`（PG 渲染 `DELETE … USING candidates`，SQLite 渲染
// `DELETE … WHERE id IN (…)`）。合一前这里裸写的是 `rowid IN (…)`——三张事件表的 `id` 就是
// `INTEGER PRIMARY KEY AUTOINCREMENT`（rowid 别名）、`webhook_trigger_fires` 的 `id` 是 ULID 主键，
// 按主键删与按 rowid 删选中的是同一批行。

function distillCandidates(cutoff: number | null, batchSize: number): SQL {
  return sql`
    SELECT ${memoryDistillEvents.id} AS id
    FROM ${memoryDistillEvents}
    WHERE ${memoryDistillEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM ${memoryDistillJobs}
        WHERE ${memoryDistillJobs.id} = ${memoryDistillEvents.distillJobId}
          AND ${memoryDistillJobs.status} IN ('done', 'failed', 'canceled')
      )
    ORDER BY ${memoryDistillEvents.id}
    LIMIT ${batchSize}
  `
}

function intentCandidates(cutoff: number | null, batchSize: number): SQL {
  return sql`
    SELECT ${intentTurnEvents.id} AS id
    FROM ${intentTurnEvents}
    WHERE ${intentTurnEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1
        FROM ${intentTurns}
        JOIN ${intentSessions} ON ${intentSessions.id} = ${intentTurns.sessionId}
        WHERE ${intentTurns.id} = ${intentTurnEvents.turnId}
          AND ${intentSessions.status} = 'archived'
      )
    ORDER BY ${intentTurnEvents.id}
    LIMIT ${batchSize}
  `
}

function mcpRuntimeCandidates(cutoff: number | null, batchSize: number): SQL {
  return sql`
    SELECT ${mcpRuntimeTestEvents.id} AS id
    FROM ${mcpRuntimeTestEvents}
    WHERE ${mcpRuntimeTestEvents.ts} < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM ${mcpRuntimeTestSessions}
        WHERE ${mcpRuntimeTestSessions.id} = ${mcpRuntimeTestEvents.testSessionId}
          AND ${mcpRuntimeTestSessions.status} = 'ended'
      )
    ORDER BY ${mcpRuntimeTestEvents.id}
    LIMIT ${batchSize}
  `
}

function webhookFireCandidates(cutoff: number | null, batchSize: number): SQL {
  return sql`
    SELECT ${webhookTriggerFires.id} AS id
    FROM ${webhookTriggerFires}
    WHERE ${webhookTriggerFires.firedAt} < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM ${tasks}
        WHERE ${tasks.id} = ${webhookTriggerFires.taskId}
          AND ${tasks.status} NOT IN (${sql.join(
            TERMINAL_TASK_STATUSES.map((value) => sql`${value}`),
            sql`, `,
          )})
      )
    ORDER BY ${webhookTriggerFires.id}
    LIMIT ${batchSize}
  `
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
  batchSize: number = BOUNDED_DELETE_MAX_ROWS,
): Promise<RetentionSweepSliceResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('maintenance-retention-batch-invalid')
  }
  const cursor = retentionCursor(cursorValue, config, now)
  const counters = zeroRetentionResult()
  if (cursor.phase === 'done') return { done: true, cursor, counters }

  const engine = databaseSessionFor(db).engine
  let deleted: Array<{ id: string }>
  switch (cursor.phase) {
    case 'distill-events':
      deleted = await db.all(
        engine.deleteByCandidates(
          memoryDistillEvents,
          memoryDistillEvents.id,
          distillCandidates(cursor.eventCutoff, batchSize),
        ),
      )
      counters.distillEvents = deleted.length
      break
    case 'intent-turn-events':
      deleted = await db.all(
        engine.deleteByCandidates(
          intentTurnEvents,
          intentTurnEvents.id,
          intentCandidates(cursor.eventCutoff, batchSize),
        ),
      )
      counters.intentTurnEvents = deleted.length
      break
    case 'mcp-runtime-test-events':
      deleted = await db.all(
        engine.deleteByCandidates(
          mcpRuntimeTestEvents,
          mcpRuntimeTestEvents.id,
          mcpRuntimeCandidates(cursor.eventCutoff, batchSize),
        ),
      )
      counters.mcpRuntimeTestEvents = deleted.length
      break
    case 'webhook-trigger-fires':
      deleted = await db.all(
        engine.deleteByCandidates(
          webhookTriggerFires,
          webhookTriggerFires.id,
          webhookFireCandidates(cursor.webhookCutoff, batchSize),
        ),
      )
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
