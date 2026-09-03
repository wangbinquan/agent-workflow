// RFC-016 §5.1: loopMemberCandidates feeds the loop wrapper Inspector
// nodeId / portName selects. The reason these are pure-fn tested rather
// than rendered: candidate derivation has to track wrapper.nodeIds changes
// reactively in the inspector, and the source of truth is the function.

import { describe, expect, test } from 'vitest'
import type { WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { loopMemberCandidates } from '../src/components/canvas/wrapperCandidates'

// RFC-146: loopMemberCandidates 签名改吃 WorkflowDefinition（声明层需要邻居
// 节点做 review inputKind 解析）；测试用最小定义包一层。
const defOf = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []) =>
  ({ $schema_version: 6, inputs: [], nodes, edges }) as unknown as Parameters<
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
    agentId: agentName,
    agentName,
  } as unknown as WorkflowNode
}
function review(id: string): WorkflowNode {
  return { id, kind: 'review', position: { x: 0, y: 0 } } as unknown as WorkflowNode
}
/** RFC-354 (schema v6): the review input is its `__review_input__` edge. */
function reviewEdge(reviewId: string, sourcePort: string): WorkflowEdge {
  return {
    id: `${reviewId}-in`,
    source: { nodeId: 'upstream', portName: sourcePort },
    target: { nodeId: reviewId, portName: '__review_input__' },
  }
}
function gitWrap(id: string, nodeIds: string[]): WorkflowNode {
  return { id, kind: 'wrapper-git', position: { x: 0, y: 0 }, nodeIds } as unknown as WorkflowNode
}

describe('loopMemberCandidates', () => {
  test('agent node candidates carry declared outputs', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'fixer')
    const out = loopMemberCandidates(l, defOf([l, a]), [
      { id: 'fixer', name: 'fixer', outputs: ['passed', 'issues'] },
    ])
    expect(out).toEqual([{ nodeId: 'a1', title: 'fixer', outputPorts: ['passed', 'issues'] }])
  })

  test('review node candidates expose the REAL ports（approved_doc/approval_meta）+ review:port 标题', () => {
    // flag-audit W0（§3-3）：旧断言锁的是不存在的 ['output'] 假端口——正是
    // wrapper-candidates-review-ports.test.ts 修复的 bug。契约改为与
    // WorkflowCanvas.computePorts 同源（多文档 accepted 场景见新测试文件）。
    const l = loop('loop1', ['r1'])
    const r = review('r1')
    const out = loopMemberCandidates(l, defOf([l, r], [reviewEdge('r1', 'design')]), [])
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
      { id: 'fixer', name: 'fixer', outputs: ['passed'] },
      { id: 'helper', name: 'helper', outputs: ['done'] },
    ])
    expect(out.map((c) => c.nodeId)).toEqual(['a1'])
  })

  test('agent without declared outputs falls back to [out]', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'unknown_agent')
    const out = loopMemberCandidates(l, defOf([l, a]), [])
    expect(out).toEqual([{ nodeId: 'a1', title: 'unknown_agent', outputPorts: ['out'] }])
  })

  test('agent candidate without a display snapshot uses the configured agent name', () => {
    const l = loop('loop1', ['a1'])
    const a = {
      id: 'a1',
      kind: 'agent-single',
      agentId: 'agent-1',
      position: { x: 0, y: 0 },
    } as unknown as WorkflowNode
    const out = loopMemberCandidates(l, defOf([l, a]), [
      { id: 'agent-1', name: 'coder', outputs: ['result'] },
    ])

    expect(out).toEqual([{ nodeId: 'a1', title: 'coder', outputPorts: ['result'] }])
  })
})
