import type { MaintenanceJobKey } from '@agent-workflow/shared'
import type { MaintenanceWorkerDelta } from '@/platform/background/maintenanceProtocol'

export interface MaintenanceJobExecutionResult {
  readonly counters: Readonly<Record<string, number>>
  readonly delta: MaintenanceWorkerDelta
  readonly continuation?: {
    readonly cursor: object
    readonly resumeAfterMs: number
  }
}

export interface MaintenanceJobHandlerInput {
  readonly appHome: string
  readonly payload: unknown
  readonly cursor?: unknown
}

export type MaintenanceJobHandler = (
  input: MaintenanceJobHandlerInput,
) => Promise<MaintenanceJobExecutionResult>

/** The historical human-gate slot is settled by the neutral dispatcher itself. */
export type MaintenanceJobHandlers = Readonly<
  Record<Exclude<MaintenanceJobKey, 'humanGateRecovery'>, MaintenanceJobHandler>
>
