import type { MaintenanceJobKey } from '@agent-workflow/shared'
import { and, count, gt, lte, sql } from 'drizzle-orm'
import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import { nodeRunEvents } from '@/db/schema'
import type { DevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/public/commands'
import type { DigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/public/commands'
import { checkpointWal, pruneBackups } from '@/services/backupScheduler'
import { convergeResourceBundleApplies } from '@/services/bundle/apply'
import { archiveEvents } from '@/services/eventsArchive'
import {
  recoverInterruptedWorkspaceGc,
  runClaimedWebhookWorkspacePrunes,
  runIsoWorktreeGc,
  runPartialCloneGc,
  runScratchOrphanGc,
  runWorktreeGc,
  runWorktreeOrphanGc,
} from '@/services/gc'
import { convergeIntentApplyJournal } from '@/services/intent/applyChangeset'
import { listQueuedIntentWorkingSetSessionIds } from '@/services/intent/dispatcher'
import { recoverIntentTurnsOnBoot, sweepIntentScratch } from '@/services/intent/maintenance'
import { runLifecycleInvariants } from '@/services/lifecycleInvariants'
import { runRetentionSweepSlice } from '@/services/maintenanceRetention'
import { runPluginGenerationGc } from '@/services/pluginGenerationGc'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import { runTaskArchiveSweep } from '@/services/taskArchive'
import { pruneTokenAuditSlice } from '@/services/tokenAudit'
import { runDeliveryGcSlice } from '@/services/webhook/webhookGc'
import { createLogger } from '@/util/log'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'
import type { MaintenanceWorkerDelta } from './maintenanceProtocol'

const log = createLogger('maintenance-worker')
const DB_WRITE_SLICE_ROWS = 1_000
// Keep the mixed FS/SQLite archive body inside the RFC-338 wall budget on the
// 4.5GB / 100-client tier. A 5k slice held the Worker hot for up to 2.23s and
// produced 516ms statement outliers even though the durable cursor and the
// foreground loop stayed healthy. The smaller slice preserves exact progress
// and backlog semantics while yielding to the queue/cooldown five times as
// often; no rows, jobs, or archive capabilities are skipped.
const EVENT_ARCHIVE_SLICE_ROWS = 1_000
/** One short primary-key range COUNT per Worker slice at large event scale. */
const EVENT_ARCHIVE_COUNT_WINDOW_IDS = 250_000

interface EventArchiveCountCursorV1 {
  readonly version: 1
  readonly phase: 'count'
  readonly maxId: number
  readonly scanFrom: number
  readonly totalRows: number
}

interface EventArchiveRunCursorV1 {
  readonly version: 1
  readonly phase: 'archive'
  readonly remainingRows: number
}

type EventArchiveCursorV1 = EventArchiveCountCursorV1 | EventArchiveRunCursorV1

function eventArchiveCursor(value: unknown): EventArchiveCursorV1 | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null) {
    throw new Error('maintenance-events-archive-cursor-invalid')
  }
  const cursor = value as Partial<EventArchiveCursorV1>
  // A pre-RFC-338 continuation was only `{ version: 1 }`. Restarting the
  // bounded count is safe and lets an in-flight deployment upgrade in place.
  if (cursor.version === 1 && cursor.phase === undefined) return null
  if (
    cursor.version !== 1 ||
    (cursor.phase !== 'count' && cursor.phase !== 'archive') ||
    (cursor.phase === 'count' &&
      (!Number.isSafeInteger(cursor.maxId) ||
        cursor.maxId! < 0 ||
        !Number.isSafeInteger(cursor.scanFrom) ||
        cursor.scanFrom! < 0 ||
        cursor.scanFrom! > cursor.maxId! ||
        !Number.isSafeInteger(cursor.totalRows) ||
        cursor.totalRows! < 0)) ||
    (cursor.phase === 'archive' &&
      (!Number.isSafeInteger(cursor.remainingRows) || cursor.remainingRows! < 0))
  ) {
    throw new Error('maintenance-events-archive-cursor-invalid')
  }
  return cursor as EventArchiveCursorV1
}

async function countEventArchiveRows(
  db: DbClient,
  cursor: EventArchiveCountCursorV1 | null,
): Promise<
  | { readonly done: true; readonly totalRows: number }
  | {
      readonly done: false
      readonly cursor: EventArchiveCountCursorV1
      readonly countedRows: number
    }
