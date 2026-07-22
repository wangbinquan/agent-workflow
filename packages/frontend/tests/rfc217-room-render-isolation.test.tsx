// RFC-217 T10 — re-render isolation lock: typing in the room composer must
// re-render the COMPOSER ALONE. The old god component kept draft/caret at the
// top, so every keystroke re-rendered all 1497 lines (timeline diffing per
// character); the split moves that state into RoomComposer and memoizes the
// timeline + side rail. The `data-render-count` probes those components stamp
// are the observable — a keystroke that bumps either is the regression.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskStatus } from '@agent-workflow/shared'
import { api } from '../src/api/client'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupRoom } from '../src/components/workgroup/room/WorkgroupRoom'
import { workgroupRoomKey } from '../src/lib/workgroup-room'
import type { WorkgroupRoomMessage, WorkgroupRoomResponse } from '../src/lib/workgroup-room'
import '../src/i18n'

function msg(id: string): WorkgroupRoomMessage {
  return {
    id,
    round: 1,
    authorKind: 'member',
    authorMemberId: 'mem_a',
    authorUserId: null,
    kind: 'chat',
    bodyMd: `body ${id}`,
    mentionMemberIds: [],
    assignmentId: null,
    createdAt: 1000,
  }
}

function makeRoom(): WorkgroupRoomResponse {
  return {
    taskId: 't1',
    taskStatus: 'running',
    budgetUsed: 0,
    config: {
      workgroupId: 'wg1',
      workgroupName: 'squad',
      mode: 'leader_worker',
      leaderMemberId: 'mem_a',
      switches: { shareOutputs: true, directMessages: true, blackboard: true },
      maxRounds: 20,
      completionGate: false,
      instructions: '',
      goal: 'ship it',
      members: [
        {
          id: 'mem_a',
          memberType: 'agent',
          agentName: 'writer',
          userId: null,
          displayName: 'Ann',
          roleDesc: '',
        },
      ],
    },
    gate: { declaredDone: false, awaitingConfirmation: false, rejected: false, summary: null },
    dw: null,
    messages: [msg('m1'), msg('m2')],
    assignments: [],
    memberRuns: {},
    runHistory: [],
  }
}

function installFetch(data: WorkgroupRoomResponse) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/room')) return json(data)
    if (url.includes('/node-runs')) return json({ runs: [], outputs: [] })
    if (url.includes('/users/lookup')) return json({ users: [] })
    return json({})
  })
}

function RoomHost(props: { taskId: string; taskStatus: TaskStatus }) {
  const room = useQuery<WorkgroupRoomResponse>({
    queryKey: workgroupRoomKey(props.taskId),
    queryFn: ({ signal }) =>
      api.get(`/api/workgroup-tasks/${encodeURIComponent(props.taskId)}/room`, undefined, signal),
  })
  return <WorkgroupRoom taskId={props.taskId} taskStatus={props.taskStatus} room={room} />
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tkn')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-217 T10 — composer keystrokes re-render the composer alone', () => {
  test('typing 5 characters bumps neither the timeline nor the side rail probe', async () => {
    installFetch(makeRoom())
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <RoomHost taskId="t1" taskStatus="running" />
      </QueryClientProvider>,
    )
    const input = await screen.findByTestId('workgroup-room-input')
    await screen.findByTestId('wg-msg-m1')

    const log = screen.getByTestId('workgroup-room-log')
    const rail = document.querySelector('.workgroup-room__side')!
    // Let the initial queries settle (each refetch legitimately re-renders).
    await waitFor(() => expect(log.getAttribute('data-render-count')).not.toBeNull())
    const logBefore = log.getAttribute('data-render-count')
    const railBefore = rail.getAttribute('data-render-count')

    for (const chunk of ['h', 'he', 'hel', 'hell', 'hello']) {
      fireEvent.change(input, { target: { value: chunk } })
    }
    // The composer DID take the keystrokes…
    expect((input as HTMLTextAreaElement).value).toBe('hello')
    // …and neither sibling re-rendered for them.
    expect(log.getAttribute('data-render-count')).toBe(logBefore)
    expect(rail.getAttribute('data-render-count')).toBe(railBefore)
  })

  test('@-mention popup interaction stays composer-local too', async () => {
    installFetch(makeRoom())
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <RoomHost taskId="t1" taskStatus="running" />
      </QueryClientProvider>,
    )
    const input = await screen.findByTestId('workgroup-room-input')
    await screen.findByTestId('wg-msg-m1')
    const log = screen.getByTestId('workgroup-room-log')
    const logBefore = log.getAttribute('data-render-count')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '@A' } })
    // The roster popup opened (composer-local state)…
    await screen.findByTestId('wg-mention-Ann')
    // …without re-rendering the timeline.
    expect(log.getAttribute('data-render-count')).toBe(logBefore)
  })
})
