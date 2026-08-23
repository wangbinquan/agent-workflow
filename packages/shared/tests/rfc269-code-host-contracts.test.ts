// RFC-269 / RFC-277 — shared 契约层与 GitLab TLS 开关的锁。
//
// 这个文件锁的是三类回归：
//   1. **动作注册表自洽**：binding 的 path/query/body 只能引用该动作声明过的
//      字段。表是手写的 19×2 映射，一个笔误就是运行期 404 或「参数明明填了却
//      没发出去」——那种 bug 在真实 GitLab 上才暴露，回归成本极高。
//   2. **按位置编码**（design D12/D13）：上游 agent 的输出经常带引号/换行，
//      拼接式模板会让它改掉请求结构。编码规则是这个 RFC 的安全承重。
//   3. **派生关系**：`TRIGGER_CONTEXT_FIELDS` 派生自 webhook 变量表，不是抄的。

import { describe, expect, test } from 'bun:test'
import {
  CODE_HOST_ACTION_DEFS,
  CODE_HOST_ACTION_GROUPS,
  CODE_HOST_ACTIONS,
  CodeHostConnectionWireSchema,
  CODE_HOST_FIELDS,
  CODE_HOST_MR_STATE_MAP,
  CODE_HOST_OUTPUT_PORTS,
  CODE_HOST_STATUS_STATE_MAP,
  codeHostActionFields,
  codeHostActionSupported,
  codeHostActionsByGroup,
  codeHostBindingCandidates,
  codeHostJsonBodyIssue,
  codeHostPathIssue,
  codeHostRequiredFields,
  extractCodeHostVars,
  isUnsupportedBinding,
  normalizeCodeHostBaseUrl,
  normalizeGitLabRepositoryUrlPrefix,
  renderCodeHostJsonBody,
  renderCodeHostTemplate,
  TRIGGER_CONTEXT_FIELDS,
  TestCodeHostConnectionSchema,
  UpsertCodeHostConnectionSchema,
  WEBHOOK_TEMPLATE_VARS,
  type CodeHostProvider,
} from '../src/index'

const PROVIDERS: readonly CodeHostProvider[] = ['gitlab', 'github']

describe('RFC-277 连接 TLS wire 契约', () => {
  test('读面必须明确返回 rejectUnauthorized，不能让客户端猜安全默认', () => {
    const row = {
      provider: 'gitlab',
      configured: true,
      baseUrl: 'https://gitlab.example/api/v4',
      repositoryUrlPrefixes: [],
      rejectUnauthorized: false,
      tokenHint: '1234',
      updatedAt: 1,
      updatedBy: null,
      lastTest: null,
    }
    expect(CodeHostConnectionWireSchema.parse(row).rejectUnauthorized).toBe(false)
    const missing: Partial<typeof row> = { ...row }
    delete missing.rejectUnauthorized
    expect(CodeHostConnectionWireSchema.safeParse(missing).success).toBe(false)
  })

  test('PUT/test 接受可选 boolean，并继续拒绝未知字段', () => {
    expect(
      UpsertCodeHostConnectionSchema.parse({
        baseUrl: 'https://gitlab.example/api/v4',
        rejectUnauthorized: false,
      }).rejectUnauthorized,
    ).toBe(false)
    expect(TestCodeHostConnectionSchema.parse({}).rejectUnauthorized).toBeUndefined()
    expect(
      TestCodeHostConnectionSchema.parse({ rejectUnauthorized: true }).rejectUnauthorized,
    ).toBe(true)
    expect(
      UpsertCodeHostConnectionSchema.safeParse({
        baseUrl: 'https://gitlab.example/api/v4',
        rejectUnauthorized: 'false',
      }).success,
    ).toBe(false)
  })

  test('GitLab 仓库 URL 前缀集合有界，单项归一化拒绝凭据与 query', () => {
    expect(
      UpsertCodeHostConnectionSchema.parse({
        baseUrl: 'https://gitlab.example/api/v4',
        repositoryUrlPrefixes: ['https://mirror.example/team'],
      }).repositoryUrlPrefixes,
    ).toEqual(['https://mirror.example/team'])
    expect(
      UpsertCodeHostConnectionSchema.safeParse({
        baseUrl: 'https://gitlab.example/api/v4',
        repositoryUrlPrefixes: Array.from({ length: 33 }, (_, i) => `https://h${i}.example`),
      }).success,
    ).toBe(false)

    expect(normalizeGitLabRepositoryUrlPrefix(' HTTPS://Mirror.Example/team/ ')).toEqual({
      ok: true,
      value: 'https://mirror.example/team',
    })
    expect(normalizeGitLabRepositoryUrlPrefix('ssh://git@mirror.example/team')).toEqual({
      ok: false,
      issue: 'not-http',
    })
    expect(normalizeGitLabRepositoryUrlPrefix('https://user:secret@mirror.example/team')).toEqual({
      ok: false,
      issue: 'has-credentials',
    })
    expect(normalizeGitLabRepositoryUrlPrefix('https://mirror.example/team?token=x')).toEqual({
      ok: false,
      issue: 'has-query',
    })
  })
})

