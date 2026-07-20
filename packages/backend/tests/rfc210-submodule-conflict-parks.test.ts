// RFC-210 后续修正 — 子仓冲突必须 park 成 awaiting_human，而不是抛异常变
// merge-failed。红→绿回归锁。
//
// 病灶：仓级 MergeBackConflict 对子仓冲突填的是 `mergedTree: ''`（父仓层确实没有
// 可给的树——gitlink 是一个 tree entry，分歧在它内部）。而 resolveConflictWithAgent
// 第一件事就是 `commitTree(repoGit, conflict.mergedTree, …)`：
//
//   git commit-tree "" -p <sha> -m x  →  exit 128  fatal: not a valid object name
//
// commitTree 非 0 即 throw。异常穿过 writeSem 和 mergeBackAndSettle 抛给调用方，
// 节点被记成 merge-failed，运维看到的是 git 底层噪声，人拿不到 resolve-iso，也就
// 没有恢复路径——恰恰是最需要人介入的那一类冲突反而没有人介入的入口。
//
// 既有的 rfc210-recursive-submodule-merge 之所以绿，是因为它直接调
// mergeBackNodeIso 且不带 resolver，整条 settle 路径被绕过了。这里直接打
// resolveConflictWithAgent，覆盖那一段。

import { describe, expect, test } from 'bun:test'
import { resolveConflictWithAgent } from '@/services/nodeIsolation'

function subConflict(paths: string[], worktreeDirName = '') {
  return {
    worktreeDirName,
    paths,
    // What mergeBackNodeIso actually pushes for a submodule conflict.
    mergedTree: '',
    rawConflictOutput: paths.map((p) => `CONFLICT (submodule): Merge conflict in ${p}`).join('\n'),
    base: 'basesha',
    // Deliberately a path that does not exist: if the fix regresses, the code
    // reaches git and fails for some *other* reason, and this test would go
    // green for the wrong cause. Parking must happen before any git call.
    canonWorktreePath: '/nonexistent/aw-rfc210-never-touched',
    taskBaseHead: 'headsha',
    salvagedPaths: [],
    forcedRepoRelPaths: [],
  }
}

describe('RFC-210 — submodule conflict parks instead of throwing', () => {
  test('an empty mergedTree returns unresolved rather than reaching commit-tree', async () => {
    let agentCalled = false
    const outcome = await resolveConflictWithAgent(subConflict(['vendor (submodule)']), {
      containerPath: '/nonexistent/aw-rfc210-container',
      runAgent: async () => {
        agentCalled = true
      },
    })

    // Before the fix this rejected with DomainError('commit-tree-failed').
    expect(outcome.resolved).toBe(false)
    expect(outcome.unresolved.map((e) => e.path)).toEqual(['vendor (submodule)'])
    expect(outcome.unresolved[0]?.type).toBe('submodule')
    // No resolve-iso: there is no parent-level tree to seed one from, and the
    // scheduler surfaces `resolveIsoPath` to the human — a path to a worktree
    // that was never created would be worse than none.
    expect(outcome.resolveIsoPath).toBeNull()
    // The in-submodule agent attempt already happened upstream (T25); this layer
    // must not spawn a second one against a tree that does not exist.
    expect(agentCalled).toBe(false)
  })

  test('carries every conflicted submodule path through to the park note', async () => {
    const outcome = await resolveConflictWithAgent(
      subConflict(['libs/a (submodule)', 'libs/b (submodule)'], 'repo2'),
      { containerPath: '/nonexistent/aw-rfc210-container', runAgent: async () => {} },
    )
    expect(outcome.resolved).toBe(false)
    // The scheduler builds the awaiting_human detail from exactly this list.
    expect(outcome.unresolved.map((e) => e.path)).toEqual([
      'libs/a (submodule)',
      'libs/b (submodule)',
    ])
    expect(outcome.unresolved.every((e) => e.worktreeDirName === 'repo2')).toBe(true)
  })
})
