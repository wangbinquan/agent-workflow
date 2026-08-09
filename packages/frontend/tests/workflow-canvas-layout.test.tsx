import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { ReactFlowInstance } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRef, StrictMode, type ComponentType } from 'react'

type CapturedReactFlowProps = {
  nodes?: { id: string; selected?: boolean }[]
  edges?: { id: string; selected?: boolean }[]
  onConnect?: (connection: {
    source: string
    target: string
    sourceHandle: string | null
    targetHandle: string | null
  }) => void
  onConnectStart?: () => void
  onConnectEnd?: (
    event: Event,
    connectionState: {
      fromHandle?: { id?: string | null; type?: string }
      fromNode?: { id?: string }
    },
  ) => void
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
  getNodes: null as
    | null
    | (() => Array<{
        id: string
        position: { x: number; y: number }
        measured: { width: number; height: number }
      }>),
  screenToFlowPosition: null as
    | null
    | ((point: { x: number; y: number }) => { x: number; y: number }),
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
    useReactFlow: () => {
      const instance = actual.useReactFlow()
      return {
        ...instance,
        fitView: xyflowHarness.fitView,
        setCenter: xyflowHarness.setCenter,
        getNodesBounds: xyflowHarness.getNodesBounds,
        getNodes: xyflowHarness.getNodes ?? instance.getNodes,
        screenToFlowPosition: xyflowHarness.screenToFlowPosition ?? instance.screenToFlowPosition,
        getInternalNode: xyflowHarness.getInternalNode,
      }
    },
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

const connectDefinition: WorkflowDefinition = { ...definition, edges: [] }
const validConnection = {
  source: 'a',
  target: 'b',
  sourceHandle: 'out',
  targetHandle: '__inbound__',
}
const sourceConnectionState = {
  fromHandle: { id: 'out', type: 'source' },
  fromNode: { id: 'a' },
}

function connectableHandle(): HTMLElement {
  const handle = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__handle')).find(
    (candidate) =>
      candidate.classList.contains('connectable') &&
      candidate.classList.contains('connectablestart'),
  )
  if (handle === undefined) throw new Error('expected a connectable canvas handle')
  return handle
}

function pressConnectHandle(pointerId: number): HTMLElement {
  const handle = connectableHandle()
  fireEvent.pointerDown(handle, { pointerId, pointerType: 'mouse', button: 0 })
  return handle
}

/**
 * Mirrors xyflow's installed document closure: registration happens at handle
 * down, threshold crossing emits start on mousemove, and mouseup synchronously
 * invokes onConnect before onConnectEnd. Using real DOM listeners makes the
 * FIFO order under overlapping old/new closures part of the regression lock.
 */
