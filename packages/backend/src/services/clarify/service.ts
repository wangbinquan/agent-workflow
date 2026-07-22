// RFC-217 T9 — unified clarify service (self + cross merged, kind-generalized).
//
// Replaces services/clarify.ts (RFC-023 self-clarify) + services/crossClarify.ts
// (RFC-056 cross-clarify), which were structural mirrors of each other over the
// SAME `clarify_rounds` table (single data source since T8, the real T17):
// per-kind create entry, per-kind DTO mappers (3+4 pair-copied helpers), and
// per-kind WS broadcast families. This module keys everything off `kind`:
//
//   - createClarifyRound(args) — discriminated-union entry. kind='self' keeps
//     the RFC-023 semantics (same-round run reuse keyed by (node, shard,
//     iteration), caller-provided round index, created-event title/taskName
//     enrichment). kind='cross' keeps RFC-056 semantics (iteration derived
//     max+1 per (node, loopIter), always mints a fresh parked run).
//   - rowToRound — the ONE row→DTO mapper (was selfRoundAsSession +
//     crossRoundAsSession + two rowToSession + two rowToSummary).
//   - broadcastClarifyAnsweredForRound(kind, …) — the ONE deferred-answer
//     re-emit (was broadcastSelfClarifyAnsweredForRound +
//     broadcastCrossClarifyAnsweredForRound).
//   - WS wire shapes are FROZEN (proposal §4 non-goal): the event type strings
//     ('clarify.*' vs 'cross-clarify.*') and their legacy-named payloads are
//     produced by private wire adapters from the unified DTO.
//
// Dead surface deleted with the merge (zero production callers; reads live in
// services/clarifyRounds.ts since T7, cleanup rides the tasks FK cascade, the
// scheduler has its own inline cross-clarify dispatch branch):
//   listClarifySummaries / getClarifyDetail / countPendingClarifications /
//   cleanupSessionsForTask / listCrossClarifySummaries / getCrossClarifyDetail /
//   cleanupCrossClarifySessionsForTask / dispatchCrossClarifyNode.
//
// Source-of-truth contracts (unchanged):
//   - `kind` on clarify_rounds is the only self/cross discriminator; the
//     per-kind status subsets are DB CHECK-enforced (migration 0031/0107).
//   - selectedOptionLabels is always reconstituted server-side from
//     selectedOptionIndices + question.options (sealAnswersServerSide).
//   - directive='stop' persistence is per questioner NODE
//     (task_node_clarify_directives, RFC-132 T7); resolveCrossNodeStopped is
//     the single oracle.
//   - terminatedAs (T9): DTO-level discriminator normalizing the self
//     'canceled' / cross 'abandoned' terminal statuses.

import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  ClarifyAnswerSchema,
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  findClarifyNodeForAgent,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
  terminatedAsForStatus,
  type ClarifyAnswer,
  type ClarifyCrossAgentNode,
  type ClarifyDirective,
  type ClarifyNode,
  type ClarifyQuestion,
  type ClarifyRoundStatus,
  type ClarifySession,
  type ClarifySessionSummary,
  type ClarifyTerminatedAs,
  type ClarifyTruncationWarning,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRuns, tasks } from '@/db/schema'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { getNodeClarifyDirectiveRow } from '@/services/taskClarifyDirective'
import { ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('clarify')

// ---------------------------------------------------------------------------
// Unified DTO
// ---------------------------------------------------------------------------

export type ClarifyRoundKind = 'self' | 'cross'

/** Service-layer round DTO — unified column vocabulary, parsed JSON fields. */
export interface ClarifyRoundDto {
  id: string
  taskId: string
  kind: ClarifyRoundKind
  /** Asking agent (self: source agent; cross: questioner). */
  askingNodeId: string
  askingNodeRunId: string
  askingShardKey: string | null
  /** Human-gate node (self: clarify node; cross: cross-clarify node). */
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  /** Cross only: designer resolved from the to_designer edge. NULL for self. */
  targetConsumerNodeId: string | null
  loopIter: number
  iteration: number
  questions: ClarifyQuestion[]
  answers?: ClarifyAnswer[]
  directive: ClarifyDirective | null
  status: ClarifyRoundStatus
  truncationWarnings?: ClarifyTruncationWarning[]
  designerRunTriggeredAt: number | null
  createdAt: number
  answeredAt: number | null
  answeredBy: string | null
  abandonedAt: number | null
  /** T9: normalized terminal discriminator ('canceled' self / 'abandoned' cross). */
  terminatedAs: ClarifyTerminatedAs | null
}

/** The ONE row→DTO mapper (replaces the 3+4 pair-copied self/cross mappers). */
export function rowToRound(r: typeof clarifyRounds.$inferSelect): ClarifyRoundDto {
  const out: ClarifyRoundDto = {
    id: r.id,
    taskId: r.taskId,
    kind: r.kind as ClarifyRoundKind,
    askingNodeId: r.askingNodeId,
    askingNodeRunId: r.askingNodeRunId ?? '',
    askingShardKey: r.askingShardKey,
    intermediaryNodeId: r.intermediaryNodeId,
    intermediaryNodeRunId: r.intermediaryNodeRunId ?? '',
    targetConsumerNodeId: r.targetConsumerNodeId,
    loopIter: r.loopIter,
    iteration: r.iteration,
    questions: safeParseArray<ClarifyQuestion>(r.questionsJson) ?? [],
    directive: r.directive,
    status: r.status as ClarifyRoundStatus,
    designerRunTriggeredAt: r.designerRunTriggeredAt,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
    answeredBy: r.answeredBy,
    abandonedAt: r.abandonedAt,
    terminatedAs: terminatedAsForStatus(r.status as ClarifyRoundStatus),
  }
  const answers = safeParseArray<ClarifyAnswer>(r.answersJson)
  if (answers !== undefined) out.answers = answers
  const warnings = safeParseArray<ClarifyTruncationWarning>(r.truncationWarningsJson)
  if (warnings !== undefined && warnings.length > 0) out.truncationWarnings = warnings
  return out
}

function safeParseArray<T>(json: string | null): T[] | undefined {
  if (json === null) return undefined
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as T[]) : undefined
  } catch {
    return undefined
  }
}

const kindIs = (kind: ClarifyRoundKind) => eq(clarifyRounds.kind, kind)

// ---------------------------------------------------------------------------
// createClarifyRound — kind-generalized runner-side entry point.
// ---------------------------------------------------------------------------

interface CreateRoundCommon {
  db: DbClient
  taskId: string
  /** Asking agent node id (self: source agent; cross: questioner). */
  askingNodeId: string
  /** node_runs.id of the asking agent's run. */
  askingNodeRunId: string
  /** Human-gate node id (self: clarify node; cross: cross-clarify node). */
  intermediaryNodeId: string
  /** Parsed questions from <workflow-clarify> (pre-validated at the runner). */
  questions: ClarifyQuestion[]
  /** Non-fatal parser warnings (option/question truncations). */
  truncationWarnings?: ClarifyTruncationWarning[]
  /** Defaults to Date.now(). Override for deterministic tests. */
  now?: () => number
}

export interface CreateSelfRoundArgs extends CreateRoundCommon {
  kind: 'self'
  /** Shard key when the asking run is an agent-multi shard child; null otherwise. */
  askingShardKey: string | null
  /** Caller-provided round index (matches the asking run's generation at ask time). */
  iteration: number
  /**
   * Parent node_run id passthrough for agent-multi shard cases so the minted
   * clarify run groups under the fan-out parent in the task detail view.
   */
  parentNodeRunId?: string | null
}

export interface CreateCrossRoundArgs extends CreateRoundCommon {
  kind: 'cross'
  /** Designer node id from the to_designer manual edge; null when unwired. */
  targetConsumerNodeId: string | null
  /** Wrapper-loop iteration index (0 outside loops). Round iteration is derived. */
  loopIter: number
}

export type CreateClarifyRoundArgs = CreateSelfRoundArgs | CreateCrossRoundArgs

export interface CreateClarifyRoundResult {
  round: ClarifyRoundDto
  /** node_runs.id of the human-gate node_run owning this round. */
  intermediaryNodeRunId: string
}

/**
 * Create a clarify_rounds row + the parked human-gate node_run that owns it.
 *
 * kind='self' (RFC-023): the gate run is keyed by (intermediaryNodeId,
 * askingShardKey, iteration) — a re-emit within the same round reuses the
 * prior parked run (park-human re-transition if needed); a new round mints
 * fresh. Broadcasts 'clarify.created' with taskName + node-title enrichment.
 *
 * kind='cross' (RFC-056): iteration is derived (latest existing for the same
 * (intermediaryNodeId, loopIter) + 1); a fresh gate run is always minted at
 * awaiting_human. Broadcasts 'cross-clarify.created'.
 */
