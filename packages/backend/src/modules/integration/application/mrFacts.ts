// RFC-310 PR-7 T72/T75 —— MR facts snapshot collector 与 feedback reply effect
// （design §10.1/§10.2）。
//
// §10.1「事实优先于事件」：webhook 只是 wake hint，reconciler 主动取得同一个
// logical snapshot——head/target、draft/terminal/mergeability、approval holds、
// thread revisions。采集是三读 fence：mr.get（head₁）→ threads/approvals →
// mr.get（head₂）；两读之间 head 变化即整组丢弃（`mr-facts-head-race`），调用
// 方重采，不缝合跨 head 的两半事实。读不到的面（approvals 无权限/字段缺失）
// 一律 null/unknown——**不伪造**，规则侧按 indeterminate 语义处置。
//
// reply（§10.2/§8.3）：平台**只回复，绝不 resolve**——本文件不出现任何
// resolve/approve/merge 调用（负扫描测试锁定）。回复正文自动携带隐形
// self-marker（HTML 注释），collector 据它把后续同 thread 的平台笔迹归
// 'self'，防 feedback 自循环。幂等由上层 effects 台账管（idempotencyKey），
// 本函数是纯执行体。

import { executeCodeHostCall } from '@/services/codeHost/call'
import { callDeps, normalizedState, parseJson, type MrEnsureConnectionDeps } from './mrEnsure'

export interface MrThreadFact {
  readonly threadRef: string
  /** 该 thread 的内容版本（`<note 数>:<最新 note id>`——新增/追加即变）。 */
  readonly revision: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly resolved: boolean
  readonly lastBody: string
  readonly path: string | null
}

export interface MrFactsSnapshot {
  readonly mrRef: string
  readonly headSha: string | null
  readonly targetSha: string | null
  readonly targetBranch: string | null
  readonly state: 'opened' | 'merged' | 'closed'
  readonly draft: boolean
  readonly mergeableState: 'mergeable' | 'conflict' | 'unknown'
  /** 读不到审批面（无权限/provider 不暴露）⇒ null，不伪造。 */
  readonly approvalHold: boolean | null
  readonly mergedCommitSha: string | null
  readonly mergedAt: string | null
  readonly threads: readonly MrThreadFact[]
}

export type MrFactsResult =
  | { readonly ok: true; readonly snapshot: MrFactsSnapshot }
  | {
      readonly ok: false
      readonly code: 'mr-facts-lookup-failed' | 'mr-facts-head-race' | 'mr-facts-threads-truncated'
      readonly detail: string
    }

/** reply 正文里的平台笔迹（隐形 HTML 注释；collector 的 self 判定锚）。 */
export function selfMarkerToken(marker: string): string {
  return `<!-- aw-self:${marker} -->`
}

const THREAD_PAGE_LIMIT = 100

interface RawUser {
  readonly username?: string
  readonly login?: string
}

interface GitlabMrDetail {
  readonly iid: number
  readonly state: string
  readonly sha?: string
  readonly target_branch?: string
  readonly diff_refs?: { readonly base_sha?: string }
  readonly draft?: boolean
  readonly work_in_progress?: boolean
  readonly merge_status?: string
  readonly detailed_merge_status?: string
  readonly merge_commit_sha?: string | null
  readonly merged_at?: string | null
}

interface GitlabNote {
  readonly id: number
  readonly body?: string
  readonly author?: RawUser
  readonly resolved?: boolean
  readonly position?: { readonly new_path?: string } | null
}

interface GitlabDiscussion {
  readonly id: string
  readonly notes?: readonly GitlabNote[]
}

interface GithubPrDetail {
  readonly number: number
  readonly state: string
  readonly merged?: boolean
  readonly merged_at?: string | null
  readonly merge_commit_sha?: string | null
  readonly draft?: boolean
  readonly mergeable?: boolean | null
  readonly mergeable_state?: string
  readonly head?: { readonly sha?: string }
  readonly base?: { readonly ref?: string; readonly sha?: string }
  readonly requested_reviewers?: readonly unknown[]
}

interface GithubReviewComment {
  readonly id: number
  readonly body?: string
  readonly user?: RawUser
  readonly in_reply_to_id?: number
  readonly path?: string
}

function classifyAuthor(
  user: RawUser | undefined,
  body: string,
  selfMarker: string | null,
): MrThreadFact['authorClass'] {
  if (selfMarker !== null && body.includes(selfMarkerToken(selfMarker))) return 'self'
  const name = user?.username ?? user?.login ?? ''
  if (name.endsWith('[bot]') || name.endsWith('-bot')) return 'bot'
  return 'human'
}

