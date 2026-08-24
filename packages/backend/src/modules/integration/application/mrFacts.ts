// RFC-310 PR-7 T72/T75 —— MR facts snapshot collector 与 feedback reply effect
// （design §10.1/§10.2）。
//
// §10.1「事实优先于事件」：webhook 只是 wake hint，reconciler 主动取得同一个
// logical snapshot——head/target、draft/terminal/mergeability、approval holds、
// thread revisions。采集同时 fence source 与 target：mr.get + target branch（h₁/t₁）
// → threads/approvals → mr.get + target branch（h₂/t₂）；两读之间任一分支变化即
// 整组丢弃（`mr-facts-head-race` / `mr-facts-target-race`），调用方重采，不缝合
// 跨 revision 的两半事实。读不到的面（approvals 无权限/字段缺失）
// 一律 null/unknown——**不伪造**，规则侧按 indeterminate 语义处置。
//
// reply（§10.2/§8.3）：平台**只回复，绝不 resolve**——本文件不出现任何
// resolve/approve/merge 调用（负扫描测试锁定）。回复正文自动携带隐形
// self-marker（HTML 注释），collector 据它把后续同 thread 的平台笔迹归
// 'self'，防 feedback 自循环。幂等由上层 effects 台账管（idempotencyKey），
// 本函数是纯执行体。

import { executeCodeHostCall } from '@/services/codeHost/call'
import { probeCodeHostConnection } from '@/services/codeHost/connections'
import { callDeps, normalizedState, parseJson, type MrEnsureConnectionDeps } from './mrEnsure'

export interface MrThreadMessageFact {
  readonly messageRef: string
  readonly parentMessageRef: string | null
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly body: string
  readonly path: string | null
  readonly createdAt: string | null
}

