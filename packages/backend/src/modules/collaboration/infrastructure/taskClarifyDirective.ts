// RFC-349 SQLite compatibility adapter for the RFC-122 per-(task,
// asking-node) clarify directive override store.
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

import {
  isClarifyAskingNode,
  type WorkflowDefinition,
  type ClarifyDirective,
} from '@agent-workflow/shared'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/public/participants'

export function getNodeClarifyDirective(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  shardKey?: string | null,
): Promise<ClarifyDirective | undefined> {
  return createTaskClarifyDirectivePersistence(db).get(taskId, nodeId, shardKey)
}

export function getNodeClarifyDirectiveRow(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  shardKey?: string | null,
): Promise<{ directive: ClarifyDirective; updatedAt: number } | undefined> {
  return createTaskClarifyDirectivePersistence(db).getRow(taskId, nodeId, shardKey)
}

export function listNodeClarifyDirectives(
  db: PersistenceDb,
  taskId: string,
): Promise<Record<string, ClarifyDirective>> {
  return createTaskClarifyDirectivePersistence(db).list(taskId)
}

export function setNodeClarifyDirective(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  directive: ClarifyDirective,
  setBy: string | null,
  shardKey?: string | null,
  now = Date.now(),
): Promise<void> {
  return createTaskClarifyDirectivePersistence(db).set(
    taskId,
    nodeId,
    directive,
    setBy,
    shardKey,
    now,
  )
}

export function setNodeClarifyDirectiveTx(
  tx: PersistenceTx,
  taskId: string,
  nodeId: string,
  directive: ClarifyDirective,
  setBy: string | null,
  shardKey: string | null,
  now: number,
): Promise<void> {
  return createTaskClarifyDirectivePersistence(tx).setInTx(
    taskId,
    nodeId,
    directive,
    setBy,
    shardKey,
    now,
  )
}
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
