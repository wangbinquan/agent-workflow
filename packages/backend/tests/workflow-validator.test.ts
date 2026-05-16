// Coverage for the 5-item static check in services/workflow.validator.ts (P-2-01).
//
// All cases are pure: no daemon, no DB. We hand validateWorkflowDef the
// definition + an Agent[] / Skill[] context built in-test, so we can exercise
// each rule with a minimal valid case + a minimal invalid case.

import type { Agent, Skill, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { extractTemplateVars, validateWorkflowDef } from '../src/services/workflow.validator'

function agent(
  name: string,
  outputs: string[] = [],
  skills: string[] = [],
  dependsOn: string[] = [],
): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    readonly: false,
    syncOutputsOnIterate: true,
    permission: {},
    skills,
    dependsOn,
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function skill(name: string): Skill {
  return {
    id: `skill-${name}`,
    name,
    description: '',
    sourceKind: 'managed',
    managedPath: '/tmp/' + name,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

const EMPTY_CTX = { agents: [], skills: [] }

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

// ---------------------------------------------------------------------------
// Rule 1 — edge port existence
// ---------------------------------------------------------------------------

describe('rule 1: edge port existence', () => {
  test('valid: edge between input.outPort and output.inPort', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'requirement' },
        {
          id: 'o1',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'i1', portName: 'requirement' } }],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'requirement' },
          target: { nodeId: 'o1', portName: 'final' },
        },
      ],
    })
    const res = validateWorkflowDef(def, EMPTY_CTX)
    expect(res.ok).toBe(true)
  })

  test('invalid: edge source node missing', () => {
    const def = makeDef({
      nodes: [{ id: 'o1', kind: 'output', ports: [] }],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'ghost', portName: 'x' },
          target: { nodeId: 'o1', portName: 'final' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).toContain('edge-source-node-missing')
  })

  test('invalid: edge source port not in node outputs', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'requirement' },
        {
          id: 'o1',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'i1', portName: 'requirement' } }],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'wrong_port' },
          target: { nodeId: 'o1', portName: 'final' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).toContain('edge-source-port-missing')
  })
})

// ---------------------------------------------------------------------------
// Rule 2 — topology (cycles only inside loop wrappers)
// ---------------------------------------------------------------------------

describe('rule 2: topology', () => {
  test('valid: linear input → agent → output', () => {
    const a = agent('coder', ['result'])
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'req', label: 'req' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'req' },
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'coder',
          promptTemplate: 'do {{req}}',
        },
        {
          id: 'o1',
          kind: 'output',
          ports: [{ name: 'r', bind: { nodeId: 'a1', portName: 'result' } }],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'req' },
          target: { nodeId: 'a1', portName: 'req' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a1', portName: 'result' },
          target: { nodeId: 'o1', portName: 'r' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [a], skills: [] })
    expect(res.ok).toBe(true)
  })

  test('invalid: cycle outside any loop wrapper', () => {
    const a1 = agent('a1', ['out'])
    const a2 = agent('a2', ['out'])
    const def = makeDef({
      nodes: [
        { id: 'n1', kind: 'agent-single', agentName: 'a1' },
        { id: 'n2', kind: 'agent-single', agentName: 'a2' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portName: 'out' },
          target: { nodeId: 'n2', portName: 'x' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portName: 'out' },
          target: { nodeId: 'n1', portName: 'x' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a1, a2], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('topology-cycle')
  })

  test('valid: cycle is permitted entirely inside a loop wrapper', () => {
    const a1 = agent('a1', ['out'])
    const a2 = agent('a2', ['out'])
    const def = makeDef({
      nodes: [
        { id: 'n1', kind: 'agent-single', agentName: 'a1' },
        { id: 'n2', kind: 'agent-single', agentName: 'a2' },
        {
          id: 'wl',
          kind: 'wrapper-loop',
          nodeIds: ['n1', 'n2'],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n1', portName: 'out' },
          target: { nodeId: 'n2', portName: 'x' },
        },
        {
          id: 'e2',
          source: { nodeId: 'n2', portName: 'out' },
          target: { nodeId: 'n1', portName: 'x' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a1, a2], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).not.toContain('topology-cycle')
  })
})

// ---------------------------------------------------------------------------
// Rule 3 — wrapper required fields
// ---------------------------------------------------------------------------

describe('rule 3: wrapper required fields', () => {
  test('valid: wrapper-loop with all required fields', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'r', label: 'r' }],
      nodes: [
        { id: 'n1', kind: 'input', inputKey: 'r' },
        {
          id: 'wl',
          kind: 'wrapper-loop',
          nodeIds: ['n1'],
          maxIterations: 5,
          exitCondition: { kind: 'port-count-lt', nodeId: 'n1', portName: 'r', n: 1 },
        },
      ],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).not.toContain('wrapper-loop-max-iterations')
    expect(codes).not.toContain('wrapper-loop-exit-condition')
    expect(codes).not.toContain('wrapper-empty')
  })

  test('invalid: wrapper-loop missing maxIterations + exitCondition + inner', () => {
    const def = makeDef({
      nodes: [{ id: 'wl', kind: 'wrapper-loop', nodeIds: [] }],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).toContain('wrapper-empty')
    expect(codes).toContain('wrapper-loop-max-iterations')
    expect(codes).toContain('wrapper-loop-exit-condition')
  })

  test('invalid: wrapper-git with empty nodeIds', () => {
    const def = makeDef({ nodes: [{ id: 'wg', kind: 'wrapper-git', nodeIds: [] }] })
    expect(validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)).toContain('wrapper-empty')
  })
})

