// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-13 (P2, WP-3)
// （兼锁 S-2 的「快照写入双轨 / 读取单轨」源码面证据，行为面见
//   scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts。）
//
// 当前缺陷行为（本文件全绿地锁定它）：
//   权威 freshest-run 比较器是纯 ULID id 序（scheduler.ts isFresherNodeRun，
//   :450-456，其 docstring 明确「(retryIndex, id) 被考虑并否决」——retry 风暴
//   可把 stale 行的 retryIndex 抬到比后铸的 clarify rerun 更高）。resumeTask
//   已为同一 bug 修过一次（scheduler-boundary-resume-retryindex-vs-id.test.ts
//   锁住）。但该被判死的 `desc(retryIndex)` 排序仍残留在三处 picker fork：
//     fork #4  scheduler.ts:3791  readSnapshotForLatestRun —— 被进程内重试回滚
//              调用（scheduler.ts:1519）；选错行 = 回滚目标错、工作区被错误覆盖。
//              且它只读 `preSnapshot` 单列（:3793）——多仓行恒得 ''（S-2 的
//              读取单轨半边）。
//     fork #5  task.ts:1178       retryNode 下游 cascade 的 prev 继承 picker ——
//              占位行的 iteration/shardKey/parentNodeRunId/preSnapshot 可能
//              继承自 stale 高-retryIndex 行而非 freshest 行。
//     fork #6  lifecycleRepair/helpers.ts:42  loadNodeRunsForNode ——
//              核实者补充发现（审计报告 S-13 机制段）。
//
// 正确语义应是：freshest 选行收敛为 shared 单函数（pure id 序），
//   `desc(nodeRuns.retryIndex)` 不得再出现在快照/继承/修复路径；
//   readSnapshotForLatestRun 整个删掉（调用方直接传当前行，与 S-2 修复合并）。
//
// 修复落点：WP-3（freshest-run picker 收敛；fork #4 也可能随 WP-1 的 S-2 修复
//   提前消失）。函数未导出 → 无法直测，按源码文本守卫兜底。
// 修复时本文件应翻红：哪个 fork 被消掉，对应计数断言就从 1 掉到 0 ——
//   按各断言旁 [FLIP-ON-FIX] 注释把期望改为 0（或直接删除该守卫），
//   并把 G6 全 src 清单里对应文件的条目移除。
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

describe('S-13 freshest-run comparator forks — source-text guards (CURRENT-BEHAVIOR LOCK)', () => {
  test('G1 fork #4: scheduler.ts readSnapshotForLatestRun still orders by desc(retryIndex) — and it is the ONLY such fork left in scheduler.ts', () => {
    const fn = extractSection(
      SCHEDULER_SRC,
      'async function readSnapshotForLatestRun(',
      // End anchor: the doc comment of the next declaration (unique, verified).
      'RFC-074 PR-C: derive a node_run',
    )
    // The dead-ruled ordering is still here.
    // [FLIP-ON-FIX] WP-3/WP-1: readSnapshotForLatestRun should be deleted
    // outright (callers pass the current row); when that happens extractSection
    // throws → replace G1 with a "marker absent" assertion:
    //   expect(SCHEDULER_SRC.includes('readSnapshotForLatestRun')).toBe(false)
    expect(fn.includes('.orderBy(desc(nodeRuns.retryIndex))')).toBe(true)
    // Exactly ONE retryIndex-ordering fork in scheduler.ts, and it is THIS one
    // (cross-file ratchet lives in G6).
    expect(countOccurrences(SCHEDULER_SRC, FORK_MARKER)).toBe(1)
  })

  test('G2 S-2 read-single-track evidence: readSnapshotForLatestRun reads ONLY the preSnapshot column; preSnapshotReposJson appears in scheduler.ts solely on the WRITE side', () => {
    const fn = extractSection(
      SCHEDULER_SRC,
      'async function readSnapshotForLatestRun(',
      'RFC-074 PR-C: derive a node_run',
    )
    // Single-column read → multi-repo rows (preSnapshot = NULL) yield ''.
    expect(fn.includes('?.preSnapshot ??')).toBe(true)
    // [FLIP-ON-FIX] WP-1: the fixed read path must consult the per-repo map —
    // flip to true (or delete alongside the function).
    expect(fn.includes('preSnapshotReposJson')).toBe(false)
    // Whole-file: exactly ONE preSnapshotReposJson occurrence = the dual-write
    // branch at scheduler.ts:1627. Write side exists, read side doesn't —
    // the structural root of S-2.
    // [FLIP-ON-FIX] WP-1: a read-side occurrence (or shared-helper call) is
    // added → bump/replace this count deliberately.
    expect(countOccurrences(SCHEDULER_SRC, 'preSnapshotReposJson')).toBe(1)
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

  test('G6 whole-src fork inventory: desc(nodeRuns.retryIndex) appears in EXACTLY these three files, once each — no new fork anywhere in src/', () => {
    // The R2 ratchet the audit asks for ("desc(nodeRuns.retryIndex) 不得再出现
    // 在快照/继承路径"), made global: G1/G3/G5 pin each known fork in place;
    // this test makes ANY new fork — in any src file, including ones this
    // family never heard of — flip red immediately.
    // [FLIP-ON-FIX] WP-3/WP-1: as each fork converges onto the shared
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
      'services/scheduler.ts': 1,
      'services/task.ts': 1,
    })
  })
})
