import {
  FANOUT_AGGREGATOR_SOURCE,
  FANOUT_SHARD_SOURCE,
  AGENT_NODE_SOURCE,
  AGENT_BINDING_SOURCE,
  AGENT_MECHANICS_SOURCE,
} from './helpers/executionMechanismSources'
import { readTaskAgentSources } from './helpers/taskAgentSource'
// RFC-066 PR-B — source-layer guards locking wrapper mechanics / runner / diff /
// rollback wiring against silent regressions. Targets:
//
//   PB-G1: wrapperMechanics.ts retains the multi-repo wrapper-git defense-
//          in-depth gate keyed by `multi-repo-wrapper-git-unsupported` so a
//          future runTask refactor cannot quietly remove it.
//   PB-G2: wrapperMechanics.ts threads `state.repos` (NOT a free-floating
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
//   PB-G5: the task diff projection branches on
//          `isSingleRootRepository(task.repos.map((repo) => repo.mountPath))` for the
//          byte-baseline single-repo path and `# === Repo:` for the multi-repo
//          concat header (RFC-359 AC-1 起它是两个引擎共用的 `taskDiffProjection`,
//          锚见 TASK_DIFF_SRC).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

// RFC-413: the wrapper workspace (per-repository changed files) and the wrapper iso create moved from
// composition/wrapperMechanics.ts into engine/wrapper/wrapperWorkspace.ts and engine/kernel/wrapperIsolation.ts;
// the scan covers the binding and both owners.
const WRAPPER_MECHANICS_SRC = [
  ['composition', 'wrapperMechanics.ts'],
  ['engine', 'wrapper', 'wrapperWorkspace.ts'],
  ['engine', 'kernel', 'wrapperIsolation.ts'],
]
  .map((segments) =>
    readFileSync(
      resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', ...segments),
      'utf-8',
    ),
  )
  .join('\n')
// RFC-405 / RFC-406: both agent-executor lanes (and their binding) left nodeMechanics.ts.
const NODE_MECHANICS_SRC = AGENT_MECHANICS_SOURCE
const RUNNER_SRC = readTaskAgentSources()
const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')
const RESUME_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '../src/modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts',
  ),
  'utf-8',
)
const ROUTE_OPERATIONS_SRC = readFileSync(
  resolve(import.meta.dir, '../src/modules/task-execution/infrastructure/taskRouteOperations.ts'),
  'utf-8',
)
// RFC-359 AC-1：PB-G5 盯的那段搬了家——纯读三件两个引擎合一之后，任务 diff 的拼装是
// `taskDiffProjection`，住在 task-execution 的共用实现文件里（文件名带 `postgresql` 前缀是
// 待还的命名债，见 RFC-359 plan §5hj——它现在是两个引擎共用的那一份）。
// **本条按文件路径读源码，搬家必须同步改锚**，否则它会以「格式变了」的名义红。
const TASK_DIFF_SRC = readFileSync(
  resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'infrastructure',
    'taskRouteOperations.ts',
  ),
  'utf-8',
)

describe('RFC-066 PR-B — source guards', () => {
  test('PB-G1（RFC-248 翻转）scheduler 里的多仓 wrapper-git 纵深防御门必须**已删除**', () => {
    // RFC-066 PR-B 加这道门是因为包裹器只对单一 worktree 取快照，多仓下会静默
    // 只看第一个仓。RFC-248 D9 让它逐仓快照、逐仓 diff、按挂载路径前缀化合并，
    // 禁令随之解除——门留着就等于仓库组永远跑不了 Code → Audit → Fix 主链路。
    // 断言翻成「码彻底消失」：留一个就意味着某条路径上禁令还在。
    expect(WRAPPER_MECHANICS_SRC.includes("'multi-repo-wrapper-git-unsupported'")).toBe(false)
    // 正向锚：finalize 确实在逐仓做。
    expect(WRAPPER_MECHANICS_SRC.includes('for (const repo of diffableRepos(scene))')).toBe(true)
  })

  test('PB-G2 scheduler threads `state.repos` into every dispatch (via RFC-130 iso creation)', () => {
    // RFC-407: the fan-out shard / aggregator dispatch lines left wrapperMechanics.ts for
    // engine/node/agent-single/.
    const executionSource = `${WRAPPER_MECHANICS_SRC}\n${FANOUT_SHARD_SOURCE}\n${FANOUT_AGGREGATOR_SOURCE}\n${NODE_MECHANICS_SRC}`
    // RFC-130: the 3 dispatch sites (single-agent, fanout shard, fanout aggregator)
    // no longer pass `state.repos` DIRECTLY into templateMeta — each first builds an
    // ISOLATED worktree from the SchedulerState-owned snapshot
    // (`createNodeIso({ canonRepos: state.repos })`) and then threads the DERIVED iso
    // repos into templateMeta (`<handle>.repos.map(...)`). The snapshot still flows to
    // every dispatch, now through the iso-creation seam. Anchor on both ends.
    // RFC-405 / RFC-407: the three dispatch lines now build their iso through the agent binding's one
    // `createIsoUnderLock`, so the snapshot threads at the binding (plus the wrapper iso's own site);
    // each line is pinned to that port below.
    // RFC-413: the wrapper iso's own site reads the same snapshot through its isolation ports
    // (`canonRepos: ports.repos`, bound to `state.repos`).
    const canonMatches = executionSource.match(/canonRepos: (?:state|ports)\.repos/g) ?? []
    expect(canonMatches.length).toBeGreaterThanOrEqual(2)
    expect(AGENT_BINDING_SOURCE).toMatch(
      /createIsoUnderLock: \(isoKeyRunId, log\) =>\s*createIsoUnderLock\(\{[\s\S]{0,300}canonRepos: state\.repos,/,
    )
    expect(AGENT_NODE_SOURCE).toMatch(/isoHandle = await workspace\.createIsoUnderLock\(/)
    expect(FANOUT_SHARD_SOURCE).toMatch(/shardIso = await workspace\.createIsoUnderLock\(/)
    expect(FANOUT_AGGREGATOR_SOURCE).toMatch(/aggIso = await workspace\.createIsoUnderLock\(/)
    expect(AGENT_NODE_SOURCE).not.toContain('canonRepos:')
    expect(FANOUT_SHARD_SOURCE).not.toContain('canonRepos:')
    expect(FANOUT_AGGREGATOR_SOURCE).not.toContain('canonRepos:')
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

  test('PB-G4 resume + retry rollback funnels through the shared rollback authority', () => {
    // RFC-424: the legacy `rollbackNodeRunForResume` shell in services/task.ts went with the test-only
    // resume entry. Production resume (the resume participant's `rollbackForResume`) and retry / sync
    // (taskRouteOperations) both call the shared `rollbackNodeRunWorktrees` (services/nodeRollback.ts).
    expect(RESUME_SRC.includes('async function rollbackForResume(')).toBe(true)
    const calls = RESUME_SRC.match(/await rollbackNodeRunWorktrees\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(ROUTE_OPERATIONS_SRC.includes('await rollbackNodeRunWorktrees(')).toBe(true)
    expect(TASK_SRC.includes('rollbackNodeRunForResume')).toBe(false)
  })

  test('PB-G5 diff endpoint branches on single vs multi via canonical mount paths + `# === Repo:` header', () => {
    expect(
      TASK_DIFF_SRC.includes('isSingleRootRepository(task.repos.map((repo) => repo.mountPath))'),
    ).toBe(true)
    // Multi-repo concat uses the stable header literal so the frontend can
    // safely split on it.
    expect(TASK_DIFF_SRC.includes('# === Repo:')).toBe(true)
  })
})
