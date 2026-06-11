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
  NodeKind,
  Plugin,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WrapperFanoutPort,
} from '@agent-workflow/shared'
import {
  FANOUT_DONE_PORT_NAME,
  WorkflowDefinitionSchema,
  agentHasClarifyChannel,
  agentHasExternalFeedbackChannel,
  buildPriorOutputBlock,
  deriveWrapperFanoutOutputs,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  findFanoutAggregator,
  findQuestionerNodeForCrossClarify,
  isClarifyChannelEdge,
  resolveClarifySessionMode,
  resolveKeyOf,
  tryParseKind,
} from '@agent-workflow/shared'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '@/services/fanout'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  clarifySessions,
  crossClarifySessions,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  skills,
  taskRepos,
  tasks,
} from '@/db/schema'
import { getAgent } from '@/services/agent'
import { resolveDependsClosure } from '@/services/agentDeps'
import { collectMcpNamesFromClosure, loadMcpsByNames } from '@/services/mcpClosure'
import { collectPluginNamesFromClosure, loadPluginsByNames } from '@/services/pluginClosure'
import { createClarifySession, findClarifyNode } from '@/services/clarify'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  hasPersistentStop,
} from '@/services/crossClarify'
import { buildPromptContext } from '@/services/clarifyRounds'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
  type ClarifyInlineFallbackReason,
} from '@/services/clarifyFallback'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import { trySetTaskStatus, setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { getTaskWriteSem, gcTaskWriteSem } from '@/services/taskWriteLocks'
import { buildReviewPromptContext, dispatchReviewNode } from '@/services/review'
import {
  areTransitiveUpstreamsCompleted,
  buildFreshestDonePerNode,
  isFresherNodeRun,
  isNodeRunFresh,
  pickFreshestRun,
} from '@/services/freshness'
import {
  decideScopeOutcome,
  isDispatchable,
  isReviewSupersededRow,
} from '@/services/dispatchFrontier'
import { runNode, type AgentOverrides, type ResolvedSkill, type RunResult } from '@/services/runner'
import { parsePortValidationFailuresJson } from '@/services/envelope'
import { runCommitPush } from '@/services/commitPushRunner'
import {
  buildCommitAgent,
  buildCommitMessagePrompt,
  buildRepairPrompt,
  commitPushNodeId,
  COMMIT_MESSAGE_PORT,
} from '@/services/commitPush'
import {
  DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
  DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
} from '@agent-workflow/shared'
import {
  decodeWrapperProgress,
  encodeWrapperProgress,
  type WrapperProgress,
} from '@/services/wrapperProgress'
import { emitTaskStatus, getTask } from '@/services/task'
import { createLogger, type Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import { gitChangedFiles, gitStashSnapshot, runGit } from '@/util/git'
import { rollbackNodeRunWorktrees } from '@/services/nodeRollback'
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
  /**
   * RFC-060 D.T6: runtime cartesian guard for wrapper-fanout. When a single
   * wrapper-fanout (possibly with nested wrapper-fanouts) would mint more
   * than this many total shards, the wrapper finalizes 'failed' with
   * `wrapper-fanout-cartesian-exceeds-max` rather than minting the shards.
   * Default 256.
   */
  fanoutMaxShardTotal?: number
  /**
   * RFC-048: forwarded verbatim to every `runNode` call so the runner spins
   * up its subagent live-capture poller with the operator-configured cadence.
   * Omitted → runner falls back to its compile-time defaults.
   */
  subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }
  /**
   * RFC-075: model for the built-in commit agent (commit message + push
   * repair). Omitted → opencode's installed default. Repair budget + diff
   * truncation use the DEFAULT_COMMIT_PUSH_* constants (Settings wiring is a
   * follow-up; the runtime reads sensible defaults today).
   */
  commitPushModel?: string
  /** RFC-075: repair-retry budget; falls back to DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES. */
  commitPushMaxRepairRetries?: number
  /** RFC-075: diff byte cap for the commit-message prompt; falls back to DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES. */
  commitPushDiffMaxBytes?: number
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
  /**
   * RFC-066: per-repo metadata loaded once at scheduler entry, threaded
   * through every templateMeta dispatch + the multi-repo
   * `pre_snapshot_repos_json` write path. Single-repo tasks get a length-1
   * array mirroring the legacy `task.repoPath` / `task.baseBranch` columns
   * (`worktreeDirName: ''`, so `{{__repo_names__}}` renders empty — the
   * single-repo byte-baseline is preserved). Always non-empty; defensive
   * fallback in runTask handles the ultra-rare task row that predates
   * migration 0034's INSERT FROM backfill.
   */
  repos: Array<{
    repoPath: string
    worktreePath: string
    worktreeDirName: string
    baseBranch: string
  }>
}

/**
 * Drive one task from "pending" to a terminal status. Caller decides whether
 * to await this (tests) or fire-and-forget (HTTP route).
 */
export async function runTask(opts: RunTaskOptions): Promise<void> {
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached SchedulerState.writeSem reference).
  try {
    await runTaskInner(opts)
  } finally {
    gcTaskWriteSem(opts.taskId)
  }
}

async function runTaskInner(opts: RunTaskOptions): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  // RFC-066 PR-B T9: load per-repo metadata once at the top so every runner
  // dispatch site can thread it through `templateMeta.repos` without an extra
  // round-trip. Single-repo tasks get a length-1 array mirroring the legacy
  // `tasks.*` columns (`worktreeDirName === ''` → `{{__repo_names__}}`
  // renders empty, byte-baseline). Defensive fallback handles the ultra-rare
  // case of a task row predating migration 0034's INSERT FROM backfill.
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos: Array<{
    repoPath: string
    worktreePath: string
    worktreeDirName: string
    baseBranch: string
  }> =
    repoRows.length > 0
      ? repoRows.map((r) => ({
          repoPath: r.repoPath,
          worktreePath: r.worktreePath,
          worktreeDirName: r.worktreeDirName,
          baseBranch: r.baseBranch,
        }))
      : [
          {
            repoPath: task.repoPath,
            worktreePath: task.worktreePath,
            worktreeDirName: '',
            baseBranch: task.baseBranch,
          },
        ]

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = WorkflowDefinitionSchema.parse(raw)
  } catch (err) {
    await failTask(db, taskId, 'snapshot-invalid', (err as Error).message)
    return
  }

  // 3. Mark running — CAS from 'pending' ONLY (RFC-097, audit S-8/S-14).
  // The unconditional write here used to revive canceled/done tasks and let a
  // second runTask take over a live one. CAS loss → another driver owns the
  // task (or it is terminal): log and step away without minting anything.
  const claimed = await trySetTaskStatus({
    db,
    taskId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'runTask-start',
  })
  if (!claimed) {
    log.warn('runTask: task not claimable (not pending) — refusing to drive it', { taskId })
    return
  }
  await emitStatus(db, taskId)

  // 4. Validate node kinds.
  for (const node of definition.nodes) {
    if (
      node.kind !== 'input' &&
      node.kind !== 'agent-single' &&
      node.kind !== 'output' &&
      node.kind !== 'wrapper-git' &&
      node.kind !== 'wrapper-loop' &&
      node.kind !== 'wrapper-fanout' && // RFC-060
      node.kind !== 'review' && // RFC-005
      node.kind !== 'clarify' && // RFC-023
      node.kind !== 'clarify-cross-agent' // RFC-056
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

  // RFC-066 PR-B T9: scheduler-side defense-in-depth gate. T6 already
  // rejects multi-repo + wrapper-git at launch time, but a hypothetical
  // direct insert into `tasks` (skipping the route layer) or a future
  // resume path could in principle hand us a wrapper-git node with
  // repoCount > 1. Catch it here before any inner-scope work runs.
  if (task.repoCount > 1) {
    const wgNode = definition.nodes.find((n) => n.kind === 'wrapper-git')
    if (wgNode !== undefined) {
      await failTask(
        db,
        taskId,
        'multi-repo-wrapper-git-unsupported',
        `wrapper-git node ${wgNode.id} not allowed in multi-repo task (repoCount=${task.repoCount})`,
        wgNode.id,
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
    // RFC-098 B1 (audit S-9): the writer lock comes from the per-task
    // registry so HTTP rollback paths (clarify/review/cross-clarify) hold THE
    // SAME instance. gc happens in this function's finally only (see
    // taskWriteLocks.ts lifecycle doc).
    writeSem: getTaskWriteSem(taskId),
    subprocessSem: new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4),
    containerOf,
    topLevelIds,
    // RFC-066: thread per-repo metadata through every inner dispatch.
    repos,
  }

  // 8. Drive the top-level scope. Any thrown error must land the task in
  // `failed` rather than wedge it on `running`: runTask is fire-and-forget from
  // the HTTP/resume path, so an unhandled rejection (e.g. an illegal node_run
  // transition, or a DB error inside a sink/wrapper branch that — unlike the
  // agent path — has no local try/catch) would otherwise leave the task stuck
  // `running` and unresumable (resumeTask refuses `running`). See
  // scheduler-boundary-wrapper-resume-interrupted.test.ts.
  let result: ScopeResult
  try {
    result = await runScope(state, {
      scopeIds: topLevelIds,
      iteration: 0,
      log,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('runTask: scope threw — failing task', { taskId, error: message })
    await failTask(db, taskId, 'scheduler error', message)
    return
  }

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
    // RFC-097: cancel wins — an abort that landed after runScope's last
    // signal check must not be overwritten by a park/terminal write.
    if (opts.signal?.aborted === true) {
      await cancelTaskRow(db, taskId)
      return
    }
    if (
      await trySetTaskStatus({
        db,
        taskId,
        to: 'awaiting_review',
        allowedFrom: ['running'],
        reason: 'scope-awaiting-review',
      })
    ) {
      await emitStatus(db, taskId)
      log.info('task awaiting human review', { taskId })
    } else {
      log.warn('awaiting_review write lost to a concurrent transition — respecting winner', {
        taskId,
      })
    }
    return
  }
  if (result.kind === 'awaiting_human') {
    // RFC-023: an agent (or one or more agent-multi shard children) emitted a
    // <workflow-clarify> envelope. The clarify node_run is parked
    // awaiting_human; the source agent has no rerun row yet — that's
    // created when the user POSTs answers. Per design §7.3 awaiting_human
    // outranks awaiting_review on the task chip when both can fire at once.
    if (opts.signal?.aborted === true) {
      await cancelTaskRow(db, taskId)
      return
    }
    if (
      await trySetTaskStatus({
        db,
        taskId,
        to: 'awaiting_human',
        allowedFrom: ['running'],
        reason: 'scope-awaiting-human',
      })
    ) {
      await emitStatus(db, taskId)
      log.info('task awaiting human clarification', { taskId })
    } else {
      log.warn('awaiting_human write lost to a concurrent transition — respecting winner', {
        taskId,
      })
    }
    return
  }

  // 9. Done. RFC-097: cancel wins — final aborted check before the terminal
  // CAS; a cancelTask fallback racing us resolves by whoever's CAS lands
  // (from-sets are disjoint winners: done from=running vs canceled CAS).
  if (opts.signal?.aborted === true) {
    await cancelTaskRow(db, taskId)
    return
  }
  if (
    await trySetTaskStatus({
      db,
      taskId,
      to: 'done',
      allowedFrom: ['running'],
      extra: { finishedAt: Date.now() },
      reason: 'task-done',
    })
  ) {
    await emitStatus(db, taskId)
    log.info('task done', { taskId })
  } else {
    log.warn('done write lost to a concurrent transition — respecting winner', { taskId })
  }
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

// RFC-096: `isFresherNodeRun` moved to freshness.ts (the row-ordering
// authority lives with the freshness primitives now; audit S-13 / WP-3).
// Re-exported here so the six existing test files importing it from the
// scheduler keep working unchanged.
export { isFresherNodeRun } from '@/services/freshness'

// -----------------------------------------------------------------------------
// RFC-042 — same-session envelope follow-up decision.
//
// When an attempt fails with a recognized envelope-format error (none / both /
// clarify-malformed) AND opencode itself exited cleanly AND we captured a
// session id AND the model emitted at least one text line, the next retry
// attempt should resume the SAME opencode session and send a short follow-up
// prompt (see shared `renderEnvelopeFollowupPrompt`) rather than rolling back
// to the pre-snapshot and starting from scratch. Any other failure shape —
// non-zero exit / crash / timeout / no session id captured / no text produced
// / non-envelope errorMessage — falls back to the legacy fresh-session retry
// path (rollback + new spawn).
//
// Pure function intentionally — easy to unit-test the 8-case truth table
// without standing up the whole scheduler.
// -----------------------------------------------------------------------------

export interface PreviousAttemptShape {
  status: 'done' | 'failed' | 'canceled' | null
  exitCode: number | null
  errorMessage: string | null
  sessionId: string | null
  /** Count of `kind='text'` rows the runner persisted for the previous run. */
  agentTextCount: number
  /**
   * RFC-049: structured port-validation failures the previous attempt's
   * runner persisted to `node_runs.port_validation_failures_json`. Defaults
   * to undefined; callers that have the JSON-parsed array can thread it
   * through here so the scheduler can route per-kind repair text via
   * `composePerKindRepairBlocks`. When the errorMessage carries the
   * `port-validation-` prefix but this field is missing (e.g. legacy rows
   * pre-RFC-049 / malformed JSON degraded by parsePortValidationFailuresJson),
   * the followup still fires but `failures` in the decision is an empty
   * array — degraded mode: prompt still nudges the agent, just without
   * per-port specifics.
   */
  portValidationFailures?: ReadonlyArray<{
    port: string
    kind: string
    subReason: string
    detail?: string
  }>
}

export type EnvelopeFollowupDecision =
  | {
      followup: true
      reason: 'envelope-missing' | 'both-present' | 'clarify-malformed' | 'port-validation'
      /**
       * Failures payload to thread into the runner / shared renderer when
       * reason is 'port-validation'. Empty array for the other reasons (and
       * for the degraded-mode port-validation case described above).
       */
      failures: ReadonlyArray<{
        port: string
        kind: string
        subReason: string
        detail?: string
      }>
    }
  | { followup: false }

export const PORT_VALIDATION_PREFIX = 'port-validation-'

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount <= 0) return { followup: false }
  const m = prev.errorMessage ?? ''
  if (m.startsWith('no <workflow-output> envelope found in stdout')) {
    return { followup: true, reason: 'envelope-missing', failures: [] }
  }
  if (m.startsWith('clarify-and-output-both-present')) {
    return { followup: true, reason: 'both-present', failures: [] }
  }
  if (m.startsWith('clarify-questions-')) {
    return { followup: true, reason: 'clarify-malformed', failures: [] }
  }
  // RFC-049: any `port-validation-<kind>-<sub>` prefix → same-session
  // followup. The `<kind>` segment routing happens later in
  // composePerKindRepairBlocks; here we only need the outermost prefix to
  // make the on/off decision.
  if (m.startsWith(PORT_VALIDATION_PREFIX)) {
    return {
      followup: true,
      reason: 'port-validation',
      failures: prev.portValidationFailures ?? [],
    }
  }
  return { followup: false }
}

async function runScope(state: SchedulerState, args: ScopeArgs): Promise<ScopeResult> {
  const { db, taskId, definition, opts } = state
  const { scopeIds, iteration, log } = args

  // RFC-076 PR-B — completion-driven dispatch frontier (replaces the
  // snapshot-batch + Promise.all-barrier + rescan/recompute reconcile model).
  //
  // Each tick re-reads node_runs and re-derives the dispatchable frontier from
  // scratch (`deriveFrontier`); there is no mutable completed/remaining snapshot
  // to keep in sync, so the old `rescanScopeForNewPendingRows` (mid-execution
  // clarify answers) and `recomputeFreshnessAndDemote` (RFC-074 multi-hop
  // demotion) are subsumed — both effects fall out of re-deriving from the DB.
  //
  // Newly-ready nodes start IMMEDIATELY and we await the FIRST in-flight
  // completion (`Promise.race`), so a finished node's downstream dispatches the
  // instant its last upstream settles — no waiting on the slowest sibling in a
  // batch. Writers still serialize via `writeSem` inside runOneNode; readonly
  // nodes run truly in parallel.
  //
  // `scopeNodes` includes output sinks: each gets a virtual node_run mirroring
  // its upstream port content, so invariant T3 (task.done ⟹ every output node
  // has a done node_run) holds and the detail page reads outputs uniformly.
  const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id))
  const upstreamsOf = buildScopeUpstreams(scopeNodes, definition.edges)
  const scopeNodeById = new Map(scopeNodes.map((n) => [n.id, n]))

  // Defensive cycle check for the dispatch graph. runTask topologically validates
  // the TOP scope at launch, but inner wrapper scopes (loop / git / fanout) were
  // never checked: a same-iteration data cycle between two inner nodes makes
  // areTransitiveUpstreamsCompleted false for both forever, so the scope goes
  // quiescent and fails with an opaque "scheduler stalled". Surface a clear cycle
  // error instead (channel/back edges are already dropped by buildScopeUpstreams,
  // so a cycle here is a genuine same-iteration data cycle). See
  // scheduler-boundary-intra-loop-cycle-stall.test.ts.
  const cycleNode = findScopeCycle(scopeNodes, upstreamsOf)
  if (cycleNode !== null) {
    return {
      kind: 'failed',
      detail: {
        summary: `cycle detected inside scope at node '${cycleNode}'`,
        message: 'scope-cycle',
        nodeId: cycleNode,
      },
    }
  }

  // In-flight node promises keyed by nodeId; `dispatchedThisInvocation` recovers
  // the per-invocation dedup the old `remaining.delete(n.id)` provided (N3): a
  // pure status read can't distinguish "failed row already (re-)dispatched this
  // call" from "failed row awaiting a fresh resume", so we remember what we
  // started. `parkedDetail` captures awaiting/failed summaries as they happen so
  // the terminal block can bubble the right message (a node parked in a PRIOR
  // invocation has no entry → falls back to '' / the generic detail, matching
  // the old `?? ''` wrapper bubbling).
  const inFlight = new Map<string, Promise<{ nodeId: string; result: OneNodeResult }>>()
  const dispatchedThisInvocation = new Set<string>()
  // RFC-092 (audit S-1): pending anchor rows already released this invocation.
  // A node in `dispatchedThisInvocation` re-dispatches when an out-of-band
  // rerun mints a FRESH pending row (mid-run clarify answer / review
  // decision); this set bounds that bypass to one release per row id.
  const dispatchedPendingRowIds = new Set<string>()
  const parkedDetail = new Map<string, { summary: string; message: string }>()
  let firstFailureDetail: { summary: string; message: string; nodeId?: string } | undefined

  // RFC-098 B1: in-flight auto commit&push promises are keyed
  // 'commitpush:<nodeId>:<iter>' — a NON-node key, so deriveFrontier's
  // in-flight node set never matches a scope node and downstream dispatch is
  // not frozen while a commit session runs (the synchronous await here used
  // to freeze the whole dispatch loop, audit S-17 second half). Canceled
  // exits MUST drain them (their inner runNode holds the shared signal and
  // returns quickly) — abandoning a commit session past runTask's finally
  // would orphan a worktree-writing process AND let the write-lock registry
  // gc race it (adversarial-review revision #2).
  const drainCommitPush = async (): Promise<void> => {
    const pending = [...inFlight.entries()].filter(([k]) => k.startsWith('commitpush:'))
    for (const [k, p] of pending) {
      try {
        await p
      } catch {
        /* commit failures never break task execution */
      }
      inFlight.delete(k)
    }
  }

  while (true) {
    if (opts.signal?.aborted === true) {
      // Cancel is a hard short-circuit: the abort already fired, so every live
      // child receives SIGTERM through the shared signal. Return immediately
      // without draining in-flight NODE promises — but commit&push synthetics
      // must be drained (see drainCommitPush above).
      await drainCommitPush()
      return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }
    }

    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const openClarify = await loadOpenClarify(db, taskId)
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      iteration,
      upstreamsOf,
      new Set(inFlight.keys()),
      dispatchedThisInvocation,
      openClarify.clarifyNodeIds,
      openClarify.askingRunIds,
      dispatchedPendingRowIds,
    )

    for (const nodeId of f.ready) {
      const node = scopeNodeById.get(nodeId)
      if (node === undefined) continue
      dispatchedThisInvocation.add(nodeId)
      const anchor = f.pendingAnchors.get(nodeId)
      if (anchor !== undefined) dispatchedPendingRowIds.add(anchor)
      inFlight.set(
        nodeId,
        runOneNode(state, { node, iteration, log }).then((result) => ({ nodeId, result })),
      )
    }

    if (inFlight.size === 0) {
      // Quiescent — nothing running and nothing newly ready. The priority
      // decision (awaiting_human > awaiting_review > firstFailure > exhausted
      // > done > stalled) lives in the pure decideScopeOutcome (RFC-095,
      // dispatchFrontier.ts) so it is table-testable; the stalled branch now
      // names the blocked nodes (audit S-12) instead of a bare message.
      const outcome = decideScopeOutcome(f, firstFailureDetail)
      if (outcome.kind === 'awaiting_human' || outcome.kind === 'awaiting_review') {
        return { kind: outcome.kind, detail: detailFor(outcome.nodeId, parkedDetail) }
      }
      return outcome
    }

    const { nodeId, result } = await Promise.race(inFlight.values())
    inFlight.delete(nodeId)

    if (result.kind === 'canceled') {
      // Hard short-circuit (user-tripped signal): no point draining the rest
      // of the NODE promises; commit&push synthetics are drained (revision #2).
      await drainCommitPush()
      return {
        kind: 'canceled',
        detail: { summary: result.summary, message: result.message, nodeId },
      }
    }
    if (result.kind === 'awaiting_review' || result.kind === 'awaiting_human') {
      // Park: record the detail and re-derive next tick. Other branches may
      // still be in flight; only when the scope goes quiescent does the
      // terminal block bubble this up (priority canceled > awaiting_human >
      // awaiting_review > failed). An un-answered clarify cannot be silently
      // lost just because a sibling failed.
      parkedDetail.set(nodeId, { summary: result.summary, message: result.message })
      continue
    }
    if (result.kind === 'failed') {
      // Record the first failure but do NOT short-circuit — sibling branches
      // may still surface awaiting_human / awaiting_review. The failed row is
      // in `dispatchedThisInvocation`, so deriveFrontier will NOT re-dispatch
      // it this call (it lands in the `failed` bucket); a fresh invocation
      // (resume/retry) re-mints it via isDispatchable (N1).
      if (firstFailureDetail === undefined) {
        firstFailureDetail = { summary: result.summary, message: result.message, nodeId }
      }
      continue
    }
    // ok — RFC-075 auto commit&push after a top-level node completes (opt-in;
    // a commit failure must NEVER break task execution). RFC-098 B1: runs as
    // a SYNTHETIC in-flight entry instead of a synchronous await — the
    // dispatch loop keeps racing node completions and dispatching ready
    // nodes while the commit session runs. The synthetic resolves kind 'ok'
    // unconditionally (failures are logged inside).
    if (
      state.task.autoCommitPush &&
      state.topLevelIds.has(nodeId) &&
      !nodeId.startsWith('commitpush:')
    ) {
      const node = scopeNodeById.get(nodeId)
      if (node !== undefined) {
        const syntheticKey = `commitpush:${nodeId}:${iteration}`
        inFlight.set(
          syntheticKey,
          maybeRunCommitPush(state, node, iteration, log)
            .catch((err) => {
              log.warn('auto commit&push trigger failed (ignored)', {
                nodeId,
                error: err instanceof Error ? err.message : String(err),
              })
            })
            .then(() => ({
              nodeId: syntheticKey,
              result: { kind: 'ok', summary: 'commit&push settled', message: '' } as OneNodeResult,
            })),
        )
      }
    }
  }
}

