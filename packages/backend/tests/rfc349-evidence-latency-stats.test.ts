// RFC-349 / RFC-338 —— 取证与 soak 报告不许因为「样本多」而算不出来。
//
// 由来：本机全量取证跑（`--scale full --clients 100 --duration-seconds 180`）里迁移本身
// 已经跑完——崩溃续跑 26/26、13,208,635 行拷完、拷贝阶段峰值 RSS 2.40GB——却在收尾算报告
// 时炸掉：
//
//   maxMs: samples.length === 0 ? 0 : Math.max(...samples)
//   RangeError: Maximum call stack size exceeded
//
// `Math.max(...samples)` 把整个数组当**函数实参**展开，几十万条样本直接越过引擎的实参
// 上限。这条路只有 full 口径才走得到，所以此前一直没人撞上；而它一炸，整条 hosted 门就
// 永远出不了报告。两个 harness 共五处同形写法（本文件锁 RFC-349 三处 + RFC-338 两处）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { latencyStats } from './helpers/rfc349PostgresqlHostedEvidence'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

describe('RFC-349 evidence latency stats survive a full-tier sample count', () => {
  test('a 500k-sample array is summarized instead of blowing the argument limit', () => {
    // Comfortably past the engine's spread-as-arguments limit; the old shape
    // throws RangeError well before this size.
    const samples = Array.from({ length: 500_000 }, (_, index) => (index % 997) + 1)

    const stats = latencyStats(samples)

    expect(stats.count).toBe(500_000)
    expect(stats.maxMs).toBe(997)
    expect(stats.p50Ms).toBeGreaterThan(0)
    expect(stats.p95Ms).toBeGreaterThanOrEqual(stats.p50Ms)
  })

  test('an empty sample set still reports zeroes', () => {
    expect(latencyStats([])).toMatchObject({ count: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 })
  })

  test('neither soak harness spreads a sample array into Math.max/min', () => {
    for (const relative of [
      'packages/backend/tests/helpers/rfc349PostgresqlHostedEvidence.ts',
      'scripts/rfc338-maintenance-soak.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, relative), 'utf8')
      const offenders = source
        .split(/\r?\n/)
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(
          ({ line }) => /Math\.(max|min)\(\.\.\./.test(line) && !line.trimStart().startsWith('*'),
        )
      expect(`${relative}: ${JSON.stringify(offenders)}`).toBe(`${relative}: []`)
    }
  })
})
