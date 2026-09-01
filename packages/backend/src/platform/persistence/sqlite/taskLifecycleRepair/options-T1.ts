// RFC-057 — T1 SQLite repair options.
//
// T1 invariant: `task.status='awaiting_review'` but NO node_run is
// awaiting_review. Typical cause: review run got force-`interrupted` by
// shutdown / orphan reap while the task was parked; task field lagged.
//
//   - T1.demote-task            — flip task to interrupted + resume; the
//     scheduler re-enters the review node and mints a fresh awaiting_review.
//   - T1.resurrect-review-run   — find the latest terminal-non-done review
//     run at the current iter and force-flip it back to awaiting_review
//     (allowTerminal). The task stays awaiting_review.

import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'

import { isTerminalNonDone, loadAllNodeRunsForTask, schedulerLivenessGate } from './helpers'
import { isFresherNodeRun } from '@/services/freshness'
import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface ReviewRunCandidate {
  nodeRunId: string
  nodeId: string
  status: string
  reviewIteration: number
}

async function findLatestTerminalReviewRun(rc: RepairContext): Promise<ReviewRunCandidate | null> {
  let nodes: Array<{ id?: string; kind?: string }> = []
  try {
    const parsed = JSON.parse(rc.task.workflowSnapshot) as { nodes?: unknown }
    if (Array.isArray(parsed?.nodes)) nodes = parsed.nodes as typeof nodes
  } catch {
    return null
  }
  const reviewNodeIds = new Set<string>()
  for (const n of nodes) {
    if (typeof n?.id === 'string' && n?.kind === 'review') reviewNodeIds.add(n.id)
  }
  if (reviewNodeIds.size === 0) return null
  const runs = await loadAllNodeRunsForTask(rc.db, rc.task.id)
  // Group by nodeId; within each group, take latest by retryIndex; pick the
  // one in terminal-non-done with no done sibling at same reviewIteration.
  type Row = (typeof runs)[number]
  const byNode = new Map<string, Row[]>()
  for (const r of runs) {
    if (!reviewNodeIds.has(r.nodeId)) continue
    const arr = byNode.get(r.nodeId) ?? []
    arr.push(r)
    byNode.set(r.nodeId, arr)
  }
  let best: ReviewRunCandidate | null = null
  for (const [nodeId, rows] of byNode) {
    const groups = new Map<number, Row[]>()
    for (const r of rows) {
      const key = r.reviewIteration
      const arr = groups.get(key) ?? []
      arr.push(r)
      groups.set(key, arr)
    }
    for (const [reviewIter, group] of groups) {
      if (group.some((r) => r.status === 'done')) continue
      // RFC-096 (audit S-13): pure id order — a stale high-retryIndex terminal
      // row must not shadow a later low-retry rerun (same class of bug
      // resumeTask fixed once already; the old in-memory retryIndex reduce
      // bypassed the SQL-text guards).
      const latest = group.reduce((acc, r) => (isFresherNodeRun(r, acc) ? r : acc), group[0]!)
      if (isTerminalNonDone(latest.status)) {
        if (best === null || reviewIter > best.reviewIteration) {
          best = {
            nodeRunId: latest.id,
            nodeId,
            status: latest.status,
            reviewIteration: latest.reviewIteration,
          }
        }
      }
    }
  }
  return best
}

const T1_DEMOTE_TASK: RepairOptionDef = {
  id: 'T1.demote-task',
  rule: 'T1',
  labelKey: 'diagnose.repair.T1.demoteTask.label',
  descriptionKey: 'diagnose.repair.T1.demoteTask.desc',
  risk: 'low',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'awaiting_review') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T1.unavailable.taskNotAwaitingReview',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-T1' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — scheduler re-enters review node and re-parks awaiting_review`,
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
      to: 'interrupted',
      allowedFrom: ['awaiting_review'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-T1',
        errorMessage: `RFC-057 repair T1.demote-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'T1.demote-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const T1_RESURRECT_REVIEW_RUN: RepairOptionDef = {
  id: 'T1.resurrect-review-run',
  rule: 'T1',
  labelKey: 'diagnose.repair.T1.resurrectReviewRun.label',
  descriptionKey: 'diagnose.repair.T1.resurrectReviewRun.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: resurrects a DAG node run — refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'awaiting_review') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T1.unavailable.taskNotAwaitingReview',
        previewSteps: [],
        ctx: {},
      }
    }
    const cand = await findLatestTerminalReviewRun(rc)
    if (cand === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T1.resurrectReviewRun.unavailable.noCandidate',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `setNodeRunStatus(${cand.nodeRunId}, 'awaiting_review', allowTerminal) — review node_run ${cand.nodeId} from '${cand.status}' → awaiting_review (reviewIteration=${cand.reviewIteration})`,
        `Task remains 'awaiting_review'. No resume needed.`,
      ],
      ctx: { candidate: cand },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const cand = pre.ctx['candidate'] as ReviewRunCandidate
    const before = { nodeRun: { id: cand.nodeRunId, status: cand.status } }
    await setNodeRunStatus({
      db: rc.db,
      nodeRunId: cand.nodeRunId,
      to: 'awaiting_review',
      allowedFrom: ['failed', 'canceled', 'interrupted', 'exhausted'],
      allowTerminal: true,
      extra: { finishedAt: null, errorMessage: null },
      reason: 'T1.resurrect-review-run',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { nodeRun: { id: cand.nodeRunId, status: 'awaiting_review' } },
    }
  },
}

export const T1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  T1_DEMOTE_TASK,
  T1_RESURRECT_REVIEW_RUN,
]