/**
 * RFC-076 PR-B — terminal detail for a parked / failed node when the scope goes
 * quiescent. A node parked THIS invocation has its summary/message captured in
 * `parked`; a node parked in a PRIOR invocation (e.g. a resume that never had to
 * re-run it) has no entry and falls back to '' — matching the old wrapper
 * bubbling (`subRes.detail?.summary ?? ''`) and the fact that the top-level
 * runTask ignores awaiting detail entirely (it only sets the task status chip).
 */
function detailFor(
  nodeId: string,
  parked: Map<string, { summary: string; message: string }>,
): { summary: string; message: string; nodeId: string } {
  const d = parked.get(nodeId)
  return { summary: d?.summary ?? '', message: d?.message ?? '', nodeId }
}

/**
 * RFC-076 PR-B — the open-clarify evidence `deriveFrontier` needs to honor a
 * clarify park while re-deriving the frontier purely from node_runs. Two sets,
 * both from UNANSWERED (`awaiting_human`) self / cross-clarify sessions:
 *
 *   - `clarifyNodeIds` (N6): clarify / cross-clarify NODE ids with an open
 *     session. Positive evidence that prevents settling a clarify leaf without a
 *     row during the "agent emitted <workflow-clarify>, createClarifySession
 *     mid-write" window (the session row can land before the clarify node_run).
 *
 *   - `askingRunIds`: the node_run ids of the ASKING agent / questioner runs
 *     (`source_agent_node_run_id` / `source_questioner_node_run_id`). When an
 *     agent emits <workflow-clarify>, the runner marks the agent's OWN run
 *     `done` and runOneNode returns `awaiting_human`; the old batch model used
 *     that return value to keep the agent OUT of `completed` (so downstream
 *     stayed blocked until the answer minted a rerun). A DB-derived frontier
 *     sees only the `done` row, so without this set it would complete the asking
 *     agent and run its downstream against an empty/clarify-only output (S12:
 *     the diamond's sibling builder ran twice). An asking run id parks its node
 *     in awaitingHuman until submitClarifyAnswers mints the rerun.
 *
 * A task parked awaiting a clarify never advances its loop iteration, so no
 * iteration filter is needed (a stale awaiting session from a prior iteration
 * cannot coexist with active scheduling of a later one).
 */
async function loadOpenClarify(
  db: DbClient,
  taskId: string,
): Promise<{ clarifyNodeIds: Set<string>; askingRunIds: Set<string> }> {
  const clarifyNodeIds = new Set<string>()
  const askingRunIds = new Set<string>()
  const self = await db
    .select({
      nodeId: clarifySessions.clarifyNodeId,
      askingRunId: clarifySessions.sourceAgentNodeRunId,
    })
    .from(clarifySessions)
    .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
  for (const r of self) {
    clarifyNodeIds.add(r.nodeId)
    if (r.askingRunId !== null && r.askingRunId !== '') askingRunIds.add(r.askingRunId)
  }
  const cross = await db
    .select({
      nodeId: crossClarifySessions.crossClarifyNodeId,
      askingRunId: crossClarifySessions.sourceQuestionerNodeRunId,
    })
    .from(crossClarifySessions)
    .where(
      and(
        eq(crossClarifySessions.taskId, taskId),
        eq(crossClarifySessions.status, 'awaiting_human'),
      ),
    )
  for (const r of cross) {
    clarifyNodeIds.add(r.nodeId)
    if (r.askingRunId !== null && r.askingRunId !== '') askingRunIds.add(r.askingRunId)
  }
  return { clarifyNodeIds, askingRunIds }
}

/**
 * RFC-075: auto commit&push after a top-level node completed. Diff-driven —
 * for each repo whose worktree has changes since the last commit, the
 * framework stages + commits (LLM message) + pushes via `runCommitPush`, with
 * the commit message + push repair driven by an opencode session (the built-in
 * commit agent) captured under the synthesized commit node_run. Read-only
 * nodes and no-op writers leave a clean worktree and are skipped for free.
 *
 * Only ever invoked when `state.task.autoCommitPush === true` (the caller
 * gates it), so this is a pure addition for opt-in tasks. Each repo's commit
 * runs sequentially in the scope's result loop, so commits never interleave.
 */
