// RFC-616 §11.3 — metric heat overlay on the workflow canvas (process-metrics page).
//
// The metrics page reuses the read-only task canvas and colours nodes by a
// metric through one optional WorkflowCanvas prop, `nodeHeat`. Every other
// canvas (editor, task detail, previews) must keep rendering exactly what it
// rendered before. This file locks both halves, from the data projection out
// to the stylesheet:
//   1. toFlowNodes stamps data.heat only on nodes that own an entry in
//      `nodeHeat` — any kind, cards and wrapper frames alike — and stamps
//      NOTHING when no map is passed: node data is deep-equal to the projection
//      made without the argument (golden-lock; existing canvas tests rely on it).
//   2. Every card-shaped renderer prints `data-heat` on the card root plus one
//      `.canvas-node__heat` line. A render without heat is the heat markup minus
//      exactly that attribute and that line.
//   3. A wrapper frame prints `data-heat` and the label on its header strip only
//      — never on the frame, which holds other nodes.
//   4. WorkflowCanvas threads the prop to the right nodes and repaints on a
//      nodeHeat-ONLY change (ref-guard AND effect dependency — the RFC-245
//      lesson: a ref-guard without the dependency never re-runs the rebuild).
//   5. styles.css colours canvas heat with the `--viz-heat-*` tokens only, one
//      token pair per step, declared after the status overlay so the fill wins.

import type { ElementType } from 'react'
import { describe, expect, test } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  WorkflowCanvas,
  __testToFlowNodes as toFlowNodes,
} from '../src/components/canvas/WorkflowCanvas'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import { CallWorkflowNode } from '../src/components/canvas/nodes/CallWorkflowNode'
import { CallWorkgroupNode } from '../src/components/canvas/nodes/CallWorkgroupNode'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CodeHostCallNode } from '../src/components/canvas/nodes/CodeHostCallNode'
import { CodeRoundNode } from '../src/components/canvas/nodes/CodeRoundNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import { InputNode } from '../src/components/canvas/nodes/InputNode'
import { OutputNode } from '../src/components/canvas/nodes/OutputNode'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import { ScriptNode } from '../src/components/canvas/nodes/ScriptNode'
import { GroupWrapperNode, type WrapperNodeData } from '../src/components/canvas/nodes/WrapperNodes'
import type { CanvasNodeData, CanvasNodeHeat } from '../src/components/canvas/nodes/types'
import i18n from '../src/i18n'
import {
  HEAT_LEVELS,
  heatColourViolations,
  heatRules,
  markupWithoutHeat,
  parseRules,
  readStyles,
} from './rfc616-heat.helpers'

const HOT: CanvasNodeHeat = { level: 4, label: '3m 12s' }
const COOL: CanvasNodeHeat = { level: 2, label: '41s' }

// --- group 1: toFlowNodes injection (golden-lock) ---------------------------

// nodeHeat is the 15th positional argument (appended after callNavs, arg 14).
function flowWithHeat(
  nodes: Array<Record<string, unknown>>,
  nodeHeat?: Readonly<Record<string, CanvasNodeHeat>>,
  callNavs?: Record<string, 'child'>,
) {
  return toFlowNodes(
    nodes as never,
    [],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'task',
    undefined,
    callNavs,
    nodeHeat,
  )
}

function dataOf(flow: ReturnType<typeof toFlowNodes>, id: string): CanvasNodeData {
  const node = flow.find((candidate) => candidate.id === id)
  expect(node, `flow node ${id}`).toBeDefined()
  return node?.data as CanvasNodeData
}