export interface MrThreadFact {
  readonly threadRef: string
  /**
   * 只计算非平台回复的内容版本。平台自己的“收到”与处理结果不会改变该版本，
   * 因而不会把同一线程重新送进修复循环；外部追加回复一定产生新版本。
   */
  readonly revision: string
  /** 最近一条非平台消息的作者分类；平台回复不覆盖待处理作者。 */
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly resolved: boolean
  readonly lastBody: string
  readonly path: string | null
  /** 根评论与全部多轮回复，按 provider 返回顺序冻结。 */
  readonly messages: readonly MrThreadMessageFact[]
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
      readonly code:
        | 'mr-facts-lookup-failed'
        | 'mr-facts-head-race'
        | 'mr-facts-target-race'
        | 'mr-facts-threads-truncated'
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

interface GitlabBranchDetail {
  readonly name?: string
  readonly commit?: { readonly id?: string }
}

interface GitlabNote {
  readonly id: number
  readonly body?: string
  readonly author?: RawUser
  /** Provider-generated timeline notes (pushes, title changes, etc.) are not review feedback. */
  readonly system?: boolean
  readonly resolved?: boolean
  readonly position?: { readonly new_path?: string } | null
  readonly created_at?: string
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
  readonly created_at?: string
}

// Source observers aggregate many employee-case subscriptions, so they cannot pin one Case ID
// as the marker prefix. The opt-in path below recognizes only the platform's bounded, single-token
// HTML marker shape; ordinary collectors remain exact-prefix by default.
const PLATFORM_SELF_MARKER_RE = /<!-- aw-self:[^\s<>]{1,500} -->/

function classifyAuthor(
  user: RawUser | undefined,
  body: string,
  selfMarker: string | null,
  trustPlatformSelfMarkers: boolean,
  verifiedPlatformLogin: string | null,
): MrThreadFact['authorClass'] {
  const authorLogin = (user?.username ?? user?.login ?? '').toLowerCase()
  const platformAuthored =
    verifiedPlatformLogin !== null && authorLogin === verifiedPlatformLogin.toLowerCase()
  if (selfMarker !== null) {
    const markerPrefix = `<!-- aw-self:${selfMarker}`
    if (
      platformAuthored &&
      (body.includes(`${markerPrefix} -->`) || body.includes(`${markerPrefix}:`))
    ) {
      return 'self'
    }
  }
  if (trustPlatformSelfMarkers && platformAuthored && PLATFORM_SELF_MARKER_RE.test(body)) {
    return 'self'
  }
  if (authorLogin.endsWith('[bot]') || authorLogin.endsWith('-bot')) return 'bot'
  return 'human'
}

function summarizeThreadMessages(
  messages: readonly MrThreadMessageFact[],
): Pick<MrThreadFact, 'revision' | 'authorClass' | 'lastBody' | 'path'> {
  const external = messages.filter((message) => message.authorClass !== 'self')
  const last = external.at(-1)
  return {
    revision: last === undefined ? '0:self' : `${external.length}:${last.messageRef}`,
    authorClass: last?.authorClass ?? 'self',
    lastBody: last?.body ?? '',
    path: last?.path ?? null,
  }
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

async function targetOf(
  deps: MrEnsureConnectionDeps,
  detail: { readonly gitlab?: GitlabMrDetail; readonly github?: GithubPrDetail },
): Promise<
  | { readonly ok: true; readonly branch: string | null; readonly sha: string | null }
  | { readonly ok: false; readonly detail: string }
> {
  if (deps.provider === 'github') {
    return {
      ok: true,
      branch: detail.github?.base?.ref ?? null,
      sha: detail.github?.base?.sha ?? null,
    }
  }
  const branch = detail.gitlab?.target_branch ?? null
  if (branch === null) return { ok: true, branch: null, sha: null }
  const got = await executeCodeHostCall(
    {
      provider: 'gitlab',
      action: 'custom',
      params: {},
      request: {
        method: 'GET',
        path: `/projects/${deps.project}/repository/branches/${encodeURIComponent(branch)}`,
      },
    },
    callDeps(deps),
  )
  if (!got.ok) return { ok: false, detail: `${got.code}: ${got.summary}` }
  const parsed = parseJson<GitlabBranchDetail>(got.body)
  const sha = parsed?.commit?.id
  if (sha === undefined || !/^[a-f0-9]{40}$/.test(sha)) {
    return { ok: false, detail: 'target branch lookup returned no exact commit id' }
  }
  return { ok: true, branch, sha }
}

async function collectThreads(
  deps: MrEnsureConnectionDeps,
  mrRef: string,
  selfMarker: string | null,
  trustPlatformSelfMarkers: boolean,
  verifiedPlatformLogin: string | null,
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
      .map((discussion) => ({
        discussion,
        // GitLab exposes timeline entries such as "added 1 commit" through the
        // discussions endpoint as individual system notes. They are neither
        // actionable review feedback nor replyable discussion threads; treating
        // them as human feedback creates a repair loop and POST /discussions/:id
        // /notes fails with HTTP 400.
        notes: (discussion.notes ?? []).filter((note) => note.system !== true),
      }))
      .filter(({ notes }) => notes.length > 0)
      .map(({ discussion, notes }) => {
        const rootRef = String(notes[0]!.id)
        const messages = notes.map((note, index) => ({
          messageRef: String(note.id),
          parentMessageRef: index === 0 ? null : rootRef,
          authorClass: classifyAuthor(
            note.author,
            note.body ?? '',
            selfMarker,
            trustPlatformSelfMarkers,
            verifiedPlatformLogin,
          ),
          body: note.body ?? '',
          path: note.position?.new_path ?? null,
          createdAt: note.created_at ?? null,
        }))
        const summary = summarizeThreadMessages(messages)
        return {
          threadRef: discussion.id,
          ...summary,
          resolved: notes.every((n) => n.resolved === true),
          messages,
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
    const messages = notes.map((note) => ({
      messageRef: String(note.id),
      parentMessageRef: note.in_reply_to_id === undefined ? null : String(note.in_reply_to_id),
      authorClass: classifyAuthor(
        note.user,
        note.body ?? '',
        selfMarker,
        trustPlatformSelfMarkers,
        verifiedPlatformLogin,
      ),
      body: note.body ?? '',
      path: note.path ?? null,
      createdAt: note.created_at ?? null,
    }))
    const summary = summarizeThreadMessages(messages)
    return {
      threadRef,
      ...summary,
      // REST 不暴露 review thread resolution（GraphQL only）；恒 false，
      // 外部 resolve 状态由 policy 侧按「未解决」保守处理。
      resolved: false,
      messages,
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
  options: {
    readonly selfMarker?: string
    /** Source observers only: recognize the platform marker family across subscribed Cases. */
    readonly trustPlatformSelfMarkers?: boolean
  } = {},
): Promise<MrFactsResult> {
  const first = await fetchMrDetail(deps, mrRef)
  if (!first.ok) return { ok: false, code: 'mr-facts-lookup-failed', detail: first.detail }
  const head1 = headOf(first)
  const target1 = await targetOf(deps, first)
  if (!target1.ok) {
    return { ok: false, code: 'mr-facts-lookup-failed', detail: target1.detail }
  }

  const verifiedPlatformLogin =
    options.selfMarker !== undefined || options.trustPlatformSelfMarkers === true
      ? await probeCodeHostConnection({
          provider: deps.provider,
          baseUrl: deps.call.connection.baseUrl,
          token: deps.call.connection.token,
          rejectUnauthorized: deps.call.connection.rejectUnauthorized,
          ...(deps.call.fetchImpl === undefined ? {} : { fetchImpl: deps.call.fetchImpl }),
        }).then((result) => (result.ok && typeof result.login === 'string' ? result.login : null))
      : null

  const threads = await collectThreads(
    deps,
    mrRef,
    options.selfMarker ?? null,
    options.trustPlatformSelfMarkers ?? false,
    verifiedPlatformLogin,
  )
  if (!threads.ok) return { ok: false, code: threads.code, detail: threads.detail }
  const approvalHold = await collectApprovalHold(deps, mrRef, first.github)

  const second = await fetchMrDetail(deps, mrRef)
  if (!second.ok) return { ok: false, code: 'mr-facts-lookup-failed', detail: second.detail }
  const head2 = headOf(second)
  const target2 = await targetOf(deps, second)
  if (!target2.ok) {
    return { ok: false, code: 'mr-facts-lookup-failed', detail: target2.detail }
  }
  if (head1 !== head2) {
    return {
      ok: false,
      code: 'mr-facts-head-race',
      detail: `head moved during collection (${head1 ?? 'none'} -> ${head2 ?? 'none'})`,
    }
  }
  if (target1.branch !== target2.branch || target1.sha !== target2.sha) {
    return {
      ok: false,
      code: 'mr-facts-target-race',
      detail: `target moved during collection (${target1.branch ?? 'none'}@${target1.sha ?? 'none'} -> ${target2.branch ?? 'none'}@${target2.sha ?? 'none'})`,
    }
  }

  const gitlab = first.gitlab
  const github = first.github
  const rawState = gitlab?.state ?? github?.state ?? 'closed'
  const snapshot: MrFactsSnapshot = {
    mrRef,
    headSha: head1,
    targetSha: target1.sha,
    targetBranch: target1.branch,
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
