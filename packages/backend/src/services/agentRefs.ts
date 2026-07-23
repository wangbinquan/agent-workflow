// RFC-223 (PR-1) — resolve create / import-time cross-resource references to
// stable ids before they are persisted on an agent row.
//
// Why this exists: the id-based pickers already hand the server ids, but an
// agent.md authored by NAME (the portable form) flows through the SAME
// create/update body. While `name` stays globally unique (uniqueness is relaxed
// in PR-8) a name maps to exactly one row, so we can deterministically resolve
// name → id here and store ids everywhere. Ids pass through unchanged: a ULID
// (Crockford base32, uppercase) and a resource name (`[a-z0-9][a-z0-9_-]*`,
// lowercase) are disjoint character sets, so an entry is never ambiguously both.
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
import { inArray, or } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import { resolveRefsUsableById, assertNoMissingRefs } from './resourceRefs'

/**
 * Resolve a list of id-or-name references against the agents table to canonical
 * ids (non-ACL — used only by the closure PREVIEW cycle check, where usability
 * is enforced at save time). De-dupes while preserving first-seen order; an
 * unresolved token is kept verbatim so the downstream validator rejects it by id.
 */
export async function resolveAgentRefs(db: DbClient, refs: readonly string[]): Promise<string[]> {
  if (refs.length === 0) return []
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(or(inArray(agents.id, [...refs]), inArray(agents.name, [...refs])))
  const idSet = new Set(rows.map((r) => r.id))
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs) {
    const id = idSet.has(ref) ? ref : (byName.get(ref) ?? ref)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Ref-identity key for skill-ref de-dup. */
function skillRefKey(ref: AgentSkillRef): string {
  return ref.kind === 'managed' ? `m:${ref.skillId}` : `p:${ref.name}`
}

/** The cross-resource references an agent create/update carries. Ids OR names on
 *  the wire (pickers hand ids; agent.md hands names); skills are typed refs. */
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
 * canonical ids and, when `actor` is a real user, enforce per-reference ACL in
 * the SAME resolution pass (Codex impl-gate P1-2). On an UPDATE, `existing`
 * carries the already-stored (resolved) refs so only NEWLY-added references are
 * ACL-checked (D15 grandfathering) — the diff compares RESOLVED IDS, never the
 * raw name/id token, so a grandfathered ref re-submitted by name is not
 * mis-flagged as new.
 *
 * Skills (Codex impl-gate P1-1): a `managed` ref's `skillId` (an id at rest, a
 * name on the agent.md wire) is resolved to the skill id; a ref that resolves to
 * no visible skill is kept as an UNRESOLVED managed ref (skillId holds the raw
 * token) and is NEVER demoted to a `project` ref. `project` refs pass through.
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