describe('toFlowNodes heat propagation (golden-lock)', () => {
  test('stamps data.heat on a card node present in the map', () => {
    const flow = flowWithHeat([{ id: 'a1', kind: 'agent-single' }], { a1: HOT })
    expect(dataOf(flow, 'a1').heat).toEqual(HOT)
  })

  test('is not tied to a node kind: a wrapper frame present in the map gets it too', () => {
    const flow = flowWithHeat(
      [
        { id: 'w1', kind: 'wrapper-git', nodeIds: ['a1'] },
        { id: 'a1', kind: 'agent-single' },
      ],
      { w1: COOL },
    )
    expect(dataOf(flow, 'w1').heat).toEqual(COOL)
    expect('heat' in dataOf(flow, 'a1')).toBe(false)
  })

  test('a node absent from the map carries no heat key at all', () => {
    const flow = flowWithHeat(
      [
        { id: 'a1', kind: 'agent-single' },
        { id: 'a2', kind: 'agent-single' },
      ],
      { a1: HOT },
    )
    expect('heat' in dataOf(flow, 'a2')).toBe(false)
  })

  test('no map supplied ⇒ node data is deep-equal to the projection without the argument', () => {
    const nodes = [
      { id: 'w1', kind: 'wrapper-git', nodeIds: ['a1'] },
      { id: 'a1', kind: 'agent-single' },
      { id: 'in', kind: 'input', inputKey: 'topic' },
    ]
    // The 14-argument shape every pre-RFC-616 caller uses.
    const before = toFlowNodes(
      nodes as never,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'task',
      undefined,
      undefined,
    )
    const after = flowWithHeat(nodes)
    expect(after).toEqual(before)
    for (const node of after) expect('heat' in (node.data as CanvasNodeData)).toBe(false)
  })

  test('an empty map stamps nothing either', () => {
    const flow = flowWithHeat([{ id: 'a1', kind: 'agent-single' }], {})
    expect('heat' in dataOf(flow, 'a1')).toBe(false)
  })

  test('a node id that only matches an inherited object member gets no heat', () => {
    // Node ids are free text. A bare `nodeHeat[id]` lookup would hand the node
    // id `constructor` the Object constructor as its "heat".
    const flow = flowWithHeat(
      [
        { id: 'constructor', kind: 'agent-single' },
        { id: 'toString', kind: 'agent-single' },
        { id: 'a1', kind: 'agent-single' },
      ],
      { a1: HOT },
    )
    expect('heat' in dataOf(flow, 'constructor')).toBe(false)
    expect('heat' in dataOf(flow, 'toString')).toBe(false)
    expect(dataOf(flow, 'a1').heat).toEqual(HOT)
  })

  test('an own entry under such an id is still honoured', () => {
    const flow = flowWithHeat([{ id: 'constructor', kind: 'agent-single' }], { constructor: COOL })
    expect(dataOf(flow, 'constructor').heat).toEqual(COOL)
  })

  test('appending at position 15 leaves callNavs (position 14) intact', () => {
    const flow = flowWithHeat(
      [{ id: 'c1', kind: 'call-workflow' }],
      { c1: HOT },
      {
        c1: 'child',
      },
    )
    const data = dataOf(flow, 'c1')
    expect(data.callNav).toBe('child')
    expect(data.heat).toEqual(HOT)
    expect(data.surface).toBe('task')
  })
})

// --- group 2: card renderers ------------------------------------------------

function cardData(kind: CanvasNodeData['kind'], heat?: CanvasNodeHeat): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: `${kind}-node`,
    kind,
    title: `${kind} title`,
    inputPorts: ['request'],
    outputPorts: ['result'],
    ...(kind === 'call-workflow' ? { workflowName: 'release-pipeline' } : {}),
    ...(kind === 'call-workgroup' ? { workgroupName: 'review-council' } : {}),
    ...(heat === undefined ? {} : { heat }),
  }
}

function renderNode(Component: ElementType, data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      <Component data={data} selected={false} id={data.nodeId} type={data.kind} />
    </ReactFlowProvider>,
  )
}

