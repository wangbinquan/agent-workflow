// RFC-263 T3a — GitHub adapter 的「动作参数」提取回归锁（GitLab 侧对称件见
// rfc263-gitlab-params.test.ts）。锁四件事：
//   ① 行内评论的线程 id = `in_reply_to_id ?? comment.id` —— 回复端点吃的是**线程
//      根评论**的 id，只用 comment.id 会让「回复第 3 条」开出一条新线程（design §5.1）；
//   ② position 包 **省略 null 键**（GitHub 的 null 是「不适用」，传给 API 必 422），
//      且当前行/原始行**成组**二选一，不混用；
//   ③ 两处**有意不填**：issue_comment 的 mrId（issue.id ≠ PR id，两个 id 空间）与
//      workflow_run 的 mrUrl（`pull_requests[].url` 是 API URL 不是网页地址）——
//      填了会让下游动作查到别的东西 / 贴出一条 JSON 端点；
//   ④ 软提取：新字段全缺时 normalize 仍 ok:true（proposal C4）。
//
// 字段路径依据 GitHub 官方文档与 octokit/webhooks 的
// common/pull-request-review-comment.schema.json；真实投递采集后以 fixture 为准
// 回改（tests/fixtures/github-webhooks/README.md 实测清单）。
import { describe, expect, test } from 'bun:test'

import { githubApiBaseUrl, githubNormalize } from '@/services/webhook/githubAdapter'

const REPOSITORY = {
  id: 8080,
  name: 'api',
  full_name: 'acme/api',
  clone_url: 'https://github.com/acme/api.git',
  ssh_url: 'git@github.com:acme/api.git',
  html_url: 'https://github.com/acme/api',
  default_branch: 'main',
  owner: { login: 'acme', id: 4242 },
}

const SENDER = { login: 'reviewer-b', id: 77 }

function headers(event: string): Record<string, string> {
  return { 'x-github-event': event, 'x-github-delivery': 'guid-263' }
}

