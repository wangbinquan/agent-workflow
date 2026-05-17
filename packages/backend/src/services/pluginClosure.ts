// RFC-031 — plugin dependsOn-closure helpers used by the scheduler before
// each runNode spawn. Kept tiny + pure so the same code is exercised by
// isolated unit tests, scheduler integration tests, and live spawn paths.
//
// Two functions:
//   collectPluginNamesFromClosure(closure)  — pure; unions every closure
//                                              member's plugins[] into a
//                                              deduped string[] in first-seen
//                                              order.
//   loadPluginsByNames(db, names)           — single DB query (`inArray`)
//                                              returning the matching plugins
//                                              rows.
//
// Composed in scheduler.ts as:
//   const closure = await agentDeps.computeClosure(db, agent)
//   const names   = collectPluginNamesFromClosure(closure)
//   const plugins = await loadPluginsByNames(db, names)
//   await runNode({ ..., dependents: closure, plugins })

import type { Agent, Plugin } from '@agent-workflow/shared'
import { PluginSchema } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { plugins as pluginsTable } from '@/db/schema'

/**
 * Union the `plugins[]` names declared on every closure agent, preserving the
 * first-seen order across BFS visit order.
 *
 * The closure is whatever shape RFC-022 `resolveDependsClosure` returns:
 * primary agent first, then dependents in BFS order. We rely on that order
 * to make the inline-injection output deterministic across runs (and easy to
 * read in spawn logs).
 */
export function collectPluginNamesFromClosure(closure: readonly Agent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of closure) {
    for (const name of agent.plugins ?? []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * Hydrate a list of plugin names into full `Plugin` rows. Unknown names are
 * silently skipped: the caller is expected to have already validated names
 * at save time (RFC-031 T6 `plugin-not-found` guard) but at spawn time a row
 * could have been deleted out from under us, and crashing the node spawn
 * over a missing plugin is worse than starting the opencode process without
 * it (opencode tolerates plugin load failures with a log+publish; see
 * opencode/packages/opencode/src/plugin/index.ts:170-209).
 *
 * Empty input returns `[]` without hitting the DB.
 */
export async function loadPluginsByNames(
  db: DbClient,
  names: readonly string[],
): Promise<Plugin[]> {
  if (names.length === 0) return []
  const rows = await db
    .select()
    .from(pluginsTable)
    .where(inArray(pluginsTable.name, [...names]))
  // Re-parse via the public schema so we never hand the runner a malformed
  // row (the same `plugin-row-corrupt` validation that services/plugin.ts uses).
  const byName = new Map<string, Plugin>()
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
    if (parsed.success) byName.set(row.name, parsed.data)
  }
  // Preserve caller's name order (matches closure traversal order) so the
  // resulting inline JSON keys list is deterministic.
  const out: Plugin[] = []
  for (const n of names) {
    const p = byName.get(n)
    if (p !== undefined) out.push(p)
  }
  return out
}
