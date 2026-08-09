// RFC-270 §7 — 特权节点读镜头：无 `scripts:author` / `code-host-calls:author`
// 的调用方拿不到脚本正文与代码平台请求模板。
//
// 为什么这条不能只在前台做：`GET /api/workflows/:id` 今天把脚本正文、`env`、
// 依赖、代码平台的 path/body/params 原样返回，任何能看见该工作流的用户 devtools
// 一开就有；同一批字节还随 `tasks.workflowSnapshot` 出现在每个任务详情里，并且
// **比工作流本身活得更久**（工作流被改被删之后快照仍然作答）。
//
// 三条性质分开锁：
//   1. 两条轴（PAT 通道 / 创作权限）正交且叠加，谁都不能吞掉谁；
//   2. 出口是**全部**出口 —— 漏一个就等于没做，所以有一条按源码枚举的接线断言；
//   3. `/ws/workflows` 帧里没有 definition，所以不需要镜头 —— 这个前提本身被钉住，
//      将来谁往帧里加 definition 会在这里红。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WorkflowsWsMessageSchema,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { buildActor, type Actor } from '@/auth/actor'
import {
  REDACTED,
  serializeTaskFor,
  serializeWorkflowFor,
  serializeWorkflowReceiptFor,
  workflowReadLensFor,
} from '@/services/tokenRedaction'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'

const SCRIPT_BODY = 'import os\nprint(os.environ["AW_PORT_DIFF"])\n'

function actorOfRole(role: 'admin' | 'manager' | 'user', source: 'session' | 'pat' = 'session') {
  return buildActor({
    source,
    user: { id: `u-${role}`, username: role, displayName: role, role, status: 'active' },
    ...(source === 'pat' ? { patScopes: [], patPurpose: 'mcp_only' as const } : {}),
  })
}

function definition(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'context' },
      {
        id: 's1',
        kind: 'script',
        language: 'python',
        script: SCRIPT_BODY,
        dependencies: ['requests==2.31.0'],
        env: { API_TOKEN: 'sk-live-scriptenv', LOG_LEVEL: 'debug' },
        network: 'deny',
        readonly: true,
      },
      {
        id: 'c1',
        kind: 'code-host-call',
        provider: 'gitlab',
        action: 'custom',
        params: { project: 'grp/app' },
        request: {
          method: 'POST',
          path: '/api/v4/projects/1/merge_requests/2/notes',
          body: '{"body":"done"}',
        },
      },
    ] as unknown as WorkflowNode[],
    edges: [],
  }
}

function nodeOf(def: unknown, id: string): Record<string, unknown> {
  const nodes = (def as { nodes: Array<Record<string, unknown>> }).nodes
  const found = nodes.find((node) => node.id === id)
  if (found === undefined) throw new Error(`no node ${id}`)
  return found
}

function readWorkflowThrough(actor: Actor): unknown {
  return serializeWorkflowFor({ id: 'w1', definition: definition() }, workflowReadLensFor(actor))
    .definition
}

describe('RFC-270 · 镜头由 permissions 推出', () => {
  test('admin / manager 透明；plain user 两项全遮', () => {
    expect(privilegedNodeLensFor(actorOfRole('admin'))).toEqual({ scripts: false, codeHost: false })
    expect(privilegedNodeLensFor(actorOfRole('manager'))).toEqual({
      scripts: false,
      codeHost: false,
    })
    expect(privilegedNodeLensFor(actorOfRole('user'))).toEqual({ scripts: true, codeHost: true })
  })

  test('PAT 永远两项全遮 —— 两个点都是系统域，任何令牌都拿不到', () => {
    // 这条把「令牌通道」与「创作权限」的交叉情形钉死：即便持有者是 admin，
    // 令牌本身也不该能读出宿主要执行的代码。
    expect(privilegedNodeLensFor(actorOfRole('admin', 'pat'))).toEqual({
      scripts: true,
      codeHost: true,
    })
  })

  test('镜头判据与 author 门读的是同一个集合（能写的一定能看）', () => {
    for (const role of ['admin', 'manager', 'user'] as const) {
      const actor = actorOfRole(role)
      expect(privilegedNodeLensFor(actor).scripts).toBe(!actor.permissions.has('scripts:author'))
      expect(privilegedNodeLensFor(actor).codeHost).toBe(
        !actor.permissions.has('code-host-calls:author'),
      )
    }
  })
})