> {
  const maxId =
    cursor?.maxId ??
    (
      await db.select({ value: sql<number | null>`max(${nodeRunEvents.id})` }).from(nodeRunEvents)
    )[0]?.value ??
    0
  const scanFrom = cursor?.scanFrom ?? 0
  const priorRows = cursor?.totalRows ?? 0
  if (scanFrom >= maxId) return { done: true, totalRows: priorRows }

  const scanTo = Math.min(maxId, scanFrom + EVENT_ARCHIVE_COUNT_WINDOW_IDS)
  const rows = await db
    .select({ value: count(nodeRunEvents.id) })
    .from(nodeRunEvents)
    .where(and(gt(nodeRunEvents.id, scanFrom), lte(nodeRunEvents.id, scanTo)))
  const countedRows = rows[0]?.value ?? 0
  const totalRows = priorRows + countedRows
  if (scanTo >= maxId) return { done: true, totalRows }
  return {
    done: false,
    countedRows,
    cursor: { version: 1, phase: 'count', maxId, scanFrom: scanTo, totalRows },
  }
}

export interface MaintenanceJobExecutionResult {
  readonly counters: Readonly<Record<string, number>>
  readonly delta: MaintenanceWorkerDelta
  readonly continuation?: {
    readonly cursor: object
    readonly resumeAfterMs: number
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

function activePredicate(ids: readonly string[]): (taskId: string) => boolean {
  const active = new Set(ids)
  return (taskId) => active.has(taskId)
}

function assertVersionOneCursor(value: unknown, code: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1)
  ) {
    throw new Error(code)
  }
}

