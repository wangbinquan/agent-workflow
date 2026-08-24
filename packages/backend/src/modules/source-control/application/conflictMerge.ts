// RFC-310 PR-7b T77 —— conflict merge 的 prepare/finish（design §8.5/§10）。
//
// 平台只做**merge target into source**这一种收敛（方向固定；§0.3 不变量禁止
// rebase/force），且绝不用 `-X ours`/`-X theirs`/`--strategy=*` 之类捷径吞掉
// 任何一侧——冲突必须留给 repair Agent 逐个人工语义解决（conflict markers
// 原样保留在 workspace）。finish 只收冲突集内的解决结果：Agent 顺手改的其它
// 文件如实拒绝（`conflict-extra-changes`），不静默剪枝也不顺手收编。merge
// commit 用平台内部 git identity（AW_INTERNAL_GIT_IDENTITY），Agent 不碰
// Git；push 不在本文件——finish 只产本地 merge commit，发布仍走
// deliverCandidate 的 exact-head CAS 面。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { AW_INTERNAL_GIT_IDENTITY, runGit as defaultRunGit } from '@/util/git'
import type { RepositoryGit } from './repositoryCommit'

export type PrepareConflictMergeResult =
  | {
      readonly ok: true
      readonly workspacePath: string
      readonly conflictPaths: readonly string[]
      cleanup(): void
    }
  | {
      readonly ok: false
      readonly code: 'conflict-workspace-failed' | 'no-conflict' | 'merge-failed'
      readonly detail: string
    }

/**
 * 临时 clone baseline → detach 到 sourceSha → `merge --no-commit --no-ff
 * targetSha`。干净合并 = `no-conflict`（调用方按 mergeable 处理，不该派
 * repair）；冲突 = ok（workspace 带 conflict markers，MERGE_HEAD 保留，供
 * finish 收口）。调用方负责 cleanup()（成功路径也要）。
 */
export async function prepareConflictMerge(input: {
  readonly baselineRepoPath: string
  readonly sourceSha: string
  readonly targetSha: string
  /**
   * workspace 宿主根。生产必须落 appHome 之下——RFC-308 的 exclude participant
   * 对平台家外的 worktree 抛 owner-mismatch，交给 Agent 的 task 会起不来
   * （actionWorkspace 同款约束）；缺省 tmpdir 仅供不派 Agent 的 merge 单测。
   */
  readonly workspacesRoot?: string
  readonly runGit?: RepositoryGit
}): Promise<PrepareConflictMergeResult> {
  const runGit = input.runGit ?? defaultRunGit
  let parent: string
  if (input.workspacesRoot === undefined) {
    parent = mkdtempSync(join(tmpdir(), 'aw-conflict-'))
  } else {
    mkdirSync(input.workspacesRoot, { recursive: true })
    parent = mkdtempSync(join(input.workspacesRoot, 'conflict-'))
  }
  const ws = join(parent, 'ws')
  const cleanup = (): void => rmSync(parent, { recursive: true, force: true })
  const fail = (
    code: 'conflict-workspace-failed' | 'no-conflict' | 'merge-failed',
    detail: string,
  ): { ok: false; code: typeof code; detail: string } => {
    cleanup()
    return { ok: false, code, detail }
  }

  const clone = await runGit(parent, [
    'clone',
    '--no-hardlinks',
    '--quiet',
    input.baselineRepoPath,
    ws,
  ])
  if (clone.exitCode !== 0) {
    return fail('conflict-workspace-failed', clone.stderr.slice(0, 300))
  }
  const checkout = await runGit(ws, ['checkout', '--quiet', '--detach', input.sourceSha])
  if (checkout.exitCode !== 0) {
    return fail('conflict-workspace-failed', checkout.stderr.slice(0, 300))
  }
  // repair Agent 拿到的现场必须与普通 action workspace 同形，否则它不能直接
  // 交给 Agent 跑：①无 remote（Agent 永不自己发布 Git，clone 继承的 origin
  // 先摘掉）；②RFC-308 平台运行物整目录 exclude（先于任何快照/写入，否则
  // finish 的 `status --porcelain` 会把平台自己的运行物当成 Agent 顺手改动）。
  const removeOrigin = await runGit(ws, ['remote', 'remove', 'origin'])
  if (removeOrigin.exitCode !== 0) {
    return fail('conflict-workspace-failed', removeOrigin.stderr.slice(0, 300))
  }
  mkdirSync(join(ws, '.git', 'info'), { recursive: true })
  writeFileSync(join(ws, '.git', 'info', 'exclude'), `${PLATFORM_WORKSPACE_DIR}/\n`)

  const merge = await runGit(ws, ['merge', '--no-commit', '--no-ff', input.targetSha], {
    env: { ...AW_INTERNAL_GIT_IDENTITY },
  })
  if (merge.exitCode === 0) {
    return fail(
      'no-conflict',
      `merge of ${input.targetSha.slice(0, 12)} into ${input.sourceSha.slice(0, 12)} is clean`,
    )
  }
  const unresolved = await runGit(ws, ['diff', '--name-only', '--diff-filter=U'])
  if (unresolved.exitCode !== 0) {
    return fail('merge-failed', unresolved.stderr.slice(0, 300))
  }
  const conflictPaths = unresolved.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
  if (conflictPaths.length === 0) {
    // merge 非零退出但没有 U 文件：不是内容冲突（如 unrelated histories）。
    return fail('merge-failed', merge.stderr.slice(0, 300))
  }
  return { ok: true, workspacePath: ws, conflictPaths, cleanup }
}

