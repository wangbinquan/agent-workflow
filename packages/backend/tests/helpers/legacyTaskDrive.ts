// RFC-387: retained fixture admission composes the same application factory; W4 removes this adapter.
import { composeTestTaskDriveFactory } from '@/services/task'
import type {
  AdmittedContinuationStep,
  TaskDriveFailureReporter,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import { createRoomContinuation } from '@/modules/task-execution/application/drive/roomContinuation'
import {
  createGateContinuationDriver,
  composeWorktreeResumePreflight,
} from '@/modules/task-execution/public/participants'
import { isTaskDriverActive } from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { TaskLaunchConfigurationQueries } from '@/modules/task-execution/public/queries'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition'
import { getTask, type StartTaskDeps } from '@/services/task'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

export function createTestTaskDriveCoordinator(
  input: Parameters<typeof composeTestTaskDriveFactory>[0] & {
    readonly admittedContinuation?: AdmittedContinuationStep
    readonly engineFailureMessage?: string
    readonly failureReporter?: TaskDriveFailureReporter
  },
) {
  return composeTestTaskDriveFactory(input).coordinatorFor({
    admittedContinuation: input.admittedContinuation,
  })
}

export function composeTestRoomContinuation(input: {
  readonly db: StartTaskDeps['db']
  readonly configPath: string
  readonly schedulerDriver: StartTaskDeps['schedulerDriver']
  readonly taskRecoveryOperations: TaskRecoveryOperations
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
}) {
  const presence = input.workspacePresence ?? createFileWorkspacePresenceQueries()
  return createRoomContinuation({
    assertResumable: composeWorktreeResumePreflight({
      getTask: (id) => getTask(input.db, id),
      taskRecoveryOperations: input.taskRecoveryOperations,
      worktreeExists: (reference) => presence.exists(reference),
    }),
    gateContinuation: createGateContinuationDriver({
      isDriving: isTaskDriverActive,
      coordinator: createTestTaskDriveCoordinator({ deps: input, appHome: Paths.root }),
    }),
    log: createLogger('rfc387-room-test'),
  })
}
