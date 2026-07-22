// RFC-057 — C1 repair options.
//
// C1 invariant: clarify_session.status ∈ {answered, canceled} BUT the
// linked clarify node_run.status is still 'awaiting_human'. Cause: the
// session got submitted/canceled but the scheduler never advanced the
// node_run out of awaiting_human (e.g. daemon restart between the two
// writes).
//
//   - C1.resume-run        — transition the node_run via `resume-clarify`
//     → done; mirrors what /clarify submit would have done.
//   - C1.reopen-session    — flip the session back to awaiting_human and
//     drop the answers; useful when the operator wants the user to redo
//     the answer cycle rather than auto-finalize.

import { and, eq } from 'drizzle-orm'

import { clarifyRounds, clarifySessions, nodeRuns } from '@/db/schema'
import { transitionNodeRunStatus } from '@/services/lifecycle'

import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface C1Detail {
  clarifySessionId: string
  clarifyNodeRunId: string
  clarifyNodeId?: string
  clarifySessionStatus?: string
}

function parseC1Detail(rc: RepairContext): C1Detail | null {
  const d = rc.alert.detail
  if (typeof d['clarifySessionId'] !== 'string') return null
  if (typeof d['clarifyNodeRunId'] !== 'string') return null
  const out: C1Detail = {
    clarifySessionId: d['clarifySessionId'],
    clarifyNodeRunId: d['clarifyNodeRunId'],
  }
  if (typeof d['clarifyNodeId'] === 'string') out.clarifyNodeId = d['clarifyNodeId']
  if (typeof d['clarifySessionStatus'] === 'string')
    out.clarifySessionStatus = d['clarifySessionStatus']
  return out
}

interface C1State {
  detail: C1Detail
  sessionStatus: string
  runStatus: string
}

async function loadC1State(rc: RepairContext): Promise<C1State | null> {
  const detail = parseC1Detail(rc)
  if (detail === null) return null
  const sess = (
    await rc.db
      .select({ status: clarifyRounds.status })
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.kind, 'self'), eq(clarifyRounds.id, detail.clarifySessionId)))
      .limit(1)
  )[0]
  if (sess === undefined) return null
  const nr = (
    await rc.db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, detail.clarifyNodeRunId))
      .limit(1)
  )[0]
  if (nr === undefined) return null
  return { detail, sessionStatus: sess.status, runStatus: nr.status }
}

const C1_RESUME_RUN: RepairOptionDef = {
  id: 'C1.resume-run',
  rule: 'C1',
  labelKey: 'diagnose.repair.C1.resumeRun.label',
  descriptionKey: 'diagnose.repair.C1.resumeRun.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    const st = await loadC1State(rc)
    if (st === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.C1.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.runStatus !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.C1.unavailable.runNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.sessionStatus !== 'answered' && st.sessionStatus !== 'canceled') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.C1.unavailable.sessionNotClosed',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `transitionNodeRunStatus(${st.detail.clarifyNodeRunId}, resume-clarify) — clarify run awaiting_human → done`,
      ],
      ctx: { state: st },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const st = pre.ctx['state'] as C1State
    const before = { nodeRun: { id: st.detail.clarifyNodeRunId, status: st.runStatus } }
    await transitionNodeRunStatus({
      db: rc.db,
      nodeRunId: st.detail.clarifyNodeRunId,
      event: { kind: 'resume-clarify' },
      extra: { finishedAt: rc.now() },
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { nodeRun: { id: st.detail.clarifyNodeRunId, status: 'done' } },
    }
  },
}

const C1_REOPEN_SESSION: RepairOptionDef = {
  id: 'C1.reopen-session',
  rule: 'C1',
  labelKey: 'diagnose.repair.C1.reopenSession.label',
  descriptionKey: 'diagnose.repair.C1.reopenSession.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    const st = await loadC1State(rc)
    if (st === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.C1.unavailable.detailDrift',
        previewSteps: [],
        ctx: {},
      }
    }
    if (st.runStatus !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.C1.unavailable.runNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE clarify_sessions SET status='awaiting_human', answers_json=NULL, answered_at=NULL WHERE id='${st.detail.clarifySessionId}'`,
        `Node_run stays awaiting_human; user can re-answer.`,
      ],
      ctx: { state: st },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const st = pre.ctx['state'] as C1State
    const before = {
      session: { id: st.detail.clarifySessionId, status: st.sessionStatus },
    }
    await rc.db
      .update(clarifySessions)
      .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
      .where(eq(clarifySessions.id, st.detail.clarifySessionId))
    // RFC-217 T7（设计门 P1）——修复路径此前只写遗留表，正是同 ID 双表分歧的
    // 制造源；补上统一表同步（T8 删表后仅此为真）。
    await rc.db
      .update(clarifyRounds)
      .set({ status: 'awaiting_human', answersJson: null, answeredAt: null })
      .where(eq(clarifyRounds.id, st.detail.clarifySessionId))
    return {
      beforeSnapshot: before,
      afterSnapshot: { session: { id: st.detail.clarifySessionId, status: 'awaiting_human' } },
    }
  },
}

export const C1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  C1_RESUME_RUN,
  C1_REOPEN_SESSION,
]
