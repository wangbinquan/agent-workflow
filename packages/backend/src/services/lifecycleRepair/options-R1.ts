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

import { docVersions, nodeRunOutputs, nodeRuns } from '@/db/schema'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'

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
  hasApprovedOutput: boolean
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
  const nrRows = await rc.db
    .select({ id: nodeRuns.id, status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, detail.reviewNodeRunId))
    .limit(1)
  if (nrRows.length === 0) return null
  const outRows = await rc.db
    .select({ portName: nodeRunOutputs.portName })
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, detail.reviewNodeRunId))
  const hasApprovedOutput = outRows.some((r) => r.portName === 'approved_doc')
  return {
    detail,
    docDecision: dv.decision,
    docVersionIndex: dv.versionIndex,
    docReviewIteration: dv.reviewIteration,
    docSourceFilePath: dv.sourceFilePath,
    runStatus: nrRows[0]!.status,
    hasApprovedOutput,
  }
}

const R1_APPROVE_RUN: RepairOptionDef = {
  id: 'R1.approve-run',
  rule: 'R1',
  labelKey: 'diagnose.repair.R1.approveRun.label',
  descriptionKey: 'diagnose.repair.R1.approveRun.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
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
    if (!st.hasApprovedOutput) {
      steps.push(
        `INSERT INTO node_run_outputs (approved_doc) — populate missing port (idempotent upsert)`,
      )
    }
    steps.push(
      `setNodeRunStatus(${st.detail.reviewNodeRunId}, 'done', allowTerminal) — review run from '${st.runStatus}' → done`,
    )
    return { available: true, previewSteps: steps, ctx: { state: st } }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const st = pre.ctx['state'] as R1State
    const before = {
      nodeRun: { id: st.detail.reviewNodeRunId, status: st.runStatus },
      hasApprovedOutput: st.hasApprovedOutput,
    }
    // Idempotent upsert of approved_doc port if missing. Mirror review.ts:1186-1196.
    // We can't reconstruct the original body without the appHome + dv, so the
    // approved_doc content is best-effort: the sourceFilePath when present
    // (the markdown_file case — downstream re-reads it), else a marker pointing
    // to the doc_version id so downstream agents fail loudly rather than
    // silently consuming '' (and so the audit row makes it obvious this was a
    // manual recovery, not a real approve).
    if (!st.hasApprovedOutput) {
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
        hasApprovedOutput: true,
      },
      // resumeAfterApply: true unless task is already terminal — but R1 is
      // a data-shape invariant violation, not necessarily a stuck task.
      // Calling resumeTask on a `done` task is rejected; on a running task
      // it's also rejected; only failed/interrupted/awaiting_* succeed.
      // The downstream scheduler picks up the now-done review on the next
      // task lifecycle event anyway, so we DON'T blanket-resume here. The
      // operator can hit the task's Resume button if needed.
      resumeAfterApply:
        rc.task.status === 'awaiting_review' ||
        rc.task.status === 'failed' ||
        rc.task.status === 'interrupted' ||
        rc.task.status === 'awaiting_human',
    }
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
    const st = pre.ctx['state'] as R1State
    const before = { doc: { id: st.detail.docVersionId, decision: st.docDecision } }
    await rc.db
      .update(docVersions)
      .set({ decision: 'pending', decidedAt: null, decidedBy: null })
      .where(eq(docVersions.id, st.detail.docVersionId))
    return {
      beforeSnapshot: before,
      afterSnapshot: { doc: { id: st.detail.docVersionId, decision: 'pending' } },
    }
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
