// RFC-223 — canonical-id reverse-reference scan for managed skills.
//
// Kept independent from skill.ts / skillDeleteOp.ts so the crash-safe delete
// state machine can run the exact same matcher inside its final dbTxSync
// without introducing a module cycle.
//
// RFC-284 T9：两段式扫描收编 resourceRefs 泛型——本域只留 managed-ref matcher。
// 顺带补上此前缺失的 LIKE 预过滤（managed 引用对象含 `"skillId":"<id>"`，
// `%"<id>"%` 必命中；行为不变、全表扫描量降）。

export interface SkillReferencingAgentRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export function matchesManagedSkillReference(parsed: unknown, skillId: string): boolean {
  return (
    Array.isArray(parsed) &&
    parsed.some(
      (ref) =>
        typeof ref === 'object' &&
        ref !== null &&
        (ref as { kind?: unknown }).kind === 'managed' &&
        (ref as { skillId?: unknown }).skillId === skillId,
    )
  )
}

export interface SkillReferenceLookup {
  find(skillId: string): Promise<readonly SkillReferencingAgentRow[]>
}

export interface SkillReferenceLookupInTransaction {
  find(skillId: string): readonly SkillReferencingAgentRow[]
}

export async function findAgentsUsingManagedSkill(
  lookup: SkillReferenceLookup,
  skillId: string,
): Promise<SkillReferencingAgentRow[]> {
  return [...(await lookup.find(skillId))]
}

export function findAgentsUsingManagedSkillInTx(
  lookup: SkillReferenceLookupInTransaction,
  skillId: string,
): SkillReferencingAgentRow[] {
  return [...lookup.find(skillId)]
}
