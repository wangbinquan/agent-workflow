// RFC-234 §4 (T1) — dump serializers for workgroup / mcp / plugin.
//
// These produce the YAML documents placed in the intent working directory
// (`mounted/res.<type>.<n>.yaml`). Two hard rules, both test-locked
// (packages/shared/tests/intent-dump-serialize.test.ts):
//
//  1. IDENTITY ISOLATION — output is built from an explicit field WHITELIST.
//     `ownerUserId`, usernames, grants, `workgroup_members.user_id`,
//     `agent_name` snapshots and machine paths can never appear, because they
//     are never copied.
//  2. SECRET REDACTION — mcp/plugin go through the closed projections in
//     ./intentSecretSlots.ts before serialization.
//
// Cross-resource references are expressed as session HANDLES supplied by the
// caller (dump builder resolves ids → handles); this module never sees ids.
//
// Pure functions: no IO, browser-safe.

import { stringify as stringifyYaml } from 'yaml'
import { projectMcpForDump, projectPluginForDump, maskFreeJsonSecrets } from './intentSecretSlots'

export interface WorkgroupDumpMember {
  memberType: 'agent' | 'human'
  /** Session handle of the member agent (agent members only). */
  agentHandle?: string
  displayName: string
  roleDesc: string
}

export interface WorkgroupDumpDocument {
  handle: string
  name: string
  description: string
  instructions: string
  mode: string
  leaderDisplayName?: string
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  maxRounds: number
  completionGate: boolean
  clarifyBudget?: number
  fanOut?: boolean
  members: WorkgroupDumpMember[]
}

export function serializeWorkgroupDump(doc: WorkgroupDumpDocument): string {
  return stringifyYaml(
    {
      handle: doc.handle,
      name: doc.name,
      description: doc.description,
      instructions: doc.instructions,
      mode: doc.mode,
      leaderDisplayName: doc.leaderDisplayName,
      switches: doc.switches,
      maxRounds: doc.maxRounds,
      completionGate: doc.completionGate,
      clarifyBudget: doc.clarifyBudget,
      fanOut: doc.fanOut,
      members: doc.members.map((m) =>
        m.memberType === 'agent'
          ? {
              memberType: 'agent',
              agentHandle: m.agentHandle,
              displayName: m.displayName,
              roleDesc: m.roleDesc,
            }
          : { memberType: 'human', displayName: m.displayName, roleDesc: m.roleDesc },
      ),
    },
    { lineWidth: 0 },
  )
}

export interface McpDumpDocument {
  handle: string
  type: 'local' | 'remote'
  name: string
  description: string
  enabled: boolean
  config: Record<string, unknown>
}

export function serializeMcpDump(doc: McpDumpDocument): string {
  const projected = projectMcpForDump(doc)
  return stringifyYaml({ handle: doc.handle, ...projected }, { lineWidth: 0 })
}

export interface PluginDumpDocument {
  handle: string
  name: string
  spec: string
  description: string
  enabled: boolean
  options?: Record<string, unknown>
}

export function serializePluginDump(doc: PluginDumpDocument): string {
  const projected = projectPluginForDump(doc)
  return stringifyYaml({ handle: doc.handle, ...projected }, { lineWidth: 0 })
}

/** Free-JSON secret masking re-export for dump-side frontmatterExtra handling
 *  (agents/skills use the heuristic-key layer, not full masking). */
export { maskFreeJsonSecrets }
