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
  ClarifyCrossAgentNode,
  ClarifyNode,
  EnvelopeFollowupReason,
  FailureCode,
  Mcp,
  MergeState,
  MergeStateOrNull,
  NodeKind,
  Plugin,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WrapperFanoutPort,
} from '@agent-workflow/shared'
import {
  FANOUT_DONE_PORT_NAME,
  FOLLOWUP_POLICY,
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  agentHasClarifyChannel,
  buildPriorOutputBlock,
  deriveWrapperFanoutOutputs,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  findFanoutAggregator,
  findQuestionerNodeForCrossClarify,
  isClarifyChannelEdge,
  isInlineMarkdownItemKind,
  isMergeStateSettled,
  isWrapperKind,
  resolveClarifySessionMode,
  resolveCrossClarifySessionMode,
  resolveKeyOf,
  splitListItems,
  splitMarkdownDocs,
  stringifyKind,
  tryParseKind,
} from '@agent-workflow/shared'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '@/services/fanout'
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
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
import { createCrossClarifySession, resolveCrossNodeStopped } from '@/services/crossClarify'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/services/clarifyRounds'
import { buildClarifyQueueContext } from '@/services/clarifyQueue'
import { getNodeClarifyDirectiveRow } from '@/services/taskClarifyDirective'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
  type ClarifyInlineFallbackReason,
} from '@/services/clarifyFallback'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import { loadUndispatchedParkTargets } from '@/services/taskQuestions'
import { resolveBorrowForNode } from '@/services/taskQuestionDispatch'
import { autoDispatchDeferredQuestions } from '@/services/clarifyAutoDispatch'
import {
  trySetTaskStatus,
  setNodeRunStatus,
  transitionNodeRunStatus,
  transitionMergeState,
  tryTransitionMergeState,
} from '@/services/lifecycle'
import {
  frozenRuntimeOfSession,
  isClarifyRerunCause,
  mintNodeRun,
  resolveFrozenRuntime,
  schedulerMintCause,
} from '@/services/nodeRunMint'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import { getTaskWriteSem, gcTaskWriteSem } from '@/services/taskWriteLocks'
import { buildReviewPromptContext, dispatchReviewNode } from '@/services/review'
import {
  areTransitiveUpstreamsCompleted,
  buildFreshestDonePerNode,
  consumedMapsEqual,
  isFresherNodeRun,
  isNodeRunFresh,
  parseConsumedJson,
  pickFreshestRun,
  pickReusableShardRun,
  pickUpstreamSourceRun,
} from '@/services/freshness'
import {
  decideScopeOutcome,
  isDispatchable,
  isReviewSupersededRow,
  WRAPPER_KINDS,
  wrapperExternalUpstreamSources,
  wrapperRevivalEvidence,
} from '@/services/dispatchFrontier'
import { runNode, type ResolvedSkill, type RunResult } from '@/services/runner'
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
import { ConflictError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import { gitBlobHashes, gitChangedFiles, runGit } from '@/util/git'
import {
  completeHumanResolvedConflict,
  createNodeIso,
  discardNodeIso,
  type IsoHandle,
  type MergeBackConflict,
  mergeBackNodeIso,
  rebuildIsoHandle,
  resolveConflictWithAgent,
  snapshotNodeIsoFinal,
  undoPriorShardDeltaInIso,
} from '@/services/nodeIsolation'
import { buildMergeAgent, mergeResolveNodeId } from '@/services/mergeAgent'
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
  /**
   * Default per-node timeout in ms (from settings). RFC-115: the per-node
   * `timeoutMs` override is removed — this global value applies to every node.
   */
  defaultPerNodeTimeoutMs?: number
  /**
   * RFC-115: global per-node retry budget (from config.defaultNodeRetries).
   * Replaces the per-node `retries` override; `?? 3` fallback for mock/unwired.
   */
  defaultNodeRetries?: number
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
  /** RFC-117: runtime profile NAME for the built-in commit agent (config.commitPushRuntime); wins over commitPushModel. */
  commitPushRuntime?: string
  /** RFC-130 §6.1: deprecated model fallback for the built-in merge-conflict resolver agent (config.mergeAgentModel). */
  mergeAgentModel?: string
  /** RFC-130 §6.1: runtime profile NAME for the built-in merge agent (config.mergeAgentRuntime); wins over mergeAgentModel. */
  mergeAgentRuntime?: string
  /** RFC-075: repair-retry budget; falls back to DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES. */
  commitPushMaxRepairRetries?: number
  /** RFC-075: diff byte cap for the commit-message prompt; falls back to DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES. */
  commitPushDiffMaxBytes?: number
  /**
   * RFC-111 D1/D15 + RFC-112: global default runtime NAME (from
   * config.defaultRuntime). At the agent-dispatch site each node's runtime is
   * resolved once from `agent.runtime ?? defaultRuntime` (name → protocol+binary
   * via the registry) and frozen onto node_runs. resume reads the frozen value.
   * Omitted → 'opencode'. Internal agents (commit&push) stay on opencode (D14).
   */
  defaultRuntime?: string
  // RFC-113 §5: the RFC-112 P2 `claudeCodePath` thread is GONE — the built-in
  // claude binary now lives on the claude runtime row's binary_path (config
  // migrated into it) and flows through the normal runtimeBinary freeze.
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

  // 4. Validate node kinds. RFC-146: positive membership in the behavior
  // table — a kind the scheduler knows is exactly a kind with a behavior row.
  // (The historical negative enum listed 6 `!==` clauses and silently
  // admitted nothing new; now adding a NodeKind admits it here by
  // construction, and runOneNode's fall-through guard catches kinds the
  // dispatch switch doesn't actually handle yet.)
  for (const node of definition.nodes) {
    if (!(node.kind in NODE_KIND_BEHAVIORS)) {
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
    // RFC-130 T3c2: recover any 'pending-merge' rows from a crash between
    // agent-success and merge-back BEFORE the scope runs (so the frontier only
    // sees merged rows). A no-op on a fresh run / non-isolated task.
    await replayPendingMerges(state, log)
    // RFC-130 §6.3 resume: complete any conflict-human node whose human resolved
    // its conflict in the preserved resolve-iso (flips 'merged' + releases
    // downstream; still-unresolved stays parked). No-op on a fresh run.
    await replayConflictHumanResolutions(state, log)
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
  /**
   * RFC-145: the machine-readable failure taxonomy the runner declared at its
   * stamp point (persisted on `node_runs.failure_code`). Replaces the old
   * errorMessage-prefix parsing — errorMessage is human breadcrumbs only and
   * is deliberately NOT part of this shape anymore. NULL = no follow-up-able
   * failure (legacy rows were backfilled by migration 0077).
   */
  failureCode: FailureCode | null
  sessionId: string | null
  /** Count of `kind='text'` rows the runner persisted for the previous run. */
  agentTextCount: number
  /**
   * RFC-049: structured port-validation failures the previous attempt's
   * runner persisted to `node_runs.port_validation_failures_json`. Defaults
   * to undefined; callers that have the JSON-parsed array can thread it
   * through here so the scheduler can route per-kind repair text via
   * `composePerKindRepairBlocks`. When failureCode is 'port-validation-failed'
   * but this field is missing (e.g. legacy rows pre-RFC-049 / malformed JSON
   * degraded by parsePortValidationFailuresJson), the followup still fires but
   * `failures` in the decision is an empty array — degraded mode: prompt still
   * nudges the agent, just without per-port specifics.
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
      /** RFC-145: 6-value render domain, single-sourced in shared/prompt.ts. */
      reason: EnvelopeFollowupReason
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

/**
 * RFC-145: table lookup replaces the old 7-branch order-sensitive
 * errorMessage-startsWith chain. The runner declares `failureCode` at the
 * same stamp that writes errorMessage; FOLLOWUP_POLICY (shared/prompt.ts)
 * projects the 7-value producer domain onto the 6-value render reason —
 * including the previously implicit clarify-forbidden → envelope-missing
 * downgrade, now an explicit table row. Order sensitivity is gone: the
 * runner distinguishes malformed-port vs port-validation at the source
 * (parse layer vs validation layer — mutually exclusive by construction).
 */
export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount <= 0) return { followup: false }
  if (prev.failureCode === null) return { followup: false }
  const policy = FOLLOWUP_POLICY[prev.failureCode]
  return {
    followup: true,
    reason: policy.reason,
    failures:
      prev.failureCode === 'port-validation-failed' ? (prev.portValidationFailures ?? []) : [],
  }
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
  // batch. RFC-130: every node runs in its OWN isolated worktree, so ALL nodes
  // run truly in parallel under `globalSem` (the `readonly` flag was removed —
  // there is no read/write distinction); `writeSem` only serializes the brief
  // per-node snapshot-at-dispatch (§段①) + merge-back (§段③), not the agent run.
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

    // RFC-140 W2 — auto-redispatch the auto-split-DEFERRED task questions (marker set at batch
    // dispatch + still undispatched + still staged) BEFORE deriving the frontier. The tick re-
    // enters after EVERY node-run completion, so the home whose in-flight rerun just finished
    // redispatches its deferred cause batch on this very tick (the in-flight gate inside
    // dispatchTaskQuestions releases on done, incl. done-no-output — RFC-133/139). Retryable
    // conflicts keep the marker for the next tick; non-recoverable ones clear it (WARN, back to
    // the manual board). Runs OUTSIDE lock B (dispatch acquires it internally). A successful
    // redispatch mints pending rows that the deriveFrontier below picks up in the same tick.
    await autoDispatchDeferredQuestions(db, taskId)
    const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const openClarify = await loadOpenClarify(db, taskId)
    // RFC-132 PR-B (universal deferred model): the park gate applies to ALL tasks now — a
    // sealed-undispatched entry (a designer waiting for its siblings — "park 等齐" — or a
    // self/questioner entry whose auto-dispatch was deferred by a recoverable conflict) parks its
    // home so the frontier never falsely completes the asking node on a clarify-only output
    // (RFC-076 T0). loadUndispatchedParkTargets returns EMPTY for a task with no sealed-undispatched
    // entries (every steady-state task the instant its answers dispatch), so this stays byte-for-byte
    // the old frontier for that case; the `deferredQuestionDispatch` flag is no longer read.
    // RFC-128 P5-BC (clean-path ③) + P5-D (Codex round-3 fix): the park set classifies designer +
    // self/questioner entries TOGETHER (loadUndispatchedParkTargets), NOT as the per-role UNION. The
    // union deadlocks a SAME-HOME node that holds an undispatched entry of one role AND an in-flight
    // rerun of another (the per-role designer source is blind to an in-flight questioner → parks the
    // node → stalls its pending rerun forever). The all-role partition is in-flight-aware across every
    // role, so such a node RUNS its in-flight rerun + re-parks next tick.
    const deferredHandlerNodeIds = await loadUndispatchedParkTargets(db, taskId)
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
      deferredHandlerNodeIds,
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
  // RFC-117: resolve the commit agent's runtime once for this task (profile name →
  // defaultRuntime → deprecated commitPushModel fallback); frozen per session below.
  const rt = await resolveInternalAgentRuntime(db, {
    runtimeName: state.opts.commitPushRuntime,
    deprecatedModel: state.opts.commitPushModel,
    defaultRuntime: state.opts.defaultRuntime,
  })

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
      try {
        const sessionRunId = await mintNodeRun(db, {
          taskId: task.id,
          nodeId,
          status: 'pending',
          cause: 'commit-push-session',
          iteration,
          overrides: { parentNodeRunId: ctx.nodeRunId },
        })
        // RFC-117: freeze the resolved commit runtime onto the session row via
        // inheritFrom — its source is config.commitPushRuntime / deprecated model
        // (not an agent.runtime row), so we pre-resolved `rt` above and freeze it
        // here, getting the same node_runs snapshot the other 3 dispatch points do.
        const frozen = await resolveFrozenRuntime(db, sessionRunId, null, null, {
          protocol: rt.protocol,
          binary: rt.binaryPath,
          params: {
            model: rt.model,
            variant: rt.variant,
            temperature: rt.temperature,
            steps: rt.steps,
            maxSteps: rt.maxSteps,
          },
        })
        const result = await runNode({
          taskId: task.id,
          nodeRunId: sessionRunId,
          nodeId,
          agent: buildCommitAgent(),
          runtime: frozen.protocol,
          runtimeBinary: frozen.binary,
          runtimeParams: frozen.params,
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
   *
   * RFC-098 B3 (audit S-3): a ready WRAPPER whose latest row is awaiting_*
   * contributes its inner revival-EVIDENCE row id here instead (the inner
   * pending rerun / approved review row, wrapperRevivalEvidence) — same
   * one-shot release contract, keyed on the evidence rather than the wrapper
   * row itself.
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

// Graph-visit no-op kinds write NO node_run row (C1); they settle without one
// once upstreams are done and no session is open (N6). RFC-146: derived from
// the behavior table (today: clarify / clarify-cross-agent) instead of a
// hand-maintained literal twin.
const SETTLES_WITHOUT_ROW_KINDS = new Set<NodeKind>(
  NODE_KIND.filter((k) => NODE_KIND_BEHAVIORS[k].settlesWithoutRow),
)

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
  // RFC-120 T9 (model A): effective handler nodes (override ?? designer) of a
  // deferred-dispatch task's undispatched designer task_questions. Each is kept
  // OUT of `completed` (its done draft is NOT a completion — downstream blocks)
  // and parked awaiting_human until batch-dispatch mints its rerun. Empty for
  // every non-deferred task → byte-for-byte today's frontier (golden-lock).
  deferredHandlerNodeIds: ReadonlySet<string> = new Set(),
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
    // RFC-120 T9: a deferred designer handler's done draft is NOT a completion —
    // exclude it from `completed` so its downstream stays blocked until dispatch.
    if (deferredHandlerNodeIds.has(nodeId)) continue
    // RFC-130 D15: an ISOLATED done run counts as complete ONLY once its delta has
    // been merged back into the canonical worktree (merge_state='merged'). A row
    // still in 'pending-merge' / 'conflict-*' / 'isolating' / 'merge-failed' has a
    // 'done' status (the runner set it) but its output never reached canonical —
    // gating downstream on merge_state closes the crash window (runner-done →
    // daemon crash → merge-back never ran). Legacy / passthrough rows leave
    // merge_state NULL and pass this gate byte-for-byte (golden-lock).
    if (
      r.status === 'done' &&
      isNodeRunFresh(r, freshestDone) &&
      // RFC-144: the settled set {NULL, merged} now derives from the shared
      // transition table (SETTLED_MERGE_STATES) — in-flight iso states
      // ('isolating' / 'pending-merge' / 'conflict-human' / 'merge-failed' /
      // 'abandoned') are gated out; null/'merged' pass (legacy golden-lock).
      isMergeStateSettled(r.mergeState)
    ) {
      completed.add(nodeId)
    }
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
    // RFC-120 T9 (model A): a deferred designer handler parks awaiting_human until
    // batch-dispatch mints its rerun (mirrors the askingRunIds park below). Its
    // done draft is not (re-)dispatchable here — dispatchTaskQuestions stamps
    // trigger_run_id + mints the pending rerun, which the next tick picks up once
    // this node leaves the deferred set.
    if (deferredHandlerNodeIds.has(n.id)) {
      awaitingHuman.push(n.id)
      continue
    }
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
    // RFC-098 B3 (audit S-3 + the RFC-092 documented limitation): a parked
    // WRAPPER row (awaiting_*) gets the same one-shot in-invocation release,
    // keyed on its inner REVIVAL EVIDENCE row (the pending rerun a mid-run
    // clarify answer minted, or the done∧fresh review row an approve flipped
    // — wrapperRevivalEvidence, dispatchFrontier.ts). Without this, a wrapper
    // already in `dispatchedThisInvocation` could never pick up the human
    // action and the task fell back to awaiting_* needing a manual resume.
    //
    // No-busy-loop argument (five layers, mirrors RFC-092 §1.3):
    //   ① the evidence ROW id is recorded into dispatchedPendingRowIds on
    //      dispatch (pendingAnchors below) — the same evidence releases the
    //      wrapper at most once per invocation;
    //   ② a dispatched wrapper enters `inFlight` — no re-dispatch same tick;
    //   ③ the wrapper resume immediately flips its row running — `latest`
    //      leaves awaiting_*, this predicate stops matching while it runs;
    //   ④ the inner runScope consumes a pending evidence row via its
    //      pendingExisting reuse (row flips running → terminal) — the
    //      evidence disappears; NEW evidence can only be minted by a new
    //      human action (fresh ULID re-arms exactly one more release);
    //   ④' while the evidence node's clarify session is still OPEN (answers
    //      mid-write), openAskingNodeIds blocks the release — the next tick
    //      after the session flips answered releases it;
    //   ⑤ pathological leak (inner exits without consuming the pending row —
    //      the known RFC-092 shape): the anchor is already recorded, so no
    //      further release — degrades to the bounded park/stalled semantics.
    const wrapperEvidence =
      latest !== undefined &&
      (latest.status === 'awaiting_human' || latest.status === 'awaiting_review') &&
      WRAPPER_KINDS.has(n.kind)
        ? wrapperRevivalEvidence(latest, rows, definition)
        : null
    const wrapperAnchorReleasable =
      wrapperEvidence !== null &&
      !dispatchedPendingRowIds.has(wrapperEvidence.rowId) &&
      !openAskingNodeIds.has(wrapperEvidence.nodeId)
    const dispatchable =
      areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed) &&
      !inFlight.has(n.id) &&
      (pendingAnchorReleasable || wrapperAnchorReleasable || !dispatchedThisInvocation.has(n.id)) &&
      isDispatchable(latest, n.kind, freshestDone, rows, definition)
    if (dispatchable) {
      ready.push(n.id)
      if (latest !== undefined && latest.status === 'pending') {
        pendingAnchors.set(n.id, latest.id)
      } else if (wrapperEvidence !== null) {
        // Record the wrapper's evidence row EVERY time it goes ready (also on
        // the plain !dispatchedThisInvocation release) so layer ① holds: a
        // re-park at the same window with the same done-review evidence stays
        // parked instead of hot-looping.
        pendingAnchors.set(n.id, wrapperEvidence.rowId)
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
          case 'done': {
            // RFC-130 §6.3 / RFC-144: exhaustive over MergeStateOrNull — a done row
            // parked at 'conflict-human' bubbles awaiting_human (decideScopeOutcome);
            // 'merge-failed' is a hard merge failure → the scope fails; 'abandoned'
            // (superseded generation, RFC-144) joins the stale-done dedup bucket like
            // every other stale row; a NEW merge state added to the union without a
            // bucket here is a compile error.
            const ms = (latest?.mergeState ?? null) as MergeStateOrNull
            switch (ms) {
              case 'conflict-human':
                awaitingHuman.push(n.id)
                break
              case 'merge-failed':
                failed.push(n.id)
                break
              case null:
              case 'isolating':
              case 'pending-merge':
              case 'merged':
              case 'abandoned':
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
                break
              default: {
                const _exhaustive: never = ms
                void _exhaustive
                // Runtime-unknown legacy value — same dedup bucket as before.
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
              }
            }
            break
          }
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

/**
 * RFC-130: persist the iso base columns after createNodeIso (single vs multi-repo,
 * design.md §3.2). merge_state='isolating' marks the row as an isolated run whose
 * agent has not yet finished — deriveFrontier treats it as not-yet-complete.
 * RFC-144: the write goes through the merge_state CAS (NULL → isolating); the
 * iso base columns ride along atomically as transition extras.
 */
async function persistIsoBase(
  db: DbClient,
  nodeRunId: string,
  repoCount: number,
  handle: IsoHandle,
): Promise<void> {
  if (handle.passthrough) return // in-place run — leave iso columns NULL (golden-lock)
  if (repoCount === 1) {
    await transitionMergeState({
      db,
      nodeRunId,
      event: { kind: 'begin-isolation' },
      extra: {
        isoWorktreePath: handle.containerPath,
        isoBaseSnapshot: handle.repos[0]?.baseSnapshot ?? null,
        isoBaseSnapshotReposJson: null,
      },
    })
    return
  }
  const map: Record<string, string> = {}
  for (const r of handle.repos) map[r.worktreeDirName] = r.baseSnapshot
  await transitionMergeState({
    db,
    nodeRunId,
    event: { kind: 'begin-isolation' },
    extra: {
      isoWorktreePath: handle.containerPath,
      isoBaseSnapshot: null,
      isoBaseSnapshotReposJson: JSON.stringify(map),
    },
  })
}

/** RFC-130: persist the iso node_tree columns + merge_state on agent success (D15).
 *  RFC-144: isolating → pending-merge via the merge_state CAS; the former
 *  `mergeState: string` parameter was a dead knob (all 4 callers passed the
 *  literal 'pending-merge') — the event now fixes the target. */
async function persistIsoNodeTree(
  db: DbClient,
  nodeRunId: string,
  repoCount: number,
  nodeTrees: Record<string, string>,
): Promise<void> {
  await transitionMergeState({
    db,
    nodeRunId,
    event: { kind: 'mark-pending-merge' },
    extra:
      repoCount === 1
        ? { isoNodeTree: nodeTrees[''] ?? null, isoNodeTreeReposJson: null }
        : { isoNodeTree: null, isoNodeTreeReposJson: JSON.stringify(nodeTrees) },
  })
}

function parseIsoJsonMap(s: string | null): Record<string, string> {
  if (s === null || s === '') return {}
  try {
    const o = JSON.parse(s) as unknown
    return o !== null && typeof o === 'object' ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * RFC-130 D15/T3c2: on resume, replay merge-back for any 'pending-merge' row. A
 * daemon crash between agent-success (runner wrote status='done') and merge-back
 * leaves a done row whose delta never reached the canonical worktree — deriveFrontier
 * gates it out of `completed` (D15), so without replay the scope would stall.
 *
 * Replays from the PINNED node_tree (iso_node_tree column), so the iso worktree may
 * be gone and the agent is NEVER re-run. Runs BEFORE the scope so the frontier only
 * ever sees merged/failed rows. A conflict or missing node_tree throws → the caller
 * fails the task loudly (PR-B upgrades the conflict path to the merge agent).
 */
async function replayPendingMerges(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'pending-merge' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    if (Object.keys(nodeTrees).length === 0) {
      throw new Error(`pending-merge replay: node_tree missing for run ${r.id}`)
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      nodeRunId: r.id,
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
    })
    const merge = await state.writeSem.run(async () => {
      const mergeRes = await mergeBackNodeIso(handle, nodeTrees, log)
      if (mergeRes.clean) return { kind: 'merged' as const }
      // RFC-130 §6.2 — a crash-recovered pending-merge that now conflicts (canonical
      // advanced while the daemon was down) goes through the SAME merge agent as a
      // live dispatch; unresolved → conflict-human (resume replay #2 completes the
      // human fix). Resolve within the writeSem hold so canon stays stable.
      const res = await resolveMergeConflicts(state, {
        conflicts: mergeRes.conflicts,
        containerPath: handle.containerPath,
        conflictNodeRunId: r.id,
        nodeId: r.nodeId,
        iteration: r.iteration,
      })
      return res.allResolved
        ? { kind: 'merged' as const }
        : { kind: 'conflict-human' as const, detail: res.detail }
    })
    if (merge.kind === 'merged') {
      await transitionMergeState({
        db,
        nodeRunId: r.id,
        event: { kind: 'mark-merged', via: 'replay' },
      })
      log.info('pending-merge replay merged', { nodeRunId: r.id })
    } else {
      await transitionMergeState({
        db,
        nodeRunId: r.id,
        event: { kind: 'park-conflict-human', via: 'replay' },
      })
      log.warn('pending-merge replay conflict → conflict-human (merge agent could not resolve)', {
        nodeRunId: r.id,
        detail: merge.detail,
      })
    }
  }
}

/**
 * RFC-130 §6.3 resume — on task resume, complete any conflict-human node whose
 * human has resolved its conflict in the preserved resolve-iso worktree(s). A repo
 * that now merges cleanly → materialized + the row flips to 'merged' (the frontier
 * releases its downstream); a repo still unresolved keeps the row at
 * 'conflict-human' → the frontier re-parks the task at awaiting_human. Runs at the
 * resume entry (before the scope loop), right after replayPendingMerges.
 */
async function replayConflictHumanResolutions(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'conflict-human' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      nodeRunId: r.id,
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
    })
    const outcome = await state.writeSem.run(() =>
      completeHumanResolvedConflict(handle, nodeTrees, log),
    )
    if (outcome.allResolved) {
      await transitionMergeState({
        db,
        nodeRunId: r.id,
        event: { kind: 'complete-human-resolution' },
      })
      log.info('conflict-human resume: human resolution merged back', { nodeRunId: r.id })
    } else {
      log.info('conflict-human resume: still unresolved — staying parked', {
        nodeRunId: r.id,
        repos: outcome.unresolvedRepos,
      })
    }
  }
}

/**
 * RFC-130 §6.2 — attempt to auto-resolve merge-back conflict(s) with the built-in
 * merge agent. For each conflicted repo, spins a resolve-iso from the conflicted
 * merged tree and dispatches the merge agent there (as a child node_run under the
 * conflicting run, `cause='merge-resolve'`). The dispatch is a DIRECT `runNode`
 * call — it deliberately does NOT acquire `globalSem`, because the caller holds
 * `writeSem` across §6.2 and a globalSem wait here would close the writeSem↔globalSem
 * cycle (§7 deadlock analysis). Framework self-checks the resolution (D6); on
 * success the resolution is materialized into the canonical worktree and the
 * resolve-iso discarded, on failure the resolve-iso is preserved for awaiting_human.
 *
 * Runtime: `resolveInternalAgentRuntime(mergeAgentRuntime → mergeAgentModel →
 * defaultRuntime)`. Threading `mergeAgentRuntime`/`mergeAgentModel` from config →
 * RunTaskOptions is a follow-up (mirrors commit&push Settings wiring); until then
 * the merge agent runs on the task's `defaultRuntime`.
 */
async function resolveMergeConflicts(
  state: SchedulerState,
  opts: {
    conflicts: MergeBackConflict[]
    containerPath: string
    conflictNodeRunId: string
    nodeId: string
    iteration: number
  },
): Promise<{ allResolved: boolean; detail: string }> {
  const { db, task, log } = state
  const rt = await resolveInternalAgentRuntime(db, {
    runtimeName: state.opts.mergeAgentRuntime,
    deprecatedModel: state.opts.mergeAgentModel,
    defaultRuntime: state.opts.defaultRuntime,
  })
  const mergeNodeId = mergeResolveNodeId(opts.nodeId, opts.iteration)
  const runAgent = async (prompt: string, cwd: string): Promise<void> => {
    const sessionRunId = await mintNodeRun(db, {
      taskId: task.id,
      nodeId: mergeNodeId,
      status: 'pending',
      cause: 'merge-resolve',
      iteration: opts.iteration,
      overrides: { parentNodeRunId: opts.conflictNodeRunId },
    })
    const frozen = await resolveFrozenRuntime(db, sessionRunId, null, null, {
      protocol: rt.protocol,
      binary: rt.binaryPath,
      params: {
        model: rt.model,
        variant: rt.variant,
        temperature: rt.temperature,
        steps: rt.steps,
        maxSteps: rt.maxSteps,
      },
    })
    // DIRECT runNode — bypasses globalSem on purpose (§7 deadlock avoidance).
    await runNode({
      taskId: task.id,
      nodeRunId: sessionRunId,
      nodeId: mergeNodeId,
      agent: buildMergeAgent(),
      runtime: frozen.protocol,
      runtimeBinary: frozen.binary,
      runtimeParams: frozen.params,
      inputs: {},
      worktreePath: cwd,
      promptTemplate: prompt,
      templateMeta: {
        repoPath: cwd,
        baseBranch: task.baseBranch,
        taskId: task.id,
        nodeId: mergeNodeId,
        iteration: opts.iteration,
        repos: state.repos,
      },
      skills: [],
      dependents: [],
      mcps: [],
      plugins: [],
      appHome: state.opts.appHome,
      db,
      log: log.child('merge'),
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      ...(state.opts.opencodeCmd ? { opencodeCmd: state.opts.opencodeCmd } : {}),
      ...(state.opts.signal ? { signal: state.opts.signal } : {}),
    })
  }
  let allResolved = true
  const parts: string[] = []
  for (const conflict of opts.conflicts) {
    const outcome = await resolveConflictWithAgent(conflict, {
      containerPath: opts.containerPath,
      runAgent,
      log,
    })
    if (!outcome.resolved) {
      allResolved = false
      parts.push(
        `${conflict.worktreeDirName || '(repo)'}: ${outcome.unresolved.map((e) => e.path).join(', ')}`,
      )
    }
  }
  return { allResolved, detail: parts.join('; ') }
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
    const nrId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'done',
      cause: 'io-virtual',
      iteration,
    })
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
      const failId = await mintNodeRun(db, {
        taskId,
        nodeId: node.id,
        status: 'pending',
        cause: 'cross-clarify-guard',
        iteration,
      })
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
    // Persistent-stop check: if the questioner node's node-level clarify directive is
    // 'stop', mint a done row immediately so the workflow advances past this point
    // without parking awaiting_human.
    // RFC-132 T7: the questioner node's directive (task_node_clarify_directives) is the
    // single source of truth (answer-stop + canvas toggle both write it; node
    // last-write-wins subsumes the RFC-123 recency gate). The questioner is guaranteed
    // to exist here (the missing-questioner guard above already failed the node), so the
    // fallback is defensive only.
    const reenableQuestionerNodeId = findQuestionerNodeForCrossClarify(definition, node.id)
    const stopped = reenableQuestionerNodeId
      ? await resolveCrossNodeStopped(db, taskId, reenableQuestionerNodeId)
      : false
    if (stopped) {
      const stopRunId = await mintNodeRun(db, {
        taskId,
        nodeId: node.id,
        status: 'pending',
        cause: 'cross-clarify-guard',
        iteration,
      })
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
    const nrId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'done',
      cause: 'io-virtual',
      iteration,
    })
    // RFC-004: an input node's single output port is named after its inputKey,
    // so edges authored on the canvas (whose source.portName defaults to the
    // visible handle label = inputKey) actually resolve. Previously hardcoded
    // to 'out', which mismatched every workflow created through the editor.
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: inputKey, content: value })
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  // RFC-146: exhaustiveness guard. Every kind above returned inside its own
  // branch; only agent-single may fall through into the agent dispatch path
  // below. A NodeKind admitted by the behavior table but not yet given a
  // runOneNode branch fails loud here instead of being silently driven as an
  // agent. (Dispatch stays an if-chain by design — the handlers close over
  // SchedulerState; see RFC-146 design D2.)
  if (node.kind !== 'agent-single') {
    return {
      kind: 'failed',
      summary: `runOneNode has no dispatch branch for node kind ${node.kind}`,
      message: 'unhandled-node-kind',
    }
  }

  const agentName = pickString(node, 'agentName')
  if (agentName === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing agentName`,
      message: 'invalid agent node',
    }
  }
  const nodeAgent = await getAgent(db, agentName)
  if (nodeAgent === null) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }
  // RFC-132 ③ (借壳收官): the borrow ledgers are move-semantics (RFC-131 T4) and the immediate
  // ledger is deleted, so resolveBorrowForNode never returns an agent anymore — its remaining
  // job is the multi-ledger duplicate-execution REJECT (designer + dispatched self/q both open
  // on this home). Keep the call for that reject; the node always runs its OWN agent.
  // ConflictError surfaces as a node-level failure (don't reject the scope tick — runTask would
  // fail the WHOLE task).
  try {
    await resolveBorrowForNode(db, taskId, node.id, iteration, definition)
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: 'failed', summary: err.message, message: err.code }
    }
    throw err
  }
  const agent = nodeAgent

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
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs
  // RFC-042: retries default to 3 so recoverable failure modes (in particular
  // the model forgetting to emit a `<workflow-output>` / `<workflow-clarify>`
  // envelope after a long tool-using session) get a chance to recover via
  // same-session follow-up before the task is failed. RFC-115: the per-node
  // `retries` override is removed — the budget is the global
  // config.defaultNodeRetries (`?? 3` only for mock/unwired callers).
  const maxRetries = opts.defaultNodeRetries ?? 3

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
  // RFC-132 (PR-C): the designer's External Feedback is no longer a separate context — its questions
  // ride the unified flat clarify queue (buildClarifyQueueContext), which selects by effective target
  // regardless of the `__external_feedback__` topology, so the scheduler needs no external-feedback
  // topology gate here anymore.

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
    // RFC-098 WP-10: the cause splits on what the freshest existing top-level
    // row is — undefined→'initial', done/awaiting_*→'stale-redispatch',
    // failed/interrupted/canceled/exhausted→'revival' (对抗检视修订 #11,
    // pinned by rfc098-rerun-cause-gates.test.ts).
    nodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: schedulerMintCause(latestExisting),
      retryIndex,
      iteration,
      overrides: {
        reviewIteration: inheritedReviewIteration,
        shardKey: inheritedShardKey,
        parentNodeRunId: inheritedParentNodeRunId,
        consumedUpstreamRunsJson: consumedUpstreamJson,
        // RFC-132 ③: the borrow ledger is gone — a retry/revival row never carries an
        // agent override anymore (the column stays as historical audit on old rows).
        agentOverrideName: null,
      },
    })
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  // Lock order: writeSem ≺ globalSem ≺ subprocessSem (no cycles — RFC-098 survey
  // §wp5-4). RFC-130 §7 SUPERSEDED the RFC-098 B1 "writer acquires writeSem before
  // its global slot" model (which existed to stop queued writers starving readers):
  // there is no whole-run write lock now — each node runs in its OWN isolated
  // worktree, so writeSem is held only for the brief snapshot-at-dispatch (§段①) +
  // merge-back (§段③), never across the multi-minute agent run. globalSem is the
  // real DAG-parallelism cap now (writeSem + globalSem are never held together —
  // §7.2 deadlock analysis; the merge agent bypasses globalSem to avoid a cycle).
  const releaseGlobal = await globalSem.acquire()
  // §段①: snapshot canonical worktree(s) + branch an isolated worktree under a
  // brief writeSem window. On failure release the slot and fail the node (the
  // canonical worktree is never touched, so nothing to roll back).
  // The iso path + refs are keyed by the ORIGINAL nodeRunId (`isoKeyRunId`) — it
  // stays stable across the internal retry loop (which mints fresh node_run rows),
  // so a same-session follow-up keeps the exact same iso worktree (D17).
  const isoKeyRunId = nodeRunId
  let isoHandle: IsoHandle
  try {
    isoHandle = await writeSem.run(() =>
      createNodeIso({
        appHome: opts.appHome,
        taskId,
        nodeRunId: isoKeyRunId,
        canonRepos: state.repos,
        log,
      }),
    )
  } catch (err) {
    releaseGlobal()
    log.warn('iso worktree setup failed', {
      nodeId: node.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      kind: 'failed',
      summary: 'isolated worktree setup failed',
      message: 'iso-setup-failed',
    }
  }
  await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
  // RFC-130: keep the iso worktree past the finally when the node parks (clarify
  // awaiting_human / merge conflict) so resume (D19) + the merge agent (PR-B) can
  // reuse its exact state. Discarded on any terminal exit.
  let keepIso = false

  let lastResult: RunResult | null = null
  let lastError: string | null = null
  // RFC-122 (same-session follow-up fix): the PRIOR attempt's
  // effectiveHasClarifyChannel. A same-session envelope follow-up re-anchors the
  // agent on "the format previously specified in this session"; that is only
  // valid when this attempt runs in the SAME mode (clarify vs output) as the
  // prior one. A per-attempt STOP-toggle flip can switch the mode mid-loop (e.g.
  // attempt 0 clarify-only → attempt 1 output), and the prior session never
  // emitted the now-needed protocol. When the mode flips we bypass the follow-up
  // and rebuild the FULL renderUserPrompt instead. Seeded false (attempt 0 never
  // follows up). Within a retry loop only nodeStopOverride varies per attempt, so
  // a flip ⟺ a toggle change ⇒ golden-lock: no toggle ⇒ never flips.
  let priorAttemptClarifyActive = false

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
          failureCode: lastResult.failureCode ?? null,
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
          // RFC-130: fresh-session retry — discard the failed iso and re-branch
          // from the CURRENT canonical state. No rollback of canonical: the iso
          // model never wrote it, so it stays clean (I-5). Same-session follow-up
          // does NOT enter this block — it keeps the same iso worktree (D17).
          await discardNodeIso(isoHandle, log)
          try {
            isoHandle = await writeSem.run(() =>
              createNodeIso({
                appHome: opts.appHome,
                taskId,
                nodeRunId: isoKeyRunId,
                canonRepos: state.repos,
                log,
              }),
            )
          } catch (err) {
            log.warn('retry iso recreate failed', {
              nodeId: node.id,
              error: err instanceof Error ? err.message : String(err),
            })
            lastError = 'iso-recreate-failed'
            lastResult = {
              status: 'failed',
              exitCode: null,
              outputs: {},
              tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
              prompt: '',
              errorMessage: 'iso-recreate-failed',
            }
            break
          }
        }
        // RFC-074 PR-C: a process-retry within the same clarify round surfaces
        // the answered Q&A via id-order generation derivation + the RFC-070
        // consumed-by stamps, not a carried clarifyIteration. shardKey /
        // parentNodeRunId still belong to this run-of-the-node and persist.
        nodeRunId = await mintNodeRun(db, {
          taskId,
          nodeId: node.id,
          status: 'pending',
          cause: 'process-retry',
          retryIndex: attempt,
          iteration,
          overrides: {
            reviewIteration: inheritedReviewIteration,
            shardKey: inheritedShardKey,
            parentNodeRunId: inheritedParentNodeRunId,
            consumedUpstreamRunsJson: consumedUpstreamJson,
          },
        })
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
        // RFC-130: carry the iso columns onto the freshly-minted retry row so a
        // crash mid-retry can still find the iso worktree (the physical iso is
        // keyed by isoKeyRunId and shared across the invocation's attempts).
        await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)

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

      // RFC-130: the RFC-092/098 pre-snapshot (git stash create → pre_snapshot
      // columns) is GONE — the iso model never writes the canonical worktree, so
      // there is nothing to roll back. Retry re-branches a fresh iso from the
      // current canonical state (see the fresh-session block above). The
      // pre_snapshot columns + rollbackNodeRunWorktrees stay in the schema as
      // defense-in-depth (design.md D10) but are no longer written here.

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
        // agent (if any). `inline` only takes effect when the current run IS
        // a clarify-driven rerun.
        // RFC-098 WP-10 (audit S-25): "is a clarify-driven rerun" is read off
        // the row itself now — the mint factory records WHY every row exists
        // (node_runs.rerun_cause, migration 0044) and gate-2 switches on it
        // instead of the old `clarifyGeneration > 0 && retryIndex === 0`
        // proxy:
        //   - 'clarify-answer' / 'cross-clarify-questioner-rerun' → TRUE
        //     (the same logical round continues after a human answered);
        //   - 'process-retry' → FALSE (design.md §7 forbids inline resume on
        //     technical retries — deterministic retry behavior);
        //   - fresh scheduler mints ('initial' / 'stale-redispatch' /
        //     'revival') → FALSE (no prior session of the same round);
        //   - NULL (pre-0044 row dispatched across a daemon upgrade) → FALSE
        //     (documented boundary degradation — see isClarifyRerunCause).
        // The (consumerKind × cause) truth table is pinned by
        // rfc098-rerun-cause-gates.test.ts.
        const clarifyNodeForGate = hasClarifyChannel
          ? findClarifyNodeForAgent(definition, node.id)
          : undefined
        const clarifyNodeObjForGate = clarifyNodeForGate
          ? (findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
          : undefined
        // RFC-056 A16: a cross-clarify questioner rerun honors the cross-clarify
        // node's `sessionModeForQuestioner`. The self-clarify findClarifyNode
        // lookup above returns undefined for the cross node (it is not a
        // `clarify` kind), so without this the questioner would silently stay
        // isolated even when the user picked inline in the editor. Resolve the
        // cross node via the SAME helper `clarifyMode` itself uses
        // (findCrossClarifyNodeForQuestioner) rather than reusing
        // clarifyNodeForGate: a questioner can wire BOTH a self-clarify and a
        // cross-clarify `__clarify__` edge, and findClarifyNodeForAgent returns
        // whichever edge is first — if the self edge wins, clarifyNodeForGate
        // points at the self clarify node and the cross node's
        // sessionModeForQuestioner would be silently ignored. (Codex review #3.)
        const crossQuestionerNodeId =
          clarifyMode === 'cross'
            ? findCrossClarifyNodeForQuestioner(definition, node.id)
            : undefined
        const crossQuestionerNode = crossQuestionerNodeId
          ? (definition.nodes.find(
              (n) => n.id === crossQuestionerNodeId && n.kind === 'clarify-cross-agent',
            ) as ClarifyCrossAgentNode | undefined)
          : undefined
        const sessionMode = crossQuestionerNode
          ? resolveCrossClarifySessionMode(crossQuestionerNode)
          : clarifyNodeObjForGate
            ? resolveClarifySessionMode(clarifyNodeObjForGate)
            : 'isolated'
        const isClarifyRerun = isClarifyRerunCause(currentRunRow?.rerunCause)
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

        // RFC-132 (PR-C): the designer's §6 update-mode prior output is no longer fetched here (the
        // cross-clarify-specific designer working-draft fetch + its dedicated prior-output block are
        // gone). A designer responding to feedback now surfaces its working draft through the SAME
        // generalized RFC-119 prior-output path every other rerun uses (`freshestPriorRunWithOutput`
        // below). RFC-141 removed the RFC-120 §18 pure-override handoff suppression that used to
        // gate it — an override target now sees its own draft too.

        // RFC-132 (PR-C): the standing continue/stop directive is read SOLELY from the per-(task,
        // asking-node) clarify state (design §7) — the per-round directive concept is gone. The flat
        // injector (buildClarifyQueueContext) carries no directive; the scheduler drives
        // effectiveHasClarifyChannel / clarifyStopped / clarifyStopNotice from nodeDirective /
        // nodeStopOverride below. So the former per-role SELECT fork + the per-round directive-override
        // plumbing (which only fed the round-grouped injectors) are gone — selectAgentQueue queries
        // every role in one shot.
        //
        // RFC-122 (H1 fix): read the node directive AT DISPATCH (parallel to RFC-056 resolveCrossNodeStopped)
        // INSIDE the retry loop so EVERY attempt's freshly-minted process-retry row reads the LATEST
        // toggle (a flip while attempt N runs is honored by attempt N+1). Gated on hasClarifyChannel
        // (self-clarify AND cross-questioner both wire the same `__clarify__` source port); every
        // other node skips the read ⇒ undefined ⇒ nodeStopOverride=false.
        // RFC-123 (B1): read the FULL directive (not just === 'stop') so an explicit 'continue' toggle
        // can re-open a stopped channel (nodeStopOverride flips false → resolveEffectiveClarifyChannel
        // re-opens). No row ⇒ undefined ⇒ byte-for-byte unchanged.
        const nodeDirectiveRow = hasClarifyChannel
          ? await getNodeClarifyDirectiveRow(db, taskId, node.id)
          : undefined
        const nodeDirective = nodeDirectiveRow?.directive
        const nodeStopOverride = nodeDirective === 'stop'
        // RFC-132 (PR-C): the SINGLE unified deferred injector. selectAgentQueue pulls this node's
        // whole agent queue — self / questioner / designer / manual — in ONE query (design §2
        // "consumerKind 消失"), binds it to this rerun (承接 marker), and renders one flat
        // `## Clarify Q&A` block (§5). It replaces the former split self/questioner + designer
        // injectors: a designer's questions now ride the SAME block (§5 ②b), so there is no separate
        // designer External-Feedback context / `## External Feedback` section. Called for EVERY agent
        // node — an override / borrow target can hold a
        // reassigned question yet wire no clarify channel of its own (this mirrors the pre-PR-C
        // UNCONDITIONAL per-node-queue designer call). An empty queue ⇒ undefined ⇒ no injection.
        const clarifyQueue = await buildClarifyQueueContext({
          db,
          definition,
          taskId,
          consumerNodeId: node.id,
          dispatchedRunId: nodeRunId,
          iteration,
        })
        // RFC-141: the RFC-120 §18 pure-override handoff suppression (`suppressPriorOutput`) is
        // GONE by user ruling — the reassigned Q&A rides the flat block below, and the prior-output
        // sections render alongside it as the node's own background.
        const clarifyContext =
          clarifyQueue === undefined
            ? undefined
            : {
                // renderUserPrompt emits this verbatim + skips the legacy round-grouped sections.
                flatBlock: clarifyQueue.block,
                iteration: String(clarifyGeneration),
                remaining: computeRemaining(definition, node.id, clarifyGeneration),
                // Inline session resume still suppresses input re-injection + swaps the trailing
                // reminder; the flat block itself is round-agnostic (RFC-131 aging keeps it small).
                ...(resumeDecision.inlineMode
                  ? { mode: 'inline' as const, currentRoundOnly: true }
                  : {}),
              }
        // effectiveHasClarifyChannel is the "mandatory ask-back is ACTIVE" signal
        // threaded to the runner + renderUserPrompt (RFC-100). It is TRUE only
        // when the agent is in a genuine clarify round and must ask back:
        //   - hasClarifyChannel: the agent wired a clarify channel, AND
        //   - directive !== 'stop' (RFC-023): the user has not clicked
        //     "Stop clarifying" — a stop round finalizes with <workflow-output>;
        //     the answersBlock already carries the STOP CLARIFYING sentence. The
        //     next round walks back through scheduleAgentNode and re-derives the
        //     flag, so 'stop' naturally scopes to one rerun, AND
        //   - (reviewContext === undefined || isClarifyRerun) (RFC-100 + Codex
        //     review #1 fix): a review reject/iterate RE-PRODUCTION run is NOT a
        //     clarify round — it must produce <workflow-output> to address the
        //     reviewer's comments, so reviewContext disables mandatory ask-back for
        //     it (without this a clarify-channel designer could never satisfy a
        //     review iterate; its v2 output would be rejected as clarify-required).
        //     BUT a clarify-answer rerun that happens DURING a review-iterate cycle
        //     (the designer asked back, the user answered) IS a clarify round and
        //     must honor its directive — so isClarifyRerun re-enables the gate
        //     there. Otherwise a "Keep clarifying" answer mid-review would be
        //     bypassed and the agent could finalize before the user clicks Stop.
        //     The agent may still CHOOSE to emit <workflow-clarify> on a pure
        //     iterate (the runner accepts it); it just isn't forced to.
        //
        // RFC-122: extracted to the pure `resolveEffectiveClarifyChannel` oracle
        // and extended with the per-(task, asking-node) `nodeStopOverride` term —
        // the on-canvas "停止反问" toggle forces ask-back off here for BOTH self and
        // cross. `nodeStopOverride=false` reproduces the exact pre-RFC-122 boolean
        // (golden-lock).
        const effectiveHasClarifyChannel = resolveEffectiveClarifyChannel({
          hasClarifyChannel,
          // RFC-132 (PR-C): the standing directive is the node clarify state (design §7); the flat
          // context carries none. nodeStopOverride already covers `=== 'stop'`, so this is redundant
          // with it but kept explicit for the oracle's contract (golden-lock).
          contextDirective: nodeDirective,
          nodeStopOverride,
          reviewActive: reviewContext !== undefined,
          isClarifyRerun,
        })
        // RFC-123 follow-up (user「强制停止」): is the node EXPLICITLY stopped? RFC-132 (PR-C): a
        // 'stop' answer already writes the per-node clarify state (clarifySeal.setNodeClarifyDirective),
        // so the node directive IS the single source — `nodeStopOverride` alone captures both the canvas
        // toggle AND a latest answered 'stop'. Threaded to the runner so a disobedient
        // <workflow-clarify> is REJECTED (no session) under an explicit stop, while review reruns
        // (reviewActive && !isClarifyRerun) keep emitting clarify.
        const clarifyStopped = hasClarifyChannel && nodeStopOverride
        // RFC-122 (H2 fix), RFC-132 (PR-C): inject the standalone STOP CLARIFYING trailer whenever the
        // node is stopped. The flat block NEVER carries a per-question directive trailer (§5), so —
        // unlike the round-grouped path — the trailer's ONLY source is this notice. `contextDirective:
        // undefined` makes shouldInjectStopNotice return `nodeStopOverride` (the block can never
        // already carry it), so a stopped node always gets exactly one STOP trailer (first run /
        // review-rerun / answered-stop alike).
        const clarifyStopNotice = shouldInjectStopNotice({
          nodeStopOverride,
          contextDirective: undefined,
        })
        // RFC-122 (same-session follow-up fix): a same-session envelope follow-up
        // (renderEnvelopeFollowupPrompt) re-anchors on "the format previously
        // specified in this session" WITHOUT re-emitting the full protocol. If the
        // per-attempt STOP toggle flipped this attempt's clarify-vs-output mode
        // relative to the prior attempt, that format was never specified in the
        // resumed session — so bypass the follow-up and let the FULL
        // renderUserPrompt render the correct protocol (output-port list +
        // clarifyStopNotice, or the mandatory ask-back block) from scratch.
        // Bidirectional (stop→output AND output→stop). Golden-lock: with no toggle
        // the mode is stable across attempts ⇒ false ⇒ follow-up path unchanged.
        const clarifyModeFlip =
          followupDecision.followup && priorAttemptClarifyActive !== effectiveHasClarifyChannel
        priorAttemptClarifyActive = effectiveHasClarifyChannel
        // RFC-119 / RFC-132 (PR-C) / RFC-141: generalized prior-output for ANY rerun — review
        // reject/iterate (supersede→canceled), manual retry, cascade, resume, clarify-answer,
        // mandatory ask-back rounds, override handoffs, AND the cross-clarify designer (whose
        // dedicated prior-output path was removed — a designer responding to feedback surfaces
        // its working draft through THIS single path). RFC-141 (user ruling) removed two former
        // gates:
        //   - RFC-119 D6 "mandatory ask-back suppresses" — its "nearly impossible" premise was
        //     disproved (a node with a done draft re-enters ask-back on every new answer batch;
        //     evidence: QMGP5 agent_m7p3n1 retry 17). renderUserPrompt now picks the ask-back
        //     directive variant off the same hasClarifyChannel signal that picks the trailing
        //     protocol, so the wording cannot contradict the clarify-only round.
        //   - RFC-120 §18 "pure-override handoff suppresses" — the override target now sees its
        //     own draft as background; the reassigned Q&A rides `## Clarify Q&A`.
        // Still skipped on inline session resume (the resumed session already holds the prior
        // output — re-injecting wastes tokens and re-anchors on stale text).
        // D10: on a review-ITERATE, RFC-014's `## Sibling Outputs` already carries the sibling ports;
        // restrict to the iterate-target port so the two don't duplicate. review-reject / non-review
        // reruns → all ports (onlyPorts undef).
        let priorOutputUpdate: { block: string } | undefined
        if (currentRunRow !== undefined && !resumeDecision.inlineMode) {
          const priorRun = await freshestPriorRunWithOutput(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
          })
          if (priorRun !== undefined) {
            const onlyPorts =
              reviewContext?.iterateTargetPort !== undefined
                ? new Set([reviewContext.iterateTargetPort])
                : undefined
            const block = await composePriorOutputBlock(
              db,
              priorRun.id,
              agent.outputs ?? [],
              onlyPorts,
            )
            if (block.length > 0) priorOutputUpdate = { block }
          }
        }
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
        // clarify-driven rerun (rows whose rerun_cause is in the gate-2 set;
        // follow-up attempt rows are minted cause='process-retry' and gate
        // FALSE) so the two paths cannot fight over the same
        // `resumeSessionId` slot. When both contexts are present,
        // follow-up wins because it expresses what THIS attempt is for.
        // RFC-122 (mode-flip session-clear): a STOP-toggle mode flip already
        // bypasses the same-session follow-up PROMPT (clarifyModeFlip → full
        // renderUserPrompt). Don't then resume the prior (wrong-mode) opencode
        // session for it — the prior session is clarify-only or output-only and
        // resuming it would feed the full fresh-mode prompt into a contradictory
        // conversation. On a flip we fall to resumeDecision.resumeSessionId, which
        // for a process-retry ('isolated') is undefined ⇒ a FRESH session matching
        // the full prompt. Golden-lock: no flip ⇒ `&& !clarifyModeFlip` is a no-op
        // ⇒ same-session resume byte-identical to today. (The worktree rollback +
        // pre-snapshot stay gated on followupDecision.followup — see the RFC-122
        // residual note: downgrading those needs the directive at loop top, which
        // is entangled with buildPromptContext; tracked as a follow-up.)
        // RFC-127 F1 + Codex impl-gate P2: a same-attempt envelope follow-up
        // (followupResumeSessionId is THIS attempt's own session) stays paired with
        // envelopeFollowup mode (the runner renders only the short repair prompt).
        // (RFC-132 ③: the borrowed-row special case is gone with the borrow ledger —
        // a node always runs its own agent, so the inline resume is always its own.)
        const effectiveResumeSessionId =
          followupDecision.followup && !clarifyModeFlip
            ? followupResumeSessionId
            : resumeDecision.resumeSessionId
        // RFC-132 (PR-C): the follow-up strong-bias trailer (renderEnvelopeFollowupPrompt) fires on
        // clarifyDirective==='continue'. When effectiveHasClarifyChannel is true the node IS in
        // ask-back ("keep clarifying") mode, so the directive is 'continue' by construction. Gate on a
        // non-empty flat queue (clarifyContext defined) to preserve the legacy "no trailer on a
        // first-ever run with no answered round" behavior (the per-round directive was undefined
        // there).
        const followupClarifyDirective =
          followupDecision.followup && effectiveHasClarifyChannel && clarifyContext !== undefined
            ? ('continue' as const)
            : undefined
        // RFC-111 D15: read the runtime frozen onto this node_run, or freeze it
        // now (agent.runtime ?? config.defaultRuntime) on the first dispatch.
        // resume/retry of the same row read the frozen value so a mutated
        // agent / default can't re-route a captured session to the wrong runtime.
        // RFC-112 P1: a retry / clarify-rerun mints a FRESH row but may carry a
        // prior session id — inherit that session owner's frozen (protocol,
        // binary) so the id + runtime stay a pair across the new row.
        const inheritedRuntime =
          effectiveResumeSessionId !== undefined
            ? await frozenRuntimeOfSession(db, effectiveResumeSessionId)
            : null
        const frozenRuntime = await resolveFrozenRuntime(
          db,
          nodeRunId,
          agent.runtime,
          state.opts.defaultRuntime,
          inheritedRuntime,
        )
        lastResult = await runNode({
          taskId,
          nodeRunId,
          nodeId: node.id,
          agent,
          runtime: frozenRuntime.protocol,
          runtimeBinary: frozenRuntime.binary,
          runtimeParams: frozenRuntime.params,
          inputs: upstreamInputs,
          // RFC-130 D16: the opencode cwd + ALL path-bearing template tokens point
          // at the ISOLATED worktree, not the canonical one — otherwise the agent
          // would be told (via {{__repo_path__}} / {{__repos__}}) to edit a path
          // outside its isolation. repos[].repoPath stays the source repo (an origin
          // reference, not a cwd); repos[].worktreePath becomes the per-repo iso.
          worktreePath: isoHandle.repos[0]?.isoWorktreePath ?? task.worktreePath,
          // RFC-067: thread per-task Git commit identity through to the runner
          // so `git commit` invocations inside the agent inherit the
          // task-scoped author + committer. Both NULL → runner skips
          // injection and falls back to daemon's default git config.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: isoHandle.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: node.id,
            iteration,
            // RFC-066: per-repo metadata for the {{__repos__}} /
            // {{__repo_names__}} / {{__repo_count__}} placeholders.
            repos: isoHandle.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          ...(reviewContext !== undefined ? { reviewContext } : {}),
          // RFC-132 (PR-C): a single flat clarifyContext (self/questioner/designer merged, §5). No
          // separate designer External-Feedback context — the designer's Q&A rides
          // clarifyContext.flatBlock.
          ...(clarifyContext !== undefined ? { clarifyContext } : {}),
          ...(priorOutputUpdate !== undefined ? { priorOutputUpdate } : {}),
          ...(clarifyMode === 'cross' ? { clarifyMode: 'cross' as const } : {}),
          ...(effectiveResumeSessionId !== undefined
            ? { resumeSessionId: effectiveResumeSessionId }
            : {}),
          // RFC-122: a same-session follow-up is bypassed when the STOP toggle
          // flipped this attempt's clarify-vs-output mode (clarifyModeFlip) — the
          // resumed session never emitted the now-needed protocol, so the runner
          // takes the FULL renderUserPrompt path instead (clarifyStopNotice + the
          // complete output protocol, or the mandatory ask-back block).
          ...(followupDecision.followup && !clarifyModeFlip
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
          ...(clarifyStopped ? { clarifyStopped: true as const } : {}),
          // RFC-122: inject STOP CLARIFYING on a first-run / pre-clarify retry
          // override (when no answersBlock carries it). Omitted otherwise.
          ...(clarifyStopNotice ? { clarifyStopNotice: true as const } : {}),
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

    // RFC-130 §段③: on success, merge the iso delta back into the canonical
    // worktree under a brief writeSem window. The runner already wrote
    // status='done'; downstream readiness ALSO gates on merge_state (D15,
    // deriveFrontier), so nothing dispatches off this node until 'merged'.
    // D19: a <workflow-clarify> reply is status='done' with result.clarify set but
    // has NOT produced final output — skip merge-back and KEEP the iso so the
    // answered inline resume (same opencode session) sees the files it wrote.
    if (lastResult !== null && lastResult.status === 'done' && lastResult.clarify !== undefined) {
      keepIso = true
    } else if (!isoHandle.passthrough && lastResult !== null && lastResult.status === 'done') {
      try {
        const nodeTrees = await snapshotNodeIsoFinal(isoHandle, log)
        await persistIsoNodeTree(db, nodeRunId, task.repoCount, nodeTrees)
        const merge = await writeSem.run(async () => {
          const mergeRes = await mergeBackNodeIso(isoHandle, nodeTrees, log)
          if (mergeRes.clean) return { kind: 'merged' as const }
          // RFC-130 §6.2 — resolve the conflict(s) with the built-in merge agent
          // WITHIN the same writeSem hold so a sibling merge-back can't advance the
          // canonical worktree under us (which would invalidate the merged tree).
          // Canon for the conflicted repo(s) was NOT touched (D27); the agent works
          // inside a resolve-iso and materializes back only on success. Holding
          // writeSem across the (rare) agent run is the §6.2/D5 tradeoff; the agent's
          // runNode bypasses globalSem (§7 — no writeSem↔globalSem cycle).
          const res = await resolveMergeConflicts(state, {
            conflicts: mergeRes.conflicts,
            containerPath: isoHandle.containerPath,
            conflictNodeRunId: nodeRunId,
            nodeId: node.id,
            iteration,
          })
          return res.allResolved
            ? { kind: 'merged' as const }
            : { kind: 'conflict-human' as const, detail: res.detail }
        })
        if (merge.kind === 'merged') {
          await transitionMergeState({ db, nodeRunId, event: { kind: 'mark-merged', via: 'live' } })
        } else {
          // §6.3 — merge agent could not resolve → park human. Conflict is NEVER
          // silently lost; canonical stays clean for siblings; the resolve-iso(s)
          // are kept (keepIso) so the human finishes there and resume re-merges (#4).
          await transitionMergeState({
            db,
            nodeRunId,
            event: { kind: 'park-conflict-human', via: 'live' },
          })
          log.warn('merge-back conflict unresolved by merge agent → awaiting_human', {
            nodeId: node.id,
            detail: merge.detail,
          })
          keepIso = true
          return {
            kind: 'awaiting_human',
            summary: `merge conflict unresolved: ${merge.detail}`,
            message: 'merge-conflict',
          }
        }
      } catch (err) {
        // RFC-130 robustness: a merge-back that THROWS (iso corrupted, .git gone,
        // a git op error) must fail the node loudly — never leave a 'done' row
        // whose delta never reached canonical. merge_state='merge-failed' keeps
        // downstream gated (D15); the failed result fails the task.
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('merge-back failed', { nodeId: node.id, error: msg })
        // try-variant: this catch must surface the ORIGINAL merge error via the
        // failed result — a CAS/illegal throw here would mask it (RFC-144 §5).
        const flipped = await tryTransitionMergeState({
          db,
          nodeRunId,
          event: { kind: 'mark-merge-failed', reason: msg },
        })
        if (!flipped) log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId })
        lastResult = { ...lastResult, status: 'failed', errorMessage: `merge-back-failed: ${msg}` }
      }
    }
  } finally {
    releaseGlobal()
    // Discard the iso worktree on a terminal exit; keep it when the node is
    // parked (awaiting_human / merge conflict) so the resume path (D19) + the
    // future merge agent (PR-B) can reuse the exact same worktree state.
    if (!keepIso) await discardNodeIso(isoHandle, log)
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

/**
 * RFC-098 B3 (audit S-7) — provenance for loop/git wrapper rows. For every
 * EXTERNAL upstream source of the wrapper (wrapperExternalUpstreamSources,
 * dispatchFrontier.ts) pick the run an inner node would consume via
 * resolveUpstreamInputs at this iteration window (pickUpstreamSourceRun —
 * shared picker, freshness.ts) and record `{sourceNodeId: runId}`. Stamped
 * onto the wrapper row so an upstream rerun demotes the wrapper's done row to
 * stale → frontier re-dispatch → findResumableWrapperRun sees done as
 * terminal → a FRESH wrapper row is minted: the loop restarts from iteration
 * 0 / the git wrapper re-captures its baseline (the correct semantics; the
 * fanout wrapper has carried the same contract since RFC-074 §8 D3).
 *
 * A source with no visible done run yet is simply ABSENT from the map (the
 * same warn-and-skip resolveUpstreamInputs applies) — that source can then
 * never demote this wrapper generation, which matches the agent-row contract
 * (isNodeRunFresh treats absent upstreams as still-fresh).
 *
 * Known bounded degradations (adversarial-review revision #6 + survey
 * §wp6c-loopgit, recorded here as the failure-mode ledger):
 *   - WRITE AT FRESH-MINT ONLY — resume must NOT overwrite. A resume-time
 *     overwrite would permanently mask an external-source rerun that landed
 *     while the wrapper was parked (the stale signal vanishes and the
 *     semantics drift with dispatch timing). Under fresh-mint-only the parked
 *     generation keeps its original provenance, finishes, is then naturally
 *     judged stale and fully re-run next invocation — one extra full pass,
 *     but convergent.
 *   - Same-invocation done→stale: if the upstream rerun lands in the SAME
 *     runScope invocation that already dispatched the wrapper, the
 *     per-invocation dedup parks the stale done row as
 *     blocked('stale-done-in-invocation-dedup') and the scope can end
 *     stalled — bounded, a resume re-derives and re-runs it.
 *   - Wrapper re-run does NOT roll the worktree back (wrapper rows carry no
 *     preSnapshot): the new generation sees the previous generation's
 *     worktree residue. Known open point, same family as the cross-generation
 *     preDirty interplay noted in design/RFC-098 §B3.
 */
async function computeWrapperConsumed(
  db: DbClient,
  taskId: string,
  definition: WorkflowDefinition,
  wrapperId: string,
  iteration: number,
): Promise<Record<string, string>> {
  const consumed: Record<string, string> = {}
  // Sorted for a deterministic JSON key order (stable across re-mints).
  const sources = [...wrapperExternalUpstreamSources(wrapperId, definition)].sort()
  for (const sourceNodeId of sources) {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, sourceNodeId)))
    const run = pickUpstreamSourceRun(rows, iteration)
    if (run !== undefined) consumed[sourceNodeId] = run.id
  }
  return consumed
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
  // four terminal states. 'running' is the typical legal source — RFC-098 B3
  // (audit S-28) marks every wrapper row running right after its fresh mint
  // (and the resume path always flips running first), so 'pending' is no
  // longer a reachable source here and was removed from allowedFrom; the only
  // surviving pending rows are daemon-crash orphans, which the boot reaper
  // flips to interrupted without passing through this function. awaiting_* is
  // still legal when a wrapper bubbled up an awaiting child and is now being
  // short-circuited by cancel.
  await setNodeRunStatus({
    db,
    nodeRunId: wrapperRunId,
    to: status,
    allowedFrom: ['running', 'awaiting_review', 'awaiting_human'],
    reason: 'wrapper-finalize',
    extra: {
      finishedAt: Date.now(),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  })
  // Note: wrapperProgressJson is left in place after terminal transitions —
  // it's debug breadcrumb for "where did this wrapper park last" and is
  // never read again by the scheduler once status is terminal…
  //
  // …with ONE exception (RFC-098 B3, audit S-20 / adversarial-review revision
  // #7): the fanout `reuseDisabled` gate must be CLEARED here. By the time a
  // wrapper goes terminal, every shard owns a row from the disabled
  // generation (fail-all-after-join runs all shards to completion; cancel
  // joins too), so those rows are the freshest per shardKey and reuse is safe
  // again — leaving the flag set would permanently disable done-shard reuse
  // for this row's resume lineage. Only the flag is stripped; the rest of the
  // payload stays as breadcrumb.
  const [terminalRow] = await db
    .select({ wrapperProgressJson: nodeRuns.wrapperProgressJson })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  const progress = decodeWrapperProgress(terminalRow?.wrapperProgressJson, () => {})
  if (progress !== null && progress.reuseDisabled === true) {
    const { reuseDisabled: _cleared, ...rest } = progress
    await persistWrapperProgress(db, wrapperRunId, rest as WrapperProgress)
  }
}

