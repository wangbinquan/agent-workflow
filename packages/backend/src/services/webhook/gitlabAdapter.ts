// RFC-257 T3 — GitLab webhook adapter：验签 + payload 归一化。
// 平台特有知识全部封在本文件（multica channel/doc.go 边界规则：核心只读
// CodeHostEvent 信封，raw 只入库审计 + {{event_json}}）。字段路径依据 GitLab
// webhook 文档与 tests/fixtures/gitlab-webhooks/ 下的样例；与真实实例不符时
// **以 fixture 为准回改本文件与 design §2.3**（T3 实测清单见 fixtures README）。
//
// 验签是 GitLab 语义：X-Gitlab-Token 与配置 secret 的**明文常量时间比对**
// （不是 GitHub 的 HMAC 签名——该差异被 CodeHostAdapter.verify 接口封装，
// githubAdapter.ts 在同一接口下实现 HMAC）。接口与注册表在 RFC-259 迁至
// codeHostAdapter.ts；本文件只剩 GitLab 实现，行为与 RFC-257 逐字节相同。
import { timingSafeEqual } from 'node:crypto'

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

function stripRefPrefix(ref: string | undefined, prefix: string): string | undefined {
  if (ref === undefined) return undefined
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
}

/**
 * 常量时间比对（长度不同必然 invalid，但仍走一次定长比较避免早退时序面）。
 * rawBody 是接口 v2（RFC-259 D2）为 GitHub HMAC 加的参数——GitLab 明文
 * token 比对不消费它。
 */
export function gitlabVerify(
  headers: HeaderBag,
  _rawBody: Uint8Array,
  secret: string,
): 'valid' | 'invalid' | 'missing' {
  const presented = headers['x-gitlab-token']
  if (presented === undefined || presented.length === 0) return 'missing'
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(secret, 'utf8')
  if (a.length !== b.length) {
    // 仍执行一次同长比较，避免「长度不等即刻返回」的可测时序差。
    timingSafeEqual(a, a)
    return 'invalid'
  }
  return timingSafeEqual(a, b) ? 'valid' : 'invalid'
}

type ProjectFields = {
  repoPath: string
  repoHttpUrl: string
  repoSshUrl: string
}

function parseProject(body: Record<string, unknown>): ProjectFields | undefined {
  const project = rec(body['project'])
  if (!project) return undefined
  const repoPath = str(project['path_with_namespace'])
  const repoHttpUrl = str(project['git_http_url'])
  const repoSshUrl = str(project['git_ssh_url'])
  if (repoPath === undefined || repoHttpUrl === undefined || repoSshUrl === undefined) {
    return undefined
  }
  return { repoPath, repoHttpUrl, repoSshUrl }
}

/** MR 属性块（merge_request 事件的 object_attributes / note・pipeline 事件的 merge_request）。 */
function parseMrBlock(v: unknown): {
  mrIid?: string
  mrTitle?: string
  sourceBranch?: string
  targetBranch?: string
  lastCommitSha?: string
} {
  const mr = rec(v)
  if (!mr) return {}
  const iidRaw = mr['iid']
  const lastCommit = rec(mr['last_commit'])
  return {
    mrIid:
      typeof iidRaw === 'number' ? String(iidRaw) : typeof iidRaw === 'string' ? iidRaw : undefined,
    mrTitle: str(mr['title']),
    sourceBranch: str(mr['source_branch']),
    targetBranch: str(mr['target_branch']),
    lastCommitSha: lastCommit ? str(lastCommit['id']) : undefined,
  }
}

/** user{} 块（MR/note/pipeline 事件）；push 事件是顶层 user_username（形态差异见 fixture）。 */
function parseUser(body: Record<string, unknown>): { username?: string; name?: string } {
  const user = rec(body['user'])
  if (user) {
    return { username: str(user['username']), name: str(user['name']) }
  }
  return { username: str(body['user_username']), name: str(body['user_name']) }
}

/**
 * 归一化 GitLab webhook payload（design §2.3 映射表）。不支持的 object_kind /
 * pipeline 中间态 / 非 MR 的 note 一律 `unsupported-event`（→ delivery
 * ignored，不落 fire）。
 */