function mergeableOf(input: {
  readonly provider: MrEnsureConnectionDeps['provider']
  readonly gitlab?: GitlabMrDetail
  readonly github?: GithubPrDetail
}): MrFactsSnapshot['mergeableState'] {
  if (input.provider === 'gitlab') {
    const detailed = input.gitlab?.detailed_merge_status
    if (detailed === 'mergeable') return 'mergeable'
    if (detailed === 'conflict') return 'conflict'
    const legacy = input.gitlab?.merge_status
    if (legacy === 'can_be_merged') return 'mergeable'
    if (legacy === 'cannot_be_merged') return 'conflict'
    return 'unknown'
  }
  const pr = input.github
  if (pr?.mergeable === true || pr?.mergeable_state === 'clean') return 'mergeable'
  if (pr?.mergeable === false || pr?.mergeable_state === 'dirty') return 'conflict'
  return 'unknown'
}

async function fetchMrDetail(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
): Promise<
  | { readonly ok: true; readonly gitlab?: GitlabMrDetail; readonly github?: GithubPrDetail }
  | { readonly ok: false; readonly detail: string }
> {
  const got = await executeCodeHostCall(
    { provider: deps.provider, action: 'mr.get', params: { project: deps.project, mr: mrRef } },
    callDeps(deps),
  )
  if (!got.ok) return { ok: false, detail: `${got.code}: ${got.summary}` }
  if (deps.provider === 'gitlab') {
    const parsed = parseJson<GitlabMrDetail>(got.body)
    return parsed === null
      ? { ok: false, detail: 'mr.get returned non-JSON' }
      : { ok: true, gitlab: parsed }
  }
  const parsed = parseJson<GithubPrDetail>(got.body)
  return parsed === null
    ? { ok: false, detail: 'mr.get returned non-JSON' }
    : { ok: true, github: parsed }
}

function headOf(detail: {
  readonly gitlab?: GitlabMrDetail
  readonly github?: GithubPrDetail
}): string | null {
  return detail.gitlab?.sha ?? detail.github?.head?.sha ?? null
}

async function collectThreads(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
  selfMarker: string | null,
): Promise<
  | { readonly ok: true; readonly threads: MrThreadFact[] }
  | {
      readonly ok: false
      readonly code: 'mr-facts-lookup-failed' | 'mr-facts-threads-truncated'
      readonly detail: string
    }
> {
  const listed = await executeCodeHostCall(
    {
      provider: deps.provider,
      action: 'comment.list',
      params: {
        project: deps.project,
        mr: mrRef,
        per_page: String(THREAD_PAGE_LIMIT),
        ...(deps.provider === 'github' ? { comment_scope: 'pulls' } : {}),
      },
    },
    callDeps(deps),
  )
  if (!listed.ok) {
    return {
      ok: false,
      code: 'mr-facts-lookup-failed',
      detail: `${listed.code}: ${listed.summary}`,
    }
  }

  if (deps.provider === 'gitlab') {
    const discussions = parseJson<GitlabDiscussion[]>(listed.body) ?? []
    if (discussions.length >= THREAD_PAGE_LIMIT) {
      return {
        ok: false,
        code: 'mr-facts-threads-truncated',
        detail: `>=${THREAD_PAGE_LIMIT} discussions; paged collection not implemented in v1`,
      }
    }
    const threads = discussions
      .filter((d) => (d.notes?.length ?? 0) > 0)
      .map((d) => {
        const notes = d.notes!
        const last = notes[notes.length - 1]!
        return {
          threadRef: d.id,
          revision: `${notes.length}:${last.id}`,
          authorClass: classifyAuthor(last.author, last.body ?? '', selfMarker),
          resolved: notes.every((n) => n.resolved === true),
          lastBody: last.body ?? '',
          path: last.position?.new_path ?? null,
        }
      })
    return { ok: true, threads }
  }

  const comments = parseJson<GithubReviewComment[]>(listed.body) ?? []
  if (comments.length >= THREAD_PAGE_LIMIT) {
    return {
      ok: false,
      code: 'mr-facts-threads-truncated',
      detail: `>=${THREAD_PAGE_LIMIT} review comments; paged collection not implemented in v1`,
    }
  }
  // github：REST 无 thread 对象——按根 comment 归组（in_reply_to_id 链指向根）。
  const byThread = new Map<string, GithubReviewComment[]>()
  for (const comment of comments) {
    const root = comment.in_reply_to_id === undefined ? comment.id : comment.in_reply_to_id
    const key = String(root)
    const bucket = byThread.get(key)
    if (bucket === undefined) byThread.set(key, [comment])
    else bucket.push(comment)
  }
  const threads = [...byThread.entries()].map(([threadRef, notes]) => {
    const last = notes[notes.length - 1]!
    return {
      threadRef,
      revision: `${notes.length}:${last.id}`,
      authorClass: classifyAuthor(last.user, last.body ?? '', selfMarker),
      // REST 不暴露 review thread resolution（GraphQL only）；恒 false，
      // 外部 resolve 状态由 policy 侧按「未解决」保守处理。
      resolved: false,
      lastBody: last.body ?? '',
      path: last.path ?? null,
    }
  })
  return { ok: true, threads }
}