// -----------------------------------------------------------------------------
// wrapper-loop (P-4-01) — RFC-040 makes it bubble awaiting_* and resumable.
// -----------------------------------------------------------------------------

async function runLoopWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition } = state
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
    // RFC-098 B3 (audit S-7, revision #6): resume deliberately does NOT
    // (re-)write consumedUpstreamRunsJson — see computeWrapperConsumed's
    // failure-mode ledger. The fresh-mint stamp below is the only write.
  } else {
    // RFC-098 B3 (audit S-7): stamp external-upstream provenance at fresh
    // mint, mirroring the fanout wrapper (RFC-074 §8 D3) — an upstream rerun
    // now demotes this wrapper's done row to stale and the loop re-runs from
    // iteration 0 on the next dispatch.
    const consumed = await computeWrapperConsumed(db, taskId, definition, node.id, parentIteration)
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration: parentIteration,
      overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
    })
    // RFC-098 B3 (audit S-28): flip the freshly-minted row pending→running
    // BEFORE the broadcast (DB-first rule, lifecycle.ts) and before any
    // reachable markWrapperTerminal — the DB row and the WS 'running' ping
    // must never disagree (scheduler-audit-s07-s28 locks the pairing).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
  }

  // RFC-130 T12 (D29): loop-PRIVATE canonical — the loop's inner iterations run in a
  // loop-canonical (iso worktree of the loop), so cross-iteration state accumulates
  // there ISOLATED from sibling merge-backs into the task canonical; the loop's total
  // delta merges back as ONE unit when it exits (§8.2). Passthrough (non-git harness)
  // → runs on the task canonical as before. Kept across a park; rebuilt on resume.
  const wrapperIso = await createOrRebuildWrapperIso(state, wrapperRunId, existing)
  const innerState: SchedulerState = wrapperIso.passthrough
    ? state
    : {
        ...state,
        repos: wrapperIso.repos.map((r) => ({
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          baseBranch: r.baseBranch,
        })),
      }

  const innerSet = new Set(inner)
  for (let i = startIter; i < maxIter; i++) {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'inner-running',
    })

    const subRes = await runScope(innerState, {
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
        await upsertWrapperOutput(db, wrapperRunId, b.name, v)
      }
      // RFC-130 T12: merge the loop's total (all-iterations) delta back into the
      // task canonical as one unit when it exits.
      if (!wrapperIso.passthrough) {
        const mb = await mergeBackWrapperIso(state, wrapperIso, wrapperRunId, node, i, log)
        if (mb.kind === 'conflict-human') {
          // row parked conflict-human → the scope outcome is awaiting_human.
          return {
            kind: 'awaiting_human',
            summary: `loop merge conflict: ${mb.detail}`,
            message: 'merge-conflict',
          }
        }
        if (mb.kind === 'merge-failed') {
          await markWrapperTerminal(db, wrapperRunId, 'failed', `wrapper-merge-failed:${mb.msg}`)
          broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
          return {
            kind: 'failed',
            summary: `loop merge-back failed: ${mb.msg}`,
            message: 'wrapper-merge-failed',
          }
        }
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
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration,
    })
    // RFC-098 B3 (audit S-28): mark-running immediately after the mint — it
    // must precede EVERY reachable markWrapperTerminal below (empty-source
    // short-circuit done, cartesian guard, inner/agent-missing failures) so
    // their from='running' is legal, and precede the broadcast (DB-first
    // rule, lifecycle.ts).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
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

  // RFC-098 B3 (audit S-20 + adversarial-review revision #7) — consumed
  // GENERATION GATE, evaluated BEFORE the provenance overwrite below (the
  // overwrite is exactly what used to erase the mismatch evidence). When the
  // previously recorded consumed map differs from the freshly resolved one,
  // an external upstream re-ran while this wrapper was parked/failed — the
  // prior generation's done shard rows may be stale in ways the per-shard
  // value hash cannot see (path-family shard values are bare path strings),
  // so done-row reuse is disabled for this entire pass (full re-run).
  let reuseDisabled = false
  let priorConsumedRaw: string | null = null
  if (existing !== null) {
    // Resume: compare against the row's own previously recorded consumed, and
    // honor the PERSISTED gate (revision #7 crash-resume backdoor: a crashed
    // disabled run has already overwritten the consumed column, so the
    // comparison alone would wrongly pass on resume).
    priorConsumedRaw = existing.consumedUpstreamRunsJson
    const persisted = decodeWrapperProgress(existing.wrapperProgressJson, (msg) =>
      log.warn(msg, { taskId, nodeId: node.id }),
    )
    if (persisted !== null && persisted.reuseDisabled === true) reuseDisabled = true
  } else {
    // Fresh mint: cross-generation shard reuse replays the PREVIOUS
    // generation's children, so ITS recorded consumed is the comparison base.
    // Rows with NULL consumed are skipped (retryNode's inert placeholder rows
    // never ran and record nothing; legacy rows predate provenance) — absent
    // evidence is treated as MATCH, mirroring the hash NULL=match policy.
    const priorGenRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, node.id),
          eq(nodeRuns.iteration, iteration),
        ),
      )
    const priorGen = pickFreshestRun(
      priorGenRows.filter((r) => r.id !== wrapperRunId && r.consumedUpstreamRunsJson !== null),
      { topLevelOnly: true },
    )
    priorConsumedRaw = priorGen?.consumedUpstreamRunsJson ?? null
  }
  if (
    priorConsumedRaw !== null &&
    !consumedMapsEqual(parseConsumedJson(priorConsumedRaw), wrapperConsumed)
  ) {
    reuseDisabled = true
  }
  if (reuseDisabled) {
    // Persist BEFORE overwriting consumed: a crash between the two writes
    // re-derives the same verdict on resume (the comparison still trips); a
    // crash AFTER the overwrite is covered by this persisted flag. Cleared by
    // markWrapperTerminal once the wrapper reaches a terminal state.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'fanout',
      phase: 'inner-running',
      reuseDisabled: true,
    })
  }

  // RFC-074 §8 (D3): the fan-out wrapper is provenance-atomic — record which
  // upstream runs the wrapper consumed on the wrapper row so freshness can
  // re-run the whole wrapper when an upstream advances. Inner shard rows do NOT
  // record provenance (treated as fresh within this wrapper run). RFC-098 B3:
  // this overwrite intentionally happens AFTER the generation gate above.
  await db
    .update(nodeRuns)
    .set({ consumedUpstreamRunsJson: JSON.stringify(wrapperConsumed) })
    .where(eq(nodeRuns.id, wrapperRunId))

  // 5. Derive wrapper outlets (aggregator outputs OR __done__ signal).
  const derivedOutputs = deriveWrapperFanoutOutputs(definition, node.id, agentsMap)

  // 6. Empty source: short-circuit done with empty outlets.
  // RFC-103 T4 (05-PORT-06/07): split via the single-source listWire codec,
  // kind-aware — `list<markdown>` items are inline multi-line bodies framed by
  // MARKDOWN_DOC_BOUNDARY; `list<path<md>>` / `list<string>` are one-per-line.
  // Hand-rolling `.split('\n')` here shredded each markdown document per line.
  const items = isInlineMarkdownItemKind(itemKind)
    ? splitMarkdownDocs(rawContent)
    : splitListItems(rawContent)
  if (items.length === 0) {
    for (const port of derivedOutputs) {
      await upsertWrapperOutput(db, wrapperRunId, port.name, '')
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
            reuseDisabled,
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
        reuseDisabled,
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
      reuseDisabled,
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
      await upsertWrapperOutput(db, wrapperRunId, outletName, content)
    }
  } else {
    // No aggregator: emit the implicit __done__ signal outlet. Empty content;
    // downstream can chain on it but must NOT reference it inside {{...}} —
    // assertNoPromptSignalRefs (D.T7) catches that at prompt-render time.
    await upsertWrapperOutput(db, wrapperRunId, FANOUT_DONE_PORT_NAME, '')
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

/**
 * RFC-098 B3 (audit S-20): sha256 hex of a fanout shard's value — the
 * cross-generation reuse identity stamped into `node_runs.shard_value_hash`
 * (migration 0043) and re-derived at dispatch time for the
 * pickReusableShardRun match. createHash precedent: util/git.ts.
 */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
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
  /**
   * RFC-098 B3 (audit S-20): the wrapper-entry consumed generation gate —
   * true forbids replaying ANY done prior row (this shard re-runs even when
   * its value hash matches). See runFanoutWrapperNode's gate block.
   */
  reuseDisabled: boolean
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
  // Cross-generation reuse identity (S-20): sha256 of the shard VALUE. The
  // shared/broadcast dispatch has no per-shard value → NULL (matches any —
  // the consumed generation gate is the shared row's only content guard).
  const valueHash = shard === null ? null : sha256Hex(shard.value)

  // Idempotent (re)dispatch — RFC-098 B3 (audit S-19): candidates are anchored
  // on (taskId, innerNodeId, iteration, shardKey, parentNodeRunId IS NOT NULL),
  // RELAXED from the old "parentNodeRunId = this wrapperRunId" so a retried
  // wrapper generation (failed → resume mints a FRESH wrapperRunId) can replay
  // the previous generation's done children instead of re-running every shard.
  // The non-null parent filter keeps frontier invisibility intact (deriveFrontier
  // / buildFreshestDonePerNode / pickFreshestRun all skip child rows) AND
  // excludes the top-level inert placeholder rows retryNode mints for inner
  // nodes. Three branches on the FRESHEST candidate (pure id-order):
  //   1. freshest is done + value-hash match (NULL=match, legacy rows) + reuse
  //      not disabled → replay its outputs without a spawn (same- OR cross-
  //      generation; the row keeps its original parent — history stays true).
  //   2. freshest is non-done and belongs to THIS wrapper generation → re-run
  //      it in place (the same-generation idempotency branch:
  //      scheduler-boundary-fanout-resume-duplicate-shards locks each shardKey
  //      to exactly ONE row under the resumed wrapper).
  //   3. anything else (no candidate / prior-generation non-done residue /
  //      done but hash-mismatched or reuse-disabled) → mint a fresh row under
  //      this wrapper, stamped with sha256(shard.value) (shared rows stay NULL).
  const candidates = (
    await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, innerNode.id),
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
  ).filter((r) => (r.shardKey ?? null) === rowShardKey)
  const freshest = pickFreshestRun(candidates, { topLevelOnly: false })
  const reusable = args.reuseDisabled
    ? undefined
    : pickReusableShardRun(candidates, { shardKey: rowShardKey, valueHash })
  let shardRunId: string
  // RFC-130 §8.3 D9 (T14): when this dispatch RE-RUNS a shard whose prior attempt's
  // delta is already merged into canon, undo that prior delta INSIDE the fresh iso
  // (below, after createNodeIso, before the agent) so the rerun's output REPLACES the
  // prior output instead of superimposing on it. SINGLE REPLACEMENT LEVEL (Codex
  // impl-gate P1): only when EXACTLY ONE done+merged candidate exists — its persisted
  // base_snapshot is then the true pre-shard state. With ≥2 merged generations the
  // older row's base already carries an earlier delta, so a further undo would
  // resurrect stale files; we fall back to superimposition (== pre-T14 for that rare
  // 3rd+ generation, never destructive). Covers branch-2 resume too (the merged row is
  // an older candidate, not the non-done freshest). Passthrough rows keep NULL iso
  // columns → skipped. Applied only to the private iso — canon is never touched before
  // the rerun succeeds (AC-6). Branch 1 (reuse) returns before the iso is built.
  let priorShardUndo: { base: Record<string, string>; node: Record<string, string> } | null = null
  const doneMergedCandidates = candidates.filter(
    (c) => c.status === 'done' && c.mergeState === ('merged' satisfies MergeState),
  )
  if (doneMergedCandidates.length === 1) {
    const priorMergedRow = doneMergedCandidates[0]!
    const priorBase: Record<string, string> = {}
    const priorNode: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (priorMergedRow.isoBaseSnapshot !== null) priorBase[''] = priorMergedRow.isoBaseSnapshot
      if (priorMergedRow.isoNodeTree !== null) priorNode[''] = priorMergedRow.isoNodeTree
    } else {
      Object.assign(priorBase, parseIsoJsonMap(priorMergedRow.isoBaseSnapshotReposJson))
      Object.assign(priorNode, parseIsoJsonMap(priorMergedRow.isoNodeTreeReposJson))
    }
    if (Object.keys(priorNode).length > 0) priorShardUndo = { base: priorBase, node: priorNode }
  }
  if (freshest !== undefined && reusable !== undefined && reusable.id === freshest.id) {
    // Branch 1 — replay. The `reusable.id === freshest.id` guard refuses a
    // done row that has been SUPERSEDED by a fresher attempt of any status
    // (e.g. a user-targeted shard retry placeholder): replaying it would undo
    // that newer attempt's intent.
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, reusable.id))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    broadcastNodeStatus(taskId, reusable.id, innerNode.id, 'done')
    return { kind: 'ok', shardKey, outputs, message: '' }
  }
  if (
    freshest !== undefined &&
    freshest.status !== 'done' &&
    freshest.parentNodeRunId === wrapperRunId
  ) {
    // Branch 2 — re-run the existing same-generation child in place.
    // allowTerminal: a reaped child is 'interrupted' (terminal); reset to
    // pending so runNode's mark-running (pending → running) applies cleanly.
    shardRunId = freshest.id
    await setNodeRunStatus({
      db,
      nodeRunId: shardRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-shard-resume',
    })
    // The re-run consumes the CURRENT shard value — refresh the stored hash
    // so future reuse decisions compare against what actually ran.
    await db.update(nodeRuns).set({ shardValueHash: valueHash }).where(eq(nodeRuns.id, shardRunId))
  } else {
    // Branch 3 — mint a fresh row under this wrapper. The T14 replacement target
    // (priorShardUndo) was already derived above from the latest done+merged
    // candidate and is applied at merge-back.
    shardRunId = await mintNodeRun(db, {
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      cause: 'fanout-shard',
      iteration,
      overrides: {
        parentNodeRunId: wrapperRunId,
        shardKey: rowShardKey,
        shardValueHash: valueHash,
      },
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
            // The shard item's effective kind is the list's ITEM kind, stringified
            // so the runner can re-parse it. Use the canonical stringifyKind rather
            // than a hand-rolled per-kind switch: the old inline version dropped a
            // nested list<list<...>> item to a bare 'list' (losing the inner kind);
            // stringifyKind round-trips path<md> / list<...> items intact.
            inputPortKinds[e.target.portName] = stringifyKind(lk.item)
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
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs

  // RFC-130: each fan-out shard runs in its OWN isolated worktree (no shared-worktree
  // writeSem serialization — shards run truly in parallel up to global/subprocess
  // caps and merge their deltas back one at a time). Shards usually touch DIFFERENT
  // files (per-file / per-dir sharding), so merge-backs rarely conflict.
  const releaseGlobal = await state.globalSem.acquire()
  const releaseSub = await state.subprocessSem.acquire()
  let shardIso: IsoHandle
  try {
    shardIso = await state.writeSem.run(() =>
      createNodeIso({
        appHome: opts.appHome,
        taskId,
        nodeRunId: shardRunId,
        canonRepos: state.repos,
        log,
      }),
    )
    if (!shardIso.passthrough) await persistIsoBase(db, shardRunId, task.repoCount, shardIso)
    // RFC-130 §8.3 D9 (T14): undo the prior merged delta INSIDE this fresh iso BEFORE
    // the agent runs, so the rerun's output REPLACES (not superimposes on) the prior
    // output — and a file the agent re-produces identically still survives (it lands
    // as the agent's own write on the cleaned base). Fail-open: any glitch falls back
    // to superimposition (never fails an otherwise-good shard). The iso is private, so
    // this never touches canon (a failed rerun leaves the prior delta intact, AC-6).
    if (priorShardUndo !== null && !shardIso.passthrough) {
      for (const r of shardIso.repos) {
        try {
          await undoPriorShardDeltaInIso(
            r.isoWorktreePath,
            priorShardUndo.node[r.worktreeDirName],
            priorShardUndo.base[r.worktreeDirName],
            log,
          )
        } catch (err) {
          log.warn('T14 iso-undo failed — superimposition fallback', {
            shardKey,
            worktreeDirName: r.worktreeDirName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  } catch (err) {
    releaseSub()
    releaseGlobal()
    log.warn('fanout shard iso setup failed', {
      shardKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return { kind: 'failed', shardKey, outputs: {}, message: 'iso-setup-failed' }
  }
  try {
    // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the fanout shard
    // so a claude-selected agent-multi dispatches its shards on claude, not opencode.
    const shardRuntime = await resolveFrozenRuntime(
      db,
      shardRunId,
      innerAgent.runtime,
      opts.defaultRuntime,
    )
    const result = await runNode({
      taskId,
      nodeRunId: shardRunId,
      nodeId: innerNode.id,
      agent: innerAgent,
      runtime: shardRuntime.protocol,
      runtimeBinary: shardRuntime.binary,
      runtimeParams: shardRuntime.params,
      inputs,
      // RFC-130 D16: cwd + path tokens → the shard's isolated worktree.
      worktreePath: shardIso.repos[0]?.isoWorktreePath ?? task.worktreePath,
      // RFC-067: per-task Git identity threaded through fanout shard dispatch.
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      templateMeta: {
        repoPath: shardIso.repos[0]?.isoWorktreePath ?? task.repoPath,
        baseBranch: task.baseBranch,
        taskId,
        nodeId: innerNode.id,
        iteration,
        ...(shard !== null ? { shardKey } : {}),
        // RFC-066: per-repo metadata for prompt placeholders.
        repos: shardIso.repos.map((r) => ({
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          baseBranch: r.baseBranch,
        })),
      },
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
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
    // RFC-130 §段③: merge the shard's iso delta back into the canonical worktree.
    // The T14 prior-delta undo (if any) already ran INSIDE the iso before the agent,
    // so the iso final is the clean replacement — merge-back is the normal path.
    if (!shardIso.passthrough) {
      try {
        const nodeTrees = await snapshotNodeIsoFinal(shardIso, log)
        await persistIsoNodeTree(db, shardRunId, task.repoCount, nodeTrees)
        const merge = await state.writeSem.run(async () => {
          const mergeRes = await mergeBackNodeIso(shardIso, nodeTrees, log)
          if (mergeRes.clean) return { kind: 'merged' as const }
          // RFC-130 §6.2 — resolve shard conflict(s) with the merge agent within the
          // writeSem hold (canon stays stable). The resolve-iso lives under the
          // shard's container; the shard's own iso is discarded in `finally`, while
          // a kept resolve-iso (on failure) survives for GC / a human.
          const res = await resolveMergeConflicts(state, {
            conflicts: mergeRes.conflicts,
            containerPath: shardIso.containerPath,
            conflictNodeRunId: shardRunId,
            nodeId: innerNode.id,
            iteration,
          })
          return res.allResolved
            ? { kind: 'merged' as const }
            : { kind: 'conflict-human' as const, detail: res.detail }
        })
        if (merge.kind === 'merged') {
          await transitionMergeState({
            db,
            nodeRunId: shardRunId,
            event: { kind: 'mark-merged', via: 'live' },
          })
        } else {
          // §6.3 — unresolved shard conflict: mark conflict-human + fail loudly so the
          // conflict is surfaced (never silently lost) and canonical stays clean.
          // Per-shard awaiting_human bubbling through the fanout aggregation is a
          // follow-up (#4/PR-E); today an unresolvable shard conflict fails the task.
          await transitionMergeState({
            db,
            nodeRunId: shardRunId,
            event: { kind: 'park-conflict-human', via: 'live' },
          })
          return {
            kind: 'failed',
            shardKey,
            outputs: {},
            message: `merge-back-conflict (merge agent could not resolve): ${merge.detail}`,
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const flipped = await tryTransitionMergeState({
          db,
          nodeRunId: shardRunId,
          event: { kind: 'mark-merge-failed', reason: msg },
        })
        if (!flipped) {
          log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: shardRunId })
        }
        return { kind: 'failed', shardKey, outputs: {}, message: `merge-back-failed: ${msg}` }
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
    await discardNodeIso(shardIso, log)
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
  /** RFC-098 B3 (audit S-20): see DispatchShardArgs.reuseDisabled. */
  reuseDisabled: boolean
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
  //
  // RFC-098 B3 (audit S-21): row picking is done-only + freshest-per-shardKey
  // via pickReusableShardRun — the EXACT picker the shard dispatch uses — and
  // the anchor is relaxed in lockstep with dispatchFanoutShard's (taskId,
  // nodeId, iteration, parentNodeRunId IS NOT NULL): a cross-generation done
  // child the dispatch phase replayed would otherwise be invisible here
  // (silent empty aggregation). The old form read with NO status filter and
  // took SELECT-order first-match — a stale outputless child shadowed the
  // fresh one.
  const aggInputs: Record<string, string> = {}
  // Every inner row that fed this aggregation: an existing aggregator row may
  // only be REPLAYED when it is fresher (pure id-order) than ALL of them — a
  // shard that re-ran after the old aggregation makes that aggregation stale.
  const participatingRowIds: string[] = []
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
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
    if (scope.perShard.has(edge.source.nodeId)) {
      // sorted by shardKey dictionary order (matches agent-multi convention).
      const sortedShards = [...shards].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
      for (const s of sortedShards) {
        const row = pickReusableShardRun(innerRows, {
          shardKey: s.shardKey,
          valueHash: sha256Hex(s.value),
        })
        if (row === undefined) continue
        participatingRowIds.push(row.id)
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
      // shared upstream — single (NULL-shardKey) row, plain content.
      const row = pickReusableShardRun(innerRows, { shardKey: null, valueHash: null })
      if (row !== undefined) {
        participatingRowIds.push(row.id)
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

  // RFC-098 B3 (audit S-21) — aggregator idempotency, mirroring the shard
  // branches. Candidates: (taskId, aggNodeId, iteration, shardKey IS NULL,
  // parentNodeRunId IS NOT NULL) — the aggregator is the convergence point so
  // its row carries no shardKey, and the relaxed anchor lets a retried
  // wrapper generation see the previous generation's aggregator row.
  //   1. freshest is done + fresher than EVERY participating inner row + reuse
  //      not disabled → replay its outputs without a spawn.
  //   2. freshest is non-done and belongs to THIS wrapper generation → re-run
  //      it in place (the daemon-restart residue that used to leak a
  //      permanently-interrupted row, scheduler-audit-s21 test 1).
  //   3. anything else → mint a fresh row (no shard_value_hash — the
  //      aggregator has no per-shard value).
  const aggCandidates = (
    await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, aggNode.id),
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
  ).filter((r) => r.shardKey === null)
  const freshestAgg = pickFreshestRun(aggCandidates, { topLevelOnly: false })
  if (
    !args.reuseDisabled &&
    freshestAgg !== undefined &&
    freshestAgg.status === 'done' &&
    participatingRowIds.every((id) => isFresherNodeRun<{ id: string }>(freshestAgg, { id }))
  ) {
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, freshestAgg.id))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    broadcastNodeStatus(taskId, freshestAgg.id, aggNode.id, 'done')
    return { kind: 'ok', summary: '', message: '', outputs }
  }
  let aggRunId: string
  if (
    freshestAgg !== undefined &&
    freshestAgg.status !== 'done' &&
    freshestAgg.parentNodeRunId === wrapperRunId
  ) {
    // Re-run the same-generation residue in place (allowTerminal: a reaped
    // aggregator is 'interrupted'; reset to pending for runNode's mark-running).
    aggRunId = freshestAgg.id
    await setNodeRunStatus({
      db,
      nodeRunId: aggRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-aggregator-resume',
    })
  } else {
    aggRunId = await mintNodeRun(db, {
      taskId,
      nodeId: aggNode.id,
      status: 'pending',
      cause: 'fanout-aggregator',
      iteration,
      overrides: { parentNodeRunId: wrapperRunId },
    })
  }
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
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs

  // RFC-119 multi-process (D9 revision): surface the aggregator's prior output on
  // a genuine re-run so it UPDATES the prior aggregated result instead of
  // regenerating blind — the multi-process analogue of the single-process
  // review/retry case. We only reach here when the aggregator actually spawns
  // (the value-hash replay branch above returned early), so this fires exactly on
  // a real re-run. `freshestPriorRunWithOutput` is parent-agnostic, so it finds
  // the prior generation's aggregator CHILD (shardKey null) for this aggNode.
  // SHARDS are deliberately NOT given prior output: their value-hash replay means
  // an unchanged slice replays without a spawn, and a CHANGED slice's prior
  // output would mis-anchor the agent to stale content.
  const aggPriorRun = await freshestPriorRunWithOutput(db, {
    taskId,
    nodeId: aggNode.id,
    iteration,
    shardKey: null,
    id: aggRunId,
  })
  let aggPriorOutputUpdate: { block: string } | undefined
  if (aggPriorRun !== undefined) {
    const block = await composePriorOutputBlock(db, aggPriorRun.id, aggAgent.outputs ?? [])
    if (block.length > 0) aggPriorOutputUpdate = { block }
  }

  // RFC-130: the aggregator runs in its OWN isolated worktree too (it can write —
  // e.g. concatenate shard outputs into a file). Merge-back into canonical on
  // success; no whole-run writeSem.
  const releaseGlobal = await state.globalSem.acquire()
  const releaseSub = await state.subprocessSem.acquire()
  let aggIso: IsoHandle
  try {
    aggIso = await state.writeSem.run(() =>
      createNodeIso({
        appHome: opts.appHome,
        taskId,
        nodeRunId: aggRunId,
        canonRepos: state.repos,
        log,
      }),
    )
    if (!aggIso.passthrough) await persistIsoBase(db, aggRunId, task.repoCount, aggIso)
  } catch {
    releaseSub()
    releaseGlobal()
    return {
      kind: 'failed',
      summary: 'aggregator iso setup failed',
      message: 'iso-setup-failed',
      outputs: {},
    }
  }
  try {
    // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the aggregator.
    const aggRuntime = await resolveFrozenRuntime(
      db,
      aggRunId,
      aggAgent.runtime,
      opts.defaultRuntime,
    )
    const result = await runNode({
      taskId,
      nodeRunId: aggRunId,
      nodeId: aggNode.id,
      agent: aggAgent,
      runtime: aggRuntime.protocol,
      runtimeBinary: aggRuntime.binary,
      runtimeParams: aggRuntime.params,
      inputs: aggInputs,
      worktreePath: aggIso.repos[0]?.isoWorktreePath ?? task.worktreePath,
      // RFC-067: per-task Git identity threaded through fanout aggregator dispatch.
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      templateMeta: {
        repoPath: aggIso.repos[0]?.isoWorktreePath ?? task.repoPath,
        baseBranch: task.baseBranch,
        taskId,
        nodeId: aggNode.id,
        iteration,
        // RFC-066: per-repo metadata for prompt placeholders.
        repos: aggIso.repos.map((r) => ({
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          baseBranch: r.baseBranch,
        })),
      },
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
      // RFC-119 multi-process: prior aggregated output on re-run (see above).
      ...(aggPriorOutputUpdate !== undefined ? { priorOutputUpdate: aggPriorOutputUpdate } : {}),
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
    // RFC-130 §段③: merge the aggregator's iso delta back into canonical.
    if (!aggIso.passthrough) {
      try {
        const nodeTrees = await snapshotNodeIsoFinal(aggIso, log)
        await persistIsoNodeTree(db, aggRunId, task.repoCount, nodeTrees)
        const merge = await state.writeSem.run(async () => {
          const mergeRes = await mergeBackNodeIso(aggIso, nodeTrees, log)
          if (mergeRes.clean) return { kind: 'merged' as const }
          // RFC-130 §6.2 — resolve the aggregator's conflict(s) with the merge agent
          // inside the writeSem hold (canon stays stable).
          const res = await resolveMergeConflicts(state, {
            conflicts: mergeRes.conflicts,
            containerPath: aggIso.containerPath,
            conflictNodeRunId: aggRunId,
            nodeId: aggNode.id,
            iteration,
          })
          return res.allResolved
            ? { kind: 'merged' as const }
            : { kind: 'conflict-human' as const, detail: res.detail }
        })
        if (merge.kind === 'merged') {
          await transitionMergeState({
            db,
            nodeRunId: aggRunId,
            event: { kind: 'mark-merged', via: 'live' },
          })
        } else {
          // §6.3 — unresolved: conflict-human + fail loudly (per-node awaiting_human
          // bubbling for fanout is a follow-up, #4/PR-E); conflict never lost.
          await transitionMergeState({
            db,
            nodeRunId: aggRunId,
            event: { kind: 'park-conflict-human', via: 'live' },
          })
          return {
            kind: 'failed',
            summary: 'aggregator merge conflict',
            message: `merge-back-conflict (merge agent could not resolve): ${merge.detail}`,
            outputs: {},
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const flipped = await tryTransitionMergeState({
          db,
          nodeRunId: aggRunId,
          event: { kind: 'mark-merge-failed', reason: msg },
        })
        if (!flipped) {
          log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: aggRunId })
        }
        return {
          kind: 'failed',
          summary: 'aggregator merge failed',
          message: `merge-back-failed: ${msg}`,
          outputs: {},
        }
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
    await discardNodeIso(aggIso, log)
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

// RFC-098 B3 (audit S-4, adversarial-review revision #9) — preDirty caps.
// Beyond either limit the capture DEGRADES TO THE EMPTY SET: the finalize
// subtraction then removes nothing, which is exactly the pre-fix cumulative
// behavior — over-report, never drop a real change. (A "paths-only" degrade
// was explicitly rejected: subtracting by bare path would drop files the
// inner scope genuinely rewrote.)
const GIT_PRE_DIRTY_MAX_ENTRIES = 4096
const GIT_PRE_DIRTY_MAX_JSON_BYTES = 256 * 1024

/**
 * RFC-098 B3 (audit S-4) — sample the worktree's pre-existing dirty set
 * `{path: blobSha | 'deleted'}` at git-wrapper FRESH MINT, right after the
 * baseline capture and inside the same task-write-lock window (no sibling
 * writer can be mid-write while we sample). Best-effort by design: any git
 * failure (no commits yet, fixture without a repo, hash race) degrades to the
 * empty set with a warn — entry must never fail the wrapper, and the empty
 * set only over-reports. Resume NEVER calls this (it reads the persisted map
 * from wrapperProgress; re-capturing after the inner scope started would
 * swallow the inner scope's own writes into the pre-set — silent UNDER-report,
 * worse than today).
 */
async function captureGitPreDirty(
  worktreePath: string,
  baseline: string,
  log: Logger,
): Promise<Record<string, string>> {
  try {
    const paths = await gitChangedFiles(worktreePath, baseline || 'HEAD')
    if (paths.length === 0) return {}
    if (paths.length > GIT_PRE_DIRTY_MAX_ENTRIES) {
      log.warn('git wrapper preDirty over entry cap — degrading to empty set (over-report)', {
        worktreePath,
        entries: paths.length,
        cap: GIT_PRE_DIRTY_MAX_ENTRIES,
      })
      return {}
    }
    const hashes = await gitBlobHashes(worktreePath, paths)
    const bytes = new TextEncoder().encode(JSON.stringify(hashes)).byteLength
    if (bytes > GIT_PRE_DIRTY_MAX_JSON_BYTES) {
      log.warn('git wrapper preDirty over JSON-size cap — degrading to empty set (over-report)', {
        worktreePath,
        bytes,
        cap: GIT_PRE_DIRTY_MAX_JSON_BYTES,
      })
      return {}
    }
    return hashes
  } catch (err) {
    log.warn('git wrapper preDirty capture failed — degrading to empty set (over-report)', {
      worktreePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/**
 * RFC-130 T11 — create (fresh mint) or rebuild (resume) the wrapper-canonical iso
 * for a wrapper node. Fresh: snapshot the task canonical into an iso worktree keyed
 * by the wrapper's run id + persist its base. Resume: rebuild the handle pointing at
 * the SAME worktree (kept across a park — carrying the inner scope's accumulated
 * changes — so it must NOT be recreated). A non-git task worktree (mock harness)
 * yields a passthrough handle (the wrapper runs directly on the task canonical).
 */
/**
 * RFC-144 (PR-5 review P2) — wrapper outputs are written onto the wrapper's
 * OWN row, and wrapper rows are multi-generation (same-row revival after a
 * merged/conflict-human prior generation). The prior generation may have
 * already written its output rows before its merge-back crashed/parked, so a
 * plain INSERT would violate the (node_run_id, port_name) PK on the rerun.
 * Upsert: the new generation's content REPLACES the stale one (mirrors the
 * runner's same-session envelope upsert, runner.ts).
 */
async function upsertWrapperOutput(
  db: DbClient,
  wrapperRunId: string,
  portName: string,
  content: string,
): Promise<void> {
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: wrapperRunId, portName, content })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { content },
    })
}

export async function createOrRebuildWrapperIso(
  state: SchedulerState,
  wrapperRunId: string,
  existing: {
    isoBaseSnapshot: string | null
    isoBaseSnapshotReposJson: string | null
  } | null,
): Promise<IsoHandle> {
  const { db, task, taskId } = state
  // RFC-144 (Codex impl-gate P2) — same-row wrapper revival: a revived wrapper
  // row may arrive with a SETTLED prior generation ('merged': crash inside
  // mergeBackWrapperIso got its pending-merge replayed at entry;
  // 'conflict-human': canceled while parked). This run opens a NEW isolation
  // generation on the same row — re-enter 'isolating' so the strict machine's
  // mark-pending-merge (from=isolating) holds at the wrapper's merge-back.
  // isolating (mid-run revival, the common case) and NULL (fresh row /
  // passthrough) rows never emit this.
  const cur = (
    await db
      .select({ mergeState: nodeRuns.mergeState })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, wrapperRunId))
      .limit(1)
  )[0]
  let effectiveExisting = existing
  if (cur !== undefined && (cur.mergeState === 'merged' || cur.mergeState === 'conflict-human')) {
    if (cur.mergeState === 'merged') {
      // Impl-gate P2 second half: the prior generation's delta is ALREADY in
      // canonical — the new generation must branch from the CURRENT canonical,
      // NOT the stale gen-1 base. A three-way merge against the old base would
      // treat gen-1 files (now in canon) as `ours` additions and resurrect
      // content the new generation deleted.
      //
      // ORDER (impl-gate P2 rounds 3-5): the reenter CAS runs FIRST — it is the
      // ownership claim. A concurrent reviver that also read 'merged' loses the
      // CAS here and throws BEFORE any destructive cleanup (it can never remove
      // the winner's freshly-built iso). The CAS ATOMICALLY clears the base
      // columns + wrapperProgressJson, so a crash anywhere after it leaves an
      // isolating row with NULL base/progress — the next resume re-detects
      // "generation start" from durable state and the stale-iso cleanup below
      // (derived paths only, no column values needed) makes the re-create
      // idempotent. conflict-human re-entry keeps base + progress: its delta
      // never reached canonical (D27), so the old base/baseline stay the
      // correct merge/diff anchors.
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        extra: {
          isoWorktreePath: null,
          isoBaseSnapshot: null,
          isoBaseSnapshotReposJson: null,
          wrapperProgressJson: null,
        },
      })
      effectiveExisting = null
    } else {
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
      })
    }
  }
  if (effectiveExisting !== null) {
    const baseSnapshots: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (effectiveExisting.isoBaseSnapshot !== null) {
        baseSnapshots[''] = effectiveExisting.isoBaseSnapshot
      }
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(effectiveExisting.isoBaseSnapshotReposJson))
    }
    if (Object.keys(baseSnapshots).length > 0) {
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of state.repos) {
        taskBaseHeads[repo.worktreeDirName] = (
          await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
        ).stdout.trim()
      }
      return rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: wrapperRunId,
        canonRepos: state.repos,
        baseSnapshots,
        taskBaseHeads,
      })
    }
    // No persisted iso base (legacy / passthrough row) — fall through to create.
  }
  if (existing !== null) {
    // Reaching CREATE for a row that has lived before (merged re-entry, or a
    // crash inside a prior re-entry window that cleared the base columns): a
    // stale iso worktree may still sit at this wrapper's derived path, and
    // `git worktree add` fails LOUDLY on an existing dir — without cleanup the
    // task would wedge on every resume. discardNodeIso only needs the derived
    // paths + refs (base snapshot VALUES are unused for removal), so a handle
    // rebuilt with empty snapshot maps cleans up regardless of what the crash
    // left behind. Tolerant: nothing there → warn-and-continue.
    await discardNodeIso(
      rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: wrapperRunId,
        canonRepos: state.repos,
        baseSnapshots: {},
        taskBaseHeads: {},
      }),
      state.log,
    )
  }
  const handle = await createNodeIso({
    appHome: state.opts.appHome,
    taskId,
    nodeRunId: wrapperRunId,
    canonRepos: state.repos,
    log: state.log,
  })
  if (!handle.passthrough) await persistIsoBase(db, wrapperRunId, task.repoCount, handle)
  return handle
}

/**
 * RFC-130 T11 — merge a completed wrapper's total delta (its wrapper-canonical)
 * back into the parent (task) canonical as ONE unit, exactly like a node merge-back
 * (§6). Clean → merge_state='merged' (D15 lets downstream consume) + iso discarded;
 * conflict → merge agent, unresolved → the wrapper is parked conflict-human (iso
 * kept) — the caller returns awaiting_human; a merge-back error → merge-failed, the
 * caller fails the wrapper. Shared by the git + loop (+ fanout) wrappers so the
 * merge-back semantics can't fork.
 */
async function mergeBackWrapperIso(
  state: SchedulerState,
  wrapperIso: IsoHandle,
  wrapperRunId: string,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<
  // RFC-144 naming收敛: the parked-conflict variant is 'conflict-human' — same
  // vocabulary as the merge_state column and the node-path union above (the
  // old 'awaiting_human' kind said what the TASK would do, not what the row
  // is; callers translate conflict-human → awaiting_human scope outcome).
  | { kind: 'merged' }
  | { kind: 'conflict-human'; detail: string }
  | { kind: 'merge-failed'; msg: string }
> {
  const { db, task, taskId } = state
  try {
    const nodeTrees = await snapshotNodeIsoFinal(wrapperIso, log)
    await persistIsoNodeTree(db, wrapperRunId, task.repoCount, nodeTrees)
    const merge = await state.writeSem.run(async () => {
      const mr = await mergeBackNodeIso(wrapperIso, nodeTrees, log)
      if (mr.clean) return { kind: 'merged' as const }
      const res = await resolveMergeConflicts(state, {
        conflicts: mr.conflicts,
        containerPath: wrapperIso.containerPath,
        conflictNodeRunId: wrapperRunId,
        nodeId: node.id,
        iteration,
      })
      return res.allResolved
        ? { kind: 'merged' as const }
        : { kind: 'conflict-human' as const, detail: res.detail }
    })
    if (merge.kind !== 'merged') {
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'park-conflict-human', via: 'live' },
      })
      // D10: merge_state and status are two orthogonal machines — two CAS
      // writes, not one cross-machine tx; the frontier's done-branch bridges
      // the (rare) crash window between them.
      await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'park-human' } })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'awaiting_human')
      return { kind: 'conflict-human', detail: merge.detail }
    }
    await transitionMergeState({
      db,
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merged', via: 'live' },
    })
    await discardNodeIso(wrapperIso, log)
    return { kind: 'merged' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const flipped = await tryTransitionMergeState({
      db,
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merge-failed', reason: msg },
    })
    if (!flipped) {
      log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: wrapperRunId })
    }
    return { kind: 'merge-failed', msg }
  }
}

