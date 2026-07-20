// RFC-122 — per-(task, asking-node) clarify directive override store.
//
// The single source of truth for the on-canvas "继续反问 / 停止反问" toggle. The
// scheduler reads `getNodeClarifyDirective` AT DISPATCH (parallel to RFC-056
// `resolveCrossNodeStopped`) and, when it returns 'stop', forces the asking agent out
// of mandatory ask-back for that dispatch. An absent row ⇒ undefined ⇒ the
// caller treats it as 'continue' (legacy behavior, byte-for-byte) — golden-lock
// hinges on this: no row → the scheduler's effectiveHasClarifyChannel boolean is
// unchanged.
//
// `setBy` is the task-member user id, recorded for the UI/audit trail only; like
// every other attribution column it MUST NOT enter an agent prompt.

import { and, eq, ne } from 'drizzle-orm'
import { isClarifyAskingNode, type ClarifyDirective } from '@agent-workflow/shared'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { taskNodeClarifyDirectives } from '@/db/schema'

/**
 * RFC-122: is `nodeId` an asking-agent node in the task's frozen workflow
 * snapshot (the JSON the route holds as a string)? Owns the JSON.parse so the
 * route never casts an `unknown` to `WorkflowDefinition` (RFC-054 W1-7). Returns
 * false on unparseable JSON — the route then surfaces the appropriate 422.
 */
export function isAskingNodeInSnapshot(snapshotJson: string, nodeId: string): boolean {
  let definition: WorkflowDefinition
  try {
    definition = JSON.parse(snapshotJson) as WorkflowDefinition
  } catch {
    return false
  }
  return isClarifyAskingNode(definition, nodeId)
}

/**
 * Resolve the override for one (task, node). Returns the stored directive, or
 * `undefined` when no row exists (⇒ caller treats as 'continue').
 */
export async function getNodeClarifyDirective(
  db: DbClient,
  taskId: string,
  nodeId: string,
  shardKey?: string | null,
): Promise<ClarifyDirective | undefined> {
  return (await getNodeClarifyDirectiveRow(db, taskId, nodeId, shardKey))?.directive
}

/**
 * RFC-123: like `getNodeClarifyDirective` but also returns the row's `updatedAt`,
 * so a 'continue' re-enable can be RECENCY-checked against the stop signal it
 * would override. A stale pre-RFC-123 'continue' row (the canvas API kept
 * 'continue' rows while answer-stop did NOT update this table) must not re-enable
 * a LATER 'stop' — the override only wins when the toggle is at least as fresh as
 * the stop it overrides. Returns `undefined` when no row exists.
 */
export async function getNodeClarifyDirectiveRow(
  db: DbClient,
  taskId: string,
  nodeId: string,
  /**
   * RFC-207 — resolve for ONE asker. The asker's own row wins; absent, the
   * node-level ('') row applies. Omitting this reads the node-level row only,
   * which is what every non-sharded caller (the canvas toggle) wants.
   */
  shardKey?: string | null,
): Promise<{ directive: ClarifyDirective; updatedAt: number } | undefined> {
  const rows = await db
    .select({
      shardKey: taskNodeClarifyDirectives.shardKey,
      directive: taskNodeClarifyDirectives.directive,
      updatedAt: taskNodeClarifyDirectives.updatedAt,
    })
    .from(taskNodeClarifyDirectives)
    .where(
      and(
        eq(taskNodeClarifyDirectives.taskId, taskId),
        eq(taskNodeClarifyDirectives.nodeId, nodeId),
      ),
    )
  const key = shardKey ?? ''
  const row = rows.find((r) => r.shardKey === key) ?? rows.find((r) => r.shardKey === '')
  if (row === undefined) return undefined
  return { directive: row.directive as ClarifyDirective, updatedAt: row.updatedAt }
}

/**
 * Upsert the override for one (task, node). Keeps the row on 'continue' (rather
 * than deleting) so the audit trail (setBy / updatedAt) survives a flip back;
 * the scheduler only ever branches on `=== 'stop'`, so a 'continue' row is
 * behaviorally identical to an absent one.
 */
export async function setNodeClarifyDirective(
  db: DbClient,
  taskId: string,
  nodeId: string,
  directive: ClarifyDirective,
  setBy: string | null,
  shardKey?: string | null,
): Promise<void> {
  const now = Date.now()
  const key = shardKey ?? ''
  await db
    .insert(taskNodeClarifyDirectives)
    .values({ taskId, nodeId, shardKey: key, directive, setBy, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        taskNodeClarifyDirectives.taskId,
        taskNodeClarifyDirectives.nodeId,
        taskNodeClarifyDirectives.shardKey,
      ],
      set: { directive, setBy, updatedAt: now },
    })
  // RFC-207 — a NODE-level 'continue' is the "un-stop everything here" gesture.
  // Without this the per-asker rows would keep winning the resolution above, and
  // the canvas toggle would read as continue while an asker stayed silenced —
  // a stop with no way back.
  if (key === '' && directive === 'continue') {
    await db
      .delete(taskNodeClarifyDirectives)
      .where(
        and(
          eq(taskNodeClarifyDirectives.taskId, taskId),
          eq(taskNodeClarifyDirectives.nodeId, nodeId),
          ne(taskNodeClarifyDirectives.shardKey, ''),
        ),
      )
  }
}

/**
 * Map of nodeId → directive for one task. The canvas reads it to colour every
 * asking-agent node's toggle; nodes with no row are absent (⇒ 'continue').
 */
export async function listNodeClarifyDirectives(
  db: DbClient,
  taskId: string,
): Promise<Record<string, ClarifyDirective>> {
  const rows = await db
    .select({
      nodeId: taskNodeClarifyDirectives.nodeId,
      shardKey: taskNodeClarifyDirectives.shardKey,
      directive: taskNodeClarifyDirectives.directive,
    })
    .from(taskNodeClarifyDirectives)
    .where(eq(taskNodeClarifyDirectives.taskId, taskId))
  const out: Record<string, ClarifyDirective> = {}
  // Node-level view only — the canvas has one toggle per node and no shard axis.
  // Per-asker rows surface in the workgroup room instead (RFC-207 §3.7.5).
  for (const r of rows) if (r.shardKey === '') out[r.nodeId] = r.directive as ClarifyDirective
  return out
}
