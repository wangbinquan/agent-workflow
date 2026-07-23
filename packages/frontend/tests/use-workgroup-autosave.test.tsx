// RFC-225 — workgroup autosave coordinator regression matrix.

import { createHash } from 'node:crypto'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  serializeWorkgroupEditableSnapshotV1,
  type SaveWorkgroupReceipt,
  type UpdateWorkgroup,
  type WorkgroupDetail,
  type WorkgroupDraftSnapshot,
  type WorkgroupSnapshotHash,
} from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import {
  projectWorkgroupDetailSnapshot,
  useWorkgroupAutosave,
  type UseWorkgroupAutosaveOptions,
  type WorkgroupSaveContext,
} from '@/hooks/useWorkgroupAutosave'

const BASE_CONTEXT: WorkgroupSaveContext = {
  configRevision: 1,
  membersRevision: 1,
  configWasDirty: true,
  membersWasDirty: false,
  membersSubmitted: null,
}

function snapshot(instructions = 'base'): WorkgroupDraftSnapshot {
  return {
    name: 'review-team',
    description: 'reviews changes',
    instructions,
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: true,
    clarifyBudget: 3,
    fanOut: false,
    members: [
      {
        memberType: 'agent',
        agentId: 'agent-1',
        displayName: 'Lead',
        roleDesc: 'coordinate',
      },
    ],
  }
}

function hashOf(value: WorkgroupDraftSnapshot): WorkgroupSnapshotHash {
  return createHash('sha256')
    .update(serializeWorkgroupEditableSnapshotV1(value), 'utf8')
    .digest('hex') as WorkgroupSnapshotHash
}

function detail(value = snapshot(), version = 1): WorkgroupDetail {
  const leader = value.members.findIndex(
    (member) => member.memberType === 'agent' && member.displayName === value.leaderDisplayName,
  )
  return {
    id: 'workgroup-1',
    name: value.name,
    description: value.description,
    instructions: value.instructions,
    mode: value.mode,
    leaderMemberId: leader < 0 ? null : `member-${leader}`,
    switches: { ...value.switches },
    maxRounds: value.maxRounds,
    completionGate: value.completionGate,
    clarifyBudget: value.clarifyBudget,
    fanOut: value.fanOut,
    members: value.members.map((member, index) =>
      member.memberType === 'agent'
        ? {
            id: `member-${index}`,
            memberType: 'agent' as const,
            agentId: member.agentId ?? null,
            agentName: member.agentId === 'agent-1' ? 'coder' : null,
            userId: null,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
            sortOrder: index,
          }
        : {
            id: `member-${index}`,
            memberType: 'human' as const,
            agentId: null,
            agentName: null,
            userId: member.userId ?? null,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
            sortOrder: index,
          },
    ),
    version,
    ownerUserId: 'user-1',
    visibility: 'private',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: version * 100,
    snapshotHash: hashOf(value),
  }
}

