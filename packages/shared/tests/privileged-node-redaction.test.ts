// RFC-270 §7 — 特权节点权限镜头（脱敏 + 回填）。
//
// 这些用例锁的是三条会静默出事的性质：
//   1. **不遮枚举** —— 把 `provider` / `language` / `request.method` 脱成 `'***'`
//      会让 `ScriptNodeSchema` / `CodeHostCallNodeSchema` 严格解析失败，而
//      `workflow.validator.ts` 正是拿这两个 schema 做严格再解析的，于是「遮一下
//      详情」会变成「整份工作流校验不过」。所以有一条直接把脱敏结果喂给严格
//      schema 的用例。
//   2. **回填由镜头决定、不由值决定** —— 一旦改成「看到 `***` 才回填」，有权限
//      的作者把正文真的写成 `***` 就会被静默吞掉。
//   3. **脱敏与回填成对** —— 两者共用同一份字段清单；清单分家 = 静默丢数据。
//      末尾那条「脱敏∘回填后两个 author 门的敏感投影一字不变」的不变式是守门人。

import { describe, expect, it } from 'bun:test'
import {
  CODE_HOST_REDACTED_FIELDS,
  CodeHostCallNodeSchema,
  PRIVILEGED_LENS_TRANSPARENT,
  SCRIPT_REDACTED_FIELDS,
  ScriptNodeSchema,
  lensIsTransparent,
  privilegedProjectionChange,
  redactPrivilegedNodes,
  rehydratePrivilegedNodes,
  serializeCodeHostSensitiveProjectionV1,
  serializeScriptSensitiveProjectionV1,
  type PrivilegedNodeLens,
  type WorkflowDefinition,
} from '../src/index'

const MARKER = '***'
const OPAQUE: PrivilegedNodeLens = { scripts: true, codeHost: true }
const SCRIPTS_ONLY: PrivilegedNodeLens = { scripts: true, codeHost: false }

/**
 * 造 env map 必须走 `Object.fromEntries` 而不是对象字面量。
 *
 * 字面量里的 `__proto__:` 是**原型 setter 语法**，压根不会变成自有属性——用字面量
 * 造夹具的话，「`__proto__` 键存活」这条用例会因为夹具里本来就没有那个键而假绿。
 * 这与被测代码里禁止逐键赋值是同一个语言坑的两面。
 */
function envOf(entries: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(entries)
}

function scriptNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sc1',
    kind: 'script',
    position: { x: 0, y: 0 },
    title: '打分',
    language: 'python',
    script: 'import os\nprint(os.environ["AW_PORT_DIFF"])\n',
    outputs: [{ name: 'score', kind: 'number' }],
    dependencies: ['requests==2.31.0'],
    env: envOf([
      ['API_KEY', 'sk-live-abc'],
      ['__proto__', 'polluted'],
    ]),
    network: 'deny',
    readonly: true,
    ...overrides,
  }
}

function codeHostNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ch1',
    kind: 'code-host-call',
    position: { x: 300, y: 0 },
    provider: 'gitlab',
    action: 'custom',
    params: { project: 'grp/app', body: '审计通过' },
    request: {
      method: 'POST',
      path: '/api/v4/projects/1/merge_requests/2/notes',
      query: { per_page: '50' },
      body: '{"body":"{{score}}"}',
    },
    allowDestructive: false,
    timeoutMs: 30_000,
    ...overrides,
  }
}

function definitionOf(nodes: Array<Record<string, unknown>>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: nodes as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
}

function nodeById(def: WorkflowDefinition, id: string): Record<string, unknown> {
  const found = def.nodes.find((node) => node.id === id)
  if (found === undefined) throw new Error(`no node ${id}`)
  return found as unknown as Record<string, unknown>
}

