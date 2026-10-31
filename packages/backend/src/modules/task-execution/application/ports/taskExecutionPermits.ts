import type { Semaphore } from '@/platform/contracts/semaphore'

/** Independent daemon-wide node budgets. */
export type NodePoolKind = 'agent' | 'script' | 'code-host'

/** The callable release and critical section keep the public lock contract explicit. */
export interface TaskExecutionPermitRelease {
  (): void
}
export interface TaskExecutionCriticalSection<T> {
  (): Promise<T>
}
export interface TaskExecutionWriteLock {
  acquire(): Promise<TaskExecutionPermitRelease>
  run<T>(work: TaskExecutionCriticalSection<T>): Promise<T>
}

/** Exact cross-context contract; consumers share the registry's existing lock objects. */
export interface TaskExecutionPermits {
  getTaskWriteSem(taskId: string): TaskExecutionWriteLock
  getTaskQuestionWriteSem(taskId: string): TaskExecutionWriteLock
}

/** Complete engine/bootstrap contract; daemon identity and resize stay internal. */
export interface TaskExecutionPermitRegistry extends TaskExecutionPermits {
  getTaskWriteSem(taskId: string): Semaphore
  getTaskQuestionWriteSem(taskId: string): Semaphore
  /** Only the task driver's finally may reclaim idle task locks. */
  gcTaskWriteSem(taskId: string): void
  taskWriteLockCount(): number
  getNodePoolSemaphore(
    daemonScope: object,
    kind: NodePoolKind,
    capacity: number,
    mode?: 'set' | 'seed-only',
  ): Semaphore
  resizeAllNodePools(daemonScope: object, capacities: Record<NodePoolKind, number>): void
  getTaskFanoutSem(taskId: string, capacity: number): Semaphore
  resizeAllTaskFanoutSems(capacity: number): void
  /** Only the task driver's finally may reclaim an idle fanout pool. */
  gcTaskFanoutSem(taskId: string): void
  taskFanoutPoolCount(): number
}
