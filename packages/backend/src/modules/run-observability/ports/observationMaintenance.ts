import type { Actor } from '@/auth/actor'
import type {
  ObservationMaintenanceRequest,
  ObservationMaintenanceOperation,
  ObservationMaintenanceConfirm,
} from '@agent-workflow/shared'
export interface ObservationMaintenanceCommands {
  prepare(
    actor: Actor,
    request: ObservationMaintenanceRequest,
  ): Promise<ObservationMaintenanceOperation>
  status(actor: Actor, id: string): Promise<ObservationMaintenanceOperation>
  confirm(
    actor: Actor,
    id: string,
    confirmation: ObservationMaintenanceConfirm,
  ): Promise<ObservationMaintenanceOperation>
}