describe('RFC-270 · lens', () => {
  it('透明镜头就是「两项都不遮」', () => {
    expect(lensIsTransparent(PRIVILEGED_LENS_TRANSPARENT)).toBe(true)
    expect(lensIsTransparent(SCRIPTS_ONLY)).toBe(false)
    expect(lensIsTransparent(OPAQUE)).toBe(false)
  })

  it('透明镜头返回同一个引用（调用方的短路判断依赖它）', () => {
    const def = definitionOf([scriptNode(), codeHostNode()])
    expect(redactPrivilegedNodes(def, PRIVILEGED_LENS_TRANSPARENT, MARKER)).toBe(def)
    expect(rehydratePrivilegedNodes(def, def, PRIVILEGED_LENS_TRANSPARENT)).toBe(def)
  })

  it('没有特权节点时同样返回同一个引用', () => {
    const def = definitionOf([{ id: 'a', kind: 'agent-single', agentId: 'ag1' }])
    expect(redactPrivilegedNodes(def, OPAQUE, MARKER)).toBe(def)
  })

  it('镜头分家：只遮脚本时代码平台节点一字不动', () => {
    const def = definitionOf([scriptNode(), codeHostNode()])
    const out = redactPrivilegedNodes(def, SCRIPTS_ONLY, MARKER)
    expect(nodeById(out, 'sc1').script).toBe(MARKER)
    expect(nodeById(out, 'ch1').params).toEqual({ project: 'grp/app', body: '审计通过' })
  })
})

describe('RFC-270 · 脚本节点脱敏', () => {
  const out = redactPrivilegedNodes(definitionOf([scriptNode()]), OPAQUE, MARKER)
  const node = nodeById(out, 'sc1')

  it('正文 / env 值 / 依赖被遮', () => {
    expect(node.script).toBe(MARKER)
    expect(node.env).toEqual(
      envOf([
        ['API_KEY', MARKER],
        ['__proto__', MARKER],
      ]),
    )
    expect(node.dependencies).toEqual([MARKER])
  })

  it('env 的键全部存活，含 `__proto__`（逐键赋值会让它凭空消失）', () => {
    expect(Object.keys(node.env as Record<string, unknown>).sort()).toEqual([
      'API_KEY',
      '__proto__',
    ])
  })

  it('依赖数组长度保留（画布卡片显示的是个数）', () => {
    const many = redactPrivilegedNodes(
      definitionOf([scriptNode({ dependencies: ['a==1', 'b==2', 'c==3'] })]),
      OPAQUE,
      MARKER,
    )
    expect(nodeById(many, 'sc1').dependencies).toEqual([MARKER, MARKER, MARKER])
  })

  it('枚举与结构字段不遮：language / network / readonly / outputs / title', () => {
    expect(node.language).toBe('python')
    expect(node.network).toBe('deny')
    expect(node.readonly).toBe(true)
    expect(node.outputs).toEqual([{ name: 'score', kind: 'number' }])
    expect(node.title).toBe('打分')
  })

  it('空正文保持空 —— 不制造也不掩盖 script-body-empty', () => {
    const empty = redactPrivilegedNodes(definitionOf([scriptNode({ script: '' })]), OPAQUE, MARKER)
    expect(nodeById(empty, 'sc1').script).toBe('')
  })

  it('脱敏后仍能通过 ScriptNodeSchema 严格解析（不遮枚举这条约束的守门人）', () => {
    expect(ScriptNodeSchema.safeParse(node).success).toBe(true)
  })
})