// Every card-shaped renderer registered in WorkflowCanvas' NODE_TYPES. They all
// share CanvasNodeCard, which is where heat is printed — a kind that stopped
// using the shared shell would fall out of this table's contract.
const CARD_RENDERERS: Array<{ kind: CanvasNodeData['kind']; Component: ElementType }> = [
  { kind: 'agent-single', Component: AgentNode },
  { kind: 'input', Component: InputNode },
  { kind: 'output', Component: OutputNode },
  { kind: 'review', Component: ReviewNode },
  { kind: 'clarify', Component: ClarifyNode },
  { kind: 'clarify-cross-agent', Component: CrossClarifyNode },
  { kind: 'call-workflow', Component: CallWorkflowNode },
  { kind: 'call-workgroup', Component: CallWorkgroupNode },
  { kind: 'script', Component: ScriptNode },
  { kind: 'code-host-call', Component: CodeHostCallNode },
  { kind: 'code-round', Component: CodeRoundNode },
]

describe('card renderers with heat', () => {
  test.each(CARD_RENDERERS)(
    '$kind prints data-heat on the card root and one label line',
    ({ kind, Component }) => {
      const { container } = renderNode(Component, cardData(kind, HOT))
      const card = container.querySelector(`.canvas-node--card[data-node-kind="${kind}"]`)
      expect(card).not.toBeNull()
      expect(card?.getAttribute('data-heat')).toBe('4')

      const labels = container.querySelectorAll('.canvas-node__heat')
      expect(labels).toHaveLength(1)
      expect(labels[0]?.textContent).toBe('3m 12s')
      // A direct child of the card, right under the identity block.
      expect(labels[0]?.parentElement).toBe(card)
      expect(labels[0]?.previousElementSibling?.classList.contains('canvas-node__id')).toBe(true)
      // Nothing inside the card repeats the attribute.
      expect(container.querySelectorAll('[data-heat]')).toHaveLength(1)
    },
  )

  test.each(CARD_RENDERERS)(
    '$kind without heat is the heat markup minus the attribute and the label (golden-lock)',
    ({ kind, Component }) => {
      const plain = renderNode(Component, cardData(kind))
      const plainCard = plain.container.querySelector('.canvas-node--card')
      expect(plainCard).not.toBeNull()
      expect(plainCard?.hasAttribute('data-heat')).toBe(false)
      expect(plain.container.querySelector('[data-heat]')).toBeNull()
      expect(plain.container.querySelector('.canvas-node__heat')).toBeNull()
      // Nothing to take out of the plain render, so this is its markup as is.
      const plainMarkup = markupWithoutHeat(plain.container)
      plain.unmount()

      const heated = renderNode(Component, cardData(kind, HOT))
      expect(heated.container.querySelector('[data-heat]')).not.toBeNull()
      expect(markupWithoutHeat(heated.container)).toBe(plainMarkup)
    },
  )

  test('each step is printed as its own attribute value', () => {
    for (const level of HEAT_LEVELS) {
      const view = renderNode(
        AgentNode,
        cardData('agent-single', { level, label: `step ${level}` }),
      )
      const card = view.container.querySelector('.canvas-node--card')
      expect(card?.getAttribute('data-heat')).toBe(String(level))
      expect(view.container.querySelector('.canvas-node__heat')?.textContent).toBe(`step ${level}`)
      view.unmount()
    }
  })

  test('on the editor surface the label follows the configuration summary instead', () => {
    const { container } = renderNode(AgentNode, {
      ...cardData('agent-single', HOT),
      surface: 'editor',
    })
    const label = container.querySelector('.canvas-node__heat')
    expect(label?.textContent).toBe('3m 12s')
    expect(label?.previousElementSibling?.classList.contains('canvas-node__configuration')).toBe(
      true,
    )
  })
})

// --- group 3: wrapper frames ------------------------------------------------

function wrapperData(kind: WrapperNodeData['kind'], heat?: CanvasNodeHeat): WrapperNodeData {
  return {
    surface: 'task',
    nodeId: `${kind}-node`,
    kind,
    title: `${kind} title`,
    inputPorts: [],
    outputPorts: ['result'],
    innerCount: 2,
    ...(heat === undefined ? {} : { heat }),
  }
}

