import { createFileTaskBackgroundConfigurationQuery } from '../infrastructure/local/fileTaskBackgroundConfiguration'
import type { TaskBackgroundConfigurationQuery } from '../application/ports/taskBackgroundConfiguration'
import {
  findStalledRunningChildren,
  runHeartbeatKillOnce,
} from '../application/recovery/heartbeatKill'
import { DAEMON_CADENCE } from '@/platform/background/daemonCadence'
import { reconcileDeadRunningRuns } from '../infrastructure/local/deadRunReconcile'
import { killStaleRunProcessTree } from '@/util/process'
import type { TaskExecutionModule } from '../composition'
import type { TaskAutoResumeCommand } from '../application/ports/taskAutoResumeCommand'
import type { TaskLifecycleAutoRepairCommand } from '../application/ports/taskLifecycleAutoRepairCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type {
  ProviderBackgroundControl,
  ProviderBackgroundStart,
} from '../application/ports/providerBackground'
import { createTaskExecutionProviderBackground } from '../application/providerBackground'

export interface TaskExecutionProviderBackgroundStartDependencies {
  readonly configPath?: string
  readonly configuration?: TaskBackgroundConfigurationQuery
  /**
   * RFC-438: one scheduled-task pass belongs to integration; bootstrap hands it in as the application port's
   * `runDue`. Task-execution keeps only the loop, its cadence and the enable gate.
   */
  readonly scheduled: ProviderBackgroundStart['scheduled']
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
      scheduleTickMs: () => DAEMON_CADENCE.scheduledTasks,
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
        scheduled: dependencies.scheduled,
      })
    },
    pause: control.pause,
    resume: control.resume,
    stop: control.stop,
    close: control.close,
    awaitIdle: control.awaitIdle,
  })
}
