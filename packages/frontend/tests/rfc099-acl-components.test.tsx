// RFC-099 B4 — shared ACL/attribution components:
//   * AttributionChip — role labels (owner/user/admin), legacy 'local' rows
//   * UserPicker — search results add/remove, chips render
//   * AclPanel — manage vs read-only render, visibility toggle → PUT body,
//     hidden entirely under the daemon-token actor (D19)

import { fileURLToPath } from 'node:url'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { getAuthSessionRevision, setToken } from '../src/stores/auth'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedPut = vi.mocked(api.put)

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
}

function wrap(node: React.ReactElement, qc = makeQueryClient()) {
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

  test('activeOnly hides disabled accounts and exposes the required combobox semantics', async () => {
    mockedGet.mockResolvedValue([
      user('u1', 'alice'),
      { ...user('u2', 'disabled-bob'), status: 'disabled' },
    ])
    wrap(
      <UserPicker
        value={[]}
        onChange={() => {}}
        activeOnly
        aria-label="Required local user"
        aria-required
        aria-invalid
        testidPrefix="active"
      />,
    )
    const input = screen.getByTestId('active-input')
    fireEvent.focus(input)
    await waitFor(() => expect(screen.queryByTestId('active-option-alice')).toBeTruthy())
    expect(screen.queryByTestId('active-option-disabled-bob')).toBeNull()
    expect(input.getAttribute('aria-label')).toBe('Required local user')
    expect(input.getAttribute('aria-required')).toBe('true')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(mockedGet.mock.calls[0]?.[1]).toMatchObject({ limit: 100, status: 'active' })
  })

  test('ArrowUp/ArrowDown skip disabled accounts and Enter picks the active option', async () => {
    mockedGet.mockResolvedValue([
      user('u1', 'alice'),
      { ...user('u2', 'disabled-bob'), status: 'disabled' },
      user('u3', 'carol'),
    ])
    const onChange = vi.fn()
    wrap(<UserPicker value={[]} onChange={onChange} single testidPrefix="keyboard" />)
    const input = screen.getByTestId('keyboard-input')
    fireEvent.focus(input)
    const alice = await screen.findByTestId('keyboard-option-alice')
    const carol = screen.getByTestId('keyboard-option-carol')
    expect((screen.getByTestId('keyboard-option-disabled-bob') as HTMLButtonElement).disabled).toBe(
      true,
    )
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).toBe(alice.id))
    expect(alice.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(carol.id)
    expect(carol.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(alice.id)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(carol.id)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'u3' })])
    expect(input.getAttribute('aria-expanded')).toBe('false')

    // The selected portaled option disappears in a real Dialog, whose focus
    // trap immediately restores focus to the input. That recovery must not
    // reopen a single-select list that just completed its choice.
    fireEvent.focus(input)
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  test('Escape closes only the portaled listbox and clears aria-activedescendant', async () => {
    mockedGet.mockResolvedValue([user('u1', 'alice')])
    wrap(<UserPicker value={[]} onChange={() => {}} testidPrefix="escape" />)
    const input = screen.getByTestId('escape-input')
    fireEvent.focus(input)
    await screen.findByTestId('escape-option-alice')
    await waitFor(() => expect(input.getAttribute('aria-activedescendant')).not.toBeNull())

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(screen.queryByTestId('escape-option-alice')).toBeNull()
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
          grants: [{ user: user('u2', 'bob'), level: 'read' as const }],
          canEdit: true,
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
      grants: [],
      canEdit: true,
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
      grants: [{ userId: 'u2', level: 'read' }],
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

  test('read-only view uses the ACL snapshot after an unsaved manager draft', async () => {
    // Regression: the grant list is the editable draft and deliberately stops syncing while
    // dirty. If access changes during that window, the read-only branch must render the
    // authoritative `acl.grants`; otherwise it leaks the stale draft after management access
    // is revoked.
    setupGet({ canManage: true })
    const qc = makeQueryClient()
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />, qc)
    await waitFor(() => expect(screen.getByText('DN bob')).toBeTruthy())

    fireEvent.click(screen.getByTestId('acl-visibility-private'))
    fireEvent.click(screen.getByTestId('acl-transfer-owner'))
    await waitFor(() => expect(screen.queryByTestId('acl-transfer-dialog')).toBeTruthy())

    act(() => {
      qc.setQueryData(['acl', '/api/agents/x/acl', getAuthSessionRevision()], {
        resourceType: 'agent',
        resourceId: 'a1',
        ownerUserId: 'owner-1',
        owner: user('owner-1', 'alice'),
        visibility: 'public',
        grants: [{ user: user('u3', 'carol'), level: 'read' as const }],
        canEdit: true,
        canManage: false,
        aclRevision: 4,
      })
    })

    await waitFor(() => {
      expect(screen.queryByTestId('acl-save')).toBeNull()
      expect(screen.getByText('DN carol')).toBeTruthy()
      expect(screen.queryByText('DN bob')).toBeNull()
      expect(screen.queryByTestId('acl-transfer-dialog')).toBeNull()
      expect(
        screen.queryByText(
          'Private resources are visible and usable only by the owner and authorized users; admins always see everything.',
        ),
      ).toBeNull()
    })
  })

  test('saving a dirty draft keeps the revision captured before a background ACL update', async () => {
    setupGet({ canManage: true })
    mockedPut.mockResolvedValue({
      resourceType: 'agent',
      resourceId: 'a1',
      ownerUserId: 'owner-1',
      owner: user('owner-1', 'alice'),
      visibility: 'private',
      grants: [{ user: user('u2', 'bob'), level: 'read' as const }],
      canEdit: true,
      canManage: true,
      aclRevision: 5,
    })
    const qc = makeQueryClient()
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />, qc)
    await waitFor(() => expect(screen.getByText('DN bob')).toBeTruthy())

    fireEvent.click(screen.getByTestId('acl-visibility-private'))

    act(() => {
      qc.setQueryData(['acl', '/api/agents/x/acl', getAuthSessionRevision()], {
        resourceType: 'agent',
        resourceId: 'a1',
        ownerUserId: 'owner-1',
        owner: user('owner-1', 'alice'),
        visibility: 'public',
        grants: [{ user: user('u3', 'carol'), level: 'read' as const }],
        canEdit: true,
        canManage: true,
        aclRevision: 4,
      })
    })

    fireEvent.click(screen.getByTestId('acl-save'))
    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut).toHaveBeenCalledWith('/api/agents/x/acl', {
      visibility: 'private',
      grants: [{ userId: 'u2', level: 'read' }],
      expectedResourceId: 'a1',
      expectedAclRevision: 3,
    })
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
      grants: [],
      canEdit: true,
      canManage: true,
      aclRevision: 4,
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

// --- Header-button sizing. Launch stays the editor's sole primary action.
// RFC-250 restores Validate as a visible full-size secondary beside the
// existing More trigger; lower-frequency management remains in More. ---

describe('workflows editor header — one primary plus visible Validate and More actions', () => {
  test('Launch is unique primary; Validate and More are full-size secondaries', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
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
    expect(fullSizeSecondaryCount).toBe(2)
    expect(block).toContain('data-testid="workflow-validate"')
    expect(block).toContain('data-testid="workflow-more-actions"')
    expect(src).toContain('data-testid="workflow-actions-dialog"')
    expect(src).toContain('data-testid="workflow-acl-button"')
    expect(src).toContain('data-testid="workflow-delete-button"')
    expect(src).not.toContain('<AclDialogButton')
  })
})
