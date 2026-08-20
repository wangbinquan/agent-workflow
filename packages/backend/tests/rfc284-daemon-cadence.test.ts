// RFC-284 T22（审计 N26）——daemon 节奏注册表数值锁：收口承诺「数值不变」，
// 本表把收口当日的每个周期拍死；有意调参须改这里并在 commit 里说明。
import { describe, expect, test } from 'bun:test'
import { DAEMON_CADENCE } from '../src/services/daemonCadence'

describe('RFC-284 T22 — DAEMON_CADENCE 数值锁', () => {
  test('与收口前逐字相等', () => {
    expect(DAEMON_CADENCE).toEqual({
      autoKill: 300_000,
      autoRepair: 300_000,
      stuckTaskScan: 300_000,
      orphanReconcile: 600_000,
      lifecycleInvariants: 3_600_000,
      worktreeGc: 3_600_000,
      fusionReconcile: 60_000,
      resourceLimits: 1_000,
      intentScratchGc: 3_600_000,
      tokenAuditGc: 3_600_000,
      // RFC-310 PR-3 新增（非调参）：mission wake sweep 30s、上传 TTL 回收 1h。
      developmentWakeSweep: 30_000,
      developmentUploadGc: 3_600_000,
      // RFC-310 T71 新增（非调参）：终态 Mission 的 retention 执行，与其它 GC 同
      // 走 hourly 节拍。
      developmentRetentionSweep: 3_600_000,
    })
  })
})
