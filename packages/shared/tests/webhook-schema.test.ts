// RFC-257 T1 — shared 契约层回归锁。
// 锁三层：①模板封套「事件仓 repo 源/name/ref-id 禁填」（设计门 F-3：直接复用
// scheduledPayloadSchemaFor 会因 StartTaskSchema 的 repo 三态 superRefine 拒掉
// 合法模板——本套 schema 存在的理由）；②模板变量矩阵与保存期静态校验
// （设计门 F-1 前提：pipeline 类事件声明 mr_iid 但不受忽略名单过滤）；
// ③event_json 截断 ≤32KiB（设计门 F-10：256KiB 原文塞 65536 上限注入面必 422）。
import { describe, expect, test } from 'bun:test'

import {
  AUTHOR_FILTERED_EVENT_TYPES,
  CODE_HOST_EVENT_TYPES,
  CodeHostEventSchema,
  CreateWebhookEndpointSchema,
  CreateWebhookTriggerSchema,
  EVENT_JSON_VAR_MAX_CHARS,
  UpdateWebhookTriggerSchema,
  WEBHOOK_DELIVERY_REASONS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_VAR_MATRIX,
  WEBHOOK_FIRE_OUTCOMES,
  WebhookRepoScopeSchema,
  availableVarsFor,
  collectWebhookTemplateSurfaces,
  collectTemplateStrings,
  eventVarsOf,
  extractTemplateVars,
  mapWebhookTemplateSurfaces,
  renderTemplate,
  templateVarIssues,
  webhookTriggerContextOf,
  webhookPayloadTemplateSchemaFor,
  type CodeHostEvent,
} from '../src'

function sampleEvent(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return CodeHostEventSchema.parse({
    provider: 'gitlab',
    eventUuid: 'uuid-1',
    eventType: 'pipeline_failed',
    repoPath: 'platform/backend/api',
    repoHttpUrl: 'https://gitlab.example.com/platform/backend/api.git',
    repoSshUrl: 'git@gitlab.example.com:platform/backend/api.git',
    branch: 'feature/x',
    mrIid: '42',
    author: { username: 'aw-bot' },
    pipelineStatus: 'failed',
    raw: { object_kind: 'pipeline' },
    ...overrides,
  })
}

describe('RFC-257 T1 · 模板封套（F-3 派生 schema）', () => {
  test('workflow 模板：事件仓 repo 源 / ref / name / workflowId 全部被 strict 拒绝', () => {
    for (const bad of [
      { repoUrl: 'https://x/y.git' },
      { cachedRepoId: 'c1' },
      { repoGroupId: 'g1' },
      { sourceTaskId: 't1' },
      { ref: 'main' },
      { name: 'x' },
      { workflowId: 'w1' },
      { expectedWorkflowVersion: 3 },
    ]) {
      const r = webhookPayloadTemplateSchemaFor('workflow').safeParse({ inputs: {}, ...bad })
      expect(r.success).toBe(false)
    }
  })

  test('workflow 模板：inputs 映射是判别对象（template | event-branch），裸字符串被拒', () => {
    const ok = webhookPayloadTemplateSchemaFor('workflow').safeParse({
      inputs: {
        mr_ref: { kind: 'event-branch' },
        title: { kind: 'template', template: '{{mr_title}}' },
      },
    })
    expect(ok.success).toBe(true)
    const bare = webhookPayloadTemplateSchemaFor('workflow').safeParse({
      inputs: { mr_ref: '{{branch}}' },
    })
    expect(bare.success).toBe(false)
  })

  test('agent / workgroup 模板：插值字段对齐启动 schema 上限；repo 源禁填', () => {
    expect(
      webhookPayloadTemplateSchemaFor('agent').safeParse({
        description: '修复 {{repo_path}} 的 MR !{{mr_iid}}',
      }).success,
    ).toBe(true)
    expect(
      webhookPayloadTemplateSchemaFor('agent').safeParse({ description: 'x', repoUrl: 'u' })
        .success,
    ).toBe(false)
    expect(webhookPayloadTemplateSchemaFor('workgroup').safeParse({ goal: 'g' }).success).toBe(true)
    expect(
      webhookPayloadTemplateSchemaFor('workgroup').safeParse({ goal: 'g', cachedRepoId: 'c' })
        .success,
    ).toBe(false)
  })

  test('CreateWebhookTriggerSchema 在请求边界跑封套校验（issues 冒泡到 launchPayload 路径）', () => {
    const r = CreateWebhookTriggerSchema.safeParse({
      name: 't',
      endpointId: 'e1',
      repoScope: { kind: 'all' },
      eventTypes: ['pipeline_failed'],
      launchKind: 'workgroup',
      launchRefId: 'wg1',
      launchPayload: { goal: '' }, // goal min(1) 违例
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === 'launchPayload')).toBe(true)
    }
  })

  test('Update schema strict：未知键拒绝；eventTypes 去重', () => {
    expect(UpdateWebhookTriggerSchema.safeParse({ visibility: 'public' }).success).toBe(false)
    const r = CreateWebhookTriggerSchema.safeParse({
      name: 't',
      endpointId: 'e1',
      repoScope: { kind: 'prefix', prefix: 'platform/' },
      eventTypes: ['push', 'push', 'note'],
      launchKind: 'agent',
      launchRefId: 'a1',
      launchPayload: { description: 'x {{comment_text}}' },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.eventTypes).toEqual(['push', 'note'])
  })
})

