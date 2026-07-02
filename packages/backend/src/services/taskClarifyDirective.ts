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

import { and, eq } from 'drizzle-orm'
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
): Promise<ClarifyDirective | undefined> {
  const rows = await db
    .select({ directive: taskNodeClarifyDirectives.directive })
    .from(taskNodeClarifyDirectives)
    .where(
      and(
        eq(taskNodeClarifyDirectives.taskId, taskId),
        eq(taskNodeClarifyDirectives.nodeId, nodeId),
      ),
    )
    .limit(1)
  return (rows[0]?.directive as ClarifyDirective | undefined) ?? undefined
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
): Promise<{ directive: ClarifyDirective; updatedAt: number } | undefined> {
  const rows = await db
    .select({
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
    .limit(1)
  const row = rows[0]
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
): Promise<void> {
  const now = Date.now()
  await db
    .insert(taskNodeClarifyDirectives)
    .values({ taskId, nodeId, directive, setBy, updatedAt: now })
    .onConflictDoUpdate({
      target: [taskNodeClarifyDirectives.taskId, taskNodeClarifyDirectives.nodeId],
      set: { directive, setBy, updatedAt: now },
    })
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
      directive: taskNodeClarifyDirectives.directive,
    })
    .from(taskNodeClarifyDirectives)
    .where(eq(taskNodeClarifyDirectives.taskId, taskId))
  const out: Record<string, ClarifyDirective> = {}
  for (const r of rows) out[r.nodeId] = r.directive as ClarifyDirective
  return out
}
