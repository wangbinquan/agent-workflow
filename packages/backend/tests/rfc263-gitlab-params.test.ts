// RFC-263 T2a — GitLab adapter 的「动作参数」提取回归锁。
//
// 这套测试存在的理由（RFC-263 proposal §1）：adapter 此前**读到了** project.id /
// object_attributes.discussion_id / note id / position 却全丢在 raw 里，导致
// 「自动回复 MR 评论」的流水线拿不到任何定位参数。锁四件事：
//   ① 回复线程三件套（project_id / mr_iid / discussion_id）确实进信封；
//   ② position 原样透传且 **null 保留**（old_line:null ⇒ 新增行，丢了就分不清增删）；
//   ③ apiBaseUrl 用后缀剥离而非 URL.origin —— 子路径部署的自建 GitLab 取 origin
//      会得到一个打到错服务的 base（design §4.1）；
//   ④ **软提取**：新字段全缺时 normalize 仍 ok:true —— 否则一次 GitLab 版本差异
//      就能把所有投递变成 parse-failed，比没有这些参数更糟（proposal C4）。
//
// payload builder 按 GitLab 官方文档与 hook_data/note_builder.rb 的
// SAFE_HOOK_ATTRIBUTES 手写；真实 fixture 采集后以 fixture 为准回改
// （tests/fixtures/gitlab-webhooks/README.md 实测清单）。
import { describe, expect, test } from 'bun:test'

import { gitlabApiBaseUrl, gitlabNormalize } from '@/services/webhook/gitlabAdapter'

const HEADERS = { 'x-gitlab-event-uuid': 'uuid-263' }

const PROJECT = {
  id: 42,
  name: 'api',
  path_with_namespace: 'platform/backend/api',
  git_http_url: 'https://gitlab.example.com/platform/backend/api.git',
  git_ssh_url: 'git@gitlab.example.com:platform/backend/api.git',
  default_branch: 'main',
  web_url: 'https://gitlab.example.com/platform/backend/api',
}

const DIFF_POSITION = {
  base_sha: 'aaa000',
  start_sha: 'bbb111',
  head_sha: 'ccc222',
  old_path: 'src/login.ts',
  new_path: 'src/login.ts',
  position_type: 'text',
  old_line: null,
  new_line: 12,
}

function notePayload(attrs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_kind: 'note',
    user: { id: 7, username: 'reviewer-b', name: 'Reviewer B' },
    project: PROJECT,
    object_attributes: {
      id: 3311,
      note: '@aw 帮我看下这个空指针',
      noteable_type: 'MergeRequest',
      discussion_id: 'ab12cd34ef56',
      url: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/7#note_3311',
      ...attrs,
    },
    merge_request: {
      id: 9901,
      iid: 7,
      title: 'Fix login NPE',
      source_branch: 'feature/login',
      target_branch: 'main',
      url: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/7',
    },
  }
}

