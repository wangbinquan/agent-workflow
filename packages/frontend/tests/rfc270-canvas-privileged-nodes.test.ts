// RFC-270 AC-14 / AC-15 — 画布上的特权节点保护。
//
// 用户实报的第五条：「一旦一个工作流里有一个脚本节点，这个工作流就会变成权限
// 异常。」触发它的动作可能只是**拖了一下节点** —— drag-stop 会按几何重算 wrapper
// 归属并改写 `nodeIds`，而归属正在两个 author 门的敏感投影里。那与
// `scriptAuthorGate.ts` 开头写下的承诺（「无权限的作者仍然可以移动脚本节点」）
// 直接矛盾。
//
// 修法是把能触发那次 403 的路径**在画布上全部封死**：节点不可拖、不可删、边不可
// 增删、拖 wrapper 不许改变受保护节点的传递归属。本文件锁这四条。

import { describe, expect, test } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { ancestryUnchanged, type WorkflowDefinition } from '@agent-workflow/shared'
import {
  lockPrivilegedFlowNodes,
  lockPrivilegedFlowEdges,
} from '../src/components/canvas/WorkflowCanvas'

const nodes: Node[] = [
  { id: 'a1', type: 'agent-single', position: { x: 0, y: 0 }, data: {} },
  { id: 's1', type: 'script', position: { x: 100, y: 0 }, data: {} },
  { id: 'c1', type: 'code-host-call', position: { x: 200, y: 0 }, data: {} },
]

const edges: Edge[] = [
  { id: 'e-a-s', source: 'a1', target: 's1' },
  { id: 'e-s-c', source: 's1', target: 'c1' },
  { id: 'e-a-a', source: 'a1', target: 'a2' },
]

describe('RFC-270 AC-14 · 受保护节点不可拖、不可删', () => {
  test('只锁点名的节点，其余原样', () => {
    const locked = lockPrivilegedFlowNodes(nodes, new Set(['s1', 'c1']))
    const byId = new Map(locked.map((n) => [n.id, n]))
    expect(byId.get('s1')?.draggable).toBe(false)
    expect(byId.get('s1')?.deletable).toBe(false)
    expect(byId.get('c1')?.draggable).toBe(false)
    expect(byId.get('a1')?.draggable).toBeUndefined()
    expect(byId.get('a1')?.deletable).toBeUndefined()
  })

  test('空集合返回同一个引用（有权限用户零开销、memo 不失效）', () => {
    expect(lockPrivilegedFlowNodes(nodes, new Set())).toBe(nodes)
    expect(lockPrivilegedFlowEdges(edges, new Set())).toBe(edges)
  })

  test('不就地修改输入（xyflow 的节点数组是共享状态）', () => {
    lockPrivilegedFlowNodes(nodes, new Set(['s1']))
    expect(nodes[1]?.draggable).toBeUndefined()
  })
})

describe('RFC-270 AC-14 · 指向受保护节点的入边不可删', () => {
  test('只锁入边 —— 判据与门一致，不多锁一分', () => {
    const locked = lockPrivilegedFlowEdges(edges, new Set(['s1']))
    const byId = new Map(locked.map((e) => [e.id, e]))
    // 入边决定 `AW_PORT_*` 取到什么 —— 拆掉它就是改了脚本实际执行的内容。
    expect(byId.get('e-a-s')?.deletable).toBe(false)
    // **出边不锁**：`inboundEdgeSignature` 只看 `edge.target.nodeId`，从脚本连出去
    // 不改变它自己的投影。锁了就是拿走一个 proposal §5 C6 从没声称、后端也一直
    // 接受的能力。这条反例是防止「顺手改宽一点更安全」的回归。
    expect(byId.get('e-s-c')?.deletable).toBeUndefined()
    expect(byId.get('e-a-a')?.deletable).toBeUndefined()
  })

  test('目标是受保护节点时才锁，与 source 无关', () => {
    const locked = lockPrivilegedFlowEdges(edges, new Set(['c1']))
    const byId = new Map(locked.map((e) => [e.id, e]))
    expect(byId.get('e-s-c')?.deletable).toBe(false)
    expect(byId.get('e-a-s')?.deletable).toBeUndefined()
  })
})

describe('RFC-270 AC-15 · wrapper 归属守卫', () => {
  const def = (nodesIn: Array<Record<string, unknown>>): WorkflowDefinition =>
    ({
      $schema_version: 4,
      inputs: [],
      nodes: nodesIn,
      edges: [],
    }) as unknown as WorkflowDefinition

  const script = { id: 's1', kind: 'script', language: 'python', script: 'print(1)' }

  test('纯位置变化通过（这正是 gate 承诺允许、今天却会 403 的那一类）', () => {
    const before = def([
      { ...script, position: { x: 0, y: 0 } },
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'] },
    ])
    const after = def([
      { ...script, position: { x: 500, y: 300 } },
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'] },
    ])
    expect(ancestryUnchanged(before, after, new Set(['s1']))).toBe(true)
  })

  test('拖动外层 wrapper 把内层整个包进去 → 守卫拦下（传递归属）', () => {
    const before = def([
      script,
      { id: 'inner', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 1 },
      { id: 'outer', kind: 'wrapper-loop', nodeIds: [], maxIterations: 50 },
    ])
    const after = def([
      script,
      { id: 'inner', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 1 },
      { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'], maxIterations: 50 },
    ])
    expect(ancestryUnchanged(before, after, new Set(['s1']))).toBe(false)
  })

  test('无受保护节点时守卫从不拦（有权限用户行为一字不变）', () => {
    const before = def([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: [] }])
    const after = def([script, { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'] }])
    expect(ancestryUnchanged(before, after, new Set())).toBe(true)
  })
})
