// RFC-099 (D15) — save-time reference usability check.
//
// Editing a workflow (or an agent) is the ONLY place per-resource use rights
// are enforced: launching a task checks just the workflow itself (D3), so the
// save-time gate is what stops a user from referencing a private agent /
// skill / mcp / plugin they cannot see. Per D15 the check covers NEW
// references only — references already present in the stored row are
// grandfathered, so losing a grant never bricks saving your own resource.
//
// Names that do not resolve to any row are NOT this module's business — the
// existing existence validators (validateDependsOn / validateMcpReferences /
// validatePluginReferences; workflows tolerate dangling agent names until
// launch validation) keep their behavior. We only reject names that resolve
// to a row the editor cannot view, and the error deliberately echoes ONLY the
// name the editor typed (no id / description / owner — D1).

import type { AclResourceType, WorkflowDefinition } from '@agent-workflow/shared'
import { inArray, or } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import { ValidationError } from '@/util/errors'
import {
  ACL_TABLES,
  isResourceAdminActor,
  isVisibleRow,
  listGrantedResourceIds,
  type AclRow,
} from './resourceAcl'

/**
 * Agent references of a workflow definition (agent-single nodes). RFC-223
 * (PR-2): returns each node's CANONICAL reference — its `agentId` when present
 * (the editor stamps it / migration 0112 backfills it), else the legacy
 * `agentName` (dynamic-generated defs, pre-migration nodes; accepts the even
 * older `agent` key). `assertNewRefsUsable` matches id-or-name against the same
 * row, so either form binds to the correct agent for the ACL usability check
 * (name↔id is 1:1 until PR-8). Diffs (`diffNewNames`) compare like-for-like
 * because a stored definition and its edited successor both prefer id.
 */
export function extractWorkflowAgentRefs(def: {
  nodes?: ReadonlyArray<Record<string, unknown>>
}): Set<string> {
  const out = new Set<string>()
  for (const node of def.nodes ?? []) {
    if (typeof node !== 'object' || node === null) continue
    if (node.kind !== 'agent-single') continue
    const ref =
      typeof node.agentId === 'string' && node.agentId.length > 0
        ? node.agentId
        : typeof node.agentName === 'string' && node.agentName.length > 0
          ? node.agentName
          : typeof node.agent === 'string' && node.agent.length > 0
            ? node.agent
            : null
    if (ref !== null) out.add(ref)
  }
  return out
}

/** Names in `next` that are not in `prev` — the D15 "new references". */
export function diffNewNames(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  return [...next].filter((n) => !prev.has(n))
}

/**
 * RFC-223 (PR-2) — portable EXPORT form of a workflow definition: drop the
 * internal `agentId` from every agent-single node so exported YAML is a
 * name-based selector that resolves against the TARGET environment's agents on
 * import (an id is meaningless across installs). `agentName` is retained as the
 * portable identity. Pure; only agent-single nodes are touched.
 */
export function stripWorkflowNodeAgentIds(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    nodes: (def.nodes ?? []).map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as Record<string, unknown>
      if (!('agentId' in rec)) return node
      const { agentId: _drop, ...rest } = rec
      return rest as typeof node
    }),
  }
}

/**
 * RFC-223 (PR-2) — IMPORT resolution: stamp each agent-single node's canonical
 * `agentId` by resolving its `agentName` against the LOCAL agents table (name↔id
 * 1:1 until PR-8, so deterministic). Any incoming `agentId` is discarded and
 * re-derived from the name — a foreign id from another install must never
 * survive. A node whose name resolves to no local agent is left id-less (the
 * name-based validator / scheduler fallback surfaces it as agent-not-found).
 * This is the pragmatic realization of the R4-3 portable-selector contract;
 * used by YAML import before persisting (no client snapshot hash there, so
 * server-side normalization is safe — unlike the hash-fenced editor save, which
 * relies on the frontend stamping agentId into the hashed snapshot).
 */
export async function resolveWorkflowNodeAgentIds(
  db: DbClient,
  def: WorkflowDefinition,
): Promise<WorkflowDefinition> {
  const names = new Set<string>()
  for (const node of def.nodes ?? []) {
    if (node.kind !== 'agent-single') continue
    const name = (node as Record<string, unknown>).agentName
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  if (names.size === 0) return def
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.name, [...names]))
  const idByName = new Map(rows.map((r) => [r.name, r.id]))
  return {
    ...def,
    nodes: (def.nodes ?? []).map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as Record<string, unknown>
      const name = typeof rec.agentName === 'string' ? rec.agentName : undefined
      const id = name !== undefined ? idByName.get(name) : undefined
      const { agentId: _drop, ...rest } = rec
      return (id !== undefined ? { ...rest, agentId: id } : rest) as typeof node
    }),
  }
}

export interface RefCheckGroup {
  type: AclResourceType
  /**
   * The references to check. RFC-223 (PR-1): these are id-or-name tokens (the
   * id-based pickers hand ids; agent.md import hands names) — the query below
   * matches either column, so both resolve to the same row + visibility check.
   */
  names: readonly string[]
}

/**
 * Throws 422 `acl-missing-refs` when any reference resolves to a row the actor
 * cannot view. Unresolvable references pass through (existence validators own
 * them). Admins short-circuit.
 */
export async function assertNewRefsUsable(
  db: DbClient,
  actor: Actor,
  groups: readonly RefCheckGroup[],
): Promise<void> {
  if (isResourceAdminActor(actor)) return
  const missing: Array<{ type: AclResourceType; name: string }> = []
  for (const group of groups) {
    const refs = [...new Set(group.names)].filter((n) => n.length > 0)
    if (refs.length === 0) continue
    const table = ACL_TABLES[group.type]
    // RFC-223 (PR-1): a ref may be an id (picker) or a name (agent.md import);
    // match either column so the ACL check binds to the actual row.
    const rows = (await db
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(or(inArray(table.id, refs), inArray(table.name, refs)))) as Array<
      AclRow & { name: string }
    >
    if (rows.length === 0) continue
    const granted = await listGrantedResourceIds(db, actor, group.type)
    for (const row of rows) {
      if (!isVisibleRow(actor, row, granted)) {
        missing.push({ type: group.type, name: row.name })
      }
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${missing.map((m) => `${m.type} '${m.name}'`).join(', ')}`,
      { missing },
    )
  }
}
