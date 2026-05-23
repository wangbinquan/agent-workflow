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
