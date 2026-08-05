// RFC-257 T3 — GitLab adapter 回归锁（AC-1 验签三态的纯函数层 + design §2.3
// 归一化映射表全行覆盖）。payload builder 按 GitLab 官方文档形态手写；真实
// fixture 采集后（tests/fixtures/gitlab-webhooks/README.md 实测清单）以
// fixture 为准回改。
import { describe, expect, test } from 'bun:test'

import { gitlabNormalize, gitlabVerify } from '@/services/webhook/gitlabAdapter'
import { CODE_HOST_ADAPTERS } from '@/services/webhook/codeHostAdapter'

/** 接口 v2（RFC-259 D2）为 GitHub HMAC 加的字节参——GitLab 明文比对不消费。 */
const NO_BODY = new Uint8Array(0)

const PROJECT = {
  id: 42,
  name: 'api',
  path_with_namespace: 'platform/backend/api',
  git_http_url: 'https://gitlab.example.com/platform/backend/api.git',
  git_ssh_url: 'git@gitlab.example.com:platform/backend/api.git',
  default_branch: 'main',
  web_url: 'https://gitlab.example.com/platform/backend/api',
}

const HEADERS = { 'x-gitlab-event-uuid': 'uuid-123' }

function pushPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'push',
    ref: 'refs/heads/feature/login',
    before: 'aaa',
    after: 'bbb1234',
    checkout_sha: 'bbb1234',
    user_username: 'dev-a',
    user_name: 'Dev A',
    project: PROJECT,
    commits: [],
    ...overrides,
  }
}

function mrPayload(action: string): Record<string, unknown> {
  return {
    object_kind: 'merge_request',
    user: { username: 'dev-a', name: 'Dev A' },
    project: PROJECT,
    object_attributes: {
      iid: 7,
      title: 'Fix login NPE',
      action,
      source_branch: 'feature/login',
      target_branch: 'main',
      last_commit: { id: 'ccc789' },
    },
  }
}

function notePayload(noteableType: string): Record<string, unknown> {
  return {
    object_kind: 'note',
    user: { username: 'reviewer-b', name: 'Reviewer B' },
    project: PROJECT,
    object_attributes: {
      note: '/fix 把这个空指针处理掉',
      noteable_type: noteableType,
    },
    merge_request: {
      iid: 7,
      title: 'Fix login NPE',
      source_branch: 'feature/login',
      target_branch: 'main',
    },
  }
}

function pipelinePayload(status: string, withMr: boolean): Record<string, unknown> {
  return {
    object_kind: 'pipeline',
    user: { username: 'aw-bot', name: 'AW Bot' },
    project: PROJECT,
    object_attributes: { id: 1001, ref: 'feature/login', status, sha: 'ddd456' },
    ...(withMr
      ? {
          merge_request: {
            iid: 7,
            source_branch: 'feature/login',
            target_branch: 'main',
          },
        }
      : {}),
  }
}

describe('RFC-257 T3 · gitlabVerify（明文常量时间比对，非 HMAC）', () => {
  test('三态：valid / invalid / missing', () => {
    expect(gitlabVerify({ 'x-gitlab-token': 's3cret' }, NO_BODY, 's3cret')).toBe('valid')
    expect(gitlabVerify({ 'x-gitlab-token': 'wrong' }, NO_BODY, 's3cret')).toBe('invalid')
    expect(gitlabVerify({ 'x-gitlab-token': 's3cret-longer' }, NO_BODY, 's3cret')).toBe('invalid')
    expect(gitlabVerify({}, NO_BODY, 's3cret')).toBe('missing')
    expect(gitlabVerify({ 'x-gitlab-token': '' }, NO_BODY, 's3cret')).toBe('missing')
  })
})

