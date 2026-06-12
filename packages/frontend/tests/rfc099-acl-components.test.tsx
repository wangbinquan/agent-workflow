// RFC-099 B4 — shared ACL/attribution components:
//   * AttributionChip — role labels (owner/user/admin), legacy 'local' rows
//   * UserPicker — search results add/remove, chips render
//   * AclPanel — manage vs read-only render, visibility toggle → PUT body,
//     hidden entirely under the daemon-token actor (D19)

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    },
  }
})

import { api } from '../src/api/client'
import { AclDialogButton, AclPanel } from '../src/components/AclPanel'
import { AttributionChip } from '../src/components/AttributionChip'
import { UserPicker } from '../src/components/UserPicker'
import { setToken } from '../src/stores/auth'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function user(id: string, username: string) {
  return { id, username, displayName: `DN ${username}`, role: 'user', status: 'active' }
}

beforeEach(() => {
  setToken('aws_s_test-token')
  mockedGet.mockReset()
  mockedPost.mockReset()
  mockedPut.mockReset()
})
afterEach(() => cleanup())

describe('AttributionChip', () => {
  test('renders display name + role label', () => {
    render(
      <AttributionChip userId="01HUSER" role="owner" user={user('01HUSER', 'alice') as never} />,
    )
    expect(screen.getByText('DN alice')).toBeTruthy()
    expect(screen.getByText('Owner')).toBeTruthy()
  })

  test("legacy 'local' rows render the historic fallback without a role", () => {
    render(<AttributionChip userId="local" role={null} />)
    expect(screen.getByText('Local user (historic)')).toBeTruthy()
  })

  test('unresolved id falls back to a shortened id', () => {
    render(<AttributionChip userId="01HUNKNOWNUSERIDXXXXYYYYZZ" role="user" />)
    expect(screen.getByText(/01HUNK…YYZZ|01HUNK/)).toBeTruthy()
    expect(screen.getByText('User')).toBeTruthy()
  })
})

describe('UserPicker', () => {
  test('search lists results; clicking adds a chip; × removes it', async () => {
    mockedGet.mockResolvedValue([user('u1', 'alice'), user('u2', 'bob')])
    const onChange = vi.fn()
    wrap(<UserPicker value={[]} onChange={onChange} testidPrefix="tp" />)
    fireEvent.focus(screen.getByTestId('tp-input'))
    await waitFor(() => expect(screen.queryByTestId('tp-option-alice')).toBeTruthy())
    fireEvent.click(screen.getByTestId('tp-option-alice'))
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'u1' })])

    cleanup()
    wrap(
      <UserPicker value={[user('u1', 'alice') as never]} onChange={onChange} testidPrefix="tp" />,
    )
    fireEvent.click(screen.getByTestId('tp-remove-alice'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  test('mousedown on the row (padding / empty area) focuses the input — the whole box is the field', async () => {
    // Regression: inside a Dialog, a click that landed on the row div (not
    // the input) parked focus on <body>, the dialog trap yanked it to the ×
    // button, and the field read as dead ("搜索用户那个textbox无法使用，是灰的").
    mockedGet.mockResolvedValue([])
    wrap(<UserPicker value={[]} onChange={() => {}} testidPrefix="tp" />)
    const input = screen.getByTestId('tp-input')
    const row = input.closest('.chips-input__row') as HTMLElement
    fireEvent.mouseDown(row)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  test('already-selected and excluded ids are filtered out of results', async () => {
    mockedGet.mockResolvedValue([user('u1', 'alice'), user('u2', 'bob'), user('u3', 'carol')])
    wrap(
      <UserPicker
        value={[user('u1', 'alice') as never]}
        onChange={() => {}}
        excludeIds={['u3']}
        testidPrefix="tp"
      />,
    )
    fireEvent.focus(screen.getByTestId('tp-input'))
    await waitFor(() => expect(screen.queryByTestId('tp-option-bob')).toBeTruthy())
    expect(screen.queryByTestId('tp-option-alice')).toBeNull()
    expect(screen.queryByTestId('tp-option-carol')).toBeNull()
  })
})

describe('AclPanel', () => {
  function mockMe(source: 'session' | 'daemon') {
    return {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
      source,
      permissions: [],
      linkedIdentities: [],
      pats: [],
    }
  }

  function setupGet(opts: { canManage: boolean; source?: 'session' | 'daemon' }) {
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/auth/me') return Promise.resolve(mockMe(opts.source ?? 'session'))
      if (path.endsWith('/acl')) {
        return Promise.resolve({
          resourceType: 'agent',
          resourceId: 'a1',
          ownerUserId: 'owner-1',
          owner: user('owner-1', 'alice'),
          visibility: 'public',
          users: [user('u2', 'bob')],
          canManage: opts.canManage,
        })
      }
      return Promise.resolve([])
    })
  }

  test('manager view: owner shown, visibility toggle dirties, save PUTs the body', async () => {
    setupGet({ canManage: true })
    mockedPut.mockResolvedValue({
      resourceType: 'agent',
      resourceId: 'a1',
      ownerUserId: 'owner-1',
      owner: user('owner-1', 'alice'),
      visibility: 'private',
      users: [],
      canManage: true,
    })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    expect(screen.getByText('DN alice')).toBeTruthy()
    const saveBtn = screen.getByTestId('acl-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)
    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut).toHaveBeenCalledWith('/api/agents/x/acl', {
      visibility: 'private',
      userIds: ['u2'],
    })
  })

  test('read-only view: no save button, members listed as plain chips', async () => {
    setupGet({ canManage: false })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    expect(screen.queryByTestId('acl-save')).toBeNull()
    expect(screen.queryByTestId('acl-transfer-owner')).toBeNull()
    expect(screen.getByText('DN bob')).toBeTruthy()
  })

  test('daemon-token actor (single-user mode) renders nothing (D19)', async () => {
    setupGet({ canManage: true, source: 'daemon' })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    // Give the /me query a tick to resolve, then assert absence.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('acl-panel')).toBeNull()
  })

  test('AclDialogButton: the uniform header entry opens the panel in a Dialog', async () => {
    setupGet({ canManage: true })
    wrap(<AclDialogButton resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    const btn = await screen.findByTestId('acl-dialog-button')
    expect(screen.queryByTestId('acl-panel')).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
  })

  test('AclDialogButton hidden under the daemon token (D19)', async () => {
    setupGet({ canManage: true, source: 'daemon' })
    wrap(<AclDialogButton resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('acl-dialog-button')).toBeNull()
  })
})