describe('RFC-270 · 代码平台调用节点脱敏', () => {
  const out = redactPrivilegedNodes(definitionOf([codeHostNode()]), OPAQUE, MARKER)
  const node = nodeById(out, 'ch1')
  const request = node.request as Record<string, unknown>

  it('params 值 / request.path / request.body / request.query 值被遮，键存活', () => {
    expect(node.params).toEqual({ project: MARKER, body: MARKER })
    expect(request.path).toBe(MARKER)
    expect(request.body).toBe(MARKER)
    expect(request.query).toEqual({ per_page: MARKER })
  })

  it('枚举与判据字段不遮：provider / action / method / allowDestructive / timeoutMs', () => {
    expect(node.provider).toBe('gitlab')
    expect(node.action).toBe('custom')
    expect(request.method).toBe('POST')
    expect(node.allowDestructive).toBe(false)
    expect(node.timeoutMs).toBe(30_000)
  })

  it('空 body 保持空（codeHostJsonBodyIssue 明确放行空 body）', () => {
    const emptyBody = redactPrivilegedNodes(
      definitionOf([codeHostNode({ request: { method: 'GET', path: '/api/v4/x', body: '' } })]),
      OPAQUE,
      MARKER,
    )
    expect((nodeById(emptyBody, 'ch1').request as Record<string, unknown>).body).toBe('')
  })

  it('没有 request 的预置动作节点只遮 params', () => {
    const preset = redactPrivilegedNodes(
      definitionOf([codeHostNode({ action: 'comment.reply-thread', request: undefined })]),
      OPAQUE,
      MARKER,
    )
    const presetNode = nodeById(preset, 'ch1')
    expect(presetNode.params).toEqual({ project: MARKER, body: MARKER })
    expect(presetNode.request).toBeUndefined()
  })

  it('脱敏后仍能通过 CodeHostCallNodeSchema 严格解析', () => {
    expect(CodeHostCallNodeSchema.safeParse(node).success).toBe(true)
  })
})

describe('RFC-270 · 回填', () => {
  it('镜头为遮时，客户端发什么都被库值覆盖', () => {
    const stored = definitionOf([scriptNode(), codeHostNode()])
    const submitted = definitionOf([
      scriptNode({ script: 'rm -rf /', env: { EVIL: '1' }, dependencies: ['evil==9'] }),
      codeHostNode({ params: { project: 'attacker/repo' } }),
    ])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect(nodeById(out, 'sc1').script).toBe(nodeById(stored, 'sc1').script)
    expect(nodeById(out, 'sc1').env).toEqual(nodeById(stored, 'sc1').env)
    expect(nodeById(out, 'sc1').dependencies).toEqual(nodeById(stored, 'sc1').dependencies)
    expect(nodeById(out, 'ch1').params).toEqual(nodeById(stored, 'ch1').params)
  })

  it('镜头透明时一个字节都不碰 —— 作者真把正文写成 `***` 也照写（AC-8）', () => {
    const stored = definitionOf([scriptNode()])
    const submitted = definitionOf([scriptNode({ script: MARKER })])
    const out = rehydratePrivilegedNodes(submitted, stored, PRIVILEGED_LENS_TRANSPARENT)
    expect(nodeById(out, 'sc1').script).toBe(MARKER)
  })

  it('不做值嗅探：镜头为遮时连库里就是 `***` 的情况也照回填', () => {
    const stored = definitionOf([scriptNode({ script: MARKER })])
    const submitted = definitionOf([scriptNode({ script: 'print(1)' })])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect(nodeById(out, 'sc1').script).toBe(MARKER)
  })

  it('库里没有该字段时把客户端带来的那个删掉（与库对齐）', () => {
    const stored = definitionOf([scriptNode({ dependencies: undefined })])
    const submitted = definitionOf([scriptNode({ dependencies: ['smuggled==1'] })])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect('dependencies' in nodeById(out, 'sc1')).toBe(false)
  })

  it('新增的特权节点不回填（留给 author 门去拒）', () => {
    const stored = definitionOf([])
    const submitted = definitionOf([scriptNode({ script: 'print(1)' })])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect(nodeById(out, 'sc1').script).toBe('print(1)')
  })

  it('同 id 但 kind 变了不回填（那是换了一个节点，不是同一个）', () => {
    const stored = definitionOf([{ id: 'sc1', kind: 'agent-single', agentId: 'ag1' }])
    const submitted = definitionOf([scriptNode({ script: 'print(1)' })])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect(nodeById(out, 'sc1').script).toBe('print(1)')
  })

  it('非特权节点的改动原样保留（无权限用户仍然能编辑工作流的其余部分）', () => {
    const agent = { id: 'a1', kind: 'agent-single', agentId: 'ag1', title: '旧' }
    const stored = definitionOf([scriptNode(), agent])
    const submitted = definitionOf([scriptNode(), { ...agent, title: '新' }])
    const out = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    expect(nodeById(out, 'a1').title).toBe('新')
  })

  it('无实际差异时返回同一个引用', () => {
    const stored = definitionOf([scriptNode()])
    expect(rehydratePrivilegedNodes(stored, stored, OPAQUE)).toBe(stored)
  })
})

