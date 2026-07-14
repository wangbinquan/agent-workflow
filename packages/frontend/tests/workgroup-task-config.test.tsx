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

  // RFC-181 A — autonomous rides the same only-changed diffing; the `?? false`
  // coalesce means an absent stored value and a false draft are "unchanged".
  test('autonomous: only-when-changed（含存储缺省≡false 的等价）', () => {
    const on = workgroupTaskConfigDraftFrom(config)
    on.autonomous = true
    expect(buildWorkgroupConfigPatch(config, on)).toEqual({ autonomous: true })

    const offOnStoredTrue = workgroupTaskConfigDraftFrom(makeConfig({ autonomous: true }))
    expect(offOnStoredTrue.autonomous).toBe(true)
    offOnStoredTrue.autonomous = false
    expect(buildWorkgroupConfigPatch(makeConfig({ autonomous: true }), offOnStoredTrue)).toEqual({
      autonomous: false,
    })

    // 存储无字段（老任务 config）+ draft false → 无变化。
    const untouched = workgroupTaskConfigDraftFrom(config)
    expect(untouched.autonomous).toBe(false)
    expect(buildWorkgroupConfigPatch(config, untouched)).toBeNull()
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

  test('isValidTaskMaxRounds mirrors the 1..1000 int rule (undefined = fine)', () => {
    expect(isValidTaskMaxRounds(undefined)).toBe(true)
    expect(isValidTaskMaxRounds(1)).toBe(true)
    expect(isValidTaskMaxRounds(1000)).toBe(true)
    expect(isValidTaskMaxRounds(0)).toBe(false)
    expect(isValidTaskMaxRounds(1001)).toBe(false)
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

function installFetch(
  overrides: { put?: () => Response; usersSearch?: unknown[] } = {},
): FetchCall[] {
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
      if (url.includes('/api/users/search')) return json(overrides.usersSearch ?? [])
      return json({})
    },
  )
  return calls
}

/** Drive the shared agent <Select> (RFC-168): open the combobox and pick an
 *  existing agent by its option label. The former datalist free-text box is
 *  gone, so tests select from /api/agents rather than typing a raw name. */
async function pickAgent(name: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workgroup-agent-name-input'))
  const listbox = await screen.findByRole('listbox')
  fireEvent.mouseDown(within(listbox).getByRole('option', { name }))
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

  // RFC-181 A —「全自动」进 mid-run 配置弹窗：拨动即 PUT {autonomous}，开启时
  // completionGate 开关置灰（与 WorkgroupForm 同款联动）。
  test('autonomous switch PUTs {autonomous:true} and grays the completion gate', async () => {
    const calls = installFetch()
    renderDialog(makeConfig())
    await screen.findByTestId('wg-config-submit')

    const gateSwitch = screen.getByLabelText(/Completion gate/) as HTMLInputElement
    expect(gateSwitch.disabled).toBe(false)

    fireEvent.click(screen.getByLabelText(/Autonomous \(don't interrupt me\)/))
    await waitFor(() => {
      expect((screen.getByTestId('wg-config-submit') as HTMLButtonElement).disabled).toBe(false)
    })
    expect((screen.getByLabelText(/Completion gate/) as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(screen.getByTestId('wg-config-submit'))
    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/workgroup-tasks/t1/config'),
      )
      expect(put).toBeTruthy()
      expect(put?.body).toEqual({ autonomous: true })
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
    await pickAgent('reviewer')
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

// ---------------------------------------------------------------------------
// RFC-168 §8.1 — dialog-shell behavior contract (increment).
// The detail page stopped opening these dialogs (the context panel edits in
// place), so the mid-run flow above is their ONLY remaining consumer. The
// MemberFields extraction must preserve the behaviors the shells relied on
// implicitly; each is locked here so a future refactor cannot break the
// Human path or the nested-dialog layering while everything else stays green.
// ---------------------------------------------------------------------------

describe('RFC-168 §8.1 — member dialog shell contract (mid-run)', () => {
  const bob = { id: 'u9', username: 'bob', displayName: 'Bob Li', role: 'user', status: 'active' }

  test('human staging full chain: pick → alias auto-follows → hand-edit stops it → roleDesc → staged + PUT', async () => {
    const calls = installFetch({ usersSearch: [bob] })
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-add-human'))
    await screen.findByTestId('workgroup-add-human-dialog')

    fireEvent.focus(screen.getByTestId('workgroup-member-user-input'))
    fireEvent.click(await screen.findByTestId('workgroup-member-user-option-bob'))
    // alias auto-followed the picked user's sanitized display name
    const alias = screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement
    expect(alias.value).toBe('BobLi')
    // hand-edit stops following
    fireEvent.change(alias, { target: { value: 'Bobby' } })
    fireEvent.change(screen.getByTestId('workgroup-member-role-input'), {
      target: { value: 'PM' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-human-confirm'))

    const staged = await screen.findByTestId('wg-config-add-Bobby')
    expect(within(staged).getByText('New')).toBeTruthy()
    fireEvent.click(screen.getByTestId('wg-config-submit'))
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put?.body).toEqual({
        addMembers: [{ memberType: 'human', userId: 'u9', displayName: 'Bobby', roleDesc: 'PM' }],
      })
    })
  })

  test('duplicate alias against the post-patch roster disables the confirm', async () => {
    installFetch()
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-add-agent'))
    await screen.findByTestId('workgroup-add-agent-dialog')
    await pickAgent('reviewer')
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: 'Worker' }, // clashes with the kept roster row
    })
    expect(screen.getByText('Display names must be unique within the group.')).toBeTruthy()
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('nested-dialog Esc closes ONLY the inner add dialog — the config dialog survives', async () => {
    installFetch()
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-add-agent'))
    const inner = await screen.findByTestId('workgroup-add-agent-dialog')
    fireEvent.keyDown(inner, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workgroup-add-agent-dialog')).toBeNull())
    expect(screen.getByTestId('workgroup-room-config-dialog')).toBeTruthy()
  })

  test('re-opening the add dialog starts from a FRESH draft (mount-on-open)', async () => {
    installFetch()
    renderDialog(makeConfig())
    fireEvent.click(await screen.findByTestId('wg-config-add-agent'))
    await screen.findByTestId('workgroup-add-agent-dialog')
    await pickAgent('reviewer')
    // cancel via the footer button, then re-open
    fireEvent.click(within(screen.getByTestId('workgroup-add-agent-dialog')).getByText('Cancel'))
    await waitFor(() => expect(screen.queryByTestId('workgroup-add-agent-dialog')).toBeNull())
    fireEvent.click(screen.getByTestId('wg-config-add-agent'))
    await screen.findByTestId('workgroup-add-agent-dialog')
    // Fresh mount cleared the picked agent — the Select trigger shows its
    // placeholder again and the confirm stays disabled (empty draft).
    expect(screen.getByTestId('workgroup-agent-name-input').textContent).not.toContain('reviewer')
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