async function maybeRunCommitPush(
  state: SchedulerState,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<void> {
  const { db, task } = state
  // The triggering node's latest done run at this iteration → parent of the
  // commit row, so the detail page can group it under the agent.
  // RFC-096: freshest-by-id pick (was desc(startedAt) — a S-13 ordering fork;
  // attribution semantics unchanged, the rows are done-only).
  const parentRows = await db
    .select({ id: nodeRuns.id, parentNodeRunId: nodeRuns.parentNodeRunId, status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, task.id),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
  const parentNodeRunId = pickFreshestRun(parentRows, { topLevelOnly: true })?.id ?? null
  const agentLabel: string =
    node.kind === 'agent-single' && typeof node.agentName === 'string' ? node.agentName : node.id
  const branch = task.branch
  const model = state.opts.commitPushModel

  for (const repo of state.repos) {
    // RFC-098 B1: a cancel that lands mid-commit&push stops at the next repo
    // boundary (the in-repo opencode session already holds the shared signal).
    if (state.opts.signal?.aborted === true) return
    const status = await runGit(repo.worktreePath, ['status', '--porcelain'])
    if (status.stdout.trim() === '') continue // nothing changed in this repo
    const repoSlug = repo.worktreeDirName
    const nodeId = commitPushNodeId(node.id, repoSlug || undefined)
    const baseRef = repo.baseBranch || task.baseBranch
    const repoName = repoSlug || repo.repoPath.split('/').pop() || 'repo'

    // Drive a commit-agent opencode session under the commit node_run id so the
    // detail-page "view session" button shows the message/repair conversation.
    const genViaOpencode = async (
      prompt: string,
      ctx: { nodeRunId: string },
    ): Promise<{ message: string | null; sessionId: string | null }> => {
      // Each opencode session (message gen, each repair) runs on its OWN child
      // node_run so runNode's lifecycle state machine (pending→running→done)
      // owns it cleanly — reusing the commit container row would collide with
      // its mark-running transition. The child's parent is the container, so
      // the detail page groups the captured session(s) under the commit row.
      const sessionRunId = ulid()
      try {
        await db.insert(nodeRuns).values({
          id: sessionRunId,
          taskId: task.id,
          nodeId,
          parentNodeRunId: ctx.nodeRunId,
          status: 'pending',
          retryIndex: 0,
          iteration,
          shardKey: null,
          startedAt: Date.now(),
        })
        const result = await runNode({
          taskId: task.id,
          nodeRunId: sessionRunId,
          nodeId,
          agent: buildCommitAgent(model ?? null),
          inputs: {},
          worktreePath: repo.worktreePath,
          promptTemplate: prompt,
          templateMeta: {
            repoPath: repo.repoPath,
            baseBranch: baseRef,
            taskId: task.id,
            nodeId,
            iteration,
            repos: state.repos,
          },
          skills: [],
          dependents: [],
          mcps: [],
          plugins: [],
          appHome: state.opts.appHome,
          db,
          log: log.child('commit'),
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          ...(state.opts.opencodeCmd ? { opencodeCmd: state.opts.opencodeCmd } : {}),
          ...(state.opts.signal ? { signal: state.opts.signal } : {}),
        })
        const msg = result.outputs[COMMIT_MESSAGE_PORT]
        return {
          message: msg !== undefined && msg.trim() !== '' ? msg : null,
          sessionId: result.sessionId ?? null,
        }
      } catch (err) {
        log.warn('commit-agent opencode run failed; will fall back', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { message: null, sessionId: null }
      }
    }

    await runCommitPush(
      {
        taskId: task.id,
        agentNodeId: node.id,
        agentName: agentLabel,
        parentNodeRunId,
        worktreePath: repo.worktreePath,
        repoBranch: branch,
        baseRef,
        ...(repoSlug ? { repoSlug } : {}),
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        maxRepairRetries:
          state.opts.commitPushMaxRepairRetries ?? DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
        diffMaxBytes: state.opts.commitPushDiffMaxBytes ?? DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
        // RFC-076 C4: capture the staged snapshot only when no writer node is
        // mid-write. Writers hold this same Semaphore(1) for their whole run, so
        // under the race loop this serializes the commit's `git add` against
        // them — restoring the worktree quiescence the old batch barrier gave.
        acquireWrite: () => state.writeSem.acquire(),
        generateMessage: (mctx) =>
          genViaOpencode(
            buildCommitMessagePrompt({
              repoName,
              branch,
              baseRef,
              stat: mctx.stat,
              diffTruncated: mctx.diffTruncated,
            }),
            mctx,
          ),
        generateRepair: (rctx) =>
          genViaOpencode(
            buildRepairPrompt({
              branch,
              pushStderr: rctx.pushStderr,
              currentMessage: rctx.currentMessage,
              stat: rctx.stat,
              priorAttempts: rctx.priorAttempts,
            }),
            rctx,
          ),
      },
      { db, log: log.child('commit') },
    )
  }
}

// RFC-096: `buildFreshestDonePerNode` moved to freshness.ts alongside the
// comparator (audit S-13 / WP-3).

// -----------------------------------------------------------------------------
// RFC-076 PR-B — deriveFrontier (the dispatch brain; PURE, and LIVE: runScope
// calls it every dispatch tick — the stale "currently UNWIRED / NOT yet called"
// claims removed by RFC-094, audit S-26).
// -----------------------------------------------------------------------------
//
// Re-derives the dispatchable frontier from node_runs each tick, replacing the
// batch model's mutable completed/remaining snapshot + rescan/recompute
// reconcile. Composes fix A's areTransitiveUpstreamsCompleted + PR-A's
// isDispatchable / wrapperHasFreshInnerWork, plus RFC-092's pending-anchor
// row-id release (mid-run clarify answer / review decision pickup, audit S-1).
// The row-ordering primitives (isFresherNodeRun / buildFreshestDonePerNode)
// live in freshness.ts since RFC-096. Pure-function locks: derive-frontier.test.ts.

export interface Frontier {
  /** done∧fresh ∪ exhausted(loop-max terminal, HIGH-2) ∪ settles-without-row leaves. */
  completed: Set<string>
  /** transitive upstreams completed ∧ isDispatchable ∧ ∉ inFlight ∧ ∉ dispatchedThisInvocation. */
  ready: string[]
  /**
   * RFC-092 (audit S-1): for every `ready` node whose latest row is `pending`,
   * that row's id. The caller records these into its per-invocation
   * `dispatchedPendingRowIds` set so each pending anchor row is released AT
   * MOST ONCE — an out-of-band rerun mint (clarify answer / review decision)
   * carries a fresh ULID and re-releases the node; a leaked pending row that a
   * dispatch failed to consume degrades back to the stall semantics instead of
   * hot-looping.
   */
  pendingAnchors: Map<string, string>
  /** latest awaiting_review / awaiting_human, NOT going to ready (terminal bubbling). */
  awaitingReview: string[]
  awaitingHuman: string[]
  /** latest failed, NOT going to ready (a dispatchable failed row = pending resume, not terminal). */
  failed: string[]
  /** latest 'exhausted' (loop-max) — a terminal FAILURE, surfaced when the scope is quiescent. */
  exhausted: string[]
  /**
   * RFC-095 (audit S-12): nodes whose upstreams are complete and which are not
   * in flight, yet are neither dispatchable nor in any park bucket — the old
   * silent black holes (orphaned running rows, supersede-marker canceled rows,
   * consumed pending anchors, skipped, …). Surfaced in the stalled diagnostic;
   * `reason` is free-text payload, not an API contract.
   */
  blocked: Array<{ nodeId: string; status: string; reason: string }>
  /** every in-scope node is completed ⇒ scope may return done. */
  allSettled: boolean
}

// clarify / cross-clarify graph-visit no-ops write NO node_run row (C1); they
// settle without one once upstreams are done and no session is open (N6).
const SETTLES_WITHOUT_ROW_KINDS = new Set<NodeKind>(['clarify', 'clarify-cross-agent'])

function isLiveStatus(status: string): boolean {
  return (
    status === 'pending' ||
    status === 'running' ||
    status === 'awaiting_human' ||
    status === 'awaiting_review'
  )
}

/**
 * @param rows                     all node_runs for the task (filtered inside)
 * @param openClarifyNodeIds       clarify / clarify-cross-agent node ids with an
 *   UNANSWERED session (N6 positive evidence — caller queries clarify_sessions /
 *   cross_clarify_sessions). A no-row clarify leaf only settles when NOT here,
 *   closing the "agent done, createClarifySession not yet written" window.
 * @param dispatchedThisInvocation nodes already dispatched this runScope call
 *   (N3 — recovers the old remaining.delete per-invocation dedup; pure status
 *   read can't tell "already-dispatched parked wrapper" from "fresh resume").
 * @param openClarifyNodeIds       clarify / cross-clarify NODE ids with an open
 *   session (N6 — see loadOpenClarify).
 * @param askingRunIds             node_run ids of asking agent / questioner runs
 *   with an open clarify session. Their `done` row is a clarify park, NOT a
 *   completion: excluded from `completed` and bucketed awaitingHuman until the
 *   answer mints a rerun (S12). See loadOpenClarify.
 * @param dispatchedPendingRowIds  pending row ids already released through the
 *   RFC-092 pending-anchor bypass this invocation (caller records
 *   `Frontier.pendingAnchors` of every dispatch). Bounds the bypass to one
 *   release per row — see Frontier.pendingAnchors.
 */
export function deriveFrontier(
  rows: ReadonlyArray<typeof nodeRuns.$inferSelect>,
  definition: WorkflowDefinition,
  scopeNodes: WorkflowNode[],
  scopeIds: Set<string>,
  iteration: number,
  upstreamsOf: Map<string, string[]>,
  inFlight: ReadonlySet<string>,
  dispatchedThisInvocation: ReadonlySet<string>,
  openClarifyNodeIds: ReadonlySet<string>,
  askingRunIds: ReadonlySet<string> = new Set(),
  dispatchedPendingRowIds: ReadonlySet<string> = new Set(),
): Frontier {
  const latestPerNode = new Map<string, typeof nodeRuns.$inferSelect>()
  for (const r of rows) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue // skip fan-out child rows
    if (isFresherNodeRun(r, latestPerNode.get(r.nodeId))) latestPerNode.set(r.nodeId, r)
  }
  const freshestDone = buildFreshestDonePerNode(rows, scopeIds, iteration)

  // Pass 1 — done∧fresh (old seed口径) + exhausted (loop-max true terminal,
  // HIGH-2). An asking agent's `done` run with an OPEN clarify session is NOT a
  // completion (it is mid-conversation, parked awaiting the answer) — excluded
  // here, bucketed awaitingHuman below (S12: matches the old batch model keeping
  // the asking agent out of `completed` via runOneNode's awaiting_human return).
  const completed = new Set<string>()
  const exhausted: string[] = []
  for (const [nodeId, r] of latestPerNode) {
    if (askingRunIds.has(r.id)) continue
    if (r.status === 'done' && isNodeRunFresh(r, freshestDone)) completed.add(nodeId)
    // 'exhausted' (loop hit maxIterations without exit) is a TERMINAL FAILURE,
    // not a completion. Marking it completed made a resume invocation see an
    // exhausted top-level loop as done → the task silently flipped failed→done
    // and downstream consumed empty output. Bucket it as a failure so the scope
    // fails consistently on the first run AND any resume. See
    // scheduler-boundary-loop-exhausted-resume.test.ts.
    else if (r.status === 'exhausted') exhausted.push(nodeId)
  }
  // Pass 2 — settles-without-row (C1/N6). clarify nodes have no structural
  // upstream (channel edges dropped) so are leaves; cross-clarify depends on its
  // questioner (settled in pass 1), so one pass over pass-1 `completed` suffices.
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    if (!SETTLES_WITHOUT_ROW_KINDS.has(n.kind)) continue
    const latest = latestPerNode.get(n.id)
    if (latest !== undefined && isLiveStatus(latest.status)) continue
    if (openClarifyNodeIds.has(n.id)) continue
    if (areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) completed.add(n.id)
  }

  // RFC-092 (audit S-1, design §1.2b): node ids whose ASKING run still has an
  // open (un-answered) clarify session. submitClarifyAnswers mints the rerun
  // row BEFORE writing the answers / flipping the session (clarify.ts, no real
  // transaction under bun:sqlite) — releasing that pending row inside the
  // window would start the rerun without its answers. Derived from the rows we
  // already hold; the set empties the tick after the session flips answered.
  const openAskingNodeIds = new Set<string>()
  if (askingRunIds.size > 0) {
    for (const r of rows) {
      if (askingRunIds.has(r.id)) openAskingNodeIds.add(r.nodeId)
    }
  }

  const awaitingReview: string[] = []
  const awaitingHuman: string[] = []
  const failed: string[] = []
  const blocked: Array<{ nodeId: string; status: string; reason: string }> = []
  const ready: string[] = []
  const pendingAnchors = new Map<string, string>()
  let remainingCount = 0
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    remainingCount += 1
    const latest = latestPerNode.get(n.id)
    // Asking agent parked on an open clarify: its `done` row is mid-conversation,
    // not a completion and not (re-)dispatchable — submitClarifyAnswers mints the
    // rerun. Park it in awaitingHuman so the scope bubbles awaiting_human (and so
    // a `done`-status latest doesn't fall through to no bucket → false stall).
    if (latest !== undefined && askingRunIds.has(latest.id)) {
      awaitingHuman.push(n.id)
      continue
    }
    // RFC-092 (audit S-1): a `pending` latest row is an explicit new-work
    // signal (out-of-band rerun mint by submitClarifyAnswers / review
    // iterate-reject, or a resume placeholder). The per-invocation node-level
    // dedup must NOT permanently mask it — that turned a mid-run clarify
    // answer into a false `scheduler stalled` failure. Release it once per
    // ROW (dispatchedPendingRowIds), and never while its asking session is
    // still open (answer-write race window — see openAskingNodeIds above).
    const pendingAnchorReleasable =
      latest !== undefined &&
      latest.status === 'pending' &&
      !dispatchedPendingRowIds.has(latest.id) &&
      !openAskingNodeIds.has(n.id)
    const dispatchable =
      areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed) &&
      !inFlight.has(n.id) &&
      (pendingAnchorReleasable || !dispatchedThisInvocation.has(n.id)) &&
      isDispatchable(latest, n.kind, freshestDone, rows, definition)
    if (dispatchable) {
      ready.push(n.id)
      if (latest !== undefined && latest.status === 'pending') {
        pendingAnchors.set(n.id, latest.id)
      }
      continue
    }
    // RFC-095 (audit S-12): EXHAUSTIVE bucketing over the full NodeRunStatus
    // universe — a new status fails compilation here instead of silently
    // becoming an undiagnosable "scheduler stalled". The three park buckets
    // collect UNCONDITIONALLY (pre-RFC-095 semantics: an awaiting/failed row
    // parks regardless of upstream readiness — quiescent priority awaiting_* >
    // failed depends on it; derive-frontier.test.ts locks the failed case).
    // Only the `blocked` diagnostic branches gate on "upstreams complete ∧ not
    // in flight" — waiting-on-upstream / in-flight nodes are not stuck points.
    switch (latest?.status) {
      case 'awaiting_review':
        awaitingReview.push(n.id)
        break
      case 'awaiting_human':
        awaitingHuman.push(n.id)
        break
      case 'failed':
        failed.push(n.id)
        break
      case 'exhausted':
        break // already collected into the exhausted bucket in pass 1
      default: {
        if (!areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) break
        if (inFlight.has(n.id)) break
        const st = latest?.status
        switch (st) {
          case undefined:
            // clarify / cross-clarify graph-visit no-ops write no row; with an
            // open session pass 2 keeps them unsettled — a normal park, not a
            // dedup pathology. Anything else here was dispatched this
            // invocation and produced no row.
            blocked.push({
              nodeId: n.id,
              status: 'absent',
              reason: openClarifyNodeIds.has(n.id) ? 'open-clarify-window' : 'in-invocation-dedup',
            })
            break
          case 'pending':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: openAskingNodeIds.has(n.id)
                ? 'open-clarify-window'
                : 'pending-anchor-consumed',
            })
            break
          case 'running':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'orphaned-running-row (restart daemon to reap, audit S-12)',
            })
            break
          case 'canceled':
            // RFC-095: plain canceled rows are revival-dispatchable; only
            // review-supersede marker rows stay parked (see isDispatchable). A
            // plain canceled row lands here only via the per-invocation dedup.
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: isReviewSupersededRow(latest!)
                ? 'review-superseded'
                : 'canceled-in-invocation-dedup',
            })
            break
          case 'skipped':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'skipped-has-no-dispatch-semantics',
            })
            break
          case 'done':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'stale-done-in-invocation-dedup',
            })
            break
          case 'interrupted':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'interrupted-in-invocation-dedup',
            })
            break
          default: {
            // awaiting_* / failed / exhausted were collected by the outer
            // switch — anything reaching here is a NEW NodeRunStatus value.
            const _exhaustive: never = st
            void _exhaustive
          }
        }
      }
    }
  }
  return {
    completed,
    ready,
    pendingAnchors,
    awaitingReview,
    awaitingHuman,
    failed,
    exhausted,
    blocked,
    allSettled: remainingCount === 0,
  }
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
  if (node.kind === 'output') {
    // Output nodes are display-only sinks: no subprocess, no envelope. The
    // node's declared `ports[]` bindings resolve to upstream (nodeId, portName)
    // pairs (the canonical form, mirroring wrapper-loop's outputBindings; see
    // workflow.validator.ts §output binding validation). We mint a virtual
    // `done` node_run and snapshot each bound port's content into
    // node_run_outputs so the detail page reads outputs uniformly and
    // lifecycle invariant T3 (task done ⟹ every output node has a done run)
    // is satisfied.
    const bindings = readBindings(node, 'ports')
    const nrId = await insertNodeRun(db, taskId, node.id, 'done', 0, iteration)
    for (const b of bindings) {
      const content = await readPortAtIteration(
        db,
        taskId,
        b.bind.nodeId,
        b.bind.portName,
        iteration,
      )
      await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: b.name, content })
    }
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  if (node.kind === 'wrapper-git') {
    return runGitWrapperNode(state, args)
  }
  if (node.kind === 'wrapper-loop') {
    return runLoopWrapperNode(state, args)
  }
  if (node.kind === 'wrapper-fanout') {
    return runFanoutWrapperNode(state, args)
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

  if (node.kind === 'clarify-cross-agent') {
    // RFC-056: cross-clarify nodes are activated by the questioner emitting
    // <workflow-clarify> — the runner forwards into createCrossClarifySession
    // which mints a fresh node_run row and parks it at 'awaiting_human'. The
    // scheduler should NOT eagerly insert a pending row on every scan; doing
    // so accumulates orphan pending rows (one per scheduler tick, the user
    // saw 21 pile up on a parked task) because nothing consumes them — the
    // runner path always inserts its OWN row via createCrossClarifySession
    // rather than upgrading whatever the scheduler pre-baked.
    //
    // Two legitimate scheduler responsibilities remain:
    //   1. Persistent-stop short-circuit: if this node has a prior
    //      directive='stop' session, mark a fresh done row so cascade
    //      reruns of the cross-clarify branch can advance past it without
    //      parking awaiting_human.
    //   2. Missing-questioner runtime defense: validator should catch
    //      this earlier, but if the workflow snapshot has no questioner
    //      wired, fail explicitly.
    //
    // For the common case (no stop, has questioner), do NOTHING — the
    // runner will create the node_run when the questioner emits clarify.
    // If a live row already exists (pending or awaiting_human) from a
    // prior runner-side creation, also do nothing — idempotency guard.
    const liveRows = await db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, node.id),
          eq(nodeRuns.iteration, iteration),
        ),
      )
    const hasLive = liveRows.some((r) => r.status === 'pending' || r.status === 'awaiting_human')
    if (hasLive) {
      return { kind: 'ok', summary: '', message: 'cross-clarify-live-row-exists' }
    }
    // Validator runtime defense: a node without a questioner means the
    // workflow is malformed — fail and let the user see it in the UI.
    if (findQuestionerNodeForCrossClarify(definition, node.id) === undefined) {
      const failId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
      await setNodeRunStatus({
        db,
        nodeRunId: failId,
        to: 'failed',
        allowedFrom: ['pending'],
        reason: 'cross-clarify-input-source-missing-at-runtime',
        extra: { finishedAt: Date.now() },
      })
      return {
        kind: 'failed',
        summary: `cross-clarify node ${node.id} has no questioner input`,
        message: 'cross-clarify-input-source-missing-at-runtime',
      }
    }
    // Persistent-stop check: if a prior directive='stop' session exists for
    // this cross-clarify node, mint a done row immediately so the workflow
    // advances past this point without parking awaiting_human.
    const stopped = await hasPersistentStop(db, taskId, node.id)
    if (stopped) {
      const stopRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
      await setNodeRunStatus({
        db,
        nodeRunId: stopRunId,
        to: 'done',
        allowedFrom: ['pending'],
        reason: 'cross-clarify-persistent-stop',
        extra: { finishedAt: Date.now() },
      })
      broadcastNodeStatus(taskId, stopRunId, node.id, 'done')
      return { kind: 'ok', summary: '', message: 'cross-clarify-persistent-stop' }
    }
    // Common path: no live row, no persistent stop, questioner valid. Don't
    // pre-create — the runner's createCrossClarifySession will create a row
    // when the questioner emits <workflow-clarify>. Return ok so the
    // dispatcher marks this node "scheduled for this pass"; the lifecycle
    // hand-off to awaiting_human happens later via the runner path.
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
  const agent = await getAgent(db, agentName)
  if (agent === null) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }

  // RFC-060 PR-E: agent-multi NodeKind was removed in favor of wrapper-fanout.
  // The agent-single path below is now the sole agent dispatch path.
  // RFC-074: resolveUpstreamInputs now also returns the provenance map of which
  // upstream run each input was read from; recorded on every row this dispatch
  // mints/reuses so read-time freshness can later tell if an upstream advanced.
  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)
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
  // RFC-042: default retries bumped from 0 → 3 so that recoverable failure
  // modes (in particular the model forgetting to emit a `<workflow-output>` /
  // `<workflow-clarify>` envelope after a long tool-using session) get a
  // chance to recover via same-session follow-up before the task is failed.
  // Workflow authors who explicitly set `retries: 0` keep that — the change
  // is only the fallback when the field is absent.
  const maxRetries = pickNumber(node, 'retries') ?? 3
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
  // RFC-056: the questioner's __clarify__ port may be wired into a
  // clarify-cross-agent node instead of (or as well as) a RFC-023 clarify
  // node. When at least one cross-clarify target exists we instruct the
  // runner to disable the 5-question cap on the envelope parser.
  const clarifyMode: 'self' | 'cross' =
    findCrossClarifyNodeForQuestioner(definition, node.id) !== undefined ? 'cross' : 'self'
  // RFC-056 + RFC-064: designer agents may receive External Feedback from
  // one or more cross-clarify nodes via the system port __external_feedback__.
  // When the current rerun has clarifyIteration > 0 (RFC-064 unified counter
  // covers cross-clarify rounds too) AND a cross-clarify round answered
  // since the last designer done row, the scheduler builds a prompt context
  // that the renderer auto-appends as ## External Feedback.
  const hasExternalFeedbackChannel = agentHasExternalFeedbackChannel(definition, node.id)

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
  // RFC-074 PR-C: no clarifyIteration inheritance — freshness is pure id-order
  // and the clarify generation is derived from prior-done id-order at dispatch
  // time. A process retry's External Feedback / Prior Output / questioner Q&A
  // context all key off id-order / the RFC-070 consumed-by stamps, so nothing
  // needs to be carried forward on the row.
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  const pendingExisting = sameNodeIterRuns.find(
    (r) => r.status === 'pending' && r.parentNodeRunId === null,
  )
  if (pendingExisting !== undefined) {
    nodeRunId = pendingExisting.id
    retryIndex = pendingExisting.retryIndex
    // RFC-074: a reused pending row (e.g. minted by clarify rerun) runs now with
    // the inputs we just resolved — stamp its provenance to match what it reads.
    await db
      .update(nodeRuns)
      .set({ consumedUpstreamRunsJson: consumedUpstreamJson })
      .where(eq(nodeRuns.id, nodeRunId))
  } else {
    retryIndex =
      sameNodeIterRuns.length === 0 ? 0 : Math.max(...sameNodeIterRuns.map((r) => r.retryIndex)) + 1
    nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', retryIndex, iteration, {
      reviewIteration: inheritedReviewIteration,
      shardKey: inheritedShardKey,
      parentNodeRunId: inheritedParentNodeRunId,
      consumedUpstreamRunsJson: consumedUpstreamJson,
    })
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  // RFC-098 B1 (audit S-17): writers take the WRITE lock FIRST, then the
  // global slot — a writer queuing for the write lock no longer occupies a
  // globalSem slot, so ready readonly nodes keep running truly in parallel
  // (the old global-first order let 3 queued writers starve every reader).
  // Global lock order: writeSem ≺ globalSem ≺ subprocessSem (no cycles — see
  // RFC-098 survey §wp5-4).
  const releaseWrite = agent.readonly ? null : await writeSem.acquire()
  const releaseGlobal = await globalSem.acquire()

  let lastResult: RunResult | null = null
  let lastError: string | null = null
  // RFC-092 T2 (audit S-2/S-2b): the pre-snapshot written by the most recent
  // FRESH-SESSION attempt of THIS invocation, kept in memory so the retry
  // rollback below targets the right baseline without re-querying node_runs
  // (the old `readSnapshotForLatestRun` ordered by retry_index and read only
  // the single-repo column — multi-repo rollbacks were silent no-ops and a
  // followup attempt's snapshot-less row shadowed the real baseline).
  // Follow-up attempts never overwrite it: they keep the worktree as-is, so
  // the last fresh-session snapshot stays the rollback target.
  let lastFreshSnapshot: {
    id: string
    preSnapshot: string | null
    preSnapshotReposJson: string | null
  } | null = null

  try {
    for (let attempt = retryIndex; attempt <= retryIndex + maxRetries; attempt++) {
      // RFC-042: when the previous attempt failed for a recognized envelope
      // reason AND opencode exited cleanly AND we captured a session id AND
      // the model emitted at least one text line, the next attempt resumes
      // the SAME opencode session with a short follow-up prompt. Any other
      // failure shape (process crash / timeout / no session / no text /
      // unrecognized error) falls back to the legacy fresh-session retry
      // path: rollback pre-snapshot and re-spawn with the full prompt.
      let followupDecision: EnvelopeFollowupDecision = { followup: false }
      let followupResumeSessionId: string | undefined
      if (attempt > retryIndex && lastResult !== null) {
        const textCountRow = await db
          .select({ c: sql<number>`count(*)` })
          .from(nodeRunEvents)
          .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'text')))
        // RFC-049: read the structured port-validation failures the prior
        // attempt's runner persisted (NULL → undefined; malformed JSON →
        // null via parsePortValidationFailuresJson, then coerced to
        // undefined for the decision input). decideEnvelopeFollowup uses
        // the failures array to populate the per-port repair prompt; absent
        // / empty arrays degrade gracefully (followup still fires on the
        // outer prefix, but the prompt skips per-kind specifics).
        const priorRunRow = (
          await db
            .select({ pvf: nodeRuns.portValidationFailuresJson })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, nodeRunId))
            .limit(1)
        )[0]
        const priorFailures = parsePortValidationFailuresJson(priorRunRow?.pvf ?? null)
        followupDecision = decideEnvelopeFollowup({
          status: lastResult.status,
          exitCode: lastResult.exitCode,
          errorMessage: lastResult.errorMessage ?? null,
          sessionId: lastResult.sessionId ?? null,
          agentTextCount: Number(textCountRow[0]?.c ?? 0),
          ...(priorFailures !== null ? { portValidationFailures: priorFailures } : {}),
        })
        if (followupDecision.followup) {
          followupResumeSessionId = lastResult.sessionId ?? undefined
        }
      }

      if (attempt > retryIndex) {
        // RFC-042: rollback / pre-snapshot is for fresh-session retries only.
        // Same-session follow-up KEEPS the worktree at whatever state the
        // first attempt left it in — the model is continuing the same
        // conversation; rolling back files behind its back would create a
        // mismatch between session memory and disk.
        if (!followupDecision.followup) {
          // RFC-092 T2 (audit S-2/S-2b): roll back to the last fresh-session
          // snapshot of THIS invocation via the shared multi-repo-aware
          // rollback. Always roll a writer back — even when no snapshot is in
          // hand ('' still does `reset --hard` + `clean -fd`, clearing the
          // failed attempt's partial writes; gating on a non-empty sha left
          // them behind, see scheduler-boundary-presnapshot-rollback-skip
          // .test.ts). Multi-repo: each sub-worktree rolls independently and
          // the container dir is never touched (nodeRollback.ts hard gate).
          if (!agent.readonly) {
            try {
              await rollbackNodeRunWorktrees(
                { repoCount: task.repoCount, worktreePath: task.worktreePath, repos: state.repos },
                lastFreshSnapshot ?? { id: nodeRunId, preSnapshot: '', preSnapshotReposJson: null },
                { resetOnEmptySnapshot: true },
                log,
              )
            } catch (err) {
              log.warn('retry rollback failed', {
                nodeId: node.id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
        // RFC-074 PR-C: a process-retry within the same clarify round surfaces
        // the answered Q&A via id-order generation derivation + the RFC-070
        // consumed-by stamps, not a carried clarifyIteration. shardKey /
        // parentNodeRunId still belong to this run-of-the-node and persist.
        nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending', attempt, iteration, {
          reviewIteration: inheritedReviewIteration,
          shardKey: inheritedShardKey,
          parentNodeRunId: inheritedParentNodeRunId,
          consumedUpstreamRunsJson: consumedUpstreamJson,
        })
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

        // RFC-042 / RFC-049: surface the follow-up decision as an audit
        // event so operators can replay how a green run recovered from a
        // failed prior attempt. Written on the FRESH row (so it sits in the
        // events list for the attempt that's about to run, not the failed
        // prior attempt). reason='port-validation' uses its own tag /
        // payload shape (RFC-049 §A6) so log aggregators can filter the
        // two failure classes apart.
        if (followupDecision.followup) {
          if (followupDecision.reason === 'port-validation') {
            // One audit row per failing port — keeps the payload symmetric
            // with how runner.ts persists multiple failures in the JSON
            // column (today fail-fast → always length 1, but the schema is
            // ready for the future batch-validate path).
            const failures =
              followupDecision.failures.length > 0
                ? followupDecision.failures
                : [{ port: '', kind: '', subReason: '' }]
            for (const f of failures) {
              await db.insert(nodeRunEvents).values({
                nodeRunId,
                ts: Date.now(),
                kind: 'text',
                payload: `[rfc049/port-validation-followup] ${JSON.stringify({
                  rfc: 'RFC-049',
                  port: f.port,
                  kind: f.kind,
                  subReason: f.subReason,
                  retryAttempt: attempt,
                })}`,
              })
            }
          } else {
            await db.insert(nodeRunEvents).values({
              nodeRunId,
              ts: Date.now(),
              kind: 'text',
              payload: `[rfc042/envelope-followup] ${JSON.stringify({
                rfc: 'RFC-042',
                reason: followupDecision.reason,
                retryAttempt: attempt,
              })}`,
            })
          }
        }
      }

      // RFC-042: pre-snapshot is also skipped on follow-up attempts (same
      // reason as rollback — the worktree must keep its current state so
      // opencode's session view matches disk).
      if (!agent.readonly && !followupDecision.followup) {
        try {
          if (task.repoCount === 1) {
            // RFC-066: single-path byte-baseline branch — `pre_snapshot`
            // remains the single-string column the resume path has always
            // read.
            const sha = await gitStashSnapshot(task.worktreePath)
            // RFC-092: remember the baseline in-process for the retry rollback
            // (set before the DB write so a failed write still leaves the
            // correct rollback target in hand).
            lastFreshSnapshot = { id: nodeRunId, preSnapshot: sha, preSnapshotReposJson: null }
            await db.update(nodeRuns).set({ preSnapshot: sha }).where(eq(nodeRuns.id, nodeRunId))
          } else {
            // RFC-066: multi-repo per-repo stash map. Each sub-worktree
            // gets its own `git stash create` sha; the resume path reads
            // back this JSON and rolls each repo independently. Repos with
            // a failed snapshot are recorded as empty strings so resume's
            // rollback skips them rather than crashing.
            const stashMap: Record<string, string> = {}
            for (const repo of state.repos) {
              try {
                stashMap[repo.worktreeDirName] = await gitStashSnapshot(repo.worktreePath)
              } catch (err) {
                log.warn('pre-snapshot per-repo failed', {
                  nodeRunId,
                  worktreeDirName: repo.worktreeDirName,
                  error: err instanceof Error ? err.message : String(err),
                })
                stashMap[repo.worktreeDirName] = ''
              }
            }
            const stashMapJson = JSON.stringify(stashMap)
            // RFC-092: in-process baseline for the retry rollback (see above).
            lastFreshSnapshot = {
              id: nodeRunId,
              preSnapshot: null,
              preSnapshotReposJson: stashMapJson,
            }
            await db
              .update(nodeRuns)
              .set({ preSnapshotReposJson: stashMapJson })
              .where(eq(nodeRuns.id, nodeRunId))
          }
        } catch (err) {
          log.warn('pre-snapshot failed', {
            nodeRunId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      try {
        // RFC-023: read this row so the prompt context surfaces the prior
        // round's Q&A. The row may have been minted at any of three sites
        // (pendingExisting, retry-mint, clarify-rerun mint from clarify
        // service); reading off the DB guarantees we see whatever each path set.
        const currentRunRow = (
          await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
        )[0]
        const currentShardKey = currentRunRow?.shardKey ?? null

        // RFC-074 PR-C: the clarify "generation" is derived from id-order, NOT
        // the retired `clarifyIteration` counter. The prior top-level `done`
        // rows for this node at the same (iteration, shardKey), minted before
        // this run (id < current), each represent an earlier completed clarify
        // generation; their count is the generation index the counter used to
        // hold. `done` (not canceled) so review-iterate supersede markers don't
        // inflate it, and parentNodeRunId === null so fan-out shard children
        // don't either.
        const priorDoneGenerations = currentRunRow
          ? await priorDoneGenerationsForRun(db, {
              taskId,
              nodeId: node.id,
              iteration: currentRunRow.iteration,
              shardKey: currentShardKey,
              id: currentRunRow.id,
            })
          : []
        const clarifyGeneration = priorDoneGenerations.length

        // RFC-026: resolve sessionMode from the clarify node attached to this
        // agent (if any). `inline` only takes effect when the current run is
        // a clarify-driven rerun (a later generation AND retryIndex === 0):
        //   - generation === 0  → first run, no prior session to resume
        //   - retryIndex > 0    → technical retry within same clarify round;
        //     design.md §7 forbids inline on retries to keep retry behavior
        //     deterministic when something went wrong mid-session
        const clarifyNodeForGate = hasClarifyChannel
          ? findClarifyNodeForAgent(definition, node.id)
          : undefined
        const clarifyNodeObjForGate = clarifyNodeForGate
          ? (findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
          : undefined
        const sessionMode = clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
        const isClarifyRerun = clarifyGeneration > 0 && (currentRunRow?.retryIndex ?? 0) === 0
        const priorSessionId =
          isClarifyRerun && currentRunRow
            ? await readPriorAgentSessionId(db, {
                taskId,
                agentNodeId: node.id,
                shardKey: currentShardKey,
                iteration: currentRunRow.iteration,
                beforeId: currentRunRow.id,
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
            extra: { clarifyGeneration },
          })
        }

        // RFC-056 §6 update mode (2026-05-22 amendment): when this rerun was
        // triggered by a cross-clarify submit, fetch the designer's latest done
        // node_run for this (taskId, nodeId, iteration) so we can inject its
        // output verbatim as `## Prior Output (to be updated)` and the agent
        // reads the working draft instead of regenerating from scratch.
        //
        // RFC-074 PR-C: the gate keys on the DERIVED clarify generation
        // (`clarifyGeneration > 0` — there is a prior completed generation),
        // never on retry_index and never on the retired clarifyIteration
        // counter. The freshest prior generation (priorDoneGenerations[max id])
        // is the working draft; an in-attempt RFC-042 retry shares the same
        // generation so it sees the same draft. The topology gate
        // `hasExternalFeedbackChannel` filters out nodes with no incoming
        // cross-clarify edge.
        const isCrossClarifyTriggeredRerun = hasExternalFeedbackChannel && clarifyGeneration > 0
        let priorDoneDesigner: typeof nodeRuns.$inferSelect | undefined
        if (isCrossClarifyTriggeredRerun) {
          // RFC-074 PR-C: the working draft for this clarify-driven rerun is
          // the freshest prior generation's done row (id < current) — exactly
          // the set already computed above. RFC-096: shared picker (the rows
          // are already done-only + top-level; the filters are belt-and-braces).
          priorDoneDesigner = pickFreshestRun(priorDoneGenerations, {
            topLevelOnly: true,
            statusIn: ['done'],
          })
        }

        // RFC-070: aging is row-state ("`consumed_by_..._run_id IS NULL`")
        // applied inside each read path (`buildPromptContext` /
        // `buildExternalFeedbackContext` / the legacy
        // `buildClarifyPromptContext` self path). The scheduler no longer
        // computes an iteration cutoff number — every previous mismatch
        // between unified `clarifyIteration` and `cross_clarify_sessions`'
        // local iteration counter is eliminated structurally.
        //
        // RFC-056 §5.4 §6.4: when the about-to-run node is a cross-clarify
        // questioner, pull the questioner's own Q&A from kind='cross' rows via
        // the cross-questioner consumer branch. Otherwise (self path) read
        // kind='self'. Both branches share the `applyLatestDirective:
        // isClarifyRerun` gate RFC-064 §5.5 unified.
        //
        // RFC-074: dropped the `&& currentClarifyIteration > 0` sub-condition.
        // It used to detect "post-cross-clarify-resolve rerun" via the cci
        // bump, but PR-B removed the cascade that bumped a DOWNSTREAM
        // questioner's cci — so a downstream questioner re-runs at cci=0 and the
        // gate misfired, dropping its Q&A and looping it. buildPromptContext
        // now self-gates for cross-questioner via the RFC-070 consumed-by stamp
        // (returns undefined when there is no unconsumed answered round), so the
        // cci proxy is no longer needed.
        const isQuestionerCrossClarifyRerun = clarifyMode === 'cross'
        const clarifyContext = hasClarifyChannel
          ? isQuestionerCrossClarifyRerun
            ? await buildPromptContext({
                db,
                definition,
                taskId,
                consumerKind: 'cross-questioner',
                consumerNodeId: node.id,
                targetIteration: clarifyGeneration,
                loopIter: iteration,
                applyLatestDirective: isClarifyRerun,
              })
            : await buildPromptContext({
                db,
                definition,
                taskId,
                consumerKind: 'self',
                consumerNodeId: node.id,
                targetIteration: clarifyGeneration,
                shardKey: currentShardKey,
                ...(resumeDecision.inlineMode ? { sessionMode: 'inline' as const } : {}),
                applyLatestDirective: isClarifyRerun,
              })
          : undefined
        // RFC-056: build the External Feedback context + (if update-mode)
        // the prior output block. RFC-070: aging applied inside
        // `buildExternalFeedbackContext` via `consumed_by_consumer_run_id
        // IS NULL`.
        const crossClarifyContext = hasExternalFeedbackChannel
          ? await buildExternalFeedbackContext({
              db,
              taskId,
              designerNodeId: node.id,
              loopIter: iteration,
              designerGeneration: clarifyGeneration,
              definition,
            })
          : undefined
        // Compose the prior-output block from the latest done designer's
        // captured port outputs. The agent's declared outputs[] determines
        // the order so the block is deterministic across reruns. Empty
        // outputs are dropped by buildPriorOutputBlock itself.
        if (
          isCrossClarifyTriggeredRerun &&
          priorDoneDesigner !== undefined &&
          crossClarifyContext !== undefined
        ) {
          const captured = await db
            .select()
            .from(nodeRunOutputs)
            .where(eq(nodeRunOutputs.nodeRunId, priorDoneDesigner.id))
          const byPort = new Map(captured.map((r) => [r.portName, r.content]))
          const ordered = (agent.outputs ?? [])
            .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
            .filter((o) => o.content.length > 0)
          const priorOutputBlock = buildPriorOutputBlock(ordered)
          if (priorOutputBlock.length > 0) {
            crossClarifyContext.priorOutputBlock = priorOutputBlock
          }
        }
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
            extra: { clarifyGeneration },
          })
        }
        // RFC-042: follow-up attempts re-use the prior attempt's opencode
        // session id (captured above into `followupResumeSessionId`) AND swap
        // the prompt for a short re-anchor directive. The RFC-026 inline
        // clarify-rerun resume path only fires on the FIRST attempt of a
        // clarify-driven rerun (`retryIndex === 0`); follow-up attempts are
        // strictly attempt > retryIndex so the two paths cannot fight over
        // the same `resumeSessionId` slot. When both contexts are present,
        // follow-up wins because it expresses what THIS attempt is for.
        const effectiveResumeSessionId = followupDecision.followup
          ? followupResumeSessionId
          : resumeDecision.resumeSessionId
        const followupClarifyDirective =
          followupDecision.followup && effectiveHasClarifyChannel
            ? clarifyContext?.directive
            : undefined
        lastResult = await runNode({
          taskId,
          nodeRunId,
          nodeId: node.id,
          agent,
          inputs: upstreamInputs,
          worktreePath: task.worktreePath,
          // RFC-067: thread per-task Git commit identity through to the runner
          // so `git commit` invocations inside the agent inherit the
          // task-scoped author + committer. Both NULL → runner skips
          // injection and falls back to daemon's default git config.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: node.id,
            iteration,
            // RFC-066: per-repo metadata for the {{__repos__}} /
            // {{__repo_names__}} / {{__repo_count__}} placeholders.
            repos: state.repos,
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          ...(reviewContext !== undefined ? { reviewContext } : {}),
          ...(clarifyContext !== undefined ? { clarifyContext } : {}),
          ...(crossClarifyContext !== undefined ? { crossClarifyContext } : {}),
          ...(clarifyMode === 'cross' ? { clarifyMode: 'cross' as const } : {}),
          ...(nodeOverrides !== undefined ? { overrides: nodeOverrides } : {}),
          ...(effectiveResumeSessionId !== undefined
            ? { resumeSessionId: effectiveResumeSessionId }
            : {}),
          ...(followupDecision.followup
            ? {
                envelopeFollowup: true as const,
                envelopeFollowupReason: followupDecision.reason,
                ...(followupClarifyDirective !== undefined
                  ? { envelopeFollowupClarifyDirective: followupClarifyDirective }
                  : {}),
                // RFC-049: thread the structured failures through to the
                // runner so it can render the per-kind repair block via
                // composePerKindRepairBlocks. Empty array (degraded mode)
                // is fine — the followup still fires; the runner just
                // omits the per-port section.
                ...(followupDecision.reason === 'port-validation'
                  ? { envelopeFollowupPortValidations: followupDecision.failures }
                  : {}),
              }
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
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
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
              extra: { clarifyGeneration },
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
    releaseGlobal()
    releaseWrite?.()
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
    // RFC-056: prefer the cross-clarify route if the questioner's
    // __clarify__ port is wired to a clarify-cross-agent node. The
    // shared helper short-circuits when no cross-clarify target exists,
    // falling through to the RFC-023 self-clarify path below.
    const crossClarifyNodeId = findCrossClarifyNodeForQuestioner(definition, node.id)
    if (crossClarifyNodeId !== undefined) {
      const currentRunRowXc = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
      const designerNodeId = findDesignerNodeForCrossClarify(definition, crossClarifyNodeId)
      // Defensive: persistent stop would have been short-circuited at
      // dispatch already. If the questioner still emitted clarify, treat
      // as protocol violation. Caller's retries (RFC-042) kick in.
      const persistentRow = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .limit(1)
      void persistentRow
      await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId,
        sourceQuestionerNodeId: node.id,
        sourceQuestionerNodeRunId: nodeRunId,
        targetDesignerNodeId: designerNodeId ?? null,
        loopIter: currentRunRowXc?.iteration ?? 0,
        questions: lastResult.clarify.questions,
        ...(lastResult.clarify.truncationWarnings.length > 0
          ? { truncationWarnings: lastResult.clarify.truncationWarnings }
          : {}),
      })
      return {
        kind: 'awaiting_human',
        summary: `questioner ${node.id} asked back via cross-clarify node ${crossClarifyNodeId}`,
        message: 'cross-clarify-awaiting-human',
      }
    }

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
    // RFC-074 PR-C: the clarify round index is the asking run's generation —
    // the count of its prior completed generations (id-order) — not the retired
    // clarifyIteration counter. First clarify round → generation 0.
    const askingGeneration = currentRunRow
      ? (
          await priorDoneGenerationsForRun(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentRunRow.shardKey ?? null,
            id: currentRunRow.id,
          })
        ).length
      : 0
    await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: node.id,
      sourceAgentNodeRunId: nodeRunId,
      sourceShardKey: currentRunRow?.shardKey ?? null,
      clarifyNodeId,
      iterationIndex: askingGeneration,
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
// RFC-040 — wrapper resume helpers shared by runLoopWrapperNode and
// runGitWrapperNode.
//
// Why they exist: before RFC-040, both wrappers silently swallowed
// `awaiting_human` / `awaiting_review` signals from their inner scope (only
// `canceled` / `failed` were matched) and either kept iterating (loop) or
// computed a diff against a half-finished worktree (git). The result was N
// ghost clarify/review rows and, for git, a wrong final diff. The fix is to
// (a) bubble the awaiting signal up unchanged, (b) persist enough state on
// the wrapper's node_run so the dispatcher can resume from the same loop
// iteration / git baseline when the user answers clarify or decides review,
// and (c) reuse the existing wrapper node_run row on resume instead of
// minting a fresh one. See design/RFC-040-wrapper-await-bubble/design.md §4.
// -----------------------------------------------------------------------------

/**
 * Find a non-terminal wrapper node_run row for (taskId, nodeId, iteration)
 * to resume into, if any. Terminal states (done / failed / canceled /
 * exhausted) return null — the dispatcher should mint a fresh wrapper run
 * for them (e.g. a sibling iteration of an outer loop wrapper).
 *
 * latestPerNode in runScope keys on nodeId only and would otherwise return
 * a stale row from another iteration when an outer loop wrapper drives the
 * dispatch; we MUST filter by iteration here to avoid grabbing a sibling
 * iteration's wrapper row.
 */
async function findResumableWrapperRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  parentIteration: number,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, parentIteration),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  if (rows.length === 0) return null
  const r = rows[0]!
  if (r.status === 'done' || r.status === 'failed' || r.status === 'exhausted') {
    // RFC-095 (audit S-22): 'canceled' is NO LONGER terminal here — a wrapper
    // row canceled by task-cancel resumes from its persisted progress when the
    // task is revived via retryNode (loop continues at the parked iteration,
    // git keeps its pre-inner baseline), exactly like 'interrupted'. Restarting
    // instead (the old behavior: mint a fresh wrapper row) would rewind the
    // loop to iteration 0 and re-capture a WRONG git baseline.
    return null
  }
  return r
}

async function persistWrapperProgress(
  db: DbClient,
  wrapperRunId: string,
  progress: WrapperProgress,
): Promise<void> {
  await db
    .update(nodeRuns)
    .set({ wrapperProgressJson: encodeWrapperProgress(progress) })
    .where(eq(nodeRuns.id, wrapperRunId))
}

async function markWrapperTerminal(
  db: DbClient,
  wrapperRunId: string,
  status: 'done' | 'failed' | 'canceled' | 'exhausted',
  errorMessage?: string,
): Promise<void> {
  // RFC-053: wrapper finalize is a runtime-determined transition into one of
  // four terminal states. setNodeRunStatus with allowedFrom=['running'] is
  // the typical legal source; awaiting_* is also legal when a wrapper bubbled
  // up an awaiting child and is now being short-circuited by cancel.
  await setNodeRunStatus({
    db,
    nodeRunId: wrapperRunId,
    to: status,
    allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human'],
    reason: 'wrapper-finalize',
    extra: {
      finishedAt: Date.now(),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  })
  // Note: wrapperProgressJson is left in place after terminal transitions —
  // it's debug breadcrumb for "where did this wrapper park last" and is
  // never read again by the scheduler once status is terminal.
}

// -----------------------------------------------------------------------------
// wrapper-loop (P-4-01) — RFC-040 makes it bubble awaiting_* and resumable.
// -----------------------------------------------------------------------------

async function runLoopWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId } = state
  const { node, iteration: parentIteration, log } = args
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

  // RFC-040 resume detection: if the dispatcher re-entered us after we
  // previously bubbled awaiting_*, reuse our prior wrapper row and pick up
  // at the persisted iteration. The user answered clarify / decided review
  // while we were parked; the inner runScope's deriveFrontier sees the
  // freshly-minted agent rerun row inside iter N (the wrapper itself was
  // re-dispatched because wrapperHasFreshInnerWork saw that pending row —
  // dispatchFrontier.ts; the old rescanScopeForNewPendingRows this comment
  // used to cite was deleted in RFC-076, comment fixed by RFC-094 S-26).
  const existing = await findResumableWrapperRun(db, taskId, node.id, parentIteration)
  let wrapperRunId: string
  let startIter = 0
  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, (msg) => log.warn(msg))
    wrapperRunId = existing.id
    if (progress?.kind === 'loop' && typeof progress.iteration === 'number') {
      startIter = progress.iteration
    } else {
      // Malformed / missing payload — observable regression to "start over",
      // but at least we don't double-mint a wrapper row. decodeWrapperProgress
      // already logged a warn if applicable.
      startIter = 0
    }
    if (existing.status !== 'running') {
      // RFC-053: wrapper enter-running — resumes from awaiting_* / pending.
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
  } else {
    wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, parentIteration)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
  }

  const innerSet = new Set(inner)
  for (let i = startIter; i < maxIter; i++) {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'inner-running',
    })

    const subRes = await runScope(state, {
      scopeIds: innerSet,
      iteration: i,
      log: log.child(`loop:${node.id}`),
    })
    if (subRes.kind === 'canceled') {
      await markWrapperTerminal(db, wrapperRunId, 'canceled')
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
      return { kind: 'canceled', summary: subRes.detail?.summary ?? 'canceled', message: '' }
    }
    if (subRes.kind === 'failed') {
      await markWrapperTerminal(
        db,
        wrapperRunId,
        'failed',
        subRes.detail?.message ?? 'inner failed',
      )
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: subRes.detail?.summary ?? `wrapper-loop ${node.id} inner failed`,
        message: subRes.detail?.message ?? 'inner failed',
      }
    }
    // RFC-040: bubble awaiting_* up. Wrapper stays non-terminal; its status
    // mirrors the inner park so the task chip reads "awaiting human/review".
    if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'loop',
        iteration: i,
        phase: 'awaiting',
      })
      const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
      // RFC-053: wrapper bubbles inner awaiting_* — park-human / park-review
      // enforces pending|running → awaiting_*.
      await transitionNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        event: subRes.kind === 'awaiting_human' ? { kind: 'park-human' } : { kind: 'park-review' },
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
      return {
        kind: subRes.kind,
        summary: subRes.detail?.summary ?? '',
        message: subRes.detail?.message ?? '',
      }
    }

    // subRes.kind === 'ok' — evaluate exit condition for this iteration.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'iter-done',
    })
    const portContent = await readPortAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, portContent)) {
      for (const b of bindings) {
        const v = await readPortAtIteration(db, taskId, b.bind.nodeId, b.bind.portName, i)
        await db
          .insert(nodeRunOutputs)
          .values({ nodeRunId: wrapperRunId, portName: b.name, content: v })
      }
      await markWrapperTerminal(db, wrapperRunId, 'done')
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
      return { kind: 'ok', summary: '', message: '' }
    }
  }

  // Exhausted: max iterations without exit.
  await markWrapperTerminal(db, wrapperRunId, 'exhausted', 'max iterations reached')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'exhausted')
  return {
    kind: 'failed',
    summary: `wrapper-loop ${node.id} exhausted after ${maxIter} iterations`,
    message: 'wrapper-loop-exhausted',
  }
}