// ---------------------------------------------------------------------------
// Rule 4 — reference resolution (agent / skill / sourcePort / bindings / keys)
// ---------------------------------------------------------------------------

describe('rule 4: reference resolution', () => {
  test('valid: known agent, known skill, valid binding', () => {
    const a = agent('coder', ['result'], ['py-utils'])
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'coder' },
        {
          id: 'o1',
          kind: 'output',
          ports: [{ name: 'r', bind: { nodeId: 'a1', portName: 'result' } }],
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [a], skills: [skill('py-utils')] })
    expect(res.ok).toBe(true)
  })

  test('invalid: agent not found + skill not found + bad binding + duplicate input key', () => {
    const a = agent('coder', ['result'], ['missing-skill'])
    const def = makeDef({
      inputs: [
        { kind: 'text', key: 'req', label: 'r' },
        { kind: 'text', key: 'req', label: 'dup' },
      ],
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'ghost' },
        { id: 'a2', kind: 'agent-single', agentName: 'coder' },
        {
          id: 'o1',
          kind: 'output',
          ports: [{ name: 'r', bind: { nodeId: 'a2', portName: 'nope' } }],
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a], skills: [] }).issues.map((i) => i.code)
    expect(codes).toContain('agent-not-found')
    expect(codes).toContain('skill-not-found')
    expect(codes).toContain('binding-port-missing')
    expect(codes).toContain('input-key-duplicate')
  })

  test('invalid: agent-multi missing sourcePort', () => {
    const a = agent('auditor', ['findings'])
    const def = makeDef({
      nodes: [{ id: 'a1', kind: 'agent-multi', agentName: 'auditor' }],
    })
    const codes = validateWorkflowDef(def, { agents: [a], skills: [] }).issues.map((i) => i.code)
    expect(codes).toContain('agent-multi-source-port-missing')
  })

  test('invalid: agent-multi sourcePort references unknown port', () => {
    const a = agent('auditor', ['findings'])
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'unused', label: 'unused' }],
      nodes: [
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['x'] },
        { id: 'x', kind: 'input', inputKey: 'unused' },
        {
          id: 'a1',
          kind: 'agent-multi',
          agentName: 'auditor',
          sourcePort: { nodeId: 'wg', portName: 'not_a_port' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a], skills: [] }).issues.map((i) => i.code)
    expect(codes).toContain('agent-multi-source-port-missing')
  })
})

// ---------------------------------------------------------------------------
// Rule 5 — prompt template variable resolution
// ---------------------------------------------------------------------------

