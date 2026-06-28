// RFC-120 T9 (model A) — explicit batch-dispatch of deferred designer questions.
//
// A deferred-dispatch task (tasks.deferred_question_dispatch) records a
// designer-scoped cross-clarify answer WITHOUT triggering the designer rerun
// (crossClarify.submitCrossClarifyAnswers → 'designer-deferred'); the round's
// designer task_questions rows are created undispatched (trigger_run_id NULL) and
// the scheduler frontier parks the task awaiting_human (see
// taskQuestions.loadUndispatchedDesignerTargets). dispatchTaskQuestions is the
// explicit "batch-dispatch" that the human triggers from the board / clarify page
// once the handlers are chosen: it mints one rerun per effective handler target
// and stamps each entry's trigger_run_id, which RELEASES the park (the frontier no
// longer parks a node once its entries carry a trigger_run_id).
//
// Idempotency (Codex H3): the per-target stamp is a CAS guarded on
// `trigger_run_id IS NULL`, and entries are minted ONLY for rows still NULL at
// read time. A repeated dispatch of the same entries reads zero claimable rows →
// no second mint. Concurrent dispatches each mint, but the IS-NULL CAS lets only
// one stamp win per row; the loser's rerun is a NON-freshest orphan that the
// scheduler's pure id-order freshness never selects (harmless, superseded).
//
// Mint-BEFORE-stamp ordering: the pending rerun exists before its entries leave
// the park, so the very tick the gate releases sees the fresh pending rerun (and
// dispatches it) rather than the stale `done` draft.
//
// Foundation scope: the default handler (the graph designer, which always has a
// prior node_run + the __external_feedback__ edge) is fully wired — its rerun
// gets the existing topology-based External Feedback injection at schedule time.
// Run-scoped injection for OVERRIDE targets without that edge (Codex H2) and a
// safe first-run mint for never-run override targets (Codex F3) are the next
// layer; here an override to a node with no prior node_run surfaces the
// triggerDesignerRerun NotFoundError to the caller.

import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskQuestions } from '@/db/schema'
import { triggerDesignerRerun } from '@/services/crossClarify'
import { createLogger } from '@/util/log'
import { partitionDesignerQuestionsByTarget } from '@agent-workflow/shared'

const log = createLogger('task-questions.dispatch')

/** Audit-only actor identity. NEVER enters a prompt (RFC-099 prompt-isolation). */
export interface DispatchTaskQuestionsActor {
  userId: string
  role: 'owner' | 'user' | 'admin'
}

export interface DispatchedRerun {
  /** Effective handler node (override ?? default designer). */
  targetNodeId: string
  /** The freshly minted handler rerun (cause 'cross-clarify-answer'). */
  nodeRunId: string
  /** task_questions ids stamped with this rerun. */
  entryIds: string[]
}

export interface DispatchTaskQuestionsResult {
  reruns: DispatchedRerun[]
}

/**
 * Batch-dispatch the given designer task_questions entries: mint one rerun per
 * effective handler target and stamp each entry's trigger_run_id (releasing the
 * deferred park). Releasing the task to `running` + re-entering the scheduler is
 * the CALLER's responsibility (resumeTask), mirroring the clarify route — once
 * trigger_run_id is stamped the frontier stops parking these handler nodes.
 */
export async function dispatchTaskQuestions(
  db: DbClient,
  taskId: string,
  entryIds: string[],
  actor: DispatchTaskQuestionsActor,
): Promise<DispatchTaskQuestionsResult> {
  if (entryIds.length === 0) return { reruns: [] }

  // Read the still-undispatched designer rows among the requested entries. The
  // IS-NULL filter is the first idempotency guard: an already-dispatched entry
  // (trigger_run_id set) is never re-minted.
  const claimable = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        inArray(taskQuestions.id, entryIds),
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNull(taskQuestions.triggerRunId),
      ),
    )
  if (claimable.length === 0) return { reruns: [] }

  // Partition by effective target (override ?? default designer) via the shared
  // oracle. Sibling sources targeting one designer aggregate into ONE rerun; the
  // scheduler's External Feedback injection reads every answered designer-scoped
  // session for that node at schedule time, so empty `sources` here is fine.
  const partition = partitionDesignerQuestionsByTarget(
    claimable.map((e) => ({
      questionId: e.id, // grouping key = entry id, so we can map back to rows
      graphDesignerNodeId: e.defaultTargetNodeId ?? '',
      overrideNodeId: e.overrideTargetNodeId,
    })),
  )

  const reruns: DispatchedRerun[] = []
  for (const [targetNodeId, groupEntryIds] of partition) {
    // Unresolved handler (no override + graph designer missing) → cannot mint;
    // leave the rows NULL so the gate keeps parking them (user must reassign).
    if (targetNodeId === '') continue

    const loopIter = claimable.find((e) => groupEntryIds.includes(e.id))?.loopIter ?? 0
    // Mint FIRST (pending rerun exists before the gate releases), reusing the
    // cross-clarify designer mint (inherits the target's last run, cause
    // 'cross-clarify-answer', no worktree rollback).
    const rerun = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: targetNodeId,
      sources: [],
      loopIter,
    })
    // CAS-stamp only rows still NULL (idempotent under race; a lost race leaves a
    // harmless non-freshest orphan rerun the scheduler never selects).
    await db
      .update(taskQuestions)
      .set({ triggerRunId: rerun.designerNodeRunId, updatedAt: Date.now() })
      .where(and(inArray(taskQuestions.id, groupEntryIds), isNull(taskQuestions.triggerRunId)))
    reruns.push({ targetNodeId, nodeRunId: rerun.designerNodeRunId, entryIds: groupEntryIds })
  }

  log.info('task questions dispatched', {
    taskId,
    actorUserId: actor.userId,
    rerunCount: reruns.length,
    entryCount: claimable.length,
  })

  return { reruns }
}
