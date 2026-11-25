import { taskExecutionParticipants } from './taskExecutionParticipantBindings'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { composeGateContinuationSupport } from '@/modules/collaboration/composition'
import {
  composeHumanGateTaskLockPort,
  neverPruneTerminalWorkspaces,
} from '@/modules/task-execution/composition'
import { epoch2RuntimeTestPorts } from './epoch2RuntimePorts'
import { o2Ports } from './o2Closure'
// RFC-386: direct engine fixtures compose the same drive factory as the daemon.
import { createSqliteMemoryDistillEnqueuer } from './memoryDistill'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createLogger } from '@/platform/logging/logger'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import { createTaskDriveCoordinatorFactory } from '@/modules/task-execution/application/drive/taskDriveCoordinatorFactory'
import {
  skipRepositoryPreparation,
  type TaskDriverLifecyclePort,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskDriveRuntimeOptions } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'

export function testDriveFactory(
  db: PersistenceDb,
  lifecycle: TaskDriverLifecyclePort,
  runConfiguration: () => TaskDriveRuntimeOptions | Promise<TaskDriveRuntimeOptions> = () => ({
    appHome: '/tmp',
  }),
) {
  return createTaskDriveCoordinatorFactory({
    runConfiguration,
    lifecycle,
    gateContinuationPreDrive: composeGateContinuationPreDrive({
      persistence: createTaskExecutionPersistence(db, {
        workspacePresence: createFileWorkspacePresenceQueries(),
        terminalWorkspacePrune: neverPruneTerminalWorkspaces,
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
      }),
      ...composeGateContinuationSupport({
        taskExecutionParticipants,
        db: db,
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
        taskLock: composeHumanGateTaskLockPort,
        memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(db),
      }),
    }),
    repositoryPreparation: skipRepositoryPreparation,
    engine: () => {
      throw new Error('direct fixture must select its scheduler in the drive profile')
    },
    failures: createTaskExecutionPersistence(db, {
      workspacePresence: createFileWorkspacePresenceQueries(),
      terminalWorkspacePrune: neverPruneTerminalWorkspaces,
      humanGateOpen: composeHumanGateOpenParticipantFactory(),
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    }),
    log: createLogger('rfc386-test'),
  })
}
