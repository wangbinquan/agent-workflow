// RFC-164 PR-5 — mid-run config dialog (WorkgroupTaskConfigDialog) +
// buildWorkgroupConfigPatch matrix.
//
// Locks:
//   1. Patch builder sends ONLY changed fields; no changes → null (submit
//      stays disabled — the backend would 422 workgroup-config-empty).
//   2. Leader row renders no remove control (mode/leader immutable §8.4);
//      other members toggle into removeMemberIds.
//   3. Member adds reuse the PR-1b dialogs and stage addMembers entries.
//   4. Backend error codes surface as friendly copy (errors.* i18n map).
//   5. free_collab renders the three switches disabled (forced-on view).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupTaskConfigDialog } from '../src/components/workgroup/WorkgroupTaskConfigDialog'
import {
  buildWorkgroupConfigPatch,
  isValidTaskMaxRounds,
  workgroupTaskConfigDraftFrom,
} from '../src/lib/workgroup-room'
import '../src/i18n'

function makeConfig(over: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'review-squad',
    mode: 'leader_worker',
    leaderMemberId: 'mem_lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    instructions: '',
    goal: 'ship it',
    members: [
      {
        id: 'mem_lead',
        memberType: 'agent',
        agentName: 'coordinator',
        userId: null,
        displayName: 'Lead',
        roleDesc: '',
      },
      {
        id: 'mem_work',
        memberType: 'agent',
        agentName: 'worker',
        userId: null,
        displayName: 'Worker',
        roleDesc: '',
      },
    ],
    ...over,
  }
}