export function gitlabNormalize(headers: HeaderBag, body: unknown): NormalizeResult {
  const root = rec(body)
  if (!root) return { ok: false, reason: 'parse-failed', detail: 'payload is not a JSON object' }
  const objectKind = str(root['object_kind'])
  if (objectKind === undefined) {
    return { ok: false, reason: 'parse-failed', detail: 'missing object_kind' }
  }
  const project = parseProject(root)
  if (!project) {
    return {
      ok: false,
      reason: 'parse-failed',
      detail: `missing project fields for object_kind '${objectKind}'`,
    }
  }
  const eventUuid = headers['x-gitlab-event-uuid'] ?? null
  const author = parseUser(root)
  const base = { provider: 'gitlab' as const, eventUuid, ...project, author, raw: body }

  if (objectKind === 'push' || objectKind === 'tag_push') {
    const prefix = objectKind === 'push' ? 'refs/heads/' : 'refs/tags/'
    const branch = stripRefPrefix(str(root['ref']), prefix)
    if (branch === undefined) {
      return { ok: false, reason: 'parse-failed', detail: `missing ref for '${objectKind}'` }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType: objectKind as CodeHostEventType,
        branch,
        commitSha: str(root['after']) ?? str(root['checkout_sha']),
      },
    }
  }

  if (objectKind === 'merge_request') {
    const attrs = rec(root['object_attributes'])
    const action = attrs ? str(attrs['action']) : undefined
    const mr = parseMrBlock(attrs)
    const eventType: CodeHostEventType | undefined =
      action === 'open' || action === 'reopen'
        ? 'mr_opened'
        : action === 'update'
          ? 'mr_updated'
          : action === 'merge'
            ? 'mr_merged'
            : action === 'close'
              ? 'mr_closed'
              : undefined
    if (eventType === undefined) {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `merge_request action '${action ?? '(none)'}' not handled`,
      }
    }
    if (mr.sourceBranch === undefined || mr.mrIid === undefined) {
      return {
        ok: false,
        reason: 'parse-failed',
        detail: 'merge_request missing iid/source_branch',
      }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType,
        branch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        mrIid: mr.mrIid,
        mrTitle: mr.mrTitle,
        commitSha: mr.lastCommitSha,
      },
    }
  }

  if (objectKind === 'note') {
    const attrs = rec(root['object_attributes'])
    const noteableType = attrs ? str(attrs['noteable_type']) : undefined
    if (noteableType !== 'MergeRequest') {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `note on '${noteableType ?? '(unknown)'}' not handled (v1: MR comments only)`,
      }
    }
    const commentText = attrs ? str(attrs['note']) : undefined
    const mr = parseMrBlock(root['merge_request'])
    if (commentText === undefined || mr.mrIid === undefined || mr.sourceBranch === undefined) {
      return { ok: false, reason: 'parse-failed', detail: 'note missing note text / merge_request' }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType: 'note',
        branch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        mrIid: mr.mrIid,
        mrTitle: mr.mrTitle,
        commentText,
      },
    }
  }

  if (objectKind === 'pipeline') {
    const attrs = rec(root['object_attributes'])
    const status = attrs ? str(attrs['status']) : undefined
    const eventType: CodeHostEventType | undefined =
      status === 'failed'
        ? 'pipeline_failed'
        : status === 'success'
          ? 'pipeline_succeeded'
          : undefined
    if (eventType === undefined) {
      return {
        ok: false,
        reason: 'unsupported-event',
        detail: `pipeline status '${status ?? '(none)'}' not handled (only failed/success)`,
      }
    }
    const mr = parseMrBlock(root['merge_request'])
    const pipelineRef = attrs ? str(attrs['ref']) : undefined
    const branch = mr.sourceBranch ?? pipelineRef
    if (branch === undefined) {
      return { ok: false, reason: 'parse-failed', detail: 'pipeline missing ref/merge_request' }
    }
    return {
      ok: true,
      event: {
        ...base,
        eventType,
        branch,
        targetBranch: mr.targetBranch,
        mrIid: mr.mrIid,
        commitSha: attrs ? str(attrs['sha']) : undefined,
        pipelineStatus: status,
      },
    }
  }

  return {
    ok: false,
    reason: 'unsupported-event',
    detail: `object_kind '${objectKind}' not handled`,
  }
}

/** 摘要判别符（原 routes/webhooks.ts objectKindOf，RFC-259 迁入；类型窄化零 cast——routes-no-cast 锁）。 */
export function gitlabSummaryKindOf(_headers: HeaderBag, parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const value = Object.entries(parsed).find(([k]) => k === 'object_kind')?.[1]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export const gitlabAdapter: CodeHostAdapter = {
  provider: 'gitlab',
  headerAllowlist: ['x-gitlab-token', 'x-gitlab-event-uuid', 'x-gitlab-event'],
  deliveryIdHeader: 'x-gitlab-event-uuid',
  eventHeader: 'x-gitlab-event',
  summaryKindOf: gitlabSummaryKindOf,
  verify: gitlabVerify,
  normalize: gitlabNormalize,
}
