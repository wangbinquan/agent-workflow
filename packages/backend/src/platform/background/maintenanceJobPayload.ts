import {
  EventsArchiveThresholdsSchema,
  type MaintenanceJobKey,
  WorktreeGcSchema,
} from '@agent-workflow/shared'
import { z, type ZodTypeAny } from 'zod'

const EmptySchema = z.object({}).strict()
const ActiveTaskIdsSchema = z.array(z.string()).max(100_000).default([])

export const MAINTENANCE_JOB_PAYLOAD_SCHEMAS = {
  worktreeGc: z
    .object({
      worktreeAutoGc: WorktreeGcSchema,
      gitCloneTimeoutMs: z.number().int().positive().optional(),
      activeTaskIds: ActiveTaskIdsSchema,
    })
    .strict(),
  webhookDeliveryGc: z
    .object({
      bodyRetentionDays: z.number().int().min(1).max(3650),
      rowRetentionDays: z.number().int().min(1).max(3650),
    })
    .strict(),
  eventsArchive: z.object({ eventsArchiveThresholds: EventsArchiveThresholdsSchema }).strict(),
  retentionSweep: z
    .object({
      eventStreamRetentionDays: z.number().int().min(0).max(3650),
      webhookTriggerFiresRetentionDays: z.number().int().min(0).max(3650),
    })
    .strict(),
  taskArchive: z
    .object({
      enabled: z.boolean(),
      retentionDays: z.number().int().min(0).max(3650),
      maxTreesPerSweep: z.number().int().min(1).max(1000),
    })
    .strict(),
  backupPrune: z
    .object({
      retentionCount: z.number().int().positive(),
      retentionDays: z.number().int().positive(),
      maxTotalBytes: z.number().int().nonnegative(),
      protectedKeepCount: z.number().int().nonnegative(),
    })
    .strict(),
  pluginGenerationGc: EmptySchema,
  developmentUploadGc: EmptySchema,
  developmentRetentionSweep: EmptySchema,
  employeeInputGc: EmptySchema,
  intentScratchGc: z.object({ retentionHours: z.number().int().positive() }).strict(),
  tokenAuditGc: z.object({ retentionDays: z.number().int().positive() }).strict(),
  workspaceRecovery: z.object({ activeTaskIds: ActiveTaskIdsSchema }).strict(),
  intentRecovery: z
    .object({
      activeIntentApplyJournalIds: z.array(z.string()).max(100_000).default([]),
      activeBundleApplyIds: z.array(z.string()).max(100_000).default([]),
      recoverTurns: z.boolean().default(false),
    })
    .strict(),
  lifecycleInvariants: z
    .object({
      scope: z.union([
        z.object({ all: z.literal(true) }).strict(),
        z.object({ since: z.number().int().nonnegative() }).strict(),
        z.object({ taskId: z.string() }).strict(),
      ]),
    })
    .strict(),
  stuckTaskDetector: z
    .object({
      stuckThresholdMs: z.number().int().positive().optional(),
      pendingThresholdMs: z.number().int().positive().optional(),
    })
    .strict(),
  humanGateRecovery: EmptySchema,
  walCheckpoint: EmptySchema,
} as const satisfies Record<MaintenanceJobKey, ZodTypeAny>

export type MaintenanceJobPayload<K extends MaintenanceJobKey> = z.infer<
  (typeof MAINTENANCE_JOB_PAYLOAD_SCHEMAS)[K]
>

export function parseMaintenanceJobPayload<K extends MaintenanceJobKey>(
  job: K,
  value: unknown,
): MaintenanceJobPayload<K> {
  return MAINTENANCE_JOB_PAYLOAD_SCHEMAS[job].parse(value) as MaintenanceJobPayload<K>
}