export async function createClarifyRound(
  args: CreateClarifyRoundArgs,
): Promise<CreateClarifyRoundResult> {
  const now = args.now ?? Date.now

  // Defensive validation (self only): callers are expected to have already run
  // the envelope parser, but a stray code path could land here with raw
  // shapes — re-validate so the DB row is always round-trip-safe. Cross rounds
  // must NOT re-run this schema: RFC-056 §4.1 lifts the 5-question cap for
  // cross-clarify and the cross parser at the runner is the validation
  // authority (locked by scheduler-cross-clarify-dispatch '5-question cap').
  const questions =
    args.kind === 'self'
      ? ClarifyEnvelopeBodySchema.parse({ questions: args.questions }).questions
      : args.questions

  let intermediaryNodeRunId: string
  let iteration: number
  const createdAt = now()

  if (args.kind === 'self') {
    iteration = args.iteration
    const existingRun = await findSelfGateRunForShard(
      args.db,
      args.taskId,
      args.intermediaryNodeId,
      args.askingShardKey,
      iteration,
    )
    if (existingRun) {
      intermediaryNodeRunId = existingRun.id
      if (existingRun.status !== 'awaiting_human') {
        // RFC-053: park-human enforces pending|running → awaiting_human.
        await transitionNodeRunStatus({
          db: args.db,
          nodeRunId: intermediaryNodeRunId,
          event: { kind: 'park-human' },
          extra: { startedAt: existingRun.startedAt ?? now() },
        })
      }
    } else {
      // RFC-074 PR-C: the gate run carries no round counter — freshness is
      // pure id-order; the round index lives on the clarify_rounds row.
      intermediaryNodeRunId = await mintNodeRun(args.db, {
        taskId: args.taskId,
        nodeId: args.intermediaryNodeId,
        status: 'awaiting_human',
        cause: 'clarify-park',
        iteration: 0,
        overrides: {
          parentNodeRunId: args.parentNodeRunId ?? null,
          shardKey: args.askingShardKey,
          startedAt: createdAt,
        },
      })
    }
  } else {
    // Derived iteration: max(existing.iteration) + 1 in the same
    // (node, loopIter); 0 if no prior round for this loop_iter.
    const prior = await args.db
      .select({ iteration: clarifyRounds.iteration })
      .from(clarifyRounds)
      .where(
        and(
          kindIs('cross'),
          eq(clarifyRounds.taskId, args.taskId),
          eq(clarifyRounds.intermediaryNodeId, args.intermediaryNodeId),
          eq(clarifyRounds.loopIter, args.loopIter),
        ),
      )
      .orderBy(desc(clarifyRounds.iteration))
      .limit(1)
    iteration = prior.length === 0 ? 0 : (prior[0]?.iteration ?? 0) + 1

    // RFC-053: mint parked at awaiting_human directly so the runner doesn't
    // need a separate pending→awaiting_human leg.
    intermediaryNodeRunId = await mintNodeRun(args.db, {
      taskId: args.taskId,
      nodeId: args.intermediaryNodeId,
      status: 'awaiting_human',
      cause: 'cross-clarify-park',
      iteration: args.loopIter,
      overrides: { startedAt: createdAt },
    })
  }

  const roundId = ulid()
  const truncationWarningsJson =
    args.kind === 'self' && args.truncationWarnings && args.truncationWarnings.length > 0
      ? JSON.stringify(args.truncationWarnings)
      : null
  if (args.kind === 'cross' && args.truncationWarnings && args.truncationWarnings.length > 0) {
    log.warn('cross-clarify envelope truncated to limits', {
      sessionId: roundId,
      warnings: args.truncationWarnings.map((w) => w.code),
    })
  }

  await args.db.insert(clarifyRounds).values({
    id: roundId,
    taskId: args.taskId,
    kind: args.kind,
    askingNodeId: args.askingNodeId,
    askingNodeRunId: args.askingNodeRunId,
    askingShardKey: args.kind === 'self' ? args.askingShardKey : null,
    intermediaryNodeId: args.intermediaryNodeId,
    intermediaryNodeRunId,
    targetConsumerNodeId: args.kind === 'cross' ? args.targetConsumerNodeId : null,
    loopIter: args.kind === 'cross' ? args.loopIter : 0,
    iteration,
    questionsJson: JSON.stringify(questions),
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  const round: ClarifyRoundDto = {
    id: roundId,
    taskId: args.taskId,
    kind: args.kind,
    askingNodeId: args.askingNodeId,
    askingNodeRunId: args.askingNodeRunId,
    askingShardKey: args.kind === 'self' ? args.askingShardKey : null,
    intermediaryNodeId: args.intermediaryNodeId,
    intermediaryNodeRunId,
    targetConsumerNodeId: args.kind === 'cross' ? args.targetConsumerNodeId : null,
    loopIter: args.kind === 'cross' ? args.loopIter : 0,
    iteration,
    questions,
    directive: null,
    status: 'awaiting_human',
    designerRunTriggeredAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
    abandonedAt: null,
    terminatedAs: null,
  }
  if (args.kind === 'self' && args.truncationWarnings && args.truncationWarnings.length > 0) {
    round.truncationWarnings = args.truncationWarnings
  }

  if (args.kind === 'self') {
    // RFC-037: created-event enrichment — taskName + clarify node title, so
    // WS subscribers don't re-fetch the list to learn them. Missing task
    // (hard-delete race) degrades to ''; missing title stays null.
    const taskRow = await args.db
      .select({ name: tasks.name, workflowSnapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, args.taskId))
      .limit(1)
    const taskName = taskRow[0]?.name ?? ''
    const title = resolveNodeTitleFromSnapshot(
      taskRow[0]?.workflowSnapshot,
      args.intermediaryNodeId,
    )
    broadcastSelfCreated(round, taskName, title)
  } else {
    broadcastCrossCreated(round)
  }
  return { round, intermediaryNodeRunId }
}

async function findSelfGateRunForShard(
  db: DbClient,
  taskId: string,
  intermediaryNodeId: string,
  shardKey: string | null,
  iteration: number,
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  // RFC-074 PR-C: the gate run carries no round counter, so this round's
  // existing run is located via the clarify_rounds row that owns it — keyed
  // by (intermediaryNodeId, askingShardKey, iteration). A re-emit within the
  // same round finds the prior round row and reuses its run; a new round has
  // no row yet and falls through to a fresh mint.
  const roundRows = await db
    .select({ intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId })
    .from(clarifyRounds)
    .where(
      and(
        kindIs('self'),
        eq(clarifyRounds.taskId, taskId),
        eq(clarifyRounds.intermediaryNodeId, intermediaryNodeId),
        eq(clarifyRounds.iteration, iteration),
        shardKey === null
          ? isNull(clarifyRounds.askingShardKey)
          : eq(clarifyRounds.askingShardKey, shardKey),
      ),
    )
    .orderBy(asc(clarifyRounds.createdAt))
  const owningRunId = roundRows[0]?.intermediaryNodeRunId ?? undefined
  if (owningRunId === undefined) return undefined
  const runRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, owningRunId)).limit(1)
  return runRows[0]
}

