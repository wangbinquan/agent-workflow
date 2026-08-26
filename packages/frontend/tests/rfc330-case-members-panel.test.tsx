// RFC-330 D19/D20 —— 案例页复用任务成员面板：只换资源适配器（URL / 缓存键 / 响应 id /
// 失效键），面板行为不变。锁四件事：
//   ① 案例适配器打 /api/employee-cases/:id/members，GET 的 caseId 变体被当作当前资源；
//   ② owner（canManage）能保存成员，PUT 打同一 URL；
//   ③ observer（canManage=false）只看到只读成员列表、没有保存 / 转移控件；
//   ④ 响应里的 caseId 与当前案例不一致 ⇒ 不进入管理会话（串线保护沿用任务侧）。

import type { CaseMembers, UserPublic } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { caseMembersAdapter } from '../src/components/digital-employees/CaseMembersDialogButton'
import { MembersPanel } from '../src/components/tasks/TaskMembersPanel'
import i18n from '../src/i18n'
import { setToken } from '../src/stores/auth'

const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)

function user(id: string, username: string): UserPublic {
  return { id, username, displayName: `DN ${username}`, role: 'user', status: 'active' }
}

const OWNER = user('owner', 'owner')
const BOB = user('bob', 'bob')
const CAROL = user('carol', 'carol')

function members(caseId: string, overrides: Partial<CaseMembers> = {}): CaseMembers {
  return {
    caseId,
    ownerUserId: OWNER.id,
    owner: OWNER,
    members: [{ user: BOB, role: 'collaborator' as const }],
    canManage: true,
    canOperate: true,
    ...overrides,
  }
}

function installReads(rows: Record<string, CaseMembers>): void {
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
    const match = /^\/api\/employee-cases\/([^/]+)\/members$/.exec(path)
    if (match !== null && rows[match[1] ?? ''] !== undefined) {
      return Promise.resolve(rows[match[1] ?? '']) as never
    }
    if (path === '/api/users/search') return Promise.resolve([CAROL]) as never
    throw new Error(`Unexpected GET ${path}`)
  })
}

function renderPanel(caseId = 'case-a') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  render(
    <QueryClientProvider client={client}>
      <MembersPanel adapter={caseMembersAdapter(caseId)} />
    </QueryClientProvider>,
  )
  return client
}

beforeEach(async () => {
  setToken('tok-case-members')
  mockedGet.mockReset()
  mockedPut.mockReset()
  await i18n.changeLanguage('en-US')
})

afterEach(() => cleanup())

describe('MembersPanel with the employee case adapter', () => {
  test('owner: GET the case members URL, edits and PUTs to the same URL', async () => {
    installReads({ 'case-a': members('case-a') })
    mockedPut.mockResolvedValue(members('case-a', { members: [] }) as never)
    renderPanel()
    expect(await screen.findByTestId('members-users-remove-bob')).toBeTruthy()
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/employee-cases/case-a/members',
      undefined,
      expect.anything(),
    )
    fireEvent.click(screen.getByTestId('members-users-remove-bob'))
    fireEvent.click(screen.getByTestId('members-save'))
    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1))
    expect(mockedPut).toHaveBeenCalledWith('/api/employee-cases/case-a/members', { members: [] })
  })

  test('observer (canManage=false): read-only member chips, no save / transfer controls', async () => {
    installReads({
      'case-a': members('case-a', {
        canManage: false,
        canOperate: false,
        members: [{ user: BOB, role: 'observer' }],
      }),
    })
    renderPanel()
    expect(await screen.findByTestId('task-members-panel')).toBeTruthy()
    expect(screen.queryByTestId('members-save')).toBeNull()
    expect(screen.queryByTestId('members-transfer-owner')).toBeNull()
    expect(screen.queryByTestId('members-users-remove-bob')).toBeNull()
    expect(screen.getByText(/DN bob/)).toBeTruthy()
  })

  test('a response whose caseId is another case never opens a manage session', async () => {
    installReads({ 'case-a': members('case-other') })
    renderPanel()
    expect(await screen.findByTestId('task-members-panel')).toBeTruthy()
    expect(screen.queryByTestId('members-save')).toBeNull()
    expect(screen.queryByTestId('members-transfer-owner')).toBeNull()
  })
})
