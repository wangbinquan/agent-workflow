// Locks in: user-set `title` on a WorkflowNode wins on the canvas card,
// blank/missing falls back to the kind-specific derivation (agentName /
// inputKey / id). Covers all node kinds touched by the unified
// "display name" field in NodeInspector.

import { describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { nodeTitle } from '../src/components/canvas/WorkflowCanvas'

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

  test('agent-single without agentName shows unset placeholder', () => {
    expect(nodeTitle(mk({}))).toBe('(unset agent)')
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
})
