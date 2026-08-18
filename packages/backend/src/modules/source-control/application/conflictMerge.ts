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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  readonly runGit?: RepositoryGit
}): Promise<PrepareConflictMergeResult> {
  const runGit = input.runGit ?? defaultRunGit
  const parent = mkdtempSync(join(tmpdir(), 'aw-conflict-'))
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

/** porcelain 行 → 涉及的路径（rename 形态两侧都算）。 */
function porcelainPaths(line: string): string[] {
  const body = line.slice(3)
  const arrow = body.indexOf(' -> ')
  if (arrow >= 0) return [body.slice(0, arrow), body.slice(arrow + 4)]
  return [body]
}

/**
 * 收口：冲突集必须全部解决（残留 U 即拒），且工作区除冲突集外不得有任何
 * 其它改动（Agent 顺手改的文件如实拒绝，绝不顺手收编）。通过后只 add 冲突集、
 * 以平台身份产 merge commit（MERGE_HEAD 已在，两 parent = source/target）。
 */
export async function finishConflictMerge(input: {
  readonly workspacePath: string
  readonly sourceSha: string
  readonly targetSha: string
  readonly conflictPaths: readonly string[]
  readonly missionId: string
  readonly runGit?: RepositoryGit
}): Promise<FinishConflictMergeResult> {
  const runGit = input.runGit ?? defaultRunGit
  const ws = input.workspacePath

  // 「已解决」看**工作树内容**而不是索引态：Agent 写完解决内容时索引仍是
  // unmerged（add 是 finish 的职责，不是 Agent 的——Agent 无 Git）。残留
  // conflict marker 行（<<<<<<< / ======= / >>>>>>>）即未解决；文件被删除
  // 视为「以删除解决」（porcelain D 属冲突集，add 收口）。
  const markerLine = /^(<{7}|={7}|>{7})( |$)/m
  const remaining = input.conflictPaths.filter((path) => {
    const abs = join(ws, path)
    if (!existsSync(abs)) return false
    try {
      return markerLine.test(readFileSync(abs, 'utf8'))
    } catch {
      return false // 二进制冲突：无 marker 概念，内容以工作树现状为准。
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
  const status = await runGit(ws, ['status', '--porcelain'])
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

  if (input.conflictPaths.length > 0) {
    const add = await runGit(ws, ['add', '--', ...input.conflictPaths])
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