// ---------------------------------------------------------------------------
// 1. 动作注册表自洽
// ---------------------------------------------------------------------------

describe('RFC-269 动作注册表', () => {
  test('每个动作在两家都有 binding 或明确的 unsupported 理由', () => {
    for (const action of CODE_HOST_ACTIONS) {
      for (const provider of PROVIDERS) {
        const binding = CODE_HOST_ACTION_DEFS[action].bindings[provider]
        if (isUnsupportedBinding(binding)) {
          expect(binding.reasonKey.length).toBeGreaterThan(0)
        } else {
          for (const candidate of codeHostBindingCandidates(binding)) {
            expect(candidate.path.startsWith('/')).toBe(true)
          }
        }
      }
    }
  })

  test('binding 的 path 占位符只引用该动作声明过的字段', () => {
    for (const action of CODE_HOST_ACTIONS) {
      const declared = new Set<string>(CODE_HOST_ACTION_DEFS[action].fields.map((f) => f.name))
      declared.add('__project__') // 解析后的 project 定位段，非表单字段
      for (const provider of PROVIDERS) {
        const binding = CODE_HOST_ACTION_DEFS[action].bindings[provider]
        if (isUnsupportedBinding(binding)) continue
        for (const candidate of codeHostBindingCandidates(binding)) {
          for (const m of candidate.path.matchAll(/\{([^}]+)\}/g)) {
            expect({ action, provider, placeholder: m[1] }).toMatchObject({
              placeholder: expect.any(String),
            })
            expect(declared.has(m[1]!)).toBe(true)
          }
        }
      }
    }
  })

  test('query / body 的取值字段也必须是声明过的字段', () => {
    for (const action of CODE_HOST_ACTIONS) {
      const declared = new Set<string>(CODE_HOST_ACTION_DEFS[action].fields.map((f) => f.name))
      for (const provider of PROVIDERS) {
        const binding = CODE_HOST_ACTION_DEFS[action].bindings[provider]
        if (isUnsupportedBinding(binding)) continue
        for (const candidate of codeHostBindingCandidates(binding)) {
          for (const map of [...(candidate.query ?? []), ...(candidate.body ?? [])]) {
            if ('field' in map.from) {
              expect(declared.has(map.from.field)).toBe(true)
            }
          }
        }
      }
    }
  })

  test('字段名全部来自闭合集合（前端 i18n 靠它保证漏写即编译红）', () => {
    const closed = new Set<string>(CODE_HOST_FIELDS)
    for (const action of CODE_HOST_ACTIONS) {
      for (const field of CODE_HOST_ACTION_DEFS[action].fields) {
        expect(closed.has(field.name)).toBe(true)
      }
    }
  })

  test('onlyFor 与 requiredFor 不矛盾：只对 A 显示的字段不能在 B 上必填', () => {
    for (const action of CODE_HOST_ACTIONS) {
      for (const field of CODE_HOST_ACTION_DEFS[action].fields) {
        const onlyFor = 'onlyFor' in field ? field.onlyFor : undefined
        if (onlyFor === undefined) continue
        for (const p of field.requiredFor) {
          expect(onlyFor).toContain(p)
        }
      }
    }
  })

  test('必填字段一定在该 provider 的可见字段里', () => {
    for (const action of CODE_HOST_ACTIONS) {
      for (const provider of PROVIDERS) {
        if (!codeHostActionSupported(action, provider)) continue
        const visible = new Set(codeHostActionFields(action, provider).map((f) => f.name))
        for (const required of codeHostRequiredFields(action, provider)) {
          expect(visible.has(required)).toBe(true)
        }
      }
    }
  })

  test('GitHub 的 resolve 线程是 unsupported —— REST 面没有这个端点', () => {
    // 2026-08-07 查证：resolveReviewThread 只在 GraphQL，且线程的 PRRT_ node id
    // 在 REST 面根本拿不到。这条断言存在是为了让「哪天有人顺手给它编一个 REST
    // 端点」立刻变红。
    expect(codeHostActionSupported('thread.resolve', 'github')).toBe(false)
    expect(codeHostActionSupported('thread.resolve', 'gitlab')).toBe(true)
  })

  test('GitLab 读 MR diff 优先 /diffs，并兼容仍只提供 /changes 的旧实例', () => {
    const binding = CODE_HOST_ACTION_DEFS['mr.diff'].bindings.gitlab
    expect(isUnsupportedBinding(binding)).toBe(false)
    if (isUnsupportedBinding(binding)) return
    expect(binding.path).toContain('/diffs')
    expect(binding.compatibilityFallbacks?.map((candidate) => candidate.path)).toEqual([
      '/projects/{__project__}/merge_requests/{mr}/changes',
    ])
  })

  test('GitHub 回复 review comment 兼容 replies 与 in_reply_to 两种官方写法', () => {
    const binding = CODE_HOST_ACTION_DEFS['comment.reply-thread'].bindings.github
    expect(isUnsupportedBinding(binding)).toBe(false)
    if (isUnsupportedBinding(binding)) return
    expect(binding.path).toContain('/comments/{thread}/replies')
    expect(binding.compatibilityFallbacks).toEqual([
      {
        method: 'POST',
        path: '/repos/{__project__}/pulls/{mr}/comments',
        body: [
          { api: 'body', from: { field: 'body' } },
          { api: 'in_reply_to', from: { field: 'thread' }, transform: 'integer' },
        ],
      },
    ])
  })

  test('job.log 是全表唯一带 followRedirectStripAuth 的 binding', () => {
    // 跟随重定向是凭据外泄面：GitHub 的 job 日志 302 到第三方签名主机，跟随时
    // 必须剥掉 Authorization。这条锁保证这个特例不会被顺手复制到别的动作上。
    const withQuirk: string[] = []
    for (const action of CODE_HOST_ACTIONS) {
      for (const provider of PROVIDERS) {
        const binding = CODE_HOST_ACTION_DEFS[action].bindings[provider]
        if (isUnsupportedBinding(binding)) continue
        for (const candidate of codeHostBindingCandidates(binding)) {
          if (candidate.quirks?.includes('followRedirectStripAuth') === true) {
            withQuirk.push(`${action}/${provider}`)
          }
        }
      }
    }
    expect(withQuirk).toEqual(['job.log/github'])
  })

  test('分组覆盖全部动作且顺序稳定', () => {
    const grouped = codeHostActionsByGroup()
    expect(grouped.map((g) => g.group)).toEqual([...CODE_HOST_ACTION_GROUPS])
    expect(grouped.flatMap((g) => g.actions).sort()).toEqual([...CODE_HOST_ACTIONS].sort())
    expect(grouped.find((g) => g.group === 'custom')?.actions).toEqual(['custom'])
  })

  test('两个固定输出端口', () => {
    expect(CODE_HOST_OUTPUT_PORTS).toEqual(['response', 'status'])
  })

  test('commit status 的三档在两家各自映射（GitHub 是 failure 不是 failed）', () => {
    expect(CODE_HOST_STATUS_STATE_MAP.gitlab.failed).toBe('failed')
    expect(CODE_HOST_STATUS_STATE_MAP.github.failed).toBe('failure')
    for (const provider of PROVIDERS) {
      expect(Object.keys(CODE_HOST_STATUS_STATE_MAP[provider]).sort()).toEqual([
        'failed',
        'pending',
        'success',
      ])
    }
  })

  test('MR 列表过滤三档各自映射（GitLab 是 opened 不是 open）', () => {
    expect(CODE_HOST_MR_STATE_MAP.gitlab.open).toBe('opened')
    expect(CODE_HOST_MR_STATE_MAP.github.open).toBe('open')
  })

  test('select 字段的 options 非空', () => {
    for (const action of CODE_HOST_ACTIONS) {
      for (const field of CODE_HOST_ACTION_DEFS[action].fields) {
        if (field.control !== 'select') continue
        const options = 'options' in field ? field.options : undefined
        expect(options?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 模板渲染与按位置编码
// ---------------------------------------------------------------------------

const CTX = {
  ports: {
    verdict: 'failed',
    audit: 'He said "no".\nLine2\\end',
    path: 'src/a b.ts',
    cn: '中文与 emoji 🎯',
  },
  triggerContext: {
    trigger: {
      webhook: { event_type: 'note' as const, mr_iid: '42', comment_thread_id: 'abc123' },
    },
  },
}

describe('RFC-269 模板渲染', () => {
  test('端口与 trigger.webhook 两个命名空间都能解析', () => {
    const r = renderCodeHostTemplate('{{verdict}}/{{trigger.webhook.mr_iid}}', CTX)
    expect(r.value).toBe('failed/42')
    expect(r.triggerMissing).toBe(false)
  })

  test('提取变量区分两个命名空间', () => {
    expect(extractCodeHostVars('{{a}} {{trigger.webhook.mr_iid}} {{a}}')).toEqual([
      { kind: 'port', name: 'a' },
      { kind: 'trigger', source: 'webhook', name: 'mr_iid' },
    ])
  })

  test('无触发上下文时 triggerMissing 为真且渲染空串', () => {
    const r = renderCodeHostTemplate('{{trigger.webhook.mr_iid}}', {
      ports: {},
      triggerContext: null,
    })
    expect(r.value).toBe('')
    expect(r.triggerMissing).toBe(true)
  })

  test('path 位置 percent-encode，斜杠也编码（GitLab 文件端点正需要）', () => {
    const r = renderCodeHostTemplate('{{path}}', CTX, 'path')
    expect(r.value).toBe('src%2Fa%20b.ts')
  })

  test('path 位置的变量值无法新开一个路径段', () => {
    const r = renderCodeHostTemplate(
      '/projects/{{p}}/notes',
      { ports: { p: '../../admin' }, triggerContext: null },
      'path',
    )
    expect(r.value).toBe('/projects/..%2F..%2Fadmin/notes')
    expect(r.value).not.toContain('/../')
  })

  test('JSON 字符串位置转义引号与换行', () => {
    const r = renderCodeHostTemplate('{{audit}}', CTX, 'json-string')
    expect(r.value).toBe('He said \\"no\\".\\nLine2\\\\end')
    expect(JSON.parse(`"${r.value}"`)).toBe(CTX.ports.audit)
  })

  test('raw 位置原样输出（query 值交给 URLSearchParams）', () => {
    expect(renderCodeHostTemplate('{{audit}}', CTX, 'raw').value).toBe(CTX.ports.audit)
  })

  test('中文与 emoji 在三种位置都不损坏', () => {
    expect(decodeURIComponent(renderCodeHostTemplate('{{cn}}', CTX, 'path').value)).toBe(
      CTX.ports.cn,
    )
    expect(JSON.parse(`"${renderCodeHostTemplate('{{cn}}', CTX, 'json-string').value}"`)).toBe(
      CTX.ports.cn,
    )
  })

  test('空值与未知变量记进 emptyRefs', () => {
    const r = renderCodeHostTemplate('{{nope}}', { ports: {}, triggerContext: null })
    expect(r.value).toBe('')
    expect(r.emptyRefs).toEqual([{ kind: 'port', name: 'nope' }])
  })
})

// ---------------------------------------------------------------------------
// 3. D13 —— 自定义 JSON body 的变量落点
// ---------------------------------------------------------------------------

describe('RFC-269 自定义 body 落点判定（D13）', () => {
  test('变量在字符串值里 —— 放行', () => {
    expect(codeHostJsonBodyIssue('{"body": "{{audit}}"}')).toBeNull()
  })

  test('变量在数组元素的字符串里 —— 放行', () => {
    expect(codeHostJsonBodyIssue('{"labels": ["{{a}}", "b"]}')).toBeNull()
  })

  test('变量在数字位 —— 拒绝并指出是哪个变量', () => {
    expect(codeHostJsonBodyIssue('{"n": {{count}}}')).toEqual({
      kind: 'var-outside-string',
      ref: 'count',
    })
  })

  test('变量当键名 —— 拒绝', () => {
    expect(codeHostJsonBodyIssue('{"{{key}}": "v"}')).toEqual({ kind: 'var-in-key', ref: 'key' })
  })

  test('body 骨架本身非法 —— 报 invalid-json 而不是甩锅给变量', () => {
    expect(codeHostJsonBodyIssue('{"body": "{{a}}",}')).toEqual({ kind: 'invalid-json' })
  })

  test('空 body 合法', () => {
    expect(codeHostJsonBodyIssue('')).toBeNull()
    expect(codeHostJsonBodyIssue('   ')).toBeNull()
  })

  test('渲染时上游值里的引号破坏不了 body 结构', () => {
    const out = renderCodeHostJsonBody('{"body": "{{audit}}"}', CTX)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value).toEqual({ body: CTX.ports.audit })
  })

  test('上游值试图注入一个新字段也只会变成字符串内容', () => {
    const ctx = { ports: { x: '", "admin": true, "z": "' }, triggerContext: null }
    const out = renderCodeHostJsonBody('{"body": "{{x}}"}', ctx)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value).toEqual({ body: '", "admin": true, "z": "' })
    expect(Object.keys(out.value as object)).toEqual(['body'])
  })
})

// ---------------------------------------------------------------------------
// 4. path 判据
// ---------------------------------------------------------------------------

describe('RFC-269 自定义 path 判据', () => {
  test('正常相对 path 放行', () => {
    expect(codeHostPathIssue('/projects/1/merge_requests/2/notes')).toBeNull()
    expect(codeHostPathIssue('/projects/{{trigger.webhook.project_id}}/notes')).toBeNull()
  })

  test('绝对 URL 报 has-scheme', () => {
    expect(codeHostPathIssue('https://evil.example/x')).toBe('has-scheme')
    expect(codeHostPathIssue('file:///etc/passwd')).toBe('has-scheme')
  })

  test('不以斜杠开头 / 协议相对', () => {
    expect(codeHostPathIssue('projects/1')).toBe('not-relative')
    expect(codeHostPathIssue('//evil.example/x')).toBe('protocol-relative')
  })

  test('.. 段被拒绝，含 percent-encoded 形态', () => {
    // 实证：base + '/../../admin' 会打到 GitLab 的管理界面，origin 检查对它无感。
    expect(codeHostPathIssue('/../../admin')).toBe('dot-dot')
    expect(codeHostPathIssue('/a/%2e%2e/b')).toBe('dot-dot')
    expect(codeHostPathIssue('/a/%2E%2E/b')).toBe('dot-dot')
  })

  test('..foo 与 ..%2f 不是逃逸段，不误伤', () => {
    expect(codeHostPathIssue('/a/..foo/b')).toBeNull()
    expect(codeHostPathIssue('/a/..%2fadmin')).toBeNull()
  })

  test('@ 与反斜杠不判负 —— 实证在真实拼接形态下无害，且 @ 是合法段名', () => {
    // GitLab 的 npm 包端点就带 @scope；把它判负是误伤。真正的兜底是后端的
    // origin + 路径前缀双复核。
    expect(codeHostPathIssue('/projects/1/packages/npm/@scope/pkg')).toBeNull()
  })

  test('query / fragment 要走独立字段', () => {
    expect(codeHostPathIssue('/x?a=1')).toBe('has-query')
    expect(codeHostPathIssue('/x#f')).toBe('has-query')
  })

  test('空白与控制符', () => {
    expect(codeHostPathIssue('')).toBe('empty')
    expect(codeHostPathIssue('/a b')).toBe('whitespace')
    expect(codeHostPathIssue('/a\u0007b')).toBe('control-char')
  })
})

describe('RFC-269 base URL 归一化', () => {
  test('GitLab 认 /api/v4，含子路径部署', () => {
    expect(normalizeCodeHostBaseUrl('https://gitlab.corp.example/api/v4/', 'gitlab')).toEqual({
      ok: true,
      value: 'https://gitlab.corp.example/api/v4',
    })
    expect(normalizeCodeHostBaseUrl('https://host/gitlab/api/v4', 'gitlab')).toEqual({
      ok: true,
      value: 'https://host/gitlab/api/v4',
    })
  })

  test('GitLab 少了 /api/v4 —— 说清期望形态而不是照收', () => {
    expect(normalizeCodeHostBaseUrl('https://gitlab.corp.example', 'gitlab')).toEqual({
      ok: false,
      issue: 'wrong-suffix',
    })
  })

  test('GitHub 认根域与 GHES 的 /api/v3', () => {
    expect(normalizeCodeHostBaseUrl('https://api.github.com', 'github')).toEqual({
      ok: true,
      value: 'https://api.github.com',
    })
    expect(normalizeCodeHostBaseUrl('https://ghes.corp.example/api/v3', 'github')).toEqual({
      ok: true,
      value: 'https://ghes.corp.example/api/v3',
    })
  })

  test('非 http(s) / 带凭据 / 带 query 一律拒绝', () => {
    expect(normalizeCodeHostBaseUrl('ftp://h/api/v4', 'gitlab').ok).toBe(false)
    expect(normalizeCodeHostBaseUrl('https://u:p@h/api/v4', 'gitlab')).toEqual({
      ok: false,
      issue: 'has-credentials',
    })
    expect(normalizeCodeHostBaseUrl('https://h/api/v4?x=1', 'gitlab')).toEqual({
      ok: false,
      issue: 'has-query',
    })
    expect(normalizeCodeHostBaseUrl('', 'gitlab')).toEqual({ ok: false, issue: 'empty' })
  })
})

// ---------------------------------------------------------------------------
// 5. 派生关系锁
// ---------------------------------------------------------------------------

describe('RFC-292 触发上下文变量集', () => {
  test('恰好是 webhook 30 字段闭集 —— 派生而非抄写', () => {
    expect([...TRIGGER_CONTEXT_FIELDS].sort()).toEqual([...WEBHOOK_TEMPLATE_VARS].sort())
  })

  test('包含统一截断后的 event_json', () => {
    expect(TRIGGER_CONTEXT_FIELDS as readonly string[]).toContain('event_json')
  })

  test('包含回帖流水线真正要用的那几个定位变量', () => {
    for (const v of ['project_id', 'mr_iid', 'comment_thread_id', 'api_base_url']) {
      expect(TRIGGER_CONTEXT_FIELDS as readonly string[]).toContain(v)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. 节点 kind 接线
// ---------------------------------------------------------------------------

describe('RFC-269 节点 kind 接线', () => {
  test('code-host-call 是 process kind 但不是 agent kind', async () => {
    const { NODE_KIND_BEHAVIORS } = await import('../src/node-kind-behavior')
    expect(NODE_KIND_BEHAVIORS['code-host-call']).toEqual({
      retryCascade: 'mint-placeholder',
      isAgent: false,
      settlesWithoutRow: false,
    })
  })

  test('声明两个输出端口、零输入端口', async () => {
    const { declaredPorts } = await import('../src/nodePorts')
    const node = { id: 'n1', kind: 'code-host-call' as const }
    const ports = declaredPorts(
      node,
      { $schema_version: 4, inputs: [], nodes: [node], edges: [] },
      { byId: () => undefined, byName: () => undefined },
    )
    expect(ports.dataOutputs.map((p) => p.name)).toEqual(['response', 'status'])
    expect(ports.dataInputs).toEqual([])
  })

  test('失败码进了闭合的 FAILURE_CODES 域（漏登记会让任务列表整页解析失败）', async () => {
    const { FAILURE_CODES, CODE_HOST_FAILURE_CODES } = await import('../src/schemas/task')
    for (const code of CODE_HOST_FAILURE_CODES) {
      expect(FAILURE_CODES as readonly string[]).toContain(code)
    }
  })

  test('权限点是系统域点：永不上令牌，角色基线 admin + manager', async () => {
    const { SYSTEM_DOMAIN_POINTS, ROLE_PERMISSIONS, MATRIX_DOMAIN_POINTS } =
      await import('../src/schemas/permission')
    const point = 'code-host-calls:author'
    expect(SYSTEM_DOMAIN_POINTS as readonly string[]).toContain(point)
    expect(MATRIX_DOMAIN_POINTS as readonly string[]).not.toContain(point)
    expect(ROLE_PERMISSIONS.admin as readonly string[]).toContain(point)
    expect(ROLE_PERMISSIONS.manager as readonly string[]).toContain(point)
    expect(ROLE_PERMISSIONS.user as readonly string[]).not.toContain(point)
  })
})
