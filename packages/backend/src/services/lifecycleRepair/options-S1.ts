// RFC-057 — S1 repair options.
//
// S1: task.status='awaiting_review' BUT no pending doc_version exists.
// Reaches the operator after the stuck detector's 30-min freshness gate.
//
//   - S1.recreate-doc-version  — re-invoke dispatchReviewNode for the
//     review node so it mints a fresh pending doc_version on top of the
//     done upstream source. Restores the "user can decide" path without
//     touching task.status.
//   - S1.demote-task           — flip task to interrupted + resume; the
//     scheduler walks back through dispatchReviewNode (same effect as
//     option 1 but goes via the normal task lifecycle).

import { and, desc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { nodeRuns, tasks } from '@/db/schema'
import { setTaskStatus } from '@/services/lifecycle'
import { isoWorktreePathFor } from '@/services/nodeIsolation'
import { dispatchReviewNode } from '@/services/review'
import { buildContainerMap } from '@/services/scheduler'

import { schedulerLivenessGate } from './helpers'
import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

interface S1Hint {
  reviewNodeId?: string
  reviewNodeRunId?: string
}

function readHint(rc: RepairContext): S1Hint {
  const h = rc.alert.detail['repairHint']
  if (h !== null && typeof h === 'object' && !Array.isArray(h)) {
    const o = h as Record<string, unknown>
    const out: S1Hint = {}
    if (typeof o['nodeRunId'] === 'string') out.reviewNodeRunId = o['nodeRunId']
    return out
  }
  return {}
}

interface PreparedDispatch {
  taskRow: typeof tasks.$inferSelect
  definition: WorkflowDefinition
  reviewNode: WorkflowNode
  iteration: number
  /** RFC-193 §4.6：review 所在 scope 的 canonical 根（回退链用）。 */
  scopeRoot: string
}

/**
 * RFC-193 §4.6 — S1 是 scheduler 之外唯一的 dispatchReviewNode 生产调用方，
 * 传 task.worktreePath 会在 wrapper 内 review 上复现本 RFC 的原始断链。归档
 * 制下主路径读 archive_json（scopeRoot 只服务存量行回退）；这里按 wrapper
 * run 谱系恢复：review 属某 git/loop wrapper（containerOf）且该 wrapper 的
 * 最新 run 的 iso 容器目录仍存在 ⇒ 用它；否则退 task.worktreePath（顶层 /
 * iso 已灭——不劣于现状）。
 */
async function deriveScopeRoot(
  rc: RepairContext,
  taskWorktreePath: string,
  definition: WorkflowDefinition,
  reviewNodeId: string,
): Promise<string> {
  const wrapperId = buildContainerMap(definition).get(reviewNodeId)
  if (wrapperId === undefined) return taskWorktreePath
  const rows = await rc.db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, rc.task.id), eq(nodeRuns.nodeId, wrapperId)))
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  const wrapperRun = rows[0]
  if (wrapperRun === undefined) return taskWorktreePath
  const isoRoot = isoWorktreePathFor(rc.appHome, rc.task.id, wrapperRun.id, '')
  return existsSync(isoRoot) ? isoRoot : taskWorktreePath
}

