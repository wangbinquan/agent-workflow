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
import { describeRepositoryRemote, type RepositoryPublicationReceipt } from '@agent-workflow/shared'
import { isAbsolute } from 'node:path'
import {
  candidateCommitMessage,
  missionGitRefComponent,
  type DeliveryContextEnvelope,
} from '../domain/deliveryPolicy'
import { stageCandidateTree } from './changeCandidate'
import type { RepositoryGit } from './repositoryCommit'
import { classifyRepositoryPushFailure } from '../domain/repositoryPushFailure'
import { redactSensitiveString } from '@/util/redact'
import type {
  RepositoryPublicationSession,
  RepositoryPublicationSubject,
  RepositoryPublicationTransport,
} from '../public/types'

/** baseline 镜像里承载 candidate commit 的内部 ref（durable、不污染分支命名空间）。 */
export function missionCandidateRef(missionId: string): string {
  return `refs/aw/mission/${missionGitRefComponent(missionId)}/candidate`
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
  /** Platform-owned portable recovery hint; never supplied by the Agent. */
  readonly contextEnvelope?: DeliveryContextEnvelope
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
      ...(input.contextEnvelope === undefined ? {} : { contextEnvelope: input.contextEnvelope }),
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
  /** Persisted mission owner, never the actor performing a retry. */
  readonly publicationSubject?: CandidatePublicationSubject
  /** Bootstrap-owned session factory. Omission is admitted only for local fixtures. */
  readonly publicationTransport?: CandidatePublicationTransport
  readonly runGit?: RepositoryGit
}

export type CandidatePublicationSubject = RepositoryPublicationSubject
export type CandidatePublicationSession = RepositoryPublicationSession
export type CandidatePublicationTransport = RepositoryPublicationTransport

export type PushCandidateResult =
  | {
      readonly ok: true
      readonly receipt: {
        readonly remoteRef: string
        readonly oldSha: string | null
        readonly newSha: string
        /** 已发布（本次或此前同身份 push）——幂等重放为 true。 */
        readonly reused: boolean
        readonly publication: RepositoryPublicationReceipt
      }
    }
  | {
      readonly ok: false
      readonly code:
        | 'remote-head-changed'
        | 'push-failed'
        | 'publication-transport-unavailable'
        | 'repository-push-authentication-failed'
        | 'repository-push-authorization-failed'
      readonly detail: string
    }

type RemoteHeadResult =
  | { readonly ok: true; readonly sha: string | null }
  | { readonly ok: false; readonly detail: string }

function failedPublicationResult(
  detail: string,
  fallback: 'push-failed' | 'remote-head-changed' = 'push-failed',
): Extract<PushCandidateResult, { readonly ok: false }> {
  const safeDetail = redactSensitiveString(detail).trim().slice(0, 300)
  return {
    ok: false,
    code: classifyRepositoryPushFailure(detail) ?? fallback,
    detail: safeDetail,
  }
}

async function remoteHeadOf(
  runGit: RepositoryGit,
  repoPath: string,
  remoteUrl: string,
  branch: string,
): Promise<RemoteHeadResult> {
  const out = await runGit(repoPath, ['ls-remote', remoteUrl, `refs/heads/${branch}`])
  if (out.exitCode !== 0) {
    return {
      ok: false,
      detail: `${out.stderr}\n${out.stdout}`.trim().slice(0, 300),
    }
  }
  const line = out.stdout.split('\n').find((l) => l.trim().length > 0)
  return {
    ok: true,
    sha: line === undefined ? null : (line.split('\t')[0]?.trim() ?? null),
  }
}

function localFixtureSession(
  remoteUrl: string,
  runGit: RepositoryGit,
): CandidatePublicationSession | null {
  const described = describeRepositoryRemote(remoteUrl)
  const local =
    (described.ok && described.value.transport === 'file') ||
    isAbsolute(remoteUrl) ||
    remoteUrl.startsWith('./') ||
    remoteUrl.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(remoteUrl)
  if (!local) return null
  return {
    endpointUrl: remoteUrl,
    receipt: {
      credentialSource: 'legacy',
      credentialRevision: null,
      endpointSource: 'local-fixture',
      endpointBindingDigest: null,
    },
    runNetwork(repoPath, args, options) {
      return runGit(repoPath, [...args], options)
    },
    close() {},
  }
}

export async function pushCandidate(input: PushCandidateInput): Promise<PushCandidateResult> {
  const runGit = input.runGit ?? defaultRunGit
  const remoteRef = `refs/heads/${input.branch}`
  let session: CandidatePublicationSession
  if (input.publicationTransport !== undefined && input.publicationSubject !== undefined) {
    const opened = await input.publicationTransport.open({
      subject: input.publicationSubject,
      remoteUrl: input.remoteUrl,
    })
    if (!opened.ok) {
      return {
        ok: false,
        code: 'publication-transport-unavailable',
        detail: opened.code,
      }
    }
    session = opened.session
  } else {
    const local = localFixtureSession(input.remoteUrl, runGit)
    if (local === null) {
      return {
        ok: false,
        code: 'publication-transport-unavailable',
        detail: 'a managed publication transport and persisted subject are required',
      }
    }
    session = local
  }
  const networkRunGit: RepositoryGit = (repoPath, args, options) =>
    session.runNetwork(repoPath, args, options)

  try {
    const actualResult = await remoteHeadOf(
      networkRunGit,
      input.baselineRepoPath,
      session.endpointUrl,
      input.branch,
    )
    if (!actualResult.ok) {
      return failedPublicationResult(actualResult.detail)
    }
    const actual = actualResult.sha

    if (actual !== null) {
      // 幂等：远端已是同身份 candidate commit ⇒ 视为已发布。
      const fetched = await networkRunGit(input.baselineRepoPath, [
        'fetch',
        '--quiet',
        session.endpointUrl,
        actual,
      ])
      if (fetched.exitCode !== 0) {
        return failedPublicationResult(`${fetched.stderr}\n${fetched.stdout}`)
      }
      const identity = await commitTreeIdentityOf(runGit, input.baselineRepoPath, actual)
      if (
        identity !== null &&
        identity.tree === input.expectedTreeOid &&
        identity.parent === input.baselineSha
      ) {
        return {
          ok: true,
          receipt: {
            remoteRef,
            oldSha: input.expectedRemoteSha,
            newSha: actual,
            reused: true,
            publication: session.receipt,
          },
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
    const pushed = await networkRunGit(input.baselineRepoPath, [
      'push',
      '--quiet',
      session.endpointUrl,
      `${input.commitSha}:${remoteRef}`,
    ])
    if (pushed.exitCode !== 0) {
      const text = `${pushed.stderr}\n${pushed.stdout}`
      const raced =
        /non-fast-forward|fetch first|stale info|tip of your current branch is behind|updates were rejected because/i.test(
          text,
        )
      return failedPublicationResult(text, raced ? 'remote-head-changed' : 'push-failed')
    }
    const confirmedResult = await remoteHeadOf(
      networkRunGit,
      input.baselineRepoPath,
      session.endpointUrl,
      input.branch,
    )
    if (!confirmedResult.ok || confirmedResult.sha !== input.commitSha) {
      const detail = confirmedResult.ok
        ? `post-push verification saw ${confirmedResult.sha ?? 'absent'}`
        : confirmedResult.detail
      return failedPublicationResult(detail)
    }
    return {
      ok: true,
      receipt: {
        remoteRef,
        oldSha: input.expectedRemoteSha,
        newSha: input.commitSha,
        reused: false,
        publication: session.receipt,
      },
    }
  } finally {
    session.close()
  }
}
