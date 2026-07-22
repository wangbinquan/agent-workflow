// RFC-057 — T2 repair options.
//
// T2 invariant: `task.status='awaiting_human'` but no node_run is
// awaiting_human. Mirrors T1 for the clarify channel.
//
//   - T2.demote-task            — flip task to interrupted + resume so the
//     scheduler re-enters the clarify node and re-parks awaiting_human.
//   - T2.resurrect-clarify-run  — find the latest terminal-non-done clarify
//     run at the current clarifyIteration and force back to awaiting_human
//     (allowTerminal). Requires there to be an open clarify_session for
//     the run — otherwise the UI would have no questions to show.

import { and, eq } from 'drizzle-orm'

import { clarifyRounds } from '@/db/schema'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'

import { isTerminalNonDone, loadAllNodeRunsForTask, schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface ClarifyRunCandidate {
  nodeRunId: string
  nodeId: string
  status: string
}

async function findClarifyResurrectionTarget(
  rc: RepairContext,
): Promise<ClarifyRunCandidate | null> {
  let nodes: Array<{ id?: string; kind?: string }> = []
  try {
    const parsed = JSON.parse(rc.task.workflowSnapshot) as { nodes?: unknown }
    if (Array.isArray(parsed?.nodes)) nodes = parsed.nodes as typeof nodes
  } catch {
    return null
  }
  const clarifyIds = new Set<string>()
  for (const n of nodes) {
    if (typeof n?.id !== 'string' || typeof n?.kind !== 'string') continue
    if (n.kind === 'clarify' || n.kind === 'clarify-cross-agent') clarifyIds.add(n.id)
  }
  if (clarifyIds.size === 0) return null
  const runs = await loadAllNodeRunsForTask(rc.db, rc.task.id)
  type Row = (typeof runs)[number]
  const byNode = new Map<string, Row[]>()
  for (const r of runs) {
    if (!clarifyIds.has(r.nodeId)) continue
    const arr = byNode.get(r.nodeId) ?? []
    arr.push(r)
    byNode.set(r.nodeId, arr)
  }
  // RFC-074 PR-C: generations are id-ordered, not clarifyIteration-grouped. Per
  // clarify node the latest row (max id) is the current round; if it already
  // reached 'done' the clarify resolved (skip), otherwise a terminal-non-done
  // latest is a stuck round to resurrect. The best candidate across nodes is the
  // most recently minted such row (max id) — the freshest stuck clarify.
  let best: { cand: ClarifyRunCandidate; id: string } | null = null
  for (const [nodeId, rows] of byNode) {
    const latest = rows.reduce((acc, r) => (r.id > acc.id ? r : acc), rows[0]!)
    if (latest.status === 'done') continue
    if (!isTerminalNonDone(latest.status)) continue
    if (best === null || latest.id > best.id) {
      best = {
        cand: { nodeRunId: latest.id, nodeId, status: latest.status },
        id: latest.id,
      }
    }
  }
  return best?.cand ?? null
}

const T2_DEMOTE_TASK: RepairOptionDef = {
  id: 'T2.demote-task',
  rule: 'T2',
  labelKey: 'diagnose.repair.T2.demoteTask.label',
  descriptionKey: 'diagnose.repair.T2.demoteTask.desc',
  risk: 'low',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T2.unavailable.taskNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-T2' WHERE id='${rc.task.id}'`,
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
        errorSummary: 'manual-repair-T2',
        errorMessage: `RFC-057 repair T2.demote-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'T2.demote-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const T2_RESURRECT_CLARIFY_RUN: RepairOptionDef = {
  id: 'T2.resurrect-clarify-run',
  rule: 'T2',
  labelKey: 'diagnose.repair.T2.resurrectClarifyRun.label',
  descriptionKey: 'diagnose.repair.T2.resurrectClarifyRun.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: resurrects a DAG node run — refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'awaiting_human') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T2.unavailable.taskNotAwaitingHuman',
        previewSteps: [],
        ctx: {},
      }
    }
    const cand = await findClarifyResurrectionTarget(rc)
    if (cand === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T2.resurrectClarifyRun.unavailable.noCandidate',
        previewSteps: [],
        ctx: {},
      }
    }
    // Require an open clarify_session for this run — otherwise resurrecting
    // the run to awaiting_human leaves the UI with no questions to show.
    const openSess = (
      await rc.db
        .select({ id: clarifyRounds.id })
        .from(clarifyRounds)
        .where(
          and(
            eq(clarifyRounds.kind, 'self'),
            eq(clarifyRounds.intermediaryNodeRunId, cand.nodeRunId),
            eq(clarifyRounds.status, 'awaiting_human'),
          ),
        )
        .limit(1)
    )[0]
    if (openSess === undefined) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.T2.resurrectClarifyRun.unavailable.noOpenSession',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `setNodeRunStatus(${cand.nodeRunId}, 'awaiting_human', allowTerminal) — clarify node_run ${cand.nodeId} from '${cand.status}' → awaiting_human`,
        `Task remains 'awaiting_human'. Operator can answer via /clarify.`,
      ],
      ctx: { candidate: cand },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const cand = pre.ctx['candidate'] as ClarifyRunCandidate
    const before = { nodeRun: { id: cand.nodeRunId, status: cand.status } }
    await setNodeRunStatus({
      db: rc.db,
      nodeRunId: cand.nodeRunId,
      to: 'awaiting_human',
      allowedFrom: ['failed', 'canceled', 'interrupted', 'exhausted'],
      allowTerminal: true,
      extra: { finishedAt: null, errorMessage: null },
      reason: 'T2.resurrect-clarify-run',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { nodeRun: { id: cand.nodeRunId, status: 'awaiting_human' } },
    }
  },
}

export const T2_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  T2_DEMOTE_TASK,
  T2_RESURRECT_CLARIFY_RUN,
]
