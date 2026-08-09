// RFC-057 — R1 repair options.
//
// R1 invariant: ∃ doc_versions row with decision='approved' BUT its
// review node_run.status != 'done'. Classic RFC-052 wedge: approve handler
// half-crashed between writing doc_versions and transitioning the
// node_run. The doc is marked approved; the run is stuck in
// awaiting_review (or any other non-done state).
//
//   - R1.approve-run        — finish the half-done approve: idempotent
//     upsert of approved_doc + approval_meta outputs, then force
//     run.status → done (allowTerminal). Low risk because the user already
//     approved; we're just completing the bookkeeping.
//   - R1.unapprove-doc      — flip the doc_version back to pending so the
//     user can re-decide. Use when the approve was a mistake / the run is
//     in a state where you'd rather not auto-finalize.
//   - R1.mark-task-failed   — escape hatch; task → failed.

import { eq } from 'drizzle-orm'
import { isTerminalTaskStatus } from '@agent-workflow/shared'
import type { TaskStatus } from '@agent-workflow/shared'

import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'

import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface R1Detail {
  docVersionId: string
  reviewNodeRunId: string
  reviewNodeId?: string
  actualStatus?: string
}

function parseR1Detail(rc: RepairContext): R1Detail | null {
  const d = rc.alert.detail
  if (typeof d['docVersionId'] !== 'string') return null
  if (typeof d['reviewNodeRunId'] !== 'string') return null
  const out: R1Detail = {
    docVersionId: d['docVersionId'],
    reviewNodeRunId: d['reviewNodeRunId'],
  }
  if (typeof d['reviewNodeId'] === 'string') out.reviewNodeId = d['reviewNodeId']
  if (typeof d['actualStatus'] === 'string') out.actualStatus = d['actualStatus']
  return out
}

interface R1State {
  detail: R1Detail
  docDecision: string
  docVersionIndex: number
  docReviewIteration: number
  docSourceFilePath: string | null
  runStatus: string
  hasApprovedDocOutput: boolean
  hasApprovalMetaOutput: boolean
}

async function loadR1State(rc: RepairContext): Promise<R1State | null> {
  const detail = parseR1Detail(rc)
  if (detail === null) return null
  const dvRows = await rc.db
    .select()
    .from(docVersions)
    .where(eq(docVersions.id, detail.docVersionId))
    .limit(1)
  if (dvRows.length === 0) return null
  const dv = dvRows[0]!
  if (dv.taskId !== rc.task.id || dv.reviewNodeRunId !== detail.reviewNodeRunId) return null
  const nrRows = await rc.db
    .select({ id: nodeRuns.id, taskId: nodeRuns.taskId, status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, detail.reviewNodeRunId))
    .limit(1)
  if (nrRows.length === 0) return null
  if (nrRows[0]!.taskId !== rc.task.id) return null
  const outRows = await rc.db
    .select({ portName: nodeRunOutputs.portName })
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, detail.reviewNodeRunId))
  const hasApprovedDocOutput = outRows.some((r) => r.portName === 'approved_doc')
  const hasApprovalMetaOutput = outRows.some((r) => r.portName === 'approval_meta')
  return {
    detail,
    docDecision: dv.decision,
    docVersionIndex: dv.versionIndex,
    docReviewIteration: dv.reviewIteration,
    docSourceFilePath: dv.sourceFilePath,
    runStatus: nrRows[0]!.status,
    hasApprovedDocOutput,
    hasApprovalMetaOutput,
  }
}

function isR1TaskHardSealed(status: string): boolean {
  // RFC-202 keeps failed/interrupted repairable. done/canceled are the hard
  // seal: neither R1 writer may reopen review facts after terminal sweep.
  return status === 'done' || status === 'canceled'
}

function throwR1PreflightStale(optionId: string, detail: string): never {
  throw new ConflictError(
    'repair-preflight-stale',
    `apply for '${optionId}' is stale (${detail}); re-diagnose to refresh`,
  )
}

