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
// Unresolved entries (neither an existing id nor an existing name) are returned
// verbatim so the downstream existence validators (validateMcpReferences /
// validatePluginReferences / validateDependsOn — all now by id) surface the
// proper `*-not-found` error rather than this module swallowing it.
//
// This whole module is transitional scaffolding for PR-8, which replaces the
// name→id convenience with an explicit import preview + ref→id mapping once a
// name can match multiple owners' resources.

import type { AgentSkillRef } from '@agent-workflow/shared'
import { inArray, or } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, skills } from '@/db/schema'

/** A table with the id + name columns every tenant resource shares. */
type NamedRefTable = typeof agents | typeof mcps | typeof plugins | typeof skills

async function loadRefRows(
  db: DbClient,
  table: NamedRefTable,
  tokens: readonly string[],
): Promise<{ idSet: Set<string>; byName: Map<string, string> }> {
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(or(inArray(table.id, [...tokens]), inArray(table.name, [...tokens])))
  const idSet = new Set<string>()
  const byName = new Map<string, string>()
  for (const row of rows) {
    idSet.add(row.id)
    byName.set(row.name, row.id)
  }
  return { idSet, byName }
}

/**
 * Resolve a list of id-or-name references against one table to canonical ids,
 * de-duplicating while preserving first-seen order. An entry already equal to a
 * row id is kept; a name is mapped to its row id; an unresolved token is kept
 * verbatim (the existence validator downstream rejects it by id).
 */
async function resolveNamedRefs(
  db: DbClient,
  table: NamedRefTable,
  refs: readonly string[],
): Promise<string[]> {
  if (refs.length === 0) return []
  const { idSet, byName } = await loadRefRows(db, table, refs)
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

export function resolveMcpRefs(db: DbClient, refs: readonly string[]): Promise<string[]> {
  return resolveNamedRefs(db, mcps, refs)
}

export function resolvePluginRefs(db: DbClient, refs: readonly string[]): Promise<string[]> {
  return resolveNamedRefs(db, plugins, refs)
}

export function resolveAgentRefs(db: DbClient, refs: readonly string[]): Promise<string[]> {
  return resolveNamedRefs(db, agents, refs)
}

/** Ref-identity key for skill-ref de-dup. */
function skillRefKey(ref: AgentSkillRef): string {
  return ref.kind === 'managed' ? `m:${ref.skillId}` : `p:${ref.name}`
}

/**
 * Normalize typed skill refs for persistence: a `managed` ref whose `skillId`
 * carries a NAME (agent.md import) is resolved to the skill's id; one that
 * resolves to no managed skill row is DEMOTED to a `project` ref (RFC-178: a
 * name with no DB row is a repo-local self-discovered skill). `project` refs are
 * passed through untouched. De-dupes by ref identity, first-seen order.
 */
export async function normalizeSkillRefs(
  db: DbClient,
  refs: readonly AgentSkillRef[],
): Promise<AgentSkillRef[]> {
  const managedTokens = refs.filter((r) => r.kind === 'managed').map((r) => r.skillId)
  const lookup =
    managedTokens.length === 0
      ? { idSet: new Set<string>(), byName: new Map<string, string>() }
      : await loadRefRows(db, skills, managedTokens)
  const seen = new Set<string>()
  const out: AgentSkillRef[] = []
  for (const ref of refs) {
    let normalized: AgentSkillRef
    if (ref.kind === 'project') {
      normalized = { kind: 'project', name: ref.name }
    } else if (lookup.idSet.has(ref.skillId)) {
      normalized = { kind: 'managed', skillId: ref.skillId }
    } else {
      const id = lookup.byName.get(ref.skillId)
      // RFC-178: a managed token that resolves to no managed skill is a
      // repo-local (project) skill referenced by name.
      normalized =
        id === undefined ? { kind: 'project', name: ref.skillId } : { kind: 'managed', skillId: id }
    }
    const key = skillRefKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

/** Managed skill ids referenced by a ref list (project refs excluded) — used by
 *  the route-level ACL usability check (assertNewRefsUsable). */
export function managedSkillTokens(refs: readonly AgentSkillRef[]): string[] {
  return refs.filter((r) => r.kind === 'managed').map((r) => r.skillId)
}
