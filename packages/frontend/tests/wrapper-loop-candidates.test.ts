// RFC-016 §5.1: loopMemberCandidates feeds the loop wrapper Inspector
// nodeId / portName selects. The reason these are pure-fn tested rather
// than rendered: candidate derivation has to track wrapper.nodeIds changes
// reactively in the inspector, and the source of truth is the function.

import { describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { loopMemberCandidates } from '../src/components/canvas/wrapperCandidates'

// RFC-146: loopMemberCandidates 签名改吃 WorkflowDefinition（声明层需要邻居
// 节点做 review inputKind 解析）；测试用最小定义包一层。
const defOf = (nodes: WorkflowNode[]) =>
  ({ $schema_version: 1, inputs: [], nodes, edges: [] }) as unknown as Parameters<
    typeof loopMemberCandidates
  >[1]

function loop(id: string, nodeIds: string[]): WorkflowNode {
  return { id, kind: 'wrapper-loop', position: { x: 0, y: 0 }, nodeIds } as unknown as WorkflowNode
}
function agent(id: string, agentName: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName,
  } as unknown as WorkflowNode
}
function review(id: string, sourcePort: string): WorkflowNode {
  // flag-audit W0（§3-4）：schema 字段是 inputSource（旧 fixture 用了不存在的
  // `source`，导致 review:port 标题分支从未被真正测过）。
  return {
    id,
    kind: 'review',
    position: { x: 0, y: 0 },
    inputSource: { nodeId: 'upstream', portName: sourcePort },
  } as unknown as WorkflowNode
}
function gitWrap(id: string, nodeIds: string[]): WorkflowNode {
  return { id, kind: 'wrapper-git', position: { x: 0, y: 0 }, nodeIds } as unknown as WorkflowNode
}

describe('loopMemberCandidates', () => {
  test('agent node candidates carry declared outputs', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'fixer')
    const out = loopMemberCandidates(l, defOf([l, a]), [
      { name: 'fixer', outputs: ['passed', 'issues'] },
    ])
    expect(out).toEqual([{ nodeId: 'a1', title: 'fixer', outputPorts: ['passed', 'issues'] }])
  })

  test('review node candidates expose the REAL ports（approved_doc/approval_meta）+ review:port 标题', () => {
    // flag-audit W0（§3-3）：旧断言锁的是不存在的 ['output'] 假端口——正是
    // wrapper-candidates-review-ports.test.ts 修复的 bug。契约改为与
    // WorkflowCanvas.computePorts 同源（多文档 accepted 场景见新测试文件）。
    const l = loop('loop1', ['r1'])
    const r = review('r1', 'design')
    const out = loopMemberCandidates(l, defOf([l, r]), [])
    expect(out).toEqual([
      { nodeId: 'r1', title: 'review:design', outputPorts: ['approved_doc', 'approval_meta'] },
    ])
  })

  test('nested wrapper inner nodes are excluded from candidate list', () => {
    const l = loop('loop1', ['a1', 'inner_git'])
    const a = agent('a1', 'fixer')
    const inner = gitWrap('inner_git', ['a2'])
    const a2 = agent('a2', 'helper')
    const out = loopMemberCandidates(l, defOf([l, a, inner, a2]), [
      { name: 'fixer', outputs: ['passed'] },
      { name: 'helper', outputs: ['done'] },
    ])
    expect(out.map((c) => c.nodeId)).toEqual(['a1'])
  })

  test('agent without declared outputs falls back to [out]', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'unknown_agent')
    const out = loopMemberCandidates(l, defOf([l, a]), [])
    expect(out).toEqual([{ nodeId: 'a1', title: 'unknown_agent', outputPorts: ['out'] }])
  })
})
