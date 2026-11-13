// RFC-016 §6: wrapper-children-outside-bounds warning. Non-blocking; fires
// when wrapper.size + inner node positions drift apart (typical cause:
// hand-edited YAML or stale rows from a pre-RFC-016 export). The editor's
// ValidationPanel shows an inline Auto-fit link that clears wrapper.size to
// fix the drift.

import type { Agent, Skill, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/modules/resource-catalog/domain/workflowValidator'

const EMPTY_CTX: { agents: Agent[]; skills: Skill[] } = { agents: [], skills: [] }

function gitWrap(
  id: string,
  position: { x: number; y: number },
  size: { width: number; height: number } | undefined,
  innerIds: string[],
): WorkflowNode {
  const base: Record<string, unknown> = {
    id,
    kind: 'wrapper-git',
    position,
    nodeIds: innerIds,
  }
  if (size !== undefined) base.size = size
  return base as unknown as WorkflowNode
}

function child(id: string, position: { x: number; y: number }): WorkflowNode {
  return { id, kind: 'agent-single', position, agentName: 'a' } as unknown as WorkflowNode
}

function makeDef(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}

describe('wrapper-children-outside-bounds (RFC-016)', () => {
  test('inner node inside the wrapper rect → no warning emitted', () => {
    const def = makeDef([
      gitWrap('w1', { x: 100, y: 100 }, { width: 400, height: 300 }, ['a1']),
      child('a1', { x: 200, y: 200 }),
    ])
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).not.toContain('wrapper-children-outside-bounds')
  })

  test('inner node outside the wrapper rect → warning fires for that wrapper', () => {
    const def = makeDef([
      gitWrap('w1', { x: 100, y: 100 }, { width: 400, height: 300 }, ['a1']),
      child('a1', { x: 9999, y: 9999 }),
    ])
    const res = validateWorkflowDef(def, EMPTY_CTX)
    const issue = res.issues.find((i) => i.code === 'wrapper-children-outside-bounds')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    // Warning must not block save — result.ok should still depend on errors only.
    const hasErrors = res.issues.some((i) => i.severity !== 'warning')
    expect(res.ok).toBe(!hasErrors)
  })

  test('wrapper without persisted size → no warning (cannot drift if size is dynamic)', () => {
    const def = makeDef([
      gitWrap('w1', { x: 100, y: 100 }, undefined, ['a1']),
      child('a1', { x: 9999, y: 9999 }),
    ])
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).not.toContain('wrapper-children-outside-bounds')
  })

  test('one warning per wrapper, not per child (auto-fit fixes them all at once)', () => {
    const def = makeDef([
      gitWrap('w1', { x: 100, y: 100 }, { width: 400, height: 300 }, ['a1', 'a2', 'a3']),
      child('a1', { x: 9999, y: 9999 }),
      child('a2', { x: 8888, y: 8888 }),
      child('a3', { x: 7777, y: 7777 }),
    ])
    const warnings = validateWorkflowDef(def, EMPTY_CTX).issues.filter(
      (i) => i.code === 'wrapper-children-outside-bounds',
    )
    expect(warnings.length).toBe(1)
  })
})
