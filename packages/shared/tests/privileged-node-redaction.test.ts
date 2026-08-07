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
