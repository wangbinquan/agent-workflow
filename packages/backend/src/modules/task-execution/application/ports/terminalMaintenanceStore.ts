import type { TerminalMaintenanceClaim, TerminalMaintenanceOperation } from '../../domain/ownership'
import type {
  MaintenanceMemberSnapshot,
  TerminalMaintenanceState,
} from '../../domain/terminalMaintenance'

export interface RecoverableTerminalMaintenanceClaim {
  readonly claim: TerminalMaintenanceClaim
  readonly rootTaskId: string
  readonly state:
    | 'claimed'
    | 'io-complete'
    | 'db-finalized'
    | 'cleanup-pending'
    | 'recovery-required'
  readonly cleanupPlanJson: string
  readonly members: readonly MaintenanceMemberSnapshot[]
}

/** Promise-shaped CAS/lease boundary for destructive terminal maintenance. */
export interface TerminalMaintenanceStore {
  snapshotMembers(taskIds: readonly string[]): Promise<readonly MaintenanceMemberSnapshot[]>
  snapshotTree(rootTaskId: string): Promise<readonly MaintenanceMemberSnapshot[]>
  claim(input: {
    readonly rootTaskId: string
    readonly operation: TerminalMaintenanceOperation
    readonly members: readonly MaintenanceMemberSnapshot[]
    readonly cleanupPlanJson: string
    readonly now?: number
  }): Promise<TerminalMaintenanceClaim>
  transition(input: {
    readonly claim: TerminalMaintenanceClaim
    readonly to: TerminalMaintenanceState
    readonly now?: number
    readonly releaseMembers?: boolean
  }): Promise<TerminalMaintenanceClaim>
  complete(input: {
    readonly claim: TerminalMaintenanceClaim
    readonly now?: number
  }): Promise<void>
  listRecoverable(input: {
    readonly operation?: TerminalMaintenanceOperation
    readonly rootTaskId?: string
  }): Promise<readonly RecoverableTerminalMaintenanceClaim[]>
}