// -----------------------------------------------------------------------------
// wrapper-fanout (RFC-060) — fan a list<T> shardSource into N parallel inner
// dispatches, optionally aggregated by an inner role='aggregator' agent.
//
// PR-D v1 inner-kind support: agent-single only. agent-multi / wrapper-*
// / review / clarify / clarify-cross-agent / output / input inside a
// wrapper-fanout's inner subgraph are PR-D2 scope and fail at runtime with
// `wrapper-fanout-v1-unsupported-inner-kind` (the user gets a clear error
// rather than silent wrong behavior). The validator emits a static warning
// for the nested wrapper-fanout case; runtime rejection here is the
// secondary safety net.
//
// Lifecycle (RFC-053 compatible — D.T8):
//   pending → running → done | failed
// Shard child rows are minted with parentNodeRunId=wrapperRunId so they
// don't bubble into latestPerNode of the wrapper's parent scope.
// -----------------------------------------------------------------------------

async function runFanoutWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition, opts, log: stateLog } = state
  const { node, iteration, log } = args

  // 1. Schema-shape validation (defensive — validator catches most pre-run).
  const rec = node as Record<string, unknown>
  const inputs = Array.isArray(rec.inputs) ? (rec.inputs as WrapperFanoutPort[]) : []
  const shardPort = inputs.find((p) => p?.isShardSource === true)
  if (shardPort === undefined) {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} missing shardSource input`,
      message: 'wrapper-fanout-shard-source-missing',
    }
  }
  const parsedKind = tryParseKind(shardPort.kind)
  if (parsedKind === null || parsedKind.kind !== 'list') {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} shardSource port '${shardPort.name}' kind '${shardPort.kind}' must be list<T>`,
      message: 'wrapper-fanout-shard-source-not-list',
    }
  }
  const itemKind = parsedKind.item
  const innerIds = pickStringArray(node, 'nodeIds')
  if (innerIds.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  // 2. Hydrate the inner-node agent map. findFanoutAggregator + scope
  // computation both consult this. Missing-agent here is fatal.
  const agentNames = new Set<string>()
  for (const id of innerIds) {
    const inner = definition.nodes.find((n) => n.id === id)
    if (inner === undefined) continue
    const an = (inner as Record<string, unknown>).agentName
    if (typeof an === 'string') agentNames.add(an)
  }
  const agentsMap = new Map<string, Agent>()
  for (const name of agentNames) {
    const a = await getAgent(db, name)
    if (a !== null) agentsMap.set(name, a)
  }

  // 3. Wrapper row resume / mint (mirrors wrapper-git pattern).
  const existing = await findResumableWrapperRun(db, taskId, node.id, iteration)
  let wrapperRunId: string
  if (existing !== null) {
    wrapperRunId = existing.id
    if (existing.status !== 'running') {
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-fanout-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
  } else {
    wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
  }

  // 4. Read shardSource content via upstream resolution. Boundary-input edges
  // (source.nodeId = wrapper) are NOT involved here — those edges connect the
  // wrapper's own input ports to inner nodes; the upstream shardSource value
  // arrives at the wrapper via a regular edge (target.nodeId = wrapper.id,
  // target.portName = shardPort.name).
  const { inputs: upstreamInputs, consumed: wrapperConsumed } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
  )
  const rawContent = upstreamInputs[shardPort.name] ?? ''
  // RFC-074 §8 (D3): the fan-out wrapper is provenance-atomic — record which
  // upstream runs the wrapper consumed on the wrapper row so freshness can
  // re-run the whole wrapper when an upstream advances. Inner shard rows do NOT
  // record provenance (treated as fresh within this wrapper run).
  await db
    .update(nodeRuns)
    .set({ consumedUpstreamRunsJson: JSON.stringify(wrapperConsumed) })
    .where(eq(nodeRuns.id, wrapperRunId))

  // 5. Derive wrapper outlets (aggregator outputs OR __done__ signal).
  const derivedOutputs = deriveWrapperFanoutOutputs(definition, node.id, agentsMap)

  // 6. Empty source: short-circuit done with empty outlets.
  const items = rawContent
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (items.length === 0) {
    for (const port of derivedOutputs) {
      await db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: wrapperRunId, portName: port.name, content: '' })
    }
    await markWrapperTerminal(db, wrapperRunId, 'done')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: 'wrapper-fanout-empty' }
  }

  // 7. Cartesian guard (D.T6). Multiplies through nested wrapper-fanout's
  // expectedShardCount (estimateShardTotal) so the user gets a bounded
  // failure rather than a flood of node_runs.
  const maxAllowed = opts.fanoutMaxShardTotal ?? 256
  const projectedTotal = estimateShardTotal(definition, node.id, items.length)
  if (projectedTotal > maxAllowed) {
    await markWrapperTerminal(
      db,
      wrapperRunId,
      'failed',
      `cartesian-exceeds-max:${projectedTotal}>${maxAllowed}`,
    )
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} would mint ${projectedTotal} shards > limit ${maxAllowed}`,
      message: `wrapper-fanout-cartesian-exceeds-max:${projectedTotal}`,
    }
  }

  // 8. Compute shard scope (D.T1) + apply auto-promote.
  let scope = computeShardScope({ wrapperId: node.id, defn: definition, agents: agentsMap })
  scope = applyAutoPromote(scope, definition)

  // 9. Build shards with per-item shardKey (resolveKeyOf — path-family uses
  // the path itself, others default to 0-based index).
  const keyOf = resolveKeyOf(itemKind)
  // Disambiguate colliding shardKeys (e.g. duplicate path items, whose
  // path-family key IS the path string) by suffixing the index, so every item
  // gets a UNIQUE shard identity. Without this, two equal items mint two
  // children with the same shardKey and the aggregator's find-by-shardKey drops
  // one. See scheduler-boundary-fanout-shardkey-collision.test.ts.
  const seenShardKeys = new Set<string>()
  const shards = items.map((value, idx) => {
    let shardKey = keyOf(value, idx, itemKind)
    if (seenShardKeys.has(shardKey)) shardKey = `${shardKey}#${idx}`
    seenShardKeys.add(shardKey)
    return { shardKey, value }
  })

  // 10. Dispatch each inner node (skip aggregator — handled last).
  for (const innerId of innerIds) {
    const inner = definition.nodes.find((n) => n.id === innerId)
    if (inner === undefined) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-missing:${innerId}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner node '${innerId}' not found in definition`,
        message: `wrapper-fanout-inner-missing:${innerId}`,
      }
    }
    if (innerId === scope.aggregatorId) continue

    if (inner.kind !== 'agent-single') {
      await markWrapperTerminal(
        db,
        wrapperRunId,
        'failed',
        `v1-unsupported-inner-kind:${inner.kind}`,
      )
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner '${innerId}' kind '${inner.kind}' — v1 supports agent-single only inside wrapper-fanout (PR-D2 will extend support)`,
        message: `wrapper-fanout-v1-unsupported-inner-kind:${inner.kind}`,
      }
    }

    const innerAgentName = (inner as Record<string, unknown>).agentName
    if (typeof innerAgentName !== 'string') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-missing-agentName:${innerId}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner '${innerId}' missing agentName`,
        message: 'wrapper-fanout-inner-missing-agent-name',
      }
    }
    const innerAgent = agentsMap.get(innerAgentName)
    if (innerAgent === undefined) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-agent-missing:${innerAgentName}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner agent '${innerAgentName}' not found`,
        message: `agent-not-found:${innerAgentName}`,
      }
    }

    // Per-shard boundary-input edges from THIS wrapper to THIS inner node.
    // Used to inject shard value into the inner's resolved inputs when an
    // edge binds wrapper.shardPort.name → inner.somePort.
    const boundaryEdges = findBoundaryEdgesToInner(definition, node.id, innerId)
    // RFC-074 §8: inner shard nodes do NOT record provenance (fresh within the
    // wrapper run); take only the resolved inputs.
    const { inputs: innerUpstream } = await resolveUpstreamInputs(
      db,
      taskId,
      definition.edges,
      innerId,
      iteration,
      log,
    )

    if (scope.perShard.has(innerId)) {
      const shardResults = await Promise.all(
        shards.map((sh) =>
          dispatchFanoutShard({
            state,
            wrapperId: node.id,
            wrapperRunId,
            innerNode: inner,
            innerAgent,
            iteration,
            shard: sh,
            shardSourcePortName: shardPort.name,
            boundaryEdges,
            broadcastInputs: innerUpstream,
            log: log.child(`fanout:${node.id}:${innerId}`),
          }),
        ),
      )
      // Cancel takes precedence over failure: when the task was aborted, shards
      // come back 'canceled' (SIGTERM) — the wrapper row must reflect 'canceled',
      // not 'failed' (a canceled task should leave no 'failed' run). See
      // scheduler-boundary-canceled-fanout-status.test.ts.
      if (shardResults.some((r) => r.kind === 'canceled') || opts.signal?.aborted === true) {
        await markWrapperTerminal(db, wrapperRunId, 'canceled')
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
        return {
          kind: 'canceled',
          summary: `wrapper-fanout ${node.id} canceled`,
          message: 'canceled',
        }
      }
      const failedShards = shardResults.filter((r) => r.kind === 'failed')
      if (failedShards.length > 0) {
        const msg = failedShards.map((f) => `${f.shardKey}:${f.message}`).join(' | ')
        await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-shard-failed:${msg}`)
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
        return {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} inner '${innerId}' ${failedShards.length}/${shards.length} shards failed`,
          message: msg,
        }
      }
    } else {
      // Shared inner: dispatch once (no shardKey). Boundary-input edges from
      // the shardSource port don't make sense for shared inner nodes (a
      // shared node by definition isn't shard-aware); the validator should
      // already prevent that wiring — if it slipped through, the boundary
      // edge injection below still copies the first shard's value, which is
      // an acceptable degenerate behavior.
      const r = await dispatchFanoutShard({
        state,
        wrapperId: node.id,
        wrapperRunId,
        innerNode: inner,
        innerAgent,
        iteration,
        shard: null,
        shardSourcePortName: shardPort.name,
        boundaryEdges,
        broadcastInputs: innerUpstream,
        log: log.child(`fanout:${node.id}:${innerId}:shared`),
      })
      if (r.kind === 'canceled' || opts.signal?.aborted === true) {
        await markWrapperTerminal(db, wrapperRunId, 'canceled')
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
        return {
          kind: 'canceled',
          summary: `wrapper-fanout ${node.id} canceled`,
          message: 'canceled',
        }
      }
      if (r.kind === 'failed') {
        await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-shared-failed:${r.message}`)
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
        return {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} inner shared '${innerId}' failed`,
          message: r.message,
        }
      }
    }
  }

  // 11. Aggregator dispatch (D.T3) — collect every perShard inner agent's
  // outputs into raw lists keyed by shardKey, dispatched once.
  if (scope.aggregatorId !== null) {
    const aggInfo = findFanoutAggregator(definition, node.id, agentsMap)
    if (aggInfo === null) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', 'aggregator-resolve-failed')
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: 'aggregator agent resolution failed',
        message: 'aggregator-resolve-failed',
      }
    }
    const aggRes = await dispatchFanoutAggregator({
      state,
      wrapperId: node.id,
      wrapperRunId,
      aggNode: aggInfo.node,
      aggAgent: aggInfo.agent,
      iteration,
      shards,
      definition,
      scope,
      log: log.child(`fanout:${node.id}:aggregator`),
    })
    if (aggRes.kind === 'failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `aggregator-failed:${aggRes.message}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return aggRes
    }
    // Propagate aggregator outputs → wrapper outlets, renamed by
    // outputWrapperPortNames where set (RFC-060 design §5.4).
    const renames = aggInfo.agent.outputWrapperPortNames ?? {}
    for (const port of aggInfo.agent.outputs) {
      const outletName = renames[port] ?? port
      const content = aggRes.outputs[port] ?? ''
      await db
        .insert(nodeRunOutputs)
        .values({ nodeRunId: wrapperRunId, portName: outletName, content })
    }
  } else {
    // No aggregator: emit the implicit __done__ signal outlet. Empty content;
    // downstream can chain on it but must NOT reference it inside {{...}} —
    // assertNoPromptSignalRefs (D.T7) catches that at prompt-render time.
    await db.insert(nodeRunOutputs).values({
      nodeRunId: wrapperRunId,
      portName: FANOUT_DONE_PORT_NAME,
      content: '',
    })
  }

  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  stateLog.info('wrapper-fanout done', {
    taskId,
    nodeId: node.id,
    shards: shards.length,
    hasAggregator: scope.aggregatorId !== null,
  })
  return { kind: 'ok', summary: '', message: '' }
}

