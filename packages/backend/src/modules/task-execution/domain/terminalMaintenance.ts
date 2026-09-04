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

export interface SettledEffectCoverageProbe {
  readonly operationGeneration: number
  readonly requestHash: string
  readonly slotPathDigest: string
}

export interface RetainedGenerationWatermark {
  readonly highestSettledGeneration: number | null
  readonly requestHash: string
  readonly slotPathDigest: string
}

/**
 * Does the retained ledger still cover this settled effect once the task's own
 * rows are gone?
 *
 * A generation watermark is a per-family HIGH-WATER MARK: exactly one row per
 * (execution_lineage_id, operation_family_key), carrying the digests of the
 * highest settled generation only. Both writers scope digest equality to that
 * generation (`settleTx` / recovery `upsertWatermark`, SQLite and PostgreSQL
 * alike), so coverage of an OLDER generation is the generation bound alone —
 * demanding digest equality there would permanently refuse terminal maintenance
 * for any family that legitimately re-ran with a different request.
 */
export function retainedWatermarkCoversSettledEffect(
  effect: SettledEffectCoverageProbe,
  watermark: RetainedGenerationWatermark | undefined,
): boolean {
  if (watermark === undefined) return false
  const highest = watermark.highestSettledGeneration ?? -1
  if (highest < effect.operationGeneration) return false
  if (highest > effect.operationGeneration) return true
  return (
    watermark.requestHash === effect.requestHash &&
    watermark.slotPathDigest === effect.slotPathDigest
  )
}