export async function runMaintenanceJob(input: {
  db: DbClient
  appHome: string
  ownerCommands: {
    readonly developmentAutomation: DevelopmentAutomationMaintenanceCommands
    readonly digitalEmployee: DigitalEmployeeMaintenanceCommands
  }
  job: MaintenanceJobKey
  payload: unknown
  cursor?: unknown
}): Promise<MaintenanceJobExecutionResult> {
  const { db, appHome, job, ownerCommands } = input

  switch (job) {
    case 'worktreeGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const isTaskActive = activePredicate(payload.activeTaskIds)
      const phase = worktreeGcPhase(input.cursor)
      let counters: Record<string, number>
      if (phase === 'worktree') {
        const result = await runWorktreeGc(db, payload, Date.now(), isTaskActive)
        counters = {
          scanned: result.scanned,
          removed: result.removed.length,
          skipped: result.skipped,
        }
      } else if (phase === 'iso') {
        const result = await runIsoWorktreeGc(db, appHome, isTaskActive)
        counters = { scanned: result.scanned, removed: result.removed.length }
      } else if (phase === 'scratch') {
        const result = await runScratchOrphanGc(db, appHome)
        counters = { scanned: result.scanned, removed: result.removed.length }
      } else if (phase === 'orphan') {
        const result = await runWorktreeOrphanGc(db, appHome)
        counters = { scanned: result.scanned, removed: result.removed.length }
      } else {
        const result = await runPartialCloneGc(appHome, Date.now(), payload.gitCloneTimeoutMs)
        counters = { scanned: result.scanned, removed: result.removed.length }
      }
      const nextPhase = nextWorktreeGcPhase(phase)
      return {
        counters,
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
      const isTaskActive = activePredicate(payload.activeTaskIds)
      const interrupted = await recoverInterruptedWorkspaceGc(db)
      const webhook = await runClaimedWebhookWorkspacePrunes(db, {
        isTaskActive,
        staleOnly: true,
      })
      return {
        counters: {
          completed: interrupted.completed.length + webhook.removed.length,
          failed: interrupted.failed.length + webhook.failed.length,
          skipped: interrupted.skipped + webhook.skipped,
        },
        delta: NONE,
      }
    }
    case 'webhookDeliveryGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await runDeliveryGcSlice(
        db,
        {
          webhookDeliveryBodyRetentionDays: payload.bodyRetentionDays,
          webhookDeliveryRowRetentionDays: payload.rowRetentionDays,
        },
        input.cursor,
        DB_WRITE_SLICE_ROWS,
      )
      return {
        counters: { ...result.counters },
        delta: NONE,
        ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
      }
    }
    case 'eventsArchive': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const cursor = eventArchiveCursor(input.cursor)
      let knownGlobalRows: number
      if (cursor?.phase === 'archive') {
        knownGlobalRows = cursor.remainingRows
      } else {
        const counted = await countEventArchiveRows(db, cursor)
        if (!counted.done) {
          return {
            counters: { countedRows: counted.countedRows },
            delta: NONE,
            continuation: { cursor: counted.cursor, resumeAfterMs: 25 },
          }
        }
        knownGlobalRows = counted.totalRows
      }
      const result = await archiveEvents(db, payload, join(appHome, 'logs'), {
        rowBudgetRows: EVENT_ARCHIVE_SLICE_ROWS,
        knownGlobalRows,
      })
      const archived = result.perGroupArchived + result.globalArchived
      return {
        counters: {
          perGroupArchived: result.perGroupArchived,
          globalArchived: result.globalArchived,
          files: result.files.length,
        },
        delta: NONE,
        ...(archived < EVENT_ARCHIVE_SLICE_ROWS
          ? {}
          : {
              continuation: {
                cursor: {
                  version: 1,
                  phase: 'archive',
                  remainingRows: result.remainingRows,
                },
                resumeAfterMs: 25,
              },
            }),
      }
    }
    case 'retentionSweep': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await runRetentionSweepSlice(
        db,
        payload,
        input.cursor,
        Date.now(),
        DB_WRITE_SLICE_ROWS,
      )
      return {
        counters: { ...result.counters },
        delta: NONE,
        ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
      }
    }
    case 'taskArchive': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await runTaskArchiveSweep(db, payload, {
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
      const removed = await runPluginGenerationGc({
        db,
        pluginsDir: join(appHome, 'plugins'),
      })
      return { counters: { removed: removed.length }, delta: NONE }
    }
    case 'developmentUploadGc': {
      parseMaintenanceJobPayload(job, input.payload)
      assertVersionOneCursor(input.cursor, 'maintenance-development-upload-cursor-invalid')
      const swept = ownerCommands.developmentAutomation.sweepExpiredUploads(
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
      const swept = ownerCommands.digitalEmployee.sweepExpiredInputUploads(
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
      const removed = sweepIntentScratch(db, appHome, payload.retentionHours, log)
      return { counters: { removed }, delta: NONE }
    }
    case 'tokenAuditGc': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const result = await pruneTokenAuditSlice(db, payload.retentionDays, input.cursor)
      return {
        counters: result.counters,
        delta: NONE,
        ...(result.done ? {} : { continuation: { cursor: result.cursor, resumeAfterMs: 25 } }),
      }
    }
    case 'intentRecovery': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const orphanedTurns = recoverIntentTurnsOnBoot(db, log, payload.recoverTurnIds)
      const intent = await convergeIntentApplyJournal(db, appHome, log, {
        activeJournalIds: payload.activeIntentApplyJournalIds,
      })
      const bundles = await convergeResourceBundleApplies(db, appHome, log, {
        activeApplyIds: payload.activeBundleApplyIds,
      })
      const sessionIds = listQueuedIntentWorkingSetSessionIds(db)
      return {
        counters: {
          failed: intent.failed + bundles.failed,
          rolledForward: intent.rolledForward + bundles.rolledForward,
          queuedWorkingSets: sessionIds.length,
          orphanedTurns,
        },
        delta: { kind: 'intent-queued', sessionIds },
      }
    }
    case 'lifecycleInvariants': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const alerts: Array<{
        taskId: string
        rule: string
        severity: 'warning' | 'error'
        transition: 'new' | 'promoted'
      }> = []
      const resolvedTaskIds: string[] = []
      const result = await runLifecycleInvariants({
        db,
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
    case 'stuckTaskDetector': {
      const payload = parseMaintenanceJobPayload(job, input.payload)
      const alerts: Array<{
        taskId: string
        rule: string
        severity: 'warning' | 'error'
        transition: 'new' | 'promoted'
      }> = []
      const resolvedTaskIds: string[] = []
      const result = await runStuckTaskDetector({
        db,
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
    case 'walCheckpoint': {
      parseMaintenanceJobPayload(job, input.payload)
      checkpointWal(db)
      return { counters: { checkpointed: 1 }, delta: NONE }
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