function installXyflowLikeDocumentClosure(label: string, order: string[]): void {
  const props = currentReactFlowProps()
  let started = false
  document.addEventListener(
    'mousemove',
    () => {
      started = true
      order.push(`${label}:start`)
      props.onConnectStart?.()
    },
    { once: true },
  )
  document.addEventListener(
    'mouseup',
    () => {
      if (!started) return
      order.push(`${label}:connect`)
      props.onConnect?.(validConnection)
      order.push(`${label}:end`)
      props.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    },
    { once: true },
  )
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
  xyflowHarness.getNodes = null
  xyflowHarness.screenToFlowPosition = null
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

  test('blur without an active gesture does not poison the next normal connection', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <StrictMode>
          <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
        </StrictMode>
      </I18nextProvider>,
    )

    act(() => window.dispatchEvent(new Event('blur')))
    const callsBeforeGesture = add.mock.calls.length
    act(() => {
      const props = currentReactFlowProps()
      props.onConnectStart?.()
      props.onConnect?.(validConnection)
      props.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as WorkflowDefinition
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'out' },
    })

    const firstPointerRegistration = add.mock.calls
      .slice(callsBeforeGesture)
      .find(([type]) => type === 'pointermove')
    expect(firstPointerRegistration).toBeDefined()
    const pointerListener = firstPointerRegistration?.[1]
    expect(
      remove.mock.calls.some(
        ([type, listener]) => type === 'pointermove' && listener === pointerListener,
      ),
    ).toBe(true)
  })

  test('an ordinary body drop still persists after FIFO gesture accounting', () => {
    xyflowHarness.getNodes = () => [
      {
        id: 'a',
        position: { x: 600, y: 80 },
        measured: { width: 200, height: 100 },
      },
      {
        id: 'b',
        position: { x: 0, y: 80 },
        measured: { width: 200, height: 100 },
      },
    ]
    xyflowHarness.screenToFlowPosition = (point) => point
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )

    act(() => {
      const props = currentReactFlowProps()
      props.onConnectStart?.()
      props.onConnectEnd?.(
        new MouseEvent('mouseup', { clientX: 100, clientY: 100 }),
        sourceConnectionState,
      )
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as WorkflowDefinition
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'out' },
    })
  })

  test('FIFO cancel debt rejects every late old callback while the fresh gesture persists once', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )

    // G1 is canceled, G2 starts before its stale xyflow closure drains, and a
    // second cancel marks both old FIFO callbacks. G3 is the fresh gesture.
    const callsBeforeGestures = add.mock.calls.length
    act(() => currentReactFlowProps().onConnectStart?.())
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => currentReactFlowProps().onConnectStart?.())
    act(() => document.dispatchEvent(new Event('pointercancel')))
    act(() => currentReactFlowProps().onConnectStart?.())

    const pointerListener = add.mock.calls
      .slice(callsBeforeGestures)
      .find(([type]) => type === 'pointermove')?.[1]
    expect(pointerListener).toBeTypeOf('function')
    const lastPointerOperation = (): 'add' | 'remove' | undefined => {
      const operations = [
        ...add.mock.calls.map((call, index) => ({
          kind: 'add' as const,
          call,
          order: add.mock.invocationCallOrder[index] ?? -1,
        })),
        ...remove.mock.calls.map((call, index) => ({
          kind: 'remove' as const,
          call,
          order: remove.mock.invocationCallOrder[index] ?? -1,
        })),
      ]
        .filter(({ call }) => call[0] === 'pointermove' && call[1] === pointerListener)
        .sort((a, b) => a.order - b.order)
      return operations.at(-1)?.kind
    }
    expect(lastPointerOperation()).toBe('add')

    // Installed xyflow invokes document listeners in registration order: each
    // old onConnect is followed by its old onConnectEnd before G3's callbacks.
    act(() => {
      const props = currentReactFlowProps()
      props.onConnect?.(validConnection)
      props.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(lastPointerOperation()).toBe('add')

    act(() => {
      const props = currentReactFlowProps()
      props.onConnect?.(validConnection)
      props.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(lastPointerOperation()).toBe('add')

    act(() => {
      const props = currentReactFlowProps()
      props.onConnect?.(validConnection)
      props.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(lastPointerOperation()).toBe('remove')
  })

  test('pre-threshold blur quarantines old late callbacks while the fresh DOM closure persists once', () => {
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )
    const order: string[] = []

    pressConnectHandle(1)
    installXyflowLikeDocumentClosure('old', order)
    fireEvent(window, new Event('blur'))

    pressConnectHandle(2)
    installXyflowLikeDocumentClosure('fresh', order)
    fireEvent.mouseMove(document, { clientX: 20, clientY: 20 })
    expect(order).toEqual(['old:start', 'fresh:start'])

    fireEvent.mouseUp(document, { clientX: 20, clientY: 20 })
    expect(order).toEqual([
      'old:start',
      'fresh:start',
      'old:connect',
      'old:end',
      'fresh:connect',
      'fresh:end',
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0]?.[0] as WorkflowDefinition).edges).toHaveLength(1)
  })

  test('a canceled pre-threshold press that ends without start does not poison recovery', () => {
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )

    pressConnectHandle(1)
    fireEvent(window, new Event('blur'))
    // xyflow removes a pre-threshold closure on this terminal event without
    // emitting onConnectStart/onConnectEnd. Our earlier document listener must
    // retire exactly the matching canceled-start debt too.
    fireEvent.mouseUp(document)
    expect(onChange).not.toHaveBeenCalled()

    const order: string[] = []
    pressConnectHandle(2)
    installXyflowLikeDocumentClosure('fresh', order)
    fireEvent.mouseMove(document, { clientX: 30, clientY: 30 })
    fireEvent.mouseUp(document, { clientX: 30, clientY: 30 })

    expect(order).toEqual(['fresh:start', 'fresh:connect', 'fresh:end'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('consecutive pre-threshold blurs accrue FIFO debt without swallowing the third fresh drag', () => {
    const onChange = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )
    const order: string[] = []

    pressConnectHandle(1)
    installXyflowLikeDocumentClosure('old-1', order)
    fireEvent(window, new Event('blur'))
    pressConnectHandle(2)
    installXyflowLikeDocumentClosure('old-2', order)
    fireEvent(document, new Event('pointercancel'))
    pressConnectHandle(3)
    installXyflowLikeDocumentClosure('fresh', order)

    fireEvent.mouseMove(document, { clientX: 40, clientY: 40 })
    fireEvent.mouseUp(document, { clientX: 40, clientY: 40 })

    expect(order).toEqual([
      'old-1:start',
      'old-2:start',
      'fresh:start',
      'old-1:connect',
      'old-1:end',
      'old-2:connect',
      'old-2:end',
      'fresh:connect',
      'fresh:end',
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('unmount releases an active connection pointer tracker', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          surface="editor"
          definition={connectDefinition}
          onChange={() => undefined}
        />
      </I18nextProvider>,
    )
    const callsBeforeGesture = add.mock.calls.length
    act(() => currentReactFlowProps().onConnectStart?.())
    const pointerListener = add.mock.calls
      .slice(callsBeforeGesture)
      .find(([type]) => type === 'pointermove')?.[1]
    expect(pointerListener).toBeTypeOf('function')

    unmount()

    expect(
      remove.mock.calls.some(
        ([type, listener]) => type === 'pointermove' && listener === pointerListener,
      ),
    ).toBe(true)
  })

  test('unmount fences a captured pre-threshold late start/connect/end without re-arming listeners', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const onChange = vi.fn()
    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="editor" definition={connectDefinition} onChange={onChange} />
      </I18nextProvider>,
    )
    const staleProps = currentReactFlowProps()
    pressConnectHandle(1)
    const pointerAddsBeforeUnmount = () =>
      add.mock.calls.filter(([type]) => type === 'pointermove').length

    unmount()
    const beforeLateCallbacks = pointerAddsBeforeUnmount()
    act(() => {
      staleProps.onConnectStart?.()
      staleProps.onConnect?.(validConnection)
      staleProps.onConnectEnd?.(new MouseEvent('mouseup'), sourceConnectionState)
    })

    expect(pointerAddsBeforeUnmount()).toBe(beforeLateCallbacks)
    expect(onChange).not.toHaveBeenCalled()
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
