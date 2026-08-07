// RFC-263 T1a — 事件参数补齐的 shared 契约层回归锁。
//
// 这套测试存在的理由（RFC-263 proposal §1）：webhook 事件此前只暴露 13 个变量，
// 回复一条 MR 评论所需的 project_id / discussion_id / comment_id 全被丢在 raw 里，
// 「自动回复评论的流水线」因此做不成。补齐后要锁住三件事：
//   ① eventVarsOf 的键集必须 === WEBHOOK_TEMPLATE_VARS —— 漏填一个新变量的症状是
//      模板渲染成空串（保存期还照样放行），不锁就查不出来；
//   ② {{comment_position_json}} 超限/序列化失败必须落**空串而非截断** —— 截断的
//      JSON 是非法 JSON，agent 要么解析失败要么把评论打到错位置（design §5.2）；
//   ③ WEBHOOK_VAR_GROUPS 必须完整覆盖全表 —— 漏登记的变量会在 UI 里直接消失。
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  CODE_HOST_EVENT_TYPES,
  CodeHostEventSchema,
  COMMENT_POSITION_JSON_MAX_CHARS,
  WEBHOOK_EVENT_VAR_MATRIX,
  WEBHOOK_TEMPLATE_VARS,
  WEBHOOK_VAR_GROUPS,
  availableVarsFor,
  eventVarsOf,
  extractTemplateVars,
  templateVarIssues,
  type CodeHostEvent,
} from '../src'

function noteEvent(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return CodeHostEventSchema.parse({
    provider: 'gitlab',
    eventUuid: 'uuid-1',
    eventType: 'note',
    repoPath: 'platform/backend/api',
    repoHttpUrl: 'https://gitlab.example.com/platform/backend/api.git',
    repoSshUrl: 'git@gitlab.example.com:platform/backend/api.git',
    branch: 'feature/x',
    targetBranch: 'main',
    mrIid: '42',
    mrTitle: '修一个 bug',
    commentText: '@aw 帮我看下',
    author: { username: 'dev-a' },
    raw: { object_kind: 'note' },
    ...overrides,
  })
}

describe('RFC-263 · 变量表与事件矩阵', () => {
  test('eventVarsOf 的键集 === WEBHOOK_TEMPLATE_VARS（漏填新变量的唯一防线）', () => {
    const vars = eventVarsOf(noteEvent())
    expect(Object.keys(vars).sort()).toEqual([...WEBHOOK_TEMPLATE_VARS].sort())
  })

  test('每个变量至少被一个事件类型声明（否则它在保存期永远不可用）', () => {
    const declared = new Set(Object.values(WEBHOOK_EVENT_VAR_MATRIX).flat())
    for (const v of WEBHOOK_TEMPLATE_VARS) {
      expect(declared.has(v)).toBe(true)
    }
  })

  test('矩阵不含重复项（MR_VARS 与 COMMON_VARS 拼接时最易出的错）', () => {
    for (const t of CODE_HOST_EVENT_TYPES) {
      const list = WEBHOOK_EVENT_VAR_MATRIX[t]
      expect(list.length).toBe(new Set(list).size)
    }
  })

  test('API 定位变量进 common 集：任何事件都能拿到 project_id / api_base_url', () => {
    for (const t of CODE_HOST_EVENT_TYPES) {
      const available = availableVarsFor([t])
      expect(available.has('project_id')).toBe(true)
      expect(available.has('api_base_url')).toBe(true)
      expect(available.has('provider')).toBe(true)
      expect(available.has('repo_owner')).toBe(true)
      expect(available.has('author_id')).toBe(true)
    }
  })

  test('评论专属变量只在 note 声明；pipeline 声明 pipeline_id、push 声明 commit_before', () => {
    expect(availableVarsFor(['note']).has('comment_thread_id')).toBe(true)
    expect(availableVarsFor(['mr_opened']).has('comment_thread_id')).toBe(false)
    expect(availableVarsFor(['pipeline_failed']).has('pipeline_id')).toBe(true)
    expect(availableVarsFor(['note']).has('pipeline_id')).toBe(false)
    expect(availableVarsFor(['push']).has('commit_before')).toBe(true)
    expect(availableVarsFor(['note']).has('commit_before')).toBe(false)
    // note ∩ pipeline_failed 的交集里没有任何一方独占的变量
    const both = availableVarsFor(['note', 'pipeline_failed'])
    expect(both.has('comment_thread_id')).toBe(false)
    expect(both.has('pipeline_id')).toBe(false)
    expect(both.has('mr_iid')).toBe(true)
  })

  test('保存期静态校验对新变量生效：push 触发器引用 comment_thread_id 被拒', () => {
    const issues = templateVarIssues('agent', { description: '回复 {{comment_thread_id}}' }, [
      'push',
    ])
    expect(issues).toContainEqual({
      code: 'template-var-unavailable',
      varName: 'comment_thread_id',
    })
    expect(
      templateVarIssues('agent', { description: '回复 {{comment_thread_id}}' }, ['note']),
    ).toEqual([])
  })
})

describe('RFC-263 · 运维文档与变量表同源', () => {
  test('docs/webhook-triggers.md 里的 curl 样例只引用真实存在的变量', () => {
    // 文档里的样例是用户直接抄去用的：写出一个不存在的变量名，抄的人拿到的是
    // 空串拼出来的 URL，而且保存触发器时才会 422 —— 在这里挡住更便宜。
    const doc = readFileSync(new URL('../../../docs/webhook-triggers.md', import.meta.url), 'utf8')
    const { known, unknown } = extractTemplateVars(doc)
    expect(unknown).toEqual([])
    // 样例至少覆盖回帖三件套，防止有人把整节删空后这条断言平凡通过
    expect(known).toContain('api_base_url')
    expect(known).toContain('project_id')
    expect(known).toContain('comment_thread_id')
  })
})