// Codex 实现门 P2 —— 两条都是「形状不合预期时要 fail closed / 不折叠」。
describe('RFC-270 · 畸形输入 fail closed（Codex 实现门 P2）', () => {
  // 保存路径用的是宽松的 `WorkflowNodeSchema`（passthrough），严格 schema 只在
  // 校验器里跑，所以库里可以躺着这些形状。只处理「plain object + string」
  // 等于对畸形值开口子，而 author 门把整个 request 都当敏感。
  it('request 不是对象时整体遮掉，不原样透出', () => {
    const out = redactPrivilegedNodes(
      definitionOf([codeHostNode({ request: '/api/v4/secret/path' })]),
      OPAQUE,
      MARKER,
    )
    expect(nodeById(out, 'ch1').request).toBe(MARKER)
  })

  it('path / body 不是字符串时同样遮', () => {
    const out = redactPrivilegedNodes(
      definitionOf([
        codeHostNode({ request: { method: 'POST', path: 12345, body: { secret: 1 } } }),
      ]),
      OPAQUE,
      MARKER,
    )
    const request = nodeById(out, 'ch1').request as Record<string, unknown>
    expect(request.path).toBe(MARKER)
    expect(request.body).toBe(MARKER)
    expect(request.method).toBe('POST')
  })

  it('params / query 不是对象时整体遮', () => {
    const out = redactPrivilegedNodes(
      definitionOf([
        codeHostNode({ params: 'grp/app', request: { method: 'GET', path: '/x', query: 'a=1' } }),
      ]),
      OPAQUE,
      MARKER,
    )
    expect(nodeById(out, 'ch1').params).toBe(MARKER)
    expect((nodeById(out, 'ch1').request as Record<string, unknown>).query).toBe(MARKER)
  })

  it('同 id 的两个特权节点按出现顺序一一配对，不被折叠', () => {
    // 折叠成 `new Map(id → node)` 的话，两个节点都会拿到**最后**那份正文，
    // 敏感投影被回填自己改掉 —— 用户一个特权字段没碰却吃 403。
    const stored = definitionOf([
      scriptNode({ id: 'dup', script: 'print("first")' }),
      scriptNode({ id: 'dup', script: 'print("second")' }),
    ])
    const submitted = redactPrivilegedNodes(stored, OPAQUE, MARKER) as WorkflowDefinition
    const restored = rehydratePrivilegedNodes(submitted, stored, OPAQUE)
    const bodies = restored.nodes.map((node) => (node as unknown as Record<string, unknown>).script)
    expect(bodies).toEqual(['print("first")', 'print("second")'])
    expect(serializeScriptSensitiveProjectionV1(restored)).toBe(
      serializeScriptSensitiveProjectionV1(stored),
    )
  })
})

