// Single source of truth for framework-seeded "system" resource identities.
//
// RFC-101's fusion feature persists a built-in agent (`aw-skill-merger`) + a
// built-in workflow (`aw-skill-fusion`) as real DB rows — the task runner can
// only drive resources it can resolve by id, so unlike the synthetic RFC-075
// commit agent / RFC-050 memory distiller (which are never DB rows) these MUST
// exist in the tables. They are infrastructure, though, not user-managed rows,
// so the user-facing GET /api/agents + /api/workflows lists hide them (which in
// turn keeps the first-run onboarding card alive and removes the "Delete a
// system workflow" footgun).
//
// A row is a built-in iff it BOTH carries a reserved built-in name AND is owned
// by `__system__` (the seed sets owner_user_id=__system__). Both halves matter:
//
//   * Name alone is unsafe for WORKFLOWS — `workflows.name` is non-unique, so a
//     user can create/import their own workflow named `aw-skill-fusion`; that
//     row is owned by the creating user and MUST stay visible.
//   * Owner alone is unsafe for everything — the daemon root token authenticates
//     as the `__system__` admin (auth/session.ts), so a solo operator's
//     daemon-token-created agents are `__system__`-owned too; an owner-blind
//     filter would wrongly hide them. Their names are not reserved, so the
//     name+owner conjunction keeps them.
//
// (Agents.name is unique so agents can't actually collide, but the same
// predicate is used for both for uniformity.) When a future RFC adds another
// built-in, register its name in the matching set below.

import { SYSTEM_USER_ID } from '@/auth/actor'

export const SKILL_MERGER_AGENT_NAME = 'aw-skill-merger'
export const SKILL_FUSION_WORKFLOW_NAME = 'aw-skill-fusion'

/** Framework-seeded agent names hidden from the user-facing /agents list. */
export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([SKILL_MERGER_AGENT_NAME])

/** Framework-seeded workflow names hidden from the user-facing /workflows list. */
export const BUILTIN_WORKFLOW_NAMES: ReadonlySet<string> = new Set([SKILL_FUSION_WORKFLOW_NAME])

/** Minimal row shape: the DTOs from listAgents/listWorkflows superset this. */
interface BuiltinCandidate {
  name: string
  ownerUserId?: string | null
}

/** Seeded-row discriminator: reserved built-in name AND owned by `__system__`. */
function isBuiltin(names: ReadonlySet<string>, row: BuiltinCandidate): boolean {
  return row.ownerUserId === SYSTEM_USER_ID && names.has(row.name)
}

/** Strip framework-seeded built-in AGENTS from a user-facing list. */
export function excludeBuiltinAgents<T extends BuiltinCandidate>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isBuiltin(BUILTIN_AGENT_NAMES, r))
}

/** Strip framework-seeded built-in WORKFLOWS from a user-facing list. */
export function excludeBuiltinWorkflows<T extends BuiltinCandidate>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isBuiltin(BUILTIN_WORKFLOW_NAMES, r))
}