/** approvals：best effort——404/无权限/字段缺失 ⇒ null（不伪造 hold 状态）。 */
async function collectApprovalHold(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
  githubDetail: GithubPrDetail | undefined,
): Promise<boolean | null> {
  if (deps.provider === 'github') {
    const requested = githubDetail?.requested_reviewers
    if (requested === undefined) return null
    return requested.length > 0
  }
  const got = await executeCodeHostCall(
    {
      provider: 'gitlab',
      action: 'custom',
      params: {},
      request: {
        method: 'GET',
        path: `/projects/${deps.project}/merge_requests/${mrRef}/approvals`,
      },
    },
    callDeps(deps),
  )
  if (!got.ok) return null
  const parsed = parseJson<{ approvals_left?: number }>(got.body)
  if (parsed === null || typeof parsed.approvals_left !== 'number') return null
  return parsed.approvals_left > 0
}

/**
 * 同 snapshot 三读 fence：head₁ → threads/approvals → head₂；漂移整组丢弃。
 */
export async function collectMergeRequestFacts(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
  options: { readonly selfMarker?: string } = {},
): Promise<MrFactsResult> {
  const first = await fetchMrDetail(deps, mrRef)
  if (!first.ok) return { ok: false, code: 'mr-facts-lookup-failed', detail: first.detail }
  const head1 = headOf(first)

  const threads = await collectThreads(deps, mrRef, options.selfMarker ?? null)
  if (!threads.ok) return { ok: false, code: threads.code, detail: threads.detail }
  const approvalHold = await collectApprovalHold(deps, mrRef, first.github)

  const second = await fetchMrDetail(deps, mrRef)
  if (!second.ok) return { ok: false, code: 'mr-facts-lookup-failed', detail: second.detail }
  const head2 = headOf(second)
  if (head1 !== head2) {
    return {
      ok: false,
      code: 'mr-facts-head-race',
      detail: `head moved during collection (${head1 ?? 'none'} -> ${head2 ?? 'none'})`,
    }
  }

  const gitlab = first.gitlab
  const github = first.github
  const rawState = gitlab?.state ?? github?.state ?? 'closed'
  const snapshot: MrFactsSnapshot = {
    mrRef,
    headSha: head1,
    targetSha: gitlab?.diff_refs?.base_sha ?? github?.base?.sha ?? null,
    targetBranch: gitlab?.target_branch ?? github?.base?.ref ?? null,
    state: normalizedState({
      provider: deps.provider,
      rawState,
      merged: github?.merged ?? false,
    }),
    draft: gitlab?.draft ?? gitlab?.work_in_progress ?? github?.draft ?? false,
    mergeableState: mergeableOf({ provider: deps.provider, gitlab, github }),
    approvalHold,
    mergedCommitSha: gitlab?.merge_commit_sha ?? github?.merge_commit_sha ?? null,
    mergedAt: gitlab?.merged_at ?? github?.merged_at ?? null,
    threads: threads.threads,
  }
  return { ok: true, snapshot }
}

// ------------------------------------------------------------------- reply

export type MrReplyResult =
  | { readonly ok: true; readonly noteRef: string }
  | { readonly ok: false; readonly code: 'mr-reply-failed'; readonly detail: string }

/**
 * 只回复不 resolve：正文尾部自动附隐形 self-marker（collector 的 'self' 判定
 * 锚，防 feedback 自循环）。同 body 重发会产生第二条 note——幂等由上层
 * effects 台账（idempotencyKey）负责，本函数是纯执行体。
 */
export async function replyMergeRequestThread(
  deps: MrEnsureConnectionDeps,
  input: {
    readonly mrRef: string
    readonly threadRef: string
    readonly body: string
    readonly selfMarker: string
  },
): Promise<MrReplyResult> {
  const body = `${input.body}\n\n${selfMarkerToken(input.selfMarker)}`
  const replied = await executeCodeHostCall(
    {
      provider: deps.provider,
      action: 'comment.reply-thread',
      params: { project: deps.project, mr: input.mrRef, thread: input.threadRef, body },
    },
    callDeps(deps),
  )
  if (!replied.ok) {
    return { ok: false, code: 'mr-reply-failed', detail: `${replied.code}: ${replied.summary}` }
  }
  const note = parseJson<{ id?: number | string }>(replied.body)
  return { ok: true, noteRef: note?.id !== undefined ? String(note.id) : 'unknown' }
}
