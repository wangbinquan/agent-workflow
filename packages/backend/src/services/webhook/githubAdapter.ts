// RFC-259 — GitHub webhook adapter：HMAC-SHA256 验签 + payload 归一化。
// 平台特有知识全部封在本文件（gitlabAdapter.ts 同款边界规则：核心只读
// CodeHostEvent 信封）。字段路径依据 GitHub 官方文档（webhook-events-and-
// payloads / validating-webhook-deliveries，2026-08-05 查证）与
// tests/fixtures/github-webhooks/ 样例；与真实投递不符时**以 fixture 为准
// 回改本文件与 design §2.2**（实测清单见 fixtures README）。
//
// 验签是 GitHub 语义（RFC-259 D2/D11）：X-Hub-Signature-256 = `sha256=` +
// HMAC-SHA256(secret, 原始请求字节) 的小写 hex。GitHub 侧未配 secret 时该头
// 整个缺失 → 'missing'（平台端点必有 secret，无签投递一律 401 拒绝）。
// 事件种类判别 = X-GitHub-Event 头（GitLab 是 body.object_kind）。
import { createHmac, timingSafeEqual } from 'node:crypto'

import type { CodeHostEventType } from '@agent-workflow/shared'

import type {
  CodeHostAdapter,
  HeaderBag,
  NormalizeResult,
} from '@/services/webhook/codeHostAdapter'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** GitHub 的编号字段是数字（PR number / issue number）；信封统一字符串。 */
function numStr(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? String(v)
    : typeof v === 'string' && v.length > 0
      ? v
      : undefined
}

/** RFC-263 —— 保持数字形态（position 包要回传给 API，行号必须是数字不是字符串）。 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * RFC-263（design §4.2）—— GitHub 的 REST base。
 *
 * 后缀剥离拿到实例根，再按主机名分流：github.com → `https://api.github.com`；
 * 其余（GHES）→ `<实例>/api/v3`。形态不符或畸形 URL 一律 undefined（→ 变量
 * 渲染空串），不猜。
 */
export function githubApiBaseUrl(
  htmlUrl: string | undefined,
  fullName: string | undefined,
): string | undefined {
  if (htmlUrl === undefined || fullName === undefined) return undefined
  const suffix = `/${fullName}`
  if (!htmlUrl.endsWith(suffix)) return undefined
  const base = htmlUrl.slice(0, htmlUrl.length - suffix.length)
  if (base.length === 0) return undefined
  let hostname: string
  try {
    hostname = new URL(base).hostname
  } catch {
    return undefined
  }
  return hostname === 'github.com' || hostname === 'www.github.com'
    ? 'https://api.github.com'
    : `${base}/api/v3`
}

/**
 * RFC-263（design §5.2）—— GitHub 行内评论的位置参数包。
 *
 * 键名 = `POST /repos/{o}/{r}/pulls/{n}/comments` 的 body 参数名，agent 原样回传
 * 即可建一条同位置的行内评论。两条与 GitLab 相反的规则：
 *   - **省略 null 键**：GitHub 的 null 是「不适用」（`start_line:null` ⇒ 单行评论），
 *     原样传给 API 会 422；GitLab 的 null 有语义（`old_line:null` ⇒ 新增行）必须保留。
 *   - **当前行与原始行成组二选一**：`line` 为 null 表示该行已被后续 commit 改动，
 *     此时整组落到 `original_*`（schema 标注 original_line 非 null）。混用两组会
 *     产出一个自相矛盾的范围。
 * 不含 `diff_hunk`：那是上下文不是定位参数（可能几十行），agent 有 worktree 可直接
 * 读文件，需要时也仍能从 {{trigger.webhook.event_json}} 取。
 */
function githubCommentPosition(
  comment: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const path = str(comment['path'])
  if (path === undefined) return undefined
  const out: Record<string, unknown> = { path }
  const current = num(comment['line'])
  const line = current ?? num(comment['original_line'])
  const startLine =
    current === undefined ? num(comment['original_start_line']) : num(comment['start_line'])
  if (line !== undefined) out['line'] = line
  const side = str(comment['side'])
  if (side !== undefined) out['side'] = side
  if (startLine !== undefined) out['start_line'] = startLine
  const startSide = str(comment['start_side'])
  if (startSide !== undefined) out['start_side'] = startSide
  const commitId = str(comment['commit_id'])
  if (commitId !== undefined) out['commit_id'] = commitId
  return out
}

