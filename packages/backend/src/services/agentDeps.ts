// RFC-022: dependency-closure helpers shared by agent CRUD, the scheduler,
// the workflow validator, and the two closure HTTP endpoints.
//
// The scope here is deliberately small: pure traversal + guard-checking. No
// DB writes; no inline-config building. Callers compose with the rest of the
// services layer.
//
//   resolveDependsClosure(db, root, opts?)
//     BFS over agent.dependsOn. Returns ok:true with agents in BFS order
//     (root first) or ok:false with the offending cycle path. Missing names
//     either throw `agent-dependency-not-found` (default) or are silently
//     skipped (allowMissing=true) — caller picks based on whether the read
//     is for save-time validation or for tolerant UI preview.
//
//   validateDependsOn(db, selfName, dependsOn)
//     Save-time guard chained from agent.ts createAgent / updateAgent. Runs
//     dedupe → self-check → existence-check → closure (cycle) and throws
//     DomainError with one of the four RFC-022 codes on the first failure.
//     Safe to call before the row exists (new agent path) — the synthetic
//     root carries the proposed dependsOn list rather than reading the DB
//     row.
//
//   findAgentsDependingOn(db, name)
//     Reverse index used by delete / rename guards. Pre-filters with LIKE
//     (rough — substring match), then JSON.parse + Array.includes to defend
//     against false positives (e.g. agent 'foo' matching 'foobar' in some
//     other row's dependsOn).

import type { Agent } from '@agent-workflow/shared'
import { like } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import { DomainError } from '@/util/errors'
import { getAgent } from './agent'

export type DependsClosureResult =
  | { ok: true; agents: Agent[] }
  | { ok: false; cyclePath: string[] }

export interface ResolveClosureOpts {
  /**
   * When true, dependsOn entries that don't resolve to an Agent row are
   * silently skipped (useful for UI preview where the DB is read tolerantly).
   * Default: throws `agent-dependency-not-found` on first missing name.
   */
  allowMissing?: boolean
}

/**
 * BFS over `agent.dependsOn`. The `path` carried with each queued entry is
 * the ordered list of ancestor names from the BFS root down to (but not
 * including) the entry itself; revisiting any name on that path is a cycle.
 *
 * Already-visited names that arrived via a *different* path are not cycles —
 * the DAG can re-converge through diamonds; we just don't expand again to
 * avoid redundant work (and the tree-rendering layer collapses repeats into
 * `↑ see above` regardless).
 */
export async function resolveDependsClosure(
  db: DbClient,
  root: Agent,
  opts: ResolveClosureOpts = {},
): Promise<DependsClosureResult> {
  const allowMissing = opts.allowMissing ?? false
  const visited = new Map<string, Agent>([[root.name, root]])
  const order: Agent[] = [root]
  const queue: Array<{ name: string; path: string[] }> = []
  for (const dep of root.dependsOn) {
    queue.push({ name: dep, path: [root.name] })
  }
  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const { name, path } = entry
    // Cycle: this name reappears on the active ancestor path. Slice from the
    // first sighting so the reported path is "B → C → B" (the loop itself)
    // rather than including unrelated prefix.
    const cycleIdx = path.indexOf(name)
    if (cycleIdx >= 0) {
      return { ok: false, cyclePath: [...path.slice(cycleIdx), name] }
    }
    if (visited.has(name)) continue
    const agent = await getAgent(db, name)
    if (agent === null) {
      if (allowMissing) continue
      throw new DomainError('agent-dependency-not-found', `agent '${name}' not found`, 400, {
        notFound: [name],
      })
    }
    visited.set(name, agent)
    order.push(agent)
    for (const next of agent.dependsOn) {
      queue.push({ name: next, path: [...path, name] })
    }
  }
  return { ok: true, agents: order }
}

/**
 * Save-time guard. Throws on the first violation; callers should let the
 * exception bubble up to the HTTP layer where errorHandler renders the
 * standard `{ ok:false, code, message, details? }` envelope.
 *
 * selfName may not yet exist in the DB (new-agent flow); the closure is
 * built from a synthetic root carrying the proposed dependsOn list, so the
 * BFS still detects cycles like A → B → A even before A is persisted.
 */
export async function validateDependsOn(
  db: DbClient,
  selfName: string,
  dependsOn: readonly string[],
): Promise<void> {
  if (dependsOn.length === 0) return

  // 1. dedupe with stable order
  const seen = new Set<string>()
  const unique: string[] = []
  for (const n of dependsOn) {
    if (seen.has(n)) continue
    seen.add(n)
    unique.push(n)
  }

  // 2. self-reference
  if (unique.includes(selfName)) {
    throw new DomainError('agent-dependency-self', `agent cannot depend on itself`, 400, {
      name: selfName,
    })
  }

  // 3. direct-level existence check — gives a crisper error than the BFS,
  //    which only reports the first missing dep on its traversal path.
  const missing: string[] = []
  for (const n of unique) {
    const a = await getAgent(db, n)
    if (a === null) missing.push(n)
  }
  if (missing.length > 0) {
    throw new DomainError(
      'agent-dependency-not-found',
      `agent dependsOn references unknown agent(s): ${missing.join(', ')}`,
      400,
      { notFound: missing },
    )
  }

  // 4. closure cycle check via BFS over the synthetic root.
  const existing = await getAgent(db, selfName)
  const syntheticRoot: Agent = existing
    ? { ...existing, dependsOn: unique }
    : ({
        id: '',
        name: selfName,
        description: '',
        outputs: [],
        readonly: false,
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: unique,
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: '',
        schemaVersion: 1,
        createdAt: 0,
        updatedAt: 0,
      } satisfies Agent)
  const closure = await resolveDependsClosure(db, syntheticRoot)
  if (closure.ok === false) {
    throw new DomainError(
      'agent-dependency-cycle',
      `agent dependsOn forms a cycle: ${closure.cyclePath.join(' → ')}`,
      400,
      { cyclePath: closure.cyclePath },
    )
  }
}

/**
 * "Who depends on me?" — agent.ts uses this in the delete / rename guard so
 * the platform refuses to break references silently.
 *
 * Implementation: SQL `LIKE` is fast but coarse (substring match). After the
 * pre-filter we re-parse the JSON column and exact-match with Array.includes
 * to reject false positives like `'foo'` matching another row's
 * `["foobar"]` dependsOn.
 */
export async function findAgentsDependingOn(db: DbClient, name: string): Promise<string[]> {
  // The escaped form ensures `["foobar"]` matches LIKE `%"foo"%` for the
  // pre-filter only; the JSON.parse step below is the authoritative test.
  const rows = await db
    .select({ name: agents.name, dependsOn: agents.dependsOn })
    .from(agents)
    .where(like(agents.dependsOn, `%"${name}"%`))
  const out: string[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.dependsOn) as unknown
      if (Array.isArray(parsed) && parsed.includes(name)) out.push(row.name)
    } catch {
      // malformed column — ignore, agent.ts parser already treats it as []
    }
  }
  return out
}
