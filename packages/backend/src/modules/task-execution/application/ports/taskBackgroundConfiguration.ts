import type { Config } from '@agent-workflow/shared'

/** Settings facts consumed by Task Execution's existing provider-session loops. */
export type TaskBackgroundConfiguration = Pick<
  Config,
  | 'autoRepair'
  | 'maxAutoRecoveriesPerWindow'
  | 'autoRecoveryWindowMs'
  | 'autoKillStalledChild'
  | 'heartbeatStallMs'
  | 'periodicOrphanReconcileMs'
  | 'scheduledTasksEnabled'
  | 'scheduledTasksMaxFailures'
  | 'defaultRuntime'
  | 'autoResumeOnBoot'
>

export interface TaskBackgroundConfigurationQuery {
  read(): TaskBackgroundConfiguration | Promise<TaskBackgroundConfiguration>
}
