// RFC-257 T9 — deliveries 保留 GC ticker（设计门 F-12：body_json 每行 ≤256KiB
// 无界累积；默认 30 天置空 body、90 天删行）。挂进 cli/start.ts 的 hourly
// ticker 组，shutdown 统一 .stop()。
// RFC-261（D9'）：保留天数改为 config 可配（webhookDeliveryBodyRetentionDays /
// webhookDeliveryRowRetentionDays）。getConfig 每次 sweep 调用 —— 设置改动
// 免重启热生效（startWorktreeGc 同款 getter 姿势）；未接 getter 的调用方
// （测试/嵌入场景）回落 deliveryStore 常量。
import type { Config } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import {
  DELIVERY_BODY_RETENTION_MS,
  DELIVERY_ROW_RETENTION_MS,
  gcDeliveries,
  gcDeliveriesSlice,
  type DeliveryGcSliceResult,
  type DeliveryRetention,
} from '@/services/webhook/deliveryStore'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-gc')

const DAY_MS = 24 * 60 * 60 * 1000

type RetentionConfig = Pick<
  Config,
  'webhookDeliveryBodyRetentionDays' | 'webhookDeliveryRowRetentionDays'
>

export function retentionFromConfig(cfg: RetentionConfig): DeliveryRetention {
  return {
    bodyRetentionMs: cfg.webhookDeliveryBodyRetentionDays * DAY_MS,
    rowRetentionMs: cfg.webhookDeliveryRowRetentionDays * DAY_MS,
  }
}

/** 单次 sweep 体（独立导出可测——两次调用间改 getter 返回值即热生效，评审门
 *  P2-④）。retention 在**每次调用时**求值，不在 ticker 装配时冻结。 */
export async function runDeliveryGcSweep(
  db: DbClient,
  getConfig?: () => RetentionConfig,
): Promise<{ bodiesCleared: number; rowsDeleted: number }> {
  const retention: DeliveryRetention = getConfig
    ? retentionFromConfig(getConfig())
    : { bodyRetentionMs: DELIVERY_BODY_RETENTION_MS, rowRetentionMs: DELIVERY_ROW_RETENTION_MS }
  return gcDeliveries(db, Date.now(), retention)
}

export function runDeliveryGcSlice(
  db: DbClient,
  config: RetentionConfig,
  cursor: unknown,
  batchSize?: number,
): Promise<DeliveryGcSliceResult> {
  return gcDeliveriesSlice(db, Date.now(), retentionFromConfig(config), cursor, batchSize)
}

export function startWebhookDeliveryGc(
  db: DbClient,
  getConfig?: () => RetentionConfig,
  // RFC-322：相位偏移；再入闸（原「评审门 P1-②」那条：保留期收缩后的首次 sweep 可能
  // 超一小时，不允许下一 tick 叠加第二个 sweep）现由 startMaintenanceTicker 统一提供。
  phaseOffsetMs: number = MAINTENANCE_PHASE.webhookDeliveryGc,
): { stop(): void } {
  return startMaintenanceTicker({
    job: 'webhookDeliveryGc',
    intervalMs: HOUR_MS,
    phaseOffsetMs,
    onTick: () =>
      runDeliveryGcSweep(db, getConfig)
        .then(({ bodiesCleared, rowsDeleted }) => {
          if (bodiesCleared > 0 || rowsDeleted > 0) {
            log.info('webhook delivery retention sweep', { bodiesCleared, rowsDeleted })
          }
        })
        .catch((err) => log.warn('webhook delivery gc failed', { error: String(err) })),
  })
}
