// RFC-269 / RFC-277 — 执行器与 GitLab TLS 例外的锁。
//
// 这个文件锁的是「平台到底往代码平台发了什么」以及「出错时会不会做傻事」：
//
//   · **请求逐字节**：19×2 的映射表是手写的，一个笔误就是运行期 404 或者
//     「参数明明填了却没发出去」——那种 bug 只有在真实 GitLab 上才暴露。
//   · **重试的幂等分档**（D18）：POST 的 5xx 重发一次就是第二条评论。
//   · **凭据不外泄**：token 不进任何错误信息；跟随重定向时必须剥掉认证头。
//   · **上游值改不了请求结构**：这是本 RFC 的安全承重。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CODE_HOST_PARAM_MAX, type TriggerContext } from '@agent-workflow/shared'

import { executeCodeHostCall, type CodeHostCallSpec } from '../src/services/codeHost/call'
import { resolveProjectFallback } from '../src/services/codeHost/project'
import { buildCodeHostUrl } from '../src/services/codeHost/url'

// 同 connections 测试：夹具刻意不带 glpat- / ghp_ 前缀（gitleaks 规则）。
const TOKEN = 'aw-fixture-not-a-real-token-1234' // gitleaks:allow
const GL_BASE = 'https://gitlab.corp.example/api/v4'
const GH_BASE = 'https://api.github.com'

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  tls: BunFetchRequestInit['tls']
}

function capturing(
  responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>,
): { fetchImpl: (url: string, init?: BunFetchRequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = []
  let index = 0
  const fetchImpl = async (url: string, init?: BunFetchRequestInit): Promise<Response> => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      tls: init?.tls,
    })
    const spec = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return new Response(spec.body ?? '{}', {
      status: spec.status,
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
    })
  }
  return { fetchImpl, seen }
}

function glDeps(
  overrides: Partial<Parameters<typeof executeCodeHostCall>[1]> = {},
): Parameters<typeof executeCodeHostCall>[1] {
  return {
    connection: {
      provider: 'gitlab',
      baseUrl: GL_BASE,
      repositoryUrlPrefixes: [],
      token: TOKEN,
      rejectUnauthorized: true,
    },
    ctx: { ports: {}, triggerContext: null },
    projectFallback: { ok: true, value: 'grp%2Frepo' },
    sleep: async () => {},
    ...overrides,
  }
}

function ghDeps(
  overrides: Partial<Parameters<typeof executeCodeHostCall>[1]> = {},
): Parameters<typeof executeCodeHostCall>[1] {
  return {
    connection: {
      provider: 'github',
      baseUrl: GH_BASE,
      repositoryUrlPrefixes: [],
      token: 'aw-fixture-gh-5678', // gitleaks:allow
      rejectUnauthorized: true,
    },
    ctx: { ports: {}, triggerContext: null },
    projectFallback: { ok: true, value: 'octo/repo' },
    sleep: async () => {},
    ...overrides,
  }
}