describe('RFC-257 T3 · gitlabNormalize（design §2.3 映射表）', () => {
  test('push：ref 去前缀、顶层 user_username、after 为 commit_sha', () => {
    const r = gitlabNormalize(HEADERS, pushPayload())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.eventType).toBe('push')
    expect(r.event.branch).toBe('feature/login')
    expect(r.event.commitSha).toBe('bbb1234')
    expect(r.event.author.username).toBe('dev-a')
    expect(r.event.repoPath).toBe('platform/backend/api')
    expect(r.event.eventUuid).toBe('uuid-123')
    expect(r.event.repoHttpUrl).toContain('https://')
    expect(r.event.repoSshUrl).toContain('git@')
  })

  test('tag_push：refs/tags/ 前缀', () => {
    const r = gitlabNormalize({}, pushPayload({ object_kind: 'tag_push', ref: 'refs/tags/v1.2.0' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.eventType).toBe('tag_push')
    expect(r.event.branch).toBe('v1.2.0')
    expect(r.event.eventUuid).toBeNull() // header 缺失 → 降级无去重（F-18）
  })

  test('merge_request 四 action 映射 + branch=source_branch', () => {
    for (const [action, expected] of [
      ['open', 'mr_opened'],
      ['reopen', 'mr_opened'],
      ['update', 'mr_updated'],
      ['merge', 'mr_merged'],
      ['close', 'mr_closed'],
    ] as const) {
      const r = gitlabNormalize(HEADERS, mrPayload(action))
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.event.eventType).toBe(expected)
      expect(r.event.mrIid).toBe('7')
      expect(r.event.branch).toBe('feature/login')
      expect(r.event.targetBranch).toBe('main')
      expect(r.event.mrTitle).toBe('Fix login NPE')
      expect(r.event.commitSha).toBe('ccc789')
    }
    const approved = gitlabNormalize(HEADERS, mrPayload('approved'))
    expect(approved.ok).toBe(false)
    if (!approved.ok) expect(approved.reason).toBe('unsupported-event')
  })

  test('note：仅 MR 评论；commentText 与 MR 上下文', () => {
    const r = gitlabNormalize(HEADERS, notePayload('MergeRequest'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.eventType).toBe('note')
    expect(r.event.commentText).toBe('/fix 把这个空指针处理掉')
    expect(r.event.mrIid).toBe('7')
    expect(r.event.branch).toBe('feature/login')
    expect(r.event.author.username).toBe('reviewer-b')
    const commit = gitlabNormalize(HEADERS, notePayload('Commit'))
    expect(commit.ok).toBe(false)
    if (!commit.ok) expect(commit.reason).toBe('unsupported-event')
  })

  test('pipeline：failed/success 归一化，MR 流水线取 source_branch，分支流水线取 ref', () => {
    const failed = gitlabNormalize(HEADERS, pipelinePayload('failed', true))
    expect(failed.ok).toBe(true)
    if (failed.ok) {
      expect(failed.event.eventType).toBe('pipeline_failed')
      expect(failed.event.mrIid).toBe('7')
      expect(failed.event.branch).toBe('feature/login')
      expect(failed.event.pipelineStatus).toBe('failed')
      expect(failed.event.author.username).toBe('aw-bot') // D14/D22 前提：pipeline user = 触发者
      expect(failed.event.commitSha).toBe('ddd456')
    }
    const success = gitlabNormalize(HEADERS, pipelinePayload('success', false))
    expect(success.ok).toBe(true)
    if (success.ok) {
      expect(success.event.eventType).toBe('pipeline_succeeded')
      expect(success.event.mrIid).toBeUndefined()
      expect(success.event.branch).toBe('feature/login') // fallback 到 object_attributes.ref
    }
    const running = gitlabNormalize(HEADERS, pipelinePayload('running', true))
    expect(running.ok).toBe(false)
    if (!running.ok) expect(running.reason).toBe('unsupported-event')
  })

  test('parse-failed 分支：非对象 / 缺 object_kind / 缺 project / 缺关键字段', () => {
    expect(gitlabNormalize(HEADERS, 'x').ok).toBe(false)
    expect(gitlabNormalize(HEADERS, { foo: 1 }).ok).toBe(false)
    expect(gitlabNormalize(HEADERS, { object_kind: 'push' }).ok).toBe(false)
    const noRef = gitlabNormalize(HEADERS, pushPayload({ ref: undefined }))
    expect(noRef.ok).toBe(false)
    if (!noRef.ok) expect(noRef.reason).toBe('parse-failed')
    const badMr = gitlabNormalize(HEADERS, {
      ...mrPayload('open'),
      object_attributes: { action: 'open' },
    })
    expect(badMr.ok).toBe(false)
  })

  test('未知 object_kind → unsupported（release/deployment 等 v1 不做）', () => {
    const r = gitlabNormalize(HEADERS, { object_kind: 'release', project: PROJECT })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsupported-event')
  })

  test('注册表：gitlab/github 双 provider 在册（RFC-259 起）', () => {
    // RFC-259 显式翻转：原断言锁「注册表只有 gitlab」，该前提正是 RFC-259
    // 推翻的对象（proposal AC-12 记档的唯一断言变更）。
    expect(CODE_HOST_ADAPTERS['gitlab']?.provider).toBe('gitlab')
    expect(CODE_HOST_ADAPTERS['github']?.provider).toBe('github')
    expect(CODE_HOST_ADAPTERS['gitea']).toBeUndefined()
  })
})
