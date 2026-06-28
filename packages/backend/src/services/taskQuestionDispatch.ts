// RFC-120 T9 (model A) — explicit batch-dispatch of deferred designer questions.
//
// A deferred-dispatch task (tasks.deferred_question_dispatch) records a
// designer-scoped cross-clarify answer WITHOUT triggering the designer rerun
// (crossClarify.submitCrossClarifyAnswers → 'designer-deferred'); the round's
// designer task_questions rows are created undispatched (trigger_run_id NULL) and
// the scheduler frontier parks the task awaiting_human (see
// taskQuestions.loadUndispatchedDesignerTargets). dispatchTaskQuestions is the
// explicit "batch-dispatch" the human triggers once the handlers are chosen: it
// mints one rerun per handler node and stamps each entry's trigger_run_id, which
// RELEASES the park (the frontier no longer parks a node once its entries carry a
// trigger_run_id). Releasing the task to `running` + scheduler re-entry is the
// CALLER's job (resumeTask), mirroring the clarify route.
//
// Codex impl-gate folds (no-ship → fixed):
//
//   H1 [granularity vs ROUND/GRAPH-scoped consumption]. The runner stamps the
//   WHOLE cross round consumed for the target node (clarifyRounds.ts
//   markClarifyRoundsConsumedBy keys on targetConsumerNodeId == run.nodeId), and
//   the designer prompt reads EVERY unconsumed round pointing at the node
//   (crossClarify.ts buildExternalFeedbackContext via the graph
//   findCrossClarifyNodesPointingToDesigner). So one designer rerun consumes +
//   injects ALL of that node's answered rounds. Dispatching a SUBSET would
//   consume the rest while leaving their trigger_run_id NULL → the park gate
//   strands them forever. FIX: the dispatch unit is the GRAPH DESIGNER NODE — a
//   requested entry expands to ALL open designer entries whose graph designer
//   (default target) matches, across every round, stamped together.
//
//   H2 [atomicity]. The mint must not precede the stamp: a crash between would
//   orphan a pending rerun while the gate (still NULL) parks the node → stuck;
//   two concurrent dispatchers would both mint. FIX: claim + mint in ONE dbTxSync
//   with a PREALLOCATED run id — a SELECT-still-NULL guard + the stamp + the
//   node_run insert commit together; a concurrent loser's SELECT sees a short
//   group, throws, and rolls back the whole tx (no stamp, no mint, no orphan).
//
//   H3 [unsafe targets]. In v1 consumption + injection are GRAPH-keyed (per the
//   graph designer's to_designer edges), so an override handing a round's answer
//   to a DIFFERENT node can't receive that answer — the node would rerun without
//   it yet be stamped as the handler. Safe run-scoped injection + safe first-run
//   minting for arbitrary nodes are explicitly the NEXT layer. FIX: REJECT any
//   open designer entry whose effective target diverges from its graph designer
//   (stricter — and more correct — than a prior-run/feedback-edge check, which a
//   run+edge sibling designer would wrongly pass), and defensively guard that the
//   graph designer itself has (a) a prior node_run to inherit AND (b) an inbound
//   __external_feedback__ channel.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { pickFreshestRun } from '@/services/freshness'
import { buildMintNodeRunValues } from '@/services/nodeRunMint'
import { ConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { agentHasExternalFeedbackChannel, type WorkflowDefinition } from '@agent-workflow/shared'

const log = createLogger('task-questions.dispatch')

/** Audit-only actor identity. NEVER enters a prompt (RFC-099 prompt-isolation). */
export interface DispatchTaskQuestionsActor {
  userId: string
  role: 'owner' | 'user' | 'admin'
}

export interface DispatchedRerun {
  /** Graph designer node the rerun was minted for. */
  targetNodeId: string
  /** The freshly minted handler rerun (cause 'cross-clarify-answer'). */
  nodeRunId: string
  /** task_questions ids stamped with this rerun (the node's whole open group). */
  entryIds: string[]
}

export interface DispatchTaskQuestionsResult {
  reruns: DispatchedRerun[]
}

type TaskQuestionRow = typeof taskQuestions.$inferSelect

/** Thrown inside the atomic tx to roll it back when a concurrent dispatcher
 *  already claimed part of the group (→ no stamp, no mint, no orphan). */
class ConcurrentClaim extends Error {}

function parseDefinition(snapshot: string): WorkflowDefinition | null {
  try {
    return JSON.parse(snapshot) as WorkflowDefinition
  } catch {
    return null
  }
}

/** The handler that actually runs this entry: the override target if reassigned,
 *  else the graph designer (default). */
function effectiveTarget(e: TaskQuestionRow): string | null {
  return e.overrideTargetNodeId ?? e.defaultTargetNodeId
}

/**
 * Batch-dispatch the deferred designer task_questions reachable from `entryIds`.
 * Expands to whole graph-designer-node groups (H1), guards override/target safety
 * (H3), and mints one rerun per node atomically (H2). Resume is the caller's job.
 */
export async function dispatchTaskQuestions(
  db: DbClient,
  taskId: string,
  entryIds: string[],
  actor: DispatchTaskQuestionsActor,
): Promise<DispatchTaskQuestionsResult> {
  if (entryIds.length === 0) return { reruns: [] }

  // 1. The requested still-undispatched designer entries (NULL trigger_run_id).
  const requested = await db
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
  if (requested.length === 0) return { reruns: [] }

  // 2. Expand to ALL open designer entries sharing a requested EFFECTIVE target
  //    (override ?? graph designer), across every round. The dispatch +
  //    consumption unit is the effective handler NODE: one rerun per node carries
  //    the answer (graph or run-scoped) + consumes every round it handles, so a
  //    subset dispatch can't strand the rest (Codex H1).
  const requestedTargets = new Set(
    requested.map(effectiveTarget).filter((t): t is string => t !== null && t !== ''),
  )
  if (requestedTargets.size === 0) return { reruns: [] }
  const allOpen = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.roleKind, 'designer'),
        isNull(taskQuestions.triggerRunId),
      ),
    )
  const groupEntries = allOpen.filter((e) => {
    const t = effectiveTarget(e)
    return t !== null && requestedTargets.has(t)
  })

  // 3. A cross round is consumed as a UNIT (round-scoped consumption), so a round
  //    whose open designer entries span >1 effective target can't be split in v1.
  //    Reject it — fail fast, no partial dispatch.
  const targetsByRound = new Map<string, Set<string>>()
  for (const e of groupEntries) {
    const t = effectiveTarget(e)
    if (t === null) continue
    const set = targetsByRound.get(e.originNodeRunId) ?? new Set<string>()
    set.add(t)
    targetsByRound.set(e.originNodeRunId, set)
  }
  for (const [roundOrigin, targets] of targetsByRound) {
    if (targets.size > 1) {
      throw new ConflictError(
        'task-question-round-multi-target',
        `round ${roundOrigin} has designer questions dispatched to multiple handler nodes (${[...targets].join(', ')}); a cross-clarify round is consumed as a unit in v1 — reassign its designer questions to a single handler first.`,
      )
    }
  }

  // 4. Group by effective target + guard every target BEFORE minting (fail fast →
  //    no partial dispatch).
  const byTarget = new Map<string, TaskQuestionRow[]>()
  for (const e of groupEntries) {
    const t = effectiveTarget(e)
    if (t === null) continue
    const list = byTarget.get(t)
    if (list) list.push(e)
    else byTarget.set(t, [e])
  }
  if (byTarget.size === 0) return { reruns: [] }
  const taskRow = (
    await db
      .select({ snapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  const definition = taskRow ? parseDefinition(taskRow.snapshot) : null
  for (const [targetNodeId, group] of byTarget) {
    await assertSafeDispatchTarget(db, taskId, targetNodeId, group, definition)
  }

  // 5. Per target: atomic claim+mint (H2).
  const reruns: DispatchedRerun[] = []
  for (const [targetNodeId, group] of byTarget) {
    const groupIds = group.map((e) => e.id)
    const nodeRunId = await claimAndMint(db, taskId, targetNodeId, groupIds)
    if (nodeRunId !== null) reruns.push({ targetNodeId, nodeRunId, entryIds: groupIds })
  }

  log.info('task questions dispatched', {
    taskId,
    actorUserId: actor.userId,
    rerunCount: reruns.length,
    entryCount: groupEntries.length,
  })
  return { reruns }
}

/**
 * H3 guard (relaxed once run-scoped injection landed). A dispatchable handler
 * node must:
 *   (a) have a prior node_run to inherit — the mint inherits the freshest run;
 *       safe first-run minting for never-run targets is still the deferred F3
 *       item, so a never-run target is rejected; AND
 *   (b) carry the human answer. The GRAPH DESIGNER (its own rounds, has the
 *       __external_feedback__ edge) carries it via the graph path; an OVERRIDE
 *       target (a node with NO edge) carries it via the run-scoped path
 *       (buildRunScopedExternalFeedback). The ONLY remaining reject (besides
 *       never-run) is an override TO a node that ITSELF has a feedback edge — the
 *       scheduler routes edge nodes through the graph path, which wouldn't see the
 *       override-claimed round (overriding to another cross-clarify designer is
 *       v1-unsupported).
 */
async function assertSafeDispatchTarget(
  db: DbClient,
  taskId: string,
  targetNodeId: string,
  group: TaskQuestionRow[],
  definition: WorkflowDefinition | null,
): Promise<void> {
  const hasRun =
    (
      await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, targetNodeId)))
        .limit(1)
    )[0] !== undefined
  if (!hasRun) {
    throw new ConflictError(
      'task-question-unsafe-dispatch-target',
      `cannot dispatch to '${targetNodeId}': no prior node_run to inherit. Safe first-run minting for never-run targets is the next layer (RFC-120 §16 F3).`,
    )
  }
  // An entry is an OVERRIDE to this target when its graph designer (default) is a
  // different node. Such an entry rides the run-scoped path, which the scheduler
  // only takes for a node WITHOUT a feedback edge.
  const overridden = group.some((e) => e.defaultTargetNodeId !== targetNodeId)
  const hasFeedback =
    definition !== null && agentHasExternalFeedbackChannel(definition, targetNodeId)
  if (overridden && hasFeedback) {
    throw new ConflictError(
      'task-question-override-to-designer-unsupported',
      `cannot dispatch override to '${targetNodeId}': it is itself a cross-clarify designer (has an __external_feedback__ edge), so the scheduler routes it through the graph path which would not carry the overridden round. Override to a node that is NOT a cross-clarify designer (run-scoped injection), or reassign back to the graph designer.`,
    )
  }
}