describe('RFC-269 请求组装 —— 两家的真实端点', () => {
  test('GitLab 回复评论线程', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.reply-thread',
        params: { mr: '42', thread: 'disc-1', body: '{{verdict}}' },
      },
      glDeps({ ctx: { ports: { verdict: '审计通过' }, triggerContext: null }, fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen[0]!.url).toBe(
      'https://gitlab.corp.example/api/v4/projects/grp%2Frepo/merge_requests/42/discussions/disc-1/notes',
    )
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.headers['private-token']).toBe(TOKEN)
    expect(JSON.parse(seen[0]!.body!)).toEqual({ body: '审计通过' })
  })

  test('GitHub 回复线程走 replies 端点 + Bearer', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'github',
        action: 'comment.reply-thread',
        params: { mr: '7', thread: '9911', body: 'ok' },
      },
      ghDeps({ fetchImpl }),
    )
    expect(seen[0]!.url).toBe(
      'https://api.github.com/repos/octo/repo/pulls/7/comments/9911/replies',
    )
    expect(seen[0]!.headers.authorization).toBe('Bearer aw-fixture-gh-5678')
    expect(seen[0]!.headers['x-github-api-version']).toBe('2022-11-28')
  })

  test('GitHub Enterprise 缺少 replies 端点时回退到 in_reply_to 写法', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 404, body: '{"message":"Not Found"}' },
      { status: 201, body: '{"id":42}' },
    ])
    const out = await executeCodeHostCall(
      {
        provider: 'github',
        action: 'comment.reply-thread',
        params: { mr: '7', thread: '9911', body: 'ok' },
      },
      ghDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/octo/repo/pulls/7/comments/9911/replies',
      'https://api.github.com/repos/octo/repo/pulls/7/comments',
    ])
    expect(JSON.parse(seen[1]!.body!)).toEqual({ body: 'ok', in_reply_to: 9911 })
  })

  test('普通评论：GitLab 走 notes，GitHub 走 issues/comments', async () => {
    const gl = capturing([{ status: 201 }])
    await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl: gl.fetchImpl }),
    )
    expect(gl.seen[0]!.url).toContain('/merge_requests/1/notes')
    const gh = capturing([{ status: 201 }])
    await executeCodeHostCall(
      { provider: 'github', action: 'comment.create', params: { mr: '1', body: 'x' } },
      ghDeps({ fetchImpl: gh.fetchImpl }),
    )
    expect(gh.seen[0]!.url).toContain('/issues/1/comments')
  })

  test('commit status 的 state 三档各自映射：GitHub 是 failure', async () => {
    const gl = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'commit-status.set',
        params: { sha: 'abc', state: 'failed', context: 'aw-audit' },
      },
      glDeps({ fetchImpl: gl.fetchImpl }),
    )
    // GitLab 用 query
    expect(gl.seen[0]!.url).toContain('state=failed')
    expect(gl.seen[0]!.url).toContain('name=aw-audit')

    const gh = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'github',
        action: 'commit-status.set',
        params: { sha: 'abc', state: 'failed', context: 'aw-audit' },
      },
      ghDeps({ fetchImpl: gh.fetchImpl }),
    )
    expect(JSON.parse(gh.seen[0]!.body!)).toEqual({ state: 'failure', context: 'aw-audit' })
  })

  test('label：GitLab 逗号串、GitHub 数组', async () => {
    const gl = capturing([{ status: 200 }])
    await executeCodeHostCall(
      { provider: 'gitlab', action: 'label.add', params: { mr: '1', labels: 'a, b' } },
      glDeps({ fetchImpl: gl.fetchImpl }),
    )
    expect(JSON.parse(gl.seen[0]!.body!)).toEqual({ add_labels: 'a, b' })
    const gh = capturing([{ status: 200 }])
    await executeCodeHostCall(
      { provider: 'github', action: 'label.add', params: { mr: '1', labels: 'a, b' } },
      ghDeps({ fetchImpl: gh.fetchImpl }),
    )
    expect(JSON.parse(gh.seen[0]!.body!)).toEqual({ labels: ['a', 'b'] })
  })

  test('指派：GitLab 要数字 id，非数字给出可读拒绝', async () => {
    const { fetchImpl } = capturing([{ status: 200 }])
    const bad = await executeCodeHostCall(
      { provider: 'gitlab', action: 'assignee.set', params: { mr: '1', assignees: 'alice' } },
      glDeps({ fetchImpl }),
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.code).toBe('code-host-param-invalid')
    expect(bad.message).toContain('numeric')
  })

  test('行内评论的 position：GitLab 收进 position 键，GitHub 展开到顶层', async () => {
    const position = JSON.stringify({ commit_id: 'c1', path: 'a.ts', line: 3, side: 'RIGHT' })
    const gl = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.create-inline',
        params: { mr: '1', body: 'x', position },
      },
      glDeps({ fetchImpl: gl.fetchImpl }),
    )
    expect(JSON.parse(gl.seen[0]!.body!)).toEqual({ body: 'x', position: JSON.parse(position) })
    const gh = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'github',
        action: 'comment.create-inline',
        params: { mr: '1', body: 'x', position },
      },
      ghDeps({ fetchImpl: gh.fetchImpl }),
    )
    expect(JSON.parse(gh.seen[0]!.body!)).toEqual({ body: 'x', ...JSON.parse(position) })
  })

  test('GitHub 不支持 resolve 线程 —— 拒绝在本地，不去打一个不存在的端点', async () => {
    const { fetchImpl, seen } = capturing([{ status: 200 }])
    const out = await executeCodeHostCall(
      { provider: 'github', action: 'thread.resolve', params: { mr: '1' } },
      ghDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain('graphqlOnly')
    expect(seen).toHaveLength(0)
  })

  test('读文件：路径整段 percent-encode（GitLab 端点的要求）', async () => {
    const { fetchImpl, seen } = capturing([{ status: 200 }])
    await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'file.read',
        params: { path: 'src/a b.ts', file_ref: 'main' },
      },
      glDeps({ fetchImpl }),
    )
    expect(seen[0]!.url).toContain('/repository/files/src%2Fa%20b.ts/raw')
    expect(seen[0]!.url).toContain('ref=main')
  })

  test('可选参数为空时省略，不发出 name= 之类的空参数', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    await executeCodeHostCall(
      { provider: 'gitlab', action: 'commit-status.set', params: { sha: 'abc', state: 'success' } },
      glDeps({ fetchImpl }),
    )
    expect(seen[0]!.url).not.toContain('name=')
    expect(seen[0]!.url).not.toContain('description=')
  })
})

