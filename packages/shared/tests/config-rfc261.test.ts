// RFC-261 (D9') — webhook 投递保留天数配置字段：
//   webhookDeliveryBodyRetentionDays（默认 30）/ webhookDeliveryRowRetentionDays（默认 90），
//   bounds 1..3650、int-only、patch 可携带。跨字段语义门（body ≤ row）不在 schema
//  （ConfigPatchSchema = ConfigSchema.partial() 要求基 schema 保持纯 ZodObject），
//   由后端 PUT /api/config 路由把关（rfc261-webhook-delivery-pagination.test.ts 锁定）。

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-261 · webhook delivery retention config fields', () => {
  test('defaults: 缺省键 parse 回填 30/90，DEFAULT_CONFIG 同步', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      webhookDeliveryBodyRetentionDays: undefined,
      webhookDeliveryRowRetentionDays: undefined,
    })
    expect(parsed.webhookDeliveryBodyRetentionDays).toBe(30)
    expect(parsed.webhookDeliveryRowRetentionDays).toBe(90)
    expect(DEFAULT_CONFIG.webhookDeliveryBodyRetentionDays).toBe(30)
    expect(DEFAULT_CONFIG.webhookDeliveryRowRetentionDays).toBe(90)
  })

  test('bounds：0 / 负数 / 3651 / 小数拒绝，1 与 3650 接受', () => {
    for (const key of [
      'webhookDeliveryBodyRetentionDays',
      'webhookDeliveryRowRetentionDays',
    ] as const) {
      for (const bad of [0, -1, 3651, 1.5]) {
        expect(ConfigPatchSchema.safeParse({ [key]: bad }).success).toBe(false)
      }
      for (const ok of [1, 3650]) {
        expect(ConfigPatchSchema.safeParse({ [key]: ok }).success).toBe(true)
      }
    }
  })

  test('patch 可同时携带两个字段', () => {
    const res = ConfigPatchSchema.safeParse({
      webhookDeliveryBodyRetentionDays: 7,
      webhookDeliveryRowRetentionDays: 30,
    })
    expect(res.success).toBe(true)
  })
})
