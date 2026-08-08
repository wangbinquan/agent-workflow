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
import { runtimeIdRef, runtimeRefKey } from '@/services/ref/runtimeRef'
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
  // RFC-271 T6f：去重走 canonical `runtimeRefKey`，不再拿裸 id 当键 —— 裸 id 默认
  // 了「id 跨资源类型全局唯一」这条从没被约束过的假设。first-seen 顺序不变。
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of closure) {
    for (const id of agent.mcp ?? []) {
      const key = runtimeRefKey(runtimeIdRef('mcp', id))
      if (seen.has(key)) continue
      seen.add(key)
      out.push(id)
    }
  }
  return out
}

/**
 * Hydrate a list of MCP ids into full `Mcp` rows. The low-level loader returns
 * the rows it can parse; RFC-228's scheduler boundary compares the requested
 * and returned id sets and fails the node on any difference. Callers must not
 * treat a shorter result as permission to run without a requested MCP.
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