/** Parse one node's title out of a task workflowSnapshot; undefined when absent. */
function resolveNodeTitleFromSnapshot(
  workflowSnapshotJson: string | undefined,
  nodeId: string,
): string | undefined {
  if (workflowSnapshotJson === undefined) return undefined
  try {
    const def = JSON.parse(workflowSnapshotJson) as WorkflowDefinition
    for (const node of def.nodes ?? []) {
      if (node.id !== nodeId) continue
      const title =
        typeof (node as Record<string, unknown>).title === 'string'
          ? ((node as Record<string, unknown>).title as string).trim()
          : ''
      return title.length > 0 ? title : undefined
    }
  } catch {
    // corrupt snapshot — degrade to no title.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// WS broadcasts — wire shapes FROZEN (legacy event types + legacy field names),
// produced from the unified DTO by these private adapters.
// ---------------------------------------------------------------------------

function toLegacySelfSession(round: ClarifyRoundDto): ClarifySession {
  const out: ClarifySession = {
    id: round.id,
    taskId: round.taskId,
    sourceAgentNodeId: round.askingNodeId,
    sourceAgentNodeRunId: round.askingNodeRunId,
    sourceShardKey: round.askingShardKey,
    clarifyNodeId: round.intermediaryNodeId,
    clarifyNodeRunId: round.intermediaryNodeRunId,
    iterationIndex: round.iteration,
    questions: round.questions,
    status: round.status as ClarifySession['status'],
    createdAt: round.createdAt,
    answeredAt: round.answeredAt,
    answeredBy: round.answeredBy,
    directive: round.directive,
  }
  if (round.answers !== undefined) out.answers = round.answers
  if (round.truncationWarnings !== undefined) out.truncationWarnings = round.truncationWarnings
  return out
}

function toLegacySelfSummary(
  round: ClarifyRoundDto,
  taskName: string,
  clarifyNodeTitle: string | undefined,
): ClarifySessionSummary {
  return {
    id: round.id,
    taskId: round.taskId,
    taskName,
    sourceAgentNodeId: round.askingNodeId,
    sourceAgentNodeTitle: null,
    sourceShardKey: round.askingShardKey,
    clarifyNodeId: round.intermediaryNodeId,
    clarifyNodeTitle: clarifyNodeTitle ?? null,
    clarifyNodeRunId: round.intermediaryNodeRunId,
    iterationIndex: round.iteration,
    questionCount: round.questions.length,
    status: round.status as ClarifySessionSummary['status'],
    createdAt: round.createdAt,
    answeredAt: round.answeredAt,
  }
}

function broadcastSelfCreated(
  round: ClarifyRoundDto,
  taskName: string,
  clarifyNodeTitle: string | undefined,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(round.taskId), {
    id: -1,
    type: 'clarify.created',
    nodeRunId: round.intermediaryNodeRunId,
    clarifyNodeId: round.intermediaryNodeId,
    sourceShardKey: round.askingShardKey,
    iterationIndex: round.iteration,
    session: toLegacySelfSummary(round, taskName, clarifyNodeTitle),
  })
}

function broadcastCrossCreated(round: ClarifyRoundDto): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(round.taskId), {
    id: -1,
    type: 'cross-clarify.created',
    nodeRunId: round.intermediaryNodeRunId,
    crossClarifyNodeId: round.intermediaryNodeId,
    sessionId: round.id,
    iteration: round.iteration,
    sourceQuestionerNodeId: round.askingNodeId,
    targetDesignerNodeId: round.targetConsumerNodeId,
  })
}

