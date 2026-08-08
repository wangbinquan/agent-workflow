// RFC-031 — plugin dependsOn-closure helpers used by the scheduler before
// each runNode spawn. Kept tiny + pure so the same code is exercised by
// isolated unit tests, scheduler integration tests, and live spawn paths.
//
// RFC-223 (PR-1): `agent.plugins` stores plugin IDS now (was names), so these
// helpers collect + hydrate by id.
//
// Two functions:
//   collectPluginIdsFromClosure(closure)  — pure; unions every closure
//                                            member's plugins[] ids into a
//                                            deduped string[] in first-seen
//                                            order.
//   loadPluginsByIds(db, ids)             — single DB query (`inArray`)
//                                            returning the matching plugins
//                                            rows.
//
// Composed in scheduler.ts as:
//   const closure = await agentDeps.computeClosure(db, agent)
//   const ids     = collectPluginIdsFromClosure(closure)
//   const plugins = await loadPluginsByIds(db, ids)
//   await runNode({ ..., dependents: closure, plugins })

import type { Agent, Plugin } from '@agent-workflow/shared'
import { PluginSchema } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { runtimeIdRef, runtimeRefKey } from '@/services/ref/runtimeRef'
import { plugins as pluginsTable } from '@/db/schema'

/**
 * Union the `plugins[]` ids declared on every closure agent, preserving the
 * first-seen order across BFS visit order.
 *
 * The closure is whatever shape RFC-022 `resolveDependsClosure` returns:
 * primary agent first, then dependents in BFS order. We rely on that order
 * to make the inline-injection output deterministic across runs (and easy to
 * read in spawn logs).
 */
export function collectPluginIdsFromClosure(closure: readonly Agent[]): string[] {
  // RFC-271 T6f：去重走 canonical `runtimeRefKey`，不再拿裸 id 当键 —— 裸 id 默认
  // 了「id 跨资源类型全局唯一」这条从没被约束过的假设。first-seen 顺序不变。
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of closure) {
    for (const id of agent.plugins ?? []) {
      const key = runtimeRefKey(runtimeIdRef('plugin', id))
      if (seen.has(key)) continue
      seen.add(key)
      out.push(id)
    }
  }
  return out
}

/**
 * Hydrate a list of plugin ids into full `Plugin` rows. The low-level loader
 * returns the rows it can parse; RFC-228's scheduler boundary compares the
 * requested and returned id sets and fails the node on any difference.
 * Callers must not run a reduced plugin set.
 *
 * Empty input returns `[]` without hitting the DB.
 */
export async function loadPluginsByIds(db: DbClient, ids: readonly string[]): Promise<Plugin[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select()
    .from(pluginsTable)
    .where(inArray(pluginsTable.id, [...ids]))
  // Re-parse via the public schema so we never hand the runner a malformed
  // row (the same `plugin-row-corrupt` validation that services/plugin.ts uses).
  const byId = new Map<string, Plugin>()
  for (const row of rows) {
    let options: unknown
    try {
      options = JSON.parse(row.optionsJson)
    } catch {
      options = {}
    }
    const parsed = PluginSchema.safeParse({
      id: row.id,
      name: row.name,
      spec: row.spec,
      options,
      description: row.description,
      enabled: row.enabled,
      sourceKind: row.sourceKind,
      cachedPath: row.cachedPath,
      resolvedVersion: row.resolvedVersion,
      installedAt: row.installedAt,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    if (parsed.success) byId.set(row.id, parsed.data)
  }
  // Preserve caller's id order (matches closure traversal order) so the
  // resulting inline JSON keys list is deterministic.
  const out: Plugin[] = []
  for (const id of ids) {
    const p = byId.get(id)
    if (p !== undefined) out.push(p)
  }
  return out
}
