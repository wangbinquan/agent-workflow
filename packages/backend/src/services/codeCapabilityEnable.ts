// RFC-304 §3.1 — switching a capability on or off for a repository.
//
// One call, two writes: the matrix cell (what the user configured) and the
// webhook trigger that makes it actually happen. They are done together on
// purpose — a cell without its trigger is a capability that shows `ready` and
// never fires, which is the exact failure this RFC keeps circling back to.
//
// The layering is why this lives in `services/` rather than in the module:
// `modules/code-capability/infrastructure` owns the cell, `services/webhook`
// owns triggers, and a module may not reach sideways into another context's
// tables. This is the composition point that is allowed to know both.

import type { DbClient } from '@/db/client'
import {
  disableCapabilityCell,
  upsertCapabilityCell,
  type CapabilityCell,
  type UpsertCellInput,
} from '@/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { retractCapabilityTrigger, syncCapabilityTrigger } from '@/services/codeCapabilityTrigger'

export interface EnableCapabilityInput extends UpsertCellInput {
  db: DbClient
  /** The endpoint whose deliveries wake this capability. */
  endpointId: string
  /** Fires launch as this user, matching every other trigger. */
  ownerUserId: string
}

export interface EnableCapabilityResult {
  cell: CapabilityCell
  triggerId: string | null
  /** Why no trigger was written, when none was. */
  triggerSkipped: string | null
}

/**
 * Turn a capability on for a repository.
 *
 * The trigger is written only when the cell comes out `ready`. A misconfigured
 * cell that still had a live trigger would fire rounds that fail at some later
 * stage, on the MR, in front of the author — the same reason `wantsCapability`
 * demands `ready` rather than `enabled`.
 */
export async function enableCapability(
  input: EnableCapabilityInput,
): Promise<EnableCapabilityResult> {
  const { db, endpointId, ownerUserId, ...cellInput } = input
  const cell = await upsertCapabilityCell(db, cellInput)

  if (cell.readiness !== 'ready') {
    // Retract any trigger from a previous ready state: a cell that has just
    // become misconfigured must stop firing, not keep firing with stale config.
    await retractCapabilityTrigger(db, {
      endpointId,
      repoId: cellInput.repoId,
      capability: cellInput.capability,
    })
    return {
      cell,
      triggerId: null,
      triggerSkipped: `the cell is ${cell.readiness}, so no trigger was armed — ${cell.readinessIssues
        .map((i) => i.detail)
        .join('; ')}`,
    }
  }

  const events = Array.isArray(cellInput.triggerConfig?.events)
    ? (cellInput.triggerConfig.events as unknown[]).filter(
        (e): e is string => typeof e === 'string',
      )
    : undefined

  const { triggerId } = await syncCapabilityTrigger({
    db,
    endpointId,
    repoId: cellInput.repoId,
    capability: cellInput.capability,
    ownerUserId,
    ...(events !== undefined ? { events } : {}),
    now: cellInput.now,
  })
  return { cell, triggerId, triggerSkipped: null }
}

/**
 * Turn a capability off.
 *
 * Retracts the trigger first: if the cell write failed afterwards the worst
 * case is a capability that stopped early, which is recoverable by re-enabling.
 * The other order risks a live trigger with a disabled cell — rounds firing for
 * something the matrix says is off.
 */
export async function disableCapability(input: {
  db: DbClient
  endpointId: string
  repoId: string
  capability: string
  now: number
}): Promise<{ cell: CapabilityCell | null; triggerRetracted: boolean }> {
  const triggerRetracted = await retractCapabilityTrigger(input.db, {
    endpointId: input.endpointId,
    repoId: input.repoId,
    capability: input.capability,
  })
  const cell = await disableCapabilityCell(input.db, input.repoId, input.capability, input.now)
  return { cell, triggerRetracted }
}
