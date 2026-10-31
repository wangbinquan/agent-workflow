// RFC-399 B1: owner-owned maintenance bodies; slicing and result projection are unchanged.
import type { DevelopmentAutomationMaintenanceCommands } from '../public/commands'
import type { MaintenanceJobHandlers } from '@/platform/contracts/maintenanceJob'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'
import { parseMaintenanceJobPayload } from '@/platform/background/maintenanceJobPayload'

const NONE: MaintenanceWorkerDelta = { kind: 'none' }

const DB_WRITE_SLICE_ROWS = 1_000

function assertVersionOneCursor(value: unknown, code: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1)
  ) {
    throw new Error(code)
  }
}

export function createDevelopmentAutomationMaintenanceJobHandlers(
  commands: DevelopmentAutomationMaintenanceCommands,
): Pick<MaintenanceJobHandlers, 'developmentUploadGc' | 'developmentRetentionSweep'> {
  return {
    async developmentUploadGc(input) {
      parseMaintenanceJobPayload('developmentUploadGc', input.payload)
      assertVersionOneCursor(input.cursor, 'maintenance-development-upload-cursor-invalid')
      const swept = await commands.sweepExpiredUploads(Date.now(), DB_WRITE_SLICE_ROWS)
      return {
        counters: { swept },
        delta: NONE,
        ...(swept < DB_WRITE_SLICE_ROWS
          ? {}
          : { continuation: { cursor: { version: 1 }, resumeAfterMs: 25 } }),
      }
    },
    async developmentRetentionSweep(input) {
      parseMaintenanceJobPayload('developmentRetentionSweep', input.payload)
      const result = await commands.sweepRetention(Date.now())
      return { counters: { ...result }, delta: NONE }
    },
  }
}