interface ShardSpec {
  shardKey: string
  value: string
}

interface DispatchShardArgs {
  state: SchedulerState
  wrapperId: string
  wrapperRunId: string
  innerNode: WorkflowNode
  innerAgent: Agent
  iteration: number
  /** null = shared (broadcast) dispatch — no shardKey, runs once. */
  shard: ShardSpec | null
  shardSourcePortName: string
  boundaryEdges: WorkflowEdge[]
  broadcastInputs: Record<string, string>
  log: Logger
}

interface DispatchShardResult {
  kind: 'ok' | 'failed' | 'canceled'
  shardKey: string
  outputs: Record<string, string>
  message: string
}

/**
 * Dispatch one agent-single inner node for one shard (or shared/broadcast
 * mode when `shard === null`). Mints a node_run row with shardKey +
 * parentNodeRunId=wrapperRunId, runs `runNode`, persists outputs.
 *
 * v1 limitations (PR-D2 will extend):
 *   - No clarify / review channel — the channel hooks are wired in by the
 *     scheduler's runOneNode single-agent branch; bringing that whole branch
 *     in here would duplicate ~500 lines. PR-D2's per-shard review (D.T4)
 *     and per-shard clarify (D.T5) will add the corresponding hand-offs.
 *   - No retry / envelope follow-up. The fanout wrapper's failure semantics
 *     are FAIL-ALL-AFTER-JOIN (RFC-094 / audit S-18): every shard runs to
 *     completion, then ANY failed shard fails the whole wrapper and skips
 *     aggregation — it is not fail-fast (siblings are not cancelled), and it
 *     is not partial-tolerant either (design.md §6.3; the errors-port partial
 *     semantics are deferred to WP-6b). Locked by scheduler-audit-s18.
 */
