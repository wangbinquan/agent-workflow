// RFC-223 — canonical-id reverse-reference scan for managed skills.
//
// Kept independent from skill.ts / skillDeleteOp.ts so the crash-safe delete
// state machine can run the exact same parser inside its final dbTxSync without
// introducing a module cycle.

import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'

export interface SkillReferencingAgentRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'public' | 'private'
}

type AgentSkillRow = SkillReferencingAgentRow & { skills: string }

export async function findAgentsUsingManagedSkill(
  db: DbClient,
  skillId: string,
): Promise<SkillReferencingAgentRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      skills: agents.skills,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
  return agentsUsingManagedSkillIn(rows, skillId)
}

export function findAgentsUsingManagedSkillInTx(
  tx: DbTxSync,
  skillId: string,
): SkillReferencingAgentRow[] {
  const rows = tx
    .select({
      id: agents.id,
      name: agents.name,
      skills: agents.skills,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .all()
  return agentsUsingManagedSkillIn(rows, skillId)
}

function agentsUsingManagedSkillIn(
  rows: ReadonlyArray<AgentSkillRow>,
  skillId: string,
): SkillReferencingAgentRow[] {
  const out: SkillReferencingAgentRow[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.skills) as unknown
      const referencesSkill =
        Array.isArray(parsed) &&
        parsed.some(
          (ref) =>
            typeof ref === 'object' &&
            ref !== null &&
            (ref as { kind?: unknown }).kind === 'managed' &&
            (ref as { skillId?: unknown }).skillId === skillId,
        )
      if (referencesSkill) {
        out.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    } catch {
      // Corrupt agent rows use the same fail-closed empty-list fallback as the
      // Agent mapper. No mutable display-name lookup is attempted.
    }
  }
  return out
}
