// RFC-016 §5 / T7 / C4: NodeInspector loop wrapper form must surface
// exitCondition.nodeId and portName as candidate-driven drop-downs whose
// options come from loopMemberCandidates, not hand-typed strings. The same
// rule applies to outputBindings rows. Red here means the candidate-driven
// contract has regressed back to bare TextInputs — users would once again be
// free to enter ids that don't match any wrapper member.
//
// The drop-downs are the shared <Select> (RFC-036): a role=combobox trigger
// (carrying the data-testid) plus a portaled role=listbox of role=option rows.
// Candidate option labels are "title (nodeId)" (title = node.title ||
// agentName || nodeId), so we match options by their nodeId-in-parens text.

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

describe('loop NodeInspector candidate-driven selects', () => {
  test('exitCondition.nodeId renders as a select populated from loop members', () => {
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
    const labels = optionLabels(openByTestId('loop-exit-node-select'))
    expect(labels.some((l) => /\(a1\)/.test(l))).toBe(true)
    expect(labels.some((l) => /\(a2\)/.test(l))).toBe(true)
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
    const labels = optionLabels(openByTestId('loop-exit-port-select'))
    expect(labels).toContain('passed')
    expect(labels).toContain('issues')
    expect(labels).not.toContain('result')
  })

  test('stale exitCondition.nodeId (member removed) renders the missing tag + red hint', () => {
    const def = makeDef([
      loop('w1', ['a1'], {
        exitCondition: { kind: 'port-empty', nodeId: 'a2', portName: 'gone' },
      }),
      agentNode('a1', 'fixer'),
    ])
    render(<Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['passed'] })} />)
    const trigger = screen.getByTestId('loop-exit-node-select')
    // Trigger shows the stale value via the appended "(missing)" sentinel.
    expect(trigger.textContent).toMatch(/a2/)
    expect(trigger.classList.contains('form-input--invalid')).toBe(true)
    expect(document.body.textContent ?? '').toMatch(/a2/)
  })

  test('outputBindings nodeId / portName render as selects too (not TextInput)', () => {
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
    // Two shared-Select triggers (nodeId + portName) — both role=combobox.
    const combos = rows[0]!.querySelectorAll('[role="combobox"]')
    expect(combos.length).toBeGreaterThanOrEqual(2)
  })

  test('exitCondition.kind dropdown lists all 4 built-in kinds including port-not-empty (RFC-023)', () => {
    const def = makeDef([loop('w1', ['a1']), agentNode('a1', 'fixer')])
    render(<Host initial={def} agents={fakeAgents({ name: 'fixer', outputs: ['design'] })} />)
    // The kind dropdown is the combobox currently showing the default kind.
    expect(optionLabels(openTrigger(comboboxShowing(/port-empty/)))).toEqual([
      'port-empty',
      'port-not-empty',
      'port-equals',
      'port-count-lt',
    ])
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
    fireEvent.mouseDown(within(openByTestId('loop-exit-node-select')).getByText(/\(a2\)/))
    // After re-render the trigger should reflect the new selection.
    expect(screen.getByTestId('loop-exit-node-select').textContent).toMatch(/a2/)
  })
})