describe('RFC-263 · 变量分组（UI 单一事实源）', () => {
  test('两组的并集 === 全表、交集 = ∅', () => {
    const all = WEBHOOK_VAR_GROUPS.flatMap((g) => [...g.vars])
    expect(all.length).toBe(WEBHOOK_TEMPLATE_VARS.length)
    expect(new Set(all).size).toBe(WEBHOOK_TEMPLATE_VARS.length)
    expect([...all].sort()).toEqual([...WEBHOOK_TEMPLATE_VARS].sort())
  })
})

describe('RFC-263 · 新变量取值与缺值语义', () => {
  test('全部新变量取到值', () => {
    const vars = eventVarsOf(
      noteEvent({
        projectId: '15',
        repoOwner: 'platform/backend',
        repoName: 'api',
        apiBaseUrl: 'https://gitlab.example.com/api/v4',
        projectWebUrl: 'https://gitlab.example.com/platform/backend/api',
        defaultBranch: 'main',
        authorId: '7',
        mrId: '9901',
        mrUrl: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/42',
        commentId: '3311',
        commentThreadId: 'ab12cd34',
        commentUrl: 'https://gitlab.example.com/platform/backend/api/-/merge_requests/42#note_3311',
        pipelineId: '555',
        pipelineUrl: 'https://gitlab.example.com/platform/backend/api/-/pipelines/555',
        commitBefore: 'aaaa1111',
      }),
    )
    expect(vars.provider).toBe('gitlab')
    expect(vars.project_id).toBe('15')
    expect(vars.repo_owner).toBe('platform/backend')
    expect(vars.repo_name).toBe('api')
    expect(vars.api_base_url).toBe('https://gitlab.example.com/api/v4')
    expect(vars.project_web_url).toBe('https://gitlab.example.com/platform/backend/api')
    expect(vars.default_branch).toBe('main')
    expect(vars.author_id).toBe('7')
    expect(vars.mr_id).toBe('9901')
    expect(vars.mr_url).toContain('/merge_requests/42')
    expect(vars.comment_id).toBe('3311')
    expect(vars.comment_thread_id).toBe('ab12cd34')
    expect(vars.comment_url).toContain('#note_3311')
    expect(vars.pipeline_id).toBe('555')
    expect(vars.pipeline_url).toContain('/pipelines/555')
    expect(vars.commit_before).toBe('aaaa1111')
  })

  test('缺值一律空串，绝不渲染 undefined / null 字面量（AC-5）', () => {
    const vars = eventVarsOf(noteEvent())
    for (const [name, value] of Object.entries(vars)) {
      expect(typeof value).toBe('string')
      expect(value).not.toContain('undefined')
      expect(value === 'null').toBe(false)
      void name
    }
    expect(vars.comment_thread_id).toBe('')
    expect(vars.project_id).toBe('')
    expect(vars.comment_position_json).toBe('')
  })
})

describe('RFC-263 · comment_position_json（design §5.2）', () => {
  test('GitLab 形态原样透传，null 保留（old_line:null ⇒ 新增行，有语义）', () => {
    const position = {
      base_sha: 'a1',
      start_sha: 'b2',
      head_sha: 'c3',
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      position_type: 'text',
      old_line: null,
      new_line: 12,
    }
    const vars = eventVarsOf(noteEvent({ commentPosition: position }))
    expect(JSON.parse(vars.comment_position_json)).toEqual(position)
    expect(vars.comment_position_json).toContain('"old_line":null')
  })

  test('GitHub 形态（省略 null 由 adapter 负责）逐字节透传', () => {
    const position = { path: 'src/a.ts', line: 12, side: 'RIGHT', commit_id: 'c3' }
    const vars = eventVarsOf(
      noteEvent({ provider: 'github', commentPosition: position, raw: { action: 'created' } }),
    )
    expect(JSON.parse(vars.comment_position_json)).toEqual(position)
    expect(vars.comment_position_json).not.toContain('null')
  })

  test('超上限 → 空串而非截断（截断的 JSON 会让 agent 把评论打到错位置）', () => {
    const huge = { new_path: 'x'.repeat(COMMENT_POSITION_JSON_MAX_CHARS + 1) }
    const vars = eventVarsOf(noteEvent({ commentPosition: huge }))
    expect(vars.comment_position_json).toBe('')
  })

  test('刚好压线的值仍然透传（上限是 > 而非 >=）', () => {
    const filler = 'y'.repeat(COMMENT_POSITION_JSON_MAX_CHARS - '{"new_path":""}'.length)
    const vars = eventVarsOf(noteEvent({ commentPosition: { new_path: filler } }))
    expect(vars.comment_position_json.length).toBe(COMMENT_POSITION_JSON_MAX_CHARS)
  })

  test('序列化抛错（循环引用）→ 空串', () => {
    const cyclic: Record<string, unknown> = { new_path: 'src/a.ts' }
    cyclic.self = cyclic
    const vars = eventVarsOf(noteEvent({ commentPosition: cyclic }))
    expect(vars.comment_position_json).toBe('')
  })

  test('null / undefined position → 空串', () => {
    expect(eventVarsOf(noteEvent({ commentPosition: null })).comment_position_json).toBe('')
    expect(eventVarsOf(noteEvent({ commentPosition: undefined })).comment_position_json).toBe('')
  })
})
