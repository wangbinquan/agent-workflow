// RFC-167 T1 — the DEFINITIVE check behind the "no synthetic IO nodes" v1
// decision: a `dwGeneratedToWorkflowDef` result (a pure agent-single chain with
// edges, no input/output IO nodes) must pass the generic `validateWorkflowDef`.
// If a future change makes the generic validator require an IO node, this test
// goes red and forces the conversion to re-introduce them.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { dwGeneratedToWorkflowDef } from '@agent-workflow/shared'
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

describe('RFC-167 dwGeneratedToWorkflowDef → validateWorkflowDef', () => {
  test('a single self-contained agent-single node validates (no IO nodes needed)', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [{ id: 'n1', agentName: 'coder', promptTemplate: 'implement the goal', inputs: [] }],
      edges: [],
    })
    const res = validateWorkflowDef(def, { agents: [agent('coder')], skills: [] })
    expect(res.ok).toBe(true)
    expect(res.issues).toEqual([])
  })

  test('a two-node chain (b consumes a.patch) validates', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'write the patch', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: 'review {{patch}}',
          inputs: [{ port: 'patch', from: { nodeId: 'a', portName: 'patch' } }],
        },
      ],
      edges: [],
    })
    // coder must declare the `patch` output port the edge sources from.
    const res = validateWorkflowDef(def, {
      agents: [agent('coder', ['patch']), agent('auditor', ['report'])],
      skills: [],
    })
    expect(res.ok).toBe(true)
    expect(res.issues.filter((i) => i.severity !== 'warning')).toEqual([])
  })

  test('an edge sourcing a port the upstream agent does NOT declare fails (sanity: real validation runs)', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'w', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: '{{ghost}}',
          inputs: [{ port: 'ghost', from: { nodeId: 'a', portName: 'ghost' } }],
        },
      ],
      edges: [],
    })
    // coder declares no outputs → the edge's source port 'ghost' is invalid.
    const res = validateWorkflowDef(def, {
      agents: [agent('coder'), agent('auditor')],
      skills: [],
    })
    expect(res.ok).toBe(false)
  })
})
