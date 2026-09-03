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

import {
  evidenceArchiveRetainRows,
  latencyStats,
  parseRfc349EvidenceArgs,
  rfc349ExpectedSeedCounts,
  RFC349_EVIDENCE_TIERS,
} from './helpers/rfc349PostgresqlHostedEvidence'

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

  // 维护等待窗从「死的 900 秒」改成停滞判据：同一个 harness 自己把 `eventsArchive` 配成
  // 要归档约 900 万行（`globalRows = expectedEvents / 10`），而归档按 RFC-338 合同走每片
  // 1000 行的有界切片——本机实测 2303 片 / 977 秒（0.42 秒一片、983 行一片，完全符合设计），
  // 900 万行要约 65 分钟，和 15 分钟的等待窗差了四倍多。判据必须是「还在推进吗」。
  test('the maintenance wait fails on a stall, not on a fixed clock', () => {
    const source = readFileSync(
      resolve(ROOT, 'packages/backend/tests/helpers/rfc349PostgresqlHostedEvidence.ts'),
      'utf8',
    )
    const wait = source.slice(source.indexOf('async function waitForMaintenanceJobs'))
    expect(wait).toContain('const STALL_MS')
    expect(wait).toContain('lastProgressAt')
    expect(wait).toContain('PostgreSQL maintenance stalled for')
    // 每一轮的推进签名必须同时看 state 与 slice——只看 state 的话，一个长跑 job 从头到尾
    // 都是 `running`，停滞判据会把「正常推进」误判成卡住。
    expect(wait).toContain('sliceNo')
  })

  // 相位测量一测完就记下来：之前它们是局部变量，任何**之后**的步骤抛错都会把整整 50 分钟
  // 跑出来的证据一起丢掉（实撞：维护等待窗超时，报告里只剩一行 failure、没有相位表）。
  test('a late failure still carries the phase evidence into the report', () => {
    const source = readFileSync(
      resolve(ROOT, 'packages/backend/tests/helpers/rfc349PostgresqlHostedEvidence.ts'),
      'utf8',
    )
    expect(source).toContain('const collectedPhases: RuntimePhaseReport[] = []')
    expect(source).toContain('await recordPhase(collectedPhases, {')
    expect(source).toContain('salvagedRuntimePhases(error)')
    // 三个相位都必须走收集器，漏一个就等于那一相位的证据仍会丢。
    expect(source.split('await recordPhase(collectedPhases, {').length - 1).toBe(3)
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

// 2026-09-03 —— 本机全量取证在 `eventsArchive` 上耗尽 2 小时仍未收敛：harness 自己把
// 归档目标配成「保留 expectedEvents/10」，full 种子就是要归档 900 万行，按实测约 1.1 秒
// 一片（1000 行/片）需要接近 3 小时，而 hosted job 总预算只有 210 分钟。取证要证的是
// 「有界切片推进并收敛」，不是归档 900 万行。
describe('RFC-349 evidence archive workload is bounded', () => {
  test('the full seed archives a bounded slice count, not nine million rows', () => {
    const fullSeedEvents = 10_000_000
    const target = RFC349_EVIDENCE_TIERS.full.archiveTargetRows
    const retained = evidenceArchiveRetainRows(fullSeedEvents, target)
    const archived = fullSeedEvents - retained

    expect(archived).toBe(1_500_000)
    // 1000 行一片 ⇒ 约 1500 片；按实测 ~1.1s/片 约 27 分钟，装得进 hosted 预算。
    expect(archived / 1_000).toBeLessThan(2_000)
    // 仍然要跑满多切片路径，不能退化成一两片。
    expect(archived / 1_000).toBeGreaterThan(500)
  })

  test('a small seed still archives, and never asks to retain less than the floor', () => {
    const target = RFC349_EVIDENCE_TIERS.full.archiveTargetRows
    expect(evidenceArchiveRetainRows(100_000, target)).toBe(1_000)
    expect(evidenceArchiveRetainRows(0, target)).toBe(1_000)
    expect(evidenceArchiveRetainRows(1_500_500, target)).toBe(1_000)
  })

  test('retention grows with the seed once the seed exceeds the target', () => {
    const target = RFC349_EVIDENCE_TIERS.full.archiveTargetRows
    expect(evidenceArchiveRetainRows(4_000_000, target)).toBe(2_500_000)
    expect(evidenceArchiveRetainRows(20_000_000, target)).toBe(18_500_000)
  })
})

// 为什么这组测试存在：full 档一次跑 86–137 分钟，其中 56.8 分钟是搬 1320 万行、
// 14.0 分钟是 1540 片归档（run 33732387691 实测）——两项都只由数据量驱动。周跑改用
// `weekly` 档把 job 压进 30 分钟后，最容易悄悄丢掉的就是「它还是不是同一套判据」：
// 档位一旦被调成单切片归档、或某张表被漏播，取证会在一个变小的语料上照样"通过"。
// 下面逐条锁住：每档的归档仍是多切片、种子计数自洽、weekly 是 full 的十分之一。
describe('RFC-349 evidence tiers keep the same oracles at a smaller workload', () => {
  test('every tier archives across many bounded slices, never one or two', () => {
    for (const [name, tier] of Object.entries(RFC349_EVIDENCE_TIERS)) {
      const archived =
        tier.seed.events - evidenceArchiveRetainRows(tier.seed.events, tier.archiveTargetRows)
      const slices = archived / 1_000
      expect({ name, multiSlice: slices >= 20 }).toEqual({ name, multiSlice: true })
      // 归档量不得超过该档播下去的事件总量，否则这一档根本归档不完、只会耗到停滞判据。
      expect({ name, withinSeed: archived <= tier.seed.events }).toEqual({ name, withinSeed: true })
    }
  })

  test('expected seed counts derive from the tier table, node runs included', () => {
    expect(rfc349ExpectedSeedCounts('full')).toEqual({
      tasks: 100_000,
      nodeRuns: 3_000_000,
      events: 10_000_000,
      webhookDeliveries: 100_000,
      cachedRepos: 500,
    })
    expect(rfc349ExpectedSeedCounts('weekly')).toEqual({
      tasks: 10_000,
      nodeRuns: 300_000,
      events: 1_000_000,
      webhookDeliveries: 10_000,
      cachedRepos: 500,
    })
    for (const scale of ['full', 'weekly', 'small'] as const) {
      const { seed } = RFC349_EVIDENCE_TIERS[scale]
      expect(rfc349ExpectedSeedCounts(scale).nodeRuns).toBe(seed.tasks * seed.runsPerTask)
    }
  })

  // weekly 是周跑实际用的档。它的时间预算由「行数 ÷ 实测吞吐」决定：托管 runner 上
  // 实测过 3874 行/秒（run 33732387691）与 2298 行/秒（run 33743436967 的慢机），
  // 132 万行在慢机上约 9.6 分钟，连同归档 ~3 分钟、三相位 9 分钟、seed 与固定开销，
  // 整个 job 落在 30 分钟内。这条锁住行数上限，防止有人把 weekly 又调回大档。
  test('the weekly tier stays one tenth of full so the hosted job fits its budget', () => {
    const full = rfc349ExpectedSeedCounts('full')
    const weekly = rfc349ExpectedSeedCounts('weekly')
    for (const key of ['tasks', 'events', 'webhookDeliveries'] as const) {
      expect({ key, ratio: full[key] / weekly[key] }).toEqual({ key, ratio: 10 })
    }
    const weeklyRows = weekly.tasks + weekly.nodeRuns + weekly.events + weekly.webhookDeliveries
    // 最慢一次实测 2298 行/秒 ⇒ 132 万行约 9.6 分钟，留足到 12 分钟的上限。
    expect(weeklyRows / 2_298 / 60).toBeLessThan(12)
    // 仍要远大于单元测试的量级，否则证不了「大迁移不冻结主线程」。
    expect(weeklyRows).toBeGreaterThan(1_000_000)
  })

  test('rejects an unknown tier instead of silently seeding the default', () => {
    expect(() => parseRfc349EvidenceArgs(['--scale', 'medium'])).toThrow('--scale must be one of')
    expect(parseRfc349EvidenceArgs(['--scale', 'weekly']).scale).toBe('weekly')
  })
})
