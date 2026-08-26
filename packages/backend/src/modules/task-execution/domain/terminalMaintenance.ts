// RFC-328 — pure terminal-maintenance membership and state rules.

import { sha256Hex } from './digest'
import { canonicalJson } from './executionIntent'
import type { TerminalMaintenanceOperation } from './ownership'

export const TERMINAL_MAINTENANCE_STATES = [
  'claimed',
  'io-complete',
  'db-finalized',
  'cleanup-pending',
  'completed',
  'recovery-required',
] as const
export type TerminalMaintenanceState = (typeof TERMINAL_MAINTENANCE_STATES)[number]

export interface MaintenanceMemberSnapshot {
  readonly taskId: string
  readonly taskRevision: number
  readonly ownerRevision: number | null
  readonly topologyRevision: number
  readonly ledgerDigest: string
}

export function maintenanceMemberSetDigest(
  operation: TerminalMaintenanceOperation,
  members: readonly MaintenanceMemberSnapshot[],
): string {
  if (members.length === 0) throw new Error('maintenance claim requires at least one member')
  const sorted = [...members].sort((a, b) => a.taskId.localeCompare(b.taskId))
  if (new Set(sorted.map((member) => member.taskId)).size !== sorted.length) {
    throw new Error('duplicate-maintenance-member')
  }
  return sha256Hex(canonicalJson({ operation, members: sorted }))
}

export function assertMaintenanceTransition(
  from: TerminalMaintenanceState,
  to: TerminalMaintenanceState,
): void {
  const allowed: Readonly<Record<TerminalMaintenanceState, readonly TerminalMaintenanceState[]>> = {
    claimed: ['io-complete', 'recovery-required'],
    'io-complete': ['db-finalized', 'cleanup-pending', 'recovery-required'],
    'db-finalized': ['cleanup-pending', 'completed', 'recovery-required'],
    'cleanup-pending': ['completed', 'recovery-required'],
    'recovery-required': ['claimed', 'io-complete', 'db-finalized', 'cleanup-pending'],
    completed: [],
  }
  if (!allowed[from].includes(to)) {
    throw new Error(`illegal-maintenance-transition:${from}->${to}`)
  }
}
