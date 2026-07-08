// flag-audit W0（design/flag-audit-2026-07-07.md §3-3/§3-4）—— loop 候选端口推导
// 对 review 节点的两处漂移 bug 的回归锁（先红后绿）：
//
//   bug A（§3-3，真实用户可见）：deriveOutputPorts 对 review 返回 ['output']——
//     该端口根本不存在。权威实现（WorkflowCanvas.computePorts）是
//     reviewApprovedPortName(inputKind) + 'approval_meta'，于是 loop Inspector 的
//     exitCondition / outputBindings 下拉向用户提供假端口、且选不到真端口。
//   bug B（§3-4，死分支）：deriveTitle 读 rec.source——schema 字段实为
//     inputSource（shared/schemas/review.ts），`review:${port}` 标题分支永不可达。
//
// 修复方向 = 与 computePorts 同源：按 inputSource → 源 agent.outputKinds 解析
// 输入 kind，交给 shared 的 reviewApprovedPortName oracle。

import { describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { loopMemberCandidates } from '../src/components/canvas/wrapperCandidates'

// RFC-146: loopMemberCandidates 签名改吃 WorkflowDefinition（声明层需要邻居
// 节点做 review inputKind 解析）；测试用最小定义包一层。
const defOf = (nodes: WorkflowNode[]) =>
  ({ $schema_version: 1, inputs: [], nodes, edges: [] }) as unknown as Parameters<
    typeof loopMemberCandidates
  >[1]

const agentNode = (id: string, agentName: string): WorkflowNode =>
  ({ id, kind: 'agent-single', agentName }) as unknown as WorkflowNode

const reviewNode = (id: string, sourceNodeId: string, portName: string): WorkflowNode =>
  ({
    id,
    kind: 'review',
    inputSource: { nodeId: sourceNodeId, portName },
  }) as unknown as WorkflowNode

const loopWrapper = (id: string, nodeIds: string[]): WorkflowNode =>
  ({ id, kind: 'wrapper-loop', nodeIds, maxIterations: 3 }) as unknown as WorkflowNode

describe('loopMemberCandidates × review 节点（flag-audit W0 假端口修复）', () => {
  test('单文档 review（markdown 输入）→ approved_doc + approval_meta，绝不是 output', () => {
    const nodes = [
      agentNode('A', 'writer'),
      reviewNode('R', 'A', 'doc'),
      loopWrapper('L', ['A', 'R']),
    ]
    const agents = [{ name: 'writer', outputs: ['doc'], outputKinds: { doc: 'markdown' } }]
    const cands = loopMemberCandidates(nodes[2]!, defOf(nodes), agents)
    const review = cands.find((c) => c.nodeId === 'R')
    expect(review).toBeDefined()
    expect(review!.outputPorts).toEqual(['approved_doc', 'approval_meta'])
    expect(review!.outputPorts).not.toContain('output')
  })

  test('多文档 review（list<path<md>> 输入）→ accepted + approval_meta', () => {
    const nodes = [
      agentNode('A', 'writer'),
      reviewNode('R', 'A', 'docs'),
      loopWrapper('L', ['A', 'R']),
    ]
    const agents = [{ name: 'writer', outputs: ['docs'], outputKinds: { docs: 'list<path<md>>' } }]
    const cands = loopMemberCandidates(nodes[2]!, defOf(nodes), agents)
    const review = cands.find((c) => c.nodeId === 'R')
    expect(review!.outputPorts).toEqual(['accepted', 'approval_meta'])
  })

  test('kind 解析不出（无 inputSource）→ 回落单文档 approved_doc（与 oracle 的 undefined 语义一致）', () => {
    const bare = { id: 'R', kind: 'review' } as unknown as WorkflowNode
    const nodes = [bare, loopWrapper('L', ['R'])]
    const cands = loopMemberCandidates(nodes[1]!, defOf(nodes), [])
    expect(cands.find((c) => c.nodeId === 'R')!.outputPorts).toEqual([
      'approved_doc',
      'approval_meta',
    ])
  })

  test('无 title 的 review 节点标题派生 review:<port>（死分支修复：读 inputSource 而非 source）', () => {
    const nodes = [
      agentNode('A', 'writer'),
      reviewNode('R', 'A', 'doc'),
      loopWrapper('L', ['A', 'R']),
    ]
    const agents = [{ name: 'writer', outputs: ['doc'], outputKinds: { doc: 'markdown' } }]
    const cands = loopMemberCandidates(nodes[2]!, defOf(nodes), agents)
    expect(cands.find((c) => c.nodeId === 'R')!.title).toBe('review:doc')
  })
})
