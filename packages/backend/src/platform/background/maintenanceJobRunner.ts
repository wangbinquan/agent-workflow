// RFC-399 B1: neutral dispatch; job bodies and their dependencies belong to their owners.
import type { MaintenanceJobKey } from '@agent-workflow/shared'
import type {
  MaintenanceJobExecutionResult,
  MaintenanceJobHandlerInput,
  MaintenanceJobHandlers,
} from '@/platform/contracts/maintenanceJob'
import { parseMaintenanceJobPayload } from './maintenanceJobPayload'

export async function runMaintenanceJob(
  input: MaintenanceJobHandlerInput & {
    readonly handlers: MaintenanceJobHandlers
    readonly job: MaintenanceJobKey
  },
): Promise<MaintenanceJobExecutionResult> {
  if (input.job === 'humanGateRecovery') {
    // Historical durable rows may survive an in-place upgrade. The active
    // owner is now collaboration's continuous worker, so an old queued slot
    // settles as a no-op instead of creating a second continuation driver.
    parseMaintenanceJobPayload('humanGateRecovery', input.payload)
    return { counters: { retired: 1 }, delta: { kind: 'none' } }
  }
  const handler = input.handlers[input.job]
  return await handler(input)
}
