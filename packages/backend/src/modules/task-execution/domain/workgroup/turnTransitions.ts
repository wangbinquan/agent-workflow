// RFC-411 — the workgroup turn engine's assignment and completion-gate transition tables, moved from
// resource-catalog's turn driver. Pure data shared by the turn engine and its persistence adapter (CAS checks).
import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'

export const WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS: Readonly<
  Record<WorkgroupAssignmentStatus, readonly WorkgroupAssignmentStatus[]>
> = {
  open: ['dispatched', 'canceled'],
  dispatched: ['running', 'delivered', 'failed', 'canceled'],
  running: ['done', 'failed', 'awaiting_human', 'canceled', 'dispatched'],
  awaiting_human: ['running', 'failed', 'canceled', 'dispatched', 'open'],
  delivered: ['done', 'canceled'],
  done: [],
  failed: ['open'],
  canceled: [],
}

export type WorkgroupTurnGateStatus =
  | 'idle'
  | 'declared'
  | 'awaiting_confirmation'
  | 'approved'
  | 'rejected'

export const WORKGROUP_TURN_GATE_TRANSITIONS: Readonly<
  Record<WorkgroupTurnGateStatus, readonly WorkgroupTurnGateStatus[]>
> = {
  idle: ['declared'],
  declared: ['awaiting_confirmation'],
  awaiting_confirmation: ['approved', 'rejected'],
  approved: [],
  rejected: ['declared', 'idle'],
}
