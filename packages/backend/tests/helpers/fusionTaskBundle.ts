// RFC-387: direct SQLite fusion fixtures configure the daemon bundle's scheduler seam.
import type { DbClient } from '@/db/client'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { composeDaemonTaskExecutionModules } from '@/cli/daemonModules/taskExecution'
import { taskBundleInput } from './daemonTaskExecutionBundle'

export function composeTestFusionTasks(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly schedulerDriver: SchedulerDriverPort
  readonly workspaces: FusionWorkspaceEffects
  readonly binaryOverride?: readonly string[]
  readonly defaultRuntime?: string
}) {
  const fixture = taskBundleInput(
    { db: input.db, applicationBinding: { provider: 'sqlite', db: input.db } },
    input.appHome,
  )
  fixture.update({ defaultRuntime: input.defaultRuntime })
  return composeDaemonTaskExecutionModules({
    ...fixture.input,
    selection: { ...fixture.input.selection, fusionWorkspaces: input.workspaces },
    testSeams: {
      schedulerDriver: {
        ...input.schedulerDriver,
        drive: (request) =>
          input.schedulerDriver.drive({
            ...request,
            ...(input.binaryOverride === undefined ? {} : { binaryOverride: input.binaryOverride }),
          }),
      },
    },
  }).fusion
}