describe('RFC-269 / RFC-292 触发上下文', () => {
  const context = (
    eventType: TriggerContext['trigger']['webhook']['event_type'],
    fields: Record<string, string> = {},
  ): TriggerContext => ({ trigger: { webhook: { event_type: eventType, ...fields } } })

  test('{{trigger.webhook.*}} 解析进定位参数', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.reply-thread',
        params: {
          project: '{{trigger.webhook.project_id}}',
          mr: '{{trigger.webhook.mr_iid}}',
          thread: '{{trigger.webhook.comment_thread_id}}',
          body: 'done',
        },
      },
      glDeps({
        ctx: {
          ports: {},
          triggerContext: {
            trigger: {
              webhook: {
                event_type: 'note',
                project_id: '77',
                mr_iid: '42',
                comment_thread_id: 'd9',
              },
            },
          },
        },
        fetchImpl,
      }),
    )
    expect(seen[0]!.url).toBe(
      'https://gitlab.corp.example/api/v4/projects/77/merge_requests/42/discussions/d9/notes',
    )
  })

  test('任务不是 webhook 起的 ⇒ 明确报 trigger-context-missing 而不是发一个空定位', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.reply-thread',
        params: { mr: '{{trigger.webhook.mr_iid}}', thread: 'x', body: 'y' },
      },
      glDeps({ ctx: { ports: {}, triggerContext: null }, fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('trigger-context-missing')
    expect(seen).toHaveLength(0)
  })

  test('可选 preset 参数也在单次 preflight 内，缺 context 时 fetch=0', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'commit-status.set',
        params: {
          sha: 'abc',
          state: 'success',
          description: '{{trigger.webhook.mr_title}}',
        },
      },
      glDeps({ fetchImpl }),
    )
    expect(out).toMatchObject({ ok: false, code: 'trigger-context-missing' })
    expect(seen).toHaveLength(0)
  })

  test('当前 event type 不可用的字段在 fetch 前失败', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.create',
        params: { mr: '1', body: '{{trigger.webhook.mr_title}}' },
      },
      glDeps({
        ctx: { ports: {}, triggerContext: context('push', { mr_title: 'must-not-be-used' }) },
        fetchImpl,
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'trigger-field-unavailable' })
    expect(seen).toHaveLength(0)
  })

  test('旧两段 trigger 语法 fail-closed 且 fetch=0', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'comment.create',
        params: { mr: '1', body: '{{trigger.mr_title}}' },
      },
      glDeps({
        ctx: { ports: {}, triggerContext: context('note', { mr_title: 'legacy' }) },
        fetchImpl,
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'code-host-param-invalid' })
    expect(seen).toHaveLength(0)
  })
})

