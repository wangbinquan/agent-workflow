// RFC-199 B2/T4 route integration lock. This renders the real
// WorkflowEditorLoaded + useWorkflowEditorDraft controller under a real
// QueryClient/router while replacing only xyflow chrome and the physical WS.
// It protects the seams that source-string tests cannot prove:
//   - canvas + rename coalesce into one captured full-snapshot PUT;
//   - an own WS echo arriving before HTTP does not create a false conflict;
//   - dirty foreign query data enters conflict without writing the old base
//     back over React Query's newer row;
//   - terminal "return to workflows" is an explicit leave decision and does
//     not self-block on the unsaved guard.

import { createContext, useContext } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  Agent,
  CreateWorkflow,
  SaveWorkflowReceipt,
  UpdateWorkflow,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowSnapshotHash,
  WorkflowValidationReceipt,
} from '@agent-workflow/shared'
import { ApiError, api } from '@/api/client'
import type { WorkflowSyncFrame, WorkflowSyncOptions } from '@/hooks/useWorkflowSync'
import { setBaseUrl, setToken } from '@/stores/auth'
import { WorkflowEditorLoaded } from '@/routes/workflows.edit'

const syncHarness = vi.hoisted(
  (): {
    options: WorkflowSyncOptions | null
    state: { connected: boolean; connectionEpoch: number }
  } => ({
    options: null,
    state: { connected: false, connectionEpoch: 0 },
  }),
)

const canvasHistoryHarness = vi.hoisted(() => ({
  clearSelection: vi.fn(),
  restoreSelection: vi.fn(),
}))

vi.mock('@/hooks/useWorkflowSync', () => ({
  useWorkflowSync: (options: WorkflowSyncOptions) => {
    syncHarness.options = options
    return syncHarness.state
  },
}))

vi.mock('@/components/AclPanel', () => ({ AclDialogButton: () => null }))
vi.mock('@/components/ConfirmButton', () => ({
  ConfirmButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}))
vi.mock('@/components/canvas/EditorSidebar', () => ({ EditorSidebar: () => null }))
vi.mock('@/components/canvas/EdgeInspector', () => ({ EdgeInspector: () => null }))
vi.mock('@/components/canvas/NodeInspector', () => ({
  NodeInspector: ({
    definition,
    onChange,
  }: {
    definition: WorkflowDefinition
    onChange: (definition: WorkflowDefinition, meta: Record<string, unknown>) => void
  }) => (
    <button
      type="button"
      data-testid="inspector-change"
      onClick={() =>
        onChange(
          {
            ...definition,
            inputs: [...definition.inputs, { kind: 'text', key: 'inspector', label: 'Inspector' }],
          },
          {
            source: 'inspector',
            label: 'Edit inspector',
            mergeKey: 'node:a:title',
            transaction: 'update',
          },
        )
      }
    >
      change inspector
    </button>
  ),
}))
vi.mock('@/components/canvas/WorkflowCanvas', async () => {
  const React = await import('react')
  return {
    WorkflowCanvas: React.forwardRef<
      unknown,
      {
        definition: WorkflowDefinition
        onChange: (definition: WorkflowDefinition) => void
        onSelect?: (selection: { kind: 'node' | 'edge'; id: string } | null) => void
      }
    >(function MockWorkflowCanvas({ definition, onChange, onSelect }, ref) {
      React.useImperativeHandle(ref, () => ({
        addPaletteItemAtViewportCenter: () => undefined,
        clearSelection: canvasHistoryHarness.clearSelection,
        restoreSelection: canvasHistoryHarness.restoreSelection,
      }))
      return (
        <>
          <output data-testid="canvas-input-count">{definition.inputs.length}</output>
          {definition.nodes[0] !== undefined ? (
            <button
              type="button"
              data-testid="canvas-select-node"
              onClick={() => onSelect?.({ kind: 'node', id: definition.nodes[0]!.id })}
            >
              select node
            </button>
          ) : null}
          <button
            type="button"
            data-testid="canvas-change"
            onClick={() =>
              onChange({
                ...definition,
                inputs: [...definition.inputs, { kind: 'text', key: 'prompt', label: 'Prompt' }],
              })
            }
          >
            change canvas
          </button>
        </>
      )
    }),
  }
})

function hash(char: string): WorkflowSnapshotHash {
  return char.repeat(64) as WorkflowSnapshotHash
}

