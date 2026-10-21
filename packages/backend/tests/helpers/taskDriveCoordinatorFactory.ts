// RFC-386: direct engine fixtures compose the same drive factory as the daemon.
import { createSqliteMemoryDistillEnqueuer } from './memoryDistill'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createLogger } from '@/util/log'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import { createTaskDriveCoordinatorFactory } from '@/modules/task-execution/application/drive/taskDriveCoordinatorFactory'
import {
  skipRepositoryPreparation,
  type TaskDriverLifecyclePort,
} from '@/modules/task-execution/application/drive/taskDriveCoordinator'
import type { TaskDriveRuntimeOptions } from '@/modules/task-execution/application/ports/taskExecutionTopology'

export function testDriveFactory(
  db: ProviderNeutralDatabase,
  lifecycle: TaskDriverLifecyclePort,
  runConfiguration: () => TaskDriveRuntimeOptions | Promise<TaskDriveRuntimeOptions> = () => ({
    appHome: '/tmp',
  }),
) {
  return createTaskDriveCoordinatorFactory({
    runConfiguration,
    lifecycle,
    gateContinuationPreDrive: composeGateContinuationPreDrive({
      db,
      memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(db),
    }),
    repositoryPreparation: skipRepositoryPreparation,
    engine: () => {
      throw new Error('direct fixture must select its scheduler in the drive profile')
    },
    failures: createTaskExecutionPersistence(db),
    log: createLogger('rfc386-test'),
  })
}
