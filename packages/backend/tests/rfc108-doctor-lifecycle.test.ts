// RFC-108 T16 (AR-20) — `doctor` lifecycle-health check.
//
// 为什么这条测试存在：doctor 新增的生命周期检查必须是「信息性、永不 fail doctor」（卡死
// 任务是可恢复运行态、非配置错误），且零卡死时给干净一行。本测试锁定 evaluateLifecycleHealth
// 纯函数：① 全零 → ok=true + 干净文案；② 有计数 → ok=true + 文案含各计数。

import { describe, expect, test } from 'bun:test'

import { evaluateLifecycleHealth } from '../src/cli/doctor'

describe('RFC-108 T16 — evaluateLifecycleHealth', () => {
  test('all zero → clean message, ok=true', () => {
    const r = evaluateLifecycleHealth({
      interrupted: 0,
      failed: 0,
      awaitingReview: 0,
      awaitingHuman: 0,
      quarantined: 0,
      openAlerts: 0,
    })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('lifecycle')
    expect(r.message).toContain('no parked')
  })

  test('non-zero counts → ok=true (informational) + message surfaces them', () => {
    const r = evaluateLifecycleHealth({
      interrupted: 3,
      failed: 1,
      awaitingReview: 2,
      awaitingHuman: 0,
      quarantined: 1,
      openAlerts: 5,
    })
    expect(r.ok).toBe(true) // never fails doctor — recoverable runtime state
    expect(r.message).toContain('3 interrupted')
    expect(r.message).toContain('2 awaiting-review')
    expect(r.message).toContain('1 auto-recovery-quarantined')
    expect(r.message).toContain('5 open alerts')
  })
})
