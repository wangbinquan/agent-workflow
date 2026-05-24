// RFC-061 PR-B T9 — ready-scan over logical_runs projection.
//
// design.md §7 spells out the lazy-cascade SQL: for each logical_run row
// in (pending|running|suspended), check whether all upstream nodes are
// `done` at this scope AND my iter < max(upstream.iter) — if so, mint a
// fresh logical_run at iter+1 and dispatch.
//
// In the projection-based world, this scan reads from logical_runs +
// node_outputs only; it never reads from events directly (the applier
// is responsible for keeping projections current before the scanner runs).
//
// The scanner returns a list of (scope, NodeKind) ready to dispatch.
// The taskActor's loop then invokes the corresponding NodeKindHandler
// for each via computeTickActions.
//
// NOTE: Wrapper-* "inner scope completed" detection is layered on top —
// when every inner-scope logical_run for a wrapper reaches a terminal
// status, the wrapper's onInnerScopeCompleted hook fires. That logic
// lives in the actor loop body (not here) so this file stays focused
// on lazy cascade.

import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '../db/client'
import { logicalRuns } from '../db/schema'
import type { Scope, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { ReadyScope } from './taskActorTick'

export interface ReadyScanContext {
  db: DbClient
  taskId: string
  workflow: WorkflowDefinition
}

/**
 * Scan the projection for logical_runs whose downstream edges are
 * satisfied. Returns the (scope, node) pairs the taskActor should
 * dispatch in the next tick.
 *
 * Semantics:
 *   - A row is "ready" when its status is 'pending' (newly minted, not
 *     yet dispatched). Already-running / suspended rows are NOT ready;
 *     the actor processes them via attempt-exit / suspension-resolved
 *     wake events, not via re-dispatch.
 *   - input nodes that haven't been minted yet (no logical_run row) get
 *     synthesized here with iter=0 so the entry points kick off the
 *     workflow without a prior bump event.
 */
export function scanReadyScopes(ctx: ReadyScanContext): ReadyScope[] {
  const pendingRows = ctx.db
    .select()
    .from(logicalRuns)
    .where(and(eq(logicalRuns.taskId, ctx.taskId), inArray(logicalRuns.status, ['pending'])))
    .all() as Array<typeof logicalRuns.$inferSelect>

  const out: ReadyScope[] = []
  for (const r of pendingRows) {
    const node = findNode(ctx.workflow, r.nodeId)
    if (!node) continue
    const scope: Scope = {
      nodeId: r.nodeId,
      loopIter: r.loopIter,
      shardKey: r.shardKey,
      iter: r.iter,
    }
    out.push({ scope, node })
  }
  return out
}

function findNode(workflow: WorkflowDefinition, nodeId: string): WorkflowNode | null {
  const nodes = (workflow as { nodes?: ReadonlyArray<WorkflowNode> }).nodes ?? []
  for (const n of nodes) {
    if (n.id === nodeId) return n
  }
  return null
}

/**
 * Detect wrappers whose inner scope has fully completed. Returns the
 * list of (outerScope, innerScopes[], outerNode) tuples the actor
 * should invoke `onInnerScopeCompleted` for.
 *
 * A wrapper inner scope is "complete" when:
 *   - Every inner logical_run at the wrapper's (loopIter, shardKey) has
 *     status === 'done' (no pending/running/suspended remaining)
 *   - The wrapper itself is NOT in a terminal state yet
 *
 * The actor calls this AFTER scanReadyScopes so it can fire
 * onInnerScopeCompleted on the wrapper's next tick.
 */
export interface WrapperInnerCompletion {
  outerScope: Scope
  outerNode: WorkflowNode
  innerScopes: ReadonlyArray<Scope>
}

export function scanWrapperInnerCompletions(ctx: ReadyScanContext): WrapperInnerCompletion[] {
  const rows = ctx.db
    .select()
    .from(logicalRuns)
    .where(eq(logicalRuns.taskId, ctx.taskId))
    .all() as Array<typeof logicalRuns.$inferSelect>

  const out: WrapperInnerCompletion[] = []
  const nodes = (ctx.workflow as { nodes?: ReadonlyArray<WorkflowNode> }).nodes ?? []
  for (const wrapper of nodes) {
    if (!isWrapper(wrapper.kind)) continue
    // Outer scope rows — the wrapper's own logical_run.
    const outerRows = rows.filter(
      (r) =>
        r.nodeId === wrapper.id &&
        (r.status === 'running' || r.status === 'pending' || r.status === 'suspended'),
    )
    for (const outer of outerRows) {
      const outerScope: Scope = {
        nodeId: outer.nodeId,
        loopIter: outer.loopIter,
        shardKey: outer.shardKey,
        iter: outer.iter,
      }
      // Inner rows at this wrapper's loopIter; nodeId is anything inside
      // the wrapper (the wrapper assigns loopIter = outer.iter when it
      // creates the inner scope per design.md §11.2).
      const innerRows = rows.filter(
        (r) =>
          r.loopIter === outer.iter && r.shardKey === outer.shardKey && r.nodeId !== outer.nodeId, // exclude the wrapper's own row
      )
      if (innerRows.length === 0) continue
      const allDone = innerRows.every((r) => r.status === 'done')
      if (!allDone) continue
      const innerScopes: Scope[] = innerRows.map((r) => ({
        nodeId: r.nodeId,
        loopIter: r.loopIter,
        shardKey: r.shardKey,
        iter: r.iter,
      }))
      out.push({ outerScope, outerNode: wrapper, innerScopes })
    }
  }
  return out
}

function isWrapper(kind: string): boolean {
  return kind === 'wrapper-git' || kind === 'wrapper-loop' || kind === 'wrapper-fanout'
}

/**
 * Detect downstream nodes that are ready to mint a fresh logical_run
 * row: every inbound edge's source node has a completed logical_run at
 * the current scope, but this node has no row yet.
 *
 * Returns the list of (scope, node) pairs the actor should write
 * `logical-run-created` events for. After the events are written + the
 * applier creates the rows, scanReadyScopes will return them on the
 * next tick.
 */
export function scanFreshDownstream(ctx: ReadyScanContext): ReadyScope[] {
  const allRuns = ctx.db
    .select()
    .from(logicalRuns)
    .where(eq(logicalRuns.taskId, ctx.taskId))
    .all() as Array<typeof logicalRuns.$inferSelect>

  const nodes = (ctx.workflow as { nodes?: ReadonlyArray<WorkflowNode> }).nodes ?? []
  const edges =
    (
      ctx.workflow as {
        edges?: ReadonlyArray<{
          source?: { nodeId?: string }
          target?: { nodeId?: string }
        }>
      }
    ).edges ?? []

  // Build adjacency: node → list of upstream node ids.
  const upstreamMap = new Map<string, Set<string>>()
  for (const e of edges) {
    const t = e.target?.nodeId
    const s = e.source?.nodeId
    if (typeof t !== 'string' || typeof s !== 'string') continue
    const set = upstreamMap.get(t) ?? new Set<string>()
    set.add(s)
    upstreamMap.set(t, set)
  }

  // Group existing runs by nodeId for quick lookup.
  const runsByNode = new Map<string, Array<typeof logicalRuns.$inferSelect>>()
  for (const r of allRuns) {
    const arr = runsByNode.get(r.nodeId) ?? []
    arr.push(r)
    runsByNode.set(r.nodeId, arr)
  }

  const out: ReadyScope[] = []
  for (const node of nodes) {
    const upstreams = upstreamMap.get(node.id)
    if (!upstreams || upstreams.size === 0) continue // entry node; seeded by launcher
    // Skip if this node already has any logical_run row at iter=0/loopIter=0/shardKey=''.
    const myRuns = runsByNode.get(node.id) ?? []
    const alreadyHasInitial = myRuns.some(
      (r) => r.loopIter === 0 && r.shardKey === '' && r.iter === 0,
    )
    if (alreadyHasInitial) continue
    // All upstream nodes must have a 'done' run at scope (0, '', any iter — take latest).
    let allUpstreamDone = true
    for (const upId of upstreams) {
      const upRuns = runsByNode.get(upId) ?? []
      const hasDone = upRuns.some(
        (r) => r.status === 'done' && r.loopIter === 0 && r.shardKey === '',
      )
      if (!hasDone) {
        allUpstreamDone = false
        break
      }
    }
    if (!allUpstreamDone) continue
    out.push({
      scope: { nodeId: node.id, loopIter: 0, shardKey: '', iter: 0 },
      node,
    })
  }
  return out
}
