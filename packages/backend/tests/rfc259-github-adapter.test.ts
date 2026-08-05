// RFC-259 — GitHub adapter 回归锁（proposal AC-1/2/4/5/6/7/8 的纯函数面）。
// payload builder 按 GitHub 官方文档形态手写（webhook-events-and-payloads，
// 2026-08-05 查证）；真实 fixture 采集后（tests/fixtures/github-webhooks/README.md
// 实测清单）以 fixture 为准回改 adapter 与 design §2.2。
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import { githubNormalize, githubVerify, githubAdapter } from '@/services/webhook/githubAdapter'
import { CODE_HOST_ADAPTERS, replayHeaders } from '@/services/webhook/codeHostAdapter'

const REPOSITORY = {
  id: 42,
  name: 'api',
  full_name: 'acme/api',
  clone_url: 'https://github.com/acme/api.git',
  ssh_url: 'git@github.com:acme/api.git',
  default_branch: 'main',
  html_url: 'https://github.com/acme/api',
}

const SENDER = { login: 'dev-a', id: 1 }

function headers(event: string, extra: Record<string, string | undefined> = {}) {
  return { 'x-github-event': event, 'x-github-delivery': 'guid-123', ...extra }
}

function sign(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function pushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'refs/heads/feature/login',
    before: 'aaa',
    after: 'bbb1234',
    created: false,
    deleted: false,
    repository: REPOSITORY,
    pusher: { name: 'dev-a', email: 'dev-a@example.com' },
    sender: SENDER,
    commits: [],
    ...overrides,
  }
}

function prPayload(
  action: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    number: 7,
    pull_request: {
      number: 7,
      title: 'Fix login NPE',
      merged: false,
      head: { ref: 'feature/login', sha: 'ccc789' },
      base: { ref: 'main', sha: 'ddd000' },
      ...(typeof overrides['pull_request'] === 'object'
        ? (overrides['pull_request'] as Record<string, unknown>)
        : {}),
    },
    repository: REPOSITORY,
    sender: SENDER,
  }
}

function issueCommentPayload(overrides: {
  action?: string
  onPr?: boolean
  body?: string
}): Record<string, unknown> {
  return {
    action: overrides.action ?? 'created',
    issue: {
      number: 7,
      title: 'Fix login NPE',
      ...(overrides.onPr === false
        ? {}
        : { pull_request: { url: 'https://api.github.com/repos/acme/api/pulls/7' } }),
    },
    comment: { body: overrides.body ?? '/fix 把这个空指针处理掉' },
    repository: REPOSITORY,
    sender: { login: 'reviewer-b', id: 2 },
  }
}

function reviewCommentPayload(action = 'created'): Record<string, unknown> {
  return {
    action,
    comment: { body: '/fix 这一行会 NPE', commit_id: 'ccc789' },
    pull_request: {
      number: 7,
      title: 'Fix login NPE',
      head: { ref: 'feature/login', sha: 'ccc789' },
      base: { ref: 'main', sha: 'ddd000' },
    },
    repository: REPOSITORY,
    sender: { login: 'reviewer-b', id: 2 },
  }
}

function workflowRunPayload(
  conclusion: string | null,
  opts: { action?: string; withPr?: boolean; actor?: string } = {},
): Record<string, unknown> {
  return {
    action: opts.action ?? 'completed',
    workflow_run: {
      id: 1001,
      head_branch: 'feature/login',
      head_sha: 'ddd456',
      conclusion,
      actor: { login: opts.actor ?? 'aw-bot' },
      pull_requests:
        opts.withPr === false
          ? []
          : [
              {
                number: 7,
                head: { ref: 'feature/login', sha: 'ddd456' },
                base: { ref: 'main', sha: 'ddd000' },
              },
            ],
    },
    repository: REPOSITORY,
    sender: SENDER,
  }
}

describe('RFC-259 · githubVerify（HMAC-SHA256 对原始字节）', () => {
  const SECRET = 'whk-secret'

  test('三态：valid / invalid / missing（AC-1）', () => {
    const body = Buffer.from(JSON.stringify(pushPayload()), 'utf8')
    expect(githubVerify({ 'x-hub-signature-256': sign(SECRET, body) }, body, SECRET)).toBe('valid')
    expect(githubVerify({ 'x-hub-signature-256': sign('wrong', body) }, body, SECRET)).toBe(
      'invalid',
    )
    expect(githubVerify({}, body, SECRET)).toBe('missing')
    expect(githubVerify({ 'x-hub-signature-256': '' }, body, SECRET)).toBe('missing')
  })

  test('对原始字节计算：多字节 UTF-8 正确、body 单字节改动即 invalid（AC-2）', () => {
    const body = Buffer.from(
      JSON.stringify({ msg: '中文提交说明 🚀', repository: REPOSITORY }),
      'utf8',
    )
    const good = sign(SECRET, body)
    expect(githubVerify({ 'x-hub-signature-256': good }, body, SECRET)).toBe('valid')
    const tampered = Buffer.from(body)
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01
    expect(githubVerify({ 'x-hub-signature-256': good }, tampered, SECRET)).toBe('invalid')
  })

  test('不等长/无前缀/大写 hex 一律 invalid（不做宽容变换）', () => {
    const body = Buffer.from('{}', 'utf8')
    const good = sign(SECRET, body)
    expect(githubVerify({ 'x-hub-signature-256': good.slice(7) }, body, SECRET)).toBe('invalid')
    expect(githubVerify({ 'x-hub-signature-256': 'sha256=abc' }, body, SECRET)).toBe('invalid')
    expect(githubVerify({ 'x-hub-signature-256': good.toUpperCase() }, body, SECRET)).toBe(
      'invalid',
    )
  })
})

