// RFC-223 — canonical-id reverse-reference scan for managed skills.
//
// Kept independent from skill.ts / skillDeleteOp.ts so the crash-safe delete
// state machine can run the exact same matcher inside its final dbTxSync
// without introducing a module cycle.
//
// RFC-284 T9：两段式扫描收编 resourceRefs 泛型——本域只留 managed-ref matcher。
// 顺带补上此前缺失的 LIKE 预过滤（managed 引用对象含 `"skillId":"<id>"`，
// `%"<id>"%` 必命中；行为不变、全表扫描量降）。

import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import {
  findAgentsReferencingIdInJsonColumn,
  findAgentsReferencingIdInJsonColumnInTx,
  type ReferencingAgentRow,
} from './resourceRefs'

export type SkillReferencingAgentRow = ReferencingAgentRow

const managedSkillRefArgs = (skillId: string) => ({
  column: agents.skills,
  id: skillId,
  matches: (parsed: unknown, id: string) =>
    Array.isArray(parsed) &&
    parsed.some(
      (ref) =>
        typeof ref === 'object' &&
        ref !== null &&
        (ref as { kind?: unknown }).kind === 'managed' &&
        (ref as { skillId?: unknown }).skillId === id,
    ),
})

export async function findAgentsUsingManagedSkill(
  db: DbClient,
  skillId: string,
): Promise<SkillReferencingAgentRow[]> {
  return findAgentsReferencingIdInJsonColumn(db, managedSkillRefArgs(skillId))
}

export function findAgentsUsingManagedSkillInTx(
  tx: DbTxSync,
  skillId: string,
): SkillReferencingAgentRow[] {
  return findAgentsReferencingIdInJsonColumnInTx(tx, managedSkillRefArgs(skillId))
}
