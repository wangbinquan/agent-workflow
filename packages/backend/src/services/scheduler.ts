// DAG scheduler for one task.
//
// M3 added agent-multi (fan-out), wrapper-git, retries, pre-snapshot rollback,
// resume, and single-node retry. M4 P-4-01 + P-4-03 extend the scheduler with
//   - wrapper-loop iteration scheduling + 3 built-in exit conditions
//   - recursive "scope" execution so wrapper nesting works for any composition
//     (git-in-loop, loop-in-git, loop-in-loop, git-in-git)
//
// A "scope" is the set of node ids that execute under one parent — the top
// level is the root scope; each wrapper has an inner scope = its nodeIds[].
// The level-parallel scheduler operates on a scope at a time. Wrapper nodes
// live in their parent scope; when one is reached, the scheduler recurses
// into the wrapper's inner scope (once for wrapper-git, up to maxIterations
// times for wrapper-loop).

import type {
  Agent,
  ClarifyNode,
  Mcp,
  Plugin,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from '@agent-workflow/shared'
import {
  WorkflowDefinitionSchema,
  agentHasClarifyChannel,
  findClarifyNodeForAgent,
  resolveClarifySessionMode,
} from '@agent-workflow/shared'
import { and, asc, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, nodeRunEvents, nodeRunOutputs, nodeRuns, skills, tasks } from '@/db/schema'
import { resolveDependsClosure } from '@/services/agentDeps'
import { collectMcpNamesFromClosure, loadMcpsByNames } from '@/services/mcpClosure'
import { collectPluginNamesFromClosure, loadPluginsByNames } from '@/services/pluginClosure'
import {
  buildClarifyPromptContext,
  createClarifySession,
  findClarifyNode,
} from '@/services/clarify'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
  type ClarifyInlineFallbackReason,
} from '@/services/clarifyFallback'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import { buildReviewPromptContext, dispatchReviewNode } from '@/services/review'
import { runNode, type AgentOverrides, type ResolvedSkill, type RunResult } from '@/services/runner'
import { emitTaskStatus, getTask } from '@/services/task'
import { createLogger, type Logger } from '@/util/log'
import { splitDiffPerDirectory, splitDiffPerFile, splitDiffPerNFiles } from '@/util/diffSplit'
import { gitDiffSnapshot, gitStashSnapshot, rollbackToSnapshot, runGit } from '@/util/git'
import { Semaphore } from '@/util/semaphore'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

export interface RunTaskOptions {
  taskId: string
  db: DbClient
  appHome: string
  /** Override opencode binary command (tests inject mock-opencode). */
  opencodeCmd?: string[]
  log?: Logger
  /**
   * When aborted, any node currently running is SIGTERMed via runNode and the
   * task transitions to status=canceled. Subsequent nodes are not started.
   */
  signal?: AbortSignal
  /** Default per-node timeout in ms (from settings); node-level override wins. */
  defaultPerNodeTimeoutMs?: number
  /** Global concurrency limit for agent nodes within this task. Default 4. */
  maxConcurrentNodes?: number
  /** Concurrency cap for fan-out child subprocesses (P-3-02). Default 4. */
  multiProcessSubprocessConcurrency?: number
}

type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'exhausted'
  | 'awaiting_review'
  | 'awaiting_human'

interface SchedulerState {
  db: DbClient
  task: typeof tasks.$inferSelect
  taskId: string
  definition: WorkflowDefinition
  opts: RunTaskOptions
  log: Logger
  inputsMap: Record<string, string>
  globalSem: Semaphore
  writeSem: Semaphore
  subprocessSem: Semaphore
  /** nodeId → innermost wrapper id containing it. */
  containerOf: Map<string, string>
  /** Top-level scope set of node ids. */
  topLevelIds: Set<string>
}

/**
 * Drive one task from "pending" to a terminal status. Caller decides whether
 * to await this (tests) or fire-and-forget (HTTP route).
 */