describe('rule 5: prompt template', () => {
  test('valid: template references inbound port + builtin only', () => {
    const a = agent('coder', ['result'])
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'requirement' },
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'coder',
          promptTemplate: 'work on {{requirement}} in {{__repo_path__}}',
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'requirement' },
          target: { nodeId: 'a1', portName: 'requirement' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [a], skills: [] })
    expect(res.ok).toBe(true)
  })

  test('invalid: template references undefined var', () => {
    const a = agent('coder', ['result'])
    const def = makeDef({
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'coder',
          promptTemplate: 'do {{requirement}}',
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a], skills: [] }).issues.map((i) => i.code)
    expect(codes).toContain('prompt-template-unresolved')
  })

  test('agent-multi can reference its sourcePort name in the template', () => {
    const a = agent('auditor', ['findings'])
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'x', label: 'x' }],
      nodes: [
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['unused'] },
        { id: 'unused', kind: 'input', inputKey: 'x' },
        {
          id: 'a1',
          kind: 'agent-multi',
          agentName: 'auditor',
          sourcePort: { nodeId: 'wg', portName: 'git_diff' },
          promptTemplate: 'audit:\n{{git_diff}}',
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [a], skills: [] }).issues.map((i) => i.code)
    expect(codes).not.toContain('prompt-template-unresolved')
  })
})

// ---------------------------------------------------------------------------
// RFC-004 — input-node ↔ workflow.inputs[] bijection
//
// Locks in the new contract: an input node's inputKey MUST appear in
// definition.inputs[]; an orphan inputs[] entry surfaces as a warning that
// does NOT block task launch. If these go red, check
// workflow.validator.ts around the input-key-not-declared / input-orphan-
// declared block plus the WorkflowValidationIssue.severity field in
// packages/shared/src/schemas/workflow.ts.
// ---------------------------------------------------------------------------

