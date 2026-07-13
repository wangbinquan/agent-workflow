// RFC-164 PR-1 — workgroup pure-helper matrix + config-form behavior.
//
// Locks (save-lenient / launch-strict contract, 决策 #21):
//   1. buildQuickCreatePayload — the list-page dialog POSTs {name,
//      description} ONLY; name token rules still gate.
//   2. buildConfigUpdatePayload — leaderless leader_worker groups and empty
//      member sets are SAVE-VALID; members pass through from the stored
//      group untouched (PUT is full-replace).
//   3. Member-card pure ops (addMember / removeMember / patchMember /
//      setLeader) — leaderKey semantics: removing the leader clears the
//      flag, only agent rows may take it.
//   4. validateMemberDraft — the only save-blocking rules left: displayName
//      non-empty / unique / no @-comma-whitespace, human rows need a picked
//      user, agent rows an agentName (dangling names are LEGAL).
//   5. free_collab renders the three collaboration switches disabled+on
//      WITHOUT mutating stored values (switch-back restores them).

import { afterEach, describe, expect, test } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Workgroup } from '@agent-workflow/shared'
import { WorkgroupForm } from '../src/components/workgroup/WorkgroupForm'
import {
  addMember,
  buildConfigUpdatePayload,
  buildMembersUpdatePayload,
  buildQuickCreatePayload,
  deriveMemberAlias,
  makeAgentMemberRow,
  makeHumanMemberRow,
  patchMember,
  removeMember,
  sanitizeMemberAlias,
  setLeader,
  validateMemberDraft,
  workgroupLeaderDisplayName,
  workgroupToConfigDraft,
  workgroupToMembersState,
  type WorkgroupConfigDraft,
} from '../src/lib/workgroup-form'
import '../src/i18n'

const STORED: Workgroup = {
  id: 'wg_1',
  name: 'review-squad',
  description: 'audits PRs',
  instructions: 'be nice',
  mode: 'leader_worker',
  leaderMemberId: 'mem_1',
  switches: { shareOutputs: true, directMessages: true, blackboard: false },
  maxRounds: 33,
  completionGate: true,
  members: [
    {
      id: 'mem_2',
      memberType: 'human',
      agentName: null,
      userId: 'u1',
      displayName: 'Alice',
      roleDesc: 'reviews',
      sortOrder: 1,
    },
    {
      id: 'mem_1',
      memberType: 'agent',
      agentName: 'coder',
      userId: null,
      displayName: 'Coder',
      roleDesc: 'writes code',
      sortOrder: 0,
    },
  ],
  ownerUserId: 'u1',
  visibility: 'public',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 2,
}

// ---------------------------------------------------------------------------
// Quick create
// ---------------------------------------------------------------------------

describe('buildQuickCreatePayload', () => {
  test('a valid name + description builds the two-field POST body', () => {
    const built = buildQuickCreatePayload({ name: 'review-squad', description: 'audits PRs' })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.payload).toEqual({ name: 'review-squad', description: 'audits PRs' })
    }
  })

  test('empty / malformed names are rejected', () => {
    const empty = buildQuickCreatePayload({ name: '', description: '' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors.name).toBe('workgroups.errors.nameRequired')
    const bad = buildQuickCreatePayload({ name: 'Bad Name!', description: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.name).toBe('workgroups.errors.nameInvalid')
  })
})

// ---------------------------------------------------------------------------
// Config update (members pass through)
// ---------------------------------------------------------------------------

