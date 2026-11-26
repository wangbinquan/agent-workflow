// RFC-602: the real navigation predicate and canvas node components consume
// the real paginated hook. Only HTTP is replaced. Route wiring is separately
// locked by call-node-click-nav.test.tsx; ChildTaskLink has its own router tests.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CallWorkflowNode } from '../src/components/canvas/nodes/CallWorkflowNode'
import { CallWorkgroupNode } from '../src/components/canvas/nodes/CallWorkgroupNode'
import { taskChildrenQueryKey, useTaskChildren } from '../src/hooks/useTaskChildren'
import { callNavIsReachable } from '../src/lib/call-node-nav'
import { setBaseUrl } from '../src/stores/auth'
import '../src/i18n'

function response(ids: string[], nextCursor: string | null = null) {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      parentTaskId: 'p',
      items: ids.map((id) => ({ id, status: 'done' })),
      nextCursor,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('RFC-602 canvas navigation consumes complete child pages', () => {
  let client: QueryClient
  beforeEach(() => {
    setBaseUrl('http://children-canvas.test')
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  })
  afterEach(() => {
    cleanup()
    client.clear()
    vi.restoreAllMocks()
  })

  function Consumer({
    kind,
    childTaskId,
  }: {
    kind: 'call-workflow' | 'call-workgroup'
    childTaskId: string
  }) {
    const children = useTaskChildren('p')
    const reachable = callNavIsReachable(
      childTaskId,
      children.data,
      children.isError,
      children.isFetching,
    )
    const Component = kind === 'call-workflow' ? CallWorkflowNode : CallWorkgroupNode
    const props: Parameters<typeof CallWorkflowNode>[0] & Parameters<typeof CallWorkgroupNode>[0] =
      {
        id: 'call',
        type: kind,
        selected: false,
        dragging: false,
        draggable: false,
        selectable: true,
        deletable: false,
        zIndex: 0,
        isConnectable: false,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
        data: {
          surface: 'task' as const,
          nodeId: 'call',
          kind,
          title: 'Child invocation',
          inputPorts: [],
          outputPorts: [],
          ...(reachable ? { callNav: 'child' as const } : {}),
        },
      }
    return (
      <>
        <output
          data-testid="children-state"
          data-status={children.status}
          data-fetching={children.isFetching}
        >
          {JSON.stringify(children.data)}
        </output>
        <ReactFlowProvider>
          <Component {...props} />
        </ReactFlowProvider>
      </>
    )
  }

  function mount(kind: 'call-workflow' | 'call-workgroup', childTaskId = 'new-child') {
    return render(
      <QueryClientProvider client={client}>
        <Consumer kind={kind} childTaskId={childTaskId} />
      </QueryClientProvider>,
    )
  }

  for (const kind of ['call-workflow', 'call-workgroup'] as const) {
    for (const outcome of ['present', 'absent', 'error'] as const) {
      test(`${kind} preserves navigation during an unfinished refresh and resolves ${outcome} only after its tail`, async () => {
        let refresh = false
        let calls = 0
        let release!: (value: Response) => void
        const tail = new Promise<Response>((resolve) => {
          release = resolve
        })
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          calls++
          if (!refresh) return response([])
          return new URL(input.toString()).searchParams.has('cursor')
            ? tail
            : response(['other'], 'tail')
        })
        const { container } = mount(kind)
        await waitFor(() =>
          expect(screen.getByTestId('children-state').getAttribute('data-fetching')).toBe('false'),
        )
        expect(screen.getByTestId('children-state').textContent).toBe('[]')
        expect(container.querySelector('[data-call-nav="child"]')).toBeNull()

        refresh = true
        let complete!: Promise<void>
        act(() => {
          complete = client.refetchQueries({ queryKey: taskChildrenQueryKey('p') })
        })
        await waitFor(() => expect(calls).toBe(3))
        expect(screen.getByTestId('children-state').textContent).toBe('[]')
        expect(screen.getByTestId('children-state').getAttribute('data-fetching')).toBe('true')
        expect(container.querySelector('[data-call-nav="child"]')).not.toBeNull()
        expect(container.querySelector('.canvas-node__call-nav')).not.toBeNull()

        await act(async () => {
          release(
            outcome === 'error'
              ? new Response(
                  JSON.stringify({
                    ok: false,
                    code: 'temporarily-unavailable',
                    message: 'retry',
                    details: null,
                  }),
                  { status: 503, headers: { 'content-type': 'application/json' } },
                )
              : response(outcome === 'present' ? ['new-child'] : []),
          )
          await complete
        })
        await waitFor(() =>
          expect(screen.getByTestId('children-state').getAttribute('data-fetching')).toBe('false'),
        )
        if (outcome === 'absent')
          expect(container.querySelector('[data-call-nav="child"]')).toBeNull()
        else expect(container.querySelector('[data-call-nav="child"]')).not.toBeNull()
        expect(screen.getByTestId('children-state').getAttribute('data-status')).toBe(
          outcome === 'error' ? 'error' : 'success',
        )
        expect(calls).toBe(3)
      })
    }

    test(`${kind} retains its navigation affordance for a child after the former 500-row boundary`, async () => {
      const ids = Array.from({ length: 501 }, (_, i) => `child-${i}`)
      let calls = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        calls++
        const offset = Number(new URL(input.toString()).searchParams.get('cursor') ?? 0)
        return response(
          ids.slice(offset, offset + 100),
          offset + 100 < ids.length ? String(offset + 100) : null,
        )
      })
      const { container } = mount(kind, 'child-500')
      await waitFor(() =>
        expect(screen.getByTestId('children-state').getAttribute('data-status')).toBe('success'),
      )
      expect(container.querySelector('[data-call-nav="child"]')).not.toBeNull()
      expect(container.querySelector('.canvas-node__call-nav')).not.toBeNull()
      expect(JSON.parse(screen.getByTestId('children-state').textContent ?? 'null')).toHaveLength(
        501,
      )
      expect(calls).toBe(6)
    })
  }
})