describe('RFC-257 T1 · repoScope / 端点 wire', () => {
  test('三态判别 + exact 去重', () => {
    expect(WebhookRepoScopeSchema.safeParse({ kind: 'all' }).success).toBe(true)
    expect(WebhookRepoScopeSchema.safeParse({ kind: 'prefix', prefix: '' }).success).toBe(false)
    const r = WebhookRepoScopeSchema.safeParse({ kind: 'exact', paths: ['a/b', 'a/b', 'c/d'] })
    expect(r.success).toBe(true)
    if (r.success && r.data.kind === 'exact') expect(r.data.paths).toEqual(['a/b', 'c/d'])
  })

  test('端点创建默认值（provider=gitlab、http），未知键拒绝', () => {
    const r = CreateWebhookEndpointSchema.parse({ name: '内网 GitLab' })
    expect(r.provider).toBe('gitlab')
    expect(r.preferredCloneProtocol).toBe('http')
    expect(CreateWebhookEndpointSchema.safeParse({ name: 'x', secret: 's' }).success).toBe(false)
  })
})

describe('RFC-257 T1 · closed enum 穷尽表（emit 域；改动此表 = 显式决策）', () => {
  test('delivery status / reason / fire outcome', () => {
    expect([...WEBHOOK_DELIVERY_STATUSES]).toEqual([
      'received',
      'processing',
      'rejected',
      'ignored',
      'matched',
      'failed',
    ])
    expect([...WEBHOOK_DELIVERY_REASONS]).toEqual([
      'invalid-token',
      'missing-token',
      'endpoint-disabled',
      'no-trigger-matched',
      'unsupported-event',
      'parse-failed',
      'internal-error',
      'interrupted',
    ])
    expect([...WEBHOOK_FIRE_OUTCOMES]).toEqual([
      'launched',
      'launch-failed',
      'skipped-circuit-open',
      'skipped-repo-unregistered',
      'skipped-owner-invalid',
      'skipped-trigger-disabled',
      'skipped-mr-stream-closed',
      'skipped-mr-stream-merged',
      'skipped-mr-stream-terminal',
      'skipped-trigger-invalid',
    ])
  })

  test('忽略名单作用域（设计门 F-1/D14）：恰好排除两个 pipeline 类事件', () => {
    const filtered = new Set(AUTHOR_FILTERED_EVENT_TYPES)
    const excluded = CODE_HOST_EVENT_TYPES.filter((t) => !filtered.has(t))
    expect(excluded).toEqual(['pipeline_failed', 'pipeline_succeeded'])
  })
})

