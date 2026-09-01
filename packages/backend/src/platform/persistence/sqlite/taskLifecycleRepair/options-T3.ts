// RFC-057 — T3 SQLite repair options.
//
// T3 invariant: `task.status='done'` but at least one output-kind node
// has no done node_run. Means the task was marked done prematurely before
// the output node closed. Two opposite resolutions:
//
//   - T3.demote-task        — flip task to interrupted + resume so the
//     scheduler picks up the missing output node and completes it.
//   - T3.mark-task-failed   — accept reality; task → failed.

import { setTaskStatus } from '@/services/lifecycle'

import { schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const T3_DEMOTE_TASK: RepairOptionDef = {
  id: 'T3.demote-task',
  rule: 'T3',
  labelKey: 'diagnose.repair.T3.demoteTask.label',
  descriptionKey: 'diagnose.repair.T3.demoteTask.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'done') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T3.unavailable.taskNotDone',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', finished_at=NULL, error_summary='manual-repair-T3' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — scheduler picks up missing output node`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write — `done` is terminal, so T3 is one of the four
    // allowTerminal holders (design §1; the repo's only terminal→terminal
    // rewrites). Explicit finishedAt:null rides the extra whitelist. A lost
    // race surfaces as repair-preflight-stale via the engine's apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'interrupted',
      allowedFrom: ['done'],
      allowTerminal: true,
      extra: {
        finishedAt: null,
        errorSummary: 'manual-repair-T3',
        errorMessage: `RFC-057 repair T3.demote-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'T3.demote-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const T3_MARK_FAILED: RepairOptionDef = {
  id: 'T3.mark-task-failed',
  rule: 'T3',
  labelKey: 'diagnose.repair.T3.markTaskFailed.label',
  descriptionKey: 'diagnose.repair.T3.markTaskFailed.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'done') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T3.unavailable.taskNotDone',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='failed', error_summary='manual-repair-T3' WHERE id='${rc.task.id}'`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write — done→failed, allowTerminal holder (see demote-task
    // above). A lost race surfaces as repair-preflight-stale via the engine's
    // apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'failed',
      allowedFrom: ['done'],
      allowTerminal: true,
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-T3',
        errorMessage: `RFC-057 repair T3.mark-task-failed via alert ${rc.alert.id}`,
      },
      reason: 'T3.mark-task-failed',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'failed' } },
    }
  },
}

export const T3_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  T3_DEMOTE_TASK,
  T3_MARK_FAILED,
]
