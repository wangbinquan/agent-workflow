// RFC-225 T1 — workgroup editable bytes are deterministic and exclude
// server-owned member ids / ACL / timestamps by construction.

import { describe, expect, test } from 'bun:test'
import {
  serializeWorkgroupEditableSnapshotV1,
  WorkgroupDraftSnapshotSchema,
  type WorkgroupDraftSnapshot,
} from '../src'

function snapshot(): WorkgroupDraftSnapshot {
  return WorkgroupDraftSnapshotSchema.parse({
    name: 'review-team',
    description: '',
    instructions: 'review carefully',
    mode: 'leader_worker',
    leaderDisplayName: 'lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    clarifyBudget: 3,
    fanOut: false,
    members: [
      {
        memberType: 'agent',
        agentId: 'agent-1',
        displayName: 'lead',
        roleDesc: 'coordinate',
      },
    ],
  })
}

describe('RFC-225 workgroup canonical serialization', () => {
  test('object insertion order cannot change canonical bytes', () => {
    const base = snapshot()
    const reordered = {
      members: base.members,
      fanOut: base.fanOut,
      clarifyBudget: base.clarifyBudget,
      completionGate: base.completionGate,
      maxRounds: base.maxRounds,
      switches: base.switches,
      leaderDisplayName: base.leaderDisplayName,
      mode: base.mode,
      instructions: base.instructions,
      description: base.description,
      name: base.name,
    } as WorkgroupDraftSnapshot
    expect(serializeWorkgroupEditableSnapshotV1(reordered)).toBe(
      serializeWorkgroupEditableSnapshotV1(base),
    )
  })

  test('member order, leader and editable fields remain semantic', () => {
    const base = snapshot()
    const second = {
      memberType: 'agent' as const,
      agentId: 'agent-2',
      displayName: 'worker',
      roleDesc: 'implement',
    }
    const withSecond = { ...base, members: [...base.members, second] }
    expect(serializeWorkgroupEditableSnapshotV1(withSecond)).not.toBe(
      serializeWorkgroupEditableSnapshotV1(base),
    )
    expect(
      serializeWorkgroupEditableSnapshotV1({
        ...withSecond,
        members: [...withSecond.members].reverse(),
      }),
    ).not.toBe(serializeWorkgroupEditableSnapshotV1(withSecond))
    expect(
      serializeWorkgroupEditableSnapshotV1({
        ...withSecond,
        leaderDisplayName: 'worker',
      }),
    ).not.toBe(serializeWorkgroupEditableSnapshotV1(withSecond))
  })

  test('canonical agentId makes the mutable display name non-semantic', () => {
    const base = snapshot()
    const withDisplayName = {
      ...base,
      members: base.members.map((member) =>
        member.memberType === 'agent'
          ? { ...member, agentName: 'current-agent-display-name' }
          : member,
      ),
    }
    expect(serializeWorkgroupEditableSnapshotV1(withDisplayName)).toBe(
      serializeWorkgroupEditableSnapshotV1(base),
    )
  })
})
