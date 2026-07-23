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
          aclRevision: 3, // RFC-170 §8
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
      aclRevision: 4,
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
      // RFC-170 §8: the panel echoes its held composite OCC precondition.
      expectedResourceId: 'a1',
      expectedAclRevision: 3,
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

  test('canTransferOwner defaults to true — a manager sees the transfer control', async () => {
    setupGet({ canManage: true })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    expect(screen.getByTestId('acl-transfer-owner')).toBeTruthy()
  })

  // Regression: closing the nested owner-transfer dialog must return focus to
  // the transfer button. WebKit (e2e-webkit-nightly run 29818632077, RFC-199
  // commit 21c2ab8a) failed e2e/rfc099-ownership-acl.spec.ts:245 because the
  // dialog auto-captured `document.activeElement` at open time and WebKit does
  // NOT focus a <button> on mouse click, so its close-time restore was a no-op.
  // The fix hands the Dialog an explicit `triggerRef`. happy-dom's fireEvent
  // click likewise leaves the button unfocused, so this reproduces the bug in
  // the main-CI suite: without the triggerRef, activeElement never lands back
  // on the button here.
  test('closing the owner-transfer dialog restores focus to the transfer button', async () => {
    setupGet({ canManage: true })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    const transferBtn = screen.getByTestId('acl-transfer-owner')
    // Deliberately do NOT focus the button first (mirrors WebKit's mouse click).
    expect(document.activeElement).not.toBe(transferBtn)
    fireEvent.click(transferBtn)
    await waitFor(() => expect(screen.queryByTestId('acl-transfer-dialog')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('acl-transfer-dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(transferBtn))
  })

  test('daemon-token actor (single-user mode) renders nothing (D19)', async () => {
    setupGet({ canManage: true, source: 'daemon' })
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    // Give the /me query a tick to resolve, then assert absence.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('acl-panel')).toBeNull()
  })

  test('AclDialogButton: opens the panel in a Dialog; a successful save CLOSES it', async () => {
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
    wrap(<AclDialogButton resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    const btn = await screen.findByTestId('acl-dialog-button')
    expect(screen.queryByTestId('acl-panel')).toBeNull()
    fireEvent.click(btn)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    // dirty the form, save → dialog closes (user feedback: 保存后必须关闭).
    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(screen.getByTestId('acl-save'))
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeNull())
  })

  test('AclDialogButton hidden under the daemon token (D19)', async () => {
    setupGet({ canManage: true, source: 'daemon' })
    wrap(<AclDialogButton resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('acl-dialog-button')).toBeNull()
  })
})

// --- Header-button sizing. RFC-198 promotes the editor's sole primary action
// (Launch) to the default page-primary target size. The visible More trigger
// shares that readable font/target size while its outline keeps the secondary
// hierarchy; lower-frequency actions remain inside the dialog. ---

describe('workflows editor header — one primary plus a same-size secondary More action', () => {
  test('Launch and More are full-size; utility actions stay compact and management lives in More', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(path.join(here, '../src/routes/workflows.edit.tsx'), 'utf8')
    const start = src.indexOf('const headerActions')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('const backgroundQueryError =', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    let primaryCount = 0
    let fullSizeSecondaryCount = 0
    for (const m of block.matchAll(/className="([^"]*)"/g)) {
      const cls = m[1] ?? ''
      if (!cls.split(/\s+/).includes('btn')) continue
      if (cls.split(/\s+/).includes('btn--primary')) {
        primaryCount += 1
        expect(cls).not.toContain('btn--sm')
      } else if (cls === 'btn') {
        fullSizeSecondaryCount += 1
      } else {
        expect(cls).toContain('btn--sm')
      }
    }
    expect(primaryCount).toBe(1)
    expect(fullSizeSecondaryCount).toBe(1)
    expect(block).toContain('data-testid="workflow-more-actions"')
    expect(src).toContain('data-testid="workflow-actions-dialog"')
    expect(src).toContain('data-testid="workflow-acl-button"')
    expect(src).toContain('data-testid="workflow-delete-button"')
    expect(src).not.toContain('<AclDialogButton')
  })
})
