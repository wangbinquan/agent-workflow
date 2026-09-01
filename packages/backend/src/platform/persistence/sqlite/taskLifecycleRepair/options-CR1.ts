// RFC-057 — CR-1 SQLite repair options.
//
// CR-1 invariant: cross_clarify_session status='answered' + directive='continue'
// + parent task FAILED + no consuming designer node_run. lifecycleInvariants
// auto-upgrades the session to 'abandoned' in-place when it detects this,
// so by the time the operator clicks Repair the alert is effectively a
// breadcrumb. Two options:
//
//   - CR-1.acknowledge          — pure UI ack; no DB change beyond the
//     engine's standard alert.resolvedAt stamp + audit row. The auto-
//     upgrade already happened during the scan; clicking this is the
//     operator saying "I saw it, move on."
//   - CR-1.retry-designer-rerun — task is still recoverable (typical
//     "failed task with feedback the designer never consumed"): demote
//     task to interrupted + resume. The cross-clarify session has been
//     auto-upgraded to abandoned; scheduler's freshness invariant
//     (RFC-056 §5.4) will pick up downstream cascade if appropriate.

import { setTaskStatus } from '@/services/lifecycle'

import { schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const CR1_ACKNOWLEDGE: RepairOptionDef = {
  id: 'CR-1.acknowledge',
  rule: 'CR-1',
  labelKey: 'diagnose.repair.CR1.acknowledge.label',
  descriptionKey: 'diagnose.repair.CR1.acknowledge.desc',
  risk: 'low',
  destructive: false,
  // Always available — acknowledging is a UI-only operation. Tests check
  // the engine resolves the alert + writes an audit row even though
  // nothing else moves.
  async preflight(): Promise<PreflightResult> {
    return {
      available: true,
      previewSteps: [
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. cross_clarify_session was already upgraded to abandoned by the invariant scan.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    return {
      beforeSnapshot: { alert: { id: rc.alert.id, rule: rc.alert.rule } },
      afterSnapshot: { alert: { id: rc.alert.id, action: 'acknowledged' } },
    }
  },
}

const CR1_RETRY_DESIGNER_RERUN: RepairOptionDef = {
  id: 'CR-1.retry-designer-rerun',
  rule: 'CR-1',
  labelKey: 'diagnose.repair.CR1.retryDesignerRerun.label',
  descriptionKey: 'diagnose.repair.CR1.retryDesignerRerun.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'failed') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.CR1.unavailable.taskNotFailed',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-CR1' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — scheduler freshness invariant cascades downstream`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write — `failed` is terminal, so this is one of the four
    // allowTerminal holders (design §1). A lost race surfaces as
    // repair-preflight-stale via the engine's apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'interrupted',
      allowedFrom: ['failed'],
      allowTerminal: true,
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-CR1',
        errorMessage: `RFC-057 repair CR-1.retry-designer-rerun via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'CR-1.retry-designer-rerun',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

export const CR1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  CR1_ACKNOWLEDGE,
  CR1_RETRY_DESIGNER_RERUN,
]