/**
 * HMAC-SHA256 验签（AC-1/AC-2）。对**原始请求字节**计算（官方文档明示 payload
 * 按 UTF-8 处理）；比较完整 `sha256=<hex>` 串、常量时间、不等长走一次同长
 * 比较（gitlabVerify 同款时序防御）。不做大小写规范化（GitHub 恒发小写 hex，
 * 攻击者可控输入不做宽容变换）；不支持 legacy X-Hub-Signature（SHA-1）。
 */
export function githubVerify(
  headers: HeaderBag,
  rawBody: Uint8Array,
  secret: string,
): 'valid' | 'invalid' | 'missing' {
  const presented = headers['x-hub-signature-256']
  if (presented === undefined || presented.length === 0) return 'missing'
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return 'invalid'
  }
  return timingSafeEqual(a, b) ? 'valid' : 'invalid'
}

type RepositoryFields = {
  repoPath: string
  repoHttpUrl: string
  repoSshUrl: string
  /** RFC-263 —— 全部软提取：缺失只让对应变量渲染空串，不影响投递归一化。 */
  projectId?: string
  projectWebUrl?: string
  defaultBranch?: string
  repoOwner?: string
  repoName?: string
  apiBaseUrl?: string
}

function parseRepository(body: Record<string, unknown>): RepositoryFields | undefined {
  const repository = rec(body['repository'])
  if (!repository) return undefined
  const repoPath = str(repository['full_name'])
  const repoHttpUrl = str(repository['clone_url'])
  const repoSshUrl = str(repository['ssh_url'])
  if (repoPath === undefined || repoHttpUrl === undefined || repoSshUrl === undefined) {
    return undefined
  }
  const projectWebUrl = str(repository['html_url'])
  const owner = rec(repository['owner'])
  return {
    repoPath,
    repoHttpUrl,
    repoSshUrl,
    projectId: numStr(repository['id']),
    projectWebUrl,
    defaultBranch: str(repository['default_branch']),
    // 取 owner.login / name 原字段而不是切 full_name —— 原字段更权威，且 GitHub
    // 的 owner 恒为单段，不存在 GitLab 那种多层 namespace 的切分问题。
    repoOwner: owner ? str(owner['login']) : undefined,
    repoName: str(repository['name']),
    apiBaseUrl: githubApiBaseUrl(projectWebUrl, repoPath),
  }
}

/**
 * sender = 触发本次事件的平台用户（全事件统一，RFC-259 D5；GitHub user 对象无显示
 * 名字段）。RFC-263 追加 `id`。
 */
function parseSender(body: Record<string, unknown>): {
  username?: string
  name?: string
  id?: string
} {
  const sender = rec(body['sender'])
  return {
    username: sender ? str(sender['login']) : undefined,
    id: sender ? numStr(sender['id']) : undefined,
  }
}

/** GitHub labels are objects with a `name`; plain strings are accepted too. */
function githubLabelNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    const name = str(rec(entry)?.['name'])
    if (name !== undefined) out.push(name)
  }
  return out
}

/** pull_request 对象的公共字段块（pull_request / pull_request_review_comment 事件）。 */
function parsePrBlock(v: unknown): {
  mrIid?: string
  /** RFC-263 —— global id，区别于 REST 路径用的 number。 */
  mrId?: string
  mrTitle?: string
  /** RFC-263 —— PR 网页地址（`html_url`，不是 API 的 `url`）。 */
  mrUrl?: string
  sourceBranch?: string
  targetBranch?: string
  headSha?: string
  merged: boolean
} {
  const pr = rec(v)
  if (!pr) return { merged: false }
  const head = rec(pr['head'])
  const base = rec(pr['base'])
  return {
    mrIid: numStr(pr['number']),
    mrId: numStr(pr['id']),
    mrTitle: str(pr['title']),
    mrUrl: str(pr['html_url']),
    sourceBranch: head ? str(head['ref']) : undefined,
    targetBranch: base ? str(base['ref']) : undefined,
    headSha: head ? str(head['sha']) : undefined,
    merged: pr['merged'] === true,
  }
}

