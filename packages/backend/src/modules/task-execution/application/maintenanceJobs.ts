// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import { join } from 'node:path'
import type {
  TaskRecoveryOperations,
  TaskLifecycleInvariantScope,
  TaskLifecycleAlertProjection,
  TaskLifecycleAlertReconciliation,
} from './ports/taskRecoveryOperations'
import type { TaskArchiveMaintenanceCommand } from './ports/taskArchiveMaintenanceCommand'
import type {
  MaintenanceJobExecutionResult,
  MaintenanceJobHandlers,
} from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

// These consumer-owned function contracts describe only the inputs and projection
// used by maintenance. Bootstrap supplies the existing runners unchanged.
interface TaskMaintenanceAlertCallbacks {
  readonly operations: TaskRecoveryOperations
  readonly onAlert: (
    row: Pick<TaskLifecycleAlertProjection, 'taskId' | 'rule' | 'severity'>,
    transition: 'new' | 'promoted',
  ) => void
  readonly onResolved: (taskId: string) => void
}
type TaskMaintenanceAlertResult = Pick<
  TaskLifecycleAlertReconciliation,
  'newAlerts' | 'promotedAlerts' | 'resolvedAlerts'
> & {
  readonly scanned: number
  readonly openAlerts: readonly unknown[]
}
export type TaskLifecycleInvariantsRunner = (
  input: TaskMaintenanceAlertCallbacks & {
    readonly scope: TaskLifecycleInvariantScope
  },
) => Promise<TaskMaintenanceAlertResult>
export type TaskStuckTaskDetectorRunner = (
  input: TaskMaintenanceAlertCallbacks & {
    readonly stuckThresholdMs?: number
    readonly pendingThresholdMs?: number
  },
) => Promise<TaskMaintenanceAlertResult>

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

export async function runLifecycleInvariantsMaintenanceJob(input: {
  readonly run: TaskLifecycleInvariantsRunner
  readonly operations: TaskRecoveryOperations
  readonly payload: unknown
}): Promise<MaintenanceJobExecutionResult> {
  const payload = parseMaintenanceJobPayload('lifecycleInvariants', input.payload)
  const alerts: Array<{
    taskId: string
    rule: string
    severity: 'warning' | 'error'
    transition: 'new' | 'promoted'
  }> = []
  const resolvedTaskIds: string[] = []
  const result = await input.run({
    operations: input.operations,
    scope: payload.scope,
    onAlert: (row, transition) => {
      alerts.push({
        taskId: row.taskId,
        rule: row.rule,
        severity: row.severity,
        transition,
      })
    },
    onResolved: (taskId) => resolvedTaskIds.push(taskId),
  })
  return {
    counters: {
      scanned: result.scanned,
      newAlerts: result.newAlerts,
      promotedAlerts: result.promotedAlerts,
      resolvedAlerts: result.resolvedAlerts,
      openAlerts: result.openAlerts.length,
    },
    delta: { kind: 'lifecycle-alerts', alerts, resolvedTaskIds },
  }
}

export async function runStuckTaskDetectorMaintenanceJob(input: {
  readonly run: TaskStuckTaskDetectorRunner
  readonly operations: TaskRecoveryOperations
  readonly payload: unknown
}): Promise<MaintenanceJobExecutionResult> {
  const payload = parseMaintenanceJobPayload('stuckTaskDetector', input.payload)
  const alerts: Array<{
    taskId: string
    rule: string
    severity: 'warning' | 'error'
    transition: 'new' | 'promoted'
  }> = []
  const resolvedTaskIds: string[] = []
  const result = await input.run({
    operations: input.operations,
    ...(payload.stuckThresholdMs === undefined
      ? {}
      : { stuckThresholdMs: payload.stuckThresholdMs }),
    ...(payload.pendingThresholdMs === undefined
      ? {}
      : { pendingThresholdMs: payload.pendingThresholdMs }),
    onAlert: (row, transition) =>
      alerts.push({
        taskId: row.taskId,
        rule: row.rule,
        severity: row.severity,
        transition,
      }),
    onResolved: (taskId) => resolvedTaskIds.push(taskId),
  })
  return {
    counters: {
      scanned: result.scanned,
      newAlerts: result.newAlerts,
      promotedAlerts: result.promotedAlerts,
      resolvedAlerts: result.resolvedAlerts,
      openAlerts: result.openAlerts.length,
    },
    delta: { kind: 'lifecycle-alerts', alerts, resolvedTaskIds },
  }
}

export function createTaskExecutionMaintenanceJobHandlers(
  commands: {
    readonly taskRecovery: TaskRecoveryOperations
    readonly taskArchive: TaskArchiveMaintenanceCommand
  },
  runners: {
    readonly runLifecycleInvariants: TaskLifecycleInvariantsRunner
    readonly runStuckTaskDetector: TaskStuckTaskDetectorRunner
  },
): Pick<MaintenanceJobHandlers, 'taskArchive' | 'lifecycleInvariants' | 'stuckTaskDetector'> {
  return {
    async taskArchive(input) {
      const { appHome } = input
      const payload = parseMaintenanceJobPayload('taskArchive', input.payload)
      const result = await commands.taskArchive.runSweep(payload, {
        archiveDir: join(appHome, 'archive', 'tasks'),
        runsDir: join(appHome, 'runs'),
        logsDir: join(appHome, 'logs'),
      })
      return {
        counters: {
          trees: result.archived.length,
          tasks: result.archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
          skipped: result.skipped,
        },
        delta: NONE,
      }
    },
    async lifecycleInvariants(input) {
      return runLifecycleInvariantsMaintenanceJob({
        run: runners.runLifecycleInvariants,
        operations: commands.taskRecovery,
        payload: input.payload,
      })
    },
    async stuckTaskDetector(input) {
      return runStuckTaskDetectorMaintenanceJob({
        run: runners.runStuckTaskDetector,
        operations: commands.taskRecovery,
        payload: input.payload,
      })
    },
  }
}