describe('RFC-269 失败与重试（D18 幂等分档）', () => {
  test('GitLab 实例缺少 /diffs 时回退到旧版 /changes', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 404, body: '{"message":"404 Not Found"}' },
      { status: 200, body: '{"changes":[]}' },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '17' } },
      glDeps({
        connection: {
          provider: 'gitlab',
          baseUrl: GL_BASE,
          repositoryUrlPrefixes: [],
          token: TOKEN,
          rejectUnauthorized: false,
        },
        fetchImpl,
      }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.pathname).toEndWith('/merge_requests/17/changes')
    expect(out.body).toBe('{"changes":[]}')
    expect(seen.map((request) => request.url)).toEqual([
      'https://gitlab.corp.example/api/v4/projects/grp%2Frepo/merge_requests/17/diffs',
      'https://gitlab.corp.example/api/v4/projects/grp%2Frepo/merge_requests/17/changes',
    ])
    expect(seen.map((request) => request.tls)).toEqual([
      { rejectUnauthorized: false },
      { rejectUnauthorized: false },
    ])
  })

  test('兼容路径也接受 405，但权限错误不回退', async () => {
    const missingRoute = capturing([{ status: 405 }, { status: 200 }])
    const recovered = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl: missingRoute.fetchImpl }),
    )
    expect(recovered.ok).toBe(true)
    expect(missingRoute.seen[1]!.url).toContain('/changes')

    for (const status of [403, 422]) {
      const rejected = capturing([{ status }, { status: 200 }])
      const denied = await executeCodeHostCall(
        { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
        glDeps({ fetchImpl: rejected.fetchImpl }),
      )
      expect(denied.ok).toBe(false)
      expect(rejected.seen).toHaveLength(1)
    }
  })

  test('所有兼容路径都不存在时保留首选错误，并列出已尝试路径', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 404, body: '{"message":"diffs missing"}' },
      { status: 404, body: `{"echo":"${TOKEN}"}` },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.summary).toContain('/diffs')
    expect(out.message).toContain('/diffs')
    expect(out.message).toContain('/changes')
    expect(out.message).not.toContain(TOKEN)
    expect(seen).toHaveLength(2)
  })

  test('GitLab false 的 TLS override 贯穿首跳与重试，默认请求不携 override', async () => {
    const insecure = capturing([{ status: 502 }, { status: 200 }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({
        connection: {
          provider: 'gitlab',
          baseUrl: GL_BASE,
          repositoryUrlPrefixes: [],
          token: TOKEN,
          rejectUnauthorized: false,
        },
        fetchImpl: insecure.fetchImpl,
      }),
    )
    expect(out.ok).toBe(true)
    expect(insecure.seen.map((request) => request.tls)).toEqual([
      { rejectUnauthorized: false },
      { rejectUnauthorized: false },
    ])

    const secure = capturing([{ status: 200 }])
    await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl: secure.fetchImpl }),
    )
    expect(secure.seen[0]!.tls).toBeUndefined()
  })

  test('非 2xx ⇒ 节点失败，错误里带状态码与摘要', async () => {
    const { fetchImpl } = capturing([{ status: 403, body: '{"message":"forbidden"}' }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-http-error')
    expect(out.summary).toContain('403')
  })

  test('403 的错误信息里没有 token（变异断言）', async () => {
    const { fetchImpl } = capturing([{ status: 403, body: `{"seen":"${TOKEN}"}` }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    // 即便对方把 token 原样回显（真实存在的坏 API 行为），也不许进错误信息。
    expect(out.message).not.toContain(TOKEN)
    expect(out.message).toContain('‹redacted›')
  })

  test('429 对 POST 也重试 —— 它表示请求没有被执行', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 201 },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen).toHaveLength(2)
  })

  test('5xx 对幂等 method 重试', async () => {
    const { fetchImpl, seen } = capturing([{ status: 502 }, { status: 200 }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen).toHaveLength(2)
  })

  test('幂等请求耗尽 5xx 重试也不换兼容路径', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 502 },
      { status: 502 },
      { status: 502 },
      { status: 200 },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    expect(seen).toHaveLength(3)
    expect(seen.every((request) => request.url.endsWith('/diffs'))).toBe(true)
  })

  test('429 重试耗尽也不换兼容路径', async () => {
    const { fetchImpl, seen } = capturing([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200 },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    expect(seen).toHaveLength(3)
    expect(seen.every((request) => request.url.endsWith('/diffs'))).toBe(true)
  })

  test('网络错误耗尽幂等重试也不换兼容路径', async () => {
    const seen: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url)
      throw new Error('ECONNRESET')
    }
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    expect(seen).toHaveLength(3)
    expect(seen.every((url) => url.endsWith('/diffs'))).toBe(true)
  })

  test('5xx 对 POST **不**重试 —— 重发一次就是第二条评论', async () => {
    const { fetchImpl, seen } = capturing([{ status: 502 }, { status: 201 }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('网络错误对 POST 同样不重试', async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      throw new Error('ECONNRESET')
    }
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-network-error')
    expect(calls).toBe(1)
  })
})