function okEvent(payload: Record<string, unknown>) {
  const r = gitlabNormalize(HEADERS, payload)
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`)
  return r.event
}

describe('RFC-263 · GitLab 公共块（project / user）', () => {
  test('project 块补齐：id / web_url / default_branch / owner / name / apiBase', () => {
    const ev = okEvent(notePayload())
    expect(ev.projectId).toBe('42')
    expect(ev.projectWebUrl).toBe('https://gitlab.example.com/platform/backend/api')
    expect(ev.defaultBranch).toBe('main')
    expect(ev.apiBaseUrl).toBe('https://gitlab.example.com/api/v4')
    // 多层 namespace：owner 取最后一段之前的全部
    expect(ev.repoOwner).toBe('platform/backend')
    expect(ev.repoName).toBe('api')
  })

  test('单层 namespace 的 owner / name 切分', () => {
    const ev = okEvent({
      ...notePayload(),
      project: {
        ...PROJECT,
        path_with_namespace: 'acme/api',
        web_url: 'https://gitlab.example.com/acme/api',
      },
    })
    expect(ev.repoOwner).toBe('acme')
    expect(ev.repoName).toBe('api')
  })

  test('authorId：note/MR/pipeline 取 user.id，push 取顶层 user_id', () => {
    expect(okEvent(notePayload()).authorId).toBe('7')
    const push = okEvent({
      object_kind: 'push',
      ref: 'refs/heads/feature/login',
      before: 'aaa000',
      after: 'bbb111',
      user_id: 15,
      user_username: 'dev-a',
      project: PROJECT,
    })
    expect(push.authorId).toBe('15')
    expect(push.author.username).toBe('dev-a')
    expect(push.commitBefore).toBe('aaa000')
  })
})

describe('RFC-263 · gitlabApiBaseUrl（design §4.1）', () => {
  test('根路径部署', () => {
    expect(gitlabApiBaseUrl('https://gl.corp.com/group/repo', 'group/repo')).toBe(
      'https://gl.corp.com/api/v4',
    )
  })

  test('子路径部署：必须保留路径前缀（取 origin 会打到错服务）', () => {
    expect(gitlabApiBaseUrl('https://host.corp.com/gitlab/group/sub/repo', 'group/sub/repo')).toBe(
      'https://host.corp.com/gitlab/api/v4',
    )
  })

  test('形态不符一律 undefined，不猜', () => {
    // web_url 与 path 对不上（大小写差异也算不符——两者同源，不一致即形态未知）
    expect(gitlabApiBaseUrl('https://gl.corp.com/Group/Repo', 'group/repo')).toBeUndefined()
    expect(gitlabApiBaseUrl('https://gl.corp.com/other/repo', 'group/repo')).toBeUndefined()
    expect(gitlabApiBaseUrl(undefined, 'group/repo')).toBeUndefined()
    expect(gitlabApiBaseUrl('https://gl.corp.com/group/repo', undefined)).toBeUndefined()
    // 剥完只剩空串（web_url 恰好等于 `/path`）
    expect(gitlabApiBaseUrl('/group/repo', 'group/repo')).toBeUndefined()
  })
})

describe('RFC-263 · note 事件（回复评论的核心诉求）', () => {
  test('线程三件套 + 评论 id / url + MR global id / url', () => {
    const ev = okEvent(notePayload())
    expect(ev.commentThreadId).toBe('ab12cd34ef56')
    expect(ev.commentId).toBe('3311')
    expect(ev.commentUrl).toContain('#note_3311')
    expect(ev.mrIid).toBe('7')
    expect(ev.mrId).toBe('9901')
    expect(ev.mrUrl).toBe('https://gitlab.example.com/platform/backend/api/-/merge_requests/7')
  })

  test('DiffNote：position 原样透传，null 保留（old_line:null ⇒ 新增行）', () => {
    const ev = okEvent(notePayload({ type: 'DiffNote', position: DIFF_POSITION }))
    expect(ev.commentPosition).toEqual(DIFF_POSITION)
    expect((ev.commentPosition as Record<string, unknown>)['old_line']).toBeNull()
  })

  test('普通评论（无 position）→ commentPosition undefined', () => {
    expect(okEvent(notePayload()).commentPosition).toBeUndefined()
  })

  test('position 不是对象（畸形 payload）→ undefined 而非原样带毒', () => {
    expect(okEvent(notePayload({ position: 'not-an-object' })).commentPosition).toBeUndefined()
    expect(okEvent(notePayload({ position: [1, 2] })).commentPosition).toBeUndefined()
  })
})

describe('RFC-263 · merge_request / pipeline 事件', () => {
  test('MR 事件：mrId / mrUrl', () => {
    const ev = okEvent({
      object_kind: 'merge_request',
      user: { id: 7, username: 'dev-a' },
      project: PROJECT,
      object_attributes: {
        id: 9901,
        iid: 7,
        title: 'Fix login NPE',
        action: 'open',
        source_branch: 'feature/login',
        target_branch: 'main',
        last_commit: { id: 'ccc222' },
        url: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/7',
      },
    })
    expect(ev.mrId).toBe('9901')
    expect(ev.mrUrl).toContain('/merge_requests/7')
    expect(ev.mrIid).toBe('7')
  })

  test('pipeline 事件：pipelineId / pipelineUrl（retry 与拉日志的入口）+ MR 块', () => {
    const ev = okEvent({
      object_kind: 'pipeline',
      user: { id: 99, username: 'aw-bot' },
      project: PROJECT,
      object_attributes: {
        id: 1001,
        ref: 'feature/login',
        status: 'failed',
        sha: 'ddd333',
        url: 'https://gitlab.example.com/platform/backend/api/-/pipelines/1001',
      },
      merge_request: {
        id: 9901,
        iid: 7,
        source_branch: 'feature/login',
        target_branch: 'main',
        url: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/7',
      },
    })
    expect(ev.pipelineId).toBe('1001')
    expect(ev.pipelineUrl).toContain('/pipelines/1001')
    expect(ev.mrId).toBe('9901')
    expect(ev.mrUrl).toContain('/merge_requests/7')
  })
})

describe('RFC-263 · 软提取回归锁（proposal C4）', () => {
  test('新字段全缺的最小 payload 仍 ok:true，既有字段逐个不变', () => {
    const minimal = {
      object_kind: 'note',
      user: { username: 'reviewer-b' },
      project: {
        path_with_namespace: 'acme/api',
        git_http_url: 'https://gitlab.example.com/acme/api.git',
        git_ssh_url: 'git@gitlab.example.com:acme/api.git',
      },
      object_attributes: { note: 'hello', noteable_type: 'MergeRequest' },
      merge_request: { iid: 3, source_branch: 'topic', target_branch: 'main' },
    }
    const ev = okEvent(minimal)
    expect(ev.eventType).toBe('note')
    expect(ev.repoPath).toBe('acme/api')
    expect(ev.mrIid).toBe('3')
    expect(ev.branch).toBe('topic')
    expect(ev.commentText).toBe('hello')
    // 新字段一律 undefined，不抛不拒
    expect(ev.projectId).toBeUndefined()
    expect(ev.apiBaseUrl).toBeUndefined()
    expect(ev.commentThreadId).toBeUndefined()
    expect(ev.commentId).toBeUndefined()
    expect(ev.mrId).toBeUndefined()
    expect(ev.authorId).toBeUndefined()
    expect(ev.commentPosition).toBeUndefined()
  })

  test('id 字段是畸形类型（对象 / bool）→ undefined，不进信封', () => {
    const ev = okEvent(notePayload({ id: { nested: true }, discussion_id: 42 }))
    expect(ev.commentId).toBeUndefined()
    // discussion_id 在 GitLab 侧是 hex 字符串；数字形态被 str() 挡掉
    expect(ev.commentThreadId).toBeUndefined()
  })
})