describe('RFC-257 T1 · 模板变量矩阵与静态校验', () => {
  test('矩阵覆盖全部事件类型；交集语义', () => {
    for (const t of CODE_HOST_EVENT_TYPES) {
      expect(WEBHOOK_EVENT_VAR_MATRIX[t].length).toBeGreaterThan(0)
    }
    // note ∩ push 交集不含 comment_text（push 不声明）
    const both = availableVarsFor(['note', 'push'])
    expect(both.has('comment_text')).toBe(false)
    expect(both.has('repo_path')).toBe(true)
    expect(availableVarsFor([]).size).toBe(0)
    // pipeline 声明 mr_iid（修到绿模板的生存条件）
    expect(availableVarsFor(['pipeline_failed']).has('mr_iid')).toBe(true)
  })

  test('extractTemplateVars：known/unknown 分离，空白容忍', () => {
    const r = extractTemplateVars(
      '修 {{ trigger.webhook.mr_iid }} 于 {{trigger.webhook.branch}}，坏 {{trigger.webhook.nope}} 与 {{trigger.other.mr_iid}}',
    )
    expect(r.known.sort()).toEqual(['branch', 'mr_iid'])
    expect(r.unknown).toEqual(['trigger.webhook.nope', 'trigger.other.mr_iid'])
  })

  test('templateVarIssues：unknown 拒绝、超出交集拒绝、合法通过', () => {
    const okIssues = templateVarIssues(
      'agent',
      {
        description: '修 {{trigger.webhook.repo_path}} !{{trigger.webhook.mr_iid}}',
      },
      ['pipeline_failed'],
    )
    expect(okIssues).toEqual([])
    const bad = templateVarIssues(
      'agent',
      {
        description: '{{trigger.webhook.comment_text}} {{trigger.webhook.whatever}}',
      },
      ['pipeline_failed'],
    )
    expect(bad).toContainEqual({ code: 'template-var-unavailable', varName: 'comment_text' })
    expect(bad).toContainEqual({
      code: 'unknown-template-var',
      varName: 'trigger.webhook.whatever',
    })
  })

  test('collectTemplateStrings：workflow 只收 template 映射（event-branch 无文本）', () => {
    const strings = collectTemplateStrings('workflow', {
      inputs: {
        a: { kind: 'template', template: 'x {{trigger.webhook.branch}}' },
        b: { kind: 'event-branch' },
      },
    })
    expect(strings).toEqual(['x {{trigger.webhook.branch}}'])
  })

  test('webhook template surface inventory drives all launch kinds and mapping', () => {
    expect(
      collectWebhookTemplateSurfaces('workflow', {
        inputs: {
          a: { kind: 'template', template: 'A' },
          branch: { kind: 'event-branch' },
        },
        workingBranch: 'WB',
      }).map(({ pointer, text }) => [pointer, text]),
    ).toEqual([
      ['/inputs/a/template', 'A'],
      ['/workingBranch', 'WB'],
    ])
    expect(
      collectWebhookTemplateSurfaces('agent', {
        description: 'D',
        inputs: { 'a/b~c': 'I' },
        workingBranch: 'WB',
      }).map(({ pointer, text }) => [pointer, text]),
    ).toEqual([
      ['/description', 'D'],
      ['/inputs/a~1b~0c', 'I'],
      ['/workingBranch', 'WB'],
    ])
    const mapped = mapWebhookTemplateSurfaces(
      'workgroup',
      { goal: 'G', workingBranch: 'WB' },
      ({ pointer, text }) => `${pointer}:${text}`,
    )
    expect(mapped).toEqual({ goal: '/goal:G', workingBranch: '/workingBranch:WB' })
  })
})

describe('RFC-257 T1 · 运行期渲染（宽松空串 + event_json 截断）', () => {
  test('eventVarsOf：缺值空串；event_json 截断 ≤32KiB（F-10）', () => {
    const big = sampleEvent({ raw: { blob: 'x'.repeat(300 * 1024) } })
    const vars = eventVarsOf(big)
    expect(vars.event_json.length).toBeLessThanOrEqual(EVENT_JSON_VAR_MAX_CHARS)
    expect(vars.comment_text).toBe('')
    expect(vars.mr_iid).toBe('42')
    expect(vars.comment_author).toBe('aw-bot')
  })

  test('renderTemplate：只读嵌套 context；适用但缺值为空串；普通未闭合文本原样', () => {
    const context = webhookTriggerContextOf(sampleEvent({ branch: 'f/x' }))
    const out = renderTemplate(
      'a={{trigger.webhook.branch}} b={{ trigger.webhook.mr_iid }} c={{trigger.webhook.comment_text}} d={{no',
      context,
    )
    expect(out).toBe('a=f/x b=42 c= d={{no')
  })
})
