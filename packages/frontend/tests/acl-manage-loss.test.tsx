// ACL manage permission is an edit-session boundary, not just a render gate.
// These focused regressions keep the concurrently edited RFC-099 suite untouched
// while locking draft disposal, OCC re-baselining and stale mutation callbacks.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ResourceAcl, UserPublic } from '@agent-workflow/shared'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      put: vi.fn(),
    },
  }
})

import { api } from '../src/api/client'
import { AclPanel } from '../src/components/AclPanel'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
import i18n from '../src/i18n'
import { getAuthSessionRevision, setToken } from '../src/stores/auth'

const ACL_URL = '/api/agents/x/acl'
const aclQueryKey = () => ['acl', ACL_URL, getAuthSessionRevision()] as const
const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)

function user(id: string, username: string): UserPublic {
  return { id, username, displayName: `DN ${username}`, role: 'user', status: 'active' }
}

const ALICE = user('owner-1', 'alice')
const BOB = user('u2', 'bob')
const CAROL = user('u3', 'carol')
const DAVE = user('u4', 'dave')

function acl(overrides: Partial<ResourceAcl> = {}): ResourceAcl {
  return {
    resourceType: 'agent',
    resourceId: 'a1',
    ownerUserId: ALICE.id,
    owner: ALICE,
    visibility: 'public',
    users: [BOB],
    canManage: true,
    aclRevision: 3,
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installReads(initial: ResourceAcl, searchUsers: UserPublic[] = []): void {
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
    if (path === ACL_URL) return Promise.resolve(initial) as never
    if (path === '/api/users/search') return Promise.resolve(searchUsers) as never
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPanel(props: { onSaved?: () => void } = {}): {
  queryClient: QueryClient
  rerenderPanel: (resourceBaseUrl: string) => void
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const panel = (resourceBaseUrl: string) => (
    <QueryClientProvider client={queryClient}>
      <AclPanel
        resourceBaseUrl={resourceBaseUrl}
        invalidateKey={['agents']}
        onSaved={props.onSaved}
      />
    </QueryClientProvider>
  )
  const view = render(panel('/api/agents/x'))
  return {
    queryClient,
    rerenderPanel: (resourceBaseUrl) => view.rerender(panel(resourceBaseUrl)),
  }
}

function publishAcl(queryClient: QueryClient, next: ResourceAcl): void {
  act(() => queryClient.setQueryData(aclQueryKey(), next))
}

beforeEach(async () => {
  setToken('aws_s_acl-manage-loss')
  mockedGet.mockReset()
  mockedPut.mockReset()
  await i18n.changeLanguage('en-US')
})

afterEach(() => cleanup())

describe('AclPanel manage-session loss', () => {
  test('token A connected Save cannot use cached human token B ACL authority', async () => {
    installReads(acl())
    const { queryClient } = renderPanel()
    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    const staleSave = screen.getByTestId('acl-save') as HTMLButtonElement
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
      setToken('aws_s_acl-manage-b')
      queryClient.setQueryData(meQueryOptions('aws_s_acl-manage-b').queryKey, actorB)
      queryClient.setQueryData(aclQueryKey(), acl({ canManage: false }))
      fireEvent.click(staleSave)
    })
    expect(invocations).toBe(1)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
  })

  test('dirty visibility and members are discarded; restored access starts clean on the fresh OCC baseline', async () => {
    installReads(acl())
    mockedPut.mockResolvedValue(acl({ visibility: 'private', users: [CAROL], aclRevision: 8 }))
    const { queryClient } = renderPanel()

    const initialSave = (await screen.findByTestId('acl-save')) as HTMLButtonElement
    expect(initialSave.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(screen.getByTestId('acl-members-remove-bob'))
    expect(initialSave.disabled).toBe(false)
    expect(screen.getByTestId('acl-visibility-private').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('acl-members-remove-bob')).toBeNull()

    const downgraded = acl({
      visibility: 'public',
      users: [CAROL],
      canManage: false,
      aclRevision: 7,
    })
    publishAcl(queryClient, downgraded)
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
    expect(screen.getByText('DN carol')).toBeTruthy()

    publishAcl(queryClient, { ...downgraded, canManage: true })
    const restoredSave = (await screen.findByTestId('acl-save')) as HTMLButtonElement
    expect(restoredSave.disabled).toBe(true)
    expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('acl-visibility-private').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('acl-members-remove-carol')).toBeTruthy()
    expect(screen.queryByTestId('acl-members-remove-bob')).toBeNull()

    // Restoring permission alone never submits the ended draft.
    fireEvent.click(restoredSave)
    expect(mockedPut).not.toHaveBeenCalled()

    // A genuinely new edit uses the newly authoritative revision, preserving
    // the existing RFC-170 frozen-baseline contract rather than weakening it.
    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(restoredSave)
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))
    expect(mockedPut).toHaveBeenCalledWith(ACL_URL, {
      visibility: 'private',
      userIds: [CAROL.id],
      expectedResourceId: 'a1',
      expectedAclRevision: 7,
    })
  })

  test('an open owner-transfer draft is cleared and cannot reopen after false→true', async () => {
    installReads(acl(), [DAVE])
    const { queryClient } = renderPanel()

    fireEvent.click(await screen.findByTestId('acl-transfer-owner'))
    const transferInput = await screen.findByTestId('acl-transfer-input')
    fireEvent.focus(transferInput)
    fireEvent.click(await screen.findByTestId('acl-transfer-option-dave'))
    expect((screen.getByTestId('acl-transfer-confirm') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('acl-transfer-remove-dave')).toBeTruthy()

    const downgraded = acl({ users: [CAROL], canManage: false, aclRevision: 8 })
    publishAcl(queryClient, downgraded)
    await waitFor(() => expect(screen.queryByTestId('acl-transfer-dialog')).toBeNull())

    publishAcl(queryClient, { ...downgraded, canManage: true })
    fireEvent.click(await screen.findByTestId('acl-transfer-owner'))
    const confirm = (await screen.findByTestId('acl-transfer-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.queryByTestId('acl-transfer-remove-dave')).toBeNull()
    expect(mockedPut).not.toHaveBeenCalled()
  })

  test('a save already in flight cannot overwrite the downgrade or close a restored clean session', async () => {
    installReads(acl())
    const staleSave = deferred<ResourceAcl>()
    mockedPut
      .mockReturnValueOnce(staleSave.promise as never)
      .mockResolvedValueOnce(acl({ visibility: 'private', users: [CAROL], aclRevision: 10 }))
    const onSaved = vi.fn()
    const { queryClient } = renderPanel({ onSaved })

    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    fireEvent.click(screen.getByTestId('acl-save'))
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))

    const authoritative = acl({
      visibility: 'public',
      users: [CAROL],
      canManage: false,
      aclRevision: 9,
    })
    publishAcl(queryClient, authoritative)
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
    publishAcl(queryClient, { ...authoritative, canManage: true })
    const restoredSave = (await screen.findByTestId('acl-save')) as HTMLButtonElement
    expect(restoredSave.disabled).toBe(true)

    await act(async () => {
      staleSave.resolve(
        acl({
          visibility: 'private',
          users: [BOB],
          canManage: true,
          aclRevision: 4,
        }),
      )
      await staleSave.promise
    })

    expect(onSaved).not.toHaveBeenCalled()
    expect(queryClient.getQueryData<ResourceAcl>(aclQueryKey())).toEqual({
      ...authoritative,
      canManage: true,
    })
    expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('true')
    expect(restoredSave.disabled).toBe(true)
    expect(mockedPut).toHaveBeenCalledTimes(1)

    // The old promise does not poison or block the new permission generation.
    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(restoredSave)
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(2))
    expect(mockedPut.mock.calls[1]).toEqual([
      ACL_URL,
      {
        visibility: 'private',
        userIds: [CAROL.id],
        expectedResourceId: 'a1',
        expectedAclRevision: 9,
      },
    ])
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  test('a synchronous cache downgrade blocks the already-rendered Save handler before React commits', async () => {
    installReads(acl())
    const { queryClient } = renderPanel()
    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    const staleSave = screen.getByTestId('acl-save') as HTMLButtonElement
    expect(staleSave.disabled).toBe(false)

    // Do not await a render boundary: the captured control is still live and
    // its React handler really runs. The mutation fence must read query state
    // now, rather than the previous render's boolean ref.
    queryClient.setQueryData(aclQueryKey(), acl({ canManage: false, aclRevision: 4 }))
    fireEvent.click(staleSave)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
  })

  test('a cached successful ACL that later refetches with error fails closed', async () => {
    installReads(acl())
    const { queryClient } = renderPanel()
    expect(await screen.findByTestId('acl-save')).toBeTruthy()

    mockedGet.mockImplementation((path: string) => {
      if (path === ACL_URL) return Promise.reject(new Error('acl refresh failed')) as never
      if (path === '/api/auth/me') {
        return Promise.resolve({
          user: user('me', 'me'),
          source: 'session',
          permissions: [],
          linkedIdentities: [],
          pats: [],
        }) as never
      }
      if (path === '/api/users/search') return Promise.resolve([]) as never
      throw new Error(`Unexpected GET ${path}`)
    })
    await queryClient.refetchQueries({ queryKey: aclQueryKey() })

    // React Query intentionally retains the previous successful payload on a
    // background error; capability code must also consult query state.
    expect(queryClient.getQueryData<ResourceAcl>(aclQueryKey())?.canManage).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
    expect(mockedPut).not.toHaveBeenCalled()
  })

  test('an ACL refetch in progress ends the draft and a connected stale Save handler sends zero PUT', async () => {
    installReads(acl())
    const { queryClient } = renderPanel()
    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    const staleSave = screen.getByTestId('acl-save') as HTMLButtonElement
    expect(staleSave.disabled).toBe(false)

    const refresh = deferred<ResourceAcl>()
    mockedGet.mockImplementation((path: string) => {
      if (path === ACL_URL) return refresh.promise as never
      if (path === '/api/auth/me') {
        return Promise.resolve({
          user: user('me', 'me'),
          source: 'session',
          permissions: [],
          linkedIdentities: [],
          pats: [],
        }) as never
      }
      if (path === '/api/users/search') return Promise.resolve([]) as never
      throw new Error(`Unexpected GET ${path}`)
    })
    let handlerInvocations = 0
    staleSave.addEventListener('click', () => {
      handlerInvocations += 1
    })
    let refetch!: Promise<void>
    act(() => {
      refetch = queryClient.refetchQueries({ queryKey: aclQueryKey() })
      // Still connected in this act: the final request boundary, rather than
      // eventual DOM removal, is what must deny the old React handler.
      fireEvent.click(staleSave)
    })
    expect(handlerInvocations).toBe(1)
    expect(mockedPut).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())

    await act(async () => {
      refresh.resolve(acl())
      await refetch
    })
    const restoredSave = (await screen.findByTestId('acl-save')) as HTMLButtonElement
    expect(restoredSave.disabled).toBe(true)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  test('switching to a cached resource ends the old dirty session and re-baselines OCC', async () => {
    installReads(acl())
    mockedPut.mockResolvedValue(
      acl({ resourceId: 'a2', users: [CAROL], visibility: 'private', aclRevision: 13 }),
    )
    const { queryClient, rerenderPanel } = renderPanel()
    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    expect((screen.getByTestId('acl-save') as HTMLButtonElement).disabled).toBe(false)

    const siblingUrl = '/api/agents/y/acl'
    queryClient.setQueryData(
      ['acl', siblingUrl, getAuthSessionRevision()],
      acl({ resourceId: 'a2', users: [CAROL], visibility: 'public', aclRevision: 12 }),
    )
    rerenderPanel('/api/agents/y')

    const cleanSave = await screen.findByTestId('acl-save')
    expect((cleanSave as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('acl-members-remove-carol')).toBeTruthy()

    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(cleanSave)
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))
    expect(mockedPut).toHaveBeenCalledWith(siblingUrl, {
      visibility: 'private',
      userIds: [CAROL.id],
      expectedResourceId: 'a2',
      expectedAclRevision: 12,
    })
  })

  test('A → missing/error B → cached A cannot resurrect the old draft', async () => {
    installReads(acl())
    const { rerenderPanel } = renderPanel()
    fireEvent.click(await screen.findByTestId('acl-visibility-private'))
    expect((screen.getByTestId('acl-save') as HTMLButtonElement).disabled).toBe(false)

    rerenderPanel('/api/agents/missing')
    await waitFor(() => expect(screen.queryByTestId('acl-save')).toBeNull())
    rerenderPanel('/api/agents/x')
    const restored = (await screen.findByTestId('acl-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)
    expect(screen.getByTestId('acl-visibility-public').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(restored)
    expect(mockedPut).not.toHaveBeenCalled()
  })
})
