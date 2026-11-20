// RFC-514 — the task drive: run the control plane on its ports, inside the bound execution context when there is one,
// and always reclaim the task's per-task registry entries afterwards.
import type { TaskRunPorts } from '../../application/ports/taskRun'
import type { TaskExecutionPermitRegistry } from '../../application/ports/taskExecutionPermits'
import type { TaskExecutionContextRef } from '../../application/ports/taskExecutionTopology'
import { runWithTaskExecutionContext } from '../../application/taskExecutionContext'
import { runTask } from './runTask'

export async function driveTaskRun<Admission>(input: {
  readonly taskId: string
  readonly executionContext: TaskExecutionContextRef | undefined
  readonly executionPermits: Pick<TaskExecutionPermitRegistry, 'gcTaskWriteSem' | 'gcTaskFanoutSem'>
  /** Built when the control plane starts, inside the execution context. */
  readonly ports: () => TaskRunPorts<Admission>
}): Promise<void> {
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached legacy mechanics writeSem reference).
  // RFC-266: the fan-out sub-pool registry entry follows the SAME rule and the
  // same reasoning (a split pool would run a task at double its configured
  // shard concurrency), so it is reclaimed in this one place too.
  try {
    // RFC-408: the task control plane runs in engine/task on ports bound inside the execution context.
    const run = () => runTask(input.ports())
    if (input.executionContext === undefined) {
      await run()
    } else {
      await runWithTaskExecutionContext(input.executionContext, run)
    }
  } finally {
    input.executionPermits.gcTaskWriteSem(input.taskId)
    input.executionPermits.gcTaskFanoutSem(input.taskId)
  }
}
