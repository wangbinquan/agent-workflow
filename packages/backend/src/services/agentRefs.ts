// RFC-223 (PR-1) — resolve create / import-time cross-resource references to
// stable ids before they are persisted on an agent row. After PR-8 this ordinary
// write path is strictly id-only; agent.md names pass through importRefs first.
//
// Codex impl-gate P1-2 — resolution is ACL-aware and BOUND to storage: the
// single pass in `resolveRefsUsableById` both resolves the token to an id AND
// checks that id's visibility, so the id the ACL gate approves is the exact id
// persisted. This closes the check-then-resolve TOCTOU (route ACL-checked the
// raw token, service re-resolved it independently → a rename between the two
// could bind an unauthorized id).
//
// Codex impl-gate P1-1 — a managed skill ref that resolves to no visible skill
// is NEVER silently demoted to a repo-local `project` ref (that would change
// execution semantics). It is kept as an UNRESOLVED managed ref instead.

import type { AgentSkillRef } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { resolveRefsUsableById, assertNoMissingRefs } from './resourceRefs'

/** Ref-identity key for skill-ref de-dup. */
function skillRefKey(ref: AgentSkillRef): string {
  return ref.kind === 'managed' ? `m:${ref.skillId}` : `p:${ref.name}`
}

/** The cross-resource references an agent create/update carries. Ordinary
 * writes are canonical ids; skills remain a typed managed-id/project-name union. */
export interface AgentRefInput {
  mcp: readonly string[]
  plugins: readonly string[]
  dependsOn: readonly string[]
  skills: readonly AgentSkillRef[]
}

/** Resolved, canonical (id) references ready for persistence. */
export interface ResolvedAgentRefs {
  mcp: string[]
  plugins: string[]
  dependsOn: string[]
  skills: AgentSkillRef[]
}

/** Managed skill ids referenced by a stored ref list (project refs excluded) —
 *  the grandfathering set for an update (D15). */
function managedSkillIdSet(refs: readonly AgentSkillRef[] | undefined): Set<string> {
  return new Set((refs ?? []).filter((r) => r.kind === 'managed').map((r) => r.skillId))
}

/**
 * RFC-223 (PR-1) — resolve an agent's mcp / plugins / dependsOn / skills refs to
 * validate canonical ids and, when `actor` is a real user, enforce per-reference ACL in
 * the SAME resolution pass (Codex impl-gate P1-2). On an UPDATE, `existing`
 * carries the already-stored (resolved) refs so only NEWLY-added references are
 * ACL-checked (D15 grandfathering) — the diff compares RESOLVED IDS, never the
 * raw name/id token, so a grandfathered ref re-submitted by name is not
 * mis-flagged as new.
 *
 * Skills: a managed ref carries an id. A missing id is retained only long
 * enough for the existence validator to raise `skill-not-found`; it is never
 * demoted to a project ref. Project refs pass through.
 *
 * `actor === null` (framework/system seeders) resolves without an ACL gate.
 * Aggregates every group's ACL violations and raises a single `acl-missing-refs`.
 */
export async function resolveAgentRefsUsable(
  db: DbClient,
  actor: Actor | null,
  input: AgentRefInput,
  existing?: AgentRefInput,
): Promise<ResolvedAgentRefs> {
  const mcp = await resolveRefsUsableById(db, actor, 'mcp', input.mcp, {
    grandfatheredIds: existing ? new Set(existing.mcp) : undefined,
  })
  const plugins = await resolveRefsUsableById(db, actor, 'plugin', input.plugins, {
    grandfatheredIds: existing ? new Set(existing.plugins) : undefined,
  })
  const dependsOn = await resolveRefsUsableById(db, actor, 'agent', input.dependsOn, {
    grandfatheredIds: existing ? new Set(existing.dependsOn) : undefined,
  })

  // Skills: resolve only the MANAGED tokens (project refs have no DB row / ACL).
  const managedTokens = input.skills.filter((r) => r.kind === 'managed').map((r) => r.skillId)
  const skillRes = await resolveRefsUsableById(db, actor, 'skill', managedTokens, {
    grandfatheredIds: existing ? managedSkillIdSet(existing.skills) : undefined,
  })
  const seenSkill = new Set<string>()
  const skills: AgentSkillRef[] = []
  for (const ref of input.skills) {
    // NO project demotion (P1-1): an unresolved managed skillId keeps its token.
    const normalized: AgentSkillRef =
      ref.kind === 'project'
        ? { kind: 'project', name: ref.name }
        : { kind: 'managed', skillId: skillRes.byToken.get(ref.skillId) ?? ref.skillId }
    const key = skillRefKey(normalized)
    if (seenSkill.has(key)) continue
    seenSkill.add(key)
    skills.push(normalized)
  }

  assertNoMissingRefs([
    ...mcp.missing,
    ...plugins.missing,
    ...dependsOn.missing,
    ...skillRes.missing,
  ])

  return { mcp: mcp.ids, plugins: plugins.ids, dependsOn: dependsOn.ids, skills }
}
