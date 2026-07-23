// RFC-028 — MCP dependsOn-closure helpers used by the scheduler before each
// runNode spawn. Kept tiny + pure on purpose so the same code is exercised
// by isolated unit tests, scheduler integration tests, and live spawn paths.
//
// RFC-223 (PR-1): `agent.mcp` stores MCP IDS now (was names), so these helpers
// collect + hydrate by id.
//
// Two functions:
//   collectMcpIdsFromClosure(closure)  — pure; unions every closure member's
//                                        mcp[] ids into a deduped string[] in
//                                        first-seen order.
//   loadMcpsByIds(db, ids)             — single DB query (`inArray`) returning
//                                        the matching mcps rows.
//
// Composed in scheduler.ts as:
//   const closure = await agentDeps.computeClosure(db, agent)
//   const ids     = collectMcpIdsFromClosure(closure)
//   const mcps    = await loadMcpsByIds(db, ids)
//   await runNode({ ..., dependents: closure, mcps })

import type { Agent, Mcp } from '@agent-workflow/shared'
import { McpSchema } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { mcps as mcpsTable } from '@/db/schema'

/**
 * Union the `mcp[]` ids declared on every closure agent, preserving the
 * first-seen order across BFS visit order.
 *
 * The closure is whatever shape RFC-022 `resolveDependsClosure` returns:
 * primary agent first, then dependents in BFS order. We rely on that order
 * to make the inline-injection output deterministic across runs (and easy to
 * read in spawn logs).
 */
export function collectMcpIdsFromClosure(closure: readonly Agent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of closure) {
    for (const id of agent.mcp ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Hydrate a list of MCP ids into full `Mcp` rows. Unknown ids are silently
 * skipped: the caller is expected to have already validated ids at save time
 * (RFC-028 T5 `mcp-not-found` guard) but at spawn time a row could have been
 * deleted out from under us, and crashing the node spawn over a missing MCP is
 * worse than starting the opencode process without it (opencode itself
 * tolerates missing MCPs by simply not exposing those tools).
 *
 * Empty input returns `[]` without hitting the DB.
 */
export async function loadMcpsByIds(db: DbClient, ids: readonly string[]): Promise<Mcp[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select()
    .from(mcpsTable)
    .where(inArray(mcpsTable.id, [...ids]))
  // Re-parse via the public schema so we never hand the runner a malformed
  // row (the same `mcp-row-corrupt` validation that services/mcp.ts uses).
  const byId = new Map<string, Mcp>()
  for (const row of rows) {
    let config: unknown
    try {
      config = JSON.parse(row.config)
    } catch {
      config = {}
    }
    const parsed = McpSchema.safeParse({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      config,
      enabled: row.enabled,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    if (parsed.success) byId.set(row.id, parsed.data)
  }
  // Preserve caller's id order (matches closure traversal order) so the
  // resulting inline JSON keys list is deterministic.
  const out: Mcp[] = []
  for (const id of ids) {
    const m = byId.get(id)
    if (m !== undefined) out.push(m)
  }
  return out
}