describe('RFC-270 AC-1 / AC-2 · 工作流读出口', () => {
  test('plain user 拿到的脚本节点：正文 / env 值 / 依赖全部是 ***', () => {
    const script = nodeOf(readWorkflowThrough(actorOfRole('user')), 's1')
    expect(script.script).toBe(REDACTED)
    expect(script.env).toEqual({ API_TOKEN: REDACTED, LOG_LEVEL: REDACTED })
    expect(script.dependencies).toEqual([REDACTED])
  })

  test('plain user 拿到的代码平台节点：params / path / body 全部是 ***', () => {
    const call = nodeOf(readWorkflowThrough(actorOfRole('user')), 'c1')
    expect(call.params).toEqual({ project: REDACTED })
    expect((call.request as Record<string, unknown>).path).toBe(REDACTED)
    expect((call.request as Record<string, unknown>).body).toBe(REDACTED)
  })

  test('AC-3 结构字段留着：图仍然可读、schema 仍然解析得过', () => {
    const def = readWorkflowThrough(actorOfRole('user'))
    const script = nodeOf(def, 's1')
    const call = nodeOf(def, 'c1')
    expect(script.language).toBe('python')
    expect(script.network).toBe('deny')
    expect(script.readonly).toBe(true)
    expect(call.provider).toBe('gitlab')
    expect(call.action).toBe('custom')
    expect((call.request as Record<string, unknown>).method).toBe('POST')
    // 非特权节点原样透传
    expect(nodeOf(def, 'in1').inputKey).toBe('context')
  })

  test('admin 拿到明文', () => {
    const def = readWorkflowThrough(actorOfRole('admin'))
    expect(nodeOf(def, 's1').script).toBe(SCRIPT_BODY)
    expect(nodeOf(def, 'c1').params).toEqual({ project: 'grp/app' })
  })

  test('manager 拿到明文（两点都在 MANAGER_EXTRA 里）', () => {
    const def = readWorkflowThrough(actorOfRole('manager'))
    expect(nodeOf(def, 's1').script).toBe(SCRIPT_BODY)
    expect(nodeOf(def, 'c1').request).toEqual({
      method: 'POST',
      path: '/api/v4/projects/1/merge_requests/2/notes',
      body: '{"body":"done"}',
    })
  })

  test('AC-5 双轴叠加：admin 的 PAT 既吃通道轴也吃权限轴，env 仍是 ***', () => {
    const def = readWorkflowThrough(actorOfRole('admin', 'pat'))
    expect(nodeOf(def, 's1').env).toEqual({ API_TOKEN: REDACTED, LOG_LEVEL: REDACTED })
    expect(nodeOf(def, 's1').script).toBe(REDACTED)
  })

  test('输入记录不被就地修改', () => {
    const record = { id: 'w1', definition: definition() }
    serializeWorkflowFor(record, workflowReadLensFor(actorOfRole('user')))
    expect(nodeOf(record.definition, 's1').script).toBe(SCRIPT_BODY)
  })
})

