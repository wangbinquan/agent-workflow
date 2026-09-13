// RFC-359 AC-6：跟着 `integrationTriggerResourceBinding` 一起放宽——它只是把 db 转交给那个夹具。
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { runDueSchedulesOnce as runDueSchedulesOnceWithProvider } from '../../src/services/scheduledTaskScheduler'
import type {
  BuildScheduleLaunch,
  ScheduleAuthorityRuntime,
} from '../../src/services/scheduledTasks'
import { scheduledTaskRuntime } from './integrationTriggerResourceBinding'

export * from '../../src/services/scheduledTaskScheduler'

export function runDueSchedulesOnce(
  db: ProviderNeutralDatabase,
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
