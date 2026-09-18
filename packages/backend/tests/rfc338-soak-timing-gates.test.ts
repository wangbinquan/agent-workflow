// RFC-338 —— maintenance soak 的 SQLite 计时判据必须有判别力：卡住真回归，放过 runner 抖动。
//
// 由来：`scripts/rfc338-maintenance-soak.ts` 的语句判据早在 2026-09-01~02 就因为
// 「单样本尾部门在共享 runner 上测的是抖动」被改造过（详见该文件里那段注释列出的
// 五次互不相关的红），但**事务那一半漏改**，仍留着 `95% <=50ms` + `单条 < 250ms`
// 的旧形状。于是同一类抖动继续在事务这一格红，且连红两次都不是产品回归：
//
//   · `a889b978c`（run 35209174566）纯 runner 冻结：92 个事务里 1 条 565.8ms。
//     同一场的语句样本（8005 条、over250=3=0.04%、max 560.6ms）被**已改造过**的
//     语句三条判据照常放绿——同一次冻结，两种量法，只有旧形状的那一半判红。
//   · `934c31af9`（run 35385151206）红的原因是 runner **变快了**：事务样本池就是
//     维护 slice 池，而 webhookDeliveryGc 的 slice 分两相（先 ~101 轮 body 相
//     UPDATE，越界后才进 row 相 1000 行批删）。绿的几次只跑到 91~93 个 slice、
//     全在 body 相、max 17~19ms；这次跑到 125 个、跨界删了 25000 行，9/126 越
//     50ms 就红了。必然跨界跑满 202 个 slice 的夜跑档反倒绿（max 96.2ms）。
//
// 本文件用上面三次**真实跑的报告原数**（artifact 里的 sqlite.statements /
// sqlite.transactions）把改造后的判据钉住：抖动与相位边界放绿、真慢与真冻结判红。
// 任何未来改动一旦让这三组真实样本重新变红，就是把这条门又退回抖动检测器。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { sqliteTimingFailures, type TimingSummary } from '../../../scripts/rfc338-maintenance-soak'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

/** 按「多少条越线」反推出判据读的那两个比例，避免测试里手写易错的小数。 */
function summary(input: {
  count: number
  maxMs: number
  over50: number
  over250: number
}): TimingSummary {
  const le50Ratio = input.count === 0 ? 1 : (input.count - input.over50) / input.count
  const le250Ratio = input.count === 0 ? 1 : (input.count - input.over250) / input.count
  return {
    count: input.count,
    maxMs: input.maxMs,
    le50Ratio,
    le250Ratio,
    p95UpperBoundMs: le50Ratio >= 0.95 ? 50 : le250Ratio >= 0.95 ? 250 : null,
  }
}

/** 三次真实跑的原数（artifact rfc338-maintenance-soak.json 的 sqlite 段）。 */
const REAL_RUNS = {
  // run 35209174566 —— 旧门判红，实为 runner 冻结
  a889b978c: {
    statements: summary({ count: 8005, maxMs: 560.6, over50: 95, over250: 3 }),
    transactions: summary({ count: 92, maxMs: 565.8, over50: 8, over250: 1 }),
  },
  // run 35385151206 —— 旧门判红，实为跨过 GC 相位边界（runner 更快）
  '934c31af9': {
    statements: summary({ count: 7842, maxMs: 238.3, over50: 77, over250: 0 }),
    transactions: summary({ count: 126, maxMs: 149.7, over50: 9, over250: 0 }),
  },
  // run 35329396207 —— 夜跑档，必然跨界，旧门下也是绿
  'f2e062092-nightly': {
    statements: summary({ count: 74036, maxMs: 354.3, over50: 178, over250: 3 }),
    transactions: summary({ count: 203, maxMs: 96.2, over50: 2, over250: 0 }),
  },
  // run 35379907049 —— push 档典型绿：93 个 slice 全在 body 相，删 0 行
  '04a6535a4': {
    statements: summary({ count: 8311, maxMs: 105.5, over50: 40, over250: 0 }),
    transactions: summary({ count: 94, maxMs: 17.4, over50: 0, over250: 0 }),
  },
} as const

