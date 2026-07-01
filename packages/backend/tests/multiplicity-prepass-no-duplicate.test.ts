// RFC-069 C4 — pre-pass × per-NodeKind rule de-duplication.
//
// The pre-pass `validateAgentClarifyMultiplicity` runs BEFORE §4c (self-
// clarify) and §4d (clarify-cross-agent) case blocks. Per the plan, the §4c
// and §4d bodies for the three moved rules have been deleted; only per-
// NodeKind topology rules (self-loop, not-in-loop, ancestor, etc.) remain in
// the case blocks. If a future refactor accidentally re-introduces a §4c or
// §4d body for any of the three pre-pass rules, the same error would be
// emitted twice — once from the pre-pass, once from the case block — and the
// editor would render duplicate banners. This test pins the de-duplication
// invariant at runtime.
//
// The fixture mixes a multi-attachment topology with a per-NodeKind topology
// error (`clarify-self-loop`) so that we can verify both error categories
// continue to fire (each exactly once) without bleeding into each other.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

const designer = agent('designer', ['design'])

describe('RFC-069 C4 — pre-pass does not duplicate per-NodeKind rule emits', () => {
  // Topology:
  //   agent a1.__clarify__ → c1.questions
  //   agent a1.__clarify__ → c2.questions   (multi-attachment on a1)
  //   c1.answers          → c1.questions   (self-loop on c1)
  //
  // Expected emits:
  //   - clarify-multiple-clarify-on-same-agent ×1 (pre-pass, dict-min pointer c1)
  //   - clarify-self-loop                       ×1 (per-NodeKind, pointer c1)
  //
  // Importantly the multi-clarify error must appear EXACTLY ONCE (pre-pass
  // owns it now; the old §4c body that would emit a second copy has been
  // deleted). Likewise self-loop remains owned by §4c and fires exactly once.
  test('multi-attachment + self-loop fire exactly once each (no pre-pass × case-block double-emit)', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
        { id: 'c2', kind: 'clarify' },
      ],
      edges: [
        // multi-attachment: a1 connects to BOTH c1 and c2 via __clarify__
        {
          id: 'e_a1_c1',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        {
          id: 'e_a1_c2',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c2', portName: 'questions' },
        },
        // self-loop on c1.answers → c1.questions (per-NodeKind rule fires)
        {
          id: 'e_c1_self',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        // close c2.answers back to a1 so we don't trip extra warnings
        {
          id: 'e_c2_a1',
          source: { nodeId: 'c2', portName: 'answers' },
          target: { nodeId: 'a1', portName: '__clarify_response__' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer], skills: [] })

    const multiClarifyIssues = res.issues.filter(
      (i) => i.code === 'clarify-multiple-clarify-on-same-agent',
    )
    expect(multiClarifyIssues).toHaveLength(1)
    expect(multiClarifyIssues[0]!.pointer).toBe('c1')

    const selfLoopIssues = res.issues.filter((i) => i.code === 'clarify-self-loop')
    expect(selfLoopIssues).toHaveLength(1)
    expect(selfLoopIssues[0]!.pointer).toBe('c1')

    // Validator is not ok overall — at least one fail-severity rule fired.
    expect(res.ok).toBe(false)
  })
})
