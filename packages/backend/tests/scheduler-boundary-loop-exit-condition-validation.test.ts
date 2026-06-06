// Locked regression: validateWorkflowDef must reject a wrapper-loop whose
// exitCondition references a node that does not exist (dangling exit ref).
//
// DEFECT (MED): the validator's wrapper-loop check only verifies that
// `exitCondition` is a non-null object — workflow.validator.ts:151-158:
//
//     const exitCond = (node as Record<string, unknown>).exitCondition
//     if (exitCond === undefined || exitCond === null || typeof exitCond !== 'object') {
//       issues.push({ code: 'wrapper-loop-exit-condition', ... })
//     }
//
// It never verifies that exitCondition.nodeId / portName actually exist or
// live inside the loop scope. At runtime readPortAtIteration() returns '' for
// the dangling ref, so a `port-empty` condition silently "succeeds" and the
// loop exits on iteration 0 (silent wrong exit — no error surfaced anywhere).
//
// RED until the validator gains an exitCondition-reference existence check
// (e.g. an 'wrapper-loop-exit-condition-ref' / 'exit-condition-unknown-node'
// issue when exitCondition.nodeId is not a node in the loop's nodeIds[]).
//
// The SECOND test (valid exitCondition.nodeId pointing at the real inner node)
// guards against a future over-broad rule and PASSES today.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

// Minimal Agent for the validation context so the validator knows node 'audit'
// exposes the 'findings' output port. The exitCondition PORT check only runs
// when the node's ports are known (agent present in ctx) — see
// workflow.validator.ts exitCondition handling.
function mkAgent(name: string, outputs: string[]): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    readonly: false,
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

describe('wrapper-loop exitCondition node-reference existence (locks dangling-ref validator gap)', () => {
  test('RED: exitCondition.nodeId pointing at a non-existent node is flagged as an exit-related issue', () => {
    const def = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          // ghost-node is NOT in the workflow at all → dangling reference.
          exitCondition: { kind: 'port-empty', nodeId: 'ghost-node', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'audit', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    } as unknown as WorkflowDefinition

    const issues = validateWorkflowDef(def, { agents: [], skills: [] }).issues

    // Headline: a dangling exitCondition reference MUST be flagged. Today the
    // validator only shallow-checks exitCondition is an object, so no
    // exit-related issue is produced → this fails (RED). Other unrelated
    // issues (e.g. agent-not-found for 'auditor') may coexist; we only look
    // for one that concerns the exit condition.
    expect(issues.some((i) => /exit/i.test(i.code) || /exit/i.test(i.message))).toBe(true)
  })

  test('GREEN today: a valid exitCondition.nodeId (real inner node) produces NO exit-related issue', () => {
    const def = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          // Valid: points at the real inner node 'audit'.
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'audit', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    } as unknown as WorkflowDefinition

    const issues = validateWorkflowDef(def, { agents: [], skills: [] }).issues

    // A correct exitCondition must not trip any future exit-reference rule.
    expect(issues.some((i) => /exit/i.test(i.code) || /exit/i.test(i.message))).toBe(false)
  })

  test('valid node but unknown PORT (agent in ctx) → wrapper-loop-exit-port-missing', () => {
    const def = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 3,
          // node exists, but 'ghost-port' is not one of auditor's outputs.
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'ghost-port' },
          outputBindings: [{ name: 'final', bind: { nodeId: 'audit', portName: 'findings' } }],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    } as unknown as WorkflowDefinition

    // Agent in ctx → the validator knows 'audit' exposes only ['findings'], so
    // the dangling PORT reference is caught. (Without the agent, the port check
    // is skipped to avoid false positives — that is the GREEN case above.)
    const issues = validateWorkflowDef(def, {
      agents: [mkAgent('auditor', ['findings'])],
      skills: [],
    }).issues
    expect(issues.some((i) => i.code === 'wrapper-loop-exit-port-missing')).toBe(true)
  })
})