// Codex 实现门 P2 —— 画布的中央守卫判据。它是「本地就拒绝」而不是「保存时 403」
// 的承重件，且必须与后端 author 门**逐字同源**，否则会漂移出「前台放行、后端
// 403」或「前台拦死、后端本来允许」两种坏组合。
describe('RFC-270 · privilegedProjectionChange（中央守卫判据）', () => {
  const script = () => scriptNode({ id: 's1' })
  const base = definitionOf([script(), { id: 'a1', kind: 'agent-single', agentId: 'ag1' }])

  it('镜头透明时永远放行（有权限用户行为一字不变）', () => {
    const next = definitionOf([{ id: 'a1', kind: 'agent-single', agentId: 'ag1' }])
    expect(privilegedProjectionChange(base, next, PRIVILEGED_LENS_TRANSPARENT)).toBeNull()
  })

  it('删除脚本节点 → 拦', () => {
    const next = definitionOf([{ id: 'a1', kind: 'agent-single', agentId: 'ag1' }])
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBe('script')
  })

  it('新增脚本节点（复制 / 粘贴 / 再来一个）→ 拦', () => {
    const next = definitionOf([
      script(),
      scriptNode({ id: 's2' }),
      { id: 'a1', kind: 'agent-single' },
    ])
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBe('script')
  })

  it('改脚本节点的入边（EdgeInspector 重连 / 改端口名）→ 拦', () => {
    const next: WorkflowDefinition = {
      ...base,
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a1', portName: 'out' },
          target: { nodeId: 's1', portName: 'diff' },
        },
      ] as unknown as WorkflowDefinition['edges'],
    }
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBe('script')
  })

  it('把脚本节点包进 wrapper（wrapSelection）→ 拦', () => {
    const next = definitionOf([
      script(),
      { id: 'a1', kind: 'agent-single', agentId: 'ag1' },
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 50 },
    ])
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBe('script')
  })

  it('挪位置 / 改标题 → 放行（门明确允许，拦了就是 over-block）', () => {
    const next = definitionOf([
      scriptNode({ id: 's1', position: { x: 999, y: 999 }, title: '改名了' }),
      { id: 'a1', kind: 'agent-single', agentId: 'ag1' },
    ])
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBeNull()
  })

  it('只改无关节点 → 放行', () => {
    const next = definitionOf([script(), { id: 'a1', kind: 'agent-single', agentId: 'ag2' }])
    expect(privilegedProjectionChange(base, next, OPAQUE)).toBeNull()
  })

  it('镜头分家：只缺 code-host 权限时，改脚本不拦、改调用节点拦', () => {
    const codeHostOnly: PrivilegedNodeLens = { scripts: false, codeHost: true }
    const withCall = definitionOf([script(), codeHostNode()])
    const removedScript = definitionOf([codeHostNode()])
    expect(privilegedProjectionChange(withCall, removedScript, codeHostOnly)).toBeNull()
    const removedCall = definitionOf([script()])
    expect(privilegedProjectionChange(withCall, removedCall, codeHostOnly)).toBe('code-host-call')
  })

  it('两边都没有特权节点时零成本放行', () => {
    const a = definitionOf([{ id: 'a1', kind: 'agent-single', agentId: 'ag1' }])
    const b = definitionOf([{ id: 'a1', kind: 'agent-single', agentId: 'ag2' }])
    expect(privilegedProjectionChange(a, b, OPAQUE)).toBeNull()
  })
})

describe('RFC-270 · 脱敏∘回填不变式（脱敏与回填成对的守门人）', () => {
  // 这条一红，说明 SCRIPT_REDACTED_FIELDS / CODE_HOST_REDACTED_FIELDS 与遮蔽
  // 实现漂移了：有字段被遮了却回填不回来（= 保存时静默丢数据），或者被回填了
  // 却根本没遮（= 白遮一场）。
  const stored = definitionOf([scriptNode(), codeHostNode()])
  const redacted = redactPrivilegedNodes(stored, OPAQUE, MARKER)
  const restored = rehydratePrivilegedNodes(redacted, stored, OPAQUE)

  it('脚本门的敏感投影一字不变', () => {
    expect(serializeScriptSensitiveProjectionV1(restored)).toBe(
      serializeScriptSensitiveProjectionV1(stored),
    )
  })

  it('代码平台门的敏感投影一字不变', () => {
    expect(serializeCodeHostSensitiveProjectionV1(restored)).toBe(
      serializeCodeHostSensitiveProjectionV1(stored),
    )
  })

  it('脱敏本身确实改变了两个投影（否则上面两条是空断言）', () => {
    expect(serializeScriptSensitiveProjectionV1(redacted)).not.toBe(
      serializeScriptSensitiveProjectionV1(stored),
    )
    expect(serializeCodeHostSensitiveProjectionV1(redacted)).not.toBe(
      serializeCodeHostSensitiveProjectionV1(stored),
    )
  })

  it('字段清单本身不为空（清单被清空会让上面全部变成空断言）', () => {
    expect(SCRIPT_REDACTED_FIELDS.length).toBeGreaterThan(0)
    expect(CODE_HOST_REDACTED_FIELDS.length).toBeGreaterThan(0)
  })
})