async function runGitWrapperNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId, definition } = state
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
  // RFC-098 B3 (audit S-4): the worktree's pre-existing dirty set, sampled at fresh
  // mint only — finalize subtracts hash-equal members so git_diff carries ONLY paths
  // this wrapper's inner scope produced/modified (fixes sequential-wrapper pollution
  // AND git-in-loop cumulative diffs). RFC-130 T11: baseline/preDirty are captured on
  // the WRAPPER-canonical (below), NOT the task canonical.
  let baseline: string | undefined
  let preDirty: Record<string, string> = {}
  // RFC-144 D13 second half (PR-4 review P2): a revived row whose prior
  // generation is 'merged' gets a FRESH wrapper-canonical from the CURRENT
  // task canonical (createOrRebuildWrapperIso replaces the iso). The persisted
  // baseline/preDirty belong to the OLD generation's canon — reusing them
  // would make the final gitChangedFiles report gen-1's already-merged files
  // in this generation's git_diff. Treat it as a fresh generation: skip the
  // persisted progress, recapture + re-persist on the new wrapper-canonical
  // below. (conflict-human / mid-run revival keep the S-4 never-recapture
  // rule — their iso and its inner writes are preserved.)
  // Crash durability (PR-5 review P2): the re-entry flip clears base cols +
  // progress ATOMICALLY, so a crash inside the re-entry window leaves an
  // isolating row with NULL base columns — the second disjunct re-detects it
  // as a generation start on the next resume (a genuine mid-generation row
  // always carries the base columns persistIsoBase stamped before any inner
  // work; passthrough rows have NULL merge_state and never match).
  const freshGeneration =
    existing !== null &&
    (existing.mergeState === 'merged' ||
      (existing.mergeState === 'isolating' &&
        existing.isoBaseSnapshot === null &&
        existing.isoBaseSnapshotReposJson === null))
  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, (msg) => log.warn(msg))
    wrapperRunId = existing.id
    if (!freshGeneration && progress?.kind === 'git' && typeof progress.baseline === 'string') {
      baseline = progress.baseline
      // S-4: resume reads the persisted pre-set; NEVER re-capture — the inner scope's
      // own writes are already in the (wrapper-)worktree.
      preDirty = progress.preDirty ?? {}
    }
    // Malformed / missing payload → baseline stays undefined → captured below on the
    // wrapper-canonical (pre-set stays empty, S-4 malformed fallback).
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
    // RFC-098 B3 (audit S-7, revision #6): resume does NOT overwrite the
    // wrapper's consumedUpstreamRunsJson — fresh-mint-only.
  } else {
    // RFC-098 B3 (audit S-7): external-upstream provenance at fresh mint
    // (mirrors the fanout wrapper, RFC-074 §8 D3) — an upstream rerun demotes
    // the done wrapper row to stale; the next dispatch mints a new generation
    // that re-captures baseline + pre-set below.
    const consumed = await computeWrapperConsumed(db, taskId, definition, node.id, iteration)
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration,
      overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
    })
    // RFC-098 B3 (audit S-28): mark-running before the broadcast and before
    // any reachable markWrapperTerminal (DB-first rule, lifecycle.ts).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    // baseline/preDirty captured below on the wrapper-canonical (after it exists).
  }

  // RFC-130 T11 (D29): wrapper-PRIVATE canonical. The wrapper's inner scope runs in
  // a `wrapper-canonical` — an iso worktree of the WRAPPER, branched from the task
  // canonical — so a sibling writer's merge-back into the TASK canonical cannot
  // pollute THIS wrapper's git_diff (AC-10). Inner nodes isolate FROM / merge-back
  // INTO the wrapper-canonical (their createNodeIso reads `innerState.repos`); the
  // wrapper's total delta merges back into the task canonical as ONE unit on done.
  // On a NON-git worktree (mock harness) createNodeIso returns passthrough → the
  // wrapper runs directly on the task canonical as pre-RFC-130 (diff + no merge-back).
  const wrapperIso = await createOrRebuildWrapperIso(state, wrapperRunId, existing)
  const wrapperCanonPath = wrapperIso.passthrough
    ? task.worktreePath
    : (wrapperIso.repos[0]?.isoWorktreePath ?? task.worktreePath)
  const innerState: SchedulerState = wrapperIso.passthrough
    ? state
    : {
        ...state,
        repos: wrapperIso.repos.map((r) => ({
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          baseBranch: r.baseBranch,
        })),
      }

  // RFC-130 T11 / §6.4: capture baseline (+ preDirty on fresh mint) on the WRAPPER-
  // canonical, NOT the task canonical. Critical for a git wrapper NESTED IN A LOOP:
  // the wrapper-canonical already carries the loop's prior-iteration writes as its
  // dirty-at-entry set, so preDirty subtracts them and each iteration's git_diff
  // stays that-round-only (per-iteration, §6.4/6.5) — diffing the task canonical
  // (which the loop hasn't merged into yet) would leave preDirty empty and wrongly
  // report the cumulative union. RFC-098 B1 (S-24): captured under the write lock.
  if (baseline === undefined) {
    // Establishing this generation's baseline. Two states land here, split by
    // a DURABLE discriminator (impl-gate P2 rounds 5-6):
    //
    // ① Generation start — fresh mint / merged re-entry / a crash after the
    //   re-entry cleared progress (even one landing after persistIsoBase
    //   re-stamped the base columns). Invariant: persistWrapperProgress runs
    //   strictly BEFORE runScope, and the ONLY writer that nulls it is the
    //   re-entry CAS — so `wrapperProgressJson IS NULL` ⟹ zero inner work in
    //   this generation. Capture preDirty (a git wrapper nested in a loop
    //   branches from the loop's DIRTY wrapper-canonical; skipping the pre-set
    //   would leak those entry-dirty files into git_diff) and persist
    //   immediately (durable for same-generation resumes).
    //
    // ② Malformed NON-NULL progress — mid-generation corruption; inner work
    //   may already sit in the wrapper worktree. Capturing preDirty here would
    //   hash-match those real inner changes and SWALLOW them from git_diff
    //   (under-report breaks downstream consumers). Keep the documented
    //   pre-RFC-144 fallback: empty pre-set (over-report, never drop) and no
    //   progress overwrite.
    const generationStart =
      existing === null || freshGeneration || existing.wrapperProgressJson === null
    const entry = await state.writeSem.run(async () => {
      const base = await captureHead(wrapperCanonPath)
      const pre = generationStart ? await captureGitPreDirty(wrapperCanonPath, base, log) : {}
      return { base, pre }
    })
    baseline = entry.base
    preDirty = entry.pre
    if (generationStart) {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'git',
        baseline,
        preDirty,
        phase: 'inner-running',
      })
    }
  }

  const subRes = await runScope(innerState, {
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
    // S-4: re-persist preDirty alongside the baseline — dropping it here
    // would make the post-park resume read an empty pre-set and regress to
    // the cumulative diff.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git',
      baseline,
      preDirty,
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
    //
    // RFC-098 B3 (audit S-4): subtract the PRE-EXISTING dirty set sampled at
    // fresh mint — a post path is dropped iff it was already dirty at entry
    // AND its current state matches the entry state (blob-hash equal, or both
    // 'deleted'). A pre-dirty file the inner scope rewrote keeps its place; a
    // touched-then-reverted one is subtracted (git-status-consistent). The
    // post hashes are sampled inside the SAME lock window as the path list.
    // Known open point (revision #9): a stale-redispatch generation inherits
    // the previous generation's residue as preDirty (wrapper re-run performs
    // no worktree rollback) — recorded in design/RFC-098 §B3.
    paths = await state.writeSem.run(async () => {
      // RFC-130 T11: diff the WRAPPER-canonical (isolated from sibling merge-backs),
      // not the task canonical — with passthrough this IS the task canonical.
      const all = await gitChangedFiles(wrapperCanonPath, baseline || 'HEAD')
      const candidates = all.filter((p) => preDirty[p] !== undefined)
      if (candidates.length === 0) return all
      const post = await gitBlobHashes(wrapperCanonPath, candidates)
      return all.filter((p) => preDirty[p] === undefined || post[p] !== preDirty[p])
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markWrapperTerminal(db, wrapperRunId, 'failed', `git-diff-failed:${msg}`)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return { kind: 'failed', summary: `git diff failed: ${msg}`, message: 'git-diff-failed' }
  }
  await upsertWrapperOutput(db, wrapperRunId, 'git_diff', paths.join('\n'))
  // RFC-130 T11: merge the wrapper's total delta (its wrapper-canonical) back into
  // the TASK canonical as ONE unit — the wrapper is isolated like a node. Clean →
  // materialized + merge_state='merged' (D15 lets downstream consume the git_diff);
  // conflict → merge agent (§6), unresolved → the wrapper parks conflict-human (iso
  // kept for the human); a merge-back error fails the wrapper loudly. Passthrough
  // wrappers already ran on the task canonical (nothing to merge, merge_state NULL).
  if (!wrapperIso.passthrough) {
    const mb = await mergeBackWrapperIso(state, wrapperIso, wrapperRunId, node, iteration, log)
    if (mb.kind === 'conflict-human') {
      // row parked conflict-human → the scope outcome is awaiting_human.
      return {
        kind: 'awaiting_human',
        summary: `wrapper merge conflict: ${mb.detail}`,
        message: 'merge-conflict',
      }
    }
    if (mb.kind === 'merge-failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `wrapper-merge-failed:${mb.msg}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper merge-back failed: ${mb.msg}`,
        message: 'wrapper-merge-failed',
      }
    }
  }
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

// RFC-098 WP-10 T-a: the old `insertNodeRun` half-factory was absorbed into
// the single mint factory — see services/nodeRunMint.ts (grep-guarded).

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
    // RFC-098 B3 (audit S-7): the two-phase picker body now lives in
    // freshness.ts (pickUpstreamSourceRun) so computeWrapperConsumed shares
    // the exact same口径 — behavior here is unchanged.
    const run = pickUpstreamSourceRun(rows, iteration)
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

// RFC-092 T2: `readSnapshotForLatestRun` was deleted (its `orderBy(desc(retryIndex))`
// was one of the audit S-13 freshest-row forks, ruled out in favor of id-order).
// RFC-130: the retry-rollback machinery it fed is itself GONE — a fresh-session
// retry now DISCARDS the failed iso and re-branches from the current canonical
// state (runOneNode); the canonical worktree is never dirtied, so there is nothing
// to roll back.

/**
 * RFC-119 / RFC-056: read a prior run's captured port outputs and render them in
 * the agent's declared-output order via the shared `buildPriorOutputBlock`.
 * Shared by the cross-clarify update-mode path AND the generalized rerun path.
 * `onlyPorts` (RFC-119 D10) restricts which declared ports render — review-iterate
 * passes the single iterate-target port so it doesn't duplicate RFC-014's
 * `## Sibling Outputs`; everything else passes undefined (all ports).
 */
export async function composePriorOutputBlock(
  db: DbClient,
  priorRunId: string,
  agentOutputs: readonly string[],
  onlyPorts?: ReadonlySet<string>,
): Promise<string> {
  const captured = await db
    .select()
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, priorRunId))
  const byPort = new Map(captured.map((r) => [r.portName, r.content]))
  const ordered = (agentOutputs ?? [])
    .filter((p) => onlyPorts === undefined || onlyPorts.has(p))
    .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
    .filter((o) => o.content.length > 0)
  return buildPriorOutputBlock(ordered)
}