describe('RFC-269 重定向与凭据', () => {
  test('跨主机重定向默认被拒', async () => {
    const { fetchImpl } = capturing([
      { status: 302, headers: { location: 'https://evil.example/x' } },
    ])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'comment.create', params: { mr: '1', body: 'x' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-redirect-refused')
  })

  test('job.log 跟随一次，且第二跳**不带**认证头', async () => {
    const { fetchImpl, seen } = capturing([
      {
        status: 302,
        headers: { location: 'https://pipelines.actions.githubusercontent.com/signed/abc' },
      },
      { status: 200, body: 'log line', headers: { 'content-type': 'text/plain' } },
    ])
    const out = await executeCodeHostCall(
      { provider: 'github', action: 'job.log', params: { job: '55' } },
      ghDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen).toHaveLength(2)
    expect(seen[0]!.headers.authorization).toBe('Bearer aw-fixture-gh-5678')
    // 关键：签名 URL 自带凭据，把我们的 token 送到第三方主机就是凭据外泄。
    expect(seen[1]!.headers.authorization).toBeUndefined()
    expect(seen[1]!.tls).toBeUndefined()
    expect(seen[1]!.url).toContain('githubusercontent.com')
  })

  test('重定向到 http 被拒', async () => {
    const { fetchImpl } = capturing([{ status: 302, headers: { location: 'http://plain/x' } }])
    const out = await executeCodeHostCall(
      { provider: 'github', action: 'job.log', params: { job: '55' } },
      ghDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-redirect-refused')
  })
})

describe('RFC-269 响应处理', () => {
  test('超上限截断并留下显式标记（静默截断会让下游在半截 JSON 上下结论）', async () => {
    const big = 'x'.repeat(5000)
    const { fetchImpl } = capturing([{ status: 200, body: big }])
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl, maxResponseBytes: 1024 }),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.truncated).toBe(true)
    expect(out.body).toContain('[truncated:')
    expect(out.body.length).toBeLessThan(2000)
  })

  test('二进制响应报 unreadable，而不是把替换字符塞进端口', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('PK', {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      })
    const out = await executeCodeHostCall(
      { provider: 'gitlab', action: 'mr.diff', params: { mr: '1' } },
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-response-unreadable')
  })
})

