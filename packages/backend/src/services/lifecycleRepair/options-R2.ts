// RFC-057 — R2 repair options.
//
// R2 invariant: review node_run.status='done' BUT no doc_version exists
// with decision='approved' for it. This is the inverse of R1. The
// commonest cause is RFC-052 fallout where the approve transaction half-
// committed: status got flipped to `done` but the doc_version row never
// reached the `approved` decision.
//
//   - R2.demote-run-to-awaiting — flip the run back to awaiting_review
//     (setNodeRunStatus allowTerminal=true) so the operator can re-decide;
//     a pending doc_version may need to be (re)created — the scheduler
//     handles that on the next pass through dispatchReviewNode.
//   - R2.mark-task-failed       — escape hatch; task → failed.
//
// The shared design.md §4.3 row for R2 lists both options.

import { eq } from 'drizzle-orm'
import { isTerminalTaskStatus } from '@agent-workflow/shared'
import type { TaskStatus } from '@agent-workflow/shared'

import { nodeRuns } from '@/db/schema'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'

import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface R2Detail {
  reviewNodeRunId: string
  reviewNodeId?: string
}

function parseR2Detail(rc: RepairContext): R2Detail | null {
  const d = rc.alert.detail
  if (typeof d['reviewNodeRunId'] !== 'string') return null
  const out: R2Detail = { reviewNodeRunId: d['reviewNodeRunId'] }
  if (typeof d['reviewNodeId'] === 'string') out.reviewNodeId = d['reviewNodeId']
  return out
}

const R2_DEMOTE_RUN: RepairOptionDef = {
  id: 'R2.demote-run-to-awaiting',
  rule: 'R2',
  labelKey: 'diagnose.repair.R2.demoteRunToAwaiting.label',
  descriptionKey: 'diagnose.repair.R2.demoteRunToAwaiting.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    const detail = parseR2Detail(rc)
    if (detail === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R2.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    const nr = (
      await rc.db
        .select({ id: nodeRuns.id, status: nodeRuns.status })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, detail.reviewNodeRunId))
        .limit(1)
    )[0]
    if (nr === undefined) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R2.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    if (nr.status !== 'done') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R2.unavailable.runNotDone',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `setNodeRunStatus(${detail.reviewNodeRunId}, 'awaiting_review', allowTerminal) — review run from 'done' → awaiting_review`,
        `Scheduler will re-enter dispatchReviewNode; pending doc_version is recreated as needed.`,
      ],
      ctx: { detail, status: nr.status },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const detail = pre.ctx['detail'] as R2Detail
    const status = pre.ctx['status'] as string
    const before = { nodeRun: { id: detail.reviewNodeRunId, status } }
    await setNodeRunStatus({
      db: rc.db,
      nodeRunId: detail.reviewNodeRunId,
      to: 'awaiting_review',
      allowedFrom: ['done'],
      allowTerminal: true,
      extra: { finishedAt: null },
      reason: 'R2.demote-run-to-awaiting',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { nodeRun: { id: detail.reviewNodeRunId, status: 'awaiting_review' } },
    }
  },
}

const R2_MARK_FAILED: RepairOptionDef = {
  id: 'R2.mark-task-failed',
  rule: 'R2',
  labelKey: 'diagnose.repair.R2.markTaskFailed.label',
  descriptionKey: 'diagnose.repair.R2.markTaskFailed.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    if (isTerminalTaskStatus(rc.task.status as TaskStatus)) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R2.unavailable.taskTerminal',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='failed', error_summary='manual-repair-R2' WHERE id='${rc.task.id}'`,
        `Task workspace preserved.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    // RFC-097: CAS write — preflight excluded terminal states, so allowedFrom
    // is the full non-terminal set. A lost race surfaces as
    // repair-preflight-stale via the engine's apply catch.
    await setTaskStatus({
      db: rc.db,
      taskId: rc.task.id,
      to: 'failed',
      allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-R2',
        errorMessage: `RFC-057 repair R2.mark-task-failed via alert ${rc.alert.id}`,
      },
      reason: 'R2.mark-task-failed',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'failed' } },
    }
  },
}

export const R2_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  R2_DEMOTE_RUN,
  R2_MARK_FAILED,
]
