// RFC-395 II-b W0: T implements; every task-subordinate writer consumes this order. Dormant.
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

/** Owned writers fence first; ownerless writers start at the task root.
 * Acquisition order, not UPDATE order: the final task CAS follows subordinate writes.
 * Multi-task writers take every root in task-id order before any owned-row update.
 */
export const TASK_AGGREGATE_LOCK_ORDER = [
  'task_execution_owners',
  'tasks',
  'task-subordinate-rows',
  'node_runs',
  'node_run_selections',
] as const
export type TaskAggregateLockStage = (typeof TASK_AGGREGATE_LOCK_ORDER)[number]
export type TaskAggregateLockCapabilities = Pick<EngineCapabilities, 'lockAggregateRoot'>

export interface TaskAggregateWritePort {
  /** T delegates to engine.lockAggregateRoot(tx, tasks, tasks.id, taskId), using
   * tablesOf(tx) before A-1 and tablesOf(tx) afterwards. No nested transaction.
   * The caller fences an execution owner before this lock. Protocol helpers must not
   * acquire this lock after node_runs writes. Lock before reading subordinate facts, then retain the original lifecycle CAS
   * predicate; a missed CAS rolls the entire transaction back. Task-only CAS keeps
   * its existing single-row protocol. Multi-task operations lock roots by id order.
   * Nullable UNIQUE indexes with NULLS NOT DISTINCT are not Drizzle conflict targets.
   */
  lockTaskAggregateRoot(tx: PersistenceTx, taskId: string): Promise<void>
}
