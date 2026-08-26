import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type {
  MaintenanceMemberSnapshot,
  TerminalMaintenanceState,
} from '../../domain/terminalMaintenance'
import type { TerminalMaintenanceClaim, TerminalMaintenanceOperation } from '../../domain/ownership'

export interface TerminalMaintenanceStore {
  snapshotMembers(db: DbClient, taskIds: readonly string[]): readonly MaintenanceMemberSnapshot[]
  snapshotTree(db: DbClient, rootTaskId: string): readonly MaintenanceMemberSnapshot[]
  claim(input: {
    db: DbClient
    rootTaskId: string
    operation: TerminalMaintenanceOperation
    members: readonly MaintenanceMemberSnapshot[]
    cleanupPlanJson: string
    now?: number
  }): TerminalMaintenanceClaim
  assertClaimTx(input: {
    tx: DbTxSync
    claim: TerminalMaintenanceClaim
    expectedState: TerminalMaintenanceState
  }): void
  transition(input: {
    db: DbClient
    claim: TerminalMaintenanceClaim
    to: TerminalMaintenanceState
    now?: number
    releaseMembers?: boolean
  }): TerminalMaintenanceClaim
  transitionTx(input: {
    tx: DbTxSync
    claim: TerminalMaintenanceClaim
    to: TerminalMaintenanceState
    now: number
    releaseMembers?: boolean
  }): TerminalMaintenanceClaim
  complete(input: { db: DbClient; claim: TerminalMaintenanceClaim; now?: number }): void
  listRecoverable(input: {
    db: DbClient
    operation?: TerminalMaintenanceOperation
    rootTaskId?: string
  }): readonly RecoverableTerminalMaintenanceClaim[]
}

export interface RecoverableTerminalMaintenanceClaim {
  readonly claim: TerminalMaintenanceClaim
  readonly rootTaskId: string
  readonly state: Exclude<TerminalMaintenanceState, 'completed'>
  readonly cleanupPlanJson: string
  readonly members: readonly MaintenanceMemberSnapshot[]
}