/** Revalidate every R1 invariant after acquiring the task mutation lock. */
async function loadWritableR1State(
  rc: RepairContext,
  optionId: 'R1.approve-run' | 'R1.unapprove-doc',
): Promise<{ state: R1State; taskStatus: string }> {
  const taskRow = (
    await rc.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, rc.task.id))
      .limit(1)
  )[0]
  if (taskRow === undefined) throwR1PreflightStale(optionId, 'task disappeared')
  if (isR1TaskHardSealed(taskRow.status)) {
    throwR1PreflightStale(optionId, `task is ${taskRow.status}`)
  }
  const state = await loadR1State(rc)
  if (state === null) throwR1PreflightStale(optionId, 'doc/run ownership or detail drifted')
  if (state.docDecision !== 'approved') {
    throwR1PreflightStale(optionId, `doc decision is ${state.docDecision}`)
  }
  if (state.runStatus === 'done') throwR1PreflightStale(optionId, 'review run is already done')
  return { state, taskStatus: taskRow.status }
}

const R1_APPROVE_RUN: RepairOptionDef = {
  id: 'R1.approve-run',
  rule: 'R1',
  labelKey: 'diagnose.repair.R1.approveRun.label',
  descriptionKey: 'diagnose.repair.R1.approveRun.desc',
  risk: 'low',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    if (isR1TaskHardSealed(rc.task.status)) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.taskTerminal',
        previewSteps: [],
        ctx: {},
      }
    }
    const st = await loadR1State(rc)
    if (st === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.docDecision !== 'approved') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.docNotApproved',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.runStatus === 'done') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.runAlreadyDone',
        previewSteps: [],
        ctx: {},
      }
    }
    const steps: string[] = []
    if (!st.hasApprovedDocOutput) {
      steps.push(
        `INSERT INTO node_run_outputs (approved_doc) — populate missing port (idempotent upsert)`,
      )
    }
    if (!st.hasApprovalMetaOutput) {
      steps.push(
        `INSERT INTO node_run_outputs (approval_meta) — populate missing port (idempotent upsert)`,
      )
    }
    steps.push(
      `setNodeRunStatus(${st.detail.reviewNodeRunId}, 'done', allowTerminal) — review run from '${st.runStatus}' → done`,
    )
    return { available: true, previewSteps: steps, ctx: { state: st } }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    void pre
    return withTaskReviewMutationLock(rc.task.id, async () => {
      const { state: st, taskStatus } = await loadWritableR1State(rc, 'R1.approve-run')
      const before = {
        nodeRun: { id: st.detail.reviewNodeRunId, status: st.runStatus },
        hasApprovedDocOutput: st.hasApprovedDocOutput,
        hasApprovalMetaOutput: st.hasApprovalMetaOutput,
      }
      // Idempotent upsert of approved_doc port if missing. Mirror review.ts:1186-1196.
      // We can't reconstruct the original body without the appHome + dv, so the
      // approved_doc content is best-effort: the sourceFilePath when present
      // (the markdown_file case — downstream re-reads it), else a marker pointing
      // to the doc_version id so downstream agents fail loudly rather than
      // silently consuming '' (and so the audit row makes it obvious this was a
      // manual recovery, not a real approve).
      const content =
        st.docSourceFilePath !== null && st.docSourceFilePath.trim().length > 0
          ? st.docSourceFilePath
          : `__rfc057_manual_repair__:doc_version=${st.detail.docVersionId}`
      const meta = JSON.stringify({
        decision: 'approved',
        decidedAt: rc.now(),
        decidedBy: 'rfc057-repair',
        reviewIteration: st.docReviewIteration,
        versionIndex: st.docVersionIndex,
      })
      // Check the two ports independently. A daemon/DB failure after the first
      // upsert must leave the next repair able to fill approval_meta instead of
      // mistaking approved_doc alone for a complete approval fact set.
      if (!st.hasApprovedDocOutput) {
        await rc.db
          .insert(nodeRunOutputs)
          .values({
            nodeRunId: st.detail.reviewNodeRunId,
            portName: 'approved_doc',
            content,
          })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content },
          })
      }
      if (!st.hasApprovalMetaOutput) {
        await rc.db
          .insert(nodeRunOutputs)
          .values({
            nodeRunId: st.detail.reviewNodeRunId,
            portName: 'approval_meta',
            content: meta,
          })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content: meta },
          })
      }
      await setNodeRunStatus({
        db: rc.db,
        nodeRunId: st.detail.reviewNodeRunId,
        to: 'done',
        allowedFrom: [
          'awaiting_review',
          'pending',
          'running',
          'failed',
          'canceled',
          'interrupted',
          'exhausted',
        ],
        allowTerminal: true,
        extra: { finishedAt: rc.now() },
        reason: 'R1.approve-run',
      })
      return {
        beforeSnapshot: before,
        afterSnapshot: {
          nodeRun: { id: st.detail.reviewNodeRunId, status: 'done' },
          hasApprovedDocOutput: true,
          hasApprovalMetaOutput: true,
        },
        // Calling resumeTask on done/running is rejected; failed/interrupted/
        // awaiting_* remain the RFC-202 repairable states. Use the lock-fresh
        // task row, never the stale engine snapshot.
        resumeAfterApply:
          taskStatus === 'awaiting_review' ||
          taskStatus === 'failed' ||
          taskStatus === 'interrupted' ||
          taskStatus === 'awaiting_human',
      }
    })
  },
}