export async function runTask(opts: RunTaskOptions): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = WorkflowDefinitionSchema.parse(raw)
  } catch (err) {
    await failTask(db, taskId, 'snapshot-invalid', (err as Error).message)
    return
  }

  // 3. Mark running.
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)

  // 4. Validate node kinds.
  for (const node of definition.nodes) {
    if (
      node.kind !== 'input' &&
      node.kind !== 'agent-single' &&
      node.kind !== 'agent-multi' &&
      node.kind !== 'output' &&
      node.kind !== 'wrapper-git' &&
      node.kind !== 'wrapper-loop' &&
      node.kind !== 'review' && // RFC-005
      node.kind !== 'clarify' // RFC-023
    ) {
      await failTask(
        db,
        taskId,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported`,
        node.id,
      )
      return
    }
  }

  // 5. Containment map (transitive — innermost wrapper wins).
  const containerOf = buildContainerMap(definition)
  const topLevelIds = new Set<string>()
  for (const n of definition.nodes) {
    if (!containerOf.has(n.id)) topLevelIds.add(n.id)
  }

  // 6. Pre-validate top-level scope for cycles (inner scopes are checked per
  //    recursive call). Output nodes are excluded — they don't execute.
  const topLevelOrder = topologicalOrder(
    definition.nodes.filter((n) => topLevelIds.has(n.id)),
    definition.edges,
    log,
  )
  if (topLevelOrder === null) {
    await failTask(db, taskId, 'workflow has a cycle outside any loop wrapper', 'cycle detected')
    return
  }

  // 7. Inputs map from launcher form.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  const state: SchedulerState = {
    db,
    task,
    taskId,
    definition,
    opts,
    log,
    inputsMap,
    globalSem: new Semaphore(opts.maxConcurrentNodes ?? 4),
    writeSem: new Semaphore(1),
    subprocessSem: new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4),
    containerOf,
    topLevelIds,
  }

  // 8. Drive the top-level scope.
  const result = await runScope(state, {
    scopeIds: topLevelIds,
    iteration: 0,
    log,
  })

  if (result.kind === 'failed' && result.detail) {
    await failTask(db, taskId, result.detail.summary, result.detail.message, result.detail.nodeId)
    return
  }
  if (result.kind === 'canceled') {
    await cancelTaskRow(db, taskId, result.detail?.nodeId)
    return
  }
  if (result.kind === 'awaiting_review') {
    // RFC-005: task pauses with status=awaiting_review until a decision lands
    // via REST. Decision handler will call resumeTask which re-enters here.
    await db.update(tasks).set({ status: 'awaiting_review' }).where(eq(tasks.id, taskId))
    await emitStatus(db, taskId)
    log.info('task awaiting human review', { taskId })
    return
  }
  if (result.kind === 'awaiting_human') {
    // RFC-023: an agent (or one or more agent-multi shard children) emitted a
    // <workflow-clarify> envelope. The clarify node_run is parked
    // awaiting_human; the source agent has no rerun row yet — that's
    // created when the user POSTs answers. Per design §7.3 awaiting_human
    // outranks awaiting_review on the task chip when both can fire at once.
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    await emitStatus(db, taskId)
    log.info('task awaiting human clarification', { taskId })
    return
  }

  // 9. Done.
  await db.update(tasks).set({ status: 'done', finishedAt: Date.now() }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
  log.info('task done', { taskId })
}

// -----------------------------------------------------------------------------
// scope execution
// -----------------------------------------------------------------------------

interface ScopeResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  detail?: { summary: string; message: string; nodeId?: string }
}

interface ScopeArgs {
  scopeIds: Set<string>
  iteration: number
  log: Logger
}

/**
 * Order two node_run rows by "freshness". The freshest row drives the node's
 * state in the scheduler (latestPerNode + rescan).
 *
 * Why this ordering specifically:
 *   - `clarifyIteration` is the user-facing counter that grows whenever the
 *     user answers a clarify session (submitClarifyAnswers mints retry=0 with
 *     clarifyIteration+1 to keep the process-retry budget intact). Putting it
 *     first means a fresh clarify rerun ALWAYS beats prior runs of the same
 *     node — even if process-retries previously inflated retryIndex above 0.
 *   - Within the same clarify round, higher retryIndex wins (newer process
 *     retry attempt).
 *   - When (clarifyIteration, retryIndex) tie — which CAN happen: e.g. an
 *     old round of clarifyIteration=1 plus a fresh rerun whose source's
 *     clarifyIteration was 0 collide at (0, 1) — ULID id is the monotonic
 *     tie-break; the newer insert wins. Without this tie-break the comparator
 *     is non-deterministic on ties.
 *
 * Locks in the fix for the bug where a directive=continue clarify rerun was
 * silently shadowed by a (retryIndex=N, clarifyIteration=0) done row from an
 * earlier single-node-retry storm, causing the task to be marked done while
 * the freshly-minted pending rerun row never ran.
 */
function isFresherNodeRun(
  candidate: typeof nodeRuns.$inferSelect,
  incumbent: typeof nodeRuns.$inferSelect | undefined,
): boolean {
  if (incumbent === undefined) return true
  if (candidate.clarifyIteration !== incumbent.clarifyIteration) {
    return candidate.clarifyIteration > incumbent.clarifyIteration
  }
  if (candidate.retryIndex !== incumbent.retryIndex) {
    return candidate.retryIndex > incumbent.retryIndex
  }
  return candidate.id > incumbent.id
}

async function runScope(state: SchedulerState, args: ScopeArgs): Promise<ScopeResult> {
  const { db, taskId, definition, opts } = state
  const { scopeIds, iteration, log } = args

  // Filter scope nodes (exclude output sinks — they don't run).
  const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id) && n.kind !== 'output')
  // Upstream map restricted to in-scope sources.
  const upstreamsOf = buildScopeUpstreams(scopeNodes, definition.edges)
  const remaining = new Map(scopeNodes.map((n) => [n.id, n]))
  const completed = new Set<string>()

  // P-3-08 resume: nodes whose latest run at THIS iteration is `done` are
  // pre-completed. Inner scopes additionally narrow by iteration so re-runs
  // start fresh per iteration.
  //
  // RFC-023: the "latest" comparator must put clarifyIteration first.
  // submitClarifyAnswers mints clarify reruns at retryIndex=0 (process-retry
  // budget intact) with clarifyIteration+1 — putting retryIndex first lets
  // a stale (retryIndex=N, clarifyIteration=0) done row from a prior single-
  // node-retry storm beat the fresh rerun. See isFresherNodeRun.
  const priorRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const latestPerNode = new Map<string, (typeof priorRuns)[number]>()
  for (const r of priorRuns) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue // skip fan-out child rows
    if (isFresherNodeRun(r, latestPerNode.get(r.nodeId))) {
      latestPerNode.set(r.nodeId, r)
    }
  }
  for (const [nodeId, r] of latestPerNode) {
    if (r.status === 'done') {
      completed.add(nodeId)
      remaining.delete(nodeId)
    }
  }

  // Cross-batch aggregation: collect awaiting / failure signals across every
  // batch instead of short-circuiting on the first failure. Background: a
  // wrapper-loop sibling failing fast used to swallow a parallel branch's
  // `awaiting_human` (RFC-023 bug 13). The new contract — "let each batch
  // finish, then decide based on priority canceled > awaiting_human >
  // awaiting_review > failed > ok" — matches the user's mental model that an
  // un-answered clarify cannot be silently lost just because another branch
  // exhausted its retry budget.
  let anyAwaitingReview = false
  let anyAwaitingHuman = false
  let awaitingReviewDetail: { summary: string; message: string; nodeId?: string } | undefined
  let awaitingHumanDetail: { summary: string; message: string; nodeId?: string } | undefined
  let firstFailureDetail: { summary: string; message: string; nodeId?: string } | undefined

  while (remaining.size > 0) {
    if (opts.signal?.aborted === true) {
      return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }
    }
    const ready: WorkflowNode[] = []
    for (const n of remaining.values()) {
      const ups = upstreamsOf.get(n.id) ?? []
      if (ups.every((u) => completed.has(u))) ready.push(n)
    }
    if (ready.length === 0) {
      // No ready nodes AND remaining is non-empty. Before declaring the
      // scope stalled, re-scan in case a clarify answer (or any other
      // out-of-band mutation) minted a fresh pending row for a node we
      // previously considered `done`. If rescan added at least one node
      // back to remaining, try again on the next loop iteration.
      const added = await rescanScopeForNewPendingRows(state, args, {
        scopeNodes,
        latestPerNode,
        completed,
        remaining,
      })
      if (added > 0) continue
      // If a prior batch parked a node in awaiting_human / awaiting_review,
      // the downstream is blocked WAITING for a human, not stalled. Bubble
      // the awaiting signal up so runTask can transition the task chip
      // cleanly. Without this branch the post-RFC-023-bug-13 refactor (which
      // moved the awaiting return out of the per-batch for-loop into the
      // end-of-scope priority block) breaks the agent-single happy-path
      // e2e: designer asks clarify, review_design has no completed upstream,
      // ready becomes empty, we'd otherwise fail the task with "scheduler
      // stalled" before the user ever sees the question.
      if (anyAwaitingHuman) {
        return { kind: 'awaiting_human', detail: awaitingHumanDetail }
      }
      if (anyAwaitingReview) {
        return { kind: 'awaiting_review', detail: awaitingReviewDetail }
      }
      // Genuine stall: no awaiting, no completable progress. Surface any
      // earlier per-node failure as the cause if one exists; otherwise
      // fall back to the generic stalled message.
      if (firstFailureDetail !== undefined) {
        return { kind: 'failed', detail: firstFailureDetail }
      }
      return {
        kind: 'failed',
        detail: { summary: 'scheduler stalled', message: 'no ready nodes in scope' },
      }
    }
    for (const n of ready) remaining.delete(n.id)

    const results = await Promise.all(
      ready.map((node) => runOneNode(state, { node, iteration, log })),
    )
    for (let i = 0; i < ready.length; i++) {
      const node = ready[i]!
      const r = results[i]!
      if (r.kind === 'ok') {
        completed.add(node.id)
        continue
      }
      if (r.kind === 'awaiting_review') {
        anyAwaitingReview = true
        awaitingReviewDetail = { summary: r.summary, message: r.message, nodeId: node.id }
        continue
      }
      if (r.kind === 'awaiting_human') {
        anyAwaitingHuman = true
        awaitingHumanDetail = { summary: r.summary, message: r.message, nodeId: node.id }
        continue
      }
      if (r.kind === 'canceled') {
        // canceled is the only hard short-circuit — the signal was tripped
        // explicitly by the user, so no point processing the remaining batch.
        return {
          kind: 'canceled',
          detail: { summary: r.summary, message: r.message, nodeId: node.id },
        }
      }
      // failed: record the first one for the eventual return value but
      // do NOT short-circuit; sibling branches may still need
      // awaiting_human / awaiting_review bubbled up to the user.
      if (firstFailureDetail === undefined) {
        firstFailureDetail = { summary: r.summary, message: r.message, nodeId: node.id }
      }
    }
    // RFC-023 bug 13: after every batch, re-scan node_runs from the DB. If a
    // user answered a clarify session mid-execution, `submitClarifyAnswers`
    // already minted a fresh `pending` row for the asking agent with a
    // higher `clarifyIteration`. Pull that node back into `remaining` so the
    // next loop iteration dispatches it — otherwise the orphaned row would
    // sit pending forever (scope's initial `latestPerNode` snapshot was
    // already stale).
    await rescanScopeForNewPendingRows(state, args, {
      scopeNodes,
      latestPerNode,
      completed,
      remaining,
    })
  }

  if (anyAwaitingHuman) {
    return { kind: 'awaiting_human', detail: awaitingHumanDetail }
  }
  if (anyAwaitingReview) {
    return { kind: 'awaiting_review', detail: awaitingReviewDetail }
  }
  if (firstFailureDetail !== undefined) {
    return { kind: 'failed', detail: firstFailureDetail }
  }
  return { kind: 'ok' }
}

/**
 * RFC-023 bug 13: rescan node_runs for the current task + iteration looking
 * for fresh rows whose (retryIndex, clarifyIteration) tuple beats whatever
 * `latestPerNode` cached at scope entry (or after the prior batch). When a
 * beating row is `pending`, the corresponding node is added back into
 * `remaining` (and pulled out of `completed` if it was there) so the
 * scheduler picks it up on the next batch — covering the "user answered a
 * clarify while the scope's `Promise.all` was still blocked on a sibling
 * branch" race. Returns the number of nodes added back to remaining so the
 * caller can decide whether to break a stall.
 */
async function rescanScopeForNewPendingRows(
  state: SchedulerState,
  args: ScopeArgs,
  ctx: {
    scopeNodes: WorkflowNode[]
    latestPerNode: Map<string, typeof nodeRuns.$inferSelect>
    completed: Set<string>
    remaining: Map<string, WorkflowNode>
  },
): Promise<number> {
  const { db, taskId } = state
  const { iteration, scopeIds } = args
  const fresh = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  let added = 0
  const newLatest = new Map<string, (typeof fresh)[number]>()
  for (const r of fresh) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, newLatest.get(r.nodeId))) {
      newLatest.set(r.nodeId, r)
    }
  }
  for (const [nodeId, row] of newLatest) {
    const cached = ctx.latestPerNode.get(nodeId)
    if (!isFresherNodeRun(row, cached)) continue
    ctx.latestPerNode.set(nodeId, row)
    if (row.status === 'pending') {
      ctx.completed.delete(nodeId)
      if (!ctx.remaining.has(nodeId)) {
        const node = ctx.scopeNodes.find((n) => n.id === nodeId)
        if (node !== undefined) {
          ctx.remaining.set(nodeId, node)
          added += 1
        }
      }
    }
  }
  return added
}

// -----------------------------------------------------------------------------
// per-node execution
// -----------------------------------------------------------------------------

interface OneNodeResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  summary: string
  message: string
}

interface OneNodeArgs {
  node: WorkflowNode
  iteration: number
  log: Logger
}

async function runOneNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, inputsMap, globalSem, writeSem, log } = state
  const { node, iteration } = args

  if (opts.signal?.aborted === true) {
    return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
  }
  if (node.kind === 'output') return { kind: 'ok', summary: '', message: '' }

  if (node.kind === 'wrapper-git') {
    return runGitWrapperNode(state, args)
  }
  if (node.kind === 'wrapper-loop') {
    return runLoopWrapperNode(state, args)
  }

  if (node.kind === 'review') {
    // RFC-005: review node dispatch. Reads upstream port, archives current
    // version to doc_versions (file + DB row), parks the node in
    // status=awaiting_review. The review service module owns the lifecycle;
    // scheduler only routes here so dispatch stays per-kind.
    return dispatchReviewNode({
      db,
      taskId,
      task,
      appHome: opts.appHome,
      definition,
      node,
      iteration,
    })
  }

  if (node.kind === 'clarify') {
    // RFC-023: clarify nodes are not actively scheduled — they're activated
    // by the runner when the asking agent emits <workflow-clarify>. If the
    // scheduler reaches a clarify node directly (as part of its dataflow
    // graph), it is a no-op pass: ready signals from upstream agents are
    // routed through createClarifySession instead. Mark this graph-level
    // visit done so downstream nodes (typically the answers→agent edge
    // marking the clarify node "complete" in the canvas) can proceed once a
    // session is closed.
    return { kind: 'ok', summary: '', message: '' }
  }

  if (node.kind === 'input') {
    const inputKey = pickString(node, 'inputKey')
    if (inputKey === null) {
      return {
        kind: 'failed',
        summary: `input node ${node.id} missing inputKey`,
        message: 'invalid',
      }
    }
    const value = inputsMap[inputKey] ?? ''
    const nrId = await insertNodeRun(db, taskId, node.id, 'done', 0, iteration)
    // RFC-004: an input node's single output port is named after its inputKey,
    // so edges authored on the canvas (whose source.portName defaults to the
    // visible handle label = inputKey) actually resolve. Previously hardcoded
    // to 'out', which mismatched every workflow created through the editor.
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: inputKey, content: value })
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  const agentName = pickString(node, 'agentName')
  if (agentName === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing agentName`,
      message: 'invalid agent node',
    }
  }
  const agent = await loadAgent(db, agentName)
  if (agent === null) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }

  if (node.kind === 'agent-multi') {
    return runFanOutNode(state, args, agent)
  }

  const upstreamInputs = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
  // RFC-022: expand the agent.dependsOn closure before resolving skills so
  // closure-member skills get unioned into the same OPENCODE_CONFIG_DIR
  // staging dir. A cycle / missing-dep here is fatal — the agent.ts save
  // guard normally prevents it; hitting one at runtime implies an external
  // SQL edit or a race against another writer. Fail loudly instead of
  // silently spawning with a broken closure.
  const injection = await prepareNodeRunInjection(db, opts.appHome, agent, log)
  if (injection.kind === 'failed') return injection
  const { dependents, resolvedSkills, mcps, plugins } = injection
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const maxRetries = pickNumber(node, 'retries') ?? 0
  const nodeOverrides = pickOverrides(node)

  // RFC-005: when this node is being re-run because a downstream review node
  // was rejected/iterated, surface the rendered comments / rejection reason
  // through the {{__review_comments__}} / {{__review_rejection__}} tokens.
  // Returns undefined for first runs and for runs whose latest downstream
  // decision is approve/pending — see buildReviewPromptContext.
  const reviewContext = await buildReviewPromptContext(db, opts.appHome, node.id, taskId, iteration)
  // RFC-023: when this node has a clarify channel wired AND a clarify_iteration
  // > 0, surface the last-round Q&A through {{__clarify_*}} tokens / auto-
  // appended sections. The protocol block is appended by the runner when
  // hasClarifyChannel is true, regardless of whether there's prior context
  // (the agent needs to know it MAY ask back even on the first round).
  const hasClarifyChannel = agentHasClarifyChannel(definition, node.id)

  // Pick up an existing pending node_run at this iteration; otherwise create
  // a fresh run with retry_index = max-existing-in-iter + 1 (or 0).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  let retryIndex = 0
  let nodeRunId: string
  // RFC-023: latest existing row drives clarify/review/shard inheritance for
  // every fresh row we mint below (single-node retry-from-interrupted, resume
  // of an interrupted clarify rerun, and the process-retry inner loop). Using
  // isFresherNodeRun matches the comparator that latestPerNode uses upstream,
  // so the inherited round is always the one the scheduler is about to treat
  // as authoritative.
  let latestExisting: (typeof sameNodeIterRuns)[number] | undefined
  for (const r of sameNodeIterRuns) {
    if (r.parentNodeRunId !== null) continue // skip fan-out children
    if (isFresherNodeRun(r, latestExisting)) latestExisting = r
  }
  const inheritedClarifyIteration = latestExisting?.clarifyIteration ?? 0
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  const pendingExisting = sameNodeIterRuns.find(
    (r) => r.status === 'pending' && r.parentNodeRunId === null,
  )
  if (pendingExisting !== undefined) {
    nodeRunId = pendingExisting.id
    retryIndex = pendingExisting.retryIndex
  } else {
    retryIndex =
      sameNodeIterRuns.length === 0 ? 0 : Math.max(...sameNodeIterRuns.map((r) => r.retryIndex)) + 1
    nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', retryIndex, iteration, {
      clarifyIteration: inheritedClarifyIteration,
      reviewIteration: inheritedReviewIteration,
      shardKey: inheritedShardKey,
      parentNodeRunId: inheritedParentNodeRunId,
    })
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  const releaseGlobal = await globalSem.acquire()
  const releaseWrite = agent.readonly ? null : await writeSem.acquire()

  let lastResult: RunResult | null = null
  let lastError: string | null = null

  try {
    for (let attempt = retryIndex; attempt <= retryIndex + maxRetries; attempt++) {
      if (attempt > retryIndex) {
        const snap = await readSnapshotForLatestRun(db, taskId, node.id, iteration)
        if (!agent.readonly && snap !== '') {
          try {
            await rollbackToSnapshot(task.worktreePath, snap)
          } catch (err) {
            log.warn('retry rollback failed', {
              nodeId: node.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        // RFC-023: process-retry within the same clarify round must keep the
        // same clarifyIteration so the next attempt's prompt still surfaces
        // the answered Q&A. shardKey / parentNodeRunId likewise belong to
        // this run-of-the-node and must persist across attempts.
        nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', attempt, iteration, {
          clarifyIteration: inheritedClarifyIteration,
          reviewIteration: inheritedReviewIteration,
          shardKey: inheritedShardKey,
          parentNodeRunId: inheritedParentNodeRunId,
        })
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
      }

      if (!agent.readonly) {
        try {
          const sha = await gitStashSnapshot(task.worktreePath)
          await db.update(nodeRuns).set({ preSnapshot: sha }).where(eq(nodeRuns.id, nodeRunId))
        } catch (err) {
          log.warn('pre-snapshot failed', {
            nodeRunId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      try {
        // RFC-023: read this row's clarifyIteration so the prompt context
        // surfaces the prior round's Q&A. The row may have been minted at
        // any of three sites (pendingExisting, retry-mint, clarify-rerun
        // mint from clarify service); reading off the DB guarantees we see
        // whatever each path set.
        const currentRunRow = (
          await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
        )[0]
        const currentClarifyIteration = currentRunRow?.clarifyIteration ?? 0
        const currentShardKey = currentRunRow?.shardKey ?? null

        // RFC-026: resolve sessionMode from the clarify node attached to this
        // agent (if any). `inline` only takes effect when the current run is
        // a clarify-driven rerun (clarifyIteration > 0 AND retryIndex === 0):
        //   - clarifyIteration === 0  → first run, no prior session to resume
        //   - retryIndex > 0          → technical retry within same clarify
        //     round; design.md §7 forbids inline on retries to keep retry
        //     behavior deterministic when something went wrong mid-session
        const clarifyNodeForGate = hasClarifyChannel
          ? findClarifyNodeForAgent(definition, node.id)
          : undefined
        const clarifyNodeObjForGate = clarifyNodeForGate
          ? (findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
          : undefined
        const sessionMode = clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
        const isClarifyRerun = currentClarifyIteration > 0 && (currentRunRow?.retryIndex ?? 0) === 0
        const priorSessionId = isClarifyRerun
          ? await readPriorAgentSessionId(db, {
              taskId,
              agentNodeId: node.id,
              shardKey: currentShardKey,
              priorIterationIndex: currentClarifyIteration - 1,
            })
          : null
        // RFC-026 fallback reasons recorded via `recordClarifyInlineEvent`
        // below:
        //   - 'missing-session-id'           — decideResumeSessionId, pre-spawn
        //   - 'session-not-found'            — stderr inspection, post-spawn
        //   - 'unsupported-opencode-version' — reserved for the daemon version
        //                                      probe (not yet wired here; see
        //                                      design.md §15)
        const resumeDecision = decideResumeSessionId({
          sessionMode: isClarifyRerun ? sessionMode : 'isolated',
          sourceSessionId: priorSessionId,
        })
        if (resumeDecision.fallbackReason !== undefined) {
          await recordClarifyInlineEvent(db, nodeRunId, {
            level: 'warning',
            reason: resumeDecision.fallbackReason,
            extra: { clarifyIteration: currentClarifyIteration },
          })
        }

        const clarifyContext = hasClarifyChannel
          ? await buildClarifyPromptContext({
              db,
              definition,
              taskId,
              agentNodeId: node.id,
              targetIteration: currentClarifyIteration,
              shardKey: currentShardKey,
              ...(resumeDecision.inlineMode ? { sessionMode: 'inline' as const } : {}),
            })
          : undefined
        // RFC-023 directive iteration: when the last answered session was
        // submitted with directive='stop', this single rerun MUST NOT see
        // the <workflow-clarify> protocol block — the answersBlock already
        // carries the stop-clarifying sentence the agent reads instead.
        // Retries inside this attempt loop inherit the same gate. The next
        // round (clarifyIteration + 1) walks back through scheduleAgentNode
        // and re-derives the flag, so 'stop' naturally scopes to one rerun.
        const effectiveHasClarifyChannel = hasClarifyChannel && clarifyContext?.directive !== 'stop'
        if (resumeDecision.inlineMode && resumeDecision.resumeSessionId !== undefined) {
          await recordClarifyInlineEvent(db, nodeRunId, {
            level: 'info',
            sessionIdPrefix: resumeDecision.resumeSessionId.slice(0, 8),
            extra: { clarifyIteration: currentClarifyIteration },
          })
        }
        lastResult = await runNode({
          taskId,
          nodeRunId,
          agent,
          inputs: upstreamInputs,
          worktreePath: task.worktreePath,
          templateMeta: {
            repoPath: task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: node.id,
            iteration,
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          ...(reviewContext !== undefined ? { reviewContext } : {}),
          ...(clarifyContext !== undefined ? { clarifyContext } : {}),
          ...(nodeOverrides !== undefined ? { overrides: nodeOverrides } : {}),
          ...(resumeDecision.resumeSessionId !== undefined
            ? { resumeSessionId: resumeDecision.resumeSessionId }
            : {}),
          hasClarifyChannel: effectiveHasClarifyChannel,
          skills: resolvedSkills,
          dependents,
          mcps,
          plugins,
          appHome: opts.appHome,
          ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
          db,
          log: log.child('run'),
          ...(opts.signal ? { signal: opts.signal } : {}),
        })

        // RFC-026: persist opencode session id captured from the JSON event
        // stream so the NEXT clarify-driven rerun on this lineage can pass
        // it back via `--session`. NULL on failed / canceled runs is fine.
        if (lastResult.sessionId !== undefined && lastResult.sessionId !== '') {
          await db
            .update(nodeRuns)
            .set({ opencodeSessionId: lastResult.sessionId })
            .where(eq(nodeRuns.id, nodeRunId))
        }
        // RFC-026: post-spawn fallback — opencode rejected the resume id we
        // passed. Treat the run as a fail-soft signal: leave the failure to
        // surface naturally (status will be 'failed' or have empty outputs),
        // but log a warning so operators can see WHY. The next retry within
        // this attempt loop will not carry resumeSessionId (we only set it
        // on the first attempt of a clarify rerun).
        if (resumeDecision.inlineMode && lastResult.status !== 'done') {
          const stderrText = await readStderrText(db, nodeRunId)
          if (detectSessionNotFoundFromStderr(stderrText)) {
            await recordClarifyInlineEvent(db, nodeRunId, {
              level: 'warning',
              reason: 'session-not-found',
              extra: { clarifyIteration: currentClarifyIteration },
            })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        lastResult = {
          status: 'failed',
          exitCode: null,
          outputs: {},
          tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
          prompt: '',
          errorMessage: `node ${node.id} threw: ${msg}`,
        }
        lastError = msg
      }

      broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)
      if (lastResult.status === 'done' || lastResult.status === 'canceled') break
    }
  } finally {
    releaseWrite?.()
    releaseGlobal()
  }

  if (lastResult === null) {
    return {
      kind: 'failed',
      summary: 'node produced no result',
      message: lastError ?? 'unknown',
    }
  }
  if (lastResult.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: lastResult.errorMessage ?? 'canceled',
    }
  }
  if (lastResult.status !== 'done') {
    return {
      kind: 'failed',
      summary: lastResult.errorMessage ?? `node ${node.id} ${lastResult.status}`,
      message: lastResult.errorMessage ?? lastResult.status,
    }
  }
  // RFC-023: when the agent reply was a <workflow-clarify> envelope, runner
  // returns status='done' AND populates result.clarify. The scheduler is the
  // only piece with access to the workflow definition, so it owns mapping
  // the asking agent → clarify node id and parking the clarify node_run
  // awaiting_human. After this returns 'awaiting_human', the scope loop
  // bubbles up and the task transitions to status='awaiting_human' until the
  // user POSTs answers via /api/clarify.
  if (lastResult.clarify !== undefined) {
    const clarifyNodeId = findClarifyNodeForAgent(definition, node.id)
    if (clarifyNodeId === undefined) {
      // Agent emitted clarify but has no clarify channel — protocol abuse.
      return {
        kind: 'failed',
        summary: `agent ${agent.name} emitted <workflow-clarify> but node ${node.id} has no clarify channel`,
        message: 'clarify-no-channel',
      }
    }
    const currentRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
    )[0]
    await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: node.id,
      sourceAgentNodeRunId: nodeRunId,
      sourceShardKey: currentRunRow?.shardKey ?? null,
      clarifyNodeId,
      iterationIndex: currentRunRow?.clarifyIteration ?? 0,
      questions: lastResult.clarify.questions,
      ...(lastResult.clarify.truncationWarnings.length > 0
        ? { truncationWarnings: lastResult.clarify.truncationWarnings }
        : {}),
    })
    return {
      kind: 'awaiting_human',
      summary: `agent ${node.id} asked back via clarify node ${clarifyNodeId}`,
      message: 'clarify-awaiting-human',
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}

// -----------------------------------------------------------------------------
// wrapper-loop (P-4-01)
// -----------------------------------------------------------------------------

async function runLoopWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId } = state
  const { node, iteration: parentIteration } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }
  const maxIter = pickNumber(node, 'maxIterations')
  if (maxIter === undefined || maxIter < 1) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} missing maxIterations`,
      message: 'wrapper-loop-max-iterations',
    }
  }
  const cond = parseExitCondition((node as Record<string, unknown>).exitCondition)
  if (cond === null) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} invalid exitCondition`,
      message: 'wrapper-loop-exit-condition',
    }
  }
  const bindings = readBindings(node, 'outputBindings')

  const wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, parentIteration)
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')

  const innerSet = new Set(inner)
  for (let i = 0; i < maxIter; i++) {
    const subRes = await runScope(state, {
      scopeIds: innerSet,
      iteration: i,
      log: args.log.child(`loop:${node.id}`),
    })
    if (subRes.kind === 'canceled') {
      await db
        .update(nodeRuns)
        .set({ status: 'canceled', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
      return { kind: 'canceled', summary: subRes.detail?.summary ?? 'canceled', message: '' }
    }
    if (subRes.kind === 'failed') {
      await db
        .update(nodeRuns)
        .set({
          status: 'failed',
          finishedAt: Date.now(),
          errorMessage: subRes.detail?.message ?? 'inner failed',
        })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: subRes.detail?.summary ?? `wrapper-loop ${node.id} inner failed`,
        message: subRes.detail?.message ?? 'inner failed',
      }
    }

    // Evaluate exit condition against the current iteration's outputs.
    const portContent = await readPortAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, portContent)) {
      // Bind outputs from this iteration.
      for (const b of bindings) {
        const v = await readPortAtIteration(db, taskId, b.bind.nodeId, b.bind.portName, i)
        await db
          .insert(nodeRunOutputs)
          .values({ nodeRunId: wrapperRunId, portName: b.name, content: v })
      }
      await db
        .update(nodeRuns)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
      return { kind: 'ok', summary: '', message: '' }
    }
  }

  // Exhausted: max iterations without exit.
  await db
    .update(nodeRuns)
    .set({ status: 'exhausted', finishedAt: Date.now(), errorMessage: 'max iterations reached' })
    .where(eq(nodeRuns.id, wrapperRunId))
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'exhausted')
  return {
    kind: 'failed',
    summary: `wrapper-loop ${node.id} exhausted after ${maxIter} iterations`,
    message: 'wrapper-loop-exhausted',
  }
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03)
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop).
// -----------------------------------------------------------------------------

