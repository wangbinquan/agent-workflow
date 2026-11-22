// RFC-530 — the cancellation composer only tests used. The daemon cancels through its task routes; the digital-employee
// execution ports' `tasks` default that called this was always overridden by the daemon and is gone. Body as it was in
// composition/taskCancellation.ts, over the tests' execution module (the process-level instance it read is gone).
import type { HumanGateOpenParticipantFactory } from '@/modules/task-execution/application/ports/humanGateOpenFactory'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger } from '@/util/log'
import { cancelTaskProjection } from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { getTask } from '@/modules/task-execution/infrastructure/taskDetailRead'
import { cancelAndReadTask } from '@/modules/task-execution/application/digitalEmployeeExecution'
import {
  createTaskExecutionPersistence,
  type TaskExecutionPersistenceDependencies,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { InMemoryTaskRuntimeRegistry } from '@/modules/task-execution/infrastructure/inMemoryTaskRuntimeRegistry'
import { testTaskExecutionModule } from './taskExecutionModule'
import { neverPruneTerminalWorkspaces } from '@/modules/task-execution/composition'

const log = createLogger('task')

/** 取消的来源。与共用实现的 `cause` 同一套词汇。 */
export type TaskCancelCause = Parameters<typeof cancelTaskProjection>[2]

export interface TaskCancellation {
  /** 缺省是用户取消；父级联传 `{ kind: 'parent-cascade', parentTaskId }`。 */
  cancel(taskId: string, cause?: TaskCancelCause): Promise<void>
}

export function composeTaskCancellation(
  db: PersistenceDb,
  historyRestrictions: HistoryRestrictionPort,
  humanGateOpen: HumanGateOpenParticipantFactory,
  /** RFC-526: the deployment's presence (cancelling never revives a task, so it is not consulted here). */
  workspacePresence: TaskExecutionPersistenceDependencies['workspacePresence'],
  /** The driver registry to stop on — a composed session's own, or (default) the tests' shared module's. */
  stop: InMemoryTaskRuntimeRegistry = testTaskExecutionModule.runtimeRegistry,
): TaskCancellation {
  const dependencies = {
    db,
    persistence: createTaskExecutionPersistence(db, {
      historyRestrictions,
      humanGateOpen,
      workspacePresence,
      terminalWorkspacePrune: neverPruneTerminalWorkspaces,
    }),
    stop,
    log,
  }
  return Object.freeze({
    async cancel(taskId: string, cause: TaskCancelCause = { kind: 'user' }): Promise<void> {
      await cancelTaskProjection(dependencies, taskId, cause)
    },
  })
}

/** The digital-employee execution ports' former `tasks` default (read, and cancel-then-read), for tests that relied on it. */
export function composeDigitalEmployeeTestTasks(
  db: PersistenceDb,
  historyRestrictions: HistoryRestrictionPort,
  humanGateOpen: HumanGateOpenParticipantFactory,
  workspacePresence: TaskExecutionPersistenceDependencies['workspacePresence'],
) {
  return Object.freeze({
    tasks: {
      get: (taskId: string) => getTask(db, taskId),
      cancel: (taskId: string) =>
        cancelAndReadTask(
          {
            cancel: (id) =>
              composeTaskCancellation(
                db,
                historyRestrictions,
                humanGateOpen,
                workspacePresence,
              ).cancel(id),
            read: (id) => getTask(db, id),
          },
          taskId,
        ),
    },
  })
}
