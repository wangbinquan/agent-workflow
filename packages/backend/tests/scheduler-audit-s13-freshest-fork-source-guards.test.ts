// SOURCE-TEXT GUARDS — design/scheduler-audit-2026-06-10.md S-13 (P2, WP-3)
// （兼锁 S-2 读取侧的修复形态，行为面见
//   scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts。）
//
// 状态（RFC-092 落地后，design/RFC-092-scheduler-p0-stopgap/design.md §2）：
//   权威 freshest-run 比较器是纯 ULID id 序（scheduler.ts isFresherNodeRun，
//   其 docstring 明确「(retryIndex, id) 被考虑并否决」——retry 风暴可把 stale
//   行的 retryIndex 抬到比后铸的 clarify rerun 更高）。resumeTask 已为同一
//   bug 修过一次（scheduler-boundary-resume-retryindex-vs-id.test.ts 锁住）。
//   被判死的 `desc(retryIndex)` picker fork 原有三处，现状分两档锁定：
//     fork #4  scheduler.ts readSnapshotForLatestRun —— ✅ RFC-092 已整个删除
//              （进程内重试回滚改用 runOneNode 的 `lastFreshSnapshot` 局部 +
//              共享 rollbackNodeRunWorktrees，逐仓读 per-repo map——S-2 的
//              读取单轨半边一并消灭）。G1/G2 翻转为「不得回来」守卫。
//     fork #5  task.ts retryNode 下游 cascade 的 prev 继承 picker ——
//              仍在（WP-3 待办）：占位行的 iteration/shardKey/parentNodeRunId/
//              preSnapshot 可能继承自 stale 高-retryIndex 行而非 freshest 行。
//     fork #6  lifecycleRepair/helpers.ts loadNodeRunsForNode ——
//              仍在（WP-3 待办；核实者补充发现，审计报告 S-13 机制段）。
//
// 终态语义：freshest 选行收敛为 shared 单函数（pure id 序），
//   `desc(nodeRuns.retryIndex)` 不得再出现在快照/继承/修复路径。
//
// 剩余修复落点：WP-3（fork #5/#6 收敛）。函数未导出 → 无法直测，按源码文本
//   守卫兜底。后续每消掉一个 fork：按 G3/G5 旁 [FLIP-ON-FIX] 注释把期望改为 0
//   （或直接删除该守卫），并把 G6 全 src 清单里对应文件的条目移除
//   （scheduler.ts 的条目已随 RFC-092 移除）。
//
// 权威比较器本身（isFresherNodeRun 纯 id 序）的回归防护不在本文件——
//   isfresher-noderun-baseline.test.ts 已用导入函数 + 逐 case 行为断言锁死
//   （含 A6b 对抗边界），比源码文本探针更强；此处不再重复（检视时删除了
//   曾经的文本版 G4，避免 WP-3 把比较器移入 shared 模块时误翻"永久守卫"）。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf-8',
)
const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')
const REPAIR_HELPERS_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'lifecycleRepair', 'helpers.ts'),
  'utf-8',
)

const FORK_MARKER = 'desc(nodeRuns.retryIndex)'

function countOccurrences(src: string, needle: string): number {
  let n = 0
  let i = src.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = src.indexOf(needle, i + needle.length)
  }
  return n
}

/** Substring between startMarker (inclusive) and the first endMarker after it.
 * Throws loudly when the source structure changed — same pattern as
 * source-text-rfc066-guards.test.ts. */
function extractSection(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}