/**
 * RFC-128 P5-D — re-emit the legacy answered WS event(s) for a (now-answered)
 * round so OTHER clients invalidate clarify list/detail/pending-count +
 * node-runs after a DEFERRED quick answer (autoDispatchClarifyRound reuses the
 * legacy quick path's notification, which it otherwise bypasses). No-op unless
 * the round exists AND is answered.
 *
 * kind='self': emits 'clarify.answered' with `rerunNodeRunId` (the dispatched
 * self rerun, or '' when deferred to manual — the invalidation still fires).
 * kind='cross': emits 'cross-clarify.answered'; pass
 * `rejectedQuestionerNodeRunId` ONLY for a stop round to also fire
 * 'cross-clarify.rejected'.
 */
export async function broadcastClarifyAnsweredForRound(
  db: DbClient,
  kind: ClarifyRoundKind,
  intermediaryNodeRunId: string,
  opts: { rerunNodeRunId?: string; rejectedQuestionerNodeRunId?: string } = {},
): Promise<void> {
  const raw = (
    await db
      .select()
      .from(clarifyRounds)
      .where(and(kindIs(kind), eq(clarifyRounds.intermediaryNodeRunId, intermediaryNodeRunId)))
      .orderBy(desc(clarifyRounds.createdAt))
      .limit(1)
  )[0]
  if (raw === undefined) return
  const round = rowToRound(raw)
  if (round.status !== 'answered') return
  if (kind === 'self') {
    taskBroadcaster.broadcast(TASK_CHANNEL(round.taskId), {
      id: -1,
      type: 'clarify.answered',
      nodeRunId: round.intermediaryNodeRunId,
      clarifyNodeId: round.intermediaryNodeId,
      sourceShardKey: round.askingShardKey,
      iterationIndex: round.iteration,
      rerunNodeRunId: opts.rerunNodeRunId ?? '',
      session: toLegacySelfSession(round),
    })
    return
  }
  taskBroadcaster.broadcast(TASK_CHANNEL(round.taskId), {
    id: -1,
    type: 'cross-clarify.answered',
    nodeRunId: round.intermediaryNodeRunId,
    sessionId: round.id,
    iteration: round.iteration,
    directive: round.directive ?? 'continue',
  })
  if (opts.rejectedQuestionerNodeRunId !== undefined) {
    taskBroadcaster.broadcast(TASK_CHANNEL(round.taskId), {
      id: -1,
      type: 'cross-clarify.rejected',
      nodeRunId: round.intermediaryNodeRunId,
      sessionId: round.id,
      questionerNodeRunId: opts.rejectedQuestionerNodeRunId,
    })
  }
}

