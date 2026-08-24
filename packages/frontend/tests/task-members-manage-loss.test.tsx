// Task membership management follows the same live-authority/session invariant
// as resource ACLs: downgrade, refetch and task identity changes end the draft.

import type { TaskMembers, UserPublic } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), put: vi.fn() },
  }
})

import { api } from '../src/api/client'
import { TaskMembersPanel } from '../src/components/tasks/TaskMembersPanel'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
import i18n from '../src/i18n'
import { getAuthSessionRevision, setToken } from '../src/stores/auth'

const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)
const membersKey = (taskId: string) =>
  ['tasks', taskId, 'members', getAuthSessionRevision()] as const

function user(id: string, username: string): UserPublic {
  return { id, username, displayName: `DN ${username}`, role: 'user', status: 'active' }
}

const OWNER = user('owner', 'owner')
const BOB = user('bob', 'bob')
const CAROL = user('carol', 'carol')

function members(taskId: string, overrides: Partial<TaskMembers> = {}): TaskMembers {
  return {
    taskId,
    ownerUserId: OWNER.id,
    owner: OWNER,
    users: [BOB],
    canManage: true,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installReads(rows: Record<string, TaskMembers>): void {
  mockedGet.mockImplementation((path: string) => {
    if (path === '/api/auth/me') {
      return Promise.resolve({
        user: user('me', 'me'),
        source: 'session',
        permissions: [],
        linkedIdentities: [],
        pats: [],
      }) as never
    }
    const match = /^\/api\/tasks\/([^/]+)\/members$/.exec(path)
    if (match !== null && rows[match[1] ?? ''] !== undefined) {
      return Promise.resolve(rows[match[1] ?? '']) as never
    }
    if (path === '/api/users/search') return Promise.resolve([CAROL]) as never
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPanel(taskId = 'a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const panel = (id: string) => (
    <QueryClientProvider client={client}>
      <TaskMembersPanel taskId={id} />
    </QueryClientProvider>
  )
  const view = render(panel(taskId))
  return { client, rerenderTask: (id: string) => view.rerender(panel(id)) }
}

beforeEach(async () => {
  setToken('tok-task-members-loss')
  mockedGet.mockReset()
  mockedPut.mockReset()
  await i18n.changeLanguage('en-US')
})

afterEach(() => cleanup())

describe('TaskMembersPanel manage-session loss', () => {
  test('token A connected Save cannot use cached human token B authority or members data', async () => {
    installReads({ a: members('a') })
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    const staleSave = screen.getByTestId('members-save') as HTMLButtonElement
    let invocations = 0
    staleSave.addEventListener('click', () => {
      invocations += 1
    })
    const actorB: MeResponse = {
      user: user('actor-b', 'actor-b'),
      profile: {
        displayName: 'actor-b',
        email: 'actor-b@example.test',
        gitCommitIdentity: { name: 'actor-b', email: 'actor-b@example.test' },
      },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    }
    act(() => {
      setToken('tok-task-members-b')
      client.setQueryData(meQueryOptions('tok-task-members-b').queryKey, actorB)
      client.setQueryData(membersKey('a'), members('a', { canManage: false }))
      fireEvent.click(staleSave)
    })
    expect(invocations).toBe(1)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
  })

  test('dirty members are discarded across downgrade and restoration', async () => {
    installReads({ a: members('a') })
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)

    act(() =>
      client.setQueryData(membersKey('a'), members('a', { canManage: false, users: [CAROL] })),
    )
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    expect(screen.getByText('DN carol')).toBeTruthy()

    act(() => client.setQueryData(membersKey('a'), members('a', { users: [CAROL] })))
    const restored = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)
    expect(screen.getByTestId('members-users-remove-carol')).toBeTruthy()
    fireEvent.click(restored)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  test('a connected stale Save handler is invoked after synchronous downgrade but sends zero PUT', async () => {
    installReads({ a: members('a') })
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    const staleSave = screen.getByTestId('members-save') as HTMLButtonElement
    let invocations = 0
    staleSave.addEventListener('click', () => {
      invocations += 1
    })

    act(() => {
      client.setQueryData(membersKey('a'), members('a', { canManage: false }))
      fireEvent.click(staleSave)
    })
    expect(invocations).toBe(1)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
  })

  test('a connected stale Transfer handler is invoked after downgrade but sends zero PUT', async () => {
    installReads({ a: members('a') })
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-transfer-owner'))
    fireEvent.focus(await screen.findByTestId('members-transfer-input'))
    fireEvent.click(await screen.findByTestId('members-transfer-option-carol'))
    const staleTransfer = screen.getByTestId('members-transfer-confirm') as HTMLButtonElement
    expect(staleTransfer.disabled).toBe(false)
    let invocations = 0
    staleTransfer.addEventListener('click', () => {
      invocations += 1
    })

    act(() => {
      client.setQueryData(membersKey('a'), members('a', { canManage: false }))
      fireEvent.click(staleTransfer)
    })
    expect(invocations).toBe(1)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('members-transfer-confirm')).toBeNull())
  })

  test('a pending save cannot overwrite a downgrade or close a restored clean session', async () => {
    installReads({ a: members('a') })
    const pending = deferred<TaskMembers>()
    mockedPut.mockReturnValue(pending.promise as never)
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    fireEvent.click(screen.getByTestId('members-save'))
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))

    const denied = members('a', { canManage: false, users: [CAROL] })
    act(() => client.setQueryData(membersKey('a'), denied))
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    act(() => client.setQueryData(membersKey('a'), { ...denied, canManage: true }))
    const restored = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)

    await act(async () => {
      pending.resolve(members('a', { users: [], canManage: true }))
      await pending.promise
    })
    expect(client.getQueryData(membersKey('a'))).toEqual({ ...denied, canManage: true })
    expect(restored.disabled).toBe(true)
  })

  test('switching to a cached sibling task clears the old draft and old URL is never written', async () => {
    installReads({ a: members('a'), b: members('b', { users: [CAROL] }) })
    const { client, rerenderTask } = renderPanel('a')
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)
    client.setQueryData(membersKey('b'), members('b', { users: [CAROL] }))

    rerenderTask('b')
    const cleanSave = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(cleanSave.disabled).toBe(true)
    expect(screen.getByTestId('members-users-remove-carol')).toBeTruthy()
    fireEvent.click(cleanSave)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  test('A → missing/error B → cached A cannot resurrect the old members draft', async () => {
    installReads({ a: members('a') })
    const { rerenderTask } = renderPanel('a')
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)

    rerenderTask('missing')
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    rerenderTask('a')
    const restored = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)
    expect(screen.getByTestId('members-users-remove-bob')).toBeTruthy()
    fireEvent.click(restored)
    expect(mockedPut).not.toHaveBeenCalled()
  })
})