describe('S-13 freshest-run comparator forks — source-text guards (fork #4 deleted by RFC-092; #5/#6 still locked)', () => {
  test('G1 fork #4 DELETED (RFC-092): scheduler.ts neither declares nor calls readSnapshotForLatestRun, and contains ZERO desc(retryIndex) ordering forks', () => {
    // The function was deleted outright — the retry rollback now passes the
    // in-process `lastFreshSnapshot` straight to the shared rollback (see G2).
    // The NAME may legitimately survive inside explanatory comments (the
    // tombstone note at the old declaration site); what must never come back
    // is the declaration or a call site.
    expect(SCHEDULER_SRC.includes('async function readSnapshotForLatestRun(')).toBe(false)
    expect(SCHEDULER_SRC.includes('await readSnapshotForLatestRun(')).toBe(false)
    // ZERO retryIndex-ordering forks left in scheduler.ts (cross-file ratchet
    // lives in G6).
    expect(countOccurrences(SCHEDULER_SRC, FORK_MARKER)).toBe(0)
  })

  test('G2 S-2 read side FIXED (RFC-092): the retry rollback goes through shared rollbackNodeRunWorktrees with the in-process lastFreshSnapshot; the per-repo map read lives in nodeRollback.ts', () => {
    // The scheduler retry path calls the shared multi-repo-aware rollback…
    expect(SCHEDULER_SRC.includes('await rollbackNodeRunWorktrees(')).toBe(true)
    // …passing the snapshot of the most recent FRESH-SESSION attempt held in
    // memory (a followup attempt's snapshot-less row can no longer shadow the
    // real baseline — S-2b).
    expect(SCHEDULER_SRC.includes('lastFreshSnapshot')).toBe(true)
    // The shared authority consumes the per-repo map — the read side S-2
    // lacked — and carries the empty-sha reset switch.
    const rollbackSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'nodeRollback.ts'),
      'utf-8',
    )
    expect(rollbackSrc.includes('preSnapshotReposJson')).toBe(true)
    expect(rollbackSrc.includes('resetOnEmptySnapshot')).toBe(true)
    // And the shared module itself never picks rows by retryIndex.
    expect(countOccurrences(rollbackSrc, FORK_MARKER)).toBe(0)
  })

  test('G3 fork #5: task.ts retryNode cascade prev-inheritance picker still orders by desc(retryIndex) — the ONLY such fork left in task.ts', () => {
    const cascade = extractSection(
      TASK_SRC,
      'const targets = new Set<string>([runRow.nodeId])',
      "errorMessage: 'queued for retry'",
    )
    // [FLIP-ON-FIX] WP-3: prev inheritance must pick by id order (the
    // isFresherNodeRun authority) → flip to false / re-anchor on the shared
    // picker call.
    expect(cascade.includes('.orderBy(desc(nodeRuns.retryIndex))')).toBe(true)
    expect(countOccurrences(TASK_SRC, FORK_MARKER)).toBe(1)
    // resumeTask itself was already fixed for this exact bug class (locked by
    // scheduler-boundary-resume-retryindex-vs-id.test.ts): its picker must NOT
    // regress back to retryIndex comparison. Anchor: the fixed selection uses
    // isFresherNodeRun semantics (id order). We assert the fixed marker exists
    // outside the cascade section by checking the file imports/contains the
    // id-order pick — cheapest robust probe: the cascade fork above is the
    // ONLY retryIndex ordering in the file (count === 1, asserted).
  })

  // (former G4 — comparator-purity source-text probe — deleted during test
  // review: isfresher-noderun-baseline.test.ts already locks isFresherNodeRun
  // pure-id ordering behaviorally, which is strictly stronger.)

  test('G5 fork #6: lifecycleRepair/helpers.ts loadNodeRunsForNode still orders by desc(retryIndex)', () => {
    // Verified against source (helpers.ts:42) per the audit's S-13 机制段
    // ("核实者另发现 lifecycleRepair 中还有第 6 处"). Repair preflights that
    // treat rows[0] as "latest" inherit the same retry-storm shadowing bug.
    // [FLIP-ON-FIX] WP-3: converge onto the shared freshest picker → flip to 0.
    const fn = extractSection(
      REPAIR_HELPERS_SRC,
      'export async function loadNodeRunsForNode(',
      'export async function loadAllNodeRunsForTask(',
    )
    expect(fn.includes('.orderBy(desc(nodeRuns.retryIndex))')).toBe(true)
    expect(countOccurrences(REPAIR_HELPERS_SRC, FORK_MARKER)).toBe(1)
  })

  test('G6 whole-src fork inventory: desc(nodeRuns.retryIndex) appears in EXACTLY these two files, once each — no new fork anywhere in src/', () => {
    // The R2 ratchet the audit asks for ("desc(nodeRuns.retryIndex) 不得再出现
    // 在快照/继承路径"), made global: G3/G5 pin each remaining fork in place;
    // this test makes ANY new fork — in any src file, including ones this
    // family never heard of — flip red immediately.
    // RFC-092 removed the scheduler.ts entry (fork #4 / readSnapshotForLatestRun).
    // [FLIP-ON-FIX] WP-3: as each remaining fork converges onto the shared
    // freshest picker, remove its entry here; end state is an empty inventory.
    const srcRoot = resolve(import.meta.dir, '..', 'src')
    const inventory: Record<string, number> = {}
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const abs = join(entry.parentPath, entry.name)
      const n = countOccurrences(readFileSync(abs, 'utf-8'), FORK_MARKER)
      if (n > 0) inventory[relative(srcRoot, abs)] = n
    }
    expect(inventory).toEqual({
      'services/lifecycleRepair/helpers.ts': 1,
      'services/task.ts': 1,
    })
  })
})
