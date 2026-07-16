// RFC-199 B2 controller regression lock. The React command runner must keep
// save request bytes captured, single-flight and response-loss-safe while it
// translates timers, HTTP, WS and browser wakeups into pure reducer events.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  SaveWorkflowReceipt,
  UpdateWorkflow,
  WorkflowDetail,
  WorkflowDraftSnapshot,
  WorkflowMutationId,
  WorkflowSnapshotHash,
} from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import {
  WorkflowEnsureSavedError,
  useWorkflowEditorDraft,
  type WorkflowEditorDraftControllerTransport,
} from '@/hooks/useWorkflowEditorDraft'

const MUTATION_A = '01KXF000000000000000000001' as WorkflowMutationId
const MUTATION_B = '01KXF000000000000000000002' as WorkflowMutationId
const MUTATION_C = '01KXF000000000000000000003' as WorkflowMutationId
const MUTATION_D = '01KXF000000000000000000004' as WorkflowMutationId

function hash(char: string): WorkflowSnapshotHash {
  return char.repeat(64) as WorkflowSnapshotHash
}

function snapshot(description: string): WorkflowDraftSnapshot {
  return {
    name: 'workflow',
    description,
    definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
  }
}

function detail(
  version = 1,
  description = 'base',
  snapshotHash: WorkflowSnapshotHash = hash('a'),
): WorkflowDetail {
  return {
    id: 'wf-1',
    ...snapshot(description),
    version,
    schemaVersion: 4,
    createdAt: 1,
    updatedAt: version * 100,
    snapshotHash,
  }
}

function receipt(
  input: UpdateWorkflow,
  version: number,
  outcome: SaveWorkflowReceipt['outcome'] = 'committed',
): SaveWorkflowReceipt {
  return {
    clientMutationId: input.clientMutationId,
    requestedBaseVersion: input.expectedVersion,
    revision: {
      workflowId: 'wf-1',
      version,
      snapshotHash: hashFor(input.snapshot),
      updatedAt: version * 100,
    },
    snapshot: input.snapshot,
    outcome,
  }
}

