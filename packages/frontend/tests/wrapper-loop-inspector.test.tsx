// RFC-016 §5 / T7 / C4 → RFC-354 (schema v6): the NodeInspector loop wrapper
// form. The exit condition names one of the loop's OWN return ports, and a
// return is a `wrapper-output` edge from a member's output to the loop — so
// the exit target is a candidate-driven <Select> over the loop's return ports
// (not a hand-typed string, not a member/port pair), and the returns
// themselves render as a read-only list derived from the edges. Red here
// means either contract regressed.
//
// The drop-downs are the shared <Select> (RFC-036): a role=combobox trigger
// (carrying the data-testid) plus a portaled role=listbox of role=option rows.

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { LOOP_EXIT_CONDITION_KINDS } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'

function makeDef(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return { $schema_version: 6, inputs: [], nodes, edges } as WorkflowDefinition
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
    agentId: `agent-${agentName}`,
    agentName,
  } as unknown as WorkflowNode
}
/** RFC-354: a loop return = a `wrapper-output` edge member.port → loop.name. */
function returnEdge(id: string, loopId: string, memberId: string, port: string, name: string) {
  return {
    id,
    source: { nodeId: memberId, portName: port },
    target: { nodeId: loopId, portName: name },
    boundary: 'wrapper-output',
  } as WorkflowEdge
}

function fakeAgents(...defs: Array<{ name: string; outputs: string[] }>): Agent[] {
  return defs.map((def) => ({ ...def, id: `agent-${def.name}` })) as unknown as Agent[]
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
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
})

// Open a Select trigger and return ITS portaled listbox (resolved via
// aria-controls, so a listbox left open by a prior assertion can't shadow it).
function openTrigger(trigger: HTMLElement): HTMLElement {
  fireEvent.click(trigger)
  const id = trigger.getAttribute('aria-controls')
  const list = id !== null ? document.getElementById(id) : null
  if (list === null) throw new Error('listbox not found for trigger')
  return list
}
function openByTestId(testid: string): HTMLElement {
  return openTrigger(screen.getByTestId(testid))
}
// Find the (only) combobox trigger whose displayed text matches `re`.
function comboboxShowing(re: RegExp): HTMLElement {
  const found = screen.getAllByRole('combobox').find((c) => re.test(c.textContent ?? ''))
  if (found === undefined) throw new Error(`no combobox showing ${re}`)
  return found
}
// Option label text only — the selected row also carries a "✓" check span.
function optionLabels(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll('[role="option"]')).map(
    (o) => o.querySelector('.select__option-label')?.textContent ?? '',
  )
}