describe('RFC-259 · githubNormalize（design §2.2 映射表）', () => {
  test('push：refs/heads/ 前缀、after 为 commitSha、sender.login 为 author（AC-4）', () => {
    const r = githubNormalize(headers('push'), pushPayload())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.provider).toBe('github')
    expect(r.event.eventType).toBe('push')
    expect(r.event.branch).toBe('feature/login')
    expect(r.event.commitSha).toBe('bbb1234')
    expect(r.event.author.username).toBe('dev-a')
    expect(r.event.repoPath).toBe('acme/api')
    expect(r.event.repoHttpUrl).toBe('https://github.com/acme/api.git')
    expect(r.event.repoSshUrl).toBe('git@github.com:acme/api.git')
    expect(r.event.eventUuid).toBe('guid-123')
  })

  test('push：refs/tags/ → tag_push；deleted=true → unsupported；未知 ref 形态 → unsupported（AC-4）', () => {
    const tag = githubNormalize(headers('push'), pushPayload({ ref: 'refs/tags/v1.2.0' }))
    expect(tag.ok).toBe(true)
    if (tag.ok) {
      expect(tag.event.eventType).toBe('tag_push')
      expect(tag.event.branch).toBe('v1.2.0')
    }
    const del = githubNormalize(headers('push'), pushPayload({ deleted: true }))
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.reason).toBe('unsupported-event')
    const notes = githubNormalize(headers('push'), pushPayload({ ref: 'refs/notes/commits' }))
    expect(notes.ok).toBe(false)
    if (!notes.ok) expect(notes.reason).toBe('unsupported-event')
  })

  test('pull_request 六 action 映射 + closed 按 merged 分流（AC-5）', () => {
    for (const [action, expected] of [
      ['opened', 'mr_opened'],
      ['reopened', 'mr_opened'],
      ['synchronize', 'mr_updated'],
      ['edited', 'mr_updated'],
      ['ready_for_review', 'mr_updated'],
    ] as const) {
      const r = githubNormalize(headers('pull_request'), prPayload(action))
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.event.eventType).toBe(expected)
      expect(r.event.mrIid).toBe('7')
      expect(r.event.branch).toBe('feature/login')
      expect(r.event.targetBranch).toBe('main')
      expect(r.event.mrTitle).toBe('Fix login NPE')
      expect(r.event.commitSha).toBe('ccc789')
    }
    const merged = githubNormalize(
      headers('pull_request'),
      prPayload('closed', { pull_request: { merged: true } }),
    )
    expect(merged.ok).toBe(true)
    if (merged.ok) expect(merged.event.eventType).toBe('mr_merged')
    const closed = githubNormalize(headers('pull_request'), prPayload('closed'))
    expect(closed.ok).toBe(true)
    if (closed.ok) expect(closed.event.eventType).toBe('mr_closed')
    const labeled = githubNormalize(headers('pull_request'), prPayload('labeled'))
    expect(labeled.ok).toBe(false)
    if (!labeled.ok) expect(labeled.reason).toBe('unsupported-event')
  })

  test("issue_comment（PR 上）→ note：branch 缺省（D7'），mrIid=issue.number（AC-6）", () => {
    const r = githubNormalize(headers('issue_comment'), issueCommentPayload({}))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.eventType).toBe('note')
    expect(r.event.commentText).toBe('/fix 把这个空指针处理掉')
    expect(r.event.mrIid).toBe('7')
    expect(r.event.mrTitle).toBe('Fix login NPE')
    expect(r.event.branch).toBeUndefined()
    expect(r.event.targetBranch).toBeUndefined()
    expect(r.event.author.username).toBe('reviewer-b')
  })

  test('issue_comment：非 PR / 非 created → unsupported（AC-6）', () => {
    const notPr = githubNormalize(headers('issue_comment'), issueCommentPayload({ onPr: false }))
    expect(notPr.ok).toBe(false)
    if (!notPr.ok) expect(notPr.reason).toBe('unsupported-event')
    const edited = githubNormalize(
      headers('issue_comment'),
      issueCommentPayload({ action: 'edited' }),
    )
    expect(edited.ok).toBe(false)
    if (!edited.ok) expect(edited.reason).toBe('unsupported-event')
  })

  test('pull_request_review_comment → note：带 head.ref 分支（AC-6 行内评论正例）', () => {
    const r = githubNormalize(headers('pull_request_review_comment'), reviewCommentPayload())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.eventType).toBe('note')
    expect(r.event.branch).toBe('feature/login')
    expect(r.event.targetBranch).toBe('main')
    expect(r.event.mrIid).toBe('7')
    expect(r.event.commentText).toBe('/fix 这一行会 NPE')
    const dismissed = githubNormalize(
      headers('pull_request_review_comment'),
      reviewCommentPayload('deleted'),
    )
    expect(dismissed.ok).toBe(false)
  })

  test('workflow_run：failure/timed_out → pipeline_failed，success → succeeded，actor 为 author（AC-7）', () => {
    for (const [conclusion, expected] of [
      ['failure', 'pipeline_failed'],
      ['timed_out', 'pipeline_failed'],
      ['success', 'pipeline_succeeded'],
    ] as const) {
      const r = githubNormalize(headers('workflow_run'), workflowRunPayload(conclusion))
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.event.eventType).toBe(expected)
      expect(r.event.branch).toBe('feature/login')
      expect(r.event.commitSha).toBe('ddd456')
      expect(r.event.pipelineStatus).toBe(conclusion)
      expect(r.event.mrIid).toBe('7')
      expect(r.event.targetBranch).toBe('main')
      // D14/D22 前提：pipeline 的 author = 引发 run 的 actor（bot push → bot）
      expect(r.event.author.username).toBe('aw-bot')
    }
  })

  test('workflow_run：fork PR（pull_requests 空）→ mrIid 缺省；cancelled/requested → unsupported（AC-7）', () => {
    const fork = githubNormalize(
      headers('workflow_run'),
      workflowRunPayload('failure', { withPr: false }),
    )
    expect(fork.ok).toBe(true)
    if (fork.ok) {
      expect(fork.event.mrIid).toBeUndefined()
      expect(fork.event.branch).toBe('feature/login') // streamKey 降级落 branch 维度
    }
    const cancelled = githubNormalize(headers('workflow_run'), workflowRunPayload('cancelled'))
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.reason).toBe('unsupported-event')
    const inProgress = githubNormalize(
      headers('workflow_run'),
      workflowRunPayload(null, { action: 'in_progress' }),
    )
    expect(inProgress.ok).toBe(false)
    if (!inProgress.ok) expect(inProgress.reason).toBe('unsupported-event')
  })

  test('ping → unsupported（200 应答，org 级无 repository 也不 parse-fail）（AC-8）', () => {
    const r = githubNormalize(headers('ping'), { zen: 'Design for failure.', hook_id: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unsupported-event')
      expect(r.detail).toContain('ping')
    }
  })

  test('parse-failed 分支：缺事件头 / 非对象 / 缺 repository / PR 缺 number', () => {
    expect(githubNormalize({}, pushPayload()).ok).toBe(false)
    const noHeader = githubNormalize({}, pushPayload())
    if (!noHeader.ok) expect(noHeader.reason).toBe('parse-failed')
    expect(githubNormalize(headers('push'), 'x').ok).toBe(false)
    expect(githubNormalize(headers('push'), { ref: 'refs/heads/x' }).ok).toBe(false)
    const badPr = githubNormalize(headers('pull_request'), {
      action: 'opened',
      pull_request: { title: 'no number' },
      repository: REPOSITORY,
      sender: SENDER,
    })
    expect(badPr.ok).toBe(false)
    if (!badPr.ok) expect(badPr.reason).toBe('parse-failed')
  })

  test('未知事件 → unsupported（star/fork/release 等 v1 不做）', () => {
    const r = githubNormalize(headers('star'), { repository: REPOSITORY, sender: SENDER })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsupported-event')
  })

  test('事件头缺失时 eventUuid 缺省逻辑仍走 deliveryIdHeader（F-18 降级）', () => {
    const r = githubNormalize({ 'x-github-event': 'push' }, pushPayload())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.eventUuid).toBeNull()
  })
})

