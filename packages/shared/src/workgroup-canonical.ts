// RFC-225 — canonical editable-workgroup serialization.
//
// Hashing stays in the runtime-specific caller: node:crypto in the backend
// and Web Crypto (with the existing browser fallback) in the frontend.

import { canonicalJson } from './workflow-canonical'
import { WorkgroupDraftSnapshotSchema, type WorkgroupDraftSnapshot } from './schemas/workgroup'

export const WORKGROUP_EDITABLE_SNAPSHOT_DOMAIN_V1 = 'agent-workflow/workgroup-editable/v1\n'

export function serializeWorkgroupEditableSnapshotV1(snapshot: WorkgroupDraftSnapshot): string {
  const parsed = WorkgroupDraftSnapshotSchema.parse(snapshot)
  const normalized: WorkgroupDraftSnapshot = {
    ...parsed,
    ...(parsed.mode === 'leader_worker' && parsed.leaderDisplayName !== undefined
      ? { leaderDisplayName: parsed.leaderDisplayName }
      : { leaderDisplayName: undefined }),
    members: parsed.members.map((member) =>
      member.memberType === 'agent' && member.agentId !== undefined
        ? {
            memberType: 'agent' as const,
            agentId: member.agentId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : member,
    ),
  }
  return `${WORKGROUP_EDITABLE_SNAPSHOT_DOMAIN_V1}${canonicalJson(normalized)}`
}
