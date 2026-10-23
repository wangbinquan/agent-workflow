import { AgentSkillRefSchema, type AgentSkillRef } from '@agent-workflow/shared'

/** RFC-395 II-a A5 源读者：II-b 转换器复用；保留字符串顺序、重复和空字符串。 */
export function decodeAgentReferenceIds(value: string | (() => string)): string[] {
  try {
    const decoded: unknown = JSON.parse(typeof value === 'function' ? value() : value)
    return Array.isArray(decoded)
      ? decoded.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function decodeAgentSkillReferences(value: string): AgentSkillRef[] {
  try {
    const decoded: unknown = JSON.parse(value)
    if (!Array.isArray(decoded)) return []
    return decoded.flatMap((entry) => {
      const parsed = AgentSkillRefSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  } catch {
    return []
  }
}

/** 反查保留旧 matcher 的宽松对象匹配；不能用 DTO schema 筛掉旧行。 */
export function matchesStoredAgentReference(
  raw: unknown,
  id: string,
  kind: 'skill' | 'id',
): boolean {
  try {
    const parsed: unknown = JSON.parse(String(raw))
    if (!Array.isArray(parsed)) return false
    return kind === 'id'
      ? parsed.includes(id)
      : parsed.some(
          (ref: unknown) =>
            typeof ref === 'object' &&
            ref !== null &&
            (ref as { kind?: unknown }).kind === 'managed' &&
            (ref as { skillId?: unknown }).skillId === id,
        )
  } catch {
    return false
  }
}

export function collectStoredAgentDependents<T extends { readonly dependsOn: string }>(
  rows: readonly T[],
  agentId: string,
): T[] {
  return rows.filter((row) => matchesStoredAgentReference(row.dependsOn, agentId, 'id'))
}
