// RFC-257 T5 — webhook_deliveries 存取。三段式（D23）的存储面：
//   同步段插 received 行 → 立即应答 → 异步段推进 processing → 终态。
// 去重靠迁移 0138 的 partial unique index（rejected/failed 不占位）；命中
// 冲突时 bump 原行 attempt_count 并返回原 deliveryId（multica 语义：重投
// 不新增行）。daemon 重启把在途行标 failed/interrupted（恢复 = 手动 replay，
// GitLab 对失败投递不自动重试——设计门 F-6）。
import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { webhookDeliveries } from '@/db/schema'
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
  const rows = await db
    .update(webhookDeliveries)
    .set({ status: 'failed', statusReason: 'interrupted' })
    .where(inArray(webhookDeliveries.status, ['received', 'processing']))
    .returning({ id: webhookDeliveries.id })
  return rows.length
}

/** 保留策略常量（设计门 F-12；hourly ticker 消费，见 services/webhookGc.ts）。 */
export const DELIVERY_BODY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELIVERY_ROW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** 保留 GC：超 30 天置空 body_json、超 90 天删行。返回 {bodiesCleared, rowsDeleted}。 */
export async function gcDeliveries(
  db: DbClient,
  now: number,
): Promise<{ bodiesCleared: number; rowsDeleted: number }> {
  const bodyCutoff = now - DELIVERY_BODY_RETENTION_MS
  const rowCutoff = now - DELIVERY_ROW_RETENTION_MS
  const cleared = await db
    .update(webhookDeliveries)
    .set({ bodyJson: null })
    .where(
      and(
        lt(webhookDeliveries.receivedAt, bodyCutoff),
        isNotNull(webhookDeliveries.bodyJson),
        // 在途行不清（理论上不会存活 30 天，防御）
        notInArray(webhookDeliveries.status, ['received', 'processing']),
      ),
    )
    .returning({ id: webhookDeliveries.id })
  const deleted = await db
    .delete(webhookDeliveries)
    .where(
      and(
        lt(webhookDeliveries.receivedAt, rowCutoff),
        notInArray(webhookDeliveries.status, ['received', 'processing']),
      ),
    )
    .returning({ id: webhookDeliveries.id })
  return { bodiesCleared: cleared.length, rowsDeleted: deleted.length }
}

/** 更新端点观测列（best-effort，不参与主链路失败语义）。 */
export async function touchEndpointLastDelivery(
  db: DbClient,
  endpointId: string,
  now: number,
): Promise<void> {
  await db.run(sql`UPDATE webhook_endpoints SET last_delivery_at = ${now} WHERE id = ${endpointId}`)
}
