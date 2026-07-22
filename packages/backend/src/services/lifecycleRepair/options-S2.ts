// RFC-057 — S2 repair options.
//
// S2: task.status='awaiting_human' BUT no open clarify_session. Reaches
// the operator after 30 min freshness gate. Two resolutions:
//
//   - S2.demote-task        — flip task to interrupted + resume.
//   - S2.reopen-session     — find a closed (answered/canceled) clarify
//     session for the task's awaiting_human run and reopen it.

import { and, desc, eq } from 'drizzle-orm'

import { clarifyRounds, nodeRuns } from '@/db/schema'
import { setTaskStatus } from '@/services/lifecycle'

import { schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairOptionDef } from './types'

const S2_DEMOTE_TASK: RepairOptionDef = {
  id: 'S2.demote-task',
  rule: 'S2',
  labelKey: 'diagnose.repair.S2.demoteTask.label',
  descriptionKey: 'diagnose.repair.S2.demoteTask.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S2.unavailable.taskNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S2' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}')`,
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
      allowedFrom: ['awaiting_human'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S2',
        errorMessage: `RFC-057 repair S2.demote-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'S2.demote-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const S2_REOPEN_SESSION: RepairOptionDef = {
  id: 'S2.reopen-session',
  rule: 'S2',
  labelKey: 'diagnose.repair.S2.reopenSession.label',
  descriptionKey: 'diagnose.repair.S2.reopenSession.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S2.unavailable.taskNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    // Find an awaiting_human clarify node_run in the task.
    const awaitingRun = (
      await rc.db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, rc.task.id), eq(nodeRuns.status, 'awaiting_human')))
        .limit(1)
    )[0]
    if (awaitingRun === undefined) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S2.reopenSession.unavailable.noAwaitingRun',
        previewSteps: [],
        ctx: {},
      }
    }
    // Find a closed clarify_session for it.
    const closed = (
      await rc.db
        .select({ id: clarifyRounds.id, status: clarifyRounds.status })
        .from(clarifyRounds)
        .where(
          and(
            eq(clarifyRounds.kind, 'self'),
            eq(clarifyRounds.intermediaryNodeRunId, awaitingRun.id),
          ),
        )
        .orderBy(desc(clarifyRounds.createdAt))
        .limit(1)
    )[0]
    if (closed === undefined) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S2.reopenSession.unavailable.noClosedSession',
        previewSteps: [],
        ctx: {},
      }
    }
    if (closed.status === 'awaiting_human') {
      // Session is already open — S2 shouldn't be firing; preflight stale.
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S2.reopenSession.unavailable.sessionAlreadyOpen',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE clarify_sessions SET status='awaiting_human', answers_json=NULL, answered_at=NULL WHERE id='${closed.id}'`,
      ],
      ctx: { sessionId: closed.id, previousStatus: closed.status },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const sessionId = pre.ctx['sessionId'] as string
    const previousStatus = pre.ctx['previousStatus'] as string
    const before = { session: { id: sessionId, status: previousStatus } }
    // RFC-217 T8 —— clarify_rounds 唯一数据源（遗留表已删）。
    await rc.db
      .update(clarifyRounds)
      .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
      .where(eq(clarifyRounds.id, sessionId))
    return {
      beforeSnapshot: before,
      afterSnapshot: { session: { id: sessionId, status: 'awaiting_human' } },
    }
  },
}

export const S2_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  S2_DEMOTE_TASK,
  S2_REOPEN_SESSION,
]