/**
 * RFC-119: the freshest prior run of this node at the SAME (iteration, shardKey),
 * minted before this run (id < current), that captured at least one output row —
 * REGARDLESS of final status. Unlike `priorDoneGenerationsForRun` (deliberately
 * `done`-only, for the clarify generation count) this MUST also see
 * review-supersede `canceled` rows: review reject/iterate flips the prior `done`
 * row to `canceled` but keeps its node_run_outputs. node_run_outputs are written
 * only on a run that reached `done`, so "has an output row" == "this run produced
 * output at some point".
 *
 * RFC-119 multi-process (D9 revision): **parent-agnostic** — it deliberately does
 * NOT filter `parentNodeRunId === null`, so it ALSO matches fan-out children
 * across wrapper generations. The (nodeId, shardKey) tuple is what scopes the
 * lookup, and no node has both top-level AND child runs at the same
 * (nodeId, iteration, shardKey): a single-process agent node has only top-level
 * runs (so the dropped filter is a no-op there); a fan-out inner node has only
 * shard children (keyed by shardKey); a fan-out aggregator node has only
 * aggregator children (shardKey null). So id-order within (nodeId, iteration,
 * shardKey) uniquely identifies the freshest prior run for all three dispatch
 * sites (single-process / fan-out shard / fan-out aggregator).
 *
 * Candidate set is tiny (one node's attempts this iteration), so the per-row
 * existence probe is cheap; the freshest candidate normally hits on the first.
 */
export async function freshestPriorRunWithOutput(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
      ),
    )
  // shardKey filtered in memory (drizzle IS NULL handling varies; see
  // readPriorAgentSessionId). Walk freshest-first (largest id) and return the
  // first prior run (any parent — see doc) that captured output.
  const candidates = rows
    .filter((r) => (r.shardKey ?? null) === (run.shardKey ?? null) && r.id < run.id)
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
  for (const c of candidates) {
    const has = await db
      .select({ p: nodeRunOutputs.portName })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, c.id))
      .limit(1)
    if (has.length > 0) return c
  }
  return undefined
}

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
  const wrappers = def.nodes.filter((n) => isWrapperKind(n.kind))
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
          isWrapperKind(nodeById.get(id)!.kind) &&
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
