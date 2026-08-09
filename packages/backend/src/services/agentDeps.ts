// RFC-022: dependency-closure helpers shared by agent CRUD, the scheduler,
// the workflow validator, and the two closure HTTP endpoints.
//
// The scope here is deliberately small: pure traversal + guard-checking. No
// DB writes; no inline-config building. Callers compose with the rest of the
// services layer.
//
//   resolveDependsClosure(db, root, { call })
//     BFS over agent.dependsOn. Returns ok:true with agents in BFS order
//     (root first) or ok:false with the offending cycle path. Missing ids
//     either throw `agent-dependency-not-found` or are silently skipped, per
//     the caller's `RefCallPolicy.onMissing` (RFC-271 T6f) — save-time
//     validation fails, tolerant UI preview skips. The policy is REQUIRED:
//     "什么都不传" 曾经默认成硬失败，读起来像是域的固有语义，实际是调用点的选择。
//
//   validateDependsOn(db, selfName, dependsOn)
//     Save-time guard chained from agent.ts createAgent / updateAgent. Runs
//     dedupe → self-check → existence-check → closure (cycle) and throws
//     DomainError with one of the four RFC-022 codes on the first failure.
//     Safe to call before the row exists (new agent path) — the synthetic
//     root carries the proposed dependsOn list rather than reading the DB
//     row.
//
//   findAgentsDependingOn(db, id)
//     Reverse index used by delete guards. Pre-filters with LIKE
//     (rough — substring match), then JSON.parse + Array.includes to defend
//     against false positives (e.g. agent 'foo' matching 'foobar' in some
//     other row's dependsOn).

import type { Agent, RefCallPolicy } from '@agent-workflow/shared'
import { VALIDATE_CALL_POLICY } from '@agent-workflow/shared'
import { like } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { agents } from '@/db/schema'
import { DomainError } from '@/util/errors'
import { getAgentById } from './agent'
import { runtimeIdRef, runtimeRefKey } from './ref/runtimeRef'

export type DependsClosureResult =
  | { ok: true; agents: Agent[] }
  | { ok: false; cyclePath: string[] }

export interface ResolveClosureOpts {
  /**
   * RFC-271 T6f —— 「解析不到怎么办」是**调用级**属性，不是 dependsOn 这个域的
   * 固有语义：同一条引用，保存期校验要硬失败、tolerant UI preview 要静默跳过。
   * 所以它走 `RefCallPolicy`（`VALIDATE_CALL_POLICY` / `PREVIEW_CALL_POLICY` /
   * `DISPATCH_CALL_POLICY`），而不是域级的 `dangle`——`dangle` 的语义是「按契约
   * 允许解析不到、留到启动再 fail closed」，dependsOn 从来不是那样。
   *
   * 只有 `onMissing:'skip'` 会跳过；`'fail'` 抛 `agent-dependency-not-found`。
   */
  call: RefCallPolicy
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
  opts: ResolveClosureOpts,
): Promise<DependsClosureResult> {
  // RFC-223 (PR-1): dependsOn stores agent IDS; the closure BFS resolves by id
  // (getAgentById) and the cycle path is expressed in ids. A rename never
  // re-routes a closure because ids are stable.
  const allowMissing = opts.call.onMissing === 'skip'
  // RFC-271 决策 29（T6f 的**第四处**）：去重键走 `runtimeRefKey`，与 skills /
  // mcp / plugins 三处同源。
  //
  // 收益不在「今天会撞键」——`dependsOn` 数组里只有 agent 一种类型，跨类型碰撞在
  // 这里不可能发生。收益在于 `runtimeIdRef` 的注释本来就把 dependsOn 算进「同一条
  // 读取点」，而这个 BFS 却自带一套裸 id 去重：**注释声称覆盖、实际没接**，正是
  // RFC-271 自己总结的那条根因（机制在 N 处各写一遍）的下一个复发位。接上之后
  // 「引用身份只有一处定义」才真的成立。
  //
  // ⚠️ 只有**去重键**换成 canonical 形态；`path` / `cyclePath` 保持**裸 id**——
  // 它们会进 HTTP 响应（`routes/agents.ts:459/564`）给人读。
  const keyOf = (id: string): string => runtimeRefKey(runtimeIdRef('agent', id))
  const visited = new Map<string, Agent>([[keyOf(root.id), root]])
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
    if (visited.has(keyOf(id))) continue
    const agent = await getAgentById(db, id)
    if (agent === null) {
      if (allowMissing) continue
      throw new DomainError('agent-dependency-not-found', `agent '${id}' not found`, 400, {
        notFound: [id],
      })
    }
    visited.set(keyOf(id), agent)
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

  // 2. self-reference is canonical-id only. Portable import selectors must be
  //    resolved before entering this ordinary-write validator.
  if (unique.includes(selfId)) {
    throw new DomainError('agent-dependency-self', `agent cannot depend on itself`, 400, {
      id: selfId,
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
  const closure = await resolveDependsClosure(db, syntheticRoot, {
    call: VALIDATE_CALL_POLICY,
  })
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
 * returned list keeps both the referencing agents' stable ids and display
 * names. Callers MUST continue to bind disclosure/filtering by id: names are
 * not unique across owners after RFC-223.
 *
 * Implementation: SQL `LIKE` is fast but coarse (substring match). After the
 * pre-filter we re-parse the JSON column and exact-match with Array.includes
 * to reject false positives (an id being a JSON substring of another value).
 */
export async function findAgentsDependingOn(
  db: DbClient,
  agentId: string,
): Promise<Array<{ id: string; name: string }>> {
  // The escaped form ensures `["<id>"]` matches LIKE `%"<id>"%` for the
  // pre-filter only; the JSON.parse step below is the authoritative test.
  const rows = await db
    .select({ id: agents.id, name: agents.name, dependsOn: agents.dependsOn })
    .from(agents)
    .where(like(agents.dependsOn, `%"${agentId}"%`))
  return agentsDependingOnIn(rows, agentId).map(({ id, name }) => ({ id, name }))
}

/** Pure core of findAgentsDependingOn — RFC-165 (F17-r3): the agent
 *  rename/delete guards re-run it on rows read INSIDE their dbTxSync. Matches
 *  by `agentId` (RFC-223 PR-1) against the id-valued dependsOn column and
 *  returns the exact matching ROWS, preserving stable referencing ids. */
export function agentsDependingOnIn<T extends { id: string; dependsOn: string }>(
  rows: readonly T[],
  agentId: string,
): T[] {
  const out: T[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.dependsOn) as unknown
      if (Array.isArray(parsed) && parsed.includes(agentId)) out.push(row)
    } catch {
      // malformed column — ignore, agent.ts parser already treats it as []
    }
  }
  return out
}