function okEvent(event: string, payload: Record<string, unknown>) {
  const r = githubNormalize(headers(event), payload)
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`)
  return r.event
}

function prBlock(): Record<string, unknown> {
  return {
    id: 55501,
    number: 7,
    title: 'Fix login NPE',
    html_url: 'https://github.com/acme/api/pull/7',
    head: { ref: 'feature/login', sha: 'ccc222' },
    base: { ref: 'main' },
  }
}

function reviewCommentPayload(comment: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    repository: REPOSITORY,
    sender: SENDER,
    pull_request: prBlock(),
    comment: {
      id: 3311,
      html_url: 'https://github.com/acme/api/pull/7#discussion_r3311',
      body: '@aw 这里的空指针要处理',
      path: 'src/login.ts',
      commit_id: 'ccc222',
      line: 12,
      original_line: 9,
      side: 'RIGHT',
      start_line: null,
      original_start_line: null,
      start_side: null,
      ...comment,
    },
  }
}

describe('RFC-263 · GitHub 公共块（repository / sender）', () => {
  test('repository 块补齐 + sender.id', () => {
    const ev = okEvent('pull_request', {
      action: 'opened',
      repository: REPOSITORY,
      sender: SENDER,
      pull_request: prBlock(),
    })
    expect(ev.projectId).toBe('8080')
    expect(ev.repoOwner).toBe('acme')
    expect(ev.repoName).toBe('api')
    expect(ev.projectWebUrl).toBe('https://github.com/acme/api')
    expect(ev.defaultBranch).toBe('main')
    expect(ev.apiBaseUrl).toBe('https://api.github.com')
    expect(ev.authorId).toBe('77')
    expect(ev.author.username).toBe('reviewer-b')
  })

  test('push：commitBefore', () => {
    const ev = okEvent('push', {
      ref: 'refs/heads/feature/login',
      before: 'aaa000',
      after: 'bbb111',
      repository: REPOSITORY,
      sender: SENDER,
    })
    expect(ev.commitBefore).toBe('aaa000')
    expect(ev.commitSha).toBe('bbb111')
  })
})

describe('RFC-263 · githubApiBaseUrl（design §4.2）', () => {
  test('github.com（含 www）→ api.github.com', () => {
    expect(githubApiBaseUrl('https://github.com/acme/api', 'acme/api')).toBe(
      'https://api.github.com',
    )
    expect(githubApiBaseUrl('https://www.github.com/acme/api', 'acme/api')).toBe(
      'https://api.github.com',
    )
  })

  test('GHES → <实例>/api/v3', () => {
    expect(githubApiBaseUrl('https://ghe.corp.com/acme/api', 'acme/api')).toBe(
      'https://ghe.corp.com/api/v3',
    )
    expect(githubApiBaseUrl('https://ghe.corp.com:8443/acme/api', 'acme/api')).toBe(
      'https://ghe.corp.com:8443/api/v3',
    )
  })

  test('形态不符 / 畸形 URL → undefined，不猜', () => {
    expect(githubApiBaseUrl('https://github.com/other/api', 'acme/api')).toBeUndefined()
    expect(githubApiBaseUrl(undefined, 'acme/api')).toBeUndefined()
    expect(githubApiBaseUrl('https://github.com/acme/api', undefined)).toBeUndefined()
    expect(githubApiBaseUrl('not a url/acme/api', 'acme/api')).toBeUndefined()
    expect(githubApiBaseUrl('/acme/api', 'acme/api')).toBeUndefined()
  })
})

describe('RFC-263 · 行内评论线程 id（design §5.1）', () => {
  test('无 in_reply_to_id（对根评论回复）→ 线程 id = comment.id', () => {
    const ev = okEvent('pull_request_review_comment', reviewCommentPayload())
    expect(ev.commentId).toBe('3311')
    expect(ev.commentThreadId).toBe('3311')
  })

  test('有 in_reply_to_id（回复线程内第 N 条）→ 线程 id = 根评论 id，不是本条 id', () => {
    const ev = okEvent(
      'pull_request_review_comment',
      reviewCommentPayload({ id: 3399, in_reply_to_id: 3311 }),
    )
    expect(ev.commentId).toBe('3399')
    // 用 comment.id 会开出一条新线程 —— 这条断言就是为了挡住那个回归
    expect(ev.commentThreadId).toBe('3311')
  })

  test('评论 url / PR global id / PR 网页地址', () => {
    const ev = okEvent('pull_request_review_comment', reviewCommentPayload())
    expect(ev.commentUrl).toContain('#discussion_r3311')
    expect(ev.mrId).toBe('55501')
    expect(ev.mrUrl).toBe('https://github.com/acme/api/pull/7')
    expect(ev.mrIid).toBe('7')
  })
})

describe('RFC-263 · commentPosition（design §5.2）', () => {
  test('省略 null 键：单行评论不带 start_line / start_side', () => {
    const ev = okEvent('pull_request_review_comment', reviewCommentPayload())
    expect(ev.commentPosition).toEqual({
      path: 'src/login.ts',
      line: 12,
      side: 'RIGHT',
      commit_id: 'ccc222',
    })
    expect(JSON.stringify(ev.commentPosition)).not.toContain('null')
  })

  test('多行评论带 start_line / start_side', () => {
    const ev = okEvent(
      'pull_request_review_comment',
      reviewCommentPayload({ start_line: 8, start_side: 'RIGHT' }),
    )
    expect(ev.commentPosition).toEqual({
      path: 'src/login.ts',
      line: 12,
      side: 'RIGHT',
      start_line: 8,
      start_side: 'RIGHT',
      commit_id: 'ccc222',
    })
  })

  test('line 为 null（所指行已被后续 commit 改动）→ 整组落到 original_*，不混用', () => {
    const ev = okEvent(
      'pull_request_review_comment',
      reviewCommentPayload({
        line: null,
        original_line: 9,
        start_line: 8,
        original_start_line: 5,
      }),
    )
    // start_line 取 original_start_line 而不是仍然新鲜的 start_line：混用两组会
    // 产出一个自相矛盾的行范围
    expect(ev.commentPosition).toEqual({
      path: 'src/login.ts',
      line: 9,
      side: 'RIGHT',
      start_line: 5,
      commit_id: 'ccc222',
    })
  })

  test('无 path（非行内评论形态）→ undefined', () => {
    const ev = okEvent('pull_request_review_comment', reviewCommentPayload({ path: undefined }))
    expect(ev.commentPosition).toBeUndefined()
  })
})

describe('RFC-263 · issue_comment（普通 PR 评论）的两处有意留空', () => {
  test('无线程 id；mrUrl 取 issue.html_url；mrId 有意不填（issue.id ≠ PR id）', () => {
    const ev = okEvent('issue_comment', {
      action: 'created',
      repository: REPOSITORY,
      sender: SENDER,
      issue: {
        id: 70001, // issue 的 id —— 与 PR 的 global id 是两个空间
        number: 7,
        title: 'Fix login NPE',
        html_url: 'https://github.com/acme/api/pull/7',
        pull_request: { url: 'https://api.github.com/repos/acme/api/pulls/7' },
      },
      comment: {
        id: 4400,
        html_url: 'https://github.com/acme/api/pull/7#issuecomment-4400',
        body: '@aw 看下 CI',
      },
    })
    expect(ev.commentId).toBe('4400')
    expect(ev.commentUrl).toContain('#issuecomment-4400')
    expect(ev.mrUrl).toBe('https://github.com/acme/api/pull/7')
    expect(ev.mrIid).toBe('7')
    // 两处有意留空
    expect(ev.commentThreadId).toBeUndefined()
    expect(ev.mrId).toBeUndefined()
    expect(ev.commentPosition).toBeUndefined()
  })
})

describe('RFC-263 · workflow_run', () => {
  test('pipelineId / pipelineUrl / mrId；mrUrl 有意不填（避免贴出 API URL）', () => {
    const ev = okEvent('workflow_run', {
      action: 'completed',
      repository: REPOSITORY,
      sender: SENDER,
      workflow_run: {
        id: 900123,
        conclusion: 'failure',
        head_branch: 'feature/login',
        head_sha: 'ccc222',
        html_url: 'https://github.com/acme/api/actions/runs/900123',
        actor: { login: 'aw-bot' },
        pull_requests: [
          {
            id: 55501,
            number: 7,
            url: 'https://api.github.com/repos/acme/api/pulls/7',
            base: { ref: 'main' },
          },
        ],
      },
    })
    expect(ev.eventType).toBe('pipeline_failed')
    expect(ev.pipelineId).toBe('900123')
    expect(ev.pipelineUrl).toBe('https://github.com/acme/api/actions/runs/900123')
    expect(ev.mrId).toBe('55501')
    expect(ev.mrIid).toBe('7')
    // 回归锁：pull_requests[].url 是 API URL，绝不能当网页地址贴出去
    expect(ev.mrUrl).toBeUndefined()
  })

  test('fork PR（pull_requests 空）→ mrId 也空，其余不受影响', () => {
    const ev = okEvent('workflow_run', {
      action: 'completed',
      repository: REPOSITORY,
      sender: SENDER,
      workflow_run: {
        id: 900124,
        conclusion: 'success',
        head_branch: 'main',
        head_sha: 'ddd333',
        html_url: 'https://github.com/acme/api/actions/runs/900124',
        pull_requests: [],
      },
    })
    expect(ev.eventType).toBe('pipeline_succeeded')
    expect(ev.pipelineId).toBe('900124')
    expect(ev.mrId).toBeUndefined()
  })
})

describe('RFC-263 · 软提取回归锁（proposal C4）', () => {
  test('新字段全缺的最小 payload 仍 ok:true，既有字段不变', () => {
    const ev = okEvent('pull_request', {
      action: 'opened',
      repository: {
        full_name: 'acme/api',
        clone_url: 'https://github.com/acme/api.git',
        ssh_url: 'git@github.com:acme/api.git',
      },
      pull_request: { number: 7, head: { ref: 'topic' }, base: { ref: 'main' } },
    })
    expect(ev.eventType).toBe('mr_opened')
    expect(ev.repoPath).toBe('acme/api')
    expect(ev.mrIid).toBe('7')
    expect(ev.branch).toBe('topic')
    expect(ev.projectId).toBeUndefined()
    expect(ev.repoOwner).toBeUndefined()
    expect(ev.apiBaseUrl).toBeUndefined()
    expect(ev.authorId).toBeUndefined()
    expect(ev.mrId).toBeUndefined()
    expect(ev.mrUrl).toBeUndefined()
  })
})
