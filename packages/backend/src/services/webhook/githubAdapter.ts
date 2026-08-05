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
  return { repoPath, repoHttpUrl, repoSshUrl }
}

/** sender = 触发本次事件的平台用户（全事件统一，RFC-259 D5；GitHub user 对象无显示名字段）。 */
function parseSender(body: Record<string, unknown>): { username?: string; name?: string } {
  const sender = rec(body['sender'])
  return { username: sender ? str(sender['login']) : undefined }
}

/** pull_request 对象的公共字段块（pull_request / pull_request_review_comment 事件）。 */
function parsePrBlock(v: unknown): {
  mrIid?: string
  mrTitle?: string
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
    mrTitle: str(pr['title']),
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
  const author = parseSender(root)
  const base = { provider: 'github' as const, eventUuid, ...repository, author, raw: body }

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
        mrTitle: pr.mrTitle,
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
    if (!issue || rec(issue['pull_request']) === undefined) {
      // issue（非 PR）上的评论：对齐 GitLab noteable_type 门（v1 只做 MR/PR 评论）。
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: 'issue comment (not on a pull request) not handled',
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
        mrTitle: pr.mrTitle,
        commitSha: pr.headSha,
        commentText,
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
        commitSha: str(run['head_sha']),
        pipelineStatus: conclusion,
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