function renderWrapper(data: WrapperNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <GroupWrapperNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

const WRAPPER_KINDS: Array<{ kind: WrapperNodeData['kind'] }> = [
  { kind: 'wrapper-git' },
  { kind: 'wrapper-loop' },
  { kind: 'wrapper-fanout' },
]

describe('wrapper frames with heat', () => {
  test.each(WRAPPER_KINDS)('$kind fills its header strip only, never the frame', ({ kind }) => {
    const { container } = renderWrapper(wrapperData(kind, COOL))
    const frame = container.querySelector('.canvas-node--wrapper-group')
    expect(frame).not.toBeNull()
    // The frame holds other nodes: colouring it would bury their own heat.
    expect(frame?.hasAttribute('data-heat')).toBe(false)

    const header = frame?.querySelector('.canvas-node__header')
    expect(header?.getAttribute('data-heat')).toBe('2')
    expect(header?.parentElement).toBe(frame)

    const labels = container.querySelectorAll('.canvas-node__heat')
    expect(labels).toHaveLength(1)
    expect(labels[0]?.textContent).toBe('41s')
    expect(labels[0]?.parentElement).toBe(header)
    expect(container.querySelectorAll('[data-heat]')).toHaveLength(1)
    // The kind pill stays in the header next to the label.
    expect(header?.querySelector('.wrapper-header-pill')).not.toBeNull()
  })

  test.each(WRAPPER_KINDS)(
    '$kind without heat is the heat markup minus the attribute and the label (golden-lock)',
    ({ kind }) => {
      const plain = renderWrapper(wrapperData(kind))
      expect(plain.container.querySelector('.canvas-node--wrapper-group')).not.toBeNull()
      expect(plain.container.querySelector('[data-heat]')).toBeNull()
      expect(plain.container.querySelector('.canvas-node__heat')).toBeNull()
      const plainMarkup = markupWithoutHeat(plain.container)
      plain.unmount()

      const heated = renderWrapper(wrapperData(kind, COOL))
      expect(heated.container.querySelector('[data-heat]')).not.toBeNull()
      expect(markupWithoutHeat(heated.container)).toBe(plainMarkup)
    },
  )
})

// --- group 4: the WorkflowCanvas prop ----------------------------------------

const FRONTEND = path.dirname(fileURLToPath(import.meta.url))
const readSource = (rel: string) => readFileSync(path.join(FRONTEND, '..', rel), 'utf8')

describe('WorkflowCanvas nodeHeat prop', () => {
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'w1', kind: 'wrapper-git', nodeIds: ['a1'], position: { x: 20, y: 20 } },
      { id: 'a1', kind: 'agent-single', agentName: 'coder', position: { x: 80, y: 80 } },
      { id: 'a2', kind: 'agent-single', agentName: 'coder', position: { x: 520, y: 80 } },
    ] as unknown as WorkflowNode[],
    edges: [],
  }
  // STABLE identities for every other input (the RFC-245 lesson): an inline
  // `agents={[]}` mints a new array per render, flips the canvas' agents guard
  // and rebuilds the nodes for the wrong reason — the repaint test below would
  // then pass even with the `nodeHeat` dependency removed.
  const NO_AGENTS: never[] = []
  const view = (nodeHeat?: Readonly<Record<string, CanvasNodeHeat>>) => (
    <I18nextProvider i18n={i18n}>
      <WorkflowCanvas
        surface="task"
        definition={definition}
        agents={NO_AGENTS}
        nodeHeat={nodeHeat}
        readOnly
      />
    </I18nextProvider>
  )
  const flowNode = (container: HTMLElement, id: string) =>
    container.querySelector(`.react-flow__node[data-id="${id}"]`)
  const mounted = async (container: HTMLElement) => {
    await waitFor(() => {
      for (const id of ['w1', 'a1', 'a2']) expect(flowNode(container, id), id).not.toBeNull()
    })
  }

  test('colours the mapped card and wrapper header and leaves the other node alone', async () => {
    const { container } = render(
      view({ a1: { level: 5, label: '4m 02s' }, w1: { level: 1, label: '1m 10s' } }),
    )
    await mounted(container)

    const card = flowNode(container, 'a1')?.querySelector('.canvas-node--card')
    expect(card?.getAttribute('data-heat')).toBe('5')
    expect(card?.querySelector('.canvas-node__heat')?.textContent).toBe('4m 02s')

    const frame = flowNode(container, 'w1')?.querySelector('.canvas-node--wrapper-group')
    expect(frame).not.toBeNull()
    expect(frame?.hasAttribute('data-heat')).toBe(false)
    const header = frame?.querySelector('.canvas-node__header')
    expect(header?.getAttribute('data-heat')).toBe('1')
    expect(header?.querySelector('.canvas-node__heat')?.textContent).toBe('1m 10s')

    const other = flowNode(container, 'a2')
    expect(other?.querySelector('.canvas-node--card')).not.toBeNull()
    expect(other?.querySelector('[data-heat]')).toBeNull()
    expect(other?.querySelector('.canvas-node__heat')).toBeNull()
    expect(container.querySelectorAll('[data-heat]')).toHaveLength(2)
  })

  test('without the prop no node carries heat', async () => {
    const { container } = render(view(undefined))
    await mounted(container)
    expect(container.querySelector('[data-heat]')).toBeNull()
    expect(container.querySelector('.canvas-node__heat')).toBeNull()
  })

  test('repaints on a nodeHeat-ONLY change: absent → step 1 → step 5 → absent', async () => {
    // Same definition object and same agents array in every render, so nodeHeat
    // is the only input that changes.
    const { container, rerender } = render(view(undefined))
    await mounted(container)
    const card = () => flowNode(container, 'a1')?.querySelector('.canvas-node--card')
    expect(container.querySelector('[data-heat]')).toBeNull()

    // the metrics page picks a metric
    rerender(view({ a1: { level: 1, label: 'low' } }))
    expect(card()?.getAttribute('data-heat')).toBe('1')
    expect(card()?.querySelector('.canvas-node__heat')?.textContent).toBe('low')

    // …switches to another metric
    rerender(view({ a1: { level: 5, label: 'high' } }))
    expect(card()?.getAttribute('data-heat')).toBe('5')
    expect(card()?.querySelector('.canvas-node__heat')?.textContent).toBe('high')

    // …and turns heat off again
    rerender(view({}))
    expect(container.querySelector('[data-heat]')).toBeNull()
    expect(container.querySelector('.canvas-node__heat')).toBeNull()
    rerender(view(undefined))
    expect(container.querySelector('[data-heat]')).toBeNull()
  })

  test('nodeHeat is in the def-sync effect dependency array, not just the ref-guard', () => {
    const src = readSource('src/components/canvas/WorkflowCanvas.tsx')
    // ref-guard
    expect(src).toMatch(/const externalNodeHeatRef = useRef\(nodeHeat\)/)
    expect(src).toMatch(/const nodeHeatChanged = nodeHeat !== externalNodeHeatRef\.current/)
    expect(src).toMatch(/externalNodeHeatRef\.current = nodeHeat\n/)
    // …and the dependency that makes the effect run at all. The array is the
    // one ending in `workflowByRef,\n  ])` right after the def-sync effect body.
    const effectIdx = src.indexOf('const nodeHeatChanged =')
    const depsIdx = src.indexOf('workflowByRef,\n  ])', effectIdx)
    expect(depsIdx).toBeGreaterThan(effectIdx)
    expect(src.slice(effectIdx, depsIdx)).toMatch(/\n {4}nodeHeat,\n/)
  })

  test('every toFlowNodes call site passes nodeHeat right after callNavs', () => {
    const src = readSource('src/components/canvas/WorkflowCanvas.tsx')
    // initial state / def-sync rebuild / rejected-delete rebuild + the test export.
    const occurrences = src.match(/\n\s*callNavs,\n\s*nodeHeat,\n\s*\)/g) ?? []
    expect(occurrences).toHaveLength(4)
  })
})

