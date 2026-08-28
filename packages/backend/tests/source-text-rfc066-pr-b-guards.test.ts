// RFC-066 PR-B — source-layer guards locking the scheduler / runner / diff /
// rollback wiring against silent regressions. Targets:
//
//   PB-G1: services/scheduler.ts retains the multi-repo wrapper-git defense-
//          in-depth gate keyed by `multi-repo-wrapper-git-unsupported` so a
//          future runTask refactor cannot quietly remove it.
//   PB-G2: services/scheduler.ts threads `state.repos` (NOT a free-floating
//          `repos` variable) into every templateMeta dispatch — anchors the
//          per-repo metadata wiring on SchedulerState as the single source
//          of truth.
//   PB-G3: services/runner.ts cwd is set from `opts.worktreePath` exactly
//          once at the spawn site — guards against an inadvertent switch
//          to `repos[0].worktreePath` (which would break single-repo
//          baseline) or a per-shard cwd injection.
//   PB-G4: services/task.ts `rollbackNodeRunForResume` is the named helper
//          both `resumeTask` and `retryNode` call into. New rollback paths
//          must reuse it; ad-hoc inline rollback in either function is a
//          regression target.
//   PB-G5: services/task.ts diff endpoint branches on `task.repoCount ===
//          1` for the byte-baseline single-repo path and `# === Repo:` for
//          the multi-repo concat header.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf-8',
)
const NODE_MECHANICS_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeMechanics.ts',
  ),
  'utf-8',
)
const RUNNER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
  'utf-8',
)
const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')

describe('RFC-066 PR-B — source guards', () => {
  test('PB-G1（RFC-248 翻转）scheduler 里的多仓 wrapper-git 纵深防御门必须**已删除**', () => {
    // RFC-066 PR-B 加这道门是因为包裹器只对单一 worktree 取快照，多仓下会静默
    // 只看第一个仓。RFC-248 D9 让它逐仓快照、逐仓 diff、按挂载路径前缀化合并，
    // 禁令随之解除——门留着就等于仓库组永远跑不了 Code → Audit → Fix 主链路。
    // 断言翻成「码彻底消失」：留一个就意味着某条路径上禁令还在。
    expect(SCHEDULER_SRC.includes("'multi-repo-wrapper-git-unsupported'")).toBe(false)
    // 正向锚：finalize 确实在逐仓做。
    expect(SCHEDULER_SRC.includes('for (const r of diffableRepos)')).toBe(true)
  })

  test('PB-G2 scheduler threads `state.repos` into every dispatch (via RFC-130 iso creation)', () => {
    const executionSource = `${SCHEDULER_SRC}\n${NODE_MECHANICS_SRC}`
    // RFC-130: the 3 dispatch sites (single-agent, fanout shard, fanout aggregator)
    // no longer pass `state.repos` DIRECTLY into templateMeta — each first builds an
    // ISOLATED worktree from the SchedulerState-owned snapshot
    // (`createNodeIso({ canonRepos: state.repos })`) and then threads the DERIVED iso
    // repos into templateMeta (`<handle>.repos.map(...)`). The snapshot still flows to
    // every dispatch, now through the iso-creation seam. Anchor on both ends.
    const canonMatches = executionSource.match(/canonRepos: state\.repos/g) ?? []
    expect(canonMatches.length).toBeGreaterThanOrEqual(3)
    // RFC-287 T3/T4：两条 fanout 线迁入装配骨架后，句柄在钩子内以局部 `iso` 承接
    // （`const iso = shardIso as IsoHandle`），故变量名不再是 shardIso/aggIso。
    // 本条锁的不变量没变——派发线的 templateMeta 仍**只**来自 iso 句柄派生的 repos，
    // 绝不回退到直接摊 state.repos——所以把匹配面放宽到「任一 iso 句柄变量」，
    // 同时补一条反向锁：templateMeta 里不得直接出现 state.repos.map。
    const isoRepoThreads =
      executionSource.match(/(isoHandle|shardIso|aggIso|iso)\.repos\.map\(/g) ?? []
    expect(isoRepoThreads.length).toBeGreaterThanOrEqual(3)
    expect(executionSource).not.toMatch(/templateMeta:[\s\S]{0,400}state\.repos\.map\(/)
  })

  test('PB-G3 runner cwd is opts.worktreePath at the spawn site exactly', () => {
    // The runner has two `cwd: opts.worktreePath` occurrences — one in the
    // log.info call and one in the Bun.spawn call. Both target the same
    // variable; no path arithmetic like `join(opts.worktreePath, ...)` or
    // `opts.repos[0].worktreePath`. Anchoring on the literal string keeps
    // the rule unambiguous.
    const spawnMatches = RUNNER_SRC.match(/cwd: opts\.worktreePath/g) ?? []
    expect(spawnMatches.length).toBeGreaterThanOrEqual(2)
    // Guard against a future "per-shard cwd" sneaking in.
    expect(/cwd:\s*opts\.repos/.test(RUNNER_SRC)).toBe(false)
    expect(/cwd:\s*\w+\.repos\[/.test(RUNNER_SRC)).toBe(false)
  })

  test('PB-G4 resume + retry rollback funnels through rollbackNodeRunForResume', () => {
    expect(TASK_SRC.includes('async function rollbackNodeRunForResume(')).toBe(true)
    // Both resumeTask and retryNode call into the helper. Match `await
    // rollbackNodeRunForResume(...)` invocations.
    const calls = TASK_SRC.match(/await rollbackNodeRunForResume\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('PB-G5 diff endpoint branches on single vs multi via task.repoCount + `# === Repo:` header', () => {
    expect(TASK_SRC.includes('task.repoCount === 1')).toBe(true)
    // Multi-repo concat uses the stable header literal so the frontend can
    // safely split on it.
    expect(TASK_SRC.includes('# === Repo:')).toBe(true)
  })
})
