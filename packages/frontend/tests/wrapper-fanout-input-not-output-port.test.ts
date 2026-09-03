// 2026-05-24 regression lock — wrapper-fanout input ports are dual-purpose
// (target + source) so users can drag boundary-input edges into inner nodes.
// The boundary-input edge's `source = (wrapperId, inputPortName)` looks
// just like any other outbound edge from a node's POV, which used to trip
// the `computePorts` fallback loop into appending the input port name to
// the wrapper's `outputs[]`. The right-side renderer then drew a phantom
// OUTPUT port mirroring the input port name — exactly the duplicate-looking
// dots the user reported:
//
//   "为什么输出节点上多出了和输出节点一样的几个节点？"
//
// Fix: skip `boundary: 'wrapper-input'` edges in the fallback. This file
// locks the contract; a future refactor that drops the boundary check
// flips these tests red.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { __testComputePorts as computePorts } from '../src/components/canvas/WorkflowCanvas'

function defWith(
  nodes: WorkflowDefinition['nodes'],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges } as WorkflowDefinition
}

// RFC-354: the fan-out's parameters are its inbound edges; `shardSourcePort`
// names the one that is split. `feed()` is the parameter edge that declares
// the `docs` port on the wrapper.
function fanout(id: string, shardSourcePort: string, nodeIds: string[] = []) {
  return {
    id,
    kind: 'wrapper-fanout',
    position: { x: 0, y: 0 },
    nodeIds,
    shardSourcePort,
  } as unknown as WorkflowDefinition['nodes'][number]
}

function feed(wrapperId: string, port: string): WorkflowDefinition['edges'][number] {
  return {
    id: `feed-${port}`,
    source: { nodeId: 'src', portName: port },
    target: { nodeId: wrapperId, portName: port },
  }
}

function agent(id: string) {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName: 'doc',
  } as unknown as WorkflowDefinition['nodes'][number]
}

describe('computePorts: wrapper-fanout boundary-input source does not leak into outputs[]', () => {
  test('boundary-input edge from wrapper input → inner node does not append a phantom output port', () => {
    const def = defWith(
      [fanout('w1', 'docs', ['a1']), agent('a1'), agent('src')],
      [
        feed('w1', 'docs'),
        {
          id: 'e1',
          source: { nodeId: 'w1', portName: 'docs' },
          target: { nodeId: 'a1', portName: 'docs' },
          boundary: 'wrapper-input',
        },
      ],
    )
    const wrapper = def.nodes.find((n) => n.id === 'w1')!
    const ports = computePorts(wrapper, new Map(), def)
    // Wrapper-fanout's default output (no aggregator) is the implicit
    // __done__ signal outlet. The input port name 'docs' must NOT appear
    // on the output side.
    expect(ports.outputs).not.toContain('docs')
    // 'docs' DOES belong on the input side via its parameter edge.
    expect(ports.inputs).toContain('docs')
  })

  test('non-boundary outbound edge to an unknown port still gets a fallback handle (snapshot drift)', () => {
    // Sanity: the snapshot-drift fallback is preserved for non-boundary
    // edges. An agent that previously declared output 'foo' but doesn't
    // any longer should still surface 'foo' as a Handle so the edge can
    // route — otherwise the edge silently disappears.
    const def = defWith(
      [agent('a1'), agent('a2')],
      [
        {
          id: 'e1',
          source: { nodeId: 'a1', portName: 'stale_port' },
          target: { nodeId: 'a2', portName: 'in' },
        },
      ],
    )
    const ports = computePorts(def.nodes[0]!, new Map(), def)
    expect(ports.outputs).toContain('stale_port')
  })

  test('boundary-output edge from inner aggregator → wrapper output does not append a phantom input port', () => {
    // Symmetric mirror of the wrapper-input-leak-into-outputs check.
    // A `boundary: 'wrapper-output'` edge has target=(wrapper, outputPort);
    // without skipping it in the inputs-fallback loop, the output port name
    // leaks into `inputs[]` and the wrapper grows a phantom INPUT port row
    // on its left side mirroring the output name.
    const def = defWith(
      [fanout('w1', 'docs', ['agg']), agent('agg'), agent('src')],
      [
        feed('w1', 'docs'),
        {
          id: 'e1',
          source: { nodeId: 'agg', portName: 'summary' },
          target: { nodeId: 'w1', portName: 'summary' },
          boundary: 'wrapper-output',
        },
      ],
    )
    const wrapper = def.nodes.find((n) => n.id === 'w1')!
    const ports = computePorts(wrapper, new Map(), def)
    // 'summary' must NOT appear on the input side. 'docs' (the parameter
    // edge) is the only legitimate left-side port.
    expect(ports.inputs).not.toContain('summary')
    expect(ports.inputs).toContain('docs')
  })

  test('wrapper-fanout with both boundary-input AND legitimate outbound edge surfaces only the real output', () => {
    // Boundary-input edge: source=w1.docs → a1.docs. Should NOT add 'docs' to outputs.
    // Plain outbound edge (e.g. user wired the wrapper's __done__ to downstream):
    // source=w1.__done__ → downstream.in. Should surface '__done__' (already
    // surfaced by the wrapper-fanout case above; this test pins behavior).
    const def = defWith(
      [fanout('w1', 'docs', ['a1']), agent('a1'), agent('downstream'), agent('src')],
      [
        feed('w1', 'docs'),
        {
          id: 'e1',
          source: { nodeId: 'w1', portName: 'docs' },
          target: { nodeId: 'a1', portName: 'docs' },
          boundary: 'wrapper-input',
        },
        {
          id: 'e2',
          source: { nodeId: 'w1', portName: '__done__' },
          target: { nodeId: 'downstream', portName: 'sig' },
        },
      ],
    )
    const wrapper = def.nodes.find((n) => n.id === 'w1')!
    const ports = computePorts(wrapper, new Map(), def)
    expect(ports.outputs).toContain('__done__')
    expect(ports.outputs).not.toContain('docs')
  })
})
