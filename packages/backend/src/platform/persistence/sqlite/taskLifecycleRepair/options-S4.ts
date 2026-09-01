// RFC-057 — S4 SQLite repair options.
//
// S4: task.status='pending' for longer than the threshold. The scheduler
// should have picked it up in milliseconds; if it hasn't, something is
// wrong (daemon restart leaving the task uncatched, or the scheduler kick
// got dropped).
//
//   - S4.kick-task    — flip task to interrupted briefly then resumeTask
//     to force a fresh scheduler kick. (resumeTask requires non-pending,
//     non-running status, so we go via interrupted.)
//   - S4.cancel-task  — give up; task → canceled. Worktree preserved.

import { setTaskStatus } from '@/services/lifecycle'

import { schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const S4_KICK_TASK: RepairOptionDef = {
  id: 'S4.kick-task',
  rule: 'S4',
  labelKey: 'diagnose.repair.S4.kickTask.label',
  descriptionKey: 'diagnose.repair.S4.kickTask.desc',
  risk: 'low',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  // RFC-108 T13 (AR-07): the v1 auto-apply starter — kicking a pending task the
  // scheduler missed is a pure reversible re-poke (its only alternative,
  // S4.cancel-task, is high/destructive), so it is unambiguously safe to
  // auto-apply behind the loop's lease+grace+breaker (decision D5).
  autoApplyEligible: true,
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'pending') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S4.unavailable.taskNotPending',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S4' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — forces a fresh scheduler kick.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write — pending→interrupted is the manual-kick escape
    // transition (design §2 row 22). A lost race surfaces as
    // repair-preflight-stale via the engine's apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'interrupted',
      allowedFrom: ['pending'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S4',
        errorMessage: `RFC-057 repair S4.kick-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'S4.kick-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const S4_CANCEL_TASK: RepairOptionDef = {
  id: 'S4.cancel-task',
  rule: 'S4',
  labelKey: 'diagnose.repair.S4.cancelTask.label',
  descriptionKey: 'diagnose.repair.S4.cancelTask.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'pending') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S4.unavailable.taskNotPending',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='canceled', error_summary='manual-repair-S4' WHERE id='${rc.task.id}'`,
        `Worktree preserved.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write mirroring the preflight status gate. A lost race
    // surfaces as repair-preflight-stale via the engine's apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'canceled',
      allowedFrom: ['pending'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S4',
        errorMessage: `RFC-057 repair S4.cancel-task via alert ${rc.alert.id}`,
      },
      reason: 'S4.cancel-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'canceled' } },
    }
  },
}

export const S4_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  S4_KICK_TASK,
  S4_CANCEL_TASK,
]
