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
//   同批消灭的还有 `desc(nodeRuns.startedAt)` 排序 fork（cross-clarify 设计者
//   重跑挑行〔RFC-132 后由 taskQuestionDispatch.ts buildFrontierMintPlan 承接〕
//   + scheduler.ts commit&push 归属挑行——NULL startedAt 沉底 / mark-running
//   重写 startedAt 的两类排序漂移，见 design §2/§3.1）。
//
// 终态语义（本文件锁定的 ratchet）：freshest 选行只有一个权威——
//   freshness.ts 的 pickFreshestRun / isFresherNodeRun（纯 id 序 + 显式谓词）。
//   freshness 路径中的 `desc(nodeRuns.retryIndex)` 与 `desc(nodeRuns.startedAt)`
//   清零且不得回归；前者只允许 `__repo_prep__` 两个因果尝试读取，内存里的
//   retryIndex 大小比较收敛到唯一白名单形态
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

  test('RFC-130 SUPERSEDES S-2 read side: the scheduler retry DISCARDS the failed iso and re-branches (no canonical rollback); nodeRollback.ts stays as resume-path defense-in-depth', () => {
    // RFC-130: the fresh-session retry never wrote the canonical worktree (the
    // failed attempt ran in its own iso), so there is nothing to roll back — the
    // scheduler discards the failed iso and re-branches a fresh one. The old
    // `await rollbackNodeRunWorktrees(...)` + in-process `lastFreshSnapshot` retry
    // machinery is GONE from the scheduler.
    expect(SCHEDULER_SRC.includes('discardNodeIso(')).toBe(true)
    expect(SCHEDULER_SRC.includes('createIsoUnderLock(')).toBe(true)
    expect(SCHEDULER_SRC.includes('createNodeIso(')).toBe(false)
    expect(SCHEDULER_SRC.includes('lastFreshSnapshot')).toBe(false)
    // The shared rollback authority is RETAINED for the RESUME path (D10
    // defense-in-depth) — it still consumes the per-repo map + empty-sha reset
    // switch, and never picks rows by retryIndex.
    const rollbackSrc = readFileSync(join(SRC_ROOT, 'services', 'nodeRollback.ts'), 'utf-8')
    expect(rollbackSrc.includes('preSnapshotReposJson')).toBe(true)
    expect(rollbackSrc.includes('resetOnEmptySnapshot')).toBe(true)
    expect(countOccurrences(rollbackSrc, FORK_MARKER)).toBe(0)
  })

  test('G3 fork #5 FIXED (RFC-096): retryNode cascade uses shared pickFreshestRun and contains no desc(retryIndex)', () => {
    // Anchor updated by RFC-098 B3 (audit ⑥-11): the targets set is no longer
    // seeded inline with runRow.nodeId — the wrapper-revival carve-out guards
    // the seed (`if (!wrapperRevivalTarget) targets.add(runRow.nodeId)`).
    const cascade = extractSection(
      TASK_SRC,
      'const targets = new Set<string>()',
      "errorMessage: 'queued for retry'",
    )
    // The fork is dead: no retryIndex ordering anywhere in the cascade — nor
    // in this cascade. Repository-preparation attempts are a separate causal
    // sequence and their exact two allowed reads are pinned by G6 below.
    expect(cascade.includes('.orderBy(desc(nodeRuns.retryIndex))')).toBe(false)
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
    // RFC-284 T21 改锚：max-scan 分配器收编 nodeRunMint.nextRetryIndex（默认口径
    // = 全行集、刻意含 child rows——与原 reduce 语义逐值相同，见其头注）。意图
    // 不变：cascade 仍是「分配下一个唯一 retryIndex」而非 freshness pick。
    expect(cascade.includes('nextRetryIndex(existing)')).toBe(true)
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

  test('G6 whole-src fork inventory: desc(nodeRuns.retryIndex) exists only on the two __repo_prep__ causal-order reads', () => {
    // The R2 ratchet the audit asks for ("desc(nodeRuns.retryIndex) 不得再出现
    // 在快照/继承路径"), made global: RFC-092 removed the scheduler.ts entry
    // (fork #4), RFC-096 removed task.ts (fork #5) and lifecycleRepair/
    // helpers.ts (fork #6). RFC-287 later added two intentional repository-
    // preparation reads: prep retries have a strictly increasing retryIndex
    // and no clarify/parent/iteration fork, so causal order is the contract.
    // The scoped regex proves both occurrences are tied to __repo_prep__ and
    // the exact inventory makes any third occurrence flip red.
    const prepCausalReads = TASK_SRC.match(
      /eq\(nodeRuns\.nodeId, REPO_PREP_NODE_ID\)\)\)\s*\.orderBy\(desc\(nodeRuns\.retryIndex\), desc\(nodeRuns\.id\)\)/g,
    )
    expect(prepCausalReads).toHaveLength(2)
    expect(srcInventory(FORK_MARKER)).toEqual({ 'services/task.ts': 2 })
  })

  test('G7 (RFC-096 §4 new ratchet): desc(nodeRuns.startedAt) appears NOWHERE in src/ — startedAt is not a freshness ordering', () => {
    // startedAt ordering carries two pathologies the id order does not
    // (design §3.1): freshly minted rerun rows never write startedAt (NULL
    // sorts LAST under DESC → the new row is unselectable) and mark-running
    // REWRITES startedAt (a resumed old row jumps to the front). Both former
    // sites are converged onto pickFreshestRun:
    //   - the clarify-rerun mint anchor (RFC-132: taskQuestionDispatch.ts
    //     buildFrontierMintPlan) → {topLevelOnly:false} (child rows stay
    //     selectable ON PURPOSE: a designer inside a wrapper-fanout reruns on
    //     shard child rows and must inherit shardKey/parentNodeRunId). RFC-172
    //     (route 2) filters that run set to the dispatch shard first (`scoped`;
    //     === targetRuns when shardKey undefined) — still pickFreshestRun, not
    //     a startedAt fork.
    //   - scheduler.ts maybeRunCommitPush attribution → {topLevelOnly:true}
    //     over a done-only SQL row set.
    // Empty whitelist (design §4 ①) — verified empty at flip time.
    expect(srcInventory(STARTED_AT_FORK_MARKER)).toEqual({})
    // Positive anchors for the two converged call sites (cheap drift probes;
    // behavior is locked by rfc096-designer-rerun-pick.test.ts and the
    // cross-clarify suite).
    const dispatchSrc = readFileSync(join(SRC_ROOT, 'services', 'taskQuestionDispatch.ts'), 'utf-8')
    // RFC-172 (route 2, S3): the inheritance source is now `scoped` (targetRuns filtered to the
    // dispatch shard for workgroup members; === targetRuns when shardKey is undefined). Still
    // pickFreshestRun + {topLevelOnly:false} — the freshness comparator, NOT a startedAt fork.
    expect(dispatchSrc.includes('pickFreshestRun(scoped, { topLevelOnly: false })')).toBe(true)
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
    //   - services/scheduler.ts: 0 since RFC-098 WP-10 — its only occurrence
    //     was comment-only prose ("retryIndex > 0 → technical retry within
    //     same clarify round") teaching the old gate-2 retryIndex proxy; the
    //     gate now switches on node_runs.rerun_cause and the prose went with
    //     it (ratchet tightened).
    // Counts are pinned exactly: a second occurrence inside a whitelisted
    // file also flips red.
    // RFC-284 T21（2026-08-12）：七处手写分配器收编 nodeRunMint.nextRetryIndex，
    // task.ts 的 reduce 随之归零；唯一的 in-memory `retryIndex > ` 比较现在
    // 就是唯一实现内部的 max-scan（非 freshness pick——它分配下一个唯一
    // retryIndex，口径见其头注与 node-run-mint.test.ts 的矩阵/结构锁）。
    // RFC-287 五轮门（2026-08-14）新增 `services/task.ts: 1`——`__repo_prep__` 的
    // 「有没有更新的准备尝试」门。**经 review 判定它不是 freshness pick**：该子系统
    // 没有 clarify / parent / iteration 分叉（那才是当年把全仓收敛到 id 序的原因），
    // 其 `retryIndex` 由 `nextRetryIndex` 严格递增分配、就是因果尝试序。
    // 反证也有：一度按本 ratchet 的字面要求改用 id 序比较器，结果实测 `nodeRunMint`
    // 用的是普通 `ulid()`（非 monotonicFactory），同毫秒 2000 对里 989 对逆序 ⇒ 同毫秒
    // 铸出的两条准备行会被判反、两边都点不动。ratchet 的价值在这次兑现了：它逼出了
    // 这场 review，而 review 的结论是「本处该用 retryIndex」——白名单正是为此存在
    //（本条注释上方原话：whitelist 刻意宽松，目标是任何新出现的至少被 review 看见）。
    expect(srcInventory('retryIndex > ')).toEqual({
      'services/nodeRunMint.ts': 1,
      'services/task.ts': 1,
    })
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// `srcInventory` 用 `readdirSync(SRC_ROOT, { recursive: true })` 扫全树后按 needle 计数；
// `SRC_ROOT` 一旦失效，每个 needle 都会返回 `{}`，而「某调用点已消失」类断言恰恰以
// 空结果为通过。这一条把「树还在」变成可断言事实。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    const files = readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts'),
    )
    expect(files.length).toBeGreaterThanOrEqual(300)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的源码喂给**扫描用的同一份计数判据**。
//
// 本文件的断言形态是「某标记在 scheduler.ts 里恰好出现 N 次」。计数判据一旦失效
// （比如 `indexOf` 的步进写错、把重叠出现算漏），期望值会被同批「顺手对齐」到新的
// 错误值上，从此双方一起说谎。这里把计数语义本身钉死。
describe('RFC-317 T14 —— matcher 自证：计数判据的语义', () => {
  test('不重叠计数：出现几次数几次', () => {
    const fabricated =
      'const a = freshestForkSnapshot(run)\n' +
      'const b = freshestForkSnapshot(other)\n' +
      '// freshestForkSnapshot 在注释里也算一次（判据是纯文本计数，不剥注释）\n'
    expect(countOccurrences(fabricated, 'freshestForkSnapshot')).toBe(3)
  })

  test('零出现返回 0，且不会把子串数错', () => {
    expect(countOccurrences('const x = 1\n', 'freshestForkSnapshot')).toBe(0)
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
  })
})