describe('RFC-269 自定义请求逃生舱', () => {
  const custom = (request: CodeHostCallSpec['request'], extra?: Partial<CodeHostCallSpec>) =>
    ({
      provider: 'gitlab',
      action: 'custom',
      params: {},
      request,
      ...extra,
    }) as CodeHostCallSpec

  test('正常自定义请求可用', async () => {
    const { fetchImpl, seen } = capturing([{ status: 200 }])
    const out = await executeCodeHostCall(
      custom({ method: 'GET', path: '/projects/1/pipelines', query: { scope: 'failed' } }),
      glDeps({ fetchImpl }),
    )
    expect(out.ok).toBe(true)
    expect(seen[0]!.url).toBe(
      'https://gitlab.corp.example/api/v4/projects/1/pipelines?scope=failed',
    )
  })

  test('custom path/query/body 全部在 fetch 前扫描 trigger 依赖', async () => {
    for (const request of [
      { method: 'GET' as const, path: '/projects/{{trigger.webhook.project_id}}' },
      {
        method: 'GET' as const,
        path: '/projects/1',
        query: { mr: '{{trigger.webhook.mr_iid}}' },
      },
      {
        method: 'POST' as const,
        path: '/projects/1',
        body: '{"body":"{{trigger.webhook.comment_text}}"}',
      },
    ]) {
      const { fetchImpl, seen } = capturing([{ status: 200 }])
      const out = await executeCodeHostCall(custom(request), glDeps({ fetchImpl }))
      expect(out).toMatchObject({ ok: false, code: 'trigger-context-missing' })
      expect(seen).toHaveLength(0)
    }
  })

  test('重复 event_json 造成渲染后 query 超限时 fetch=0', async () => {
    const eventJson = 'x'.repeat(32 * 1024)
    const template = Array.from(
      { length: Math.ceil(CODE_HOST_PARAM_MAX / eventJson.length) + 1 },
      () => '{{trigger.webhook.event_json}}',
    ).join('')
    const { fetchImpl, seen } = capturing([{ status: 200 }])
    const out = await executeCodeHostCall(
      custom({ method: 'GET', path: '/projects/1', query: { payload: template } }),
      glDeps({
        ctx: {
          ports: {},
          triggerContext: {
            trigger: { webhook: { event_type: 'note', event_json: eventJson } },
          },
        },
        fetchImpl,
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'code-host-param-invalid' })
    expect(seen).toHaveLength(0)
  })

  test('DELETE 需要显式勾选破坏性方法', async () => {
    const { fetchImpl, seen } = capturing([{ status: 204 }])
    const denied = await executeCodeHostCall(
      custom({ method: 'DELETE', path: '/projects/1/notes/2' }),
      glDeps({ fetchImpl }),
    )
    expect(denied.ok).toBe(false)
    expect(seen).toHaveLength(0)
    const allowed = await executeCodeHostCall(
      custom({ method: 'DELETE', path: '/projects/1/notes/2' }, { allowDestructive: true }),
      glDeps({ fetchImpl }),
    )
    expect(allowed.ok).toBe(true)
  })

  test('path 逃逸在发请求之前就被拒', async () => {
    const { fetchImpl, seen } = capturing([{ status: 200 }])
    for (const path of ['/../../admin', 'https://evil.example/x', '//evil.example/x']) {
      const out = await executeCodeHostCall(custom({ method: 'GET', path }), glDeps({ fetchImpl }))
      expect(out.ok).toBe(false)
      if (out.ok) continue
      expect(out.code).toBe('code-host-path-invalid')
    }
    expect(seen).toHaveLength(0)
  })

  test('上游值改不了 body 结构 —— 注入尝试只会变成字符串内容', async () => {
    const { fetchImpl, seen } = capturing([{ status: 201 }])
    const out = await executeCodeHostCall(
      custom({ method: 'POST', path: '/projects/1/notes', body: '{"body": "{{evil}}"}' }),
      glDeps({
        ctx: { ports: { evil: '", "admin": true, "x": "' }, triggerContext: null },
        fetchImpl,
      }),
    )
    expect(out.ok).toBe(true)
    const sent = JSON.parse(seen[0]!.body!) as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['body'])
    expect(sent.admin).toBeUndefined()
  })
})

