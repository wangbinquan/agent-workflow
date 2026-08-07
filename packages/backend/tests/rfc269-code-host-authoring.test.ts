// RFC-269 — 保存期的两道门：静态校验规则与 `code-host-calls:author` 权限门。
//
// 校验规则全部 fail closed：一个执行器无法兑现的组合要在保存时被拒，而不是
// 半夜对着真实 GitLab 才炸。权限门锁的是「谁能决定平台以管理员 token 发出
// 什么请求」——平台侧 ACL 约束不了这个节点能碰到的仓库，所以它是能力点而不是
// 普通编辑。

import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { serializeCodeHostSensitiveProjectionV1 } from '@agent-workflow/shared'
import { validateWorkflowDefinition } from '@/services/workflow.validator'
import { assertCodeHostAuthorAllowed } from '@/services/codeHostAuthorGate'
import type { Actor } from '@/auth/actor'

function codesFor(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): string[] {
  const definition: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges }
  return validateWorkflowDefinition(definition, { agents: [], skills: [] }).issues.map(
    (i) => i.code,
  )
}

function call(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'ch1',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.create',
    params: { mr: '1', body: 'hi' },
    ...extra,
  } as WorkflowNode
}

describe('RFC-269 校验规则', () => {
  test('合法节点无 code-host 相关 issue', () => {
    expect(codesFor([call()]).filter((c) => c.startsWith('code-host'))).toEqual([])
  })

  test('R1 provider 非法', () => {
    expect(codesFor([call({ provider: 'gitea' })])).toContain('code-host-provider-invalid')
  })

  test('R2 未知动作 / 该 provider 不支持的动作', () => {
    expect(codesFor([call({ action: 'comment.nope' })])).toContain('code-host-action-invalid')
    expect(
      codesFor([call({ provider: 'github', action: 'thread.resolve', params: { mr: '1' } })]),
    ).toContain('code-host-action-unsupported')
  })

  test('R3 必填字段为空', () => {
    expect(codesFor([call({ params: { mr: '1' } })])).toContain('code-host-param-missing')
  })

  test('R9 枚举字段的字面量非法值被拒；含 {{ 的值放到运行期判', () => {
    const literal = call({
      action: 'commit-status.set',
      params: { sha: 'a', state: 'exploded' },
    })
    expect(codesFor([literal])).toContain('code-host-param-invalid')
    const templated = call({
      action: 'commit-status.set',
      params: { sha: 'a', state: '{{verdict}}' },
    })
    // 用户故事 2 要的就是 state 来自上游端口 —— 保存期不能因此变红。
    expect(codesFor([templated])).not.toContain('code-host-param-invalid')
  })

  test('R4 DELETE 需要显式勾选破坏性方法', () => {
    const node = call({
      action: 'custom',
      params: {},
      request: { method: 'DELETE', path: '/projects/1/notes/2' },
    })
    expect(codesFor([node])).toContain('code-host-method-forbidden')
    expect(
      codesFor([call({ ...node, allowDestructive: true } as Record<string, unknown>)]),
    ).not.toContain('code-host-method-forbidden')
  })

  test('R5 path 逃逸被拒', () => {
    for (const path of ['/../../admin', 'https://evil.example/x', '//evil.example/x', 'rel']) {
      const node = call({ action: 'custom', params: {}, request: { method: 'GET', path } })
      expect(codesFor([node])).toContain('code-host-path-invalid')
    }
  })

  test('R6 body 里变量落在字符串外被拒，并指出是哪个变量', () => {
    const node = call({
      action: 'custom',
      params: {},
      request: { method: 'POST', path: '/x', body: '{"n": {{count}}}' },
    })
    const issues = validateWorkflowDefinition(
      { $schema_version: 4, inputs: [], nodes: [node], edges: [] },
      { agents: [], skills: [] },
    ).issues
    const hit = issues.find((i) => i.code === 'code-host-body-invalid')
    expect(hit).toBeDefined()
    expect(hit!.message).toContain('count')
  })

  test('R8 未知端口变量与未知 trigger 变量都被拒', () => {
    expect(codesFor([call({ params: { mr: '1', body: '{{nosuchport}}' } })])).toContain(
      'code-host-var-unknown',
    )
    expect(codesFor([call({ params: { mr: '1', body: '{{trigger.nope}}' } })])).toContain(
      'code-host-var-unknown',
    )
    // 合法的 trigger 变量不报
    expect(codesFor([call({ params: { mr: '{{trigger.mr_iid}}', body: 'x' } })])).not.toContain(
      'code-host-var-unknown',
    )
  })

  test('**不**校验多仓与「工作流是否真有触发器」（design D24 与仓数是启动参数）', () => {
    // project 留空是常态（Q11 的默认行为），保存期不该因此报错。
    expect(codesFor([call()]).filter((c) => c.startsWith('code-host'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------

const ACTOR = (perms: string[]): Actor =>
  ({
    user: { id: 'u1', username: 'u', displayName: 'u', role: 'user', status: 'active' },
    source: 'session',
    permissions: new Set(perms),
  }) as unknown as Actor

const WITH_POINT = ACTOR(['code-host-calls:author'])
const WITHOUT_POINT = ACTOR([])

function def(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges }
}

describe('RFC-269 权限门', () => {
  test('无该权限不能新建含调用节点的工作流', () => {
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: def([call()]),
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).toThrow(/code-host-calls:author/)
  })

  test('有该权限可以', () => {
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: def([call()]),
        principal: { kind: 'actor', actor: WITH_POINT },
      }),
    ).not.toThrow()
  })

  test('不改敏感投影时任何人都能编辑（移动节点 / 改标题）', () => {
    const previous = def([call()])
    const moved = def([call({ position: { x: 10, y: 20 }, title: '回帖' })])
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: moved,
        previous,
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).not.toThrow()
  })

  test('改参数 = 改了会发出去的东西 ⇒ 要点', () => {
    const previous = def([call()])
    const edited = def([call({ params: { mr: '1', body: 'DIFFERENT' } })])
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: edited,
        previous,
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).toThrow()
  })

  test('改入边 = 改了回帖正文来源 ⇒ 要点（节点自身一字未动）', () => {
    const node = call({ params: { mr: '1', body: '{{verdict}}' } })
    const previous = def(
      [node],
      [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'ch1', portName: 'verdict' },
        },
      ],
    )
    const rewired = def(
      [node],
      [
        {
          id: 'e1',
          source: { nodeId: 'b', portName: 'other' },
          target: { nodeId: 'ch1', portName: 'verdict' },
        },
      ],
    )
    expect(serializeCodeHostSensitiveProjectionV1(previous)).not.toBe(
      serializeCodeHostSensitiveProjectionV1(rewired),
    )
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: rewired,
        previous,
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).toThrow()
  })

  test('挪进 50 次的循环 = 回 50 条帖 ⇒ 要点（含传递归属）', () => {
    const node = call()
    const previous = def([node])
    const looped = def([
      node,
      { id: 'loop1', kind: 'wrapper-loop', nodeIds: ['ch1'], maxIterations: 50 } as WorkflowNode,
    ])
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: looped,
        previous,
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).toThrow()
  })

  test('verbatim-copy 与 system 放行（RFC-231 复制的是已通过门的内容）', () => {
    for (const principal of [
      { kind: 'verbatim-copy' as const },
      { kind: 'system' as const, reason: 'seed' },
    ]) {
      expect(() => assertCodeHostAuthorAllowed({ next: def([call()]), principal })).not.toThrow()
    }
  })

  test('不含调用节点的工作流零成本放行', () => {
    expect(() =>
      assertCodeHostAuthorAllowed({
        next: def([{ id: 'i1', kind: 'input', inputKey: 'topic' } as WorkflowNode]),
        principal: { kind: 'actor', actor: WITHOUT_POINT },
      }),
    ).not.toThrow()
  })
})