async function runGitWrapperNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId } = state
  const { node, iteration } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-git ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  const wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')

  // Baseline = HEAD of the worktree right before inner runs.
  let baseline = ''
  try {
    const r = await runGit(task.worktreePath, ['rev-parse', 'HEAD'])
    if (r.exitCode === 0) baseline = r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }

  // Recurse into inner scope.
  const subRes = await runScope(state, {
    scopeIds: new Set(inner),
    iteration,
    log: args.log.child(`git:${node.id}`),
  })
  if (subRes.kind === 'canceled') {
    await db
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, wrapperRunId))
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
    return { kind: 'canceled', summary: 'inner canceled', message: '' }
  }
  if (subRes.kind === 'failed') {
    await db
      .update(nodeRuns)
      .set({
        status: 'failed',
        finishedAt: Date.now(),
        errorMessage: subRes.detail?.message ?? 'inner failed',
      })
      .where(eq(nodeRuns.id, wrapperRunId))
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: subRes.detail?.summary ?? `wrapper-git ${node.id} inner failed`,
      message: subRes.detail?.message ?? 'inner failed',
    }
  }

  // Compute diff vs baseline (or HEAD as fallback when worktree was empty).
  let diff = ''
  try {
    diff = await gitDiffSnapshot(task.worktreePath, baseline || 'HEAD')
  } catch {
    diff = ''
  }
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: wrapperRunId, portName: 'git_diff', content: diff })
  await db
    .update(nodeRuns)
    .set({ status: 'done', finishedAt: Date.now() })
    .where(eq(nodeRuns.id, wrapperRunId))
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