describe('RFC-259 · adapter 元数据与 replay 重建', () => {
  test('注册表 github 在册；头名字段与 allowlist 一致', () => {
    expect(CODE_HOST_ADAPTERS['github']).toBe(githubAdapter)
    expect(githubAdapter.headerAllowlist).toContain(githubAdapter.deliveryIdHeader)
    expect(githubAdapter.headerAllowlist).toContain(githubAdapter.eventHeader)
    expect(githubAdapter.headerAllowlist).toContain('x-hub-signature-256')
  })

  test('replayHeaders：审计列值重建事件头（AC-14 的纯函数面）', () => {
    const rebuilt = replayHeaders(githubAdapter, 'workflow_run')
    const r = githubNormalize(rebuilt, workflowRunPayload('failure'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.eventType).toBe('pipeline_failed')
    // 列值缺失（老行/异常路径）→ 空 bag → parse-failed（可诊断，不误判成功）
    const empty = githubNormalize(replayHeaders(githubAdapter, null), workflowRunPayload('failure'))
    expect(empty.ok).toBe(false)
  })

  test('summaryKindOf = 事件头值（github 无 object_kind 同位物）', () => {
    expect(githubAdapter.summaryKindOf(headers('push'), pushPayload())).toBe('push')
    expect(githubAdapter.summaryKindOf({}, pushPayload())).toBeNull()
  })
})