// ---------------------------------------------------------------------------
// evaluateDesignerRerunReadiness — cross multi-source aggregation.
// ---------------------------------------------------------------------------

export interface EvaluateDesignerRerunReadinessArgs {
  db: DbClient
  taskId: string
  designerNodeId: string
  definition: WorkflowDefinition
  /** Limit the readiness scan to a specific loop iteration. Non-loop = 0. */
  loopIter: number
  /**
   * RFC-128 P3 — origin node-run ids (= the round's intermediary run id, which
   * equals task_questions.origin_node_run_id) of the designer questions being
   * DISPATCHED right now. A per-question dispatch explicitly dispatches the
   * SEALED questions of these sources even while their round is still
   * awaiting_human (a partial seal), so a sibling whose latest round is one of
   * these is NOT counted as "pending". Other awaiting_human siblings still
   * gate the dispatch (golden lock: rfc120 H3/H2). Empty / omitted on the
   * immediate-submit path → byte-for-byte the pre-RFC-128 readiness.
   */
  dispatchedOrigins?: ReadonlySet<string>
}

export interface DesignerRerunReadinessSource {
  sessionId: string
  crossClarifyNodeId: string
  sourceQuestionerNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
  answers: ClarifyAnswer[]
}

export interface DesignerRerunReadiness {
  ready: boolean
  /** When ready=true, the directive='continue' sources that should feed the
   *  designer's External Feedback. directive='stop' / abandoned siblings are
   *  not included here even though they count toward "resolved". */
  sources: DesignerRerunReadinessSource[]
  /** When ready=false, the cross-clarify NodeIds still in awaiting_human. */
  pendingCrossClarifyNodeIds: string[]
}

/**
 * Determine whether `designerNodeId` is ready to rerun based on the latest
 * round (per cross-clarify NodeId, scoped to `loopIter`) of every sibling
 * cross-clarify node whose `to_designer` edge targets it.
 *
 * Readiness rule:
 *   ready ⟺ every sibling's latest round in this loop_iter has
 *           status ∈ {answered, abandoned}.
 *
 * Sources for the rerun:
 *   {latest where directive='continue' AND status='answered'}.
 *   directive='stop' / status='abandoned' siblings count as resolved but do
 *   NOT feed External Feedback.
 */
export async function evaluateDesignerRerunReadiness(
  args: EvaluateDesignerRerunReadinessArgs,
): Promise<DesignerRerunReadiness> {
  const siblingNodeIds = findCrossClarifyNodesPointingToDesigner(
    args.definition,
    args.designerNodeId,
  )
  // RFC-162 (correlation-readiness barrier reframe): a handler node with NO
  // cross-clarify to_designer sibling has NOTHING to correlate — immediately
  // READY (the reassign-added upstream/downstream reviser case). The N:1
  // barrier below still applies to GENUINE graph designers.
  if (siblingNodeIds.length === 0) {
    return { ready: true, sources: [], pendingCrossClarifyNodeIds: [] }
  }

  const sources: DesignerRerunReadinessSource[] = []
  const pending: string[] = []
  for (const nodeId of siblingNodeIds) {
    // Latest round for this (nodeId, loop_iter).
    const rawRows = await args.db
      .select()
      .from(clarifyRounds)
      .where(
        and(
          kindIs('cross'),
          eq(clarifyRounds.taskId, args.taskId),
          eq(clarifyRounds.intermediaryNodeId, nodeId),
          eq(clarifyRounds.loopIter, args.loopIter),
        ),
      )
      .orderBy(desc(clarifyRounds.iteration))
      .limit(1)
    const latest = rawRows[0] === undefined ? undefined : rowToRound(rawRows[0])
    if (latest === undefined) {
      pending.push(nodeId)
      continue
    }
    if (latest.status === 'awaiting_human') {
      // RFC-128 P3: a per-question dispatch explicitly dispatches THIS
      // source's sealed questions even though its round is still
      // awaiting_human (a partial seal) — not pending. Other awaiting_human
      // siblings still gate (golden lock H3/H2).
      if (args.dispatchedOrigins?.has(latest.intermediaryNodeRunId)) continue
      pending.push(nodeId)
      continue
    }
    // Already-consumed rounds (designerRunTriggeredAt set) do not feed again —
    // they were part of a prior batch. Skip them as "resolved" so we don't
    // re-trigger off a stale row when a single new sibling just submitted.
    if (latest.designerRunTriggeredAt !== null) {
      continue
    }
    if (latest.status === 'answered' && latest.directive === 'continue') {
      sources.push({
        sessionId: latest.id,
        crossClarifyNodeId: nodeId,
        sourceQuestionerNodeId: latest.askingNodeId,
        iteration: latest.iteration,
        questions: latest.questions,
        answers: latest.answers ?? [],
      })
    }
    // 'answered'+'stop' / 'abandoned' → resolved, no source contribution.
  }
  return {
    ready: pending.length === 0,
    sources,
    pendingCrossClarifyNodeIds: pending,
  }
}