// -----------------------------------------------------------------------------
// fan-out (P-3-02), kept structurally identical to M3 except for iteration.
// -----------------------------------------------------------------------------

async function runFanOutNode(
  state: SchedulerState,
  args: OneNodeArgs,
  agent: Agent,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, subprocessSem, log } = state
  const { node, iteration } = args

  const sourcePort = (node as Record<string, unknown>).sourcePort as
    | { nodeId?: unknown; portName?: unknown }
    | undefined
  if (
    sourcePort === undefined ||
    typeof sourcePort.nodeId !== 'string' ||
    typeof sourcePort.portName !== 'string'
  ) {
    return {
      kind: 'failed',
      summary: `agent-multi node ${node.id} missing sourcePort`,
      message: 'sourcePort required',
    }
  }

  // Latest source-node run not narrower than current iteration; prefer in-iter
  // run, otherwise fall back to most recent run from a prior iteration.
  const sourceRun = await pickLatestSourceRun(db, taskId, sourcePort.nodeId as string, iteration)
  if (sourceRun === null) {
    return {
      kind: 'failed',
      summary: `agent-multi node ${node.id} sourcePort ${sourcePort.nodeId as string} has no completed run`,
      message: 'source-not-ready',
    }
  }
  const sourceOuts = await db
    .select()
    .from(nodeRunOutputs)
    .where(
      and(
        eq(nodeRunOutputs.nodeRunId, sourceRun.id),
        eq(nodeRunOutputs.portName, sourcePort.portName as string),
      ),
    )
  const sourceContent = sourceOuts[0]?.content ?? ''

  const parentRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
  broadcastNodeStatus(taskId, parentRunId, node.id, 'running')

  if (sourceContent.trim() === '') {
    for (const port of agent.outputs) {
      await db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: parentRunId, portName: port, content: '' })
    }
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: parentRunId, portName: 'errors', content: '' })
    await db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, parentRunId))
    broadcastNodeStatus(taskId, parentRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  const strategy = (node as Record<string, unknown>).shardingStrategy as
    | { kind: 'per-file' }
    | { kind: 'per-n-files'; n: number }
    | { kind: 'per-directory'; depth?: number }
    | undefined
  let shards
  try {
    if (strategy === undefined || strategy.kind === 'per-file') {
      shards = splitDiffPerFile(sourceContent)
    } else if (strategy.kind === 'per-n-files') {
      shards = splitDiffPerNFiles(sourceContent, strategy.n)
    } else {
      shards = splitDiffPerDirectory(sourceContent, strategy.depth ?? 1)
    }
  } catch (err) {
    return {
      kind: 'failed',
      summary: `shard split failed for node ${node.id}`,
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const upstreamInputs = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
  // RFC-022: same closure expansion as the single-agent path — every shard
  // subprocess gets the full closure + skills union (design.md §4.2 #2).
  const injection = await prepareNodeRunInjection(db, opts.appHome, agent, log)
  if (injection.kind === 'failed') return injection
  const { dependents, resolvedSkills, mcps, plugins } = injection
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const nodeOverrides = pickOverrides(node)
  // RFC-005 review-driven re-run context — same plumbing as the single-agent
  // path. Each shard child inherits the parent fan-out node's review context
  // so an iterate decision pinned to the aggregator's port re-feeds review
  // comments to every spawned child on the next pass.
  const reviewContext = await buildReviewPromptContext(db, opts.appHome, node.id, taskId, iteration)

  interface ChildResult {
    shardKey: string
    runId: string
    status: RunResult['status']
    outputs: Record<string, string>
    errorMessage?: string
    /** RFC-023: when set, this shard's child agent asked back. The aggregate
     *  pass below skips its outputs and surfaces 'awaiting_human' on the
     *  parent. */
    clarifyAwaiting?: boolean
  }

  const hasClarifyChannel = agentHasClarifyChannel(definition, node.id)
  const clarifyNodeIdForFanout = hasClarifyChannel
    ? findClarifyNodeForAgent(definition, node.id)
    : undefined

  const children = await Promise.all(
    shards.map((shard) =>
      subprocessSem.run<ChildResult>(async () => {
        const childRunId = ulid()
        await db.insert(nodeRuns).values({
          id: childRunId,
          taskId,
          nodeId: node.id,
          status: 'pending',
          retryIndex: 0,
          iteration,
          parentNodeRunId: parentRunId,
          shardKey: shard.shardKey,
          startedAt: Date.now(),
        })
        broadcastNodeStatus(taskId, childRunId, node.id, 'pending')

        const shardInputs: Record<string, string> = {
          ...upstreamInputs,
          [sourcePort.portName as string]: shard.content,
        }
        try {
          // RFC-023: per-shard clarify context — surfaces this shard's prior
          // round Q&A (if any) without bleeding shards into each other.
          const clarifyContext = hasClarifyChannel
            ? await buildClarifyPromptContext({
                db,
                definition,
                taskId,
                agentNodeId: node.id,
                targetIteration: 0, // first run; rerun rows are minted by clarify service
                shardKey: shard.shardKey,
              })
            : undefined
          // RFC-023 directive iteration: stop suppresses the protocol block
          // for the shard's rerun (clarify service mints a fresh per-shard
          // run before calling resumeTask, so this branch only sees stop
          // when the new run inherits an answered session with directive=stop).
          const effectiveHasClarifyChannel =
            hasClarifyChannel && clarifyContext?.directive !== 'stop'
          const result = await runNode({
            taskId,
            nodeRunId: childRunId,
            agent,
            inputs: shardInputs,
            worktreePath: task.worktreePath,
            templateMeta: {
              repoPath: task.repoPath,
              baseBranch: task.baseBranch,
              taskId,
              nodeId: node.id,
              iteration,
              shardKey: shard.shardKey,
            },
            ...(promptTemplate !== undefined ? { promptTemplate } : {}),
            ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
            ...(reviewContext !== undefined ? { reviewContext } : {}),
            ...(clarifyContext !== undefined ? { clarifyContext } : {}),
            ...(nodeOverrides !== undefined ? { overrides: nodeOverrides } : {}),
            hasClarifyChannel: effectiveHasClarifyChannel,
            skills: resolvedSkills,
            dependents,
            mcps,
            appHome: opts.appHome,
            ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
            db,
            log: log.child('fanout'),
            ...(opts.signal ? { signal: opts.signal } : {}),
          })
          // RFC-026: persist opencode session id for this shard so a future
          // clarify-inline rerun on the same shard chain can resume. Captured
          // even when the run failed — opencode often still emits a session
          // id before bailing — so the next attempt can resume regardless.
          if (result.sessionId !== undefined && result.sessionId !== '') {
            await db
              .update(nodeRuns)
              .set({ opencodeSessionId: result.sessionId })
              .where(eq(nodeRuns.id, childRunId))
          }
          // RFC-023: shard child emitted clarify — mint the per-shard
          // session, mark this child clarifyAwaiting (it does NOT count as
          // done; the parent waits for all shards including answered-then-
          // rerun shards before aggregating).
          if (result.clarify !== undefined && clarifyNodeIdForFanout !== undefined) {
            await createClarifySession({
              db,
              taskId,
              sourceAgentNodeId: node.id,
              sourceAgentNodeRunId: childRunId,
              sourceShardKey: shard.shardKey,
              clarifyNodeId: clarifyNodeIdForFanout,
              iterationIndex: 0,
              questions: result.clarify.questions,
              ...(result.clarify.truncationWarnings.length > 0
                ? { truncationWarnings: result.clarify.truncationWarnings }
                : {}),
              parentNodeRunId: parentRunId,
            })
            broadcastNodeStatus(taskId, childRunId, node.id, 'awaiting_human')
            return {
              shardKey: shard.shardKey,
              runId: childRunId,
              status: result.status,
              outputs: {},
              clarifyAwaiting: true,
            }
          }
          broadcastNodeStatus(taskId, childRunId, node.id, result.status)
          return {
            shardKey: shard.shardKey,
            runId: childRunId,
            status: result.status,
            outputs: result.outputs,
            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          broadcastNodeStatus(taskId, childRunId, node.id, 'failed')
          return {
            shardKey: shard.shardKey,
            runId: childRunId,
            status: 'failed',
            outputs: {},
            errorMessage: msg,
          }
        }
      }),
    ),
  )

  // RFC-023: if ANY shard is awaiting clarification, the agent-multi parent
  // does not aggregate — the task pauses awaiting_human until each pending
  // shard's user answers land + their rerun children re-complete. The
  // parent's eventual aggregation will be triggered by resumeTask, which
  // re-enters runFanOutNode and finds prior shard rows in 'done' status,
  // skipping the re-spawn.
  const awaitingShards = children.filter((c) => c.clarifyAwaiting === true)
  if (awaitingShards.length > 0) {
    await db.update(nodeRuns).set({ status: 'awaiting_human' }).where(eq(nodeRuns.id, parentRunId))
    broadcastNodeStatus(taskId, parentRunId, node.id, 'awaiting_human')
    return {
      kind: 'awaiting_human',
      summary: `agent-multi ${node.id}: ${awaitingShards.length}/${children.length} shards asked back`,
      message: 'clarify-awaiting-human',
    }
  }

  const sorted = [...children].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
  for (const port of agent.outputs) {
    const content = sorted
      .filter((c) => c.status === 'done')
      .map((c) => c.outputs[port] ?? '')
      .join('\n')
    await db.insert(nodeRunOutputs).values({ nodeRunId: parentRunId, portName: port, content })
  }
  const failed = sorted.filter((c) => c.status !== 'done')
  const errorsBody = failed
    .map((c) => `## ${c.shardKey} (${c.status})\n${c.errorMessage ?? ''}`)
    .join('\n\n')
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: parentRunId, portName: 'errors', content: errorsBody })

  const allFailed = sorted.length > 0 && sorted.every((c) => c.status !== 'done')
  const finalStatus: NodeStatus = allFailed ? 'failed' : 'done'
  // P-4-05: aggregate child tok_total into the parent so resource-limit ticks
  // and the UI's per-node stats reflect actual cost.
  const childTok = await sumChildTokens(db, parentRunId)
  await db
    .update(nodeRuns)
    .set({
      status: finalStatus,
      finishedAt: Date.now(),
      tokInput: childTok.input,
      tokOutput: childTok.output,
      tokCacheCreate: childTok.cacheCreate,
      tokCacheRead: childTok.cacheRead,
      tokTotal: childTok.total,
      ...(allFailed ? { errorMessage: 'all shards failed' } : {}),
    })
    .where(eq(nodeRuns.id, parentRunId))
  broadcastNodeStatus(taskId, parentRunId, node.id, finalStatus)
  if (allFailed) {
    return {
      kind: 'failed',
      summary: `agent-multi ${node.id} all ${sorted.length} shards failed`,
      message: errorsBody,
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function emitStatus(db: DbClient, taskId: string): Promise<void> {
  const t = await getTask(db, taskId)
  if (t !== null) emitTaskStatus(t)
}

function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status: NodeStatus,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'pending' | 'done' | 'awaiting_review' | 'awaiting_human',
  retryIndex: number = 0,
  iteration: number = 0,
  inherit?: {
    clarifyIteration?: number
    reviewIteration?: number
    shardKey?: string | null
    parentNodeRunId?: string | null
  },
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    retryIndex,
    iteration,
    clarifyIteration: inherit?.clarifyIteration ?? 0,
    reviewIteration: inherit?.reviewIteration ?? 0,
    shardKey: inherit?.shardKey ?? null,
    parentNodeRunId: inherit?.parentNodeRunId ?? null,
    startedAt: now,
    finishedAt: status === 'done' ? now : null,
  })
  return id
}

async function failTask(
  db: DbClient,
  taskId: string,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'failed',
    finishedAt: Date.now(),
    errorSummary,
    errorMessage,
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

async function cancelTaskRow(db: DbClient, taskId: string, failedNodeId?: string): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'canceled',
    finishedAt: Date.now(),
    errorSummary: 'canceled by user',
    errorMessage: 'aborted by signal',
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

function parseStringArray(value: string | null | undefined): string[] {
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

async function loadAgent(db: DbClient, name: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.name, name)).limit(1)
  const row = rows[0]
  if (!row) return null
  const out: Agent = {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: JSON.parse(row.outputs) as string[],
    readonly: row.readonly,
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: JSON.parse(row.skills) as string[],
    // RFC-022: tolerate legacy rows whose depends_on column is missing /
    // malformed (manual SQL edits); parse failure or non-array → [].
    dependsOn: parseStringArray(row.dependsOn),
    // RFC-028: same lenient parsing for the mcp column.
    mcp: parseStringArray(row.mcp),
    // RFC-031: same lenient parsing for the plugins column.
    plugins: parseStringArray(row.plugins),
    frontmatterExtra: JSON.parse(row.frontmatterExtra) as Record<string, unknown>,
    bodyMd: row.bodyMd,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.model !== null) out.model = row.model
  if (row.variant !== null) out.variant = row.variant
  if (row.temperature !== null) out.temperature = row.temperature
  if (row.steps !== null) out.steps = row.steps
  if (row.maxSteps !== null) out.maxSteps = row.maxSteps
  return out
}

/**
 * RFC-022: expand the agent.dependsOn closure and resolve the skills union
 * for one node-run spawn. Used by both the single-agent path and the
 * fan-out child path so they stay in lockstep.
 *
 * Returns either `{ kind: 'ok', dependents, resolvedSkills }` for the
 * scheduler to feed straight into `runNode({ ..., dependents, skills })`, or
 * the same `NodeStepResult` 'failed' shape every other scheduler step uses
 * so the caller's normal failure path handles cycles / missing-dep names.
 *
 * Skills union de-dup is by name — same skill referenced from multiple
 * closure agents only stages once under OPENCODE_CONFIG_DIR/skills/.
 */
export async function prepareNodeRunInjection(
  db: DbClient,
  appHome: string,
  agent: Agent,
  log: Logger,
): Promise<
  | {
      kind: 'ok'
      dependents: Agent[]
      resolvedSkills: ResolvedSkill[]
      /**
       * RFC-028: MCP rows hydrated from the dependsOn closure's union of
       * agent.mcp[] names. Empty when nothing in the closure declares an
       * mcp (most workflows pre-RFC-028). Names that no longer resolve
       * in the DB (deleted out from under the running task) are silently
       * dropped — see loadMcpsByNames + OPENCODE_CONFIG.md §6.
       */
      mcps: Mcp[]
      /**
       * RFC-031: opencode plugin rows hydrated from the dependsOn closure's
       * union of agent.plugins[] names. Empty when no closure member declares
       * a plugin. Same "silently skip names that no longer resolve" stance as
       * mcps — see loadPluginsByNames docstring.
       */
      plugins: Plugin[]
    }
  | { kind: 'failed'; summary: string; message: string }
> {
  const closure = await resolveDependsClosure(db, agent, { allowMissing: false }).catch(
    (err: Error & { code?: string; details?: unknown }) => {
      // resolveDependsClosure throws DomainError for missing deps. Surface
      // the code via NodeStepResult so the caller's normal failure path
      // handles it — no separate exception path needed.
      log.warn('dependsOn resolve failed', {
        agent: agent.name,
        code: err.code,
        message: err.message,
      })
      return { ok: false as const, cyclePath: [] as string[], error: err }
    },
  )
  if ('error' in closure) {
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' depends on missing agent`,
      message: closure.error.code ?? 'agent-dependency-not-found',
    }
  }
  if (closure.ok === false) {
    log.warn('dependsOn cycle detected', {
      agent: agent.name,
      cyclePath: closure.cyclePath,
    })
    return {
      kind: 'failed',
      summary: `agent '${agent.name}' dependsOn forms a cycle`,
      message: `agent-dependency-cycle: ${closure.cyclePath.join(' → ')}`,
    }
  }
  const dependents = closure.agents.slice(1) // [0] is the root
  const skillsUnion: string[] = []
  const seenSkills = new Set<string>()
  for (const skillName of [...agent.skills, ...dependents.flatMap((a) => a.skills)]) {
    if (seenSkills.has(skillName)) continue
    seenSkills.add(skillName)
    skillsUnion.push(skillName)
  }
  const resolvedSkills = await resolveSkills(db, appHome, skillsUnion)
  // RFC-028: union mcp names across the full closure (root first, then BFS
  // dependents) and hydrate the rows. Errors that can't surface as a
  // 'failed' here — missing MCP names are silently skipped at hydrate time
  // (see loadMcpsByNames docstring; we prefer "spawn without that MCP" over
  // "fail the whole node because a previously-saved name no longer exists").
  const mcpNames = collectMcpNamesFromClosure(closure.agents)
  const mcps = await loadMcpsByNames(db, mcpNames)
  // RFC-031: same closure + hydrate dance for opencode plugins. Names that no
  // longer resolve (deleted out from under the running task) are silently
  // dropped at the loader; we'd rather start the node without a plugin than
  // crash on a previously-saved-but-deleted reference.
  const pluginNames = collectPluginNamesFromClosure(closure.agents)
  const plugins = await loadPluginsByNames(db, pluginNames)
  return { kind: 'ok', dependents, resolvedSkills, mcps, plugins }
}

