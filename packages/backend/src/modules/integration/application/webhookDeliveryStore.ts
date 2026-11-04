// RFC-349 — provider-neutral webhook delivery application facade. Database
// mechanics live in this module's infrastructure; ingress, recovery, and
// maintenance receive this explicit Promise port from bootstrap composition.
// RFC-437：自 services/webhook/deliveryStore.ts 迁入 integration application。
import type {
  WebhookDeliveryGcCursorV1,
  WebhookDeliveryGcSliceReceipt,
  WebhookDeliveryInsertInput,
  WebhookDeliveryInsertReceipt,
  WebhookDeliveryPersistencePort,
  WebhookDeliveryRetention,
} from './ports/webhookDeliveryPersistence'
import {
  DELIVERY_BODY_RETENTION_MS,
  DELIVERY_GC_BATCH,
  DELIVERY_ROW_RETENTION_MS,
} from '../domain/webhookDelivery'
import type { WebhookDeliveryReason, WebhookDeliveryStatus } from '@agent-workflow/shared'

export type InsertDeliveryInput = WebhookDeliveryInsertInput
export type InsertDeliveryResult = WebhookDeliveryInsertReceipt
export type DeliveryRetention = WebhookDeliveryRetention
export type DeliveryGcCursorV1 = WebhookDeliveryGcCursorV1
export type DeliveryGcSliceResult = WebhookDeliveryGcSliceReceipt

function deliveryGcCursor(value: unknown): WebhookDeliveryGcCursorV1 | null {
  if (value === null || value === undefined) return null
  const record = value as Partial<WebhookDeliveryGcCursorV1> | null
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
  return record as WebhookDeliveryGcCursorV1
}

export function insertDelivery(
  persistence: WebhookDeliveryPersistencePort,
  input: InsertDeliveryInput,
): Promise<InsertDeliveryResult> {
  return persistence.insert(input)
}

export function markDelivery(
  persistence: WebhookDeliveryPersistencePort,
  deliveryId: string,
  status: WebhookDeliveryStatus,
  reason?: WebhookDeliveryReason | null,
): Promise<void> {
  return persistence.mark({ deliveryId, status, reason })
}

export function recoverInterruptedDeliveries(
  persistence: WebhookDeliveryPersistencePort,
): Promise<number> {
  return persistence.recoverInterrupted()
}

export function gcDeliveriesSlice(
  persistence: WebhookDeliveryPersistencePort,
  now: number,
  retention: DeliveryRetention,
  cursorValue: unknown,
  batchSize: number = DELIVERY_GC_BATCH,
): Promise<DeliveryGcSliceResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('maintenance-webhook-delivery-batch-invalid')
  }
  return persistence.gcSlice({
    now,
    retention,
    cursor: deliveryGcCursor(cursorValue),
    batchSize,
  })
}

export async function gcDeliveries(
  persistence: WebhookDeliveryPersistencePort,
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
    const slice = await gcDeliveriesSlice(persistence, now, retention, cursor, batchSize)
    total.bodiesCleared += slice.counters.bodiesCleared
    total.rowsDeleted += slice.counters.rowsDeleted
    if (slice.done) return total
    cursor = slice.cursor
  }
}