describe('RFC-269 project 推导', () => {
  test('单仓任务从仓库 URL 推导；GitLab 整段编码、GitHub 分两段', () => {
    expect(
      resolveProjectFallback({
        provider: 'gitlab',
        baseUrl: GL_BASE,
        repositoryUrlPrefixes: [],
        repoUrl: 'https://gitlab.corp.example/grp/sub/repo.git',
        repoCount: 1,
      }),
    ).toEqual({ ok: true, value: 'grp%2Fsub%2Frepo' })
    expect(
      resolveProjectFallback({
        provider: 'github',
        baseUrl: GH_BASE,
        repositoryUrlPrefixes: [],
        repoUrl: 'git@github.com:octo/repo.git',
        repoCount: 1,
      }),
    ).toEqual({ ok: true, value: 'octo/repo' })
  })

  test('仓库不属于所配实例 ⇒ 拒绝并点名两个 host（绝不拿去改同名项目）', () => {
    const out = resolveProjectFallback({
      provider: 'gitlab',
      baseUrl: GL_BASE,
      repositoryUrlPrefixes: [],
      repoUrl: 'https://other.example/grp/repo.git',
      repoCount: 1,
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-project-foreign')
    expect(out.message).toContain('other.example')
    expect(out.message).toContain('gitlab.corp.example')
  })

  test('GitLab 仓库 URL 命中任一已配置前缀 ⇒ 允许用主连接执行', () => {
    expect(
      resolveProjectFallback({
        provider: 'gitlab',
        baseUrl: GL_BASE,
        repositoryUrlPrefixes: [
          'https://unused.example/team',
          'https://gitlab-mirror.example/platform',
        ],
        repoUrl: 'git@gitlab-mirror.example:platform/backend/api.git',
        repoCount: 1,
      }),
    ).toEqual({ ok: true, value: 'platform%2Fbackend%2Fapi' })
  })

  test('GitLab 仓库 URL 前缀按路径段边界匹配，近似字符串仍拒绝', () => {
    const out = resolveProjectFallback({
      provider: 'gitlab',
      baseUrl: GL_BASE,
      repositoryUrlPrefixes: ['https://gitlab-mirror.example/platform'],
      repoUrl: 'https://gitlab-mirror.example/platform-other/backend.git',
      repoCount: 1,
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-project-foreign')
  })

  test('仓库 URL 前缀是 GitLab 专属，GitHub 不消费同名字段', () => {
    const out = resolveProjectFallback({
      provider: 'github',
      baseUrl: GH_BASE,
      repositoryUrlPrefixes: ['https://github-mirror.example/octo'],
      repoUrl: 'https://github-mirror.example/octo/repo.git',
      repoCount: 1,
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-project-foreign')
  })

  test('多仓任务 ⇒ 要求显式填写（运行期判定，因为仓数是启动参数不是定义属性）', () => {
    const out = resolveProjectFallback({
      provider: 'gitlab',
      baseUrl: GL_BASE,
      repositoryUrlPrefixes: [],
      repoUrl: 'https://gitlab.corp.example/grp/repo.git',
      repoCount: 2,
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('code-host-project-unresolved')
  })
})

describe('RFC-269 URL 双复核', () => {
  test('origin 逃逸与路径前缀逃逸都被拦', () => {
    expect(buildCodeHostUrl(GL_BASE, '/projects/1').ok).toBe(true)
    // 只查 origin 拦不住这个：origin 一字未变，却跳到了 GitLab 管理界面。
    const escaped = buildCodeHostUrl(GL_BASE, '/../../admin')
    expect(escaped.ok).toBe(false)
    if (escaped.ok) return
    expect(escaped.issue).toBe('prefix-escaped')
  })

  test('base 在根上时（GitHub）前缀复核恒真且正确', () => {
    expect(buildCodeHostUrl(GH_BASE, '/repos/o/r').ok).toBe(true)
  })
})

describe('RFC-269 源码层锁', () => {
  test('执行路径不 spawn 任何子进程 —— 它因此不进 containment 准入面', () => {
    // 这条锁存在的意义：未来任何人把实现改成 `curl` 子进程，都会静默绕过
    // RFC-205/227/233 的全部边界论证，而所有行为测试仍会绿。
    const dir = resolve(import.meta.dir, '..', 'src', 'services', 'codeHost')
    for (const file of ['call.ts', 'connections.ts', 'project.ts', 'url.ts']) {
      const src = readFileSync(resolve(dir, file), 'utf8')
      expect(src).not.toContain('Bun.spawn')
      expect(src).not.toContain('containedSpawn')
      expect(src).not.toContain('child_process')
    }
  })

  test('RFC-292 统一 parser 同时服务 agent prompt 与 code-host，不再有私有 trigger grammar', () => {
    const promptSrc = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts'),
      'utf8',
    )
    expect(promptSrc).toContain('renderTemplateRefs')
    expect(promptSrc).toContain('triggerContext.trigger.webhook')

    const callSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'codeHost', 'call.ts'),
      'utf8',
    )
    expect(callSrc).toContain('renderCodeHostTemplate')
    expect(callSrc).toContain('triggerContext')
    expect(callSrc).not.toContain("'code-host-trigger-context-missing'")
  })
})