export interface DispatchCrossClarifyResult {
  /** 'short-circuit-stop' = persistent stop hit, node_run forced done.
   *  'awaiting' = needs envelope from questioner; nothing to do, the runner
   *               will create a round when the questioner emits clarify.
   *  'no-questioner' = validator missed cross-clarify-input-source-missing;
   *                    caller surfaces the failure. */
  kind: 'short-circuit-stop' | 'awaiting' | 'no-questioner'
}

/**
 * Cross-clarify dispatch policy for an EXISTING pending node_run: when the
 * questioner node's persistent stop directive is set, transition the run
 * pending → done ('cross-clarify-persistent-stop') without parking — the
 * questioner's own cascade rerun runs through STOP CLARIFYING (RFC-056 S3
 * reject persistence). Otherwise no-op ('awaiting'): the runner parks a fresh
 * round when the questioner emits <workflow-clarify>.
 *
 * The scheduler's cross-clarify branch owns the surrounding orchestration
 * (live-row idempotency, missing-questioner mint+fail, WS broadcast) and
 * delegates the short-circuit transition here — single owner of the
 * transition + reason string.
 */
export async function dispatchCrossClarifyNode(args: {
  db: DbClient
  taskId: string
  crossClarifyNodeId: string
  /** node_runs.id being dispatched (must exist, typically 'pending'). */
  nodeRunId: string
  definition: WorkflowDefinition
}): Promise<DispatchCrossClarifyResult> {
  const questionerNodeId = findQuestionerNodeForCrossClarify(
    args.definition,
    args.crossClarifyNodeId,
  )
  if (questionerNodeId === undefined) {
    return { kind: 'no-questioner' }
  }
  const stopped = await resolveCrossNodeStopped(args.db, args.taskId, questionerNodeId)
  if (stopped) {
    await setNodeRunStatus({
      db: args.db,
      nodeRunId: args.nodeRunId,
      to: 'done',
      allowedFrom: ['pending'],
      reason: 'cross-clarify-persistent-stop',
      extra: { finishedAt: Date.now() },
    })
    return { kind: 'short-circuit-stop' }
  }
  return { kind: 'awaiting' }
}

/**
 * RFC-056 + RFC-123 + RFC-132 T7: should the cross-clarify NODE short-circuit
 * to done? The questioner node's node-level clarify directive
 * (`task_node_clarify_directives`) is the SINGLE source of truth. Both the
 * answer-stop path (sealRoundQuestions → setNodeClarifyDirective on the
 * questioner node) and the canvas toggle write it, so node last-write-wins
 * subsumes the old RFC-123 recency gate: a stale 'continue' followed by a
 * later answer-stop resolves to 'stop' (stopped); a toggle 'continue' after a
 * stop re-enables the questioner. No row or 'continue' ⇒ not stopped.
 */
export async function resolveCrossNodeStopped(
  db: DbClient,
  taskId: string,
  questionerNodeId: string,
): Promise<boolean> {
  return (await getNodeClarifyDirectiveRow(db, taskId, questionerNodeId))?.directive === 'stop'
}

// ---------------------------------------------------------------------------
// Answer sealing (shared by self quick path, seal path, dispatch path).
// ---------------------------------------------------------------------------

/** RFC-128 §7 — safe parse of a round's `answers_json` into a ClarifyAnswer[] for the
 *  per-question merge-write. Returns [] for NULL, malformed JSON, or a non-array payload
 *  (some fixtures seed a legacy '{}' placeholder; production seeds NULL). Keeping this
 *  tolerant means the merge boundary never throws on a virgin/legacy round (golden-lock:
 *  empty existing → merge returns the incoming subset unchanged). */