/**
 * H2 — atomically claim the entry group + mint its rerun in ONE dbTxSync with a
 * PREALLOCATED run id. Returns the minted run id, or null when a concurrent
 * dispatcher won the group (its SELECT-still-NULL guard saw a short group →
 * rolled back: no stamp, no mint, no orphan). The minted row is field-identical
 * to triggerDesignerRerun's (inherits the freshest run, cause
 * 'cross-clarify-answer', retry_index = prior-max + 1, startedAt NULL).
 */
async function claimAndMint(
  db: DbClient,
  taskId: string,
  targetNodeId: string,
  groupIds: string[],
): Promise<string | null> {
  // Inheritance source read BEFORE the tx (async). assertSafeDispatchTarget has
  // already proven a prior run exists.
  const targetRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, targetNodeId)))
  const last = pickFreshestRun(targetRuns, { topLevelOnly: false })
  if (last === undefined) {
    throw new ConflictError(
      'task-question-unsafe-dispatch-target',
      `cannot dispatch to '${targetNodeId}': no prior node_run to inherit`,
    )
  }
  const topLevel = targetRuns.filter(
    (r) => r.parentNodeRunId === null && r.iteration === last.iteration,
  )
  const retryIndex = topLevel.length === 0 ? 0 : Math.max(...topLevel.map((r) => r.retryIndex)) + 1
  const preId = ulid()
  const now = Date.now()

  let minted = false
  try {
    dbTxSync(db, (tx) => {
      const stillNull = tx
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(and(inArray(taskQuestions.id, groupIds), isNull(taskQuestions.triggerRunId)))
        .all()
      if (stillNull.length !== groupIds.length) {
        // A concurrent dispatcher already claimed ≥1 of the group → abort the
        // whole group atomically (rollback): no stamp, no mint, no orphan.
        throw new ConcurrentClaim()
      }
      tx.update(taskQuestions)
        .set({ triggerRunId: preId, updatedAt: now })
        .where(and(inArray(taskQuestions.id, groupIds), isNull(taskQuestions.triggerRunId)))
        .run()
      // The RFC-098 WP-10 guard forbids direct node_runs inserts outside the mint
      // factory to prevent hand-copied inheritance drift. This site is exempt and
      // SAFE: (1) the row's fields come from buildMintNodeRunValues — the SAME
      // factory logic mintNodeRun uses, so there is zero hand-copied inheritance /
      // cause / born-running drift; (2) the insert MUST be synchronous to commit
      // atomically with the claim stamp inside this dbTxSync (the async mintNodeRun
      // would yield + commit early, defeating the H2 atomicity the claim+mint
      // depends on). The factory stays the single value-building authority; only the
      // insert STATEMENT lives here.
      // rfc098-allow-direct-node-run-insert
      tx.insert(nodeRuns)
        .values(
          buildMintNodeRunValues({
            id: preId,
            taskId,
            nodeId: targetNodeId,
            status: 'pending',
            cause: 'cross-clarify-answer',
            retryIndex,
            iteration: last.iteration,
            inheritFrom: last,
            overrides: { startedAt: null },
          }),
        )
        .run()
      minted = true
    })
  } catch (e) {
    if (e instanceof ConcurrentClaim) return null
    throw e
  }
  return minted ? preId : null
}