export type FinishConflictMergeResult =
  | { readonly ok: true; readonly mergeCommitSha: string; readonly treeOid: string }
  | {
      readonly ok: false
      readonly code: 'conflict-unresolved' | 'conflict-extra-changes' | 'finish-failed'
      readonly detail: string
    }

export type InspectConflictMergeResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'conflict-unresolved' | 'conflict-extra-changes' | 'finish-failed'
      readonly detail: string
    }

/** porcelain 行 → 涉及的路径（rename 形态两侧都算）。 */
function porcelainPaths(line: string): string[] {
  const body = line.slice(3)
  const arrow = body.indexOf(' -> ')
  if (arrow >= 0) return [body.slice(0, arrow), body.slice(arrow + 4)]
  return [body]
}

/**
 * Read-only half of conflict finish. The Agent execution boundary calls this
 * before its envelope is accepted, so validation cannot accidentally create a
 * commit for an invalid envelope. The deterministic platform work item calls
 * `finishConflictMerge` only after settlement accepted that envelope.
 */
export async function inspectConflictMerge(input: {
  readonly workspacePath: string
  readonly conflictPaths: readonly string[]
  /**
   * Platform-authoritative delta relative to the prepared merge scene. When
   * present, this is stronger than `git status`: checkpoint materialization
   * intentionally flattens the merge index, so status also lists untouched
   * automatic merge results as working-tree changes relative to source HEAD.
   */
  readonly validatedChangedPaths?: readonly string[]
  readonly runGit?: RepositoryGit
}): Promise<InspectConflictMergeResult> {
  const runGit = input.runGit ?? defaultRunGit
  const markerLine = /^(<{7}|={7}|>{7})( |$)/m
  const remaining = input.conflictPaths.filter((path) => {
    const abs = join(input.workspacePath, path)
    if (!existsSync(abs)) return false
    try {
      return markerLine.test(readFileSync(abs, 'utf8'))
    } catch {
      return false
    }
  })
  if (remaining.length > 0) {
    return {
      ok: false,
      code: 'conflict-unresolved',
      detail: `unresolved conflicts: ${[...remaining].sort().join(', ')}`,
    }
  }

  const allowed = new Set(input.conflictPaths)
  if (input.validatedChangedPaths !== undefined) {
    const extras = input.validatedChangedPaths.filter((path) => !allowed.has(path))
    if (extras.length > 0) {
      return {
        ok: false,
        code: 'conflict-extra-changes',
        detail: `workspace has validated changes outside the conflict set: ${[...new Set(extras)]
          .sort()
          .join(', ')}`,
      }
    }
    return { ok: true }
  }

  const status = await runGit(input.workspacePath, ['status', '--porcelain'])
  if (status.exitCode !== 0) {
    return { ok: false, code: 'finish-failed', detail: status.stderr.slice(0, 300) }
  }
  const extras = status.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap(porcelainPaths)
    .filter((path) => !allowed.has(path))
  if (extras.length > 0) {
    return {
      ok: false,
      code: 'conflict-extra-changes',
      detail: `workspace has changes outside the conflict set: ${[...new Set(extras)].sort().join(', ')}`,
    }
  }
  return { ok: true }
}