async function prepareDispatch(rc: RepairContext): Promise<PreparedDispatch | string> {
  // Parse the workflow snapshot to locate the review node.
  let definition: WorkflowDefinition
  try {
    definition = JSON.parse(rc.task.workflowSnapshot) as WorkflowDefinition
  } catch {
    return 'diagnose.repair.S1.unavailable.workflowSnapshotCorrupt'
  }
  if (!Array.isArray(definition.nodes))
    return 'diagnose.repair.S1.unavailable.workflowSnapshotCorrupt'

  const hint = readHint(rc)
  // Locate the latest awaiting_review review node_run; if hint specifies a
  // run, prefer that; otherwise scan node_runs by review kind in workflow.
  const reviewNodeIds = new Set<string>()
  for (const n of definition.nodes) {
    if (typeof n?.id === 'string' && n?.kind === 'review') reviewNodeIds.add(n.id)
  }
  if (reviewNodeIds.size === 0) return 'diagnose.repair.S1.unavailable.noReviewNode'

  let awaitingRun: { id: string; nodeId: string; iteration: number } | undefined
  if (hint.reviewNodeRunId !== undefined) {
    const row = (
      await rc.db
        .select({
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          iteration: nodeRuns.iteration,
          status: nodeRuns.status,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, hint.reviewNodeRunId))
        .limit(1)
    )[0]
    if (row !== undefined && row.status === 'awaiting_review' && reviewNodeIds.has(row.nodeId)) {
      awaitingRun = { id: row.id, nodeId: row.nodeId, iteration: row.iteration }
    }
  }
  if (awaitingRun === undefined) {
    // Fallback: pick any awaiting_review review run for this task.
    const candidates = await rc.db
      .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId, iteration: nodeRuns.iteration })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, rc.task.id), eq(nodeRuns.status, 'awaiting_review')))
    for (const c of candidates) {
      if (reviewNodeIds.has(c.nodeId)) {
        awaitingRun = c
        break
      }
    }
  }
  if (awaitingRun === undefined) return 'diagnose.repair.S1.unavailable.noAwaitingReviewRun'

  const reviewNode = definition.nodes.find((n) => n.id === awaitingRun!.nodeId)
  if (reviewNode === undefined) return 'diagnose.repair.S1.unavailable.workflowSnapshotCorrupt'

  // Load full task row.
  const taskRow = (await rc.db.select().from(tasks).where(eq(tasks.id, rc.task.id)).limit(1))[0]
  if (taskRow === undefined) return 'diagnose.repair.S1.unavailable.detailDrift'

  return {
    taskRow,
    definition,
    reviewNode,
    iteration: awaitingRun.iteration,
    scopeRoot: await deriveScopeRoot(rc, taskRow.worktreePath, definition, reviewNode.id),
  }
}

const S1_RECREATE_DOC: RepairOptionDef = {
  id: 'S1.recreate-doc-version',
  rule: 'S1',
  labelKey: 'diagnose.repair.S1.recreateDocVersion.label',
  descriptionKey: 'diagnose.repair.S1.recreateDocVersion.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'awaiting_review') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S1.unavailable.taskNotAwaitingReview',
        previewSteps: [],
        ctx: {},
      }
    }
    const prep = await prepareDispatch(rc)
    if (typeof prep === 'string') {
      return { available: false, unavailableReasonKey: prep, previewSteps: [], ctx: {} }
    }
    return {
      available: true,
      previewSteps: [
        `dispatchReviewNode(node=${prep.reviewNode.id}, iter=${prep.iteration}) — re-invoke review dispatch which mints a fresh pending doc_version on top of the done upstream.`,
        `Task stays 'awaiting_review'. No node_run.status changes.`,
      ],
      ctx: { prep },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const prep = pre.ctx['prep'] as PreparedDispatch
    const result = await dispatchReviewNode({
      db: rc.db,
      taskId: rc.task.id,
      appHome: rc.appHome,
      definition: prep.definition,
      node: prep.reviewNode,
      iteration: prep.iteration,
      scopeRoot: prep.scopeRoot,
    })
    if (result.kind === 'failed') {
      throw new Error(`dispatchReviewNode failed: ${result.message} — ${result.summary}`)
    }
    return {
      beforeSnapshot: { reviewNode: prep.reviewNode.id, iteration: prep.iteration },
      afterSnapshot: { dispatchResult: result.kind, message: result.message },
    }
  },
}

const S1_DEMOTE_TASK: RepairOptionDef = {
  id: 'S1.demote-task',
  rule: 'S1',
  labelKey: 'diagnose.repair.S1.demoteTask.label',
  descriptionKey: 'diagnose.repair.S1.demoteTask.desc',
  risk: 'medium',
  destructive: false,
  revivesExecution: true, // RFC-165 F13-r4: refused for workgroup tasks
  async preflight(rc): Promise<PreflightResult> {
    // RFC-097 (audit S-23): refuse while an in-process scheduler owns the task.
    const gate = schedulerLivenessGate(rc)
    if (gate !== null) return gate
    if (rc.task.status !== 'awaiting_review') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S1.unavailable.taskNotAwaitingReview',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S1' WHERE id='${rc.task.id}'`,
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
      allowedFrom: ['awaiting_review'],
      extra: {
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S1',
        errorMessage: `RFC-057 repair S1.demote-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      },
      reason: 'S1.demote-task',
    })
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

export const S1_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  S1_RECREATE_DOC,
  S1_DEMOTE_TASK,
]