function hashFor(value: WorkflowDraftSnapshot): WorkflowSnapshotHash {
  const char =
    value.description === 'base'
      ? 'a'
      : value.description === 'first'
        ? 'b'
        : value.description === 'latest'
          ? 'c'
          : value.description === 'foreign'
            ? 'f'
            : value.description === 'remote'
              ? 'd'
              : 'e'
  return hash(char)
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

function mutationFactory() {
  const ids = [MUTATION_A, MUTATION_B, MUTATION_C, MUTATION_D]
  return vi.fn(() => ids.shift() ?? MUTATION_D)
}

function makeTransport(): {
  transport: WorkflowEditorDraftControllerTransport
  save: ReturnType<typeof vi.fn<WorkflowEditorDraftControllerTransport['save']>>
  fetch: ReturnType<typeof vi.fn<WorkflowEditorDraftControllerTransport['fetch']>>
} {
  const save = vi.fn<WorkflowEditorDraftControllerTransport['save']>()
  const fetch = vi.fn<WorkflowEditorDraftControllerTransport['fetch']>()
  return { transport: { save, fetch }, save, fetch }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useWorkflowEditorDraft', () => {
  test('fake clock coalesces mergeKey through 750ms, boundary splits, and exposes Undo/Redo hints', () => {
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({ initial: detail(), debounceMs: 10_000 }),
    )
    const editMeta = {
      source: 'inspector' as const,
      label: 'Edit description',
      mergeKey: 'metadata.description',
    }

    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
    act(() => result.current.commit(snapshot('a'), editMeta))
    act(() => vi.advanceTimersByTime(750))
    act(() => result.current.commit(snapshot('ab'), editMeta))
    expect(result.current.state).toMatchObject({ revision: 2, history: { cursor: 1 } })

    act(() => vi.advanceTimersByTime(751))
    act(() =>
      result.current.commit(snapshot('abc'), {
        ...editMeta,
        selectionAfter: { kind: 'node', id: 'node-a' },
      }),
    )
    expect(result.current.state.history.cursor).toBe(2)
    expect(result.current.selectionHint).toBeNull()
    expect(result.current.state.history.selectionHintRevision).toBe(0)

    // A focus boundary is an equality no-op: no revision/save, but the next
    // immediate keystroke becomes its own undoable transaction.
    act(() =>
      result.current.commit(result.current.state.local, {
        ...editMeta,
        historyBoundary: 'focus-boundary',
      }),
    )
    expect(result.current.state.revision).toBe(3)
    act(() =>
      result.current.commit(snapshot('abcd'), {
        ...editMeta,
        selectionAfter: { kind: 'node', id: 'node-z' },
      }),
    )
    expect(result.current.state).toMatchObject({ revision: 4, history: { cursor: 3 } })
    expect(result.current.selectionHint).toBeNull()
    expect(result.current.state.history.selectionHintRevision).toBe(0)

    act(() => result.current.undo())
    expect(result.current).toMatchObject({
      canUndo: true,
      canRedo: true,
      selectionHint: { kind: 'node', id: 'node-a' },
      state: { revision: 5, local: snapshot('abc'), history: { cursor: 2 } },
    })
    act(() => result.current.redo())
    expect(result.current).toMatchObject({
      canRedo: false,
      selectionHint: { kind: 'node', id: 'node-z' },
      state: { revision: 6, local: snapshot('abcd'), history: { cursor: 3 } },
    })

    act(() => result.current.undo())
    act(() => result.current.commit(snapshot('replacement'), { ...editMeta, mergeKey: undefined }))
    expect(result.current.canRedo).toBe(false)
    expect(result.current.state).toMatchObject({ revision: 8, history: { cursor: 3 } })
  })

  test('switching workflow identity resets both undo and redo stacks', () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial: WorkflowDetail }) =>
        useWorkflowEditorDraft({ initial, debounceMs: 10_000 }),
      { initialProps: { initial: detail() } },
    )
    act(() => result.current.commit(snapshot('first')))
    act(() => result.current.commit(snapshot('latest')))
    act(() => result.current.undo())
    expect(result.current).toMatchObject({ canUndo: true, canRedo: true })

    rerender({ initial: { ...detail(), id: 'wf-2' } })
    expect(result.current).toMatchObject({
      canUndo: false,
      canRedo: false,
      selectionHint: null,
      state: { workflowId: 'wf-2', history: { epoch: 0, cursor: 0, entries: [] } },
    })
  })

  test('ensureSaved cancels the long debounce, waits for 300ms idle, and returns exact truth', async () => {
    const io = makeTransport()
    io.save.mockImplementation(async (_workflowId, input) => receipt(input, 2))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    const barrier = result.current.ensureSaved()
    act(() => vi.advanceTimersByTime(299))
    await flush()
    expect(io.save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    await flush()
    await expect(barrier).resolves.toEqual({
      revision: 1,
      server: {
        workflowId: 'wf-1',
        version: 2,
        snapshotHash: hash('b'),
        updatedAt: 200,
      },
      snapshot: snapshot('first'),
    })

    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
  })

  test('ensureSaved restarts the 300ms quiet period when typing lands during deferred hashing', async () => {
    const firstHash = deferred<WorkflowSnapshotHash>()
    const io = makeTransport()
    io.save.mockImplementation(async (_workflowId, input) => receipt(input, 2))
    const hashSnapshot = vi
      .fn<(value: WorkflowDraftSnapshot) => Promise<WorkflowSnapshotHash>>()
      .mockReturnValueOnce(firstHash.promise)
      .mockImplementation(async (value) => hashFor(value))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot,
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    const barrier = result.current.ensureSaved()
    act(() => vi.advanceTimersByTime(300))
    await flush()
    expect(hashSnapshot).toHaveBeenCalledTimes(1)

    // The first revision was quiet for 300ms, but its digest has not finished.
    // This new edit invalidates that deferred attempt and owns a fresh window.
    act(() => result.current.commit(snapshot('latest')))
    firstHash.resolve(hash('b'))
    await flush()
    expect(io.save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(299))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    await flush()

    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.save.mock.calls[0]![1].snapshot).toEqual(snapshot('latest'))
    await expect(barrier).resolves.toMatchObject({
      revision: 2,
      snapshot: snapshot('latest'),
    })
  })

  test('cancelling the last ensureSaved caller unlocks it and restores ordinary autosave', async () => {
    const io = makeTransport()
    io.save.mockImplementation(async (_workflowId, input) => receipt(input, 2))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
        debounceMs: 1_000,
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    const abort = new AbortController()
    const barrier = result.current
      .ensureSaved({ signal: abort.signal })
      .catch((error: unknown) => error)
    act(() => abort.abort())
    await expect(barrier).resolves.toMatchObject({ reason: 'cancelled' })

    act(() => vi.advanceTimersByTime(999))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(result.current.state.phase).toBe('clean')
  })

  test('offline reconciliation rejects only the exact barrier and retains its save attempt', async () => {
    const io = makeTransport()
    io.save.mockRejectedValueOnce(new TypeError('request outcome unknown'))
    io.fetch.mockRejectedValueOnce(new TypeError('offline'))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    const barrier = result.current.ensureSaved().catch((error: unknown) => error)
    act(() => vi.advanceTimersByTime(300))
    await flush()

    await expect(barrier).resolves.toMatchObject({ reason: 'unavailable', transport: 'offline' })
    expect(result.current.state).toMatchObject({
      phase: 'reconciling',
      transport: 'offline',
      local: snapshot('first'),
      inFlight: { clientMutationId: MUTATION_A, snapshot: snapshot('first') },
    })
  })

  test('isSavedDraftCurrent rejects any later local revision or remote adoption', async () => {
    const current = renderHook(() => useWorkflowEditorDraft({ initial: detail() }))
    const saved = await current.result.current.ensureSaved()
    expect(current.result.current.isSavedDraftCurrent(saved)).toBe(true)

    act(() => current.result.current.commit(snapshot('later-local')))
    expect(current.result.current.isSavedDraftCurrent(saved)).toBe(false)

    const remote = renderHook(() => useWorkflowEditorDraft({ initial: detail() }))
    const remoteSaved = await remote.result.current.ensureSaved()
    act(() => remote.result.current.remoteDetail(detail(2, 'foreign', hash('f'))))
    expect(remote.result.current.isSavedDraftCurrent(remoteSaved)).toBe(false)
  })

  test('ensureSaved follows typing and an active save until the newest queued revision settles', async () => {
    const firstSave = deferred<SaveWorkflowReceipt>()
    const secondSave = deferred<SaveWorkflowReceipt>()
    const io = makeTransport()
    io.save.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(secondSave.promise)
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    const barrier = result.current.ensureSaved()
    act(() => result.current.commit(snapshot('latest')))

    const firstInput = io.save.mock.calls[0]![1]
    firstSave.resolve(receipt(firstInput, 2))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(2)
    const latestInput = io.save.mock.calls[1]![1]
    expect(latestInput.snapshot).toEqual(snapshot('latest'))

    secondSave.resolve(receipt(latestInput, 3))
    await flush()
    await expect(barrier).resolves.toMatchObject({
      revision: 2,
      server: { version: 3, snapshotHash: hash('c') },
      snapshot: snapshot('latest'),
    })
  })

  test('ensureSaved fails structurally in conflict and deleted terminal states', async () => {
    const conflict = renderHook(() => useWorkflowEditorDraft({ initial: detail() }))
    act(() => conflict.result.current.commit(snapshot('latest')))
    act(() => conflict.result.current.remoteDetail(detail(2, 'foreign', hash('f'))))
    await expect(conflict.result.current.ensureSaved()).rejects.toMatchObject({
      name: 'WorkflowEnsureSavedError',
      code: 'workflow-draft-not-saveable',
      reason: 'conflict',
    })
    conflict.unmount()

    const deleted = renderHook(() => useWorkflowEditorDraft({ initial: detail() }))
    act(() =>
      deleted.result.current.remoteFrame({
        type: 'workflow.deleted',
        workflowId: 'wf-1',
        clientMutationId: MUTATION_B,
        deletedVersion: 2,
      }),
    )
    const failure = await deleted.result.current.ensureSaved().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowEnsureSavedError)
    expect(failure).toMatchObject({ reason: 'deleted', transport: 'online' })
  })

  test('debounce captures one request; edit-during-save coalesces three edits into one latest follow-up', async () => {
    const firstSave = deferred<SaveWorkflowReceipt>()
    const secondSave = deferred<SaveWorkflowReceipt>()
    const io = makeTransport()
    io.save.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(secondSave.promise)
    const ids = mutationFactory()
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: ids,
        hashSnapshot: async (value) => hashFor(value),
        debounceMs: 1_000,
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(999))
    await flush()
    expect(io.save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
    const firstInput = io.save.mock.calls[0]![1]
    expect(firstInput).toEqual({
      expectedVersion: 1,
      clientMutationId: MUTATION_A,
      snapshot: snapshot('first'),
    })

    act(() => result.current.commit(snapshot('second')))
    act(() => result.current.commit(snapshot('third')))
    act(() => result.current.commit(snapshot('latest')))
    act(() => vi.advanceTimersByTime(2_000))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({ revision: 4, queuedRevision: 4, phase: 'saving' })
    expect(firstInput.snapshot).toEqual(snapshot('first'))

    firstSave.resolve(receipt(firstInput, 2))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(2)
    expect(io.save.mock.calls[1]![1]).toEqual({
      expectedVersion: 2,
      clientMutationId: MUTATION_B,
      snapshot: snapshot('latest'),
    })
  })

  test('response lost after commit: GET matching submitted hash synthesizes success', async () => {
    const io = makeTransport()
    io.save.mockRejectedValueOnce(new TypeError('response lost'))
    io.fetch.mockResolvedValueOnce(detail(2, 'first', hash('b')))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()

    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.fetch).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({
      phase: 'clean',
      inFlight: null,
      savedRevision: 1,
      serverRevision: { version: 2, snapshotHash: hash('b') },
    })
  })

  test('request failed before commit: same-base GET resends the exact mutation id and bytes', async () => {
    const io = makeTransport()
    io.save
      .mockRejectedValueOnce(new TypeError('request never reached daemon'))
      .mockResolvedValueOnce({} as SaveWorkflowReceipt)
    io.fetch.mockResolvedValueOnce(detail())
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()

    expect(io.save).toHaveBeenCalledTimes(2)
    expect(io.save.mock.calls[1]![1]).toEqual(io.save.mock.calls[0]![1])
    expect(io.save.mock.calls[1]![1].clientMutationId).toBe(MUTATION_A)
  })

  test.each([429, 503])('HTTP %s is uncertain and reconciles before any retry', async (status) => {
    const pendingRetry = deferred<SaveWorkflowReceipt>()
    const io = makeTransport()
    io.save
      .mockRejectedValueOnce(new ApiError(status, `http-${status}`, 'uncertain'))
      .mockReturnValueOnce(pendingRetry.promise)
    io.fetch.mockResolvedValueOnce(detail())
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()

    expect(io.fetch).toHaveBeenCalledTimes(1)
    expect(io.save).toHaveBeenCalledTimes(2)
    expect(io.save.mock.calls[1]![1]).toEqual(io.save.mock.calls[0]![1])
  })

  test('409 retains structured current revision and pauses autosave in conflict', async () => {
    const io = makeTransport()
    io.save.mockRejectedValueOnce(
      new ApiError(409, 'workflow-version-conflict', 'changed', {
        current: {
          workflowId: 'wf-1',
          version: 3,
          snapshotHash: hash('f'),
          updatedAt: 300,
        },
      }),
    )
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('latest')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()

    expect(result.current.state).toMatchObject({
      phase: 'conflict',
      local: snapshot('latest'),
      conflict: {
        reason: 'save-conflict',
        current: { version: 3, snapshotHash: hash('f') },
        snapshot: null,
      },
    })
    act(() => vi.advanceTimersByTime(10_000))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
  })

  test('GET outage keeps the attempt, follows fake-clock backoff, and WS epoch wakes immediately', async () => {
    const io = makeTransport()
    io.save.mockRejectedValueOnce(new TypeError('response lost'))
    io.fetch
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(detail(2, 'foreign', hash('f')))
    const baseOptions = {
      initial: detail(),
      transport: io.transport,
      mutationIdFactory: mutationFactory(),
      hashSnapshot: async (value: WorkflowDraftSnapshot) => hashFor(value),
      connectionEpoch: 0,
      connected: false,
    }
    const { result, rerender } = renderHook(
      ({ epoch }) => useWorkflowEditorDraft({ ...baseOptions, connectionEpoch: epoch }),
      { initialProps: { epoch: 0 } },
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    expect(result.current.state).toMatchObject({
      phase: 'reconciling',
      transport: 'offline',
      reconcileRetry: { attempt: 1, nextAt: 11_000 + 1_000 },
      local: snapshot('first'),
    })

    act(() => vi.advanceTimersByTime(999))
    await flush()
    expect(io.fetch).toHaveBeenCalledTimes(1)

    rerender({ epoch: 1 })
    await flush()
    expect(io.fetch).toHaveBeenCalledTimes(2)
    expect(result.current.state).toMatchObject({
      phase: 'conflict',
      local: snapshot('first'),
      conflict: { current: { version: 2, snapshotHash: hash('f') } },
    })

    act(() => vi.advanceTimersByTime(10_000))
    await flush()
    expect(io.fetch).toHaveBeenCalledTimes(2)
  })

  test.each(['online', 'focus', 'visibility'] as const)(
    '%s browser wake cancels reconciliation backoff and retries GET immediately',
    async (wakeKind) => {
      const io = makeTransport()
      io.save.mockRejectedValueOnce(new TypeError('response lost'))
      io.fetch
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(detail(2, 'first', hash('b')))
      const { result } = renderHook(() =>
        useWorkflowEditorDraft({
          initial: detail(),
          transport: io.transport,
          mutationIdFactory: mutationFactory(),
          hashSnapshot: async (value) => hashFor(value),
        }),
      )

      act(() => result.current.commit(snapshot('first')))
      act(() => vi.advanceTimersByTime(1_000))
      await flush()
      expect(result.current.state.reconcileRetry.nextAt).toBe(12_000)

      act(() => {
        if (wakeKind === 'visibility') {
          document.dispatchEvent(new Event('visibilitychange'))
        } else {
          window.dispatchEvent(new Event(wakeKind))
        }
      })
      await flush()

      expect(io.fetch).toHaveBeenCalledTimes(2)
      expect(result.current.state.phase).toBe('clean')
      act(() => vi.advanceTimersByTime(5_000))
      await flush()
      expect(io.fetch).toHaveBeenCalledTimes(2)
    },
  )

  test('focus reconciles a normal dirty draft before replacing its pending debounce save', async () => {
    const pendingSave = deferred<SaveWorkflowReceipt>()
    const io = makeTransport()
    io.fetch.mockResolvedValueOnce(detail())
    io.save.mockReturnValueOnce(pendingSave.promise)
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )
    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(500))

    act(() => window.dispatchEvent(new Event('focus')))
    await flush()

    expect(io.fetch).toHaveBeenCalledTimes(1)
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.fetch.mock.invocationCallOrder[0]).toBeLessThan(io.save.mock.invocationCallOrder[0]!)
    act(() => vi.advanceTimersByTime(5_000))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
  })

  test('own WS frame before HTTP receipt does not settle; receipt remains authoritative', async () => {
    const pending = deferred<SaveWorkflowReceipt>()
    const io = makeTransport()
    io.save.mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )

    act(() => result.current.commit(snapshot('first')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    const input = io.save.mock.calls[0]![1]
    act(() =>
      result.current.remoteFrame({
        type: 'workflow.updated',
        workflowId: 'wf-1',
        clientMutationId: input.clientMutationId,
        version: 2,
        snapshotHash: hash('b'),
        updatedAt: 200,
      }),
    )
    expect(result.current.state).toMatchObject({ phase: 'saving', savedRevision: 0 })

    pending.resolve(receipt(input, 2))
    await flush()
    expect(result.current.state).toMatchObject({ phase: 'clean', savedRevision: 1 })
  })

  test('clean foreign frame fetches and adopts; dirty foreign frame preserves local and conflicts', async () => {
    const cleanIo = makeTransport()
    cleanIo.fetch.mockResolvedValueOnce(detail(2, 'remote', hash('d')))
    const clean = renderHook(() =>
      useWorkflowEditorDraft({ initial: detail(), transport: cleanIo.transport }),
    )
    act(() =>
      clean.result.current.remoteFrame({
        type: 'workflow.updated',
        workflowId: 'wf-1',
        clientMutationId: MUTATION_B,
        version: 2,
        snapshotHash: hash('d'),
        updatedAt: 200,
      }),
    )
    await flush()
    expect(cleanIo.fetch).toHaveBeenCalledTimes(1)
    expect(clean.result.current.state).toMatchObject({
      phase: 'clean',
      local: snapshot('remote'),
      history: { epoch: 1, cursor: 0 },
    })
    clean.unmount()

    const dirtyIo = makeTransport()
    const dirty = renderHook(() =>
      useWorkflowEditorDraft({ initial: detail(), transport: dirtyIo.transport }),
    )
    act(() => dirty.result.current.commit(snapshot('latest')))
    act(() =>
      dirty.result.current.remoteFrame({
        type: 'workflow.updated',
        workflowId: 'wf-1',
        clientMutationId: MUTATION_B,
        version: 2,
        snapshotHash: hash('f'),
        updatedAt: 200,
      }),
    )
    expect(dirty.result.current.state).toMatchObject({
      phase: 'conflict',
      local: snapshot('latest'),
      conflict: { current: { version: 2, snapshotHash: hash('f') } },
    })
    act(() => vi.advanceTimersByTime(2_000))
    await flush()
    expect(dirtyIo.save).not.toHaveBeenCalled()
  })

  test('explicit delete and 403 remain distinct terminal states and preserve local history', async () => {
    const deleted = renderHook(() => useWorkflowEditorDraft({ initial: detail() }))
    act(() => deleted.result.current.commit(snapshot('latest')))
    act(() =>
      deleted.result.current.remoteFrame({
        type: 'workflow.deleted',
        workflowId: 'wf-1',
        clientMutationId: MUTATION_B,
        deletedVersion: 2,
      }),
    )
    expect(deleted.result.current.state).toMatchObject({
      phase: 'deleted',
      local: snapshot('latest'),
      history: { epoch: 0, cursor: 1 },
    })
    deleted.unmount()

    const inaccessibleIo = makeTransport()
    inaccessibleIo.save.mockRejectedValueOnce(new ApiError(403, 'workflow-not-found', 'not found'))
    const inaccessible = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: inaccessibleIo.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )
    act(() => inaccessible.result.current.commit(snapshot('latest')))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    expect(inaccessible.result.current.state).toMatchObject({
      phase: 'inaccessible',
      local: snapshot('latest'),
      history: { epoch: 0, cursor: 1 },
    })
  })

  test('inaccessible retry is correlated; copy/load/overwrite reducer commands surface intents', async () => {
    const io = makeTransport()
    const pendingSave = deferred<SaveWorkflowReceipt>()
    io.fetch.mockResolvedValueOnce(detail())
    io.save.mockReturnValueOnce(pendingSave.promise)
    const onIntent = vi.fn()
    const ids = mutationFactory()
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: ids,
        hashSnapshot: async (value) => hashFor(value),
        onIntent,
      }),
    )
    act(() => result.current.commit(snapshot('latest')))
    act(() => result.current.remoteInaccessible(new ApiError(404, 'not-found', 'hidden')))

    act(() => result.current.requestCopy())
    expect(result.current.intent).toEqual({
      type: 'save-copy',
      snapshot: snapshot('latest'),
      suggestedName: 'workflow-copy',
    })
    expect(onIntent).toHaveBeenLastCalledWith(result.current.intent)
    act(() => result.current.clearIntent())
    expect(result.current.intent).toBeNull()

    act(() => result.current.retryAccess())
    await flush()
    expect(io.fetch).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({
      phase: 'saving',
      accessRetryId: null,
      local: snapshot('latest'),
    })

    // Put the draft back into conflict and assert both confirmation intents.
    act(() => result.current.remoteDetail(detail(2, 'foreign', hash('f'))))
    expect(result.current.state.phase).toBe('conflict')
    act(() => result.current.requestLoadRemote())
    expect(result.current.intent).toMatchObject({ type: 'confirm-load-remote' })
    act(() => result.current.requestOverwrite())
    expect(result.current.intent).toMatchObject({
      type: 'confirm-overwrite',
      snapshot: snapshot('latest'),
    })
  })

  test('confirmLoadRemote and confirmOverwrite work directly without prior request-intent render', async () => {
    const io = makeTransport()
    io.save.mockResolvedValueOnce({} as SaveWorkflowReceipt)
    io.fetch.mockResolvedValue(detail(3, 'remote', hash('d')))
    const { result } = renderHook(() =>
      useWorkflowEditorDraft({
        initial: detail(),
        transport: io.transport,
        mutationIdFactory: mutationFactory(),
        hashSnapshot: async (value) => hashFor(value),
      }),
    )
    act(() => result.current.commit(snapshot('latest')))
    act(() => result.current.remoteDetail(detail(2, 'foreign', hash('f'))))
    expect(result.current.state.phase).toBe('conflict')

    await act(async () => result.current.confirmOverwrite())
    await flush()
    expect(io.save.mock.calls[0]![1]).toMatchObject({
      expectedVersion: 3,
      snapshot: snapshot('latest'),
    })

    // A separate conflict demonstrates direct load without a preceding
    // requestLoadRemote()/intent state commit.
    const loadIo = makeTransport()
    loadIo.fetch.mockResolvedValueOnce(detail(4, 'remote', hash('d')))
    const load = renderHook(() =>
      useWorkflowEditorDraft({ initial: detail(), transport: loadIo.transport }),
    )
    act(() => load.result.current.commit(snapshot('latest')))
    act(() => load.result.current.remoteDetail(detail(2, 'foreign', hash('f'))))
    await act(async () => load.result.current.confirmLoadRemote())
    await flush()
    expect(load.result.current.state).toMatchObject({
      phase: 'clean',
      local: snapshot('remote'),
      serverRevision: { version: 4 },
    })
  })
})