async function dispatchFanoutShard(args: DispatchShardArgs): Promise<DispatchShardResult> {
  const {
    state,
    wrapperRunId,
    innerNode,
    innerAgent,
    iteration,
    shard,
    shardSourcePortName,
    boundaryEdges,
    broadcastInputs,
    log,
  } = args
  const { db, task, taskId, opts } = state

  const shardKey = shard?.shardKey ?? '__shared__'
  const rowShardKey = shard === null ? null : shardKey

  // Idempotent (re)dispatch: a reaped prior run can leave a child row for this
  // (wrapper run, shardKey). Reuse it instead of minting a duplicate — the
  // aggregator's find-by-shardKey would otherwise pick the older empty one. A
  // 'done' child is reused as-is (its outputs are still valid); a
  // non-terminal/failed child is re-run in place. Only a missing child mints a
  // fresh row. See scheduler-boundary-fanout-resume-duplicate-shards.test.ts.
  const priorChildren = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, innerNode.id),
        eq(nodeRuns.parentNodeRunId, wrapperRunId),
      ),
    )
  const priorChild = priorChildren.find((r) => (r.shardKey ?? null) === rowShardKey)
  let shardRunId: string
  if (priorChild !== undefined && priorChild.status === 'done') {
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, priorChild.id))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    broadcastNodeStatus(taskId, priorChild.id, innerNode.id, 'done')
    return { kind: 'ok', shardKey, outputs, message: '' }
  }
  if (priorChild !== undefined) {
    // Re-run the existing non-terminal/failed child in place. allowTerminal: a
    // reaped child is 'interrupted' (terminal); reset to pending so runNode's
    // mark-running (pending → running) applies cleanly.
    shardRunId = priorChild.id
    await setNodeRunStatus({
      db,
      nodeRunId: shardRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-shard-resume',
    })
  } else {
    shardRunId = ulid()
    await db.insert(nodeRuns).values({
      id: shardRunId,
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      retryIndex: 0,
      iteration,
      parentNodeRunId: wrapperRunId,
      shardKey: rowShardKey,
      startedAt: Date.now(),
    })
  }
  broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'pending')

  // Build inner inputs: broadcast first, then inject shard value for any
  // boundary-input edge that wires the wrapper's shardSource port into one
  // of the inner's input ports.
  const inputs: Record<string, string> = { ...broadcastInputs }
  if (shard !== null) {
    for (const e of boundaryEdges) {
      if (e.source.portName !== shardSourcePortName) continue
      inputs[e.target.portName] = shard.value
    }
  }

  // RFC-060 D.T7: build inputPortKinds from boundary edges so the runner can
  // refuse `{{port}}` references against signal-kind inputs. We look up each
  // boundary edge's source port on the wrapper itself to find its declared
  // kind (signal / list<T> / etc.) and stash that against the target
  // (inner's local) port name.
  const inputPortKinds: Record<string, string> = {}
  const wrapper = args.state.definition.nodes.find((n) => n.id === args.wrapperId)
  if (wrapper !== undefined && wrapper.kind === 'wrapper-fanout') {
    const wrapperInputs = ((wrapper as Record<string, unknown>).inputs ?? []) as WrapperFanoutPort[]
    for (const e of boundaryEdges) {
      const wp = wrapperInputs.find((p) => p.name === e.source.portName)
      if (wp !== undefined) {
        // For shardSource ports, the inner receives ONE item (the shard
        // value); the item's effective kind is the list's item kind, not
        // `list<T>`. For non-shard broadcast boundary ports, the kind is
        // the wrapper's declared input kind verbatim.
        if (wp.isShardSource === true) {
          const lk = tryParseKind(wp.kind)
          if (lk !== null && lk.kind === 'list') {
            // stringify the item kind so the runner side can re-parse.
            const itemRepr = (() => {
              const item = lk.item
              if (item.kind === 'base') return item.name
              if (item.kind === 'path') return `path<${item.ext}>`
              // nested list<list<...>> — uncommon, but stringify recursively
              if (item.kind === 'list') {
                // delegated to stringifyKind via JSON-friendly fallback
                return 'list'
              }
              return 'string'
            })()
            inputPortKinds[e.target.portName] = itemRepr
          } else {
            inputPortKinds[e.target.portName] = wp.kind
          }
        } else {
          inputPortKinds[e.target.portName] = wp.kind
        }
      }
    }
  }

  const injection = await prepareNodeRunInjection(db, opts.appHome, innerAgent, log)
  if (injection.kind === 'failed') {
    await setNodeRunStatus({
      db,
      nodeRunId: shardRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-shard-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
    })
    broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
    return { kind: 'failed', shardKey, outputs: {}, message: injection.message }
  }
  const promptTemplate = pickString(innerNode, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(innerNode, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const nodeOverrides = pickOverrides(innerNode)

  // Concurrency: fan-out shards previously bypassed every cap. Acquire the
  // global node slot + the fan-out subprocess slot (the previously-dead
  // subprocessSem), plus the write slot for non-readonly shards so writers
  // serialize on the shared worktree. See scheduler-boundary-fanout-concurrency.test.ts.
  // RFC-098 B1 (audit S-17): write ≺ global ≺ subprocess (see single-node site).
  const releaseWrite = innerAgent.readonly ? null : await state.writeSem.acquire()
  const releaseGlobal = await state.globalSem.acquire()
  const releaseSub = await state.subprocessSem.acquire()
  try {
    const result = await runNode({
      taskId,
      nodeRunId: shardRunId,
      nodeId: innerNode.id,
      agent: innerAgent,
      inputs,
      worktreePath: task.worktreePath,
      // RFC-067: per-task Git identity threaded through fanout shard dispatch.
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      templateMeta: {
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        taskId,
        nodeId: innerNode.id,
        iteration,
        ...(shard !== null ? { shardKey } : {}),
        // RFC-066: per-repo metadata for prompt placeholders.
        repos: state.repos,
      },
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
      ...(nodeOverrides !== undefined ? { overrides: nodeOverrides } : {}),
      hasClarifyChannel: false, // PR-D2: per-shard clarify
      skills: injection.resolvedSkills,
      dependents: injection.dependents,
      mcps: injection.mcps,
      plugins: injection.plugins,
      appHome: opts.appHome,
      ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
      ...(Object.keys(inputPortKinds).length > 0 ? { inputPortKinds } : {}),
      db,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.subagentLiveCapture !== undefined
        ? { subagentLiveCapture: opts.subagentLiveCapture }
        : {}),
    })
    broadcastNodeStatus(taskId, shardRunId, innerNode.id, result.status)
    if (result.status === 'canceled') {
      return { kind: 'canceled', shardKey, outputs: {}, message: result.errorMessage ?? 'canceled' }
    }
    if (result.status !== 'done') {
      return {
        kind: 'failed',
        shardKey,
        outputs: {},
        message: result.errorMessage ?? `shard-${result.status}`,
      }
    }
    return { kind: 'ok', shardKey, outputs: result.outputs, message: '' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
    return { kind: 'failed', shardKey, outputs: {}, message: msg }
  } finally {
    releaseSub()
    releaseGlobal()
    releaseWrite?.()
  }
}

interface DispatchAggregatorArgs {
  state: SchedulerState
  wrapperId: string
  wrapperRunId: string
  aggNode: WorkflowNode
  aggAgent: Agent
  iteration: number
  shards: ShardSpec[]
  definition: WorkflowDefinition
  scope: ReturnType<typeof computeShardScope>
  log: Logger
}

/**
 * Dispatch the wrapper-fanout's aggregator agent — runs once, with per-shard
 * inner outputs collected into raw lists. The aggregator's prompt template
 * accesses these via {{#each port.shards}}{{shardKey}}: {{content}}{{/each}}
 * (PR-D2 will add that template syntax to renderUserPrompt; PR-D ships the
 * minimum: each per-shard output is delimited by a blank line and prefixed
 * with `### <shardKey>` so even a plain `{{port}}` substitution gives the
 * aggregator readable input).
 */
async function dispatchFanoutAggregator(
  args: DispatchAggregatorArgs,
): Promise<OneNodeResult & { outputs: Record<string, string> }> {
  const { state, wrapperRunId, aggNode, aggAgent, iteration, shards, definition, scope, log } = args
  const { db, task, taskId, opts } = state

  // Collect each perShard inner's outputs across all shards. The aggregator
  // declares (via its edges' target.portName) which inner port to read; we
  // group by aggregator-input port name → newline-joined `### shardKey` blocks.
  // boundary-input edges from the wrapper itself are NOT relevant here (the
  // aggregator sits inside the wrapper and consumes inner-to-inner edges).
  const aggInputs: Record<string, string> = {}
  const incoming = definition.edges.filter(
    (e) => e.target.nodeId === aggNode.id && e.boundary === undefined,
  )
  for (const edge of incoming) {
    const blocks: string[] = []
    // For each shard, pick the corresponding inner node_run + read port.
    const innerRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, edge.source.nodeId),
          eq(nodeRuns.parentNodeRunId, wrapperRunId),
        ),
      )
    if (scope.perShard.has(edge.source.nodeId)) {
      // sorted by shardKey dictionary order (matches agent-multi convention).
      const sortedShards = [...shards].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
      for (const s of sortedShards) {
        const row = innerRows.find((r) => r.shardKey === s.shardKey)
        if (row === undefined) continue
        const outRows = await db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, row.id))
        const port = outRows.find((o) => o.portName === edge.source.portName)
        if (port !== undefined) {
          blocks.push(`### ${s.shardKey}\n${port.content}`)
        }
      }
    } else {
      // shared upstream — single row, plain content.
      const row = innerRows.find((r) => r.shardKey === null)
      if (row !== undefined) {
        const outRows = await db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, row.id))
        const port = outRows.find((o) => o.portName === edge.source.portName)
        if (port !== undefined) blocks.push(port.content)
      }
    }
    aggInputs[edge.target.portName] = blocks.join('\n\n')
  }

  // Mint aggregator node_run row. The aggregator does NOT carry shardKey
  // (it's the convergence point); parentNodeRunId=wrapperRunId so its row
  // also doesn't leak into the parent scope's latestPerNode.
  const aggRunId = ulid()
  await db.insert(nodeRuns).values({
    id: aggRunId,
    taskId,
    nodeId: aggNode.id,
    status: 'pending',
    retryIndex: 0,
    iteration,
    parentNodeRunId: wrapperRunId,
    shardKey: null,
    startedAt: Date.now(),
  })
  broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'pending')

  const injection = await prepareNodeRunInjection(db, opts.appHome, aggAgent, log)
  if (injection.kind === 'failed') {
    await setNodeRunStatus({
      db,
      nodeRunId: aggRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-aggregator-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
    })
    broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
    return { kind: 'failed', summary: injection.summary, message: injection.message, outputs: {} }
  }
  const promptTemplate = pickString(aggNode, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(aggNode, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs
  const nodeOverrides = pickOverrides(aggNode)

  // Concurrency: the aggregator is a real opencode subprocess too — count it
  // against the global node + fan-out subprocess caps (and the write slot when
  // it is non-readonly), like the shards above.
  // RFC-098 B1 (audit S-17): write ≺ global ≺ subprocess.
  const releaseWrite = aggAgent.readonly ? null : await state.writeSem.acquire()
  const releaseGlobal = await state.globalSem.acquire()
  const releaseSub = await state.subprocessSem.acquire()
  try {
    const result = await runNode({
      taskId,
      nodeRunId: aggRunId,
      nodeId: aggNode.id,
      agent: aggAgent,
      inputs: aggInputs,
      worktreePath: task.worktreePath,
      // RFC-067: per-task Git identity threaded through fanout aggregator dispatch.
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      templateMeta: {
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        taskId,
        nodeId: aggNode.id,
        iteration,
        // RFC-066: per-repo metadata for prompt placeholders.
        repos: state.repos,
      },
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
      ...(nodeOverrides !== undefined ? { overrides: nodeOverrides } : {}),
      hasClarifyChannel: false, // PR-D2
      skills: injection.resolvedSkills,
      dependents: injection.dependents,
      mcps: injection.mcps,
      plugins: injection.plugins,
      appHome: opts.appHome,
      ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
      db,
      log,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.subagentLiveCapture !== undefined
        ? { subagentLiveCapture: opts.subagentLiveCapture }
        : {}),
    })
    broadcastNodeStatus(taskId, aggRunId, aggNode.id, result.status)
    if (result.status !== 'done') {
      return {
        kind: 'failed',
        summary: `aggregator ${aggNode.id} ${result.status}`,
        message: result.errorMessage ?? `aggregator-${result.status}`,
        outputs: {},
      }
    }
    // Aggregator's outputs are already persisted by runner.ts (nodeRunOutputs
    // upsert at runner.ts §port-persist). The wrapper-row outlet copy is
    // handled by the caller (runFanoutWrapperNode after this returns).
    return { kind: 'ok', summary: '', message: '', outputs: result.outputs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
    return { kind: 'failed', summary: 'aggregator threw', message: msg, outputs: {} }
  } finally {
    releaseSub()
    releaseGlobal()
    releaseWrite?.()
  }
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03) — RFC-040 makes it bubble
// awaiting_* and resumable.
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop). On RFC-040 resume the baseline is read from
// persisted progress — we MUST NOT re-capture HEAD on resume because the
// worktree has already diverged from the original pre-inner state while the
// inner agent was running; the final diff is meant to be against pre-inner,
// not pre-resume.
// -----------------------------------------------------------------------------

