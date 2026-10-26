import type { AgentReferences, AgentSkillRef } from '@agent-workflow/shared'

/** Versioned tuple; the selector is literal, including Unicode and separators. */
export function encodeAgentSkillReferenceKey(ref: AgentSkillRef): string {
  return JSON.stringify(['ar1', ref.kind, ref.kind === 'managed' ? ref.skillId : ref.name])
}

export function decodeAgentSkillReferenceKey(key: string): AgentSkillRef {
  const value: unknown = JSON.parse(key)
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 'ar1' ||
    (value[1] !== 'managed' && value[1] !== 'project') ||
    typeof value[2] !== 'string'
  )
    throw new Error('agent-reference-key-invalid')
  const ref: AgentSkillRef =
    value[1] === 'managed'
      ? { kind: 'managed', skillId: value[2] }
      : { kind: 'project', name: value[2] }
  if (encodeAgentSkillReferenceKey(ref) !== key) throw new Error('agent-reference-key-noncanonical')
  return ref
}

/** Typed rows share the converter's occurrence and ordinal identities. */
export function agentReferenceRows(agentId: string, refs: AgentReferences) {
  function ordered<T>(values: readonly T[], key: (value: T) => string) {
    const occurrences = new Map<string, number>()
    return values.map((value, ordinal) => {
      const referenceKey = key(value)
      const occurrence = occurrences.get(referenceKey) ?? 0
      occurrences.set(referenceKey, occurrence + 1)
      return { agentId, value, ordinal, occurrence }
    })
  }
  return {
    skills: ordered(refs.skills, encodeAgentSkillReferenceKey).map(({ value, ...row }) => ({
      ...row,
      referenceKey: encodeAgentSkillReferenceKey(value),
      kind: value.kind,
      skillId: value.kind === 'managed' ? value.skillId : null,
      projectName: value.kind === 'project' ? value.name : null,
    })),
    mcp: ordered(refs.mcp, (id) => id).map(({ value, ...row }) => ({ ...row, mcpId: value })),
    plugins: ordered(refs.plugins, (id) => id).map(({ value, ...row }) => ({
      ...row,
      pluginId: value,
    })),
    dependencies: ordered(refs.dependsOn, (id) => id).map(({ value, ...row }) => ({
      ...row,
      dependencyAgentId: value,
    })),
  }
}