describe('loop NodeInspector — RFC-354 return ports + candidate-driven exit target', () => {
  test('max-iteration continuation switch is directly after the limit and persists its value', () => {
    const def = makeDef([loop('w1', ['a1']), agentNode('a1', 'fixer')])
    function ChangeHost() {
      const [d, setD] = useState(def)
      return (
        <>
          <NodeInspector
            definition={d}
            selectedNodeId="w1"
            agents={fakeAgents({ name: 'fixer', outputs: ['findings'] })}
            onChange={setD}
            onClose={() => {}}
          />
          <pre data-testid="snapshot">{JSON.stringify(d)}</pre>
        </>
      )
    }

    const { container } = render(<ChangeHost />)
    const fields = Array.from(container.querySelectorAll('[data-inspector-field]')).map((field) =>
      field.getAttribute('data-inspector-field'),
    )
    const maxIterationsIndex = fields.indexOf('loop-max-iterations')
    expect(fields[maxIterationsIndex + 1]).toBe('loop-continue-on-max-iterations')

    const policySwitch = screen.getByTestId('loop-continue-on-max-iterations')
    expect((policySwitch as HTMLInputElement).checked).toBe(false)
    fireEvent.click(policySwitch)
    expect((policySwitch as HTMLInputElement).checked).toBe(true)

    const snap = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    const loopNode = snap.nodes.find((node: { id: string }) => node.id === 'w1')
    expect(loopNode.continueOnMaxIterations).toBe(true)
  })

  test('the return list renders one row per wrapper-output edge (name ← member.port)', () => {
    const def = makeDef(
      [loop('w1', ['a1', 'a2']), agentNode('a1', 'fixer'), agentNode('a2', 'check')],
      [
        returnEdge('r1', 'w1', 'a1', 'passed', 'final'),
        returnEdge('r2', 'w1', 'a2', 'result', 'verdict'),
      ],
    )
    render(
      <Host
        initial={def}
        agents={fakeAgents(
          { name: 'fixer', outputs: ['passed'] },
          { name: 'check', outputs: ['result'] },
        )}
      />,
    )
    const list = screen.getByTestId('loop-return-list')
    expect(list.textContent).toContain('final')
    expect(list.textContent).toContain('a1')
    expect(list.textContent).toContain('passed')
    expect(list.textContent).toContain('verdict')
    expect(list.textContent).toContain('a2')
    // No member picker and no "add binding" editor exist any more.
    expect(screen.queryByTestId('loop-exit-node-select')).toBeNull()
    expect(screen.queryByText('+ Add binding')).toBeNull()
  })

  test('exitCondition.portName options are exactly the loop return ports, not member ports', () => {
    const def = makeDef(
      [loop('w1', ['a1', 'a2']), agentNode('a1', 'fixer'), agentNode('a2', 'check')],
      [
        returnEdge('r1', 'w1', 'a1', 'passed', 'final'),
        returnEdge('r2', 'w1', 'a2', 'result', 'verdict'),
      ],
    )
    render(
      <Host
        initial={def}
        agents={fakeAgents(
          { name: 'fixer', outputs: ['passed', 'issues'] },
          { name: 'check', outputs: ['result'] },
        )}
      />,
    )
    const labels = optionLabels(openByTestId('loop-exit-port-select'))
    expect(labels).toContain('final')
    expect(labels).toContain('verdict')
    expect(labels).not.toContain('passed')
    expect(labels).not.toContain('issues')
    expect(labels).not.toContain('result')
  })

  test('a stale exitCondition.portName (return edge removed) renders the missing tag + red hint', () => {
    const def = makeDef(
      [
        loop('w1', ['a1'], { exitCondition: { kind: 'port-empty', portName: 'gone' } }),
        agentNode('a1', 'fixer'),
      ],
      [returnEdge('r1', 'w1', 'a1', 'passed', 'final')],
    )
    render(<Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['passed'] })} />)
    const trigger = screen.getByTestId('loop-exit-port-select')
    expect(trigger.textContent).toMatch(/gone/)
    expect(trigger.classList.contains('form-input--invalid')).toBe(true)
    expect(document.body.textContent ?? '').toMatch(/gone/)
  })

  test('exitCondition.kind dropdown lists every LOOP_EXIT_CONDITION_KINDS roster kind (RFC-023 port-not-empty, RFC-306 port-inactive; RFC-348 derives the options from the roster)', () => {
    const def = makeDef([loop('w1', ['a1']), agentNode('a1', 'fixer')])
    render(<Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['design'] })} />)
    // The kind dropdown is the combobox currently showing the default kind.
    expect(optionLabels(openTrigger(comboboxShowing(/port-empty/)))).toEqual([
      ...LOOP_EXIT_CONDITION_KINDS,
    ])
    expect(LOOP_EXIT_CONDITION_KINDS).toContain('port-not-empty')
    expect(LOOP_EXIT_CONDITION_KINDS).toContain('port-inactive')
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
    render(<ChangeHost />)
    const kindList = openTrigger(comboboxShowing(/port-empty/))
    fireEvent.mouseDown(within(kindList).getByText('port-not-empty'))
    const snap = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    const loopNode = snap.nodes.find((n: { id: string }) => n.id === 'w1')
    expect(loopNode.exitCondition.kind).toBe('port-not-empty')
  })

  test('switching to port-count-lt persists the displayed default n', () => {
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
    render(<ChangeHost />)
    const kindList = openTrigger(comboboxShowing(/port-empty/))
    fireEvent.mouseDown(within(kindList).getByText('port-count-lt'))
    const snap = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    const loopNode = snap.nodes.find((n: { id: string }) => n.id === 'w1')
    expect(loopNode.exitCondition).toMatchObject({ kind: 'port-count-lt', n: 1 })
  })

  test('picking a return port writes exitCondition.portName only — never a nodeId', () => {
    const def = makeDef(
      [loop('w1', ['a1', 'a2']), agentNode('a1', 'fixer'), agentNode('a2', 'check')],
      [
        returnEdge('r1', 'w1', 'a1', 'passed', 'final'),
        returnEdge('r2', 'w1', 'a2', 'result', 'verdict'),
      ],
    )
    function ChangeHost() {
      const [d, setD] = useState(def)
      return (
        <>
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
          <pre data-testid="snapshot">{JSON.stringify(d)}</pre>
        </>
      )
    }
    render(<ChangeHost />)
    fireEvent.mouseDown(within(openByTestId('loop-exit-port-select')).getByText('verdict'))
    expect(screen.getByTestId('loop-exit-port-select').textContent).toMatch(/verdict/)
    const snap = JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}')
    const loopNode = snap.nodes.find((n: { id: string }) => n.id === 'w1')
    expect(loopNode.exitCondition).toEqual({ kind: 'port-empty', portName: 'verdict' })
    expect('outputBindings' in loopNode).toBe(false)
  })
})
