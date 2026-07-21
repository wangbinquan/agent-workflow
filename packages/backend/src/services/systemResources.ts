// Single source of truth for framework-seeded "system" resource identities
// and the RFC-104 read-only lock.
//
// RFC-101's fusion feature persists a built-in agent (`aw-skill-merger`) + a
// built-in workflow (`aw-skill-fusion`) as real DB rows — the task runner can
// only drive resources it resolves by id, so unlike the synthetic RFC-075
// commit agent / RFC-050 memory distiller (which are never DB rows) these MUST
// exist in the tables. They are infrastructure, not user-managed rows.
//
// RFC-104: a row's built-in identity is the immutable `builtin` column, set
// ONLY by seedFusionResources and absent from every Create*/Update* HTTP schema
// (so no external caller can flip it). This REPLACES the old
// `owner_user_id === '__system__' && reserved-name` heuristic, which keyed the
// hide (and any lock built on it) off the owner — so transferring a built-in's
// owner silently un-hid AND unlocked it (the exact footgun RFC-104 closes). The
// column is owner/name-independent, so:
//   * list-hide (excludeBuiltin*) and the read-only lock (assertNotBuiltin)
//     agree and survive owner/visibility drift;
//   * a user MAY still create their own workflow named `aw-skill-fusion`
//     (builtin=false) — it stays fully visible/editable and the framework
//     ignores it (fusionWorkflowId selects builtin=true), so the name
//     collision RFC-101 worried about is no longer ambiguous.
//
// Only agents + workflows carry the column today (the sole seeded types). The
// reserved-name sets below are NOT the runtime discriminator anymore — they
// only let seedFusionResources LOCATE / seed its own rows. skill / mcp / plugin
// rows have no `builtin` field, so isBuiltinRow is false for them and the
// generic guards are no-ops; adding a built-in of those types later MUST add
// the column to that table AND guard that type's write paths (e.g. for skills:
// ZIP/source-conflict import, reconcile, commitSkillVersion fusion approval).

import type { AclResourceType } from '@agent-workflow/shared'
import { ForbiddenError } from '@/util/errors'

export const SKILL_MERGER_AGENT_NAME = 'aw-skill-merger'
export const SKILL_FUSION_WORKFLOW_NAME = 'aw-skill-fusion'

/** Reserved framework names — used by seedFusionResources to locate/seed its
 *  own rows. NOT a runtime built-in discriminator (that is the `builtin`
 *  column); kept so the seeder and future built-ins share one registry. */
export const BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([SKILL_MERGER_AGENT_NAME])
export const BUILTIN_WORKFLOW_NAMES: ReadonlySet<string> = new Set([SKILL_FUSION_WORKFLOW_NAME])

/** Minimal row shape every check accepts; full rows AND mapped DTOs superset it. */
interface BuiltinCandidate {
  builtin?: boolean | null
}

/** A row is a framework built-in iff its immutable `builtin` column is set. */
export function isBuiltinRow(row: BuiltinCandidate): boolean {
  return row.builtin === true
}

/** Strip framework-seeded built-in AGENTS from a user-facing list. */
export function excludeBuiltinAgents<T extends BuiltinCandidate>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isBuiltinRow(r))
}

/** Strip framework-seeded built-in WORKFLOWS from a user-facing list. */
export function excludeBuiltinWorkflows<T extends BuiltinCandidate>(rows: readonly T[]): T[] {
  return rows.filter((r) => !isBuiltinRow(r))
}

/**
 * RFC-104 read-only lock: refuse any mutate / delete / rename / ACL-change /
 * manual execution / import-overwrite that targets a framework built-in. Throws
 * 403 `builtin-readonly`. Refuses admins and the daemon `__system__` token too
 * (the guard keys off the row, not the actor's role).
 *
 * Call ordering at every site: load-visible / can-view (404 if invisible, keeps
 * RFC-099 D1 existence isolation) → assertNotBuiltin (403; built-in identity
 * outranks ownership) → requireResourceOwner (403) → write. For skill / mcp /
 * plugin rows (no `builtin` field) this is a no-op.
 */
export function assertNotBuiltin(type: AclResourceType, row: BuiltinCandidate): void {
  if (isBuiltinRow(row)) {
    throw new ForbiddenError(
      'builtin-readonly',
      `this ${type} is a built-in framework resource and is read-only`,
    )
  }
}