const R1_UNAPPROVE_DOC: RepairOptionDef = {
  id: 'R1.unapprove-doc',
  rule: 'R1',
  labelKey: 'diagnose.repair.R1.unapproveDoc.label',
  descriptionKey: 'diagnose.repair.R1.unapproveDoc.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (isR1TaskHardSealed(rc.task.status)) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.taskTerminal',
        previewSteps: [],
        ctx: {},
      }
    }
    const st = await loadR1State(rc)
    if (st === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.docDecision !== 'approved') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.docNotApproved',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.runStatus === 'done') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.runAlreadyDone',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE doc_versions SET decision='pending', decided_at=NULL, decided_by=NULL WHERE id='${st.detail.docVersionId}'`,
        `Review run left in '${st.runStatus}'. Operator may need to demote task / retry to re-park awaiting_review.`,
      ],
      ctx: { state: st },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    void pre
    return withTaskReviewMutationLock(rc.task.id, async () => {
      const { state: st } = await loadWritableR1State(rc, 'R1.unapprove-doc')
      const before = { doc: { id: st.detail.docVersionId, decision: st.docDecision } }
      await rc.db
        .update(docVersions)
        .set({ decision: 'pending', decidedAt: null, decidedBy: null })
        .where(eq(docVersions.id, st.detail.docVersionId))
      return {
        beforeSnapshot: before,
        afterSnapshot: { doc: { id: st.detail.docVersionId, decision: 'pending' } },
      }
    })
  },
}

const R1_MARK_FAILED: RepairOptionDef = {
  id: 'R1.mark-task-failed',
  rule: 'R1',
  labelKey: 'diagnose.repair.R1.markTaskFailed.label',
  descriptionKey: 'diagnose.repair.R1.markTaskFailed.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    if (isTerminalTaskStatus(rc.task.status as TaskStatus)) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.R1.unavailable.taskTerminal',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='failed', error_summary='manual-repair-R1' WHERE id='${rc.task.id}'`,
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
        errorSummary: 'manual-repair-R1',
        errorMessage: `RFC-057 repair R1.mark-task-failed via alert ${rc.alert.id}`,
      },
      reason: 'R1.mark-task-failed',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'failed' } },
    }
  },
}

export const R1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  R1_APPROVE_RUN,
  R1_UNAPPROVE_DOC,
  R1_MARK_FAILED,
]
