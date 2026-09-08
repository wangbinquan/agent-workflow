// Shared Workgroup row, editable snapshot and revision projection.
// Callers retain their database boundaries and original array-copy operation.

import {
  QUARANTINED_SNAPSHOT_AGENT_ID,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  type CreateWorkgroup,
  type Workgroup,
  type WorkgroupDetail,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
  type WorkgroupMember,
  type WorkgroupRevision,
  type WorkgroupSnapshotHash,
} from '@agent-workflow/shared'
import type { workgroups, workgroupMembers } from '@/db/schema'
import { ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect

export function normalizeWorkgroupSnapshot(
  snapshot: WorkgroupDraftSnapshot,
  fallbackOutputContract: unknown = 'files',
): WorkgroupDraftSnapshot {
  return WorkgroupDraftSnapshotSchema.parse({
    name: snapshot.name,
    description: snapshot.description,
    instructions: snapshot.instructions,
    mode: snapshot.mode,
    outputContract: resolveWorkgroupOutputContract(
      snapshot.outputContract ?? fallbackOutputContract,
    ),
    ...(snapshot.mode === 'leader_worker' && snapshot.leaderDisplayName
      ? { leaderDisplayName: snapshot.leaderDisplayName }
      : {}),
    switches: { ...snapshot.switches },
    maxRounds: snapshot.maxRounds,
    completionGate: snapshot.completionGate,
    clarifyBudget: snapshot.clarifyBudget,
    fanOut: snapshot.fanOut,
    members: snapshot.members.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

export function workgroupDraftSnapshotOf(group: Workgroup): WorkgroupDraftSnapshot {
  const ordered = [...group.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return normalizeWorkgroupSnapshot({
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: { ...group.switches },
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId ?? QUARANTINED_SNAPSHOT_AGENT_ID,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human' as const,
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

export function workgroupSnapshotHashOf(snapshot: WorkgroupDraftSnapshot): WorkgroupSnapshotHash {
  return sha256Hex(
    serializeWorkgroupEditableSnapshotV1(normalizeWorkgroupSnapshot(snapshot)),
  ) as WorkgroupSnapshotHash
}

export function workgroupRevisionOf(group: Workgroup): WorkgroupRevision {
  const snapshot = workgroupDraftSnapshotOf(group)
  return {
    workgroupId: group.id,
    version: group.version,
    snapshotHash: workgroupSnapshotHashOf(snapshot),
    updatedAt: group.updatedAt,
  }
}

export function workgroupToDetail(group: Workgroup): WorkgroupDetail {
  return { ...group, snapshotHash: workgroupSnapshotHashOf(workgroupDraftSnapshotOf(group)) }
}

/** The wrappers supply an owned copy using their original array-copy operation. */
export function workgroupFromCopiedRows(row: WorkgroupRow, memberRows: MemberRow[]): Workgroup {
  const members: WorkgroupMember[] = memberRows
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
    )
    .map((member) => ({
      id: member.id,
      memberType: member.memberType,
      agentName: member.agentName,
      agentId: member.agentId,
      userId: member.userId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
      sortOrder: member.sortOrder,
    }))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    mode: row.mode,
    outputContract: resolveWorkgroupOutputContract(row.outputContract),
    leaderMemberId: row.leaderMemberId,
    switches: {
      shareOutputs: row.shareOutputs,
      directMessages: row.directMessages,
      blackboard: row.blackboard,
    },
    maxRounds: row.maxRounds,
    completionGate: row.completionGate,
    clarifyBudget: row.clarifyBudget,
    fanOut: row.fanOut,
    members,
    version: row.version,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function workgroupMemberPersistenceValues(
  workgroupId: string,
  members: readonly WorkgroupDraftMember[],
  now: number,
  names: ReadonlyMap<string, string>,
  nextId: () => string,
): Array<typeof workgroupMembers.$inferInsert> {
  return members.map((member, index) => ({
    id: nextId(),
    workgroupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId ? (names.get(member.agentId) ?? null) : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder: index,
    createdAt: now,
  }))
}

export function resolveWorkgroupLeaderMemberId(
  input: { readonly mode: string; readonly leaderDisplayName?: string },
  members: ReadonlyArray<typeof workgroupMembers.$inferInsert>,
): string | null {
  if (input.mode !== 'leader_worker' || input.leaderDisplayName === undefined) return null
  const leader = members.find((member) => member.displayName === input.leaderDisplayName)
  if (leader === undefined || leader.memberType !== 'agent') {
    throw new ValidationError(
      'workgroup-leader-invalid',
      'leaderDisplayName must match an agent member',
    )
  }
  return leader.id
}

export type WorkgroupInsertDocument = Pick<
  CreateWorkgroup,
  | 'name'
  | 'description'
  | 'instructions'
  | 'mode'
  | 'outputContract'
  | 'switches'
  | 'maxRounds'
  | 'completionGate'
  | 'clarifyBudget'
  | 'fanOut'
>

export function workgroupContentPersistenceValues(input: {
  readonly id: string
  readonly document: WorkgroupInsertDocument
  readonly leaderMemberId: string | null
}) {
  return {
    id: input.id,
    name: input.document.name,
    description: input.document.description,
    instructions: input.document.instructions,
    mode: input.document.mode,
    outputContract: resolveWorkgroupOutputContract(input.document.outputContract),
    leaderMemberId: input.leaderMemberId,
    shareOutputs: input.document.switches.shareOutputs,
    directMessages: input.document.switches.directMessages,
    blackboard: input.document.switches.blackboard,
    maxRounds: input.document.maxRounds,
    completionGate: input.document.completionGate,
    clarifyBudget: input.document.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: input.document.fanOut ?? false,
    version: 1,
  }
}