async function resolveSkills(
  db: DbClient,
  appHome: string,
  names: string[],
): Promise<ResolvedSkill[]> {
  const out: ResolvedSkill[] = []
  for (const name of names) {
    const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
    const row = rows[0]
    if (!row) {
      out.push({ name, sourceKind: 'project' })
      continue
    }
    if (row.sourceKind === 'managed') {
      const skillPath = `${appHome}/${row.managedPath ?? `skills/${name}/files`}`
      out.push({ name, sourceKind: 'managed', sourcePath: skillPath })
    } else if (row.sourceKind === 'external' && row.externalPath !== null) {
      out.push({ name, sourceKind: 'external', sourcePath: row.externalPath })
    }
  }
  return out
}

/**
 * Resolve upstream port values for one node at a given iteration.
 *
 * For each incoming edge: pick the upstream node's latest run whose iteration
 * is ≤ current iteration (prefer the highest matching iteration, then highest
 * retry_index). This lets inner-scope nodes see top-level node outputs
 * (iteration=0) and same-iteration upstream outputs from earlier ready batches.
 */
async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  iteration: number,
  log: Logger,
): Promise<Record<string, string>> {
  const grouped = new Map<string, string[]>()
  const incoming = edges.filter((e) => e.target.nodeId === nodeId)

  for (const edge of incoming) {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, edge.source.nodeId)))
    const candidates = rows
      .filter((r) => r.iteration <= iteration && r.parentNodeRunId === null)
      .sort((a, b) => {
        if (b.iteration !== a.iteration) return b.iteration - a.iteration
        return b.retryIndex - a.retryIndex
      })
    const run = candidates[0]
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: edge.source.nodeId })
      continue
    }
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, run.id))
    const port = outRows.find((o) => o.portName === edge.source.portName)
    const content = port?.content ?? ''
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const result: Record<string, string> = {}
  for (const [name, values] of grouped) {
    result[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return result
}

async function pickLatestSourceRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  const candidates = rows
    .filter((r) => r.iteration <= iteration && r.parentNodeRunId === null)
    .sort((a, b) => {
      if (b.iteration !== a.iteration) return b.iteration - a.iteration
      return b.retryIndex - a.retryIndex
    })
  return candidates[0] ?? null
}

