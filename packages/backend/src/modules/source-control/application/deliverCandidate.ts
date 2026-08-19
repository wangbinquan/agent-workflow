// RFC-310 PR-5 T59 —— candidate 的 commit 与 exact-head CAS 发布（design §9.2）。
//
// 两个 effect 两个函数（§9.4 outbox：source.commit → source.push 各自结算）：
//   commitCandidate：stage 重放（与派生共用同一份实现）→ treeOid 对拍
//     pinned receipt（不等 = candidate-drifted，整个作废）→ commit-tree
//     （平台模板 message + AW_INTERNAL_GIT_IDENTITY，Agent 只供 summary
//     素材）→ fetch 回 baseline 镜像的内部 ref（refs/aw/mission/<id>/candidate）
//     = 本地 durable commit receipt；
//   pushCandidate：ls-remote 读 remote head → 与 expected 对拍（不等且树身份
//     也对不上 ⇒ typed remote-head-changed）→ 普通 push（git 缺省拒
//     non-fast-forward；本文件不存在任何强推形态——文本锁）→ push 后复核。
//
// 幂等：同 candidate 重放不重复 commit——commit 前先看目标位（expected/内部
// ref/远端）上是否已有 tree==treeOid 且 parent==baseline 的 commit，有则复用。

import { runGit as defaultRunGit, AW_INTERNAL_GIT_IDENTITY } from '@/util/git'
import { candidateCommitMessage } from '../domain/deliveryPolicy'
import { stageCandidateTree } from './changeCandidate'
import type { RepositoryGit } from './repositoryCommit'

/** baseline 镜像里承载 candidate commit 的内部 ref（durable、不污染分支命名空间）。 */
export function missionCandidateRef(missionId: string): string {
  return `refs/aw/mission/${missionId.toLowerCase()}/candidate`
}

async function commitTreeIdentityOf(
  runGit: RepositoryGit,
  repoPath: string,
  sha: string,
): Promise<{ tree: string; parent: string | null } | null> {
  const tree = await runGit(repoPath, ['rev-parse', '--verify', `${sha}^{tree}`])
  if (tree.exitCode !== 0) return null
  const parent = await runGit(repoPath, ['rev-parse', '--verify', `${sha}^1`])
  return {
    tree: tree.stdout.trim(),
    parent: parent.exitCode === 0 ? parent.stdout.trim() : null,
  }
}

export interface CommitCandidateInput {
  readonly baselineRepoPath: string
  readonly baselineSha: string
  readonly overlayRoot: string
  /** pinned ChangeCandidateReceipt.treeOid——重放结果必须逐字相等。 */
  readonly expectedTreeOid: string
  readonly missionId: string
  /** Agent 提供的 summary 素材；message 由平台模板包裹。 */
  readonly summarySource: string
  readonly uploadPlan?: {
    readonly entries: readonly {
      readonly targetPath: string
      readonly disposition: 'create' | 'replace' | 'already-present'
      readonly fileMode: 'regular' | 'executable'
    }[]
  } | null
  readonly runGit?: RepositoryGit
}

export type CommitCandidateResult =
  | {
      readonly ok: true
      readonly commitSha: string
      readonly localRef: string
      readonly reused: boolean
    }
  | {
      readonly ok: false
      readonly code:
        | 'candidate-workspace-failed'
        | 'overlay-symlink'
        | 'candidate-drifted'
        | 'commit-failed'
      readonly detail: string
    }

export async function commitCandidate(input: CommitCandidateInput): Promise<CommitCandidateResult> {
  const runGit = input.runGit ?? defaultRunGit
  const localRef = missionCandidateRef(input.missionId)

  // 幂等短路：内部 ref 已有同身份 commit ⇒ 复用（不重复 commit）。
  const existing = await runGit(input.baselineRepoPath, [
    'rev-parse',
    '--verify',
    `${localRef}^{commit}`,
  ])
  if (existing.exitCode === 0) {
    const sha = existing.stdout.trim()
    const identity = await commitTreeIdentityOf(runGit, input.baselineRepoPath, sha)
    if (
      identity !== null &&
      identity.tree === input.expectedTreeOid &&
      identity.parent === input.baselineSha
    ) {
      return { ok: true, commitSha: sha, localRef, reused: true }
    }
  }

  const staged = await stageCandidateTree({
    baselineRepoPath: input.baselineRepoPath,
    baselineSha: input.baselineSha,
    overlayRoot: input.overlayRoot,
    uploadPlan: input.uploadPlan ?? null,
    runGit,
  })
  if (!staged.ok) return staged
  try {
    if (staged.treeOid !== input.expectedTreeOid) {
      // §9.2：prepare 之后现场改变 = digest mismatch，整个 candidate 作废。
      return {
        ok: false,
        code: 'candidate-drifted',
        detail: `staged tree ${staged.treeOid} != pinned ${input.expectedTreeOid}`,
      }
    }
    const message = candidateCommitMessage({
      missionId: input.missionId,
      summarySource: input.summarySource,
    })
    const committed = await runGit(
      staged.ws,
      ['commit-tree', staged.treeOid, '-p', input.baselineSha, '-m', message],
      { env: { ...AW_INTERNAL_GIT_IDENTITY } },
    )
    if (committed.exitCode !== 0) {
      return { ok: false, code: 'commit-failed', detail: committed.stderr.slice(0, 300) }
    }
    const commitSha = committed.stdout.trim()
    // durable：对象 + 内部 ref 落 baseline 镜像（临时 stage 树随后销毁）。
    const fetched = await runGit(input.baselineRepoPath, [
      'fetch',
      '--quiet',
      staged.ws,
      `+${commitSha}:${localRef}`,
    ])
    if (fetched.exitCode !== 0) {
      return { ok: false, code: 'commit-failed', detail: fetched.stderr.slice(0, 300) }
    }
    return { ok: true, commitSha, localRef, reused: false }
  } finally {
    staged.cleanup()
  }
}

