// RFC-257 T5 — webhook_deliveries 存取。三段式（D23）的存储面：
//   同步段插 received 行 → 立即应答 → 异步段推进 processing → 终态。
// 去重靠迁移 0138 的 partial unique index（rejected/failed 不占位）；命中
// 冲突时 bump 原行 attempt_count 并返回原 deliveryId（multica 语义：重投
// 不新增行）。daemon 重启把在途行标 failed/interrupted（恢复 = 手动 replay，
// GitLab 对失败投递不自动重试——设计门 F-6）。
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { webhookDeliveries, webhookMrControlEffects } from '@/db/schema'
import type {
  CodeHostEventType,
  WebhookDeliveryReason,
  WebhookDeliveryStatus,
} from '@agent-workflow/shared'

/** body_json 入库截断（HTTP 层 body 上限 1MiB 在路由；入库再截到 256KiB）。 */
export const DELIVERY_BODY_MAX_CHARS = 256 * 1024

export type InsertDeliveryInput = {
  endpointId: string
  eventUuid: string | null
  gitlabEventHeader?: string | null
  objectKind?: string | null
  eventType?: CodeHostEventType | null
  repoPath?: string | null
  streamHint?: string | null
  status: WebhookDeliveryStatus
  statusReason?: WebhookDeliveryReason | null
  bodyJson?: string | null
  replayedFromDeliveryId?: string | null
}

export type InsertDeliveryResult =
  | { kind: 'inserted'; deliveryId: string }
  | { kind: 'duplicate'; deliveryId: string; attemptCount: number }

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

export function truncateDeliveryBody(body: string): string {
  return body.length > DELIVERY_BODY_MAX_CHARS ? body.slice(0, DELIVERY_BODY_MAX_CHARS) : body
}

/**
 * 插入投递行；同 (endpoint, uuid) 命中未拒未败行时不新增，bump 原行
 * attempt_count 并返回原 id。竞态由唯一索引兜底（先 INSERT 后查，
 * 不做 check-then-act）。
 */
export async function insertDelivery(
  db: DbClient,
  input: InsertDeliveryInput,
): Promise<InsertDeliveryResult> {
  const id = ulid()
  try {
    await db.insert(webhookDeliveries).values({
      id,
      endpointId: input.endpointId,
      eventUuid: input.eventUuid,
      gitlabEventHeader: input.gitlabEventHeader ?? null,
      objectKind: input.objectKind ?? null,
      eventType: input.eventType ?? null,
      repoPath: input.repoPath ?? null,
      streamHint: input.streamHint ?? null,
      status: input.status,
      statusReason: input.statusReason ?? null,
      bodyJson:
        input.bodyJson === undefined || input.bodyJson === null
          ? null
          : truncateDeliveryBody(input.bodyJson),
      replayedFromDeliveryId: input.replayedFromDeliveryId ?? null,
    })
    return { kind: 'inserted', deliveryId: id }
  } catch (err) {
    if (!isUniqueViolation(err) || input.eventUuid === null) throw err
    const existing = (
      await db
        .select({
          id: webhookDeliveries.id,
          attemptCount: webhookDeliveries.attemptCount,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, input.endpointId),
            eq(webhookDeliveries.eventUuid, input.eventUuid),
            notInArray(webhookDeliveries.status, ['rejected', 'failed']),
          ),
        )
        .limit(1)
    )[0]
    if (!existing) throw err // 索引说冲突但行查不到：真实异常，向上抛
    const bumped = existing.attemptCount + 1
    await db
      .update(webhookDeliveries)
      .set({ attemptCount: bumped })
      .where(eq(webhookDeliveries.id, existing.id))
    return { kind: 'duplicate', deliveryId: existing.id, attemptCount: bumped }
  }
}

export async function markDelivery(
  db: DbClient,
  deliveryId: string,
  status: WebhookDeliveryStatus,
  reason?: WebhookDeliveryReason | null,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status, statusReason: reason ?? null })
    .where(eq(webhookDeliveries.id, deliveryId))
}

/**
 * daemon 启动恢复（D23）：把上次进程遗留的在途行（received/processing）标为
 * failed/interrupted。返回处理行数；调用点在 cli/start.ts 的启动序列。
 */
export async function recoverInterruptedDeliveries(db: DbClient): Promise<number> {
  const controlledIds = db
    .select({ id: webhookMrControlEffects.deliveryId })
    .from(webhookMrControlEffects)
    .all()
    .map((row) => row.id)
  if (controlledIds.length > 0) {
    db.update(webhookDeliveries)
      .set({ status: 'matched', statusReason: 'terminal-control-accepted' })
      .where(
        and(
          inArray(webhookDeliveries.id, controlledIds),
          inArray(webhookDeliveries.status, ['received', 'processing']),
        ),
      )
      .run()
  }
  const rows = await db
    .update(webhookDeliveries)
    .set({ status: 'failed', statusReason: 'interrupted' })
    .where(
      and(
        inArray(webhookDeliveries.status, ['received', 'processing']),
        ...(controlledIds.length > 0 ? [notInArray(webhookDeliveries.id, controlledIds)] : []),
      ),
    )
    .returning({ id: webhookDeliveries.id })
  return rows.length
}

/** 保留策略默认值（设计门 F-12）。RFC-261（D9'）：生效值来自 config 的
 *  `webhookDeliveryBodyRetentionDays` / `webhookDeliveryRowRetentionDays`
 *  （hourly ticker 每次 sweep 读取，见 services/webhook/webhookGc.ts）；
 *  这两个常量只作缺省与直接调用方的兜底。 */
