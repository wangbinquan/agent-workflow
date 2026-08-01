// Locks in: user-set `title` on a WorkflowNode wins on the canvas card,
// blank/missing falls back to the kind-specific derivation (agentName /
// inputKey / id). Covers all node kinds touched by the unified
// "display name" field in NodeInspector.
//
// 2026-08-01 regression: a canonical agentId with no node-title/display
// snapshot must resolve the configured agent's name and must never render an
// "unset agent" label on the card or its companion inspector surfaces.

import { describe, expect, test } from 'vitest'
import { buildNodeAgentLookup, type Agent, type WorkflowNode } from '@agent-workflow/shared'
import { __testToFlowNodes, nodeTitle } from '../src/components/canvas/WorkflowCanvas'

const mk = (extra: Record<string, unknown>): WorkflowNode =>
  ({ id: 'n1', kind: 'agent-single', ...extra }) as unknown as WorkflowNode

describe('nodeTitle()', () => {
  test('explicit title wins for agent-single', () => {
    expect(nodeTitle(mk({ agentName: 'coder', title: 'My Coder' }))).toBe('My Coder')
  })

  test('explicit title wins for agent-multi', () => {
    expect(nodeTitle(mk({ kind: 'agent-multi', agentName: 'auditor', title: 'Fan-out' }))).toBe(
      'Fan-out',
    )
  })

  test('blank title falls back to agentName', () => {
    expect(nodeTitle(mk({ agentName: 'coder', title: '' }))).toBe('coder')
  })

  test('missing title still falls back to agentName', () => {
    expect(nodeTitle(mk({ agentName: 'coder' }))).toBe('coder')
  })

  test('blank display name resolves the configured agent name by canonical id', () => {
    const configuredAgent = { id: 'agent-1', name: 'coder' } as Agent
    const lookup = buildNodeAgentLookup([configuredAgent], (agent) => agent)

    expect(nodeTitle(mk({ agentId: 'agent-1', title: '' }), lookup)).toBe('coder')
  })

  test('canvas card projection supplies the configured-agent lookup to the title rule', () => {
    const configuredAgent = { id: 'agent-1', name: 'coder' } as Agent
    const [flowNode] = __testToFlowNodes([mk({ agentId: 'agent-1', title: '' })], [configuredAgent])

    expect(flowNode?.data.title).toBe('coder')
    expect(flowNode?.data.agentName).toBe('coder')
  })

  test('canvas card keeps custom title and current referenced-agent name separately', () => {
    const configuredAgent = { id: 'agent-1', name: 'renamed-coder' } as Agent
    const [flowNode] = __testToFlowNodes(
      [mk({ agentId: 'agent-1', agentName: 'old-coder', title: 'Implementation' })],
      [configuredAgent],
    )

    expect(flowNode?.data.title).toBe('Implementation')
    expect(flowNode?.data.agentName).toBe('renamed-coder')
  })

  test('the configured agent name wins over a stale display snapshot', () => {
    const configuredAgent = { id: 'agent-1', name: 'renamed-coder' } as Agent
    const lookup = buildNodeAgentLookup([configuredAgent], (agent) => agent)

    expect(nodeTitle(mk({ agentId: 'agent-1', agentName: 'old-coder', title: '' }), lookup)).toBe(
      'renamed-coder',
    )
  })

  test('an unresolved agent node falls back to its node id, never an unset-agent label', () => {
    expect(nodeTitle(mk({}))).toBe('n1')
  })

  test('input node falls back to inputKey when no title', () => {
    expect(nodeTitle(mk({ kind: 'input', inputKey: 'spec' }))).toBe('spec')
  })

  test('input node title overrides inputKey', () => {
    expect(nodeTitle(mk({ kind: 'input', inputKey: 'spec', title: 'Spec doc' }))).toBe('Spec doc')
  })

  test('wrapper / output / review / clarify all honour explicit title', () => {
    const kinds: WorkflowNode['kind'][] = [
      'wrapper-git',
      'wrapper-loop',
      'output',
      'review',
      'clarify',
    ]
    for (const kind of kinds) {
      expect(nodeTitle(mk({ kind, title: `T-${kind}` }))).toBe(`T-${kind}`)
    }
  })

  test('non-agent / non-input kinds fall back to id when no title', () => {
    expect(nodeTitle(mk({ id: 'wrap_1', kind: 'wrapper-git' }))).toBe('wrap_1')
    expect(nodeTitle(mk({ id: 'out_1', kind: 'output' }))).toBe('out_1')
  })

  // RFC-146 T4: the title rule is single-sourced (nodeTitle.ts). The
  // `review:<port>` derivation — previously only in the loop-candidates
  // fork — now applies to the canvas card too (the RFC's one deliberate
  // display change).
  test('review node with wired inputSource derives review:<port>', () => {
    expect(
      nodeTitle(mk({ id: 'rev_1', kind: 'review', inputSource: { nodeId: 'a', portName: 'doc' } })),
    ).toBe('review:doc')
  })

  test('review node without a wired port still falls back to id', () => {
    expect(
      nodeTitle(mk({ id: 'rev_1', kind: 'review', inputSource: { nodeId: '', portName: '' } })),
    ).toBe('rev_1')
  })

  test('explicit title still beats review:<port>', () => {
    expect(
      nodeTitle(
        mk({
          id: 'rev_1',
          kind: 'review',
          title: 'Final gate',
          inputSource: { nodeId: 'a', portName: 'doc' },
        }),
      ),
    ).toBe('Final gate')
  })
})
