import type { Config } from '@agent-workflow/shared'

import { createFileTaskBackgroundConfigurationQuery } from '../infrastructure/local/fileTaskBackgroundConfiguration'
import type { TaskBackgroundConfigurationQuery } from '../application/ports/taskBackgroundConfiguration'
import { findStalledRunningChildren, runHeartbeatKillOnce } from '@/services/autoKill'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { reconcileDeadRunningRuns } from '@/services/orphanReconcile'
import {
  runDueSchedulesOnce,
  SCHEDULE_MAX_IN_FLIGHT,
  SCHEDULE_TICK_MS,
} from '@/services/scheduledTaskScheduler'
import type {
  BuildScheduleLaunch,
  ScheduleAuthorityRuntime,
  ScheduledTaskOperations,
} from '@/services/scheduledTasks'
import { killStaleRunProcessTree } from '@/util/process'
import type { TaskExecutionModule } from '../composition'
import type { TaskAutoResumeCommand } from '../application/ports/taskAutoResumeCommand'
import type { TaskLifecycleAutoRepairCommand } from '../application/ports/taskLifecycleAutoRepairCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { ProviderBackgroundControl } from '../application/ports/providerBackground'
import { createTaskExecutionProviderBackground } from '../application/providerBackground'

export interface TaskExecutionProviderBackgroundStartDependencies {
  readonly configPath?: string
  readonly configuration?: TaskBackgroundConfigurationQuery
  readonly scheduled: Readonly<{
    readonly operations: ScheduledTaskOperations
    readonly identityAccess: ScheduleAuthorityRuntime
    readonly loadConfig?: () => Config | Promise<Config>
    readonly onAutoDisable?: (id: string) => void
  }>
}

export interface TaskExecutionProviderBackgroundControl extends Omit<
  ProviderBackgroundControl,
  'start'
> {
  /** Bind and start every TaskExecution-owned provider-session loop exactly once. */
  start(dependencies: TaskExecutionProviderBackgroundStartDependencies): Promise<void>
}

interface ProviderBackgroundRuntime {
  readonly recoveryConsumer?: { tick(): Promise<void> }
  readonly module: TaskExecutionModule
  readonly lifecycleRepair: TaskLifecycleAutoRepairCommand
  readonly autoResume: TaskAutoResumeCommand
  readonly recovery: TaskRecoveryOperations
  readonly taskHasDriver: (taskId: string) => boolean
  readonly buildScheduleLaunch: BuildScheduleLaunch
}

/**
 * Provider-session control for runtime admission plus every TaskExecution-owned
 * periodic writer. RFC-418: the loops and the session control are application
 * flow; this binding supplies the legacy sweeps, the cadence constants, the file
 * configuration source and, at start, the scheduled-task runner.
 */
export function composeTaskExecutionProviderBackground(
  runtime: ProviderBackgroundRuntime,
): TaskExecutionProviderBackgroundControl {
  const control = createTaskExecutionProviderBackground({
    ...(runtime.recoveryConsumer === undefined
      ? {}
      : { recoveryConsumer: runtime.recoveryConsumer }),
    module: runtime.module,
    lifecycleRepair: runtime.lifecycleRepair,
    autoResume: runtime.autoResume,
    cadence: {
      autoRepairMs: () => DAEMON_CADENCE.autoRepair,
      autoKillMs: () => DAEMON_CADENCE.autoKill,
      orphanReconcileSupervisoryMs: () => DAEMON_CADENCE.orphanReconcileSupervisory,
      scheduleTickMs: () => SCHEDULE_TICK_MS,
    },
    fileConfiguration: (configPath) => createFileTaskBackgroundConfigurationQuery(configPath),
    sweeps: {
      async heartbeatKill(input) {
        await runHeartbeatKillOnce({
          operations: runtime.recovery,
          enabled: true,
          breaker: input.breaker,
          findStalledRuns: () =>
            findStalledRunningChildren(runtime.recovery, input.heartbeatStallMs, input.occurredAt),
          killChild: (run) =>
            killStaleRunProcessTree({
              pid: run.pid,
              startedAt: run.startedAt,
              spawnBinaryPath: run.spawnBinaryPath,
              spawnLaunchNonce: run.spawnLaunchNonce,
            }),
        })
      },
      async orphanReconcile() {
        await reconcileDeadRunningRuns({
          operations: runtime.recovery,
          taskHasDriver: runtime.taskHasDriver,
          graceMs: 60_000,
        })
      },
    },
  })
  return Object.freeze({
    async start(dependencies: TaskExecutionProviderBackgroundStartDependencies) {
      await control.start({
        ...(dependencies.configPath === undefined ? {} : { configPath: dependencies.configPath }),
        ...(dependencies.configuration === undefined
          ? {}
          : { configuration: dependencies.configuration }),
        scheduled: {
          ...(dependencies.scheduled.loadConfig === undefined
            ? {}
            : { loadConfig: dependencies.scheduled.loadConfig }),
          async runDue(input) {
            await runDueSchedulesOnce(dependencies.scheduled.operations, {
              buildLaunch: runtime.buildScheduleLaunch,
              identityAccess: dependencies.scheduled.identityAccess,
              maxFailures: input.maxFailures,
              limit: SCHEDULE_MAX_IN_FLIGHT,
              defaultRuntime: input.defaultRuntime,
              ...(dependencies.scheduled.onAutoDisable === undefined
                ? {}
                : { onAutoDisable: dependencies.scheduled.onAutoDisable }),
            })
          },
        },
      })
    },
    pause: control.pause,
    resume: control.resume,
    stop: control.stop,
    close: control.close,
    awaitIdle: control.awaitIdle,
  })
}