export const DELIVERY_BODY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELIVERY_ROW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export type DeliveryRetention = { bodyRetentionMs: number; rowRetentionMs: number }

/** GC 单批行数上限（评审门 P1-②）：D9' 让「保留期收缩」成为一等操作——90→7 天
 *  意味着一次性清理数百万行。分批让每批独立事务（写锁间隙 ingress 插入可穿插、
 *  WAL 有界）且 RETURNING 物化有界（原 `.returning()` 会物化百万级 id 数组）。 */
export const DELIVERY_GC_BATCH = 10_000

export interface DeliveryGcCursorV1 {
  readonly version: 1
  readonly phase: 'bodies' | 'rows'
  readonly bodyCutoff: number
  readonly rowCutoff: number
}

export interface DeliveryGcSliceResult {
  readonly done: boolean
  readonly cursor: DeliveryGcCursorV1
  readonly counters: { readonly bodiesCleared: number; readonly rowsDeleted: number }
}

function deliveryGcCursor(
  value: unknown,
  now: number,
  retention: DeliveryRetention,
): DeliveryGcCursorV1 {
  if (value === null || value === undefined) {
    return {
      version: 1,
      phase: 'bodies',
      bodyCutoff: now - retention.bodyRetentionMs,
      rowCutoff: now - retention.rowRetentionMs,
    }
  }
  const record = value as Partial<DeliveryGcCursorV1> | null
  if (
    typeof record !== 'object' ||
    record === null ||
    record.version !== 1 ||
    (record.phase !== 'bodies' && record.phase !== 'rows') ||
    !Number.isSafeInteger(record.bodyCutoff) ||
    !Number.isSafeInteger(record.rowCutoff)
  ) {
    throw new Error('maintenance-webhook-delivery-cursor-invalid')
  }
  return record as DeliveryGcCursorV1
}

/** One bounded UPDATE or DELETE statement for the RFC-338 Worker. */
export async function gcDeliveriesSlice(
  db: DbClient,
  now: number,
  retention: DeliveryRetention,
  cursorValue: unknown,
  batchSize: number = DELIVERY_GC_BATCH,
): Promise<DeliveryGcSliceResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('maintenance-webhook-delivery-batch-invalid')
  }
  const cursor = deliveryGcCursor(cursorValue, now, retention)
  if (cursor.phase === 'bodies') {
    const batch = await db.all<{ id: string }>(sql`
      UPDATE webhook_deliveries SET body_json = NULL
      WHERE rowid IN (
        SELECT rowid FROM webhook_deliveries
        WHERE received_at < ${cursor.bodyCutoff} AND body_json IS NOT NULL
          AND status NOT IN ('received','processing')
        LIMIT ${batchSize}
      )
      RETURNING id`)
    return {
      done: false,
      cursor: {
        ...cursor,
        phase: batch.length < batchSize ? 'rows' : 'bodies',
      },
      counters: { bodiesCleared: batch.length, rowsDeleted: 0 },
    }
  }
  const batch = await db.all<{ id: string }>(sql`
    DELETE FROM webhook_deliveries
    WHERE rowid IN (
      SELECT rowid FROM webhook_deliveries
      WHERE received_at < ${cursor.rowCutoff}
        AND status NOT IN ('received','processing')
        AND NOT EXISTS (
          SELECT 1 FROM webhook_mr_control_effects effect
          WHERE effect.delivery_id = webhook_deliveries.id
            AND effect.status <> 'succeeded'
        )
        AND NOT EXISTS (
          SELECT 1 FROM webhook_mr_launch_guards guard
          WHERE guard.delivery_id = webhook_deliveries.id
            AND guard.status IN ('reserved','launching','revoking-terminal','task-committed')
        )
      LIMIT ${batchSize}
    )
    RETURNING id`)
  return {
    done: batch.length < batchSize,
    cursor,
    counters: { bodiesCleared: 0, rowsDeleted: batch.length },
  }
}

/** 保留 GC：超期置空 body_json / 删行，按 batchSize 分批。返回 {bodiesCleared,
 *  rowsDeleted}。body>row 的畸形组合（手改 config 绕过保存门）无害：行先死，
 *  body 段自然空转。在途行（received/processing）两段都不动（防御）。 */
export async function gcDeliveries(
  db: DbClient,
  now: number,
  retention: DeliveryRetention = {
    bodyRetentionMs: DELIVERY_BODY_RETENTION_MS,
    rowRetentionMs: DELIVERY_ROW_RETENTION_MS,
  },
  batchSize: number = DELIVERY_GC_BATCH,
): Promise<{ bodiesCleared: number; rowsDeleted: number }> {
  let cursor: DeliveryGcCursorV1 | null = null
  const total = { bodiesCleared: 0, rowsDeleted: 0 }
  for (;;) {
    const slice = await gcDeliveriesSlice(db, now, retention, cursor, batchSize)
    total.bodiesCleared += slice.counters.bodiesCleared
    total.rowsDeleted += slice.counters.rowsDeleted
    if (slice.done) return total
    cursor = slice.cursor
  }
}

/** 更新端点观测列（best-effort，不参与主链路失败语义）。 */
export async function touchEndpointLastDelivery(
  db: DbClient,
  endpointId: string,
  now: number,
): Promise<void> {
  await db.run(sql`UPDATE webhook_endpoints SET last_delivery_at = ${now} WHERE id = ${endpointId}`)
}