async function captureHead(worktreePath: string): Promise<string> {
  try {
    const r = await runGit(worktreePath, ['rev-parse', 'HEAD'])
    if (r.exitCode === 0) return r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }
  return ''
}

async function runGitWrapperNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId } = state
  const { node, iteration, log } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-git ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  const existing = await findResumableWrapperRun(db, taskId, node.id, iteration)
  let wrapperRunId: string
  let baseline: string
  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, (msg) => log.warn(msg))
    wrapperRunId = existing.id
    if (progress?.kind === 'git' && typeof progress.baseline === 'string') {
      baseline = progress.baseline
    } else {
      // Malformed / missing — best-effort re-capture. Worse than persisted
      // baseline but no worse than today's pre-RFC-040 init-only path.
      // RFC-098 B1 (audit S-24): captured under the task write lock so the
      // baseline never samples a sibling writer mid-write.
      baseline = await state.writeSem.run(() => captureHead(task.worktreePath))
    }
    if (existing.status !== 'running') {
      // RFC-053: wrapper enter-running — resumes from awaiting_* / pending.
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
  } else {
    wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    // RFC-098 B1 (audit S-24): baseline under the task write lock.
    baseline = await state.writeSem.run(() => captureHead(task.worktreePath))
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git',
      baseline,
      phase: 'inner-running',
    })
  }

  const subRes = await runScope(state, {
    scopeIds: new Set(inner),
    iteration,
    log: log.child(`git:${node.id}`),
  })
  if (subRes.kind === 'canceled') {
    await markWrapperTerminal(db, wrapperRunId, 'canceled')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
    return { kind: 'canceled', summary: 'inner canceled', message: '' }
  }
  if (subRes.kind === 'failed') {
    await markWrapperTerminal(db, wrapperRunId, 'failed', subRes.detail?.message ?? 'inner failed')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: subRes.detail?.summary ?? `wrapper-git ${node.id} inner failed`,
      message: subRes.detail?.message ?? 'inner failed',
    }
  }
  // RFC-040: bubble awaiting_* up. We do NOT compute the diff yet —
  // doing so against a half-finished worktree was the silent correctness
  // bug RFC-040 is fixing.
  if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git',
      baseline,
      phase: 'awaiting',
    })
    const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
    // RFC-053: wrapper-git bubbles inner awaiting_*; same semantics as
    // wrapper-loop above.
    await transitionNodeRunStatus({
      db,
      nodeRunId: wrapperRunId,
      event: subRes.kind === 'awaiting_human' ? { kind: 'park-human' } : { kind: 'park-review' },
    })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
    return {
      kind: subRes.kind,
      summary: subRes.detail?.summary ?? '',
      message: subRes.detail?.message ?? '',
    }
  }

  // subRes.kind === 'ok' — emit changed-file list against persisted baseline.
  // RFC-060 PR-E: git_diff outlet is now `list<path>` (newline-joined file
  // paths) instead of a full unified diff. Downstream wrapper-fanout can
  // consume it directly as a shardSource. Authors who still want the raw
  // diff can run `git diff` themselves in a downstream agent — or wait for
  // the planned `git_diff_full` companion outlet.
  let paths: string[] = []
  try {
    // RFC-098 B1 (audit S-24): the diff is captured under the task write lock
    // (no sibling writer mid-write can leak half-written files into the
    // changed-file list), and a diff FAILURE now fails the wrapper instead of
    // silently degrading to an empty git_diff — the old empty-catch sent the
    // whole downstream fan-out into the empty-source short-circuit and the
    // task went green with zero audit shards.
    paths = await state.writeSem.run(() => gitChangedFiles(task.worktreePath, baseline || 'HEAD'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markWrapperTerminal(db, wrapperRunId, 'failed', `git-diff-failed:${msg}`)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return { kind: 'failed', summary: `git diff failed: ${msg}`, message: 'git-diff-failed' }
  }
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: wrapperRunId, portName: 'git_diff', content: paths.join('\n') })
  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