function receipt(
  input: UpdateWorkgroup,
  version: number,
  outcome: SaveWorkgroupReceipt['outcome'] = 'committed',
): SaveWorkgroupReceipt {
  const workgroup = detail(input.snapshot, version)
  return {
    clientMutationId: input.clientMutationId,
    requestedBaseVersion: input.expectedVersion,
    revision: {
      workgroupId: workgroup.id,
      version,
      snapshotHash: workgroup.snapshotHash,
      updatedAt: workgroup.updatedAt,
    },
    snapshot: input.snapshot,
    workgroup,
    outcome,
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

function makeTransport() {
  const save =
    vi.fn<(workgroupId: string, input: UpdateWorkgroup) => Promise<SaveWorkgroupReceipt>>()
  const fetch = vi.fn<(workgroupId: string) => Promise<WorkgroupDetail>>()
  return { transport: { save, fetch }, save, fetch }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  // WebCrypto resolves on a native task, whose scheduling becomes
  // nondeterministic when Vitest runs this file beside heavier route suites.
  // Keep this state-machine test on a deterministic, standards-equivalent
  // digest boundary so advancing the fake debounce clock cannot race hashing.
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (_algorithm, input) => {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const digest = createHash('sha256').update(bytes).digest()
    return digest.buffer.slice(
      digest.byteOffset,
      digest.byteOffset + digest.byteLength,
    ) as ArrayBuffer
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useWorkgroupAutosave', () => {
  test('fails closed before autosave state when an agent member has only a name snapshot', () => {
    const legacy = detail()
    legacy.members[0] = {
      ...legacy.members[0]!,
      agentId: null,
      agentName: 'legacy-coder',
    }

    expect(() => projectWorkgroupDetailSnapshot(legacy)).toThrow(
      /member-0 is missing canonical agentId/,
    )
    expect(projectWorkgroupDetailSnapshot(detail()).members[0]).toEqual({
      memberType: 'agent',
      agentId: 'agent-1',
      displayName: 'Lead',
      roleDesc: 'coordinate',
    })
  })

  test('debounces text, keeps one save in flight and immediately flushes queued latest', async () => {
    const io = makeTransport()
    const first = deferred<SaveWorkgroupReceipt>()
    io.save
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (_id, input) => receipt(input, 3))
    const contexts: Array<WorkgroupSaveContext | undefined> = []
    const { result } = renderHook(() =>
      useWorkgroupAutosave({
        initial: detail(),
        blockReason: null,
        debounceMs: 1_000,
        transport: io.transport,
        onReceipt: (_receipt, context) => contexts.push(context),
      }),
    )

    act(() => result.current.commit(snapshot('first'), BASE_CONTEXT))
    act(() => vi.advanceTimersByTime(999))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)

    act(() =>
      result.current.commit(snapshot('middle'), {
        ...BASE_CONTEXT,
        configRevision: 2,
      }),
    )
    act(() =>
      result.current.commit(snapshot('latest'), {
        ...BASE_CONTEXT,
        configRevision: 3,
      }),
    )
    expect(io.save).toHaveBeenCalledTimes(1)

    first.resolve(receipt(io.save.mock.calls[0]![1], 2))
    await vi.waitFor(() => expect(io.save).toHaveBeenCalledTimes(2))
    expect(io.save.mock.calls[1]![1]).toMatchObject({
      expectedVersion: 2,
      snapshot: { instructions: 'latest' },
    })
    await flush()
    expect(result.current.state).toMatchObject({
      phase: 'clean',
      revision: 3,
      savedRevision: 3,
      serverRevision: { version: 3 },
      local: { instructions: 'latest' },
    })
    expect(contexts.map((context) => context?.configRevision)).toEqual([1, 3])
  })

  test('structural edits save immediately while invalid/transient drafts emit no request', async () => {
    const io = makeTransport()
    io.save.mockImplementation(async (_id, input) => receipt(input, 2))
    const { result, rerender } = renderHook(
      ({ blockReason }: Pick<UseWorkgroupAutosaveOptions, 'blockReason'>) =>
        useWorkgroupAutosave({
          initial: detail(),
          blockReason,
          debounceMs: 1_000,
          transport: io.transport,
        }),
      {
        initialProps: {
          blockReason: 'transient-member' as UseWorkgroupAutosaveOptions['blockReason'],
        },
      },
    )

    act(() => result.current.commit(snapshot('blocked'), BASE_CONTEXT, { immediate: true }))
    await flush()
    act(() => vi.advanceTimersByTime(5_000))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    expect(result.current.state).toMatchObject({
      phase: 'blocked',
      blockReason: 'transient-member',
    })

    rerender({ blockReason: null })
    act(() => vi.advanceTimersByTime(999))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(result.current.state.phase).toBe('clean')

    act(() =>
      result.current.commit(
        snapshot('structural'),
        { ...BASE_CONTEXT, configRevision: 2 },
        {
          immediate: true,
        },
      ),
    )
    await flush()
    expect(io.save).toHaveBeenCalledTimes(2)
  })

  test('response loss reconciles by exact version/hash without blind replay', async () => {
    const io = makeTransport()
    let persisted = detail()
    io.save.mockImplementation(async (_id, input) => {
      persisted = receipt(input, 2).workgroup
      throw new ApiError(0, 'network-unreachable', 'response was lost')
    })
    io.fetch.mockImplementation(async () => persisted)
    const { result } = renderHook(() =>
      useWorkgroupAutosave({
        initial: detail(),
        blockReason: null,
        debounceMs: 1_000,
        transport: io.transport,
      }),
    )

    act(() => result.current.commit(snapshot('persisted despite loss'), BASE_CONTEXT))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    expect(io.save).toHaveBeenCalledTimes(1)
    expect(io.fetch).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({
      phase: 'clean',
      transport: 'online',
      serverRevision: { version: 2 },
      local: { instructions: 'persisted despite loss' },
    })
  })

  test('version conflict preserves local draft and exposes the mapped remote revision', async () => {
    const io = makeTransport()
    io.save.mockRejectedValue(
      new ApiError(409, 'workgroup-version-conflict', 'changed remotely', {
        current: {
          workgroupId: 'workgroup-1',
          version: 2,
          snapshotHash: 'f'.repeat(64),
          updatedAt: 200,
        },
      }),
    )
    const { result } = renderHook(() =>
      useWorkgroupAutosave({
        initial: detail(),
        blockReason: null,
        debounceMs: 1_000,
        transport: io.transport,
      }),
    )

    act(() => result.current.commit(snapshot('local draft'), BASE_CONTEXT))
    act(() => vi.advanceTimersByTime(1_000))
    await flush()
    expect(result.current.state).toMatchObject({
      phase: 'conflict',
      local: { instructions: 'local draft' },
      conflict: {
        reason: 'save-conflict',
        current: { workgroupId: 'workgroup-1', version: 2 },
      },
    })
  })

  test('foreign WS update conflicts with a dirty draft; ensureSaved waits for exact clean truth', async () => {
    const io = makeTransport()
    io.save.mockImplementation(async (_id, input) => receipt(input, 2))
    const current = renderHook(() =>
      useWorkgroupAutosave({
        initial: detail(),
        blockReason: null,
        debounceMs: 10_000,
        transport: io.transport,
      }),
    )
    act(() => current.result.current.commit(snapshot('must flush'), BASE_CONTEXT))
    let barrier!: Promise<unknown>
    act(() => {
      barrier = current.result.current.ensureSaved()
    })
    act(() => vi.advanceTimersByTime(299))
    await flush()
    expect(io.save).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    await flush()
    await expect(barrier).resolves.toMatchObject({
      server: { version: 2 },
      snapshot: { instructions: 'must flush' },
    })
    expect(current.result.current.state.phase).toBe('clean')

    const foreign = renderHook(() =>
      useWorkgroupAutosave({
        initial: detail(),
        blockReason: null,
        debounceMs: 10_000,
        transport: makeTransport().transport,
      }),
    )
    act(() => foreign.result.current.commit(snapshot('local'), BASE_CONTEXT))
    act(() =>
      foreign.result.current.remoteFrame({
        type: 'workgroup.updated',
        workgroupId: 'workgroup-1',
        clientMutationId: '01KXF000000000000000000009',
        version: 2,
        snapshotHash: 'e'.repeat(64) as WorkgroupSnapshotHash,
        updatedAt: 200,
      }),
    )
    expect(foreign.result.current.state).toMatchObject({
      phase: 'conflict',
      local: { instructions: 'local' },
      conflict: { reason: 'remote-observed', current: { version: 2 } },
    })
  })
})