describe('buildConfigUpdatePayload', () => {
  test('carries the draft config, passes stored members + server description through', () => {
    // 2026-07-13: description left the config draft (it's edited in the rename
    // dialog). buildConfigUpdatePayload passes the SERVER's description through
    // unchanged, so a config save can never revert a dialog description edit.
    const built = buildConfigUpdatePayload(workgroupToConfigDraft(STORED), STORED)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.description).toBe(STORED.description)
    expect(built.payload.leaderDisplayName).toBe('Coder')
    expect(built.payload.maxRounds).toBe(33)
    // Members pass through sorted by sortOrder — no name key on updates.
    expect('name' in built.payload).toBe(false)
    expect(built.payload.members).toEqual([
      { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
      { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
    ])
  })

  test('RFC-180: autonomous round-trips draft ↔ payload (default off; on when set)', () => {
    // STORED has no autonomous → draft defaults false → payload false.
    const asDraft = workgroupToConfigDraft(STORED)
    expect(asDraft.autonomous).toBe(false)
    const on = buildConfigUpdatePayload({ ...asDraft, autonomous: true }, STORED)
    expect(on.ok && on.payload.autonomous).toBe(true)
    const off = buildConfigUpdatePayload({ ...asDraft, autonomous: false }, STORED)
    expect(off.ok && off.payload.autonomous).toBe(false)
  })

  test('description is sourced from the server row, never the draft (2026-07-13 decouple)', () => {
    // Editing an unrelated config field still carries the server description
    // through verbatim — the rename dialog is its only editor now, so the
    // config PUT can never clobber it.
    const group: Workgroup = { ...STORED, description: 'server-owned copy' }
    const draft = { ...workgroupToConfigDraft(group), instructions: 'edited charter' }
    const built = buildConfigUpdatePayload(draft, group)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.description).toBe('server-owned copy')
    expect(built.payload.instructions).toBe('edited charter')
  })

  test('a leaderless leader_worker group SAVES (决策 #21 — launch is the strict gate)', () => {
    const group: Workgroup = { ...STORED, leaderMemberId: null }
    const built = buildConfigUpdatePayload(workgroupToConfigDraft(group), group)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.leaderDisplayName).toBeUndefined()
  })

  test('an empty member set SAVES', () => {
    const group: Workgroup = { ...STORED, leaderMemberId: null, members: [] }
    const built = buildConfigUpdatePayload(workgroupToConfigDraft(group), group)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.members).toEqual([])
  })

  test('switching the draft to free_collab omits leaderDisplayName', () => {
    const draft = workgroupToConfigDraft(STORED)
    draft.mode = 'free_collab'
    const built = buildConfigUpdatePayload(draft, STORED)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.leaderDisplayName).toBeUndefined()
  })

  test('RFC-168 F3 — draft mode dynamic_workflow + stored human members yields a stable `mode` error key', () => {
    const draft = workgroupToConfigDraft(STORED) // STORED includes a human row
    draft.mode = 'dynamic_workflow'
    const built = buildConfigUpdatePayload(draft, STORED)
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.errors.mode).toBe('workgroups.errors.dynamicNoHumanMembers')
    // agent-only groups switch modes freely
    const agentOnly: Workgroup = {
      ...STORED,
      leaderMemberId: null,
      members: STORED.members.filter((m) => m.memberType === 'agent'),
    }
    const ok = buildConfigUpdatePayload(
      { ...workgroupToConfigDraft(agentOnly), mode: 'dynamic_workflow' },
      agentOnly,
    )
    expect(ok.ok).toBe(true)
  })

  // Cap raised 500 → 1000 (2026-07-13): 1000 is accepted, 1001 rejected.
  test.each([[0], [1001], [2.5]])('maxRounds=%p is rejected', (maxRounds) => {
    const draft = workgroupToConfigDraft(STORED)
    draft.maxRounds = maxRounds
    const built = buildConfigUpdatePayload(draft, STORED)
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.errors.maxRounds).toBe('workgroups.errors.maxRoundsInvalid')
  })

  test('maxRounds=1000 (the new cap) is accepted', () => {
    const draft = workgroupToConfigDraft(STORED)
    draft.maxRounds = 1000
    expect(buildConfigUpdatePayload(draft, STORED).ok).toBe(true)
  })

  test('cleared maxRounds falls back to the default 1000', () => {
    const draft = workgroupToConfigDraft(STORED)
    draft.maxRounds = undefined
    const built = buildConfigUpdatePayload(draft, STORED)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.maxRounds).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// Member-card pure ops
// ---------------------------------------------------------------------------

describe('member-card ops (add / remove / patch / setLeader)', () => {
  test('workgroupToMembersState sorts rows by sortOrder and keys them by member id', () => {
    const state = workgroupToMembersState(STORED)
    expect(state.members.map((m) => m.key)).toEqual(['mem_1', 'mem_2'])
    expect(state.leaderKey).toBe('mem_1')
  })

  test('addMember appends and keeps the leader flag', () => {
    const state = workgroupToMembersState(STORED)
    const next = addMember(
      state,
      makeAgentMemberRow({ agentName: 'auditor', displayName: 'Auditor' }),
    )
    expect(next.members).toHaveLength(3)
    expect(next.members[2]).toMatchObject({
      memberType: 'agent',
      agentName: 'auditor',
      displayName: 'Auditor',
      roleDesc: '',
    })
    expect(next.leaderKey).toBe('mem_1')
  })

  test('makeHumanMemberRow carries the picked user id', () => {
    const row = makeHumanMemberRow({ userId: 'u9', displayName: 'Ann', roleDesc: 'PM' })
    expect(row).toMatchObject({
      memberType: 'human',
      userId: 'u9',
      displayName: 'Ann',
      roleDesc: 'PM',
    })
  })

  test('removeMember drops the row; removing the LEADER clears the flag', () => {
    const state = workgroupToMembersState(STORED)
    const noAlice = removeMember(state, 'mem_2')
    expect(noAlice.members.map((m) => m.key)).toEqual(['mem_1'])
    expect(noAlice.leaderKey).toBe('mem_1')
    const noLeader = removeMember(state, 'mem_1')
    expect(noLeader.members.map((m) => m.key)).toEqual(['mem_2'])
    expect(noLeader.leaderKey).toBeNull()
  })

  test('patchMember edits only the targeted row (alias + roleDesc)', () => {
    const state = workgroupToMembersState(STORED)
    const next = patchMember(state, 'mem_2', { displayName: 'Alicia', roleDesc: 'lead reviewer' })
    expect(next.members.find((m) => m.key === 'mem_2')).toMatchObject({
      displayName: 'Alicia',
      roleDesc: 'lead reviewer',
      userId: 'u1',
    })
    expect(next.members.find((m) => m.key === 'mem_1')?.displayName).toBe('Coder')
  })

  test('setLeader accepts agent rows, no-ops on human/unknown rows, null unsets', () => {
    const base = workgroupToMembersState(STORED)
    const state = addMember(
      base,
      makeAgentMemberRow({ agentName: 'auditor', displayName: 'Auditor' }),
    )
    const auditorKey = state.members[2]!.key
    expect(setLeader(state, auditorKey).leaderKey).toBe(auditorKey)
    expect(setLeader(state, 'mem_2')).toBe(state) // human — no-op
    expect(setLeader(state, 'nope')).toBe(state) // unknown — no-op
    expect(setLeader(state, null).leaderKey).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Member draft validation (dialog gating)
// ---------------------------------------------------------------------------

describe('validateMemberDraft', () => {
  const others = [{ displayName: 'Coder' }]

  test('duplicate displayName against the rest of the group is rejected', () => {
    const errors = validateMemberDraft(
      { memberType: 'agent', agentName: 'auditor', userId: '', displayName: 'Coder' },
      others,
    )
    expect(errors.displayName).toBe('workgroups.errors.displayNameDuplicate')
  })

  test.each([
    ['with @', 'Co@der'],
    ['with whitespace', 'Co der'],
    ['with comma', 'Co,der'],
  ])('displayName %s is rejected', (_label, displayName) => {
    const errors = validateMemberDraft(
      { memberType: 'agent', agentName: 'auditor', userId: '', displayName },
      others,
    )
    expect(errors.displayName).toBe('workgroups.errors.displayNameInvalid')
  })

  test('empty displayName is required; >64 chars is too long', () => {
    expect(
      validateMemberDraft(
        { memberType: 'agent', agentName: 'a', userId: '', displayName: '  ' },
        [],
      ).displayName,
    ).toBe('workgroups.errors.displayNameRequired')
    expect(
      validateMemberDraft(
        { memberType: 'agent', agentName: 'a', userId: '', displayName: 'x'.repeat(65) },
        [],
      ).displayName,
    ).toBe('workgroups.errors.displayNameTooLong')
  })

  test('human drafts need a picked user; agent drafts need an agentName (dangling is legal)', () => {
    expect(
      validateMemberDraft(
        { memberType: 'human', agentName: '', userId: '', displayName: 'Ann' },
        [],
      ).userId,
    ).toBe('workgroups.errors.userRequired')
    expect(
      validateMemberDraft(
        { memberType: 'agent', agentName: ' ', userId: '', displayName: 'Bot' },
        [],
      ).agentName,
    ).toBe('workgroups.errors.agentNameRequired')
    expect(
      validateMemberDraft(
        { memberType: 'agent', agentName: 'does-not-exist-yet', userId: '', displayName: 'Bot' },
        [],
      ),
    ).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Members update payload
// ---------------------------------------------------------------------------

describe('buildMembersUpdatePayload', () => {
  test('config passes through from the group; members + leader come from the state', () => {
    const state = addMember(
      workgroupToMembersState(STORED),
      makeAgentMemberRow({ agentName: 'auditor', displayName: 'Auditor', roleDesc: 'audits' }),
    )
    const built = buildMembersUpdatePayload(STORED, state)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.description).toBe('audits PRs')
    expect(built.payload.maxRounds).toBe(33)
    expect(built.payload.leaderDisplayName).toBe('Coder')
    expect(built.payload.members).toEqual([
      { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
      { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
      { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: 'audits' },
    ])
  })

  test('a leaderless state in leader_worker mode still builds (lenient save)', () => {
    const state = setLeader(workgroupToMembersState(STORED), null)
    const built = buildMembersUpdatePayload(STORED, state)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.leaderDisplayName).toBeUndefined()
  })

  test('removing every member builds an empty members array', () => {
    let state = workgroupToMembersState(STORED)
    state = removeMember(state, 'mem_1')
    state = removeMember(state, 'mem_2')
    const built = buildMembersUpdatePayload(STORED, state)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.members).toEqual([])
  })

  test('a leader key pointing at a human row is rejected', () => {
    const state = workgroupToMembersState(STORED)
    const built = buildMembersUpdatePayload(STORED, { ...state, leaderKey: 'mem_2' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.errors.leader).toBe('workgroups.errors.leaderMustBeAgent')
  })

  test('duplicate displayNames in the state are rejected per row', () => {
    const state = patchMember(workgroupToMembersState(STORED), 'mem_2', { displayName: 'Coder' })
    const built = buildMembersUpdatePayload(STORED, state)
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.errors['member-0-displayName']).toBe('workgroups.errors.displayNameDuplicate')
      expect(built.errors['member-1-displayName']).toBe('workgroups.errors.displayNameDuplicate')
    }
  })
})

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe('display helpers', () => {
  test('workgroupLeaderDisplayName resolves the leader; free_collab / unset read null', () => {
    expect(workgroupLeaderDisplayName(STORED)).toBe('Coder')
    expect(workgroupLeaderDisplayName({ ...STORED, mode: 'free_collab' })).toBeNull()
    expect(workgroupLeaderDisplayName({ ...STORED, leaderMemberId: null })).toBeNull()
  })

  test('sanitizeMemberAlias / deriveMemberAlias strip mention-breaking chars', () => {
    expect(sanitizeMemberAlias('Alice Wang')).toBe('AliceWang')
    expect(deriveMemberAlias({ displayName: 'Alice Wang', username: 'alice' })).toBe('AliceWang')
    expect(deriveMemberAlias({ displayName: '@,  ', username: 'alice' })).toBe('alice')
  })
})

// ---------------------------------------------------------------------------
// Config form behavior (free_collab switch gating)
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
})

function baseDraft(): WorkgroupConfigDraft {
  return {
    instructions: '',
    mode: 'leader_worker',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    autonomous: false,
  }
}

/** Stateful harness mirroring the detail page's controlled-form wiring. */
function Harness({ initial }: { initial?: WorkgroupConfigDraft }) {
  const [draft, setDraft] = useState<WorkgroupConfigDraft>(initial ?? baseDraft())
  return <WorkgroupForm value={draft} onChange={setDraft} errors={{}} />
}

function switchInput(label: RegExp): HTMLInputElement {
  return screen.getByRole('checkbox', { name: label }) as HTMLInputElement
}

describe('WorkgroupForm — free_collab switch gating', () => {
  test('fc disables the three switches, shows them on, and restores on switch-back', () => {
    render(<Harness />)
    expect(switchInput(/Share outputs/).checked).toBe(true)
    expect(switchInput(/Direct messages/).checked).toBe(false)
    expect(switchInput(/Direct messages/).disabled).toBe(false)

    // Flip blackboard on so switch-back has a non-default value to restore.
    fireEvent.click(switchInput(/Broadcast messages/))
    expect(switchInput(/Broadcast messages/).checked).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Free collaboration' }))
    for (const label of [/Share outputs/, /Direct messages/, /Broadcast messages/]) {
      expect(switchInput(label).checked).toBe(true)
      expect(switchInput(label).disabled).toBe(true)
    }
    expect(screen.getByTestId('workgroup-fc-switches-notice')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Leader-Worker' }))
    expect(switchInput(/Share outputs/).checked).toBe(true)
    expect(switchInput(/Direct messages/).checked).toBe(false)
    expect(switchInput(/Broadcast messages/).checked).toBe(true)
    expect(switchInput(/Direct messages/).disabled).toBe(false)
    expect(screen.queryByTestId('workgroup-fc-switches-notice')).toBeNull()
  })

  // RFC-167 / 2026-07-14: dynamic_workflow has no chatroom — none of the
  // switches / maxRounds / completion gate apply, so the whole "Collaboration
  // switches" section is OMITTED. Regression guard: an empty section header
  // carrying only a "does-not-apply" notice was noise (user 2026-07-14 —
  // 「没有协作开关就不要显示协作开关，还写个备注干什么」); the mode hint
  // already says members are the orchestratable pool.
  test('dynamic_workflow omits the whole switches section (no header, no notice)', () => {
    render(<Harness />)
    expect(switchInput(/Share outputs/)).toBeTruthy() // present in leader_worker
    fireEvent.click(screen.getByRole('radio', { name: 'Dynamic workflow' }))
    expect(screen.queryByRole('checkbox', { name: /Share outputs/ })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Completion gate/ })).toBeNull()
    // The section header AND the old notice are both gone.
    expect(screen.queryByRole('heading', { name: 'Collaboration switches' })).toBeNull()
    expect(screen.queryByTestId('workgroup-dynamic-notice')).toBeNull()
  })

  test('completion gate switch stays editable in fc mode', () => {
    const draft = baseDraft()
    draft.mode = 'free_collab'
    render(<Harness initial={draft} />)
    const gate = switchInput(/Completion gate/)
    expect(gate.disabled).toBe(false)
    fireEvent.click(gate)
    expect(switchInput(/Completion gate/).checked).toBe(true)
  })

  test('RFC-180: turning on Autonomous grays out the completion gate switch', () => {
    render(<Harness />)
    expect(switchInput(/Completion gate/).disabled).toBe(false)
    // `/Autonomous \(/` matches the label only — the gate's autonomous hint
    // ("Autonomous mode: …") must NOT be mistaken for a second Autonomous switch.
    const auto = switchInput(/Autonomous \(/)
    expect(auto.checked).toBe(false)
    fireEvent.click(auto)
    expect(switchInput(/Autonomous \(/).checked).toBe(true)
    expect(switchInput(/Completion gate/).disabled).toBe(true)
  })
})
