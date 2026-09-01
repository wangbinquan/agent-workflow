import type { DbClient } from '../../src/db/client'
import { runDueSchedulesOnce as runDueSchedulesOnceWithProvider } from '../../src/services/scheduledTaskScheduler'
import type {
  BuildScheduleLaunch,
  ScheduleAuthorityRuntime,
} from '../../src/services/scheduledTasks'
import { scheduledTaskRuntime } from './integrationTriggerResourceBinding'

export * from '../../src/services/scheduledTaskScheduler'

export function runDueSchedulesOnce(
  db: DbClient,
  options: {
    buildLaunch: BuildScheduleLaunch
    identityAccess: ScheduleAuthorityRuntime
    now?: number
    maxFailures?: number
    limit?: number
    onAutoDisable?: (id: string) => void
    defaultRuntime?: string | null
  },
) {
  return runDueSchedulesOnceWithProvider(scheduledTaskRuntime(db).operations, options)
}