describe('RFC-004: input-node ↔ workflow.inputs[] bijection', () => {
  test('error: input node inputKey not declared in inputs[]', () => {
    const def = makeDef({
      inputs: [],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' }],
    })
    const res = validateWorkflowDef(def, EMPTY_CTX)
    expect(res.ok).toBe(false)
    const issue = res.issues.find((i) => i.code === 'input-key-not-declared')
    expect(issue).toBeDefined()
    expect(issue?.pointer).toBe('i1')
    expect(issue?.severity ?? 'error').toBe('error')
  })

  test('ok: input node inputKey declared in inputs[]', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement' }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' }],
    })
    const res = validateWorkflowDef(def, EMPTY_CTX)
    expect(res.issues.find((i) => i.code === 'input-key-not-declared')).toBeUndefined()
    expect(res.ok).toBe(true)
  })

  test('warning (non-blocking): inputs[] declares a key no input node references', () => {
    const def = makeDef({
      inputs: [{ kind: 'text', key: 'orphan', label: 'orphan' }],
      nodes: [],
    })
    const res = validateWorkflowDef(def, EMPTY_CTX)
    const issue = res.issues.find((i) => i.code === 'input-orphan-declared')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    // Warning must not flip result.ok to false.
    expect(res.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rule 4b — review node (RFC-005)
// ---------------------------------------------------------------------------

describe('rule 4b: review node (RFC-005)', () => {
  function agentWithKinds(
    name: string,
    outputs: string[],
    outputKinds: Record<string, 'string' | 'markdown' | 'markdown_file'>,
  ): Agent {
    return { ...agent(name, outputs), outputKinds }
  }

  test('valid: review inputSource → agent.markdown port, rerunnable subset of upstream', () => {
    const designer = agentWithKinds('designer', ['design', 'plan'], {
      design: 'markdown',
      plan: 'markdown_file',
    })
    const def = makeDef({
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer', 'in_1'],
          rerunnableOnIterate: ['designer'],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer], skills: [] })
    expect(res.ok).toBe(true)
  })

  test('invalid: inputSource missing entirely → review-input-source-missing', () => {
    const def = makeDef({
      $schema_version: 2,
      nodes: [{ id: 'rev_1', kind: 'review', rerunnableOnReject: [], rerunnableOnIterate: [] }],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).toContain('review-input-source-missing')
  })

  test('invalid: inputSource points at unknown node → review-input-source-missing', () => {
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'ghost', portName: 'design' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
        },
      ],
    })
    const codes = validateWorkflowDef(def, EMPTY_CTX).issues.map((i) => i.code)
    expect(codes).toContain('review-input-source-missing')
  })

  test('invalid: inputSource port not declared on source node', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'absent_port' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('review-input-source-missing')
  })

  test('invalid: agent port not declared as markdown[_file] → review-input-source-not-markdown', () => {
    const designer = agentWithKinds('designer', ['notes'], { notes: 'string' })
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'notes' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('review-input-source-not-markdown')
  })

  test('invalid: source is a wrapper-git (non-agent) → review-input-source-not-markdown', () => {
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'g1', kind: 'wrapper-git', nodeIds: ['inner_a'] },
        { id: 'inner_a', kind: 'agent-single', agentName: 'x', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'g1', portName: 'git_diff' },
          rerunnableOnReject: ['g1'],
          rerunnableOnIterate: ['g1'],
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [agent('x', [])], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('review-input-source-not-markdown')
  })

  test('invalid: rerunnableOnReject id not in reachable upstream → review-rerunnable-out-of-scope', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const sibling = agent('sibling', ['unrelated'])
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        { id: 'sibling', kind: 'agent-single', agentName: 'sibling', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          // 'sibling' is NOT upstream of designer → out of scope.
          rerunnableOnReject: ['designer', 'sibling'],
          rerunnableOnIterate: ['designer'],
        },
      ],
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer, sibling], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('review-rerunnable-out-of-scope')
  })

  test('invalid: rerunnableOnIterate same out-of-scope check', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer', 'ghost_node'],
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('review-rerunnable-out-of-scope')
  })

  test('warning: rerunnableOnReject empty (default would have been non-empty)', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: [],
          rerunnableOnIterate: ['designer'],
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer], skills: [] })
    const empty = res.issues.find((i) => i.code === 'review-rerunnable-empty-on-reject')
    expect(empty).toBeDefined()
    expect(empty?.severity).toBe('warning')
    // Warning alone does not flip ok to false.
    expect(res.ok).toBe(true)
  })

  test('rerunnable subset can include transitive upstream (input → designer → review)', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const def = makeDef({
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          // 'in_1' is transitively upstream of designer — should be allowed.
          rerunnableOnReject: ['designer', 'in_1'],
          rerunnableOnIterate: ['designer'],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] })
      .issues.filter((i) => (i.severity ?? 'error') === 'error')
      .map((i) => i.code)
    expect(codes).not.toContain('review-rerunnable-out-of-scope')
  })

  test('review node publishes approved_doc + approval_meta as output ports (edges can reference them)', () => {
    const designer = agentWithKinds('designer', ['design'], { design: 'markdown' })
    const def = makeDef({
      $schema_version: 2,
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer', promptTemplate: '' },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
        {
          id: 'out_1',
          kind: 'output',
          ports: [
            { name: 'final', bind: { nodeId: 'rev_1', portName: 'approved_doc' } },
            { name: 'audit', bind: { nodeId: 'rev_1', portName: 'approval_meta' } },
          ],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'rev_1', portName: 'approved_doc' },
          target: { nodeId: 'out_1', portName: 'final' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] })
      .issues.filter((i) => (i.severity ?? 'error') === 'error')
      .map((i) => i.code)
    expect(codes).not.toContain('edge-source-port-missing')
    expect(codes).not.toContain('binding-port-missing')
  })
})

// ---------------------------------------------------------------------------
// extractTemplateVars unit
// ---------------------------------------------------------------------------

describe('extractTemplateVars', () => {
  test('extracts unique {{name}} tokens with optional whitespace', () => {
    expect(extractTemplateVars('a {{x}} b {{ y }} c {{x}}')).toEqual(['x', 'y'])
  })

  test('ignores malformed braces', () => {
    expect(extractTemplateVars('{}{x}}{{{}')).toEqual([])
  })
})
