// SOURCE-TEXT GUARDS — design/scheduler-audit-2026-06-10.md S-13 (P2, WP-3)
// （兼锁 S-2 读取侧的修复形态，行为面见
//   scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts。）
//
// 状态（RFC-096 落地后，design/RFC-096-freshest-picker-convergence/design.md）：
//   S-13 审计判死的全部 freshest-run picker fork 已收敛完毕——权威比较器
//   isFresherNodeRun（纯 ULID id 序）与共享 picker pickFreshestRun 移籍
//   freshness.ts 并导出，scheduler.ts 仅保留一行 re-export 兼容层。收敛史：
//     fork #4  scheduler.ts readSnapshotForLatestRun —— RFC-092 整个删除
//              （进程内重试回滚改用 runOneNode 的 `lastFreshSnapshot` 局部 +
//              共享 rollbackNodeRunWorktrees，逐仓读 per-repo map——S-2 的
//              读取单轨半边一并消灭）。
//     fork #5  task.ts retryNode 下游 cascade 的 prev 继承 picker ——
//              RFC-096 改 pickFreshestRun({topLevelOnly:true})；nextRetry
//              保守用全行 max+1（存量病理行的 retryIndex 可能虚高，全行口径
//              零成本规避 UNIQUE 撞车）。
//     fork #6  lifecycleRepair/helpers.ts loadNodeRunsForNode ——
//              RFC-096 直接删除（零调用点的死导出，git 史实证从未被调用）。
//   同批消灭的还有 `desc(nodeRuns.startedAt)` 排序 fork（crossClarify.ts
//   triggerDesignerRerun + scheduler.ts commit&push 归属挑行——NULL startedAt
//   沉底 / mark-running 重写 startedAt 的两类排序漂移，见 design §2/§3.1）。
//
// 终态语义（本文件锁定的 ratchet）：freshest 选行只有一个权威——
//   freshness.ts 的 pickFreshestRun / isFresherNodeRun（纯 id 序 + 显式谓词）。
//   `desc(nodeRuns.retryIndex)` 与 `desc(nodeRuns.startedAt)` 在 src/ 全域
//   清零且不得回归；内存里的 retryIndex 大小比较收敛到唯一白名单形态
//   （task.ts nextRetry 分配器，见 G8）。任何新 fork——哪怕出现在本家族
//   从未听说过的新文件——立即翻红，至少强制 review 看见。
//
// 权威比较器本身（isFresherNodeRun 纯 id 序）的回归防护不在本文件——
//   isfresher-noderun-baseline.test.ts 已用导入函数 + 逐 case 行为断言锁死
//   （含 A6b 对抗边界），比源码文本探针更强；picker 谓词矩阵的行为面见
//   rfc096-pick-freshest.test.ts。此处只做「fork 不得回来」的源码文本兜底。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '..', 'src')

const SCHEDULER_SRC = readFileSync(join(SRC_ROOT, 'services', 'scheduler.ts'), 'utf-8')
const TASK_SRC = readFileSync(join(SRC_ROOT, 'services', 'task.ts'), 'utf-8')
const REPAIR_HELPERS_SRC = readFileSync(
  join(SRC_ROOT, 'services', 'lifecycleRepair', 'helpers.ts'),
  'utf-8',
)
const FRESHNESS_SRC = readFileSync(join(SRC_ROOT, 'services', 'freshness.ts'), 'utf-8')

const FORK_MARKER = 'desc(nodeRuns.retryIndex)'
const STARTED_AT_FORK_MARKER = 'desc(nodeRuns.startedAt)'

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

/** Per-file occurrence inventory of `needle` across every .ts under src/.
 * Keys are paths relative to src/; files with zero hits are omitted, so an
 * all-clear scan compares equal to `{}`. */
function srcInventory(needle: string): Record<string, number> {
  const inventory: Record<string, number> = {}
  for (const entry of readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const abs = join(entry.parentPath, entry.name)
    const n = countOccurrences(readFileSync(abs, 'utf-8'), needle)
    if (n > 0) inventory[relative(SRC_ROOT, abs)] = n
  }
  return inventory
}