describe('RFC-338 soak SQLite timing gates', () => {
  test('每一次真实跑（含两次旧门判红的）在改造后的判据下都是绿的', () => {
    for (const [sha, report] of Object.entries(REAL_RUNS)) {
      expect(`${sha}: ${JSON.stringify(sqliteTimingFailures(report))}`).toBe(`${sha}: []`)
    }
  })

  test('单条事务越 1s 才算真冻结——565.8ms 放绿，1200ms 判红', () => {
    const base = REAL_RUNS.a889b978c
    expect(sqliteTimingFailures(base)).toEqual([])
    const frozen = {
      statements: base.statements,
      transactions: summary({ count: 92, maxMs: 1_200, over50: 8, over250: 1 }),
    }
    expect(sqliteTimingFailures(frozen)).toEqual(['SQLite transaction max 1200.0ms >= 1000ms'])
  })

  test('一片事务越 250ms 才算真慢：整片 row 相 slice 被推过 250ms 就判红', () => {
    // 回归形态：125 个 slice 里越界后那 24 个批删全部劣化到 400ms。
    const regressed = {
      statements: REAL_RUNS['934c31af9'].statements,
      transactions: summary({ count: 126, maxMs: 400, over50: 24, over250: 24 }),
    }
    expect(sqliteTimingFailures(regressed)).toEqual([
      'SQLite transactions over 250ms exceeded 2% (24/126)',
    ])
  })

  test('百来条的样本池里「一片」有绝对条数下限，1~2 条抖动不算一片', () => {
    const statements = REAL_RUNS.a889b978c.statements
    for (const over250 of [1, 2]) {
      const jitter = {
        statements,
        transactions: summary({ count: 92, maxMs: 600, over50: 8, over250 }),
      }
      expect(`over250=${over250}: ${JSON.stringify(sqliteTimingFailures(jitter))}`).toBe(
        `over250=${over250}: []`,
      )
    }
    const band = {
      statements,
      transactions: summary({ count: 92, maxMs: 600, over50: 8, over250: 3 }),
    }
    expect(sqliteTimingFailures(band)).toEqual([
      'SQLite transactions over 250ms exceeded 2% (3/92)',
    ])
  })

  test('语句那三条判据行为不变：0.04% 越 250ms 放绿、0.2% 判红、单条越 1s 判红', () => {
    expect(sqliteTimingFailures(REAL_RUNS['f2e062092-nightly'])).toEqual([])
    const band = {
      statements: summary({ count: 8000, maxMs: 300, over50: 95, over250: 16 }),
      transactions: REAL_RUNS['04a6535a4'].transactions,
    }
    expect(sqliteTimingFailures(band)).toEqual([
      'SQLite statements over 250ms exceeded 0.1% (0.20% over, count=8000)',
    ])
    const frozen = {
      statements: summary({ count: 8000, maxMs: 1_500, over50: 95, over250: 1 }),
      transactions: REAL_RUNS['04a6535a4'].transactions,
    }
    expect(sqliteTimingFailures(frozen)).toEqual(['SQLite statement max 1500.0ms >= 1000ms'])
    const p95 = {
      statements: summary({ count: 8000, maxMs: 200, over50: 800, over250: 0 }),
      transactions: REAL_RUNS['04a6535a4'].transactions,
    }
    expect(sqliteTimingFailures(p95)).toEqual(['SQLite statement p95 exceeded 50ms (90.0% <=50ms)'])
  })

  test('计时样本完全没采到仍然判红（门不许因为无样本而空转放绿）', () => {
    const empty = {
      statements: summary({ count: 0, maxMs: 0, over50: 0, over250: 0 }),
      transactions: summary({ count: 0, maxMs: 0, over50: 0, over250: 0 }),
    }
    expect(sqliteTimingFailures(empty)).toEqual(['no Worker SQLite statement timings recorded'])
  })

  test('soak 脚本的入口被 import.meta.main 守着——本文件 import 它不会把 soak 跑起来', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/rfc338-maintenance-soak.ts'), 'utf8')
    expect(source).toContain('if (import.meta.main) {')
    // 裸 `await main()` 一旦回来，这个测试文件的 import 就会真的起一次 daemon。
    const bare = source.split(/\r?\n/).filter((line) => /^await main\(\)/.test(line))
    expect(bare).toEqual([])
  })
})
