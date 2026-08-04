// RFC-257 T9 — deliveries 保留 GC ticker（设计门 F-12：body_json 每行 ≤256KiB
// 无界累积；30 天置空 body、90 天删行——常量在 deliveryStore.ts）。挂进
// cli/start.ts 的 hourly ticker 组，shutdown 统一 .stop()。
import type { DbClient } from '@/db/client'
import { gcDeliveries } from '@/services/webhook/deliveryStore'
import { createLogger } from '@/util/log'

const log = createLogger('webhook-gc')

const HOUR_MS = 60 * 60 * 1000

export function startWebhookDeliveryGc(db: DbClient): { stop(): void } {
  const timer = setInterval(() => {
    void gcDeliveries(db, Date.now())
      .then(({ bodiesCleared, rowsDeleted }) => {
        if (bodiesCleared > 0 || rowsDeleted > 0) {
          log.info('webhook delivery retention sweep', { bodiesCleared, rowsDeleted })
        }
      })
      .catch((err) => log.warn('webhook delivery gc failed', { error: String(err) }))
  }, HOUR_MS)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