const PR_ACTION_MAP: Readonly<Record<string, CodeHostEventType>> = {
  opened: 'mr_opened',
  reopened: 'mr_opened',
  synchronize: 'mr_updated',
  edited: 'mr_updated',
  ready_for_review: 'mr_updated',
}

/**
 * 归一化 GitHub webhook payload（design §2.2 映射表）。不支持的事件 / action /
 * conclusion 一律 `unsupported-event`（→ delivery ignored 200——含 `ping`，
 * GitHub 创建 hook 的连通性测试拿到 2xx 即绿）。`ping` 在 repository 解析之前
 * 返回：org 级 webhook 的 ping 没有 repository 对象（proposal §8.4）。
 */
export function githubNormalize(headers: HeaderBag, body: unknown): NormalizeResult {
  const eventName = headers['x-github-event']
  if (eventName === undefined || eventName.length === 0) {
    return { ok: false, reason: 'parse-failed', detail: 'missing x-github-event header' }
  }
  if (eventName === 'ping') {
    return { ok: false, reason: 'unsupported-event', detail: 'ping acknowledged' }
  }
  const root = rec(body)
  if (!root) return { ok: false, reason: 'parse-failed', detail: 'payload is not a JSON object' }
  const repository = parseRepository(root)
  if (!repository) {
    return {
      ok: false,
      reason: 'parse-failed',
      detail: `missing repository fields for event '${eventName}'`,
    }
  }
  const eventUuid = headers['x-github-delivery'] ?? null
  const sender = parseSender(root)
  const base = {
    provider: 'github' as const,
    eventUuid,
    ...repository,
    author: { username: sender.username, name: sender.name },
    authorId: sender.id,
    raw: body,
  }

  if (eventName === 'push') {
    if (root['deleted'] === true) {
      return { ok: false, reason: 'unsupported-event', detail: 'branch deletion push not handled' }
    }
    const ref = str(root['ref'])
    if (ref === undefined) {
      return { ok: false, reason: 'parse-failed', detail: 'push missing ref' }
    }
    const eventType: CodeHostEventType | undefined = ref.startsWith('refs/heads/')
      ? 'push'
      : ref.startsWith('refs/tags/')
        ? 'tag_push'
        : undefined
    if (eventType === undefined) {
      return { ok: false, reason: 'unsupported-event', detail: `push ref '${ref}' not handled` }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType,
        branch: ref.slice(eventType === 'push' ? 'refs/heads/'.length : 'refs/tags/'.length),
        commitSha: str(root['after']),
        commitBefore: str(root['before']),
      },
    }
  }

  if (eventName === 'pull_request') {
    const action = str(root['action'])
    const pr = parsePrBlock(root['pull_request'])
    const eventType: CodeHostEventType | undefined =
      action === 'closed'
        ? pr.merged
          ? 'mr_merged'
          : 'mr_closed'
        : action !== undefined
          ? PR_ACTION_MAP[action]
          : undefined
    if (eventType === undefined) {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `pull_request action '${action ?? '(none)'}' not handled`,
      }
    }
    if (pr.mrIid === undefined || pr.sourceBranch === undefined) {
      return {
        ok: false,
        reason: 'parse-failed',
        detail: 'pull_request missing number/head.ref',
      }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType,
        branch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        mrIid: pr.mrIid,
        mrId: pr.mrId,
        mrTitle: pr.mrTitle,
        mrUrl: pr.mrUrl,
        commitSha: pr.headSha,
      },
    }
  }

  if (eventName === 'issue_comment') {
    const action = str(root['action'])
    if (action !== 'created') {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `issue_comment action '${action ?? '(none)'}' not handled`,
      }
    }
    const issue = rec(root['issue'])
    if (!issue) {
      return { ok: false, reason: 'parse-failed', detail: 'issue_comment missing issue block' }
    }

    // RFC-304 T46a — a comment on a real ISSUE, not a pull request.
    //
    // GitHub sends both through the same `issue_comment` hook and distinguishes
    // them only by the presence of `issue.pull_request`. Until now the non-PR
    // side was rejected, which meant an answer to the platform's own clarifying
    // question was dropped at the door: the person replied where they were
    // asked, and nothing happened.
    if (rec(issue['pull_request']) === undefined) {
      const comment = rec(root['comment'])
      const commentText = comment ? str(comment['body']) : undefined
      const issueIid = numStr(issue['number'])
      if (commentText === undefined || issueIid === undefined) {
        return { ok: false, reason: 'parse-failed', detail: 'issue_comment missing body/number' }
      }
      return {
        ok: true,
        event: {
          ...base,
          eventType: 'issue_comment',
          issueIid,
          issueTitle: str(issue['title']),
          issueUrl: str(issue['html_url']),
          issueBody: str(issue['body']),
          ...(githubLabelNames(issue['labels']) === undefined
            ? {}
            : { issueLabels: githubLabelNames(issue['labels']) }),
          commentText,
          commentId: numStr(comment?.['id']),
          commentUrl: comment ? str(comment['html_url']) : undefined,
        },
      }
    }
    const comment = rec(root['comment'])
    const commentText = comment ? str(comment['body']) : undefined
    const mrIid = numStr(issue['number'])
    if (commentText === undefined || mrIid === undefined) {
      return { ok: false, reason: 'parse-failed', detail: 'issue_comment missing body/number' }
    }
    // D7'：普通 PR 评论的 payload 不含分支（issue.pull_request 只有 API URL），
    // 零平台 API 下 branch/targetBranch 缺省——fire 不注入 ref、任务跑仓库默认
    // 分支；branchFilter 非空的触发器按 '' 匹配必 miss（文档写明）。
    return {
      ok: true,
      event: {
        ...base,
        eventType: 'note',
        mrIid,
        mrTitle: str(issue['title']),
        commentText,
        // RFC-263：`issue.html_url` 就是 PR 页面地址（issue 与 PR 共用编号空间的
        // 网页路由），可直接当 mrUrl 用。但 **`issue.id` 不是 PR 的 id**——两者是
        // 独立的 id 空间，填进 mrId 会让任何按 global id 查 PR 的调用查到别的东西，
        // 所以这里有意不填 mrId。
        mrUrl: str(issue['html_url']),
        commentId: numStr(comment?.['id']),
        commentUrl: comment ? str(comment['html_url']) : undefined,
        // commentThreadId 有意不填：普通 PR 评论没有线程概念（回复只能新开一条
        // issue comment），编造一个 id 会让模板作者以为能回到线程里（proposal AC-2）。
      },
    }
  }

  if (eventName === 'issues') {
    // RFC-304 T46a — labelling an issue is how `requirement` is entered.
    //
    // Only `labeled` is routed. The `issues` hook fires on opened, edited,
    // assigned, milestoned and half a dozen more; treating them all as an entry
    // point would start work every time somebody fixed a typo in a requirement
    // they had already submitted.
    const action = str(root['action'])
    if (action !== 'labeled') {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `issues action '${action ?? '(none)'}' not handled (only 'labeled')`,
      }
    }
    const issue = rec(root['issue'])
    const issueIid = issue ? numStr(issue['number']) : undefined
    if (issue === undefined || issueIid === undefined) {
      return { ok: false, reason: 'parse-failed', detail: 'issues event missing issue/number' }
    }

    // GitHub names the label that was just added in a top-level `label` block —
    // which is why `labeled` is a distinct action rather than something to
    // diff out of the labels array, as it has to be on GitLab.
    const added = str(rec(root['label'])?.['name'])

    return {
      ok: true,
      event: {
        ...base,
        eventType: 'issue_labeled',
        issueIid,
        issueTitle: str(issue['title']),
        issueUrl: str(issue['html_url']),
        issueBody: str(issue['body']),
        ...(githubLabelNames(issue['labels']) === undefined
          ? {}
          : { issueLabels: githubLabelNames(issue['labels']) }),
        ...(added === undefined ? {} : { addedLabels: [added] }),
      },
    }
  }

  if (eventName === 'pull_request_review_comment') {
    const action = str(root['action'])
    if (action !== 'created') {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `pull_request_review_comment action '${action ?? '(none)'}' not handled`,
      }
    }
    const pr = parsePrBlock(root['pull_request'])
    const comment = rec(root['comment'])
    const commentText = comment ? str(comment['body']) : undefined
    if (commentText === undefined || pr.mrIid === undefined || pr.sourceBranch === undefined) {
      return {
        ok: false,
        reason: 'parse-failed',
        detail: 'pull_request_review_comment missing body/pull_request',
      }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType: 'note',
        branch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        mrIid: pr.mrIid,
        mrId: pr.mrId,
        mrTitle: pr.mrTitle,
        mrUrl: pr.mrUrl,
        commitSha: pr.headSha,
        commentText,
        commentId: numStr(comment?.['id']),
        commentUrl: comment ? str(comment['html_url']) : undefined,
        // RFC-263（design §5.1）：回复端点吃的是**线程根评论的 id**。回复别人的
        // 行内评论时 in_reply_to_id 指向根；对根评论本身回复时该字段不存在，此时
        // 根就是 comment.id。只用 comment.id 会让「回复第 3 条」开出一条新线程。
        commentThreadId: numStr(comment?.['in_reply_to_id']) ?? numStr(comment?.['id']),
        commentPosition: comment === undefined ? undefined : githubCommentPosition(comment),
      },
    }
  }

  if (eventName === 'workflow_run') {
    const action = str(root['action'])
    if (action !== 'completed') {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `workflow_run action '${action ?? '(none)'}' not handled`,
      }
    }
    const run = rec(root['workflow_run'])
    if (!run) {
      return { ok: false, reason: 'parse-failed', detail: 'workflow_run missing workflow_run' }
    }
    const conclusion = str(run['conclusion'])
    // timed_out 归 failed（D10）：GitLab 把流水线超时判为 status=failed，归并
    // 是对参考语义的忠实还原。其余 conclusion（cancelled/skipped/neutral/…）
    // 与 GitLab 侧「非 failed/success 一律 unsupported」对称。
    const eventType: CodeHostEventType | undefined =
      conclusion === 'failure' || conclusion === 'timed_out'
        ? 'pipeline_failed'
        : conclusion === 'success'
          ? 'pipeline_succeeded'
          : undefined
    if (eventType === undefined) {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `workflow_run conclusion '${conclusion ?? '(none)'}' not handled`,
      }
    }
    // pull_requests[] 只对同仓 PR 填充（fork PR 为空，proposal §8.2）——缺失时
    // streamKey 降级为 repo|branch:<head_branch> 维度。head_branch 官方标注
    // nullable：缺失不 parse-fail，streamKey/branchFilter 按空串降级（可预测）。
    const pull = rec((Array.isArray(run['pull_requests']) ? run['pull_requests'] : [])[0])
    const pullBase = pull ? rec(pull['base']) : undefined
    const actor = rec(run['actor'])
    return {
      ok: true,
      event: {
        ...base,
        eventType,
        branch: str(run['head_branch']),
        targetBranch: pullBase ? str(pullBase['ref']) : undefined,
        mrIid: pull ? numStr(pull['number']) : undefined,
        mrId: pull ? numStr(pull['id']) : undefined,
        // mrUrl 有意不填：`pull_requests[].url` 是 **API URL** 而非网页地址，填进去
        // 会让「回帖里贴 PR 链接」这个动作贴出一条 JSON 端点（design §3.2）。
        commitSha: str(run['head_sha']),
        pipelineStatus: conclusion,
        // RFC-263：run id 是「rerun / 列 jobs / 拉失败日志」三个动作的入口。
        pipelineId: numStr(run['id']),
        pipelineUrl: str(run['html_url']),
        // 熔断重置判定（RFC-257 D22）要「引发这次流水线的人」：actor 是
        // initially-triggering user（是否 = push 者列入 fixtures 实测清单）。
        author: {
          username: (actor ? str(actor['login']) : undefined) ?? base.author.username,
        },
      },
    }
  }

  return {
    ok: false,
    reason: 'unsupported-event',
    detail: `event '${eventName}' not handled`,
  }
}

export const githubAdapter: CodeHostAdapter = {
  provider: 'github',
  headerAllowlist: ['x-hub-signature-256', 'x-github-delivery', 'x-github-event'],
  deliveryIdHeader: 'x-github-delivery',
  eventHeader: 'x-github-event',
  // GitHub 的判别符就是事件头（payload 无 object_kind 同位物）。
  summaryKindOf: (headers) => headers['x-github-event'] ?? null,
  verify: githubVerify,
  normalize: githubNormalize,
}
