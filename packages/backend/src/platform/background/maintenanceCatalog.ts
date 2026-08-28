import type { MaintenanceJobClass, MaintenanceJobKey } from '@agent-workflow/shared'

import { DAEMON_CADENCE, HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { sha256Hex } from '@/util/hash'

export interface MaintenanceJobSpec {
  readonly key: MaintenanceJobKey
  readonly class: MaintenanceJobClass
  /** Heavy cleanup jobs participate in the administrator-selected schedule. */
  readonly schedule: 'heavy' | 'fixed' | 'checkpoint'
  readonly intervalMs?: number
  readonly phaseOffsetMs?: number
  readonly bootDelayMs?: number
}

export const HEAVY_MAINTENANCE_JOB_KEYS = [
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
] as const satisfies readonly MaintenanceJobKey[]

export const FIXED_MAINTENANCE_JOB_SPECS = [
  {
    key: 'workspaceRecovery',
    class: 'recovery',
    schedule: 'fixed',
    intervalMs: HOUR_MS,
    phaseOffsetMs: MAINTENANCE_PHASE.worktreeGc,
  },
  {
    key: 'intentRecovery',
    class: 'recovery',
    schedule: 'fixed',
    intervalMs: HOUR_MS,
    phaseOffsetMs: MAINTENANCE_PHASE.intentScratchGc,
    bootDelayMs: 0,
  },
  {
    key: 'lifecycleInvariants',
    class: 'recovery',
    schedule: 'fixed',
    intervalMs: DAEMON_CADENCE.lifecycleInvariants,
    phaseOffsetMs: MAINTENANCE_PHASE.lifecycleInvariants,
    bootDelayMs: 5_000,
  },
  {
    key: 'stuckTaskDetector',
    class: 'recovery',
    schedule: 'fixed',
    intervalMs: DAEMON_CADENCE.stuckTaskScan,
    // Existing semantics: no boot pass; first scan after one full interval.
    phaseOffsetMs: DAEMON_CADENCE.stuckTaskScan,
  },
  {
    key: 'humanGateRecovery',
    class: 'recovery',
    schedule: 'fixed',
    // Existing semantics are boot-only; the durable continuation remains
    // pending for the normal post-commit wake path after startup.
    bootDelayMs: 0,
  },
] as const satisfies readonly MaintenanceJobSpec[]

export const MAINTENANCE_JOB_CATALOG: readonly MaintenanceJobSpec[] = [
  ...HEAVY_MAINTENANCE_JOB_KEYS.map((key) => ({
    key,
    class: 'cleanup' as const,
    schedule: 'heavy' as const,
    intervalMs: HOUR_MS,
    phaseOffsetMs: MAINTENANCE_PHASE[key],
  })),
  ...FIXED_MAINTENANCE_JOB_SPECS,
  { key: 'walCheckpoint', class: 'checkpoint', schedule: 'checkpoint' },
]

export const MAINTENANCE_CATALOG_DIGEST_SOURCE = MAINTENANCE_JOB_CATALOG.map(
  ({ key, class: jobClass, schedule }) => `${key}:${jobClass}:${schedule}`,
).join('|')
export const MAINTENANCE_CATALOG_DIGEST = sha256Hex(MAINTENANCE_CATALOG_DIGEST_SOURCE)

export function maintenanceJobSpec(key: MaintenanceJobKey): MaintenanceJobSpec {
  const spec = MAINTENANCE_JOB_CATALOG.find((candidate) => candidate.key === key)
  if (spec === undefined) throw new Error(`unknown maintenance job: ${key}`)
  return spec
}