// --- group 5: styles --------------------------------------------------------

describe('canvas heat styles', () => {
  const css = readStyles()
  const rules = heatRules(css, '.canvas-node')

  test('corpus is not empty: the canvas heat rules were actually read', () => {
    // 5 card fills + 5 header fills + the label and the ink rules.
    expect(rules.length).toBeGreaterThanOrEqual(14)
  })

  test('each step maps to its own token pair, on the card and on the wrapper header', () => {
    for (const level of HEAT_LEVELS) {
      for (const selector of [
        `.canvas-node--card[data-heat='${level}']`,
        `.canvas-node--wrapper-group > .canvas-node__header[data-heat='${level}']`,
      ]) {
        const rule = rules.find((candidate) => candidate.selector === selector)
        expect(rule, selector).toBeDefined()
        expect(rule?.declarations).toEqual([
          { property: 'background', value: `var(--viz-heat-${level})` },
          { property: 'color', value: `var(--viz-heat-${level}-ink)` },
        ])
      }
    }
  })

  test('heat styles reference the --viz-heat-* tokens only: no other token, no literal', () => {
    expect(heatColourViolations(rules)).toEqual([])
  })

  test('the tokens exist for the light theme and both dark-theme declarations', () => {
    for (const level of HEAT_LEVELS) {
      for (const token of [`--viz-heat-${level}`, `--viz-heat-${level}-ink`]) {
        const declared = css.match(new RegExp(`${token}:\\s`, 'g')) ?? []
        // :root, :root[data-theme='dark'] and the prefers-color-scheme fallback.
        expect(declared.length, token).toBeGreaterThanOrEqual(3)
      }
    }
  })

  test('the card fill is declared after the base card and the status overlay', () => {
    const base = css.indexOf('.canvas-node--card {')
    const lastStatus = css.lastIndexOf(".canvas-node[data-status='")
    const fill = css.indexOf(".canvas-node--card[data-heat='1'] {")
    expect(base).toBeGreaterThanOrEqual(0)
    expect(lastStatus).toBeGreaterThanOrEqual(0)
    // Later in the file AND one attribute more specific than `.canvas-node--card`:
    // the fill wins over the base gradient and over anything a status rule sets.
    expect(fill).toBeGreaterThan(base)
    expect(fill).toBeGreaterThan(lastStatus)
  })

  test('text on the card surface follows the heat ink', () => {
    const ink = rules.find(
      (rule) =>
        rule.selector.startsWith('.canvas-node--card[data-heat] :is(') &&
        rule.declarations.some(
          (declaration) => declaration.property === 'color' && declaration.value === 'inherit',
        ),
    )
    expect(ink).toBeDefined()
    for (const part of [
      '.canvas-node__kind',
      '.canvas-node__title',
      '.canvas-node__id',
      '.canvas-node__port-row',
      '.muted',
    ]) {
      expect(ink?.selector, part).toContain(part)
    }
  })

  test('no rule fills the wrapper frame itself', () => {
    for (const { selector } of rules) {
      expect(selector, selector).not.toMatch(/\.canvas-node--wrapper-group[\w-]*\[data-heat/)
    }
  })

  test('oracle self-check: a foreign token, a literal and a named colour are each reported', () => {
    const fabricated = parseRules(`
      .canvas-node--card[data-heat='1'] { background: var(--accent); }
      .canvas-node--card[data-heat='2'] { color: #fff; }
      .canvas-node--card[data-heat='3'] {
        background: color-mix(in srgb, var(--viz-heat-3) 50%, transparent);
      }
      .canvas-node--card[data-heat='4'] { color: white; }
      .canvas-node--card[data-heat='5'] {
        background: var(--viz-heat-5);
        color: var(--viz-heat-5-ink);
      }
    `)
    const violations = heatColourViolations(fabricated)
    const reported = (level: number) =>
      violations.filter((violation) => violation.includes(`[data-heat='${level}']`))
    expect(reported(1).join('\n')).toContain('foreign token --accent')
    expect(reported(2).join('\n')).toContain('colour literal')
    expect(reported(3).join('\n')).toContain('colour literal')
    expect(reported(4).join('\n')).toContain('colour keyword white')
    // …and the clean rule contributes nothing.
    expect(reported(5)).toEqual([])
  })
})
