// RFC-311 — 性能治理配置面的默认值锁(proposal §5 能力影响):
//   C5:WAL checkpoint 循环默认**开启**(600_000ms;原默认 0=关)。
//   C4:backupProtectedKeepCount 默认 10(0 = 保持历史不清理)。
//   C6:eventStreamRetentionDays 30 / webhookTriggerFiresRetentionDays 90。
//   C3:事件归档字节水位默认 8MiB / 256MiB。
//   容量 PRAGMA 组:sqlitePageCacheMib 128 / sqliteMmapMib 512 / slowQueryMs 50。
// 旧 config 快照(缺这些键)必须经 ConfigSchema 补默认——这是 C5 的「行为
// 变化生效面」:老部署升级后 checkpoint 循环自动打开。

import { describe, expect, test } from 'bun:test'

import { ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-311 · perf governance config defaults', () => {
  test('old config snapshots inherit the RFC-311 defaults (C3/C4/C5/C6 + PRAGMA group)', () => {
    const {
      walCheckpointIntervalMs: _a,
      backupProtectedKeepCount: _b,
      eventStreamRetentionDays: _c,
      webhookTriggerFiresRetentionDays: _d,
      sqlitePageCacheMib: _e,
      sqliteMmapMib: _f,
      sqliteSlowQueryMs: _g,
      eventsArchiveThresholds: thresholds,
      ...rest
    } = DEFAULT_CONFIG
    // 旧快照:顶层 thresholds 对象一直存在(必填),只是没有 RFC-311 的两个
    // byte 键。
    const oldConfig = {
      ...rest,
      eventsArchiveThresholds: {
        perNodeRunRows: thresholds.perNodeRunRows,
        globalRows: thresholds.globalRows,
      },
    }
    const parsed = ConfigSchema.parse(oldConfig)

    // C5:默认开启(600_000 = 10min)。0 仍是合法的「关」。
    expect(parsed.walCheckpointIntervalMs).toBe(600_000)
    expect(
      ConfigSchema.parse({ ...oldConfig, walCheckpointIntervalMs: 0 }).walCheckpointIntervalMs,
    ).toBe(0)
    // C4
    expect(parsed.backupProtectedKeepCount).toBe(10)
    // C6
    expect(parsed.eventStreamRetentionDays).toBe(30)
    expect(parsed.webhookTriggerFiresRetentionDays).toBe(90)
    // C3
    expect(parsed.eventsArchiveThresholds.perNodeRunBytes).toBe(8 * 1024 * 1024)
    expect(parsed.eventsArchiveThresholds.globalBytes).toBe(256 * 1024 * 1024)
    // PRAGMA 组
    expect(parsed.sqlitePageCacheMib).toBe(128)
    expect(parsed.sqliteMmapMib).toBe(512)
    expect(parsed.sqliteSlowQueryMs).toBe(50)
  })
})