/** Remove one platform-created conflict scene after its commit was published. */
export function discardConflictMergeWorkspace(input: { readonly workspacePath: string }): void {
  if (basename(input.workspacePath) !== 'ws') {
    throw new Error('conflict workspace cleanup refused an unexpected path')
  }
  rmSync(dirname(input.workspacePath), { recursive: true, force: true })
}

/**
 * 收口：冲突集必须全部解决（残留 U 即拒），且工作区除冲突集外不得有任何
 * 其它改动（Agent 顺手改的文件如实拒绝，绝不顺手收编）。通过后以平台身份产
 * merge commit（MERGE_HEAD 已在，两 parent = source/target）。当调用方提供了
 * 平台验证过的 delta 时，重建整个 merge index，确保现场物化时被扁平化的自动
 * 合并结果也进入 merge commit；否则保留旧接口的仅 add 冲突集行为。
 */
export async function finishConflictMerge(input: {
  readonly workspacePath: string
  readonly sourceSha: string
  readonly targetSha: string
  readonly conflictPaths: readonly string[]
  readonly validatedChangedPaths?: readonly string[]
  readonly missionId: string
  readonly runGit?: RepositoryGit
}): Promise<FinishConflictMergeResult> {
  const runGit = input.runGit ?? defaultRunGit
  const ws = input.workspacePath

  // 幂等重入：merge commit 已经产出（HEAD 的两个 parent 恰是 S/T、MERGE_HEAD
  // 已清）就原样回执。发布是 finish 之后的独立一步，进程在两步之间挂掉时
  // 收口侧会重入本函数——不认这个已完成态的话，重入必然撞 `nothing to
  // commit` 并把一次**已经解好的**冲突判成失败。
  if (!existsSync(join(ws, '.git', 'MERGE_HEAD'))) {
    const first = await runGit(ws, ['rev-parse', '--verify', 'HEAD^1'])
    const second = await runGit(ws, ['rev-parse', '--verify', 'HEAD^2'])
    if (
      first.exitCode === 0 &&
      second.exitCode === 0 &&
      first.stdout.trim() === input.sourceSha &&
      second.stdout.trim() === input.targetSha
    ) {
      const head = await runGit(ws, ['rev-parse', 'HEAD'])
      const tree = await runGit(ws, ['rev-parse', 'HEAD^{tree}'])
      if (head.exitCode === 0 && tree.exitCode === 0) {
        return { ok: true, mergeCommitSha: head.stdout.trim(), treeOid: tree.stdout.trim() }
      }
    }
  }

  // 「已解决」看**工作树内容**而不是索引态：Agent 写完解决内容时索引仍是
  // unmerged（add 是 finish 的职责，不是 Agent 的——Agent 无 Git）。
  const inspected = await inspectConflictMerge({
    workspacePath: ws,
    conflictPaths: input.conflictPaths,
    validatedChangedPaths: input.validatedChangedPaths,
    runGit,
  })
  if (!inspected.ok) return inspected

  const stageArgs =
    input.validatedChangedPaths !== undefined
      ? ['add', '-A', '--', '.']
      : input.conflictPaths.length > 0
        ? ['add', '--', ...input.conflictPaths]
        : null
  if (stageArgs !== null) {
    const add = await runGit(ws, stageArgs)
    if (add.exitCode !== 0) {
      return { ok: false, code: 'finish-failed', detail: add.stderr.slice(0, 300) }
    }
  }

  const message = `merge ${input.targetSha.slice(0, 12)} into ${input.sourceSha.slice(0, 12)} (mission ${input.missionId})`
  const commit = await runGit(ws, ['commit', '--no-edit', '-m', message], {
    env: { ...AW_INTERNAL_GIT_IDENTITY },
  })
  if (commit.exitCode !== 0) {
    return { ok: false, code: 'finish-failed', detail: commit.stderr.slice(0, 300) }
  }
  const head = await runGit(ws, ['rev-parse', 'HEAD'])
  const tree = await runGit(ws, ['rev-parse', 'HEAD^{tree}'])
  if (head.exitCode !== 0 || tree.exitCode !== 0) {
    return { ok: false, code: 'finish-failed', detail: 'cannot resolve merge commit identity' }
  }
  return { ok: true, mergeCommitSha: head.stdout.trim(), treeOid: tree.stdout.trim() }
}