async function sumChildTokens(
  db: DbClient,
  parentRunId: string,
): Promise<{
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}> {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.parentNodeRunId, parentRunId))
  let input = 0
  let output = 0
  let cacheCreate = 0
  let cacheRead = 0
  for (const r of rows) {
    input += r.tokInput ?? 0
    output += r.tokOutput ?? 0
    cacheCreate += r.tokCacheCreate ?? 0
    cacheRead += r.tokCacheRead ?? 0
  }
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead }
}

async function readPortAtIteration(
  db: DbClient,
  taskId: string,
  nodeId: string,
  portName: string,
  iteration: number,
): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  const r = rows
    .filter((r) => r.parentNodeRunId === null)
    .sort((a, b) => b.retryIndex - a.retryIndex)[0]
  if (!r) return ''
  const out = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, r.id), eq(nodeRunOutputs.portName, portName)))
  return out[0]?.content ?? ''
}

/**
 * Topological order using Kahn's algorithm over a node subset. Edges whose
 * endpoints are outside the subset are ignored. Returns null if a cycle is
 * detected.
 */
function topologicalOrder(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  _log: Logger,
): WorkflowNode[] | null {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  for (const n of nodes) inDegree.set(n.id, 0)
  // RFC-023: ignore clarify channel edges when computing topology. They form
  // an explicit cycle (agent → clarify → agent) by design, and the cycle is
  // resolved out-of-band via clarify_session prompt injection.
  const isClarifyEdge = (e: WorkflowEdge): boolean =>
    e.source.portName === '__clarify__' || e.target.portName === '__clarify_response__'
  for (const e of edges) {
    if (!nodeById.has(e.source.nodeId) || !nodeById.has(e.target.nodeId)) continue
    if (isClarifyEdge(e)) continue
    inDegree.set(e.target.nodeId, (inDegree.get(e.target.nodeId) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id)
  const out: WorkflowNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    const n = nodeById.get(id)
    if (n) out.push(n)
    for (const e of edges) {
      if (e.source.nodeId !== id) continue
      if (!nodeById.has(e.target.nodeId)) continue
      if (isClarifyEdge(e)) continue
      const next = (inDegree.get(e.target.nodeId) ?? 0) - 1
      inDegree.set(e.target.nodeId, next)
      if (next === 0) queue.push(e.target.nodeId)
    }
  }
  if (out.length !== nodes.length) return null
  return out
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function pickNumber(node: WorkflowNode, key: string): number | undefined {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function pickStringArray(node: WorkflowNode, key: string): string[] {
  const v = (node as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

/**
 * Read per-node model/variant/temperature overrides written by the canvas
 * inspector under `node.overrides`. Returns undefined when no usable override
 * is present so the caller can omit the field entirely (keeps the runner's
 * `overrides ?? agent.<field>` fallback identity-preserving). An empty string
 * model/variant is treated as "cleared" and not forwarded.
 */
function pickOverrides(node: WorkflowNode): AgentOverrides | undefined {
  const raw = (node as Record<string, unknown>).overrides
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  const out: AgentOverrides = {}
  if (typeof rec.model === 'string' && rec.model.length > 0) out.model = rec.model
  if (typeof rec.variant === 'string' && rec.variant.length > 0) out.variant = rec.variant
  if (typeof rec.temperature === 'number' && Number.isFinite(rec.temperature)) {
    out.temperature = rec.temperature
  }
  return Object.keys(out).length === 0 ? undefined : out
}

interface Binding {
  name: string
  bind: { nodeId: string; portName: string }
}

function readBindings(node: WorkflowNode, key: string): Binding[] {
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: Binding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string') continue
    const bind = rec.bind
    if (typeof bind !== 'object' || bind === null) continue
    const br = bind as Record<string, unknown>
    if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
    out.push({ name: rec.name, bind: { nodeId: br.nodeId, portName: br.portName } })
  }
  return out
}

async function readSnapshotForLatestRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration: number,
): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(desc(nodeRuns.retryIndex))
    .limit(1)
  return rows[0]?.preSnapshot ?? ''
}

/**
 * RFC-026: look up the opencode session id captured on the agent's PRIOR
 * clarify round (one less than the current run's clarifyIteration). Walks
 * node_runs filtered by (taskId, nodeId, shardKey, clarifyIteration), picks
 * the latest retry attempt that actually finished — that's the run that
 * emitted the `<workflow-clarify>` envelope the user just answered. Returns
 * null when nothing matches (will then degrade to isolated via
 * `decideResumeSessionId`).
 */
async function readPriorAgentSessionId(
  db: DbClient,
  args: {
    taskId: string
    agentNodeId: string
    shardKey: string | null
    priorIterationIndex: number
  },
): Promise<string | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        eq(nodeRuns.nodeId, args.agentNodeId),
        eq(nodeRuns.clarifyIteration, args.priorIterationIndex),
        eq(nodeRuns.status, 'done'),
      ),
    )
    .orderBy(desc(nodeRuns.retryIndex))
  // shardKey is filtered in memory because drizzle's IS NULL handling
  // varies; the result set is tiny (one row per retry attempt).
  const filtered = rows.filter((r) => (r.shardKey ?? null) === args.shardKey)
  for (const r of filtered) {
    if (r.opencodeSessionId !== null && r.opencodeSessionId !== '') {
      return r.opencodeSessionId
    }
  }
  return null
}

