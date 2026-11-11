// RFC-482 — collaboration's `infrastructure/taskClarifyDirective.ts` forwarders are gone (production code reaches
// task-execution's directive persistence through the participant bindings). Tests that seed or read directives
// directly keep the same five calls here, over the owner's persistence.
import type { ClarifyDirective } from '@agent-workflow/shared'
import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/composition'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'

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
