import type { MaintenanceJobKey } from '@agent-workflow/shared'
import { join } from 'node:path'

import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import type { DevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/public/commands'
import type { DigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/public/commands'
import type { IntegrationMaintenanceCommands } from '@/modules/integration/public/commands'
import type { IntentMaintenanceCommands } from '@/modules/intent/public/commands'
import type { PluginGenerationGcCommand } from '@/modules/resource-catalog/public/commands'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { TaskArchiveMaintenanceCommand } from '@/modules/task-execution/application/ports/taskArchiveMaintenanceCommand'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { runPluginGenerationGc } from '@/services/pluginGenerationGc'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import { pruneBackups } from './providerBackupScheduler'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'
import type { MaintenanceWorkerDelta } from './maintenanceProtocol'

const DB_WRITE_SLICE_ROWS = 1_000
const DAY_MS = 86_400_000

export interface MaintenanceJobExecutionResult {
  readonly counters: Readonly<Record<string, number>>
  readonly delta: MaintenanceWorkerDelta
  readonly continuation?: {
    readonly cursor: object
    readonly resumeAfterMs: number
  }
}

interface WebhookDeliveryGcCursor {
  readonly version: 1
  readonly phase: 'bodies' | 'rows'
  readonly bodyCutoff: number
  readonly rowCutoff: number
}

export interface MaintenanceSystemOperations {
  readonly eventsArchive: {
    runSlice(input: {
      readonly thresholds: {
        readonly perNodeRunRows: number
        readonly globalRows: number
        readonly perNodeRunBytes: number
        readonly globalBytes: number
      }
      readonly cursor?: unknown
    }): Promise<MaintenanceJobExecutionResult>
  }
  readonly retention: {
    runSlice(input: {
      readonly eventStreamRetentionDays: number
      readonly webhookTriggerFiresRetentionDays: number
      readonly cursor?: unknown
    }): Promise<MaintenanceJobExecutionResult>
  }
  readonly storage: {
    run(): Promise<Readonly<Record<string, number>>>
  }
}

function webhookDeliveryCursor(value: unknown): WebhookDeliveryGcCursor | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'object' ||
    (value as { readonly version?: unknown }).version !== 1 ||
    !['bodies', 'rows'].includes(String((value as { readonly phase?: unknown }).phase)) ||
    !Number.isSafeInteger((value as { readonly bodyCutoff?: unknown }).bodyCutoff) ||
    !Number.isSafeInteger((value as { readonly rowCutoff?: unknown }).rowCutoff)
  ) {
    throw new Error('maintenance-webhook-delivery-cursor-invalid')
  }
  const cursor = value as WebhookDeliveryGcCursor
  return {
    version: 1,
    phase: cursor.phase,
    bodyCutoff: cursor.bodyCutoff,
    rowCutoff: cursor.rowCutoff,
  }
}

export async function runWebhookDeliveryMaintenanceJob(input: {
  readonly commands: IntegrationMaintenanceCommands
  readonly bodyRetentionDays: number
  readonly rowRetentionDays: number
  readonly cursor?: unknown
  readonly now?: number
}): Promise<MaintenanceJobExecutionResult> {
  const result = await input.commands.gcWebhookDeliveries({
    now: input.now ?? Date.now(),
    retention: {
      bodyRetentionMs: input.bodyRetentionDays * DAY_MS,
      rowRetentionMs: input.rowRetentionDays * DAY_MS,
    },
    cursor: webhookDeliveryCursor(input.cursor),
    batchSize: DB_WRITE_SLICE_ROWS,
  })
  return {
    counters: { ...result.counters },
    delta: NONE,
    ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
  }
}

const NONE: MaintenanceWorkerDelta = { kind: 'none' }
const WORKTREE_GC_PHASES = ['worktree', 'iso', 'scratch', 'orphan', 'partial'] as const
type WorktreeGcPhase = (typeof WORKTREE_GC_PHASES)[number]

