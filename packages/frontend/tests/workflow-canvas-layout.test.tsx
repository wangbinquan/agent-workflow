import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRef, type ComponentType } from 'react'

type CapturedReactFlowProps = {
  nodes?: { id: string; selected?: boolean }[]
  edges?: { id: string; selected?: boolean }[]
  onMove?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void
  onNodeClick?: (event: unknown, node: { id: string }) => void
  onEdgeClick?: (event: unknown, edge: { id: string }) => void
}

function currentReactFlowProps(): CapturedReactFlowProps {
  const props = xyflowHarness.reactFlowProps
  if (props === null) throw new Error('ReactFlow props were not captured')
  return props
}

const xyflowHarness = vi.hoisted(() => ({
  fitView: vi.fn(async () => true),
  setCenter: vi.fn(
    async (_x: number, _y: number, _options: { zoom?: number; duration?: number }) => true,
  ),
  getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 2400, height: 1200 })),
  getInternalNode: vi.fn((id: string) => ({
    id,
    type: id === 'wrapper' ? 'wrapper-git' : 'agent-single',
    measured: id === 'wrapper' ? { width: 500, height: 420 } : { width: 200, height: 100 },
    internals: { positionAbsolute: { x: id === 'a' ? 600 : 0, y: 80 } },
  })),
  reactFlowProps: null as CapturedReactFlowProps | null,
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const React = await import('react')
  const actual = await importOriginal<
    Record<string, unknown> & { useReactFlow: () => ReactFlowInstance }
  >()
  const ActualReactFlow = actual.ReactFlow as ComponentType<Record<string, unknown>>
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      xyflowHarness.reactFlowProps = props as CapturedReactFlowProps
      return React.createElement(ActualReactFlow, props)
    },
    useNodesInitialized: () => true,
    useReactFlow: () => ({
      ...actual.useReactFlow(),
      fitView: xyflowHarness.fitView,
      setCenter: xyflowHarness.setCenter,
      getNodesBounds: xyflowHarness.getNodesBounds,
      getInternalNode: xyflowHarness.getInternalNode,
    }),
  }
})

import { WorkflowCanvas, type WorkflowCanvasHandle } from '../src/components/canvas/WorkflowCanvas'
import { READABLE_MIN_ZOOM } from '../src/components/canvas/canvasCamera'
import i18n from '../src/i18n'

function agentNode(id: string, x: number): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: id,
    position: { x, y: 80 },
  } as WorkflowNode
}

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [agentNode('a', 600), agentNode('b', 0)],
  edges: [
    {
      id: 'a-to-b',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'input' },
    },
  ],
}

const overviewSelectionDefinition: WorkflowDefinition = {
  ...definition,
  nodes: [
    ...definition.nodes,
    {
      id: 'wrapper',
      kind: 'wrapper-git',
      nodeIds: [],
      position: { x: 0, y: 320 },
      size: { width: 500, height: 420 },
    } as WorkflowNode,
  ],
}