export interface PushCandidateInput {
  readonly baselineRepoPath: string
  readonly commitSha: string
  /** push 目标（本地 bare 路径或 URL；测试用 file remote）。 */
  readonly remoteUrl: string
  readonly branch: string
  /** exact-head CAS：null = 分支必须尚不存在。 */
  readonly expectedRemoteSha: string | null
  readonly expectedTreeOid: string
  readonly baselineSha: string
  readonly runGit?: RepositoryGit
}

export type PushCandidateResult =
  | {
      readonly ok: true
      readonly receipt: {
        readonly remoteRef: string
        readonly oldSha: string | null
        readonly newSha: string
        /** 已发布（本次或此前同身份 push）——幂等重放为 true。 */
        readonly reused: boolean
      }
    }
  | {
      readonly ok: false
      readonly code: 'remote-head-changed' | 'push-failed'
      readonly detail: string
    }

async function remoteHeadOf(
  runGit: RepositoryGit,
  repoPath: string,
  remoteUrl: string,
  branch: string,
): Promise<string | null> {
  const out = await runGit(repoPath, ['ls-remote', remoteUrl, `refs/heads/${branch}`])
  if (out.exitCode !== 0) return null
  const line = out.stdout.split('\n').find((l) => l.trim().length > 0)
  return line === undefined ? null : (line.split('\t')[0]?.trim() ?? null)
}

export async function pushCandidate(input: PushCandidateInput): Promise<PushCandidateResult> {
  const runGit = input.runGit ?? defaultRunGit
  const remoteRef = `refs/heads/${input.branch}`
  const actual = await remoteHeadOf(runGit, input.baselineRepoPath, input.remoteUrl, input.branch)

  if (actual !== null) {
    // 幂等：远端已是同身份 candidate commit ⇒ 视为已发布。
    const fetched = await runGit(input.baselineRepoPath, [
      'fetch',
      '--quiet',
      input.remoteUrl,
      actual,
    ])
    const identity =
      fetched.exitCode === 0
        ? await commitTreeIdentityOf(runGit, input.baselineRepoPath, actual)
        : null
    if (
      identity !== null &&
      identity.tree === input.expectedTreeOid &&
      identity.parent === input.baselineSha
    ) {
      return {
        ok: true,
        receipt: { remoteRef, oldSha: input.expectedRemoteSha, newSha: actual, reused: true },
      }
    }
  }
  if (actual !== input.expectedRemoteSha) {
    return {
      ok: false,
      code: 'remote-head-changed',
      detail: `remote ${remoteRef} is ${actual ?? 'absent'}, expected ${input.expectedRemoteSha ?? 'absent'}`,
    }
  }

  // 普通 push：git 缺省拒 non-fast-forward——对拍窗口后的并发推进也会在这里
  // 被拒并归为 remote-head-changed。本文件没有任何强推形态。
  const pushed = await runGit(input.baselineRepoPath, [
    'push',
    '--quiet',
    input.remoteUrl,
    `${input.commitSha}:${remoteRef}`,
  ])
  if (pushed.exitCode !== 0) {
    const text = `${pushed.stderr}\n${pushed.stdout}`
    const raced = /fast-forward|fetch first|stale info|rejected/i.test(text)
    return {
      ok: false,
      code: raced ? 'remote-head-changed' : 'push-failed',
      detail: text.trim().slice(0, 300),
    }
  }
  const confirmed = await remoteHeadOf(
    runGit,
    input.baselineRepoPath,
    input.remoteUrl,
    input.branch,
  )
  if (confirmed !== input.commitSha) {
    return {
      ok: false,
      code: 'push-failed',
      detail: `post-push verification saw ${confirmed ?? 'absent'}`,
    }
  }
  return {
    ok: true,
    receipt: {
      remoteRef,
      oldSha: input.expectedRemoteSha,
      newSha: input.commitSha,
      reused: false,
    },
  }
}
