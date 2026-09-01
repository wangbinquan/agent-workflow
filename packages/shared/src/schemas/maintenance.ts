// RFC-338 — maintenance scheduling and status contracts shared by the daemon
// and Settings. Heavy cleanup can keep the historical hourly cadence or run
// once at an explicit IANA wall-clock time. Correctness/recovery jobs do not
// consume this schedule.

import { z } from 'zod'
import { isValidIanaTz } from '../scheduleTime'

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const MaintenanceScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly') }),
  z.object({
    kind: z.literal('daily'),
    at: z.string().regex(HHMM_RE, 'invalid-time'),
    timezone: z.string().min(1).refine(isValidIanaTz, { message: 'invalid-timezone' }),
  }),
])
export type MaintenanceSchedule = z.infer<typeof MaintenanceScheduleSchema>

export const MAINTENANCE_JOB_KEYS = [
  'worktreeGc',
  'webhookDeliveryGc',
  'eventsArchive',
  'retentionSweep',
  'taskArchive',
  'backupPrune',
  'pluginGenerationGc',
  'developmentUploadGc',
  'developmentRetentionSweep',
  'employeeInputGc',
  'intentScratchGc',
  'tokenAuditGc',
  'workspaceRecovery',
  'intentRecovery',
  'lifecycleInvariants',
  'stuckTaskDetector',
  'humanGateRecovery',
  'walCheckpoint',
] as const

export const MaintenanceJobKeySchema = z.enum(MAINTENANCE_JOB_KEYS)
export type MaintenanceJobKey = z.infer<typeof MaintenanceJobKeySchema>

export const MaintenanceJobClassSchema = z.enum(['cleanup', 'recovery', 'checkpoint'])
export type MaintenanceJobClass = z.infer<typeof MaintenanceJobClassSchema>

export const MaintenanceWorkerStateSchema = z.enum(['starting', 'ready', 'degraded', 'stopped'])
export type MaintenanceWorkerState = z.infer<typeof MaintenanceWorkerStateSchema>

const MaintenanceCountersSchema = z.record(z.string(), z.number().finite())

export const DatabaseRuntimeTelemetrySchema = z.object({
  version: z.literal(1),
  provider: z.enum(['sqlite', 'postgresql']),
  poolWait: z
    .object({
      windowMs: z.number().int().positive(),
      sampleCount: z.number().int().nonnegative(),
      acquiredCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      p50Ms: z.number().finite().nonnegative(),
      p95Ms: z.number().finite().nonnegative(),
      maxMs: z.number().finite().nonnegative(),
    })
    .nullable(),
})
export type DatabaseRuntimeTelemetry = z.infer<typeof DatabaseRuntimeTelemetrySchema>

export const MaintenanceStatusSchema = z.object({
  version: z.literal(1),
  worker: z.object({
    state: MaintenanceWorkerStateSchema,
    lastHeartbeatAt: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(),
  }),
  /** Rolling main-thread timer gap; optional for older embedders. */
  eventLoop: z
    .object({
      samplePeriodMs: z.number().int().positive(),
      windowMs: z.number().int().positive(),
      sampleCount: z.number().int().nonnegative(),
      maxGapMs: z.number().finite().nonnegative(),
    })
    .optional(),
  /** Provider mechanism telemetry; optional for older embedded callers. */
  database: DatabaseRuntimeTelemetrySchema.optional(),
  schedule: MaintenanceScheduleSchema,
  nextRunAt: z.number().int().nonnegative().nullable(),
  active: z
    .object({
      runId: z.string(),
      cycleKey: z.string().nullable(),
      job: MaintenanceJobKeySchema,
      startedAt: z.number().int().nonnegative(),
      counters: MaintenanceCountersSchema,
    })
    .nullable(),
  last: z
    .object({
      runId: z.string(),
      job: MaintenanceJobKeySchema,
      outcome: z.enum(['succeeded', 'failed', 'deferred']),
      finishedAt: z.number().int().nonnegative(),
      counters: MaintenanceCountersSchema,
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .nullable(),
  backlog: z.array(
    z.object({
      runId: z.string(),
      job: MaintenanceJobKeySchema,
      state: z.enum(['pending', 'deferred', 'failed']),
      since: z.number().int().nonnegative(),
    }),
  ),
})
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>