beforeEach(() => {
  xyflowHarness.fitView.mockClear()
  xyflowHarness.setCenter.mockClear()
  xyflowHarness.getNodesBounds.mockClear()
  xyflowHarness.getInternalNode.mockClear()
  xyflowHarness.reactFlowProps = null
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-199 canvas auto-layout adapter', () => {
  test('whole-graph layout is one semantic history transaction, preserves graph data, and fits view', async () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={definition} onChange={onChange} />
      </I18nextProvider>,
    )

    expect(getByTestId('workflow-layout-selection')).toHaveProperty('disabled', true)
    fireEvent.click(getByTestId('workflow-layout-all'))

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const [next, meta] = onChange.mock.calls[0] as [
      WorkflowDefinition,
      { label: string; selectionBefore: null; selectionAfter: null },
    ]
    expect(next.edges).toEqual(definition.edges)
    expect(next.nodes.map(({ id, kind, agentName }) => ({ id, kind, agentName }))).toEqual(
      definition.nodes.map(({ id, kind, agentName }) => ({ id, kind, agentName })),
    )
    expect(next.nodes.find((node) => node.id === 'a')!.position!.x).toBeLessThan(
      next.nodes.find((node) => node.id === 'b')!.position!.x,
    )
    expect(meta.label).toMatch(/Auto-layout workflow|自动整理工作流/)
    expect(meta.selectionBefore).toBeNull()
    expect(meta.selectionAfter).toBeNull()
    expect(xyflowHarness.fitView).toHaveBeenCalledTimes(1)
  })

  test('read-only consumers do not expose layout mutation controls', () => {
    const { queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="task" definition={definition} readOnly />
      </I18nextProvider>,
    )
    expect(queryByTestId('workflow-layout-all')).toBeNull()
    expect(queryByTestId('workflow-layout-selection')).toBeNull()
  })

  test('imperative validation jumps focus nodes and edge midpoints at readable zoom', () => {
    const canvasRef = createRef<WorkflowCanvasHandle>()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          ref={canvasRef}
          surface="editor"
          definition={definition}
          onChange={() => undefined}
        />
      </I18nextProvider>,
    )

    act(() => canvasRef.current?.focusSelection({ kind: 'node', id: 'a' }))
    expect(xyflowHarness.setCenter).toHaveBeenLastCalledWith(
      700,
      130,
      expect.objectContaining({ zoom: expect.any(Number) }),
    )
    expect(xyflowHarness.setCenter.mock.calls.at(-1)?.[2]?.zoom).toBeGreaterThanOrEqual(
      READABLE_MIN_ZOOM,
    )

    act(() => canvasRef.current?.focusSelection({ kind: 'edge', id: 'a-to-b' }))
    expect(xyflowHarness.setCenter).toHaveBeenLastCalledWith(
      400,
      130,
      expect.objectContaining({ zoom: expect.any(Number) }),
    )
    expect(xyflowHarness.setCenter.mock.calls.at(-1)?.[2]?.zoom).toBeGreaterThanOrEqual(
      READABLE_MIN_ZOOM,
    )
  })

  test('authoritative owner epoch refits the same workflow exactly once without following ambient definition churn', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })
    const onChange = () => undefined
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          workflowId="workflow-one"
          authoritativeLoadEpoch={0}
          surface="editor"
          definition={definition}
          onChange={onChange}
        />
      </I18nextProvider>,
    )

    await waitFor(() => expect(xyflowHarness.setCenter).toHaveBeenCalledTimes(1))
    expect(xyflowHarness.setCenter.mock.calls[0]?.[2]?.zoom).toBeGreaterThanOrEqual(
      READABLE_MIN_ZOOM,
    )

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          workflowId="workflow-one"
          authoritativeLoadEpoch={0}
          surface="editor"
          definition={{ ...definition, nodes: [...definition.nodes] }}
          onChange={onChange}
        />
      </I18nextProvider>,
    )
    await Promise.resolve()
    expect(xyflowHarness.setCenter).toHaveBeenCalledTimes(1)

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          workflowId="workflow-one"
          authoritativeLoadEpoch={1}
          surface="editor"
          definition={definition}
          onChange={onChange}
        />
      </I18nextProvider>,
    )
    await waitFor(() => expect(xyflowHarness.setCenter).toHaveBeenCalledTimes(2))

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          workflowId="workflow-one"
          authoritativeLoadEpoch={1}
          surface="editor"
          definition={{ ...definition, edges: [...definition.edges] }}
          onChange={onChange}
        />
      </I18nextProvider>,
    )
    await Promise.resolve()
    expect(xyflowHarness.setCenter).toHaveBeenCalledTimes(2)

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          workflowId="workflow-two"
          authoritativeLoadEpoch={0}
          surface="editor"
          definition={definition}
          onChange={onChange}
        />
      </I18nextProvider>,
    )
    await waitFor(() => expect(xyflowHarness.setCenter).toHaveBeenCalledTimes(3))
  })

  // RFC-250 regression: selecting an overview target also crosses the inline-action
  // zoom threshold. That same-event rebuild must not erase xyflow's selected class
  // while the route Inspector remains open, or emit the route callback twice.
  test.each([
    {
      label: 'ordinary node',
      target: { kind: 'node' as const, id: 'a' },
      selector: '.react-flow__node[data-id="a"]',
    },
    {
      label: 'wrapper node',
      target: { kind: 'node' as const, id: 'wrapper' },
      selector: '.react-flow__node[data-id="wrapper"]',
    },
    {
      label: 'edge',
      target: { kind: 'edge' as const, id: 'a-to-b' },
      selector: '.react-flow__edge[data-id="a-to-b"]',
    },
  ])(
    'overview selection keeps $label visually selected and route emission deduplicated',
    async ({ target, selector }) => {
      const onSelect = vi.fn()
      const { container, getByTestId } = render(
        <I18nextProvider i18n={i18n}>
          <WorkflowCanvas
            surface="editor"
            definition={overviewSelectionDefinition}
            onChange={() => undefined}
            onSelect={onSelect}
          />
        </I18nextProvider>,
      )
      const canvas = container.querySelector<HTMLElement>('.workflow-canvas')
      expect(canvas).not.toBeNull()

      const selectFromOverview = () => {
        fireEvent.click(getByTestId('workflow-camera-overview'))
        act(() => {
          currentReactFlowProps().onMove?.(null, { x: 0, y: 0, zoom: 0.4 })
        })
        expect(canvas?.getAttribute('data-camera-mode')).toBe('overview')
        expect(canvas?.getAttribute('data-zoom-band')).toBe('topology')

        act(() => {
          const props = currentReactFlowProps()
          if (target.kind === 'node') props.onNodeClick?.(null, { id: target.id })
          else props.onEdgeClick?.(null, { id: target.id })
          props.onMove?.(null, { x: 0, y: 0, zoom: 1.15 })
        })
      }

      selectFromOverview()
      await waitFor(() => {
        expect(canvas?.getAttribute('data-camera-mode')).toBe('readable-focus')
        const props = currentReactFlowProps()
        const controlledItem = (target.kind === 'node' ? props.nodes : props.edges)?.find(
          (item) => item.id === target.id,
        )
        expect(controlledItem?.selected).toBe(true)
        if (target.kind === 'node') {
          expect(container.querySelector(selector)?.classList.contains('selected')).toBe(true)
        }
      })
      expect(xyflowHarness.setCenter.mock.calls.at(-1)?.[2]?.zoom).toBeGreaterThanOrEqual(
        READABLE_MIN_ZOOM,
      )
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenLastCalledWith(target)

      selectFromOverview()
      await waitFor(() => {
        const props = currentReactFlowProps()
        const controlledItem = (target.kind === 'node' ? props.nodes : props.edges)?.find(
          (item) => item.id === target.id,
        )
        expect(controlledItem?.selected).toBe(true)
      })
      expect(onSelect).toHaveBeenCalledTimes(1)
    },
  )
})