describe('buildWorkgroupConfigPatch — only-changed-fields matrix', () => {
  const config = makeConfig()

  test('untouched draft → null (empty patch is not sendable)', () => {
    expect(buildWorkgroupConfigPatch(config, workgroupTaskConfigDraftFrom(config))).toBeNull()
  })

  test('one switch flip carries the FULL switches triple and nothing else', () => {
    const draft = workgroupTaskConfigDraftFrom(config)
    draft.switches.blackboard = true
    expect(buildWorkgroupConfigPatch(config, draft)).toEqual({
      switches: { shareOutputs: true, directMessages: false, blackboard: true },
    })
  })

  test('maxRounds: only when defined AND different; cleared field = unchanged', () => {
    const changed = workgroupTaskConfigDraftFrom(config)
    changed.maxRounds = 50
    expect(buildWorkgroupConfigPatch(config, changed)).toEqual({ maxRounds: 50 })
    const cleared = workgroupTaskConfigDraftFrom(config)
    cleared.maxRounds = undefined
    expect(buildWorkgroupConfigPatch(config, cleared)).toBeNull()
    const same = workgroupTaskConfigDraftFrom(config)
    same.maxRounds = 20
    expect(buildWorkgroupConfigPatch(config, same)).toBeNull()
  })

  test('completionGate flip / member add / member remove each ride alone', () => {
    const gate = workgroupTaskConfigDraftFrom(config)
    gate.completionGate = true
    expect(buildWorkgroupConfigPatch(config, gate)).toEqual({ completionGate: true })

    const add = workgroupTaskConfigDraftFrom(config)
    add.addMembers = [
      { memberType: 'agent', agentName: 'reviewer', displayName: 'Reviewer', roleDesc: 'r' },
      { memberType: 'human', userId: 'u9', displayName: 'Bob', roleDesc: '' },
    ]
    expect(buildWorkgroupConfigPatch(config, add)).toEqual({
      addMembers: [
        { memberType: 'agent', agentName: 'reviewer', displayName: 'Reviewer', roleDesc: 'r' },
        { memberType: 'human', userId: 'u9', displayName: 'Bob', roleDesc: '' },
      ],
    })

    const rm = workgroupTaskConfigDraftFrom(config)
    rm.removeMemberIds = ['mem_work']
    expect(buildWorkgroupConfigPatch(config, rm)).toEqual({ removeMemberIds: ['mem_work'] })
  })

  test('isValidTaskMaxRounds mirrors the 1..500 int rule (undefined = fine)', () => {
    expect(isValidTaskMaxRounds(undefined)).toBe(true)
    expect(isValidTaskMaxRounds(1)).toBe(true)
    expect(isValidTaskMaxRounds(500)).toBe(true)
    expect(isValidTaskMaxRounds(0)).toBe(false)
    expect(isValidTaskMaxRounds(501)).toBe(false)
    expect(isValidTaskMaxRounds(2.5)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dialog behaviour
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(overrides: { put?: () => Response } = {}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/config') && method === 'PUT') {
        return overrides.put !== undefined ? overrides.put() : json({ changes: ['x'] })
      }
      if (url.includes('/api/agents')) return json([{ name: 'reviewer' }])
      if (url.includes('/api/users/search')) return json([])
      return json({})
    },
  )
  return calls
}

function renderDialog(config: WorkgroupRuntimeConfig, onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WorkgroupTaskConfigDialog taskId="t1" config={config} onClose={onClose} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('WorkgroupTaskConfigDialog', () => {
  test('submit disabled while nothing changed; a gate flip PUTs ONLY {completionGate}', async () => {
    const calls = installFetch()
    renderDialog(makeConfig())
    const submit = (await screen.findByTestId('wg-config-submit')) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByTestId('wg-config-empty-hint')).toBeTruthy()

    // Flip the completion gate switch. Regex matcher: the wrapping <label>
    // also contains the hint text, so an exact-string lookup misses.
    fireEvent.click(screen.getByLabelText(/Completion gate/))
    await waitFor(() => {
      expect((screen.getByTestId('wg-config-submit') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('wg-config-submit'))
    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/workgroup-tasks/t1/config'),
      )
      expect(put).toBeTruthy()
      expect(put?.body).toEqual({ completionGate: true })
    })
  })

  test('leader row has no remove control; staging a worker removal PUTs removeMemberIds', async () => {
    const calls = installFetch()
    renderDialog(makeConfig())
    const leadRow = await screen.findByTestId('wg-config-member-Lead')
    expect(within(leadRow).queryByTestId('wg-config-remove-Lead')).toBeNull()

    const removeBtn = screen.getByTestId('wg-config-remove-Worker')
    fireEvent.click(removeBtn)
    // Staged: chip + undo label.
    const row = screen.getByTestId('wg-config-member-Worker')
    expect(within(row).getByText('Removing')).toBeTruthy()
    fireEvent.click(screen.getByTestId('wg-config-submit'))
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put?.body).toEqual({ removeMemberIds: ['mem_work'] })
    })
  })

  test('undoing a staged removal re-empties the patch (submit disabled again)', async () => {
    installFetch()
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-remove-Worker'))
    expect((screen.getByTestId('wg-config-submit') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('wg-config-remove-Worker')) // undo
    expect((screen.getByTestId('wg-config-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('adding an agent member via the reused PR-1b dialog stages addMembers', async () => {
    const calls = installFetch()
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-add-agent'))
    // The reused AgentMemberDialog from WorkgroupMemberCards.
    await screen.findByTestId('workgroup-add-agent-dialog')
    fireEvent.change(screen.getByTestId('workgroup-agent-name-input'), {
      target: { value: 'reviewer' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-agent-confirm'))
    // Staged row appears with the New chip.
    const staged = await screen.findByTestId('wg-config-add-reviewer')
    expect(within(staged).getByText('New')).toBeTruthy()
    fireEvent.click(screen.getByTestId('wg-config-submit'))
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put?.body).toEqual({
        addMembers: [
          { memberType: 'agent', agentName: 'reviewer', displayName: 'reviewer', roleDesc: '' },
        ],
      })
    })
  })

  test('backend error codes map to friendly copy (duplicate member)', async () => {
    installFetch({
      put: () =>
        new Response(
          JSON.stringify({
            ok: false,
            code: 'workgroup-config-duplicate-member',
            message: "displayName 'Worker' already exists in the group",
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    })
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-remove-Worker'))
    fireEvent.click(screen.getByTestId('wg-config-submit'))
    const err = await screen.findByTestId('wg-config-error')
    expect(err.textContent).toContain('A member with this display name already exists.')
    expect(err.textContent).not.toContain('workgroup-config-duplicate-member')
  })

  test('free_collab renders the three switches disabled (forced-on view)', async () => {
    installFetch()
    renderDialog(makeConfig({ mode: 'free_collab', leaderMemberId: null }))
    await screen.findByTestId('wg-config-fc-notice')
    const share = screen.getByLabelText('Share outputs') as HTMLInputElement
    expect(share.disabled).toBe(true)
    expect(share.checked).toBe(true)
  })
})