/**
 * RFC-026: read concatenated stderr text recorded for a node_run via the
 * runner's stderr pump. Used post-spawn to sniff for `session not found`
 * style messages so the inline-mode fallback can degrade gracefully.
 */
async function readStderrText(db: DbClient, nodeRunId: string): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRunEvents)
    .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
    .orderBy(asc(nodeRunEvents.id))
  return rows.map((r) => r.payload).join('\n')
}

/**
 * RFC-026: record an info/warning row about inline-mode session resume.
 *
 * Both flavors are written as `kind: 'text'` (the closest enum value that
 * doesn't collide with stderr / step-finish / etc.) with a structured JSON
 * payload + a stable `[rfc026/...]` prefix. PR-B's frontend reads the
 * prefix to render the row with an info or warning style; until then the
 * payload is plain-readable in the events tab.
 */
async function recordClarifyInlineEvent(
  db: DbClient,
  nodeRunId: string,
  args:
    | {
        level: 'info'
        sessionIdPrefix: string
        extra?: Record<string, unknown>
      }
    | {
        level: 'warning'
        reason: ClarifyInlineFallbackReason
        extra?: Record<string, unknown>
      },
): Promise<void> {
  const tag = args.level === 'info' ? '[rfc026/inline-session-resumed]' : '[rfc026/inline-fallback]'
  const payload =
    args.level === 'info'
      ? JSON.stringify({
          rfc: 'rfc026',
          code: 'clarify-session-resumed',
          sessionIdPrefix: args.sessionIdPrefix,
          ...args.extra,
        })
      : JSON.stringify({
          rfc: 'rfc026',
          code: 'inline-clarify-fallback-to-isolated',
          reason: args.reason,
          ...args.extra,
        })
  await db.insert(nodeRunEvents).values({
    nodeRunId,
    ts: Date.now(),
    kind: 'text',
    payload: `${tag} ${payload}`,
  })
}