describe('S-13 freshest-run comparator forks — source-text guards (all forks converged by RFC-092 + RFC-096; ratchets keep them out)', () => {
  test('G1 fork #4 DELETED (RFC-092) + comparator rehomed (RFC-096): scheduler.ts neither declares nor calls readSnapshotForLatestRun, contains ZERO desc(retryIndex) forks, and only re-exports isFresherNodeRun from freshness.ts', () => {
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
    // RFC-096: the authority now LIVES in freshness.ts; scheduler.ts keeps a
    // one-line compatibility re-export (six test files import it from
    // '../src/services/scheduler' — that surface must not silently vanish)
    // and must NOT re-grow a local declaration that could drift from the
    // shared one.
    expect(FRESHNESS_SRC.includes('export function isFresherNodeRun')).toBe(true)
    expect(FRESHNESS_SRC.includes('export function pickFreshestRun')).toBe(true)
    expect(SCHEDULER_SRC.includes("export { isFresherNodeRun } from '@/services/freshness'")).toBe(
      true,
    )
    expect(SCHEDULER_SRC.includes('export function isFresherNodeRun')).toBe(false)
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
    const rollbackSrc = readFileSync(join(SRC_ROOT, 'services', 'nodeRollback.ts'), 'utf-8')
    expect(rollbackSrc.includes('preSnapshotReposJson')).toBe(true)
    expect(rollbackSrc.includes('resetOnEmptySnapshot')).toBe(true)
    // And the shared module itself never picks rows by retryIndex.
    expect(countOccurrences(rollbackSrc, FORK_MARKER)).toBe(0)
  })

  test('G3 fork #5 FIXED (RFC-096): task.ts retryNode cascade prev-inheritance picks via shared pickFreshestRun (top-level only, pure id order) — desc(retryIndex) is gone from task.ts', () => {
    // Anchor updated by RFC-098 B3 (audit ⑥-11): the targets set is no longer
    // seeded inline with runRow.nodeId — the wrapper-revival carve-out guards
    // the seed (`if (!wrapperRevivalTarget) targets.add(runRow.nodeId)`).
    const cascade = extractSection(
      TASK_SRC,
      'const targets = new Set<string>()',
      "errorMessage: 'queued for retry'",
    )
    // The fork is dead: no retryIndex ordering anywhere in the cascade — nor
    // anywhere else in task.ts (resumeTask was already fixed for this exact
    // bug class, locked by scheduler-boundary-resume-retryindex-vs-id.test.ts;
    // count === 0 keeps BOTH sites from regressing).
    expect(cascade.includes('.orderBy(desc(nodeRuns.retryIndex))')).toBe(false)
    expect(countOccurrences(TASK_SRC, FORK_MARKER)).toBe(0)
    // Positive anchor: the inheritance source is the shared picker with the
    // top-level predicate (a placeholder must never inherit a fan-out child's
    // parentNodeRunId — that made it invisible to the frontier and the
    // cascade silently dead; design §3.2).
    expect(cascade.includes('pickFreshestRun(existing, { topLevelOnly: true })')).toBe(true)
    // nextRetry stays the CONSERVATIVE all-rows max+1 (NOT prev.retryIndex+1):
    // legacy pathological rows minted by the old pickers can carry inflated
    // retryIndex on child/inherited rows; the all-rows max avoids a UNIQUE
    // collision at zero cost. See G8 — this reduce is the single whitelisted
    // in-memory retryIndex comparison in src/.
    expect(
      cascade.includes('existing.reduce((mx, r) => (r.retryIndex > mx ? r.retryIndex : mx), -1)'),
    ).toBe(true)
  })

  // (former G4 — comparator-purity source-text probe — deleted during test
  // review: isfresher-noderun-baseline.test.ts already locks isFresherNodeRun
  // pure-id ordering behaviorally, which is strictly stronger.)

  test('G5 fork #6 DELETED (RFC-096): lifecycleRepair/helpers.ts no longer exports loadNodeRunsForNode (dead export with a desc(retryIndex) ordering) — only the tombstone comment may mention the name', () => {
    // The function was a zero-call-site dead export since its RFC-057
    // introduction; RFC-096 deleted it outright (design §3.5). The bare name
    // inside the tombstone comment is fine — what must never come back is the
    // declaration (or any call form, which would not compile anyway but a
    // copy-paste revert would re-add both at once).
    expect(REPAIR_HELPERS_SRC.includes('export async function loadNodeRunsForNode')).toBe(false)
    expect(REPAIR_HELPERS_SRC.includes('loadNodeRunsForNode(')).toBe(false)
    expect(countOccurrences(REPAIR_HELPERS_SRC, FORK_MARKER)).toBe(0)
  })

  test('G6 whole-src fork inventory: desc(nodeRuns.retryIndex) appears NOWHERE in src/ — the audit ratchet reached its empty end state', () => {
    // The R2 ratchet the audit asks for ("desc(nodeRuns.retryIndex) 不得再出现
    // 在快照/继承路径"), made global: RFC-092 removed the scheduler.ts entry
    // (fork #4), RFC-096 removed task.ts (fork #5) and lifecycleRepair/
    // helpers.ts (fork #6). The inventory is EMPTY and must stay that way —
    // any new fork, in any src file (including ones this family never heard
    // of), flips red immediately.
    expect(srcInventory(FORK_MARKER)).toEqual({})
  })

  test('G7 (RFC-096 §4 new ratchet): desc(nodeRuns.startedAt) appears NOWHERE in src/ — startedAt is not a freshness ordering', () => {
    // startedAt ordering carries two pathologies the id order does not
    // (design §3.1): freshly minted rerun rows never write startedAt (NULL
    // sorts LAST under DESC → the new row is unselectable) and mark-running
    // REWRITES startedAt (a resumed old row jumps to the front). Both former
    // sites are converged onto pickFreshestRun:
    //   - crossClarify.ts triggerDesignerRerun → {topLevelOnly:false} (child
    //     rows stay selectable ON PURPOSE: a designer inside a wrapper-fanout
    //     reruns on shard child rows and must inherit shardKey/parentNodeRunId)
    //   - scheduler.ts maybeRunCommitPush attribution → {topLevelOnly:true}
    //     over a done-only SQL row set.
    // Empty whitelist (design §4 ①) — verified empty at flip time.
    expect(srcInventory(STARTED_AT_FORK_MARKER)).toEqual({})
    // Positive anchors for the two converged call sites (cheap drift probes;
    // behavior is locked by rfc096-designer-rerun-pick.test.ts and the
    // cross-clarify suite).
    const crossClarifySrc = readFileSync(join(SRC_ROOT, 'services', 'crossClarify.ts'), 'utf-8')
    expect(crossClarifySrc.includes('pickFreshestRun(designerRows, { topLevelOnly: false })')).toBe(
      true,
    )
    expect(SCHEDULER_SRC.includes('pickFreshestRun(parentRows, { topLevelOnly: true })')).toBe(true)
  })

  test("G8 (RFC-096 §4 new heuristic ratchet): in-memory 'retryIndex > ' comparisons exist ONLY in the whitelisted files — any new file flips red for review", () => {
    // A picker fork does not need SQL to exist — `rows.reduce(highest
    // retryIndex)` in memory is the same bug (options-T1.ts had exactly that
    // until RFC-096 §3.4 switched it to isFresherNodeRun). This grep is a
    // HEURISTIC: it cannot prove a hit is a freshness pick, so the whitelist
    // is deliberately loose — the goal is that any NEW occurrence at least
    // gets seen in review (design §4 ②). Current baseline, verified at flip
    // time:
    //   - services/task.ts (1): the nextRetry allocator's conservative
    //     all-rows max reduce (G3 pins its exact text). NOT a freshness pick —
    //     it allocates the next UNIQUE retryIndex and intentionally scans ALL
    //     rows including children, never selecting a row to inherit from.
    //   - services/scheduler.ts (1): comment-only ("retryIndex > 0 →
    //     technical retry within same clarify round" — prose explaining
    //     clarify-round semantics, no code).
    // Counts are pinned exactly: a second occurrence inside a whitelisted
    // file also flips red.
    expect(srcInventory('retryIndex > ')).toEqual({
      'services/scheduler.ts': 1,
      'services/task.ts': 1,
    })
  })
})