function worktreeGcPhase(value: unknown): WorktreeGcPhase {
  if (value === undefined || value === null) return 'worktree'
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !WORKTREE_GC_PHASES.includes((value as { phase?: WorktreeGcPhase }).phase as WorktreeGcPhase)
  ) {
    throw new Error('maintenance-worktree-gc-cursor-invalid')
  }
  return (value as { phase: WorktreeGcPhase }).phase
}

function nextWorktreeGcPhase(phase: WorktreeGcPhase): WorktreeGcPhase | null {
  const index = WORKTREE_GC_PHASES.indexOf(phase)
  return WORKTREE_GC_PHASES[index + 1] ?? null
}

function assertVersionOneCursor(value: unknown, code: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1)
  ) {
    throw new Error(code)
  }
}

export async function runLifecycleInvariantsMaintenanceJob(input: {
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
  const result = await runLifecycleInvariants({
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
  const result = await runStuckTaskDetector({
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

export async function runMaintenanceJob(input: {
  appHome: string
  ownerCommands: {
    readonly workspace: WorkspaceMaintenanceCommand
    readonly developmentAutomation: DevelopmentAutomationMaintenanceCommands
    readonly digitalEmployee: DigitalEmployeeMaintenanceCommands
    readonly intent: IntentMaintenanceCommands
    readonly pluginGenerationGc: {
      readonly command: PluginGenerationGcCommand
      /** Task execution owns the live-node fence; the GC command owns catalog reads. */
      readonly executionFence: () => Promise<'clear' | 'busy'>
    }
    readonly integration: IntegrationMaintenanceCommands
    readonly taskRecovery: TaskRecoveryOperations
    readonly taskArchive: TaskArchiveMaintenanceCommand
    readonly tokenAudit: Pick<TokenCallAuditParticipant, 'pruneSlice'>
    readonly system: MaintenanceSystemOperations
  }
  job: MaintenanceJobKey
  payload: unknown
  cursor?: unknown
}): Promise<MaintenanceJobExecutionResult> {
  const { appHome, job, ownerCommands } = input

  switch (job) {
    case 'worktreeGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const phase = worktreeGcPhase(input.cursor)
      const result = await ownerCommands.workspace.runGcPhase({
        phase,
        activeTaskIds: payload.activeTaskIds,
        worktreeAutoGc: payload.worktreeAutoGc,
        gitCloneTimeoutMs: payload.gitCloneTimeoutMs ?? 0,
        now: Date.now(),
      })
      const nextPhase = nextWorktreeGcPhase(phase)
      return {
        counters: { scanned: result.scanned, removed: result.removed, skipped: result.skipped },
        delta: NONE,
        ...(nextPhase === null
          ? {}
          : {
              continuation: {
                cursor: { version: 1, phase: nextPhase },
                resumeAfterMs: 25,
              },
            }),
      }
    }
    case 'workspaceRecovery': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await ownerCommands.workspace.recover({
        activeTaskIds: payload.activeTaskIds,
        now: Date.now(),
      })
      return {
        counters: { ...result },
        delta: NONE,
      }
    }
    case 'webhookDeliveryGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      return await runWebhookDeliveryMaintenanceJob({
        commands: ownerCommands.integration,
        bodyRetentionDays: payload.bodyRetentionDays,
        rowRetentionDays: payload.rowRetentionDays,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    }
    case 'eventsArchive': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      return await ownerCommands.system.eventsArchive.runSlice({
        thresholds: payload.eventsArchiveThresholds,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    }
    case 'retentionSweep': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      return await ownerCommands.system.retention.runSlice({
        eventStreamRetentionDays: payload.eventStreamRetentionDays,
        webhookTriggerFiresRetentionDays: payload.webhookTriggerFiresRetentionDays,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    }
    case 'taskArchive': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await ownerCommands.taskArchive.runSweep(payload, {
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
    }
    case 'backupPrune': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = pruneBackups({
        dir: join(appHome, 'backups'),
        count: payload.retentionCount,
        days: payload.retentionDays,
        maxTotalBytes: payload.maxTotalBytes,
        protectedKeepCount: payload.protectedKeepCount,
        now: Date.now(),
      })
      return {
        counters: { deleted: result.deleted.length, kept: result.kept.length },
        delta: NONE,
      }
    }
    case 'pluginGenerationGc': {
      parseMaintenanceJobPayload(job, input.payload)
      const pluginGenerationGc = ownerCommands.pluginGenerationGc
      const removed = await runPluginGenerationGc({
        command: pluginGenerationGc.command,
        executionFence: await pluginGenerationGc.executionFence(),
      })
      return { counters: { removed: removed.length }, delta: NONE }
    }
    case 'developmentUploadGc': {
      parseMaintenanceJobPayload(job, input.payload)
      assertVersionOneCursor(input.cursor, 'maintenance-development-upload-cursor-invalid')
      const swept = await ownerCommands.developmentAutomation.sweepExpiredUploads(
        Date.now(),
        DB_WRITE_SLICE_ROWS,
      )
      return {
        counters: { swept },
        delta: NONE,
        ...(swept < DB_WRITE_SLICE_ROWS
          ? {}
          : { continuation: { cursor: { version: 1 }, resumeAfterMs: 25 } }),
      }
    }
    case 'developmentRetentionSweep': {
      parseMaintenanceJobPayload(job, input.payload)
      const result = await ownerCommands.developmentAutomation.sweepRetention(Date.now())
      return { counters: { ...result }, delta: NONE }
    }
    case 'employeeInputGc': {
      parseMaintenanceJobPayload(job, input.payload)
      assertVersionOneCursor(input.cursor, 'maintenance-employee-input-cursor-invalid')
      const swept = await ownerCommands.digitalEmployee.sweepExpiredInputUploads(
        Date.now(),
        DB_WRITE_SLICE_ROWS,
      )
      return {
        counters: { swept },
        delta: NONE,
        ...(swept < DB_WRITE_SLICE_ROWS
          ? {}
          : { continuation: { cursor: { version: 1 }, resumeAfterMs: 25 } }),
      }
    }
    case 'intentScratchGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const { removed } = await ownerCommands.intent.scratch.sweep({
        retentionHours: payload.retentionHours,
      })
      return { counters: { removed }, delta: NONE }
    }
    case 'tokenAuditGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const tokenAudit = ownerCommands.tokenAudit
      const result = await tokenAudit.pruneSlice(payload.retentionDays, input.cursor)
      return {
        counters: result.counters,
        delta: NONE,
        ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
      }
    }
    case 'intentRecovery': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await ownerCommands.intent.recovery.recover({
        recoverTurnIds: payload.recoverTurnIds,
        activeIntentApplyJournalIds: payload.activeIntentApplyJournalIds,
        activeBundleApplyIds: payload.activeBundleApplyIds,
      })
      return {
        counters: {
          failed: result.failed,
          rolledForward: result.rolledForward,
          queuedWorkingSets: result.queuedWorkingSets,
          orphanedTurns: result.orphanedTurns,
        },
        delta: { kind: 'intent-queued', sessionIds: [...result.queuedSessionIds] },
      }
    }
    case 'lifecycleInvariants': {
      return runLifecycleInvariantsMaintenanceJob({
        operations: ownerCommands.taskRecovery,
        payload: input.payload,
      })
    }
    case 'stuckTaskDetector': {
      return runStuckTaskDetectorMaintenanceJob({
        operations: ownerCommands.taskRecovery,
        payload: input.payload,
      })
    }
    case 'walCheckpoint': {
      parseMaintenanceJobPayload(job, input.payload)
      return { counters: await ownerCommands.system.storage.run(), delta: NONE }
    }
    case 'humanGateRecovery': {
      // Historical durable rows may survive an in-place upgrade. The active
      // owner is now collaboration's continuous worker, so an old queued slot
      // settles as a no-op instead of creating a second continuation driver.
      parseMaintenanceJobPayload(job, input.payload)
      return { counters: { retired: 1 }, delta: NONE }
    }
  }
}
