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

/**
 * RFC-401 design §2.4 —— agent 四个引用字段在共同写入层去重：`dependsOn` / `mcp` / `plugins` 按 id，`skills` 按
 * （kind, skillId / name），保留第一次出现的位置，其余按输入顺序。重复引用在运行时没有含义；此前三条入口各不相同
 * （普通编辑与 Intent 保留重复，资源包对前三个字段去重、对 skills 保留）。只处理给出的字段，update 的部分 patch 不补字段。
 */
export function uniqueAgentReferences<T extends Partial<AgentReferences>>(refs: T): T {
  function firstOccurrences<V>(values: readonly V[], key: (value: V) => string): V[] {
    const seen = new Set<string>()
    return values.filter((value) => {
      const referenceKey = key(value)
      if (seen.has(referenceKey)) return false
      seen.add(referenceKey)
      return true
    })
  }
  return {
    ...refs,
    ...(refs.skills === undefined
      ? {}
      : { skills: firstOccurrences(refs.skills, encodeAgentSkillReferenceKey) }),
    ...(refs.dependsOn === undefined
      ? {}
      : { dependsOn: firstOccurrences(refs.dependsOn, (id) => id) }),
    ...(refs.mcp === undefined ? {} : { mcp: firstOccurrences(refs.mcp, (id) => id) }),
    ...(refs.plugins === undefined ? {} : { plugins: firstOccurrences(refs.plugins, (id) => id) }),
  }
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