export function parseAnswersArray(json: string | null): ClarifyAnswer[] {
  if (json === null) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

/**
 * Rebuild selectedOptionLabels from selectedOptionIndices + question.options.
 * Clients post both fields; only the indices are trusted. This defends
 * against clients trying to inject custom labels (e.g. for prompt injection
 * attacks) when the underlying question never offered that string.
 *
 * Additionally drops indices that point outside the question's options
 * array and drops answers whose questionId is unknown to the round
 * (silently — the agent's next-round prompt will simply not see them).
 *
 * RFC-128 §1/§7: this is a pure SUBSET sealer — it validates+normalises exactly the
 * answers passed in (whether the whole round or a single question) and returns them;
 * per-question merging into the round's `answers_json` is the caller's job (via
 * mergeSealedAnswers). A non-array payload throws `clarify-answers-not-array`
 * (runtime guard, kept). An EMPTY array is a no-op that returns `[]` (NOT an error —
 * the loop simply doesn't run); this is locked by rfc128-p0-whole-round-seal-net.
 */
export function sealAnswersServerSide(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
): ClarifyAnswer[] {
  if (!Array.isArray(answers)) {
    throw new ValidationError('clarify-answers-not-array', 'answers payload must be an array')
  }
  const byId = new Map(questions.map((q) => [q.id, q]))
  const sealed: ClarifyAnswer[] = []
  for (const ans of answers) {
    const parsed = ClarifyAnswerSchema.safeParse(ans)
    if (!parsed.success) {
      throw new ValidationError(
        'clarify-answer-malformed',
        `answer for question '${ans?.questionId}': ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      )
    }
    const a = parsed.data
    const q = byId.get(a.questionId)
    if (q === undefined) {
      // Unknown question id — defensive drop. We don't throw because a
      // future migration that adds id renames shouldn't break old drafts.
      log.warn('clarify answer references unknown question id', { questionId: a.questionId })
      continue
    }
    const indices = a.selectedOptionIndices.filter((i) => i >= 0 && i < q.options.length)
    const labels = indices.map((i) => q.options[i]?.label ?? '').filter((s) => s.length > 0)
    sealed.push({
      questionId: a.questionId,
      selectedOptionIndices: indices,
      selectedOptionLabels: labels,
      customText: a.customText,
    })
  }
  return sealed
}

// ---------------------------------------------------------------------------
// Definition-level helpers (self) re-exported for runner / scheduler wiring.
// ---------------------------------------------------------------------------

/**
 * Find the clarify node wired to a given agent node by looking for an outbound
 * edge on the system port `__clarify__`. Returns undefined when the agent has
 * no clarify channel attached. Thin wrapper over shared/findClarifyNodeForAgent
 * so the backend can co-locate the lookup with its other clarify helpers.
 */
export function findClarifyNodeIdForAgent(
  definition: WorkflowDefinition,
  agentNodeId: string,
): string | undefined {
  return findClarifyNodeForAgent(definition, agentNodeId)
}

/** Returns the workflow node object for a clarify id, when present. */
export function findClarifyNode(
  definition: WorkflowDefinition,
  clarifyNodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((n) => n.id === clarifyNodeId && n.kind === 'clarify')
}

/**
 * RFC-026: parse a task's stored workflowSnapshot JSON and pull out the clarify
 * node by id. Returns undefined when the snapshot is malformed or the id isn't
 * present (e.g. workflow was edited after task launch and the snapshot is
 * stale in a way that drops the clarify node — falls back to isolated then).
 *
 * Kept narrow on purpose: callers want `resolveClarifySessionMode` access at
 * REST-handler time WITHOUT pulling the whole definition into scope.
 */
export function resolveClarifyNodeFromTaskSnapshot(
  workflowSnapshotJson: string,
  clarifyNodeId: string,
): ClarifyNode | undefined {
  let snap: unknown
  try {
    snap = JSON.parse(workflowSnapshotJson)
  } catch {
    return undefined
  }
  const nodes = (snap as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return undefined
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const rec = n as { id?: unknown; kind?: unknown }
    if (rec.kind !== 'clarify') continue
    if (rec.id !== clarifyNodeId) continue
    return n as ClarifyNode
  }
  return undefined
}

// Constants re-export for tests / runner wire-ups so callers don't pull
// directly from shared in two places.
export {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  ClarifyQuestionSchema,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  resolveCrossClarifySessionMode,
}
export type { ClarifyCrossAgentNode }
