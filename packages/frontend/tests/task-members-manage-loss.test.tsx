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
import { TASK_QUERY_KEYS } from '../src/lib/query-keys'

const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)
const membersKey = (taskId: string) => TASK_QUERY_KEYS.members(taskId, getAuthSessionRevision())

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
    members: [{ user: BOB, role: 'collaborator' as const }],
    canManage: true,
    canOperate: true,
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
      client.setQueryData(
        membersKey('a'),
        members('a', {
          canManage: false,
          members: [{ user: CAROL, role: 'collaborator' as const }],
        }),
      ),
    )
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    // RFC-324 —— 只读分支的 chip 现在带档位后缀（「DN carol · 协作者」），
    // 断言改成子串匹配：这里锁的是「降权后仍看得见成员」，不是文案的确切字节。
    expect(screen.getByText(/DN carol/)).toBeTruthy()

    act(() =>
      client.setQueryData(
        membersKey('a'),
        members('a', { members: [{ user: CAROL, role: 'collaborator' as const }] }),
      ),
    )
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
    // RFC-324：UserPicker 不再因为「拿到焦点」展开列表（Dialog 的初始焦点会让它
    // 盖住弹窗自己的按钮），展开挂在用户按下去那一刻——所以这里发 mouseDown。
    fireEvent.mouseDown(await screen.findByTestId('members-transfer-input'))
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

    const denied = members('a', {
      canManage: false,
      members: [{ user: CAROL, role: 'collaborator' as const }],
    })
    act(() => client.setQueryData(membersKey('a'), denied))
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    act(() => client.setQueryData(membersKey('a'), { ...denied, canManage: true }))
    const restored = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)

    await act(async () => {
      pending.resolve(members('a', { members: [], canManage: true }))
      await pending.promise
    })
    expect(client.getQueryData(membersKey('a'))).toEqual({ ...denied, canManage: true })
    expect(restored.disabled).toBe(true)
  })

  test('switching to a cached sibling task clears the old draft and old URL is never written', async () => {
    installReads({
      a: members('a'),
      b: members('b', { members: [{ user: CAROL, role: 'collaborator' as const }] }),
    })
    const { client, rerenderTask } = renderPanel('a')
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)
    client.setQueryData(
      membersKey('b'),
      members('b', { members: [{ user: CAROL, role: 'collaborator' as const }] }),
    )

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

  // RFC-319 B81 —— e2e `collab-multi-user.spec.ts`「grants a collaborator」在 Windows 分片
  // 上的红（CI run 32835038793）：面板的编辑快照 key 曾落在 `['tasks', taskId]` 之下，
  // useTaskSync 每次 WS 建连（reconcileOnOpen）与每一帧 task.status 都失效这个前缀，
  // 把快照打成 fetching ⇒ `liveCanManage` 为假 ⇒ 面板按「失去管理权」整体重置：Save
  // 先从 DOM 消失再以 disabled 回来、刚选的 chip 被冲掉、picker 的 onChange 静默丢弃。
  // 这条锁两面：无关的任务家族失效碰不到草稿（连一次 members 读都不许发出）；而**直接**
  // 失效快照本身仍然结束草稿——那是上面各条锁着的授权不变量，不能被这次修复顺手放松。
  test('an unrelated task-family invalidation neither refetches the snapshot nor ends the draft', async () => {
    installReads({ a: members('a') })
    const { client } = renderPanel()
    fireEvent.click(await screen.findByTestId('members-users-remove-bob'))
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)

    // 后续的 members 读一律悬着：真实 CI 上 refetch 在飞的窗口正是草稿被冲掉的窗口。
    const inflight = deferred<TaskMembers>()
    const membersReads = () =>
      mockedGet.mock.calls.filter(([path]) => path === '/api/tasks/a/members').length
    const before = membersReads()
    mockedGet.mockImplementation((path: string) =>
      path === '/api/tasks/a/members'
        ? (inflight.promise as never)
        : (Promise.resolve([CAROL]) as never),
    )

    // useTaskSync 的 reconcile 前缀 + 列表面的根前缀：两者都不该触达编辑快照。
    void client.invalidateQueries({ queryKey: TASK_QUERY_KEYS.detail('a') })
    void client.invalidateQueries({ queryKey: TASK_QUERY_KEYS.root() })
    expect(membersReads()).toBe(before)
    // 给 react-query 的通知调度（setTimeout 0）一个 tick，再断言草稿原封不动。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId('members-users-remove-bob')).toBeNull()
    expect((screen.getByTestId('members-save') as HTMLButtonElement).disabled).toBe(false)

    // 正向对照：直接失效快照本身仍旧结束草稿（fetching 期间管理面整体让位）……
    void client.invalidateQueries({ queryKey: membersKey('a') })
    expect(membersReads()).toBe(before + 1)
    await waitFor(() => expect(screen.queryByTestId('members-save')).toBeNull())
    // ……refetch 落定后回到干净会话：bob 回来了、Save 变灰。
    await act(async () => {
      inflight.resolve(members('a'))
      await inflight.promise
    })
    const restored = (await screen.findByTestId('members-save')) as HTMLButtonElement
    expect(restored.disabled).toBe(true)
    expect(screen.getByTestId('members-users-remove-bob')).toBeTruthy()
  })
})