// RFC-060 PR-E: runFanOutNode (the M3 agent-multi fan-out implementation)
// was removed. wrapper-fanout (RFC-060) is now the sole fan-out mechanism;
// see runFanoutWrapperNode above for the replacement.

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
    reviewIteration?: number
    shardKey?: string | null
    parentNodeRunId?: string | null
    /** RFC-074 provenance: JSON `{upstreamNodeId: nodeRunId}` this run consumed. */
    consumedUpstreamRunsJson?: string | null
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
    reviewIteration: inherit?.reviewIteration ?? 0,
    shardKey: inherit?.shardKey ?? null,
    parentNodeRunId: inherit?.parentNodeRunId ?? null,
    consumedUpstreamRunsJson: inherit?.consumedUpstreamRunsJson ?? null,
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
  // RFC-097: callers sit either before mark-running (snapshot-invalid /
  // unsupported-kind → from=pending) or inside the running scope. A canceled
  // winner is respected (cancel outranks fail).
  const won = await trySetTaskStatus({
    db,
    taskId,
    to: 'failed',
    allowedFrom: ['pending', 'running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary,
      errorMessage,
      ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    },
    reason: `failTask: ${errorSummary}`,
  })
  if (!won) {
    createLogger('scheduler').warn(
      'failTask write lost to a concurrent transition — respecting winner',
      { taskId, errorSummary },
    )
    return
  }
  await emitStatus(db, taskId)
}

async function cancelTaskRow(db: DbClient, taskId: string, failedNodeId?: string): Promise<void> {
  // RFC-097: idempotent — cancelTask's fallback (or a failTask that raced
  // first) may already have landed a terminal status; respect the winner.
  const won = await trySetTaskStatus({
    db,
    taskId,
    to: 'canceled',
    allowedFrom: ['running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: 'canceled by user',
      errorMessage: 'aborted by signal',
      ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    },
    reason: 'cancelTaskRow',
  })
  if (!won) {
    createLogger('scheduler').warn(
      'cancelTaskRow lost to a concurrent transition — respecting winner',
      { taskId },
    )
    return
  }
  await emitStatus(db, taskId)
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
// RFC-074: exported (was module-private) for the picker baseline test. PR-B
// unified the source-run picker with the freshness picker (done-only,
// highest-iteration-then-isFresherNodeRun) and now returns `consumed`
// provenance alongside the resolved inputs — see body + design §5.1 / D10.
export async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  iteration: number,
  log: Logger,
): Promise<{ inputs: Record<string, string>; consumed: Record<string, string> }> {
  const grouped = new Map<string, string[]>()
  const incoming = edges.filter((e) => e.target.nodeId === nodeId)
  // RFC-074 provenance: which upstream node_run each source edge actually read.
  // Keyed by source nodeId — all edges from the same source resolve to the same
  // picked run, so this stays consistent across multi-port fan-in.
  const consumed: Record<string, string> = {}

  for (const edge of incoming) {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, edge.source.nodeId)))
    // RFC-074 (decision D10 / design §5.1): unify the source-run picker with
    // the freshness picker. Previously this sorted by (iteration desc,
    // retryIndex desc) with NO cci term and NO status filter — so it could read
    // a STALE pre-clarify row (higher retryIndex, lower cci) or even a pending
    // row's empty output while a done row carried the real content (the
    // three-picker drift the RFC indicts; baseline PB1/PB2). Now: among
    // top-level DONE rows within the iteration window, pick the highest
    // iteration (cross-boundary "latest visible", e.g. git-wrapper / loop
    // carry) and, within that iteration, the freshest by isFresherNodeRun.
    const candidates = rows.filter(
      (r) => r.iteration <= iteration && r.parentNodeRunId === null && r.status === 'done',
    )
    let run: (typeof candidates)[number] | undefined
    for (const r of candidates) {
      if (run === undefined) {
        run = r
        continue
      }
      if (r.iteration > run.iteration) {
        run = r
        continue
      }
      if (r.iteration === run.iteration && isFresherNodeRun(r, run)) run = r
    }
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: edge.source.nodeId })
      continue
    }
    consumed[edge.source.nodeId] = run.id
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

  const inputs: Record<string, string> = {}
  for (const [name, values] of grouped) {
    inputs[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return { inputs, consumed }
}

// RFC-060 PR-E: pickLatestSourceRun + sumChildTokens were used only by the
// agent-multi runFanOutNode path (now removed). Deleted alongside the fan-out
// implementation.

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
  // Pick the freshest DONE top-level run (shared picker, pure id order).
  // RFC-096 (audit 附录 C #5): the done-only filter aligns this read with
  // buildFreshestDonePerNode / the RFC-074 freshness口径 — without it, a
  // freshly minted non-done row (e.g. a concurrent designer-rerun pending
  // row) was picked as freshest, had no outputs, and the port read returned
  // '': a loop `port-empty` exit condition false-fired and the wrapper
  // persisted '' outputs. Non-done rows never have outputs (the runner only
  // persists ports on done), so skipping them can only surface the newest
  // REAL content. (The RFC-040 shadowing fix — pure id over retryIndex — is
  // inherited from isFresherNodeRun; the old comment describing the retired
  // (clarifyIteration, retryIndex, id) triple was stale and is gone.)
  const chosen = pickFreshestRun(rows, { topLevelOnly: true, statusIn: ['done'] })
  if (chosen === undefined) return ''
  const out = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, chosen.id), eq(nodeRunOutputs.portName, portName)))
  return out[0]?.content ?? ''
}

/**
 * Detect a cycle in a scope's structural upstream graph (the same `upstreamsOf`
 * the dispatch frontier walks). Returns a node id that lies on a cycle, or null
 * when the scope is acyclic. DFS with white/grey/black coloring; a grey re-visit
 * is a back-edge. `upstreamsOf` values are always in-scope (buildScopeUpstreams
 * drops out-of-scope sources), so the walk stays within the scope.
 */
function findScopeCycle(
  scopeNodes: WorkflowNode[],
  upstreamsOf: Map<string, string[]>,
): string | null {
  const color = new Map<string, 0 | 1 | 2>() // 0=unvisited 1=visiting 2=done
  const visit = (id: string): string | null => {
    color.set(id, 1)
    for (const up of upstreamsOf.get(id) ?? []) {
      const c = color.get(up) ?? 0
      if (c === 1) return up // back-edge → cycle
      if (c === 0) {
        const found = visit(up)
        if (found !== null) return found
      }
    }
    color.set(id, 2)
    return null
  }
  for (const n of scopeNodes) {
    if ((color.get(n.id) ?? 0) === 0) {
      const found = visit(n.id)
      if (found !== null) return found
    }
  }
  return null
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
  // RFC-023 + RFC-056: ignore clarify-channel edges when computing topology.
  // They form explicit cycles (agent → clarify → agent for RFC-023,
  // questioner → cross-clarify → designer / questioner for RFC-056) by design.
  // The cycle is resolved out-of-band via clarify_session /
  // cross_clarify_session prompt injection.
  for (const e of edges) {
    if (!nodeById.has(e.source.nodeId) || !nodeById.has(e.target.nodeId)) continue
    if (isClarifyChannelEdge(e)) continue
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
      if (isClarifyChannelEdge(e)) continue
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

// RFC-092 T2: `readSnapshotForLatestRun` was deleted — the retry rollback now
// uses the in-process `lastFreshSnapshot` (see runOneNode). Its
// `orderBy(desc(retryIndex))` was one of the audit S-13 freshest-row forks
// (retry_index ordering was ruled out in favor of id-order, and a followup
// attempt's snapshot-less row shadowed the real baseline — S-2b).

/**
 * RFC-074 PR-C: derive a node_run's clarify "generation" from id-order instead
 * of the retired `clarifyIteration` counter. The generation is the number of
 * earlier completed generations: top-level (`parentNodeRunId === null`) `done`
 * rows for the same (taskId, nodeId, iteration, shardKey) minted before this
 * run (id < beforeId). 0 = first generation. `done` (not canceled) so
 * review-iterate supersede markers don't inflate it; parent-null so fan-out
 * shard children don't either. Returns the prior rows too — the freshest is the
 * clarify-rerun's working draft (priorDoneDesigner) and the session-resume
 * source.
 */
async function priorDoneGenerationsForRun(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<Array<typeof nodeRuns.$inferSelect>> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
  return rows.filter(
    (r) =>
      (r.shardKey ?? null) === (run.shardKey ?? null) &&
      r.parentNodeRunId === null &&
      r.id < run.id,
  )
}

/**
 * RFC-026: look up the opencode session id captured on the agent's PRIOR
 * clarify round. RFC-074 PR-C: the retired `clarifyIteration` counter is
 * replaced by id-order — the prior generation is simply the freshest top-level
 * `done` row for this node minted BEFORE the current run (id < beforeId),
 * scoped to the same (taskId, nodeId, iteration, shardKey). That row emitted
 * the `<workflow-clarify>` envelope the user just answered. Returns null when
 * nothing matches (will then degrade to isolated via `decideResumeSessionId`).
 */
async function readPriorAgentSessionId(
  db: DbClient,
  args: {
    taskId: string
    agentNodeId: string
    shardKey: string | null
    iteration: number
    beforeId: string
  },
): Promise<string | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        eq(nodeRuns.nodeId, args.agentNodeId),
        eq(nodeRuns.iteration, args.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
    .orderBy(desc(nodeRuns.id))
  // shardKey is filtered in memory because drizzle's IS NULL handling
  // varies; the result set is tiny (one row per prior attempt). Walk newest
  // first (largest id) and return the first prior generation that captured a
  // session id.
  const filtered = rows.filter(
    (r) =>
      (r.shardKey ?? null) === args.shardKey && r.parentNodeRunId === null && r.id < args.beforeId,
  )
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
  // Build a quick node-kind lookup so the channel-edge skip can
  // distinguish RFC-023 clarify targets (skip the edge — clarify nodes
  // are dispatched out-of-band by the runner) from RFC-056 cross-clarify
  // targets (KEEP the edge — the cross-clarify node legitimately
  // depends on the questioner reaching a terminal state).
  const kindById = new Map<string, string>()
  for (const n of scopeNodes) kindById.set(n.id, n.kind)
  for (const e of edges) {
    if (!ids.has(e.target.nodeId)) continue
    if (!ids.has(e.source.nodeId)) continue
    // RFC-023: agent.__clarify__ → clarify.questions is a channel edge
    // (clarify node is dispatched by the runner via createClarifySession,
    // not by the scheduler's dataflow walk); skip to prevent agent→clarify
    // → agent cycles. RFC-056 cross-clarify TARGETS are NOT skipped here:
    // a cross-clarify node legitimately waits for its questioner to
    // complete before runtime activates it (see 2026-05-22 bug: skipping
    // this edge made cross-clarify a no-upstream leaf, dispatcher
    // re-fired it every scheduler tick, accumulating orphan pending rows).
    if (e.source.portName === '__clarify__') {
      const tgtKind = kindById.get(e.target.nodeId)
      if (tgtKind === 'clarify') continue
      // tgtKind === 'clarify-cross-agent' → fall through, KEEP edge as
      // dataflow dep so cross-clarify waits for questioner.
    }
    // Other channel edges (RFC-023 answer / RFC-056 back-channels) stay
    // skipped — they're injected via prompt context, not consumed as
    // dataflow inputs.
    if (
      e.target.portName === '__clarify_response__' ||
      e.target.portName === '__external_feedback__' ||
      e.source.portName === 'to_designer' ||
      e.source.portName === 'to_questioner'
    ) {
      continue
    }
    const list = m.get(e.target.nodeId) ?? []
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
    m.set(e.target.nodeId, list)
  }
  // RFC-060 PR-E: agent-multi removed; its sourcePort dep handling deleted
  // (wrapper-fanout uses boundary edges instead, which are real graph edges).
  for (const n of scopeNodes) {
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
    // Output nodes carry their dependencies in `ports[].bind` (not always as
    // edges; the canvas editor emits both in practice but bindings are the
    // canonical form per workflow.validator.ts §output bindings). Treating
    // them as implicit upstream deps keeps the scheduler from snapshotting
    // empty port content when an output node would otherwise be considered
    // a graph root with no incoming edges.
    if (n.kind === 'output') {
      const bindings = readBindings(n, 'ports')
      const list = m.get(n.id) ?? []
      for (const b of bindings) {
        if (!ids.has(b.bind.nodeId)) continue
        if (!list.includes(b.bind.nodeId)) list.push(b.bind.nodeId)
      }
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
  const wrappers = def.nodes.filter(
    (n) => n.kind === 'wrapper-git' || n.kind === 'wrapper-loop' || n.kind === 'wrapper-fanout',
  )
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
          (nodeById.get(id)!.kind === 'wrapper-git' ||
            nodeById.get(id)!.kind === 'wrapper-loop' ||
            nodeById.get(id)!.kind === 'wrapper-fanout') &&
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
