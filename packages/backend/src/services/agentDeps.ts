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
import { getAgentById } from './agent'

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
  // RFC-223 (PR-1): dependsOn stores agent IDS; the closure BFS resolves by id
  // (getAgentById) and the cycle path is expressed in ids. A rename never
  // re-routes a closure because ids are stable.
  const allowMissing = opts.allowMissing ?? false
  const visited = new Map<string, Agent>([[root.id, root]])
  const order: Agent[] = [root]
  const queue: Array<{ id: string; path: string[] }> = []
  for (const dep of root.dependsOn) {
    queue.push({ id: dep, path: [root.id] })
  }
  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const { id, path } = entry
    // Cycle: this id reappears on the active ancestor path. Slice from the
    // first sighting so the reported path is "B → C → B" (the loop itself)
    // rather than including unrelated prefix.
    const cycleIdx = path.indexOf(id)
    if (cycleIdx >= 0) {
      return { ok: false, cyclePath: [...path.slice(cycleIdx), id] }
    }
    if (visited.has(id)) continue
    const agent = await getAgentById(db, id)
    if (agent === null) {
      if (allowMissing) continue
      throw new DomainError('agent-dependency-not-found', `agent '${id}' not found`, 400, {
        notFound: [id],
      })
    }
    visited.set(id, agent)
    order.push(agent)
    for (const next of agent.dependsOn) {
      queue.push({ id: next, path: [...path, id] })
    }
  }
  return { ok: true, agents: order }
}

/**
 * Save-time guard. Throws on the first violation; callers should let the
 * exception bubble up to the HTTP layer where errorHandler renders the
 * standard `{ ok:false, code, message, details? }` envelope.
 *
 * selfId may not yet exist in the DB (new-agent flow — createAgent mints the id
 * up front); the closure is built from a synthetic root carrying the proposed
 * dependsOn list, so the BFS still detects cycles like A → B → A even before A
 * is persisted. RFC-223 (PR-1): keyed by id, so a self-dependency and cycles are
 * detected against stable ids rather than names.
 */
export async function validateDependsOn(
  db: DbClient,
  selfId: string,
  dependsOn: readonly string[],
  selfName?: string,
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

  // 2. self-reference. By id for the normal path; ALSO by name for a brand-new
  //    agent whose own id does not exist yet (a self-name in agent.md can't
  //    resolve to an id via resolveAgentRefs, so it survives as the raw name).
  if (unique.includes(selfId) || (selfName !== undefined && unique.includes(selfName))) {
    throw new DomainError('agent-dependency-self', `agent cannot depend on itself`, 400, {
      name: selfName ?? selfId,
    })
  }

  // 3. direct-level existence check — gives a crisper error than the BFS,
  //    which only reports the first missing dep on its traversal path.
  const missing: string[] = []
  for (const n of unique) {
    const a = await getAgentById(db, n)
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
  const existing = await getAgentById(db, selfId)
  const syntheticRoot: Agent = existing
    ? { ...existing, dependsOn: unique }
    : ({
        id: selfId,
        name: '',
        description: '',
        outputs: [],
        inputs: [], // RFC-166
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
 * the platform refuses to break references silently. RFC-223 (PR-1): dependsOn
 * stores agent IDS, so the lookup key is the target agent's `agentId`; the
 * returned list is the referencing agents' NAMES (for the refusal disclosure).
 *
 * Implementation: SQL `LIKE` is fast but coarse (substring match). After the
 * pre-filter we re-parse the JSON column and exact-match with Array.includes
 * to reject false positives (an id being a JSON substring of another value).
 */
export async function findAgentsDependingOn(db: DbClient, agentId: string): Promise<string[]> {
  // The escaped form ensures `["<id>"]` matches LIKE `%"<id>"%` for the
  // pre-filter only; the JSON.parse step below is the authoritative test.
  const rows = await db
    .select({ name: agents.name, dependsOn: agents.dependsOn })
    .from(agents)
    .where(like(agents.dependsOn, `%"${agentId}"%`))
  return agentsDependingOnIn(rows, agentId)
}

/** Pure core of findAgentsDependingOn — RFC-165 (F17-r3): the agent
 *  rename/delete guards re-run it on rows read INSIDE their dbTxSync. Matches
 *  by `agentId` (RFC-223 PR-1) against the id-valued dependsOn column. */
export function agentsDependingOnIn(
  rows: ReadonlyArray<{ name: string; dependsOn: string }>,
  agentId: string,
): string[] {
  const out: string[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.dependsOn) as unknown
      if (Array.isArray(parsed) && parsed.includes(agentId)) out.push(row.name)
    } catch {
      // malformed column — ignore, agent.ts parser already treats it as []
    }
  }
  return out
}
