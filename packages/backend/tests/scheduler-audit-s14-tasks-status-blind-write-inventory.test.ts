// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-14 (WP-4)
//
// 当前缺陷行为：tasks.status 的写点全部是非 CAS 盲写（`db.update(tasks).set(…)`
// 直写，无转移表、无 from-状态校验），与 node_runs 侧 RFC-053 的三件套治理
// （转移表 + transitionNodeRunStatus CAS + lifecycle-grep-guard）完全不对称。
// 已命名的互踩窗口：runTask 无条件写 running 可复活已 canceled 任务
// （scheduler.ts:262，由 scheduler-audit-s08-*.test.ts 行为级锁定）；最后一轮
// 检查后到达的 abort 被 done 覆盖；limits 在 cancel 失败后仍覆写 errorSummary。
//
// 本守卫按报告"普查口径"（27 处 / 15 文件，含个别非 status 字段的 update(tasks)
// 写点——它们同样在 WP-4 收口范围内）锁定全量 `.update(tasks)` 写点清单：
// 任何新文件出现写点、或既有文件写点数上升，本测试即红——新写点的作者必须
// 有意识地决定"这真的需要一个新的盲写吗"，并把决定记录在此清单旁。
//
// 正确语义：复制 RFC-053 模式——shared `nextTaskStatus` 转移表 +
// `transitionTaskStatus` CAS + ESLint/grep 直写禁令；终态写点一律要求
// from ∈ 非终态集合。
//
// 修复落点：WP-4。修复时本文件应翻红，处置方式：
//   - `no task-level CAS helper exists yet` 用例在 transitionTaskStatus 落地时
//     自然翻红 → 删除该用例；
//   - 清单用例改写为 lifecycle-grep-guard.test.ts 同款 allowlist 守卫
//     （只允许 task-lifecycle 模块直写 tasks.status，其余文件清零）。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of content.split('\n')) {
    if (isCommentLine(line)) continue
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

/**
 * 调研基线（HEAD f9db99f 附近）的 `.update(tasks)` 普查清单：27 处 / 15 文件。
 * 与报告 S-14 + 附录 A "architecture：tasks.status 27 写点普查" 口径一致。
 */
const EXPECTED_UPDATE_TASKS_SITES: Record<string, number> = {
  'services/lifecycleRepair/options-CR1.ts': 1,
  'services/lifecycleRepair/options-R1.ts': 1,
  'services/lifecycleRepair/options-R2.ts': 1,
  'services/lifecycleRepair/options-S1.ts': 1,
  'services/lifecycleRepair/options-S2.ts': 1,
  'services/lifecycleRepair/options-S3.ts': 4,
  'services/lifecycleRepair/options-S4.ts': 2,
  'services/lifecycleRepair/options-T1.ts': 1,
  'services/lifecycleRepair/options-T2.ts': 1,
  'services/lifecycleRepair/options-T3.ts': 2,
  'services/limits.ts': 1,
  'services/orphans.ts': 1,
  'services/scheduler.ts': 6,
  'services/shutdown.ts': 1,
  'services/task.ts': 3,
}

describe('S-14 guard: `.update(tasks)` blind-write inventory in packages/backend/src', () => {
  test('exactly 27 write points across 15 known files — any new file or extra site turns this red', () => {
    const actual: Record<string, number> = {}
    for (const file of walkTsFiles(BACKEND_SRC)) {
      const count = countNonCommentMatches(
        readFileSync(file, 'utf8'),
        /\.update\s*\(\s*tasks\s*\)/g,
      )
      if (count > 0) {
        actual[relative(BACKEND_SRC, file).split(sep).join('/')] = count
      }
    }
    // 红了怎么办：优先不要新增盲写——等待/推动 WP-4 的 transitionTaskStatus；
    // 确属必要的新写点要在上方清单登记并附一行"为什么这里可以盲写"的理由。
    expect(actual).toEqual(EXPECTED_UPDATE_TASKS_SITES)

    const total = Object.values(actual).reduce((a, b) => a + b, 0)
    expect(total).toBe(27)
  })

  test('characterization: no task-level CAS helper exists yet (nextTaskStatus / transitionTaskStatus zero hits)', () => {
    // FLIP (WP-4): transitionTaskStatus/nextTaskStatus 落地时本用例翻红——
    // 这是预期信号：删除本用例，并把上面的清单守卫改写为 allowlist
    // （仅 task-lifecycle 模块允许直写，参照 lifecycle-grep-guard.test.ts）。
    let hits = 0
    for (const file of walkTsFiles(BACKEND_SRC)) {
      hits += countNonCommentMatches(
        readFileSync(file, 'utf8'),
        /\b(?:nextTaskStatus|transitionTaskStatus)\b/g,
      )
    }
    expect(hits).toBe(0)
  })
})