function detail(
  version = 1,
  name = 'workflow',
  description = 'base',
  snapshotHash = hash('a'),
): WorkflowDetail {
  return {
    id: 'wf-1',
    name,
    description,
    definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    version,
    schemaVersion: 4,
    createdAt: 1,
    updatedAt: version * 100,
    snapshotHash,
  }
}

function validationReceipt(
  version = 1,
  snapshotHash: WorkflowSnapshotHash = hash('a'),
  issues: WorkflowValidationReceipt['issues'] = [],
): WorkflowValidationReceipt {
  return {
    revision: {
      workflowId: 'wf-1',
      version,
      snapshotHash,
      updatedAt: version * 100,
    },
    validationContextHash: hash('c'),
    validatedAt: 10_000,
    ok: !issues.some((issue) => (issue.severity ?? 'error') === 'error'),
    issues,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Observation {
  detail: WorkflowDetail
  error: unknown
}

const ObservationContext = createContext<Observation | null>(null)

function renderEditor(initial: WorkflowDetail) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['workflows', initial.id], initial)
  const root = createRootRoute({ component: Outlet })
  const editor = createRoute({
    getParentRoute: () => root,
    path: '/editor',
    component: function EditorHarness() {
      const observation = useContext(ObservationContext)
      if (observation === null) throw new Error('missing observation')
      return (
        <WorkflowEditorLoaded
          workflowId={initial.id}
          initial={initial}
          observedDetail={observation.detail}
          queryError={observation.error}
          onRefetch={() => {}}
        />
      )
    },
  })
  const list = createRoute({
    getParentRoute: () => root,
    path: '/workflows',
    component: () => <div data-testid="workflow-list">workflow list</div>,
  })
  const created = createRoute({
    getParentRoute: () => root,
    path: '/workflows/$id',
    component: () => <div data-testid="created-workflow">created workflow</div>,
  })
  const launch = createRoute({
    getParentRoute: () => root,
    path: '/workflows/$id/launch',
    component: () => <div data-testid="workflow-launch">workflow launch</div>,
  })
  const router = createRouter({
    routeTree: root.addChildren([editor, list, created, launch]),
    history: createMemoryHistory({ initialEntries: ['/editor'] }),
  })
  const tree = (observation: Observation) => (
    <ObservationContext.Provider value={observation}>
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    </ObservationContext.Provider>
  )
  const view = render(tree({ detail: initial, error: null }))
  return {
    container: view.container,
    qc,
    router,
    rerender: (observation: Observation) => view.rerender(tree(observation)),
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function renameLocal(name: string, description: string): void {
  fireEvent.click(screen.getByTestId('workflow-rename-button'))
  fireEvent.change(screen.getByTestId('workflow-rename-name'), { target: { value: name } })
  fireEvent.change(screen.getByTestId('workflow-rename-description'), {
    target: { value: description },
  })
  fireEvent.click(screen.getByTestId('workflow-rename-confirm'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  setBaseUrl('http://daemon.test')
  setToken('token')
  syncHarness.options = null
  syncHarness.state = { connected: false, connectionEpoch: 0 }
  vi.spyOn(api, 'get').mockImplementation(async () => [] as never)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkflowEditorLoaded RFC-199 draft integration', () => {
  test('visible Undo/Redo restores the composite draft and a new edit clears redo', async () => {
    renderEditor(detail())
    await flushEffects()

    const undo = screen.getByTestId('workflow-undo') as HTMLButtonElement
    const redo = screen.getByTestId('workflow-redo') as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)

    fireEvent.click(screen.getByTestId('canvas-change'))
    expect(screen.getByTestId('canvas-input-count').textContent).toBe('1')
    expect(undo.disabled).toBe(false)
    expect(undo.textContent).toContain('Undo:')
    expect(undo.title).toContain('Undo:')

    fireEvent.click(undo)
    expect(screen.getByTestId('canvas-input-count').textContent).toBe('0')
    expect(redo.disabled).toBe(false)
    expect(redo.textContent).toContain('Redo:')

    fireEvent.click(redo)
    expect(screen.getByTestId('canvas-input-count').textContent).toBe('1')

    fireEvent.click(undo)
    fireEvent.click(screen.getByTestId('canvas-change'))
    expect(screen.getByTestId('canvas-input-count').textContent).toBe('1')
    expect(redo.disabled).toBe(true)
  })

  test('ordinary inspector input does not publish a selection restore; Undo does', async () => {
    renderEditor(detail())
    await flushEffects()
    const initialRestoreCalls = canvasHistoryHarness.restoreSelection.mock.calls.length

    fireEvent.click(screen.getByTestId('inspector-change'))
    expect(canvasHistoryHarness.restoreSelection).toHaveBeenCalledTimes(initialRestoreCalls)

    fireEvent.click(screen.getByTestId('workflow-undo'))
    expect(canvasHistoryHarness.restoreSelection).toHaveBeenCalledTimes(initialRestoreCalls + 1)
  })

  test('clean remote follow prunes a deleted inspector selection without history focus restore', async () => {
    const initial = detail()
    initial.definition = {
      ...initial.definition,
      nodes: [{ id: 'node-a', kind: 'agent-single', agentName: 'coder' }],
    }
    const { container, rerender } = renderEditor(initial)
    await flushEffects()
    fireEvent.click(screen.getByTestId('canvas-select-node'))
    expect(container.querySelector('.editor-layout--with-inspector')).not.toBeNull()
    const restoreCalls = canvasHistoryHarness.restoreSelection.mock.calls.length

    rerender({ detail: detail(2, 'workflow', 'base', hash('b')), error: null })
    await flushEffects()

    expect(container.querySelector('.editor-layout--with-inspector')).toBeNull()
    expect(canvasHistoryHarness.restoreSelection).toHaveBeenCalledTimes(restoreCalls)
    expect(canvasHistoryHarness.clearSelection).toHaveBeenCalled()
  })

  test('canvas + rename share one full-snapshot save and own WS before HTTP stays non-conflicting', async () => {
    const pending = deferred<SaveWorkflowReceipt>()
    let request: UpdateWorkflow | null = null
    vi.spyOn(api, 'put').mockImplementation((_path, body) => {
      request = body as UpdateWorkflow
      return pending.promise as never
    })
    const { qc } = renderEditor(detail())
    await flushEffects()

    fireEvent.click(screen.getByTestId('canvas-change'))
    renameLocal('workflow-renamed', 'local description')
    expect(screen.getByTestId('workflow-draft-phase').textContent).toMatch(
      /有未保存修改|Unsaved changes/,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    // hashWorkflowDraftSnapshot crosses the native WebCrypto queue. A fixed
    // number of Promise.resolve() turns can still finish before digest() on a
    // loaded CI worker, so wait for the observable save seam instead.
    await vi.waitFor(() => expect(request).not.toBeNull())
    const captured = request as unknown as UpdateWorkflow
    expect(captured.expectedVersion).toBe(1)
    expect(captured.snapshot).toEqual({
      name: 'workflow-renamed',
      description: 'local description',
      definition: {
        $schema_version: 4,
        inputs: [{ kind: 'text', key: 'prompt', label: 'Prompt' }],
        nodes: [],
        edges: [],
      },
    })
    expect(syncHarness.options?.inFlightMutationId).toBe(captured.clientMutationId)

    act(() => {
      syncHarness.options?.onFrame?.({
        type: 'workflow.updated',
        workflowId: 'wf-1',
        version: 2,
        snapshotHash: hash('b'),
        updatedAt: 200,
        clientMutationId: captured.clientMutationId,
      } satisfies WorkflowSyncFrame)
    })
    expect(screen.getByTestId('workflow-draft-phase').textContent).not.toMatch(
      /版本冲突|Version conflict/,
    )

    pending.resolve({
      clientMutationId: captured.clientMutationId,
      requestedBaseVersion: 1,
      revision: {
        workflowId: 'wf-1',
        version: 2,
        snapshotHash: hash('b'),
        updatedAt: 200,
      },
      snapshot: captured.snapshot,
      outcome: 'committed',
    })
    await flushEffects()
    expect(screen.getByTestId('workflow-draft-phase').textContent).toMatch(/已保存|Saved/)
    expect(qc.getQueryData<WorkflowDetail>(['workflows', 'wf-1'])?.version).toBe(2)
  })

  test('dirty foreign query enters conflict, preserves newer cache row, and copy POSTs local snapshot', async () => {
    let createBody: CreateWorkflow | null = null
    const createPending = deferred<WorkflowDetail>()
    vi.spyOn(api, 'post').mockImplementation((_path, body) => {
      createBody = body as CreateWorkflow
      return createPending.promise as never
    })
    const initial = detail()
    const rendered = renderEditor(initial)
    await flushEffects()
    renameLocal('workflow-local', 'local description')

    const foreign = detail(2, 'workflow-remote', 'remote description', hash('f'))
    rendered.qc.setQueryData(['workflows', initial.id], foreign)
    rendered.rerender({ detail: foreign, error: null })
    await flushEffects()
    expect(screen.getByTestId('workflow-draft-phase').textContent).toMatch(
      /版本冲突|Version conflict/,
    )
    expect(rendered.qc.getQueryData<WorkflowDetail>(['workflows', initial.id])).toMatchObject({
      version: 2,
      snapshotHash: hash('f'),
      name: 'workflow-remote',
    })

    fireEvent.click(
      screen.getByRole('button', { name: /另存为副本（推荐）|Save as copy \(recommended\)/ }),
    )
    await flushEffects()
    expect((screen.getByTestId('workflow-copy-create-name') as HTMLInputElement).value).toBe(
      'workflow-local-copy',
    )
    fireEvent.click(screen.getByTestId('workflow-copy-create-confirm'))
    await flushEffects()
    expect(createBody).toEqual({
      name: 'workflow-local-copy',
      description: 'local description',
      definition: initial.definition,
    })
  })

  test('background 404 retains local draft as inaccessible and explicit return does not self-block', async () => {
    const initial = detail()
    const rendered = renderEditor(initial)
    await flushEffects()
    renameLocal('workflow-local', 'local description')
    rendered.rerender({
      detail: initial,
      error: new ApiError(404, 'not-found', 'not found'),
    })
    await flushEffects()

    expect(screen.getByTestId('workflow-draft-phase').textContent).toMatch(/无法访问|Inaccessible/)
    expect(screen.getByRole('heading', { name: 'workflow-local' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /返回工作流列表|Return to workflows/ }))
    await flushEffects()
    expect(rendered.router.state.location.pathname).toBe('/workflows')
    expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull()
  })

  test('Validate and every Launch run exact save-bound validation; double click navigates once with version', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(validationReceipt() as never)
    const rendered = renderEditor(detail())
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /^校验$|^Validate$/ }))
    await flushEffects()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenLastCalledWith(
      '/api/workflows/wf-1/validate',
      {
        expectedVersion: 1,
        expectedSnapshotHash: hash('a'),
      },
      expect.any(AbortSignal),
    )
    expect(screen.getByText(/校验通过|valid/)).toBeTruthy()

    const launch = screen.getByRole('button', { name: /启动任务|Launch task/ })
    fireEvent.click(launch)
    fireEvent.click(launch)
    await flushEffects()

    // The page's old green result never authorizes Launch: it performs a
    // second fresh exact validation, while the synchronous ref collapses the
    // two clicks into one preparing-launch operation.
    expect(post).toHaveBeenCalledTimes(2)
    expect(rendered.router.state.location.pathname).toBe('/workflows/wf-1/launch')
    expect(rendered.router.state.location.search).toMatchObject({ version: 1 })
  })

  test('dirty Validate flushes the composite snapshot before posting the saved exact revision', async () => {
    const put = vi.spyOn(api, 'put').mockImplementation((_path, body) => {
      const input = body as UpdateWorkflow
      return Promise.resolve({
        clientMutationId: input.clientMutationId,
        requestedBaseVersion: input.expectedVersion,
        revision: {
          workflowId: 'wf-1',
          version: 2,
          snapshotHash: hash('b'),
          updatedAt: 200,
        },
        snapshot: input.snapshot,
        outcome: 'committed',
      } satisfies SaveWorkflowReceipt) as never
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue(validationReceipt(2, hash('b')) as never)
    renderEditor(detail())
    await flushEffects()
    renameLocal('saved-before-validate', 'exact sequence')

    fireEvent.click(screen.getByRole('button', { name: /^校验$|^Validate$/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    await flushEffects()
    expect(put).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1)
      expect(post).toHaveBeenCalledWith(
        '/api/workflows/wf-1/validate',
        {
          expectedVersion: 2,
          expectedSnapshotHash: hash('b'),
        },
        expect.any(AbortSignal),
      )
    })
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]!)
  })

  test('Launch fails closed when the local revision changes before exact validation returns', async () => {
    const pending = deferred<WorkflowValidationReceipt>()
    vi.spyOn(api, 'post').mockReturnValue(pending.promise as never)
    const rendered = renderEditor(detail())
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /启动任务|Launch task/ }))
    await flushEffects()
    renameLocal('changed-during-validation', 'must not launch')
    pending.resolve(validationReceipt())
    await flushEffects()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(rendered.router.state.location.pathname).toBe('/editor')
    expect(screen.getByTestId('validation-stale').textContent).toMatch(
      /草稿已变化|draft has changed/,
    )
    expect(document.activeElement).toBe(screen.getByTestId('workflow-action-error-focus'))
  })

  test('a validation response is rendered stale when inventory changes while the request is deferred', async () => {
    const pending = deferred<WorkflowValidationReceipt>()
    vi.spyOn(api, 'post').mockReturnValue(pending.promise as never)
    const rendered = renderEditor(detail())
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /^校验$|^Validate$/ }))
    await flushEffects()
    act(() => {
      rendered.qc.setQueryData<Agent[]>(
        ['agents'],
        [
          {
            id: 'agent-new',
            name: 'new-validator-input',
            updatedAt: 20_000,
          } as Agent,
        ],
      )
    })
    pending.resolve(validationReceipt())
    await flushEffects()

    expect(screen.getByTestId('validation-stale').textContent).toMatch(
      /校验所依赖的资源可能已变化|validation resources may have changed/,
    )
    expect(document.querySelector('.validation-panel--ok')).toBeNull()
  })

  test('cancelling Launch during the save barrier unlocks actions and leaves autosave responsible', async () => {
    const put = vi.spyOn(api, 'put').mockImplementation((_path, body) => {
      const input = body as UpdateWorkflow
      return Promise.resolve({
        clientMutationId: input.clientMutationId,
        requestedBaseVersion: input.expectedVersion,
        revision: {
          workflowId: 'wf-1',
          version: 2,
          snapshotHash: hash('b'),
          updatedAt: 200,
        },
        snapshot: input.snapshot,
        outcome: 'committed',
      } satisfies SaveWorkflowReceipt) as never
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue(validationReceipt(2, hash('b')) as never)
    renderEditor(detail())
    await flushEffects()
    renameLocal('cancelled-launch', 'autosave must continue')

    fireEvent.click(screen.getByRole('button', { name: /启动任务|Launch task/ }))
    await flushEffects()
    fireEvent.click(screen.getByTestId('workflow-launch-cancel'))
    await flushEffects()

    expect(post).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: /启动任务|Launch task/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(screen.queryByTestId('workflow-action-error-focus')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await vi.waitFor(() => {
      expect(put).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('workflow-draft-phase').textContent).toMatch(/已保存|Saved/)
    })
  })

  test('offline ensureSaved failure unlocks Launch and focuses the durable save Notice', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(new TypeError('offline before PUT'))
    vi.mocked(api.get).mockImplementation((path) =>
      path === '/api/workflows/wf-1'
        ? (Promise.reject(new TypeError('offline GET')) as never)
        : (Promise.resolve([]) as never),
    )
    renderEditor(detail())
    await flushEffects()
    renameLocal('offline-launch', 'retained locally')

    fireEvent.click(screen.getByRole('button', { name: /启动任务|Launch task/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-draft-transport').textContent).toMatch(/离线|Offline/)
      expect(
        (screen.getByRole('button', { name: /启动任务|Launch task/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false)
      expect(document.activeElement).toBe(screen.getByTestId('workflow-draft-status-focus'))
    })
    expect(screen.queryByTestId('workflow-action-error-focus')).toBeNull()
  })

  test('Export uses authenticated exact-revision blob fetch and downloads only after the fence', async () => {
    const blob = new Blob(['name: workflow\n'], { type: 'application/yaml' })
    const getBlob = vi.spyOn(api, 'getBlob').mockResolvedValue(blob)
    const createObjectURL = vi.fn(() => 'blob:workflow-export')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderEditor(detail())
    await flushEffects()

    fireEvent.click(screen.getByRole('button', { name: /导出 YAML|Export YAML/ }))
    await flushEffects()

    expect(getBlob).toHaveBeenCalledWith(
      '/api/workflows/wf-1/export',
      {
        expectedVersion: 1,
        expectedSnapshotHash: hash('a'),
      },
      expect.any(AbortSignal),
    )
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(click.mock.contexts[0]).toMatchObject({ download: 'workflow.yaml' })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:workflow-export')
  })
})
