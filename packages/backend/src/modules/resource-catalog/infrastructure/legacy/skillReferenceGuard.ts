// RFC-223 — canonical-id reverse-reference scan for managed skills.
//
// Kept independent from skill.ts / skillDeleteOp.ts so the crash-safe delete
// state machine can run the exact same matcher inside its final dbTxSync
// without introducing a module cycle.
//
// RFC-395 II-a A5：预检查与事务内终检均注入 typed reference lookup。

export interface SkillReferencingAgentRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface SkillReferenceLookup {
  find(skillId: string): Promise<readonly SkillReferencingAgentRow[]>
}

export async function findAgentsUsingManagedSkill(
  lookup: SkillReferenceLookup,
  skillId: string,
): Promise<SkillReferencingAgentRow[]> {
  return [...(await lookup.find(skillId))]
}

// RFC-359 W4-D23b：事务内的查引用改走中立事务原语后与上面这条**完全同形**（都是异步 lookup），
// 于是原来的 `findAgentsUsingManagedSkillInTx` / `SkillReferenceLookupInTransaction` 一并删除。
