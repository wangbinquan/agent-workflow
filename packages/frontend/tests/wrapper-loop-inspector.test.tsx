// RFC-016 §5 / T7 / C4: NodeInspector loop wrapper form must surface
// exitCondition.nodeId and portName as <select> drop-downs whose options
// come from loopMemberCandidates, not hand-typed strings. The same rule
// applies to outputBindings rows. Red here means the candidate-driven
// contract has regressed back to bare TextInputs — users would once again
// be free to enter ids that don't match any wrapper member.

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'

function makeDef(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}
function loop(id: string, nodeIds: string[], extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id,
    kind: 'wrapper-loop',
    position: { x: 0, y: 0 },
    nodeIds,
    maxIterations: 5,
    exitCondition: { kind: 'port-empty' },
    ...extra,
  } as unknown as WorkflowNode
}
function agentNode(id: string, agentName: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName,
  } as unknown as WorkflowNode
}

function fakeAgents(...defs: Array<{ name: string; outputs: string[] }>): Agent[] {
  // We cast to Agent to satisfy the type; only `name` + `outputs` are
  // consumed by loopMemberCandidates.
  return defs as unknown as Agent[]
}

function Host({ initial, agents }: { initial: WorkflowDefinition; agents: Agent[] }) {
  const [def, setDef] = useState(initial)
  const loopId = def.nodes.find((n) => n.kind === 'wrapper-loop')!.id
  return (
    <NodeInspector
      definition={def}
      selectedNodeId={loopId}
      agents={agents}
      onChange={setDef}
      onClose={() => {}}
    />
  )
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('loop NodeInspector candidate-driven selects', () => {
  test('exitCondition.nodeId renders as a <select> populated from loop members', () => {
    const def = makeDef([
      loop('w1', ['a1', 'a2']),
      agentNode('a1', 'fixer'),
      agentNode('a2', 'check'),
    ])
    render(
      <Host
        initial={def}
        agents={fakeAgents(
          { name: 'fixer', outputs: ['passed'] },
          { name: 'check', outputs: ['result'] },
        )}
      />,
    )
    const select = screen.getByTestId('loop-exit-node-select') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toContain('a1')
    expect(optionValues).toContain('a2')
  })

  test('exitCondition.portName options derive from the selected nodeId only', () => {
    const def = makeDef([
      loop('w1', ['a1', 'a2'], { exitCondition: { kind: 'port-equals', nodeId: 'a1' } }),
      agentNode('a1', 'fixer'),
      agentNode('a2', 'check'),
    ])
    render(
      <Host
        initial={def}
        agents={fakeAgents(
          { name: 'fixer', outputs: ['passed', 'issues'] },
          { name: 'check', outputs: ['result'] },
        )}
      />,
    )
    const portSelect = screen.getByTestId('loop-exit-port-select') as HTMLSelectElement
    const portOptions = Array.from(portSelect.options).map((o) => o.value)
    expect(portOptions).toContain('passed')
    expect(portOptions).toContain('issues')
    expect(portOptions).not.toContain('result')
  })

  test('stale exitCondition.nodeId (member removed) renders the missing tag + red hint', () => {
    const def = makeDef([
      loop('w1', ['a1'], {
        exitCondition: { kind: 'port-empty', nodeId: 'a2', portName: 'gone' },
      }),
      agentNode('a1', 'fixer'),
    ])
    render(<Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['passed'] })} />)
    const select = screen.getByTestId('loop-exit-node-select') as HTMLSelectElement
    expect(select.value).toBe('a2')
    expect(select.classList.contains('form-input--invalid')).toBe(true)
    expect(document.body.textContent ?? '').toMatch(/a2/)
  })

  test('outputBindings nodeId / portName render as <select> too (not TextInput)', () => {
    const def = makeDef([
      loop('w1', ['a1'], {
        outputBindings: [{ name: 'out_1', bind: { nodeId: 'a1', portName: 'passed' } }],
      }),
      agentNode('a1', 'fixer'),
    ])
    const { container } = render(
      <Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['passed'] })} />,
    )
    const rows = container.querySelectorAll('.inspector__output-port-row')
    expect(rows.length).toBe(1)
    const selects = rows[0]!.querySelectorAll('select')
    expect(selects.length).toBeGreaterThanOrEqual(2)
  })

  test('exitCondition.kind dropdown lists all 4 built-in kinds including port-not-empty (RFC-023)', () => {
    const def = makeDef([loop('w1', ['a1']), agentNode('a1', 'fixer')])
    const { container } = render(
      <Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['design'] })} />,
    )
    // The kind <select> is the only select that has these 4 option values.
    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
    const kindSelect = selects.find((s) => {
      const vals = Array.from(s.options).map((o) => o.value)
      return vals.includes('port-empty') && vals.includes('port-equals')
    })!
    const optionValues = Array.from(kindSelect.options).map((o) => o.value)
    expect(optionValues).toEqual(['port-empty', 'port-not-empty', 'port-equals', 'port-count-lt'])
  })

  test('switching to port-not-empty persists kind in the definition', () => {
    const def = makeDef([loop('w1', ['a1']), agentNode('a1', 'fixer')])
    function ChangeHost() {
      const [d, setD] = useState(def)
      return (
        <>
          <NodeInspector
            definition={d}
            selectedNodeId="w1"
            agents={fakeAgents({ name: 'fixer', outputs: ['design'] })}
            onChange={setD}
            onClose={() => {}}
          />
          <pre data-testid="snapshot">{JSON.stringify(d)}</pre>
        </>
      )
    }
    const { container } = render(<ChangeHost />)
    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
    const kindSelect = selects.find((s) =>
      Array.from(s.options)
        .map((o) => o.value)
        .includes('port-not-empty'),
    )!
    fireEvent.change(kindSelect, { target: { value: 'port-not-empty' } })
    const snap = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    const loopNode = snap.nodes.find((n: { id: string }) => n.id === 'w1')
    expect(loopNode.exitCondition.kind).toBe('port-not-empty')
  })

  test('changing exitCondition.nodeId triggers a definition update', () => {
    const def = makeDef([
      loop('w1', ['a1', 'a2']),
      agentNode('a1', 'fixer'),
      agentNode('a2', 'check'),
    ])
    function ChangeHost() {
      const [d, setD] = useState(def)
      return (
        <NodeInspector
          definition={d}
          selectedNodeId="w1"
          agents={fakeAgents(
            { name: 'fixer', outputs: ['passed'] },
            { name: 'check', outputs: ['result'] },
          )}
          onChange={setD}
          onClose={() => {}}
        />
      )
    }
    render(<ChangeHost />)
    const select = screen.getByTestId('loop-exit-node-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'a2' } })
    // After re-render the select value should reflect the new selection.
    const after = screen.getByTestId('loop-exit-node-select') as HTMLSelectElement
    expect(after.value).toBe('a2')
  })
})