/**
 * Build the in-scope upstream map for nodes within a single scope. Edges
 * crossing into the scope from outside are ignored (their sources are
 * treated as already-done because the parent scope ran them first).
 */
function buildScopeUpstreams(
  scopeNodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, string[]> {
  const ids = new Set(scopeNodes.map((n) => n.id))
  const m = new Map<string, string[]>()
  for (const n of scopeNodes) m.set(n.id, [])
  for (const e of edges) {
    if (!ids.has(e.target.nodeId)) continue
    if (!ids.has(e.source.nodeId)) continue
    // RFC-023: clarify channel edges are not dataflow deps; they're
    // out-of-band, handled by services/clarify.ts. Skipping them prevents
    // a cycle (agent -> clarify -> agent) and keeps the clarify node off
    // the agent's upstream list (the answer arrives via prompt injection,
    // not the answers→agent edge).
    if (e.source.portName === '__clarify__' || e.target.portName === '__clarify_response__') {
      continue
    }
    const list = m.get(e.target.nodeId) ?? []
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
    m.set(e.target.nodeId, list)
  }
  // agent-multi's sourcePort.nodeId is an extra dep if both ends are in scope.
  for (const n of scopeNodes) {
    if (n.kind === 'agent-multi') {
      const sp = (n as Record<string, unknown>).sourcePort as { nodeId?: unknown } | undefined
      if (sp === undefined || typeof sp.nodeId !== 'string') continue
      if (!ids.has(sp.nodeId)) continue
      const list = m.get(n.id) ?? []
      if (!list.includes(sp.nodeId)) list.push(sp.nodeId)
      m.set(n.id, list)
    }
    // RFC-005: review.inputSource.nodeId is an implicit upstream dep — it
    // isn't an edge in the user-authored graph, but the scheduler must wait
    // for the source node before parking the review at awaiting_review.
    if (n.kind === 'review') {
      const inp = (n as Record<string, unknown>).inputSource as { nodeId?: unknown } | undefined
      if (inp === undefined || typeof inp.nodeId !== 'string') continue
      if (!ids.has(inp.nodeId)) continue
      const list = m.get(n.id) ?? []
      if (!list.includes(inp.nodeId)) list.push(inp.nodeId)
      m.set(n.id, list)
    }
  }
  return m
}

/**
 * Recursive containment map: every node id → innermost wrapper id containing
 * it (if any). Outer wrapper relationships are not stored because the inner
 * scope already implies them. Nodes not contained by any wrapper are absent
 * from the map (= top-level).
 *
 * Robust against:
 *   - wrappers listing the same inner under both (treats it as belonging to
 *     the wrapper appearing later in iteration order — validator catches the
 *     truly invalid configurations)
 *   - missing inner ids (skipped)
 */
function buildContainerMap(def: WorkflowDefinition): Map<string, string> {
  const out = new Map<string, string>()
  const nodeById = new Map(def.nodes.map((n) => [n.id, n]))
  // Walk wrappers from innermost to outermost (innermost = wrapper whose
  // inner ids contain no other wrappers from def). Since wrappers can nest,
  // we sort by nesting depth: wrappers whose inner ids include other
  // wrappers are processed AFTER those other wrappers. This is implemented
  // by repeated passes — small N, cheap.
  const wrappers = def.nodes.filter((n) => n.kind === 'wrapper-git' || n.kind === 'wrapper-loop')
  const processed = new Set<string>()
  let safety = wrappers.length + 1
  while (processed.size < wrappers.length && safety-- > 0) {
    for (const w of wrappers) {
      if (processed.has(w.id)) continue
      const inner = pickStringArray(w, 'nodeIds')
      // Defer if any inner is itself an unprocessed wrapper.
      const blocked = inner.some(
        (id) =>
          nodeById.get(id) !== undefined &&
          (nodeById.get(id)!.kind === 'wrapper-git' || nodeById.get(id)!.kind === 'wrapper-loop') &&
          !processed.has(id),
      )
      if (blocked) continue
      for (const id of inner) {
        if (!nodeById.has(id)) continue
        // Innermost wins (don't overwrite once set).
        if (!out.has(id)) out.set(id, w.id)
      }
      processed.add(w.id)
    }
  }
  return out
}