describe('RFC-270 AC-4 · 回执与任务快照', () => {
  test('保存回执里的定义同样被遮', () => {
    const receipt = {
      clientMutationId: 'm1',
      snapshot: { name: 'w', description: '', definition: definition() },
    }
    const out = serializeWorkflowReceiptFor(receipt, workflowReadLensFor(actorOfRole('user')))
    expect(nodeOf(out.snapshot.definition, 's1').script).toBe(REDACTED)
    expect(out.clientMutationId).toBe('m1')
  })

  test('任务的冻结快照同样被遮（它比工作流活得更久）', () => {
    const task = {
      id: 't1',
      workflowSnapshot: definition(),
      status: 'done',
    } as unknown as Parameters<typeof serializeTaskFor>[0]
    const out = serializeTaskFor(task, workflowReadLensFor(actorOfRole('user')))
    expect(nodeOf(out.workflowSnapshot, 's1').script).toBe(REDACTED)
    expect(nodeOf(out.workflowSnapshot, 'c1').params).toEqual({ project: REDACTED })
    expect((out as unknown as { status: string }).status).toBe('done')
  })

  test('admin 的任务快照不被遮，且是同一个引用', () => {
    const task = { id: 't1', workflowSnapshot: definition() } as unknown as Parameters<
      typeof serializeTaskFor
    >[0]
    expect(serializeTaskFor(task, workflowReadLensFor(actorOfRole('admin')))).toBe(task)
  })
})

describe('RFC-270 · 接线：每个定义出口都过镜头', () => {
  const src = (file: string): string =>
    readFileSync(resolve(import.meta.dir, '..', 'src', file), 'utf8')

  test('routes/workflows.ts 的每次 serialize 调用都传 workflowReadLensFor', () => {
    const routes = src('routes/workflows.ts')
    const calls = routes.match(/serializeWorkflow(?:Receipt)?For\(/g) ?? []
    // RFC-271 C1/C2 显式改判：8 → 5。YAML 导出与导入两条端点下线，随之少掉三个
    // 出口（export 的 record、import 的 created record 与 overwritten receipt）。
    // **守卫的意图一字未改**：每一个把定义交出去的出口都必须过镜头，少传一次就是
    // 一条未经权限裁剪的通道。数字下调是因为出口真的少了，不是要求放宽了。
    // 列表 / 详情 / create / copy / PUT 回执。
    expect(calls.length).toBe(5)
    // 旧的单轴形参一个都不许残留 —— 它现在编译不过，这条是给「有人把签名改回去」
    // 留的可读信号。
    expect(routes).not.toContain('actor.source)')
    expect(routes).not.toContain('actorOf(c).source)')
    const lensCalls = routes.match(/workflowReadLensFor\(/g) ?? []
    expect(lensCalls.length).toBe(calls.length)
  })

  test('routes/tasks.ts 的每次 serializeTaskFor 都传 workflowReadLensFor', () => {
    const routes = src('routes/tasks.ts')
    const calls =
      routes.match(/serializeTaskFor\(\w+, workflowReadLensFor\(actorOf\(c\)\)\)/g) ?? []
    // get + create(multipart) + create + cancel + resume + retry + sync
    expect(calls.length).toBe(7)
    // 没有任何一处 serializeTaskFor 走别的形参形态（漏一个出口 = 没做遮蔽）。
    expect(routes.match(/serializeTaskFor\(/g)?.length).toBe(calls.length)
  })

  test('两个 author 门与镜头共用同一个权限点字符串', () => {
    expect(src('services/privilegedNodeLens.ts')).toContain("'scripts:author'")
    expect(src('services/privilegedNodeLens.ts')).toContain("'code-host-calls:author'")
    expect(src('services/scriptAuthorGate.ts')).toContain("'scripts:author'")
    expect(src('services/codeHostAuthorGate.ts')).toContain("'code-host-calls:author'")
  })
})

describe('RFC-270 · /ws/workflows 帧不带 definition（所以不需要镜头）', () => {
  test('三种帧的字段里没有 definition / snapshot', () => {
    // 这条钉的是一个**前提**：WS 侧之所以不做遮蔽，是因为帧里根本没有定义。
    // 将来谁往帧里加 definition，必须先来这里改断言，从而被迫想起镜头。
    const keys = new Set<string>()
    for (const option of WorkflowsWsMessageSchema.options) {
      for (const key of Object.keys(option.shape)) keys.add(key)
    }
    expect(keys.has('definition')).toBe(false)
    expect(keys.has('snapshot')).toBe(false)
    expect(keys.has('workflowId')).toBe(true)
  })
})
