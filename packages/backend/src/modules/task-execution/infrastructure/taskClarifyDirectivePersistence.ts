// RFC-395 II-a A7：执行域持有 clarify directive 存储；外域沿 public 端口消费。
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, ne } from 'drizzle-orm'
import type { ClarifyDirective } from '@agent-workflow/shared'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { TaskClarifyDirectivePersistence } from '../application/ports/taskClarifyDirectivePersistence'
/**
 * Resolve the override for one (task, node). Returns the stored directive, or
 * `undefined` when no row exists (⇒ caller treats as 'continue').
 */
async function getNodeClarifyDirective(
  db: PersistenceDb,
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
async function getNodeClarifyDirectiveRow(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  /**
   * RFC-207 — resolve for ONE asker. The asker's own row wins; absent, the
   * node-level ('') row applies. Omitting this reads the node-level row only,
   * which is what every non-sharded caller (the canvas toggle) wants.
   */
  shardKey?: string | null,
): Promise<{ directive: ClarifyDirective; updatedAt: number } | undefined> {
  const { taskNodeClarifyDirectives } = tablesOf(db)
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
async function setNodeClarifyDirective(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  directive: ClarifyDirective,
  setBy: string | null,
  shardKey?: string | null,
  now = Date.now(),
): Promise<void> {
  await databaseSessionFor(db).transaction((tx) =>
    setNodeClarifyDirectiveTx(tx, taskId, nodeId, directive, setBy, shardKey ?? null, now),
  )
}

/** RFC-341 — transaction participant used by the clarify decision seal (RFC-359: both engines). */
async function setNodeClarifyDirectiveTx(
  tx: PersistenceTx,
  taskId: string,
  nodeId: string,
  directive: ClarifyDirective,
  setBy: string | null,
  shardKey: string | null,
  now: number,
): Promise<void> {
  const key = shardKey ?? ''
  const { taskNodeClarifyDirectives } = tablesOf(tx)
  await tx
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
    await tx
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
async function listNodeClarifyDirectives(
  db: PersistenceDb,
  taskId: string,
): Promise<Record<string, ClarifyDirective>> {
  const { taskNodeClarifyDirectives } = tablesOf(db)
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

async function listWorkgroupStopDirectives(
  db: PersistenceDb,
  taskId: string,
): Promise<
  {
    nodeId: string
    shardKey: string
    directive: ClarifyDirective
  }[]
> {
  const { taskNodeClarifyDirectives } = tablesOf(db)
  return db
    .select({
      nodeId: taskNodeClarifyDirectives.nodeId,
      shardKey: taskNodeClarifyDirectives.shardKey,
      directive: taskNodeClarifyDirectives.directive,
    })
    .from(taskNodeClarifyDirectives)
    .where(
      and(
        eq(taskNodeClarifyDirectives.taskId, taskId),
        eq(taskNodeClarifyDirectives.directive, 'stop'),
        ne(taskNodeClarifyDirectives.shardKey, ''),
      ),
    )
}

/** 读写共享调用方句柄；事务内调用 setInTx 时不另开事务。 */
export function createTaskClarifyDirectivePersistence(
  db: PersistenceDb,
): TaskClarifyDirectivePersistence {
  return {
    get(taskId, nodeId, shardKey) {
      return getNodeClarifyDirective(db, taskId, nodeId, shardKey)
    },
    getRow(taskId, nodeId, shardKey) {
      return getNodeClarifyDirectiveRow(db, taskId, nodeId, shardKey)
    },
    list(taskId) {
      return listNodeClarifyDirectives(db, taskId)
    },
    listWorkgroupStops(taskId) {
      return listWorkgroupStopDirectives(db, taskId)
    },
    set(taskId, nodeId, directive, setBy, shardKey, now) {
      return setNodeClarifyDirective(db, taskId, nodeId, directive, setBy, shardKey, now)
    },
    setInTx(taskId, nodeId, directive, setBy, shardKey, now) {
      return setNodeClarifyDirectiveTx(db, taskId, nodeId, directive, setBy, shardKey, now)
    },
  }
}
