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

import { resolveRepositoryPublicationTransportFromKeyFile } from '@/modules/source-control/composition'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '@/services/fanout'
import type {
  Agent,
  FailureCode,
  MergeState,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WrapperFanoutPort,
} from '@agent-workflow/shared'
import {
  buildWorkflowScopeParentMap,
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  deriveWrapperFanoutOutputs,
  FANOUT_DONE_PORT_NAME,
  findFanoutAggregator,
  readContinueOnMaxIterations,
  resolveKeyOf,
  splitPortItems,
  stringifyKind,
  tryParseKind,
} from '@agent-workflow/shared'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
// RFC-253 — script node execution.
import { loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, taskRepos } from '@/db/schema'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { resolveInjection } from '@/services/execution/resolveInjection'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import {
  setNodeRunStatus,
  transitionMergeState,
  transitionNodeRunStatus,
  trySetTaskStatus,
  tryTransitionMergeState,
} from '@/services/lifecycle'
import { loadRunEnvelopeNonce, mintNodeRun, resolveFrozenRuntime } from '@/services/nodeRunMint'
import { fanoutInnerAgentRefKey, resolveNodeAgentRef } from '@/services/ref/runtimeRef'

import {
  taskStopProjection,
  type TaskStopCause,
} from '@/modules/task-execution/domain/sourceTermination'
import type { TaskExecutionContextRef } from '@/modules/task-execution/public/topology'
import {
  buildCommitAgent,
  buildCommitMessagePrompt,
  buildRepairPrompt,
  COMMIT_MESSAGE_PORT,
  commitPushNodeId,
} from '@/services/commitPush'
import { runCommitPush } from '@/services/commitPushRunner'
import { wrapperExternalUpstreamSources } from '@/services/dispatchFrontier'
import {
  consumedMapsEqual,
  isFresherNodeRun,
  parseConsumedJson,
  pickFreshestRun,
  pickReusableShardRun,
  pickUpstreamSourceRun,
} from '@/services/freshness'
import { forcedPortPathsForTask, toContainerRelative } from '@/services/portArtifacts'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { runNode, type RunResult } from '@/services/runner'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import {
  withCurrentTaskExecutionMutation,
  withTaskExecutionMutation,
} from '@/services/taskExecutionParticipants'
import {
  decodeWrapperProgress,
  encodeWrapperProgress,
  type WrapperProgress,
} from '@/services/wrapperProgress'
import { createLogger, type Logger } from '@/util/log'
import {
  DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
  DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
  FANOUT_HYDRATE_CALL_POLICY,
} from '@agent-workflow/shared'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import {
  completeHumanResolvedConflict,
  // snapshotNodeIsoFinal / mergeBackNodeIso remain imported for the WRAPPER
  // merge path only (mergeBackWrapperIso — outside RFC-188's agent-site
  // scope). Wrapper CREATE shares createIsoUnderLock with every AGENT site so
  // sibling `git worktree add` mutations cannot race in the common repository.
  discardNodeIso,
  mergeBackNodeIso,
  rebuildIsoHandle,
  snapshotNodeIsoFinal,
  undoPriorShardDeltaInIso,
  type IsoHandle,
} from '@/services/nodeIsolation'
import { gitBlobHashes, gitChangedFiles, runGit } from '@/util/git'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
import {
  createIsoUnderLock,
  markMergeFailed,
  mergeBackAndSettle,
  persistIsoBase,
  persistIsoNodeTree,
} from '@/services/isolatedAgentRun'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import {
  broadcastNodeStatus,
  composePriorOutputBlock,
  freezeBinaryConfig,
  freshestPriorRunWithOutput,
  isoKeyOf,
  parseIsoJsonMap,
  parseIsoSubmodules,
  pickString,
  readBindings,
  readPortRowAtIteration,
  resolveMergeConflicts,
  resolveUpstreamInputs,
  shouldRetryNodeFailure,
  type Binding,
  type OneNodeArgs,
  type OneNodeResult,
  type SchedulerState,
} from '@/modules/task-execution/composition/nodeMechanics'
import {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
  type SchedulerRuntimeTopology,
} from '@/modules/task-execution/public/topology'
import type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'
import { runAssembly, type IsoLike } from '@/services/schedulerAssembly'
import { sha256Hex } from '@/util/hash'
import { existsSync } from 'node:fs'
import { join as pathJoin } from 'node:path'

// Compatibility exports for the existing scheduler test contract. The owner is
// task-execution/public/topology; production consumers import that public surface.
export { INHERITABLE_RUN_CONFIG_KEYS, pickInheritableRunConfig }
export type InheritableRunConfig = ReturnType<typeof pickInheritableRunConfig>

export type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'

/** RFC-308: one immutable settings slice per commit/freeze operation. */
export function readCommitExcludePatterns(opts: RunTaskOptions): readonly string[] {
  if (opts.configPath !== undefined && opts.configPath !== '') {
    try {
      return [...loadConfig(opts.configPath).taskCommitExcludePatterns]
    } catch {
      // Launch-time snapshot is the safe fallback when a concurrent manual
      // edit leaves config temporarily unreadable.
    }
  }
  return [...(opts.commitPushExcludePatterns ?? [])]
}

// -----------------------------------------------------------------------------
// scope execution
// -----------------------------------------------------------------------------

// RFC-096: `isFresherNodeRun` moved to freshness.ts (the row-ordering
// authority lives with the freshness primitives now; audit S-13 / WP-3).
// Re-exported here so the six existing test files importing it from the
// scheduler keep working unchanged.
export { isFresherNodeRun } from '@/services/freshness'

// RFC-332 W2-B: DAG scope ownership moved to
// modules/task-execution/composition/taskDagScope.ts. W2-C/D mechanics below
// receive only the nested-scope capability carried by SchedulerState.
export async function inspectReadonlyRepos(state: SchedulerState, log: Logger): Promise<void> {
  for (const repo of state.repos) {
    if (!repo.readonly) continue
    const status = await runGit(repo.worktreePath, ['status', '--porcelain'])
    const changed = status.stdout.trim() === '' ? [] : status.stdout.trim().split('\n')
    withTaskExecutionMutation({
      db: state.db,
      taskId: state.task.id,
      run: (tx) =>
        tx
          .update(taskRepos)
          .set({ readonlyDirtyCount: changed.length })
          .where(and(eq(taskRepos.taskId, state.task.id), eq(taskRepos.repoIndex, repo.repoIndex)))
          .run(),
    })
    if (changed.length > 0) {
      log.warn('[rfc248/readonly-dirty] read-only repo was modified; NOT committed or pushed', {
        taskId: state.task.id,
        mountPath: repo.mountPath === '' ? '<root>' : repo.mountPath,
        changedCount: changed.length,
        changedSample: changed.slice(0, 20),
      })
    }
  }
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
export async function maybeRunCommitPush(
  state: SchedulerState,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<{ processUnreaped?: true }> {
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
    if (state.opts.signal?.aborted === true) return {}
    const status = await runGit(repo.worktreePath, ['status', '--porcelain'])
    // RFC-248 D11: 只读成员不参与自动提交推送。它被改动了不是「无事发生」——
    // 框架不在文件系统层面阻止写入，所以 agent 确实可能改了它。静默丢弃最难
    // 排查，故落一条任务级告警（不改任务状态：一个误建的临时文件不该搞垮整任务）。
    // RFC-248 D11: 只读成员不参与自动提交推送。脏检查本身**不在这里**做——
    // 它挂在任务终态收尾（`inspectReadonlyRepos`），否则默认关闭自动推送的
    // 任务永远不会被检查（实现门 P1）。
    if (repo.readonly) continue
    if (status.stdout.trim() === '') continue // nothing changed in this repo
    const repoSlug = repo.worktreeDirName
    const nodeId = commitPushNodeId(node.id, repoSlug || undefined)
    const baseRef = repo.baseBranch || task.baseBranch
    const repoName = repoSlug || repo.repoPath.split('/').pop() || 'repo'

    // Drive a commit-agent opencode session under the commit node_run id so the
    // detail-page "view session" button shows the message/repair conversation.
    const genViaOpencode = async (
      buildPrompt: (envelopeNonce: string) => string,
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
        const frozen = await resolveFrozenRuntime(
          db,
          sessionRunId,
          null,
          null,
          {
            protocol: rt.protocol,
            binary: rt.binaryPath,
            params: {
              model: rt.model,
              variant: rt.variant,
              temperature: rt.temperature,
              steps: rt.steps,
              maxSteps: rt.maxSteps,
              isSandbox: rt.isSandbox,
            },
            configDir: rt.configDir, // RFC-154: frozen with the rest of the snapshot
          },
          // Codex impl-gate P1-2: profile binaryPath NULL + config head set used
          // to reach this spawn via opts.opencodeCmd; fold it into the freeze.
          freezeBinaryConfig(state.opts.configPath),
        )
        const envelopeNonce = await loadRunEnvelopeNonce(db, sessionRunId)
        const commitAgent = buildCommitAgent()
        // RFC-282 B2 — the 6th/5th entries also go through the ONE resolver.
        // writeSem is held here: thread the scope signal (design §9-5).
        const commitInjection = await resolveInjection(db, commitAgent, {
          appHome: state.opts.appHome,
          log: log.child('commit'),
          ...(state.opts.signal ? { signal: state.opts.signal } : {}),
        })
        if (commitInjection.kind === 'failed') {
          throw new Error(`commit-push injection resolve failed: ${commitInjection.message}`)
        }
        const result = await runNode({
          taskId: task.id,
          nodeRunId: sessionRunId,
          nodeId,
          agent: commitAgent,
          triggerContext: null,
          expandPromptTemplate: false,
          runtime: frozen.protocol,
          runtimeBinary: frozen.binary,
          runtimeParams: frozen.params,
          runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
          inputs: {},
          worktreePath: repo.worktreePath,
          promptTemplate: buildPrompt(envelopeNonce),
          templateMeta: {
            repoPath: repo.repoPath,
            baseBranch: baseRef,
            taskId: task.id,
            nodeId,
            iteration,
            repos: state.repos,
            // RFC-248: `{{__repo_group__}}`；非组启动时不传 ⇒ 渲染空串。
            ...(state.repoGroupName !== null ? { repoGroupName: state.repoGroupName } : {}),
          },
          // RFC-282 B2 — resources derive from the synthetic agent's own
          // definition via the ONE resolver (was four hand-written empty
          // arrays: adding an MCP ref to the built-in agent silently did
          // nothing). Zero-resource today ⇒ identical spec; the regression
          // lock pins that resolveInjection stays ok for synthetic agents.
          skills: commitInjection.spec.skills,
          dependents: commitInjection.spec.dependents,
          mcps: commitInjection.spec.mcps,
          plugins: commitInjection.spec.plugins,
          appHome: state.opts.appHome,
          db,
          log: log.child('commit'),
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          ...(state.opts.binaryOverride ? { binaryOverride: state.opts.binaryOverride } : {}),
          ...(state.opts.signal ? { signal: state.opts.signal } : {}),
        })
        const msg = result.outputs[COMMIT_MESSAGE_PORT]
        return {
          message: msg !== undefined && msg.trim() !== '' ? msg : null,
          sessionId: result.sessionId ?? null,
          ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
        }
      } catch (err) {
        log.warn('commit-agent opencode run failed; will fall back', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { message: null, sessionId: null }
      }
    }

    const commitResult = await runCommitPush(
      {
        taskId: task.id,
        agentNodeId: node.id,
        agentName: agentLabel,
        parentNodeRunId,
        worktreePath: repo.worktreePath,
        repositoryIdentity: repo.repoPath,
        repoBranch: branch,
        baseRef,
        ...(repoSlug ? { repoSlug } : {}),
        ownerUserId: task.ownerUserId,
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        maxRepairRetries:
          state.opts.commitPushMaxRepairRetries ?? DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
        diffMaxBytes: state.opts.commitPushDiffMaxBytes ?? DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
        excludePatterns: readCommitExcludePatterns(state.opts),
        // RFC-076 C4: capture the staged snapshot only when no writer node is
        // mid-write. Writers hold this same Semaphore(1) for their whole run, so
        // under the race loop this serializes the commit's `git add` against
        // them — restoring the worktree quiescence the old batch barrier gave.
        acquireWrite: () => state.writeSem.acquire(),
        generateMessage: (mctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              buildCommitMessagePrompt(
                {
                  repoName,
                  branch,
                  baseRef,
                  stat: mctx.stat,
                  diffTruncated: mctx.diffTruncated,
                  // RFC-157: undefined ≡ en-US. Initial + repair share one language.
                  lang: state.opts.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            mctx,
          ),
        generateRepair: (rctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              buildRepairPrompt(
                {
                  branch,
                  pushStderr: rctx.pushStderr,
                  currentMessage: rctx.currentMessage,
                  stat: rctx.stat,
                  priorAttempts: rctx.priorAttempts,
                  lang: state.opts.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            rctx,
          ),
      },
      {
        db,
        log: log.child('commit'),
        publicationTransport:
          state.opts.repositoryPublicationTransport ??
          resolveRepositoryPublicationTransportFromKeyFile({
            db,
            appHome: state.opts.appHome,
          }),
      },
    )
    if (commitResult.processUnreaped === true) return { processUnreaped: true }
  }
  return {}
}

/**
 * RFC-210 fail-closed gate for replay: does any repo carry submodules while the
 * persisted topology for it is missing?
 *
 * Mirrors the existing `node_tree missing` refusal a few lines below — replaying
 * without the per-submodule merge bases is not a degraded merge, it is a merge
 * that silently drops work.
 */
function replaySubmodulesMissing(
  repos: ReadonlyArray<{ worktreePath: string; worktreeDirName: string }>,
  persisted: Record<string, { subBases: Record<string, string> }>,
): string | null {
  for (const repo of repos) {
    if (!existsSync(pathJoin(repo.worktreePath, '.gitmodules'))) continue
    const entry = persisted[repo.worktreeDirName]
    if (entry === undefined || Object.keys(entry.subBases).length === 0) {
      return repo.worktreeDirName || 'repo'
    }
  }
  return null
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
export async function replayPendingMerges(state: SchedulerState, log: Logger): Promise<void> {
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
    const submodules = parseIsoSubmodules(r, task.repoCount)
    const missingSub = replaySubmodulesMissing(state.repos, submodules)
    if (missingSub !== null) {
      throw new Error(
        `pending-merge replay: submodule topology missing for repo '${missingSub}' of run ${r.id}`,
      )
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      // Round 6 P2: the PHYSICAL iso identity — a process-retry keeps the
      // worktree + ref namespace keyed by the ORIGINAL row id (D17) while
      // pending-merge lands on the retry row; rebuild from the persisted
      // path so discard/refs address what actually exists.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      submodules,
      // RFC-193 K1: the replay's merge-back re-snapshots canonical (ours) —
      // it must keep force-including the task's gitignored port files.
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
    })
    // RFC-188: the ONE merge-back assembly — replay passes the PERSISTED node
    // trees (the iso worktree may be gone; the agent is never re-run) so the
    // snapshot phase is skipped. RFC-130 §6.2: a crash-recovered pending-merge
    // that now conflicts goes through the SAME merge agent as a live dispatch;
    // unresolved → conflict-human (resume replay #2 completes the human fix).
    const merge = await mergeBackAndSettle({
      db,
      writeSem: state.writeSem,
      handle,
      nodeRunId: r.id,
      repoCount: task.repoCount,
      nodeTrees,
      via: 'replay',
      conflictResolver: (conflicts, containerPath) =>
        resolveMergeConflicts(state, {
          conflicts,
          containerPath,
          conflictNodeRunId: r.id,
          nodeId: r.nodeId,
          iteration: r.iteration,
        }),
      log,
    })
    if (merge.kind === 'merged') {
      log.info('pending-merge replay merged', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): a replayed merge never passes a live
      // site's discard — without this the node-scoped pool refs leak forever
      // and a NEW path's worktree anchor is never handed over. Best-effort:
      // the iso worktree is usually already gone (that is why we replayed).
      await discardNodeIso(handle, log, state.writeSem)
    } else {
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
export async function replayConflictHumanResolutions(
  state: SchedulerState,
  log: Logger,
): Promise<void> {
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
      // Round 6 P2 (same as replayPendingMerges): rebuild the PHYSICAL iso
      // identity from the persisted path — this is also what makes the
      // resolve-iso lookup inside completeHumanResolvedConflict hit the
      // container a process-retry actually used.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
      // RFC-210: the human-resolve completion re-merges, so it needs the same
      // per-submodule bases the original merge-back had.
      submodules: parseIsoSubmodules(r, task.repoCount),
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
      // RFC-210 (review round 5, P2): the park kept the iso for the human;
      // now that the resolution landed, close its lifecycle — anchor handoff
      // for NEW paths + node pool ref cleanup happen inside the discard.
      await discardNodeIso(handle, log, state.writeSem)
    } else {
      log.info('conflict-human resume: still unresolved — staying parked', {
        nodeRunId: r.id,
        repos: outcome.unresolvedRepos,
      })
    }
  }
}

export function runWrapperGitNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  return runWrapperNode(state, args, runGitWrapperNode)
}

export function runWrapperLoopNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  return runWrapperNode(state, args, runLoopWrapperNode)
}

export function runWrapperFanoutNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  return runWrapperNode(state, args, runFanoutWrapperNode)
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
  withCurrentTaskExecutionMutation({
    db,
    run: (tx) =>
      tx
        .update(nodeRuns)
        .set({ wrapperProgressJson: encodeWrapperProgress(progress) })
        .where(eq(nodeRuns.id, wrapperRunId))
        .run(),
  })
}

/**
 * RFC-230 PR-2 — 三个 wrapper 分派点的共同外壳：把 `WrapperSupersededSignal`
 * 收敛成 scope 结果。放在这一个位置而不是 15 个 markWrapperTerminal 调用点各判
 * 一次，是为了让「收尾撞上外部终态」只有一条出口，漏改一个分支不可能发生。
 */
async function runWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
  run: (state: SchedulerState, args: OneNodeArgs) => Promise<OneNodeResult>,
): Promise<OneNodeResult> {
  try {
    return await run(state, args)
  } catch (err) {
    if (err instanceof WrapperSupersededSignal) return err.outcome
    throw err
  }
}

/**
 * RFC-230 PR-2 — wrapper 收尾时发现自己那行已被外部**合法**终态抢先（用户取消 /
 * 诊断修复 / 孤儿回收）时抛出的信号。在 wrapper 分派点（runWrapperNode）统一转成
 * scope 结果，而不是让 ConflictError 一路冒泡成任务级 `scheduler error` —— 那条
 * 报错说的是「两个写者对同一行的真相不一致」，但取消与修复本来就有权先落定，
 * 真相并不冲突，冲突的是收尾逻辑假设自己是唯一写者。
 *
 * 只有 canceled / interrupted 走这条路。其余非法转移（例如已 done 又要写 failed）
 * 仍然大声抛出：那才是真正的数据不一致，不能被收敛掩盖。
 */
class WrapperSupersededSignal extends Error {
  constructor(readonly outcome: OneNodeResult) {
    super(outcome.message)
    this.name = 'WrapperSupersededSignal'
  }
}

/**
 * 只有这两类错误可能是「别人合法地先落定了这一行」：
 *   - `illegal-node-run-transition` —— 读到的当前状态已是终态，守卫拒写；
 *   - `concurrent-node-run-transition` —— 读到非终态但 CAS 被人抢走。
 * DB 故障、NotFound、以及任何别的异常都不属于这一类，必须原样抛。
 */
function isSupersedableTransitionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'illegal-node-run-transition' || code === 'concurrent-node-run-transition'
}

/** 外部抢先的终态 → 本 scope 应当收敛到的结果；不是可收敛的终态则 null（原样抛）。 */
async function supersedingWrapperOutcome(
  db: DbClient,
  wrapperRunId: string,
): Promise<OneNodeResult | null> {
  const [cur] = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  if (cur === undefined) return null
  if (cur.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'wrapper canceled while finalizing',
      message: 'wrapper-superseded-canceled',
    }
  }
  if (cur.status === 'interrupted') {
    // interrupted 是可 resume 的终态；任务收在 failed（同样可 resume），而不是
    // 假装成功 done —— 后者会让一段被外部打断的工作以绿色收场。
    return {
      kind: 'failed',
      summary: 'wrapper interrupted while finalizing',
      message: 'wrapper-superseded-interrupted',
    }
  }
  return null
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
  try {
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
  } catch (err) {
    // RFC-230 PR-2: 外部终态抢先 → 收敛。
    //
    // 只认这两类错误（Codex 设计门 P2-3）：终态守卫拒写、以及 CAS 丢失。
    // 捕获**任意**异常然后「重读一眼状态恰好是终态就收敛」，会在底层 DB 故障 /
    // NotFound 时把原始错误吞掉——那是把两种完全不同的失败混成一种。
    if (!isSupersedableTransitionError(err)) throw err
    const outcome = await supersedingWrapperOutcome(db, wrapperRunId)
    if (outcome === null) throw err
    // 先清 reuseDisabled 再抛信号：那个 flag 留着会永久禁掉这条 resume 血脉的
    // done-shard 复用。
    await clearWrapperReuseDisabled(db, wrapperRunId)
    createLogger('scheduler').info('wrapper finalize superseded by external terminal state', {
      wrapperRunId,
      attempted: status,
      outcome: outcome.message,
    })
    throw new WrapperSupersededSignal(outcome)
  }
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
  await clearWrapperReuseDisabled(db, wrapperRunId)
}

/** 见上：终态到达后必须剥掉 fanout 的 `reuseDisabled` 闸门，其余 payload 留作面包屑。 */
async function clearWrapperReuseDisabled(db: DbClient, wrapperRunId: string): Promise<void> {
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

type LoopCompletionReason = 'exit-condition' | 'max-iterations-continued'

/**
 * RFC-236: both loop success policies share one completion path. In particular,
 * reaching the iteration limit with continueOnMaxIterations=true must promote
 * the same content/kind/archive row and merge the same loop-private canonical
 * as an ordinary exit-condition success.
 */
async function completeLoopWrapperIteration(args: {
  state: SchedulerState
  node: WorkflowNode
  wrapperRunId: string
  wrapperIso: IsoHandle
  bindings: readonly Binding[]
  iteration: number
  maxIterations: number
  reason: LoopCompletionReason
  log: Logger
}): Promise<OneNodeResult> {
  const { state, node, wrapperRunId, wrapperIso, bindings, iteration, maxIterations, reason, log } =
    args
  const { db, taskId } = state

  for (const binding of bindings) {
    const value = await readPortRowAtIteration(
      db,
      taskId,
      binding.bind.nodeId,
      binding.bind.portName,
      iteration,
    )
    await upsertWrapperOutput(
      db,
      wrapperRunId,
      binding.name,
      value.content,
      value.kind,
      value.archiveJson,
      // RFC-306 D9: inheritance across the loop boundary.
      value.active,
    )
  }

  // RFC-130 T12: merge the loop's total (all-iterations) delta back into the
  // task canonical as one unit for both ordinary and policy-controlled success.
  if (!wrapperIso.passthrough) {
    const merge = await mergeBackWrapperIso(state, wrapperIso, wrapperRunId, node, iteration, log)
    if (merge.kind === 'conflict-human') {
      return {
        kind: 'awaiting_human',
        summary: `loop merge conflict: ${merge.detail}`,
        message: 'merge-conflict',
      }
    }
    if (merge.kind === 'merge-failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `wrapper-merge-failed:${merge.msg}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `loop merge-back failed: ${merge.msg}`,
        message: 'wrapper-merge-failed',
      }
    }
  }

  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  if (reason === 'max-iterations-continued') {
    log.warn('wrapper-loop reached max iterations and continued by policy', {
      code: 'wrapper-loop-max-iterations-continued',
      taskId,
      nodeId: node.id,
      wrapperRunId,
      iteration,
      maxIterations,
    })
  }
  return { kind: 'ok', summary: '', message: '' }
}

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
  const continueOnMaxIterations = readContinueOnMaxIterations(node)
  if (continueOnMaxIterations === null) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} continueOnMaxIterations must be a boolean`,
      message: 'wrapper-loop-continue-on-max-iterations',
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
        repos: wrapperIso.repos.map((r, i) => ({
          // iso 仓按下标与 canonical 对齐，repoIndex 直接沿用。
          repoIndex: i,
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          // RFC-248: iso 仓由 `canonRepos: state.repos` 派生，**按下标对齐**，
          // 所以挂载路径与只读标记要从 state 那侧取真值——iso 句柄本身只带
          // worktreeDirName，用它当 mountPath 在组任务里就丢了嵌套信息。
          mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
          readonly: state.repos[i]?.readonly ?? false,
          baseBranch: r.baseBranch,
          // RFC-187 §4 — a wrapper-iso repo's base is the commit it forked from.
          baseCommit: r.baseSnapshot,
        })),
        // RFC-193 D9: inner nodes' scope canonical is the loop-canonical
        // container (== repos[0] iso root when single-repo, dirName='').
        scopeRoot: wrapperIso.containerPath,
      }

  const innerSet = new Set(inner)
  for (let i = startIter; i < maxIter; i++) {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'inner-running',
    })

    const subRes = await state.driveScope(innerState, {
      scopeId: node.id,
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
    // RFC-306: the exit rule now sees ACTIVATION as well as content, so a loop
    // can exit on "the body closed this branch" (`port-inactive`) instead of
    // having to encode that as an empty string.
    const portRow = await readPortRowAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, { content: portRow.content, active: portRow.active })) {
      return completeLoopWrapperIteration({
        state,
        node,
        wrapperRunId,
        wrapperIso,
        bindings,
        iteration: i,
        maxIterations: maxIter,
        reason: 'exit-condition',
        log,
      })
    }
  }

  if (continueOnMaxIterations) {
    return completeLoopWrapperIteration({
      state,
      node,
      wrapperRunId,
      wrapperIso,
      bindings,
      iteration: maxIter - 1,
      maxIterations: maxIter,
      reason: 'max-iterations-continued',
      log,
    })
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

/**
 * RFC-223 (PR-3a impl-gate H2): the CANONICAL dedup / lookup key for a
 * wrapper-fanout inner agent node — its stamped `agentId`. Used by BOTH the
 * inner-agent-map hydration and per-shard dispatch. A name-only node returns
 * null and fails closed.
 */
export function fanoutInnerAgentKey(node: {
  agentId?: unknown
  agentName?: unknown
}): string | null {
  // RFC-271 T6d：判据收到 `services/ref/runtimeRef.ts` 的单一读取点。
  // 语义与返回值逐字不变——name-only 节点仍返回 null 并 fail closed。
  return fanoutInnerAgentRefKey(node)
}

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
  // RFC-223 (PR-2/PR-3a impl-gate H2): resolve + dedup + key each inner agent by
  // its CANONICAL identity — the required agentId (rename-/ABA-safe). The old
  // dedup keyed by NAME (`agentsMap.has(an)`), which collapsed two same-name
  // DIFFERENT-id inner nodes into one — the second was skipped and both then
  // dispatched under the FIRST node's agent. Keying dedup + the map entry by the
  // canonical key keeps distinct-id inner nodes distinct; the shared
  // `resolveNodeAgent` (findFanoutAggregator / scope) and the per-shard dispatch
  // below both look up by that same key.
  const agentsMap = new Map<string, Agent>()
  for (const id of innerIds) {
    const inner = definition.nodes.find((n) => n.id === id)
    if (inner === undefined) continue
    const rec = inner as Record<string, unknown>
    // RFC-271 T6d：此处原本内联重算了一遍与 `fanoutInnerAgentKey` 完全相同的判据
    // （紧接着的下一行又调了它），现在只留一次。
    const dedupKey = fanoutInnerAgentKey(rec)
    if (dedupKey === null || agentsMap.has(dedupKey)) continue
    // ⚠️ 归属：hydration **静默跳过**缺失/查不到的 ref（FANOUT_HYDRATE_CALL_POLICY），
    // 与主派发的「节点失败」不同——这是实测差异，不是笔误。
    const resolved = await resolveNodeAgentRef(db, rec, FANOUT_HYDRATE_CALL_POLICY)
    if (resolved.ok) agentsMap.set(dedupKey, resolved.value)
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
    definition,
    state.containerOf,
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
  withTaskExecutionMutation({
    db,
    taskId,
    run: (tx) =>
      tx
        .update(nodeRuns)
        .set({ consumedUpstreamRunsJson: JSON.stringify(wrapperConsumed) })
        .where(eq(nodeRuns.id, wrapperRunId))
        .run(),
  })

  // 5. Derive wrapper outlets (aggregator outputs OR __done__ signal).
  const derivedOutputs = deriveWrapperFanoutOutputs(definition, node.id, agentsMap)

  // 6. Empty source: short-circuit done with empty outlets.
  // RFC-103 T4 (05-PORT-06/07): split via the single-source listWire codec,
  // kind-aware — `list<markdown>` items are inline multi-line bodies framed by
  // MARKDOWN_DOC_BOUNDARY; `list<path<md>>` / `list<string>` are one-per-line.
  // Hand-rolling `.split('\n')` here shredded each markdown document per line.
  // RFC-317 T57（findings NK-01）—— codec 选择收进 handler（`splitPortItems`）。
  // 这里的分支本身是对的，但它是**第三份**独立判据：另两处（list.ts 的 validate、
  // portArtifacts）当时忘了分支，于是同一份内容落库时按行切、分片时按边界行切。
  // 走同一个入口之后，"这个 kind 怎么切" 只有一个答案。
  const items = splitPortItems(itemKind, rawContent)
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

    const innerRec = inner as Record<string, unknown>
    const innerAgentName =
      typeof innerRec.agentName === 'string' ? innerRec.agentName : `node:${innerId}`
    const innerAgentId = fanoutInnerAgentKey(innerRec)
    if (innerAgentId === null) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-missing-agentId:${innerId}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner '${innerId}' missing canonical agentId`,
        message: 'wrapper-fanout-inner-missing-agent-id',
      }
    }
    const innerAgent = agentsMap.get(innerAgentId)
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
      definition,
      state.containerOf,
    )
    // Boundary inputs are structural mirrors and are deliberately excluded
    // from resolveUpstreamInputs. Inject every non-shard wrapper input as a
    // broadcast value here; dispatchFanoutShard replaces only the shard-source
    // target with the current item. This lets one per-shard node receive both
    // its item and shared context through explicit wrapper boundaries.
    for (const edge of boundaryEdges) {
      if (edge.source.portName === shardPort.name) continue
      const value = upstreamInputs[edge.source.portName] ?? ''
      const prior = innerUpstream[edge.target.portName]
      innerUpstream[edge.target.portName] =
        prior === undefined ? value : `${prior}\n\n---\n\n${value}`
    }

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
      // RFC-193 D16: the aggregator run's row carries kind+archive reference
      // (runner wrote them) — the outlet projection must not drop them. The
      // aggregator run is a CHILD row (parentNodeRunId = wrapperRunId), so a
      // topLevelOnly picker never sees it (Codex impl-gate P1): read the exact
      // run the dispatch returned.
      const aggRows =
        aggRes.aggRunId !== undefined
          ? await db
              .select()
              .from(nodeRunOutputs)
              .where(
                and(
                  eq(nodeRunOutputs.nodeRunId, aggRes.aggRunId),
                  eq(nodeRunOutputs.portName, port),
                ),
              )
          : []
      const row = aggRows[0]
      // RFC-306 D9 (design-gate P1#5): the aggregator may itself declare a branch
      // port — that is how a decision made INSIDE a fanout leaves the wrapper.
      // Dropping `active` here silently re-opened the branch at the boundary, so
      // downstream ran with the aggregator's reason text as its input.
      await upsertWrapperOutput(
        db,
        wrapperRunId,
        outletName,
        content,
        row?.kind ?? null,
        row !== undefined && row.content === content ? (row.archiveJson ?? null) : null,
        row?.active !== false,
      )
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
 * pickReusableShardRun match. sha256Hex（@/util/hash）precedent: util/git.ts 同款单步 hash 收口。
 */

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
  /**
   * Internal process-retry attempt. When present, dispatch must mint a fresh
   * child row instead of replaying/resetting the failed same-generation row.
   */
  processRetryIndex?: number
  log: Logger
}

interface DispatchShardResult {
  kind: 'ok' | 'failed' | 'canceled'
  shardKey: string
  outputs: Record<string, string>
  message: string
  /** Present only when the failed attempt may consume process-retry budget. */
  retry?: {
    retryIndex: number
    failureCode: FailureCode | null
    processUnreaped?: true
  }
}

/**
 * Dispatch one agent-single inner node for one shard (or shared/broadcast
 * mode when `shard === null`). Mints a node_run row with shardKey +
 * parentNodeRunId=wrapperRunId, runs `runNode`, persists outputs.
 *
 * v1 limitations (PR-D2 will extend):
 *   - No clarify / review channel — the channel hooks are wired in by the
 *     task-execution agent lane; bringing that whole lane
 *     in here would duplicate ~500 lines. PR-D2's per-shard review (D.T4)
 *     and per-shard clarify (D.T5) will add the corresponding hand-offs.
 *   - No clarify / review channel. Process failures consume the same global
 *     retry budget as a top-level agent node; envelope follow-up remains a
 *     top-level-only optimization because fanout retries use fresh sessions.
 *     After retries, the wrapper keeps FAIL-ALL-AFTER-JOIN semantics
 *     (RFC-094 / audit S-18): every shard runs to completion, then ANY failed
 *     shard fails the whole wrapper and skips aggregation.
 */
async function dispatchFanoutShard(args: DispatchShardArgs): Promise<DispatchShardResult> {
  const maxRetries = args.state.opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  let attemptArgs = args
  for (let retriesUsed = 0; ; retriesUsed++) {
    const result = await dispatchFanoutShardAttempt(attemptArgs)
    if (
      result.kind !== 'failed' ||
      result.retry === undefined ||
      retriesUsed >= maxRetries ||
      !shouldRetryNodeFailure(result.retry.failureCode, result.retry.processUnreaped === true)
    ) {
      return result
    }
    attemptArgs = {
      ...args,
      reuseDisabled: true,
      processRetryIndex: result.retry.retryIndex + 1,
    }
  }
}

async function dispatchFanoutShardAttempt(args: DispatchShardArgs): Promise<DispatchShardResult> {
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
  // / buildFreshestSettledPerNode / pickFreshestRun all skip child rows) AND
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
  const forcedProcessRetry = args.processRetryIndex !== undefined
  const reusable =
    args.reuseDisabled || forcedProcessRetry
      ? undefined
      : pickReusableShardRun(candidates, { shardKey: rowShardKey, valueHash })
  let shardRunId: string
  let shardRetryIndex: number
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
  if (
    !forcedProcessRetry &&
    freshest !== undefined &&
    reusable !== undefined &&
    reusable.id === freshest.id
  ) {
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
    !forcedProcessRetry &&
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
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({ shardValueHash: valueHash })
          .where(eq(nodeRuns.id, shardRunId))
          .run(),
    })
    shardRetryIndex = freshest.retryIndex
  } else {
    // Branch 3 — mint a fresh row under this wrapper. The T14 replacement target
    // (priorShardUndo) was already derived above from the latest done+merged
    // candidate and is applied at merge-back.
    shardRunId = await mintNodeRun(db, {
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-shard',
      retryIndex: args.processRetryIndex ?? 0,
      iteration,
      overrides: {
        parentNodeRunId: wrapperRunId,
        shardKey: rowShardKey,
        shardValueHash: valueHash,
      },
    })
    shardRetryIndex = args.processRetryIndex ?? 0
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

  const injection = await resolveInjection(db, innerAgent, { appHome: opts.appHome, log })
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
  // RFC-287 T4：分片线改走骨架。与聚合线逐相位同构，多出的只有 T14 的
  // 「在新隔离树里先撤销上一次已合并的增量」——正落在 beforeSpawn 钩子上：
  // 它逐仓自兜（失败只记 warn 退回叠加，绝不让一个本来好好的分片失败），整体
  // 又在 iso 物化的同一个 try 内，所以未兜住的抛出走 onIsoSetupFailure，形态
  // 与现状一致（design §10.2 的 beforeSpawn 契约就是为它写的）。
  let shardIso: IsoHandle | null = null
  return await runAssembly<Record<string, never>, RunResult, DispatchShardResult>(
    {},
    {
      pools: [state.agentSem, state.subprocessSem],
      iso: {
        create: async () => {
          shardIso = await createIsoUnderLock({
            writeSem: state.writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId: shardRunId,
            canonRepos: state.repos,
            log,
          })
          return shardIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(db, shardRunId, task.repoCount, shardIso as IsoHandle)
        },
      },
      beforeSpawn: async () => {
        const iso = shardIso as IsoHandle
        if (priorShardUndo !== null && !iso.passthrough) {
          for (const r of iso.repos) {
            try {
              await undoPriorShardDeltaInIso(
                r.isoWorktreePath,
                priorShardUndo.node[r.worktreeDirName],
                priorShardUndo.base[r.worktreeDirName],
                log,
                r.forcedRepoRelPaths,
              )
            } catch (err) {
              log.warn('T14 iso-undo failed — superimposition fallback', {
                shardKey,
                worktreeDirName: r.worktreeDirName,
                mountPath: r.worktreeDirName,
                subdir: '',
                readonly: false,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
      },
      onIsoSetupFailure: (err) => {
        log.warn('fanout shard iso setup failed', {
          shardKey,
          error: err instanceof Error ? err.message : String(err),
        })
        return { kind: 'failed', shardKey, outputs: {}, message: 'iso-setup-failed' }
      },
      spawn: async () => {
        // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the fanout shard
        // so a claude-selected agent-multi dispatches its shards on claude, not opencode.
        const shardRuntime = await resolveFrozenRuntime(
          db,
          shardRunId,
          innerAgent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = shardIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: shardRunId,
          nodeId: innerNode.id,
          agent: innerAgent,
          triggerContext: state.triggerContext,
          runtime: shardRuntime.protocol,
          runtimeBinary: shardRuntime.binary,
          runtimeParams: shardRuntime.params,
          runtimeConfigDir: shardRuntime.configDir, // RFC-154: frozen config-dir profile
          inputs,
          // RFC-130 D16: cwd + path tokens → the shard's isolated worktree.
          worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
          // RFC-067: per-task Git identity threaded through fanout shard dispatch.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: innerNode.id,
            iteration,
            ...(shard !== null ? { shardKey } : {}),
            // RFC-066: per-repo metadata for prompt placeholders.
            repos: iso.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              mountPath: r.worktreeDirName,
              subdir: '',
              readonly: false,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          // PR-D2: per-shard clarify stays off — RFC-148 ADT form.
          clarifyChannel: { kind: 'none' as const },
          skills: injection.spec.skills,
          dependents: injection.spec.dependents,
          mcps: injection.spec.mcps,
          plugins: injection.spec.plugins,
          appHome: opts.appHome,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          ...(Object.keys(inputPortKinds).length > 0 ? { inputPortKinds } : {}),
          db,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        })
        broadcastNodeStatus(taskId, shardRunId, innerNode.id, result.status)
        return result
      },
      keepFromOutcome: (result) => result.processUnreaped === true,
      mergePhase: (_c, result) => {
        if (result.status !== 'done') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'failed' as const,
                shardKey,
                outputs: {},
                message: result.errorMessage ?? `shard-${result.status}`,
                ...(result.status === 'canceled'
                  ? {}
                  : {
                      retry: {
                        retryIndex: shardRetryIndex,
                        failureCode: result.failureCode ?? null,
                        ...(result.processUnreaped === true
                          ? { processUnreaped: true as const }
                          : {}),
                      },
                    }),
              }),
            },
          }
        }
        if ((shardIso as IsoHandle).passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async (_c, result) => {
          const iso = shardIso as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem: state.writeSem,
            handle: iso,
            nodeRunId: shardRunId,
            repoCount: task.repoCount,
            via: 'live',
            extraForcedContainerPaths: (result.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: shardRunId,
                nodeId: innerNode.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          // RFC-287 T14（用户拍板在本 RFC 内补掉的既存缺陷）：与 L1 同款，本线也
          // 许不起「留着给人解」的承诺——`keep: false` 意味着骨架随即丢弃 iso 并删
          // pin refs，而 `mergeBackAndSettle` **已经**把行落成了 conflict-human
          // （isolatedAgentRun.ts 的 park-conflict-human）。库里承诺「等待人工解决」、
          // 物理载体却没了，`replayConflictHumanResolutions` 又在每个任务的 runTask
          // 入口都跑，下次 resume 就会去找已 GC 的提交、抛错并打挂**整个任务**。
          //
          // 迁移前 fanout 两条线同样漏了这一步（63adfb66^ 的 7984/8411）——RFC-187
          // T8 当年只为工作组线修了，fanout 一直带病。这次一并补上：这份 delta 是
          // 真的被丢弃了，状态就该如实说 abandon。
          onConflictHuman: (detail) => ({
            keep: false,
            produce: async () => {
              await tryTransitionMergeState({
                db,
                nodeRunId: shardRunId,
                event: { kind: 'abandon', reason: 'fanout-shard-merge-conflict-unresolved' },
              })
              return {
                kind: 'failed' as const,
                shardKey,
                outputs: {},
                message: `merge-back-conflict (merge agent could not resolve): ${detail}`,
              }
            },
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, shardRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  shardKey,
                  outputs: {},
                  message: `merge-back-failed: ${msg}`,
                }
              },
            },
          }),
        },
      },
      onUnhandledThrow: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
        return {
          kind: 'failed',
          shardKey,
          outputs: {},
          message: msg,
          retry: { retryIndex: shardRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => discardNodeIso(h as IsoHandle, log, state.writeSem),
      settle: async (_c, result) => ({
        kind: 'ok',
        shardKey,
        outputs: result.outputs,
        message: '',
      }),
      log,
    },
  )
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
  /** Internal fresh-row process retry; see DispatchShardArgs.processRetryIndex. */
  processRetryIndex?: number
  log: Logger
}

type DispatchAggregatorResult = OneNodeResult & {
  outputs: Record<string, string>
  aggRunId?: string
  /** Present only when the failed attempt may consume process-retry budget. */
  retry?: {
    retryIndex: number
    failureCode: FailureCode | null
    processUnreaped?: true
  }
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
): Promise<DispatchAggregatorResult> {
  const maxRetries = args.state.opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  let attemptArgs = args
  for (let retriesUsed = 0; ; retriesUsed++) {
    const result = await dispatchFanoutAggregatorAttempt(attemptArgs)
    if (
      result.kind !== 'failed' ||
      result.retry === undefined ||
      retriesUsed >= maxRetries ||
      !shouldRetryNodeFailure(result.retry.failureCode, result.retry.processUnreaped === true)
    ) {
      return result
    }
    attemptArgs = {
      ...args,
      reuseDisabled: true,
      processRetryIndex: result.retry.retryIndex + 1,
    }
  }
}

async function dispatchFanoutAggregatorAttempt(
  args: DispatchAggregatorArgs,
): Promise<DispatchAggregatorResult> {
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
        // RFC-306 D13: only ACTIVE shards feed the aggregation. A shard that
        // closed this branch contributes nothing at all — not an empty `###`
        // block. Two reasons it must be absent rather than blank: the aggregator
        // prompt would otherwise carry N empty sections that read as "these
        // shards found nothing" (they were never asked), and the port's content
        // on an inactive port is the shard's REASON text, which would land in
        // the aggregate as if it were a finding.
        if (port !== undefined && port.active !== false) {
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
        // Same rule for a shared (broadcast) upstream — see above.
        if (port !== undefined && port.active !== false) blocks.push(port.content)
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
  const forcedProcessRetry = args.processRetryIndex !== undefined
  if (
    !forcedProcessRetry &&
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
    return { kind: 'ok', summary: '', message: '', outputs, aggRunId: freshestAgg.id }
  }
  let aggRunId: string
  let aggRetryIndex: number
  if (
    !forcedProcessRetry &&
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
    aggRetryIndex = freshestAgg.retryIndex
  } else {
    aggRunId = await mintNodeRun(db, {
      taskId,
      nodeId: aggNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-aggregator',
      retryIndex: args.processRetryIndex ?? 0,
      iteration,
      overrides: { parentNodeRunId: wrapperRunId },
    })
    aggRetryIndex = args.processRetryIndex ?? 0
  }
  broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'pending')

  const injection = await resolveInjection(db, aggAgent, { appHome: opts.appHome, log })
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
    const block = await composePriorOutputBlock(
      db,
      aggPriorRun.id,
      aggAgent.outputs ?? [],
      undefined,
      await loadRunEnvelopeNonce(db, aggRunId),
    )
    if (block.length > 0) aggPriorOutputUpdate = { block }
  }

  // RFC-130: the aggregator runs in its OWN isolated worktree too (it can write —
  // e.g. concatenate shard outputs into a file). Merge-back into canonical on
  // success; no whole-run writeSem.
  // RFC-287 T3：本线改走 `runAssembly` 骨架。相位与逐线声明一一对应，行为逐字保持：
  //   · 双许可（agent 池 + 本任务子进程池），释放逆序、finally 保证；
  //   · iso 物化 + 落基线同处一个 try（persistBase: 'in-setup'）——抛出即释放许可
  //     并返回结构化 iso-setup-failed（§10.10 按线声明，本线保持现状）；
  //   · processUnreaped ⇒ 保留 iso（§10.11 第五维，与合并处置正交）；
  //   · 非 done / passthrough 各自跳合并；撞冲突判失败且**不**保留（fail-all，
  //     C8 落地时改 abandon）；合并抛出保留 iso + 标记合并失败；
  //   · 线级 catch-all 带 retry 载荷（failureCode 为 null ⇒ 会重试到上限）。
  let aggIso: IsoHandle | null = null
  return await runAssembly<Record<string, never>, RunResult, DispatchAggregatorResult>(
    {},
    {
      pools: [state.agentSem, state.subprocessSem],
      iso: {
        create: async () => {
          aggIso = await createIsoUnderLock({
            writeSem: state.writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId: aggRunId,
            canonRepos: state.repos,
            log,
          })
          return aggIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(db, aggRunId, task.repoCount, aggIso as IsoHandle)
        },
      },
      onIsoSetupFailure: () => ({
        kind: 'failed',
        summary: 'aggregator iso setup failed',
        message: 'iso-setup-failed',
        outputs: {},
      }),
      spawn: async () => {
        // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the aggregator.
        const aggRuntime = await resolveFrozenRuntime(
          db,
          aggRunId,
          aggAgent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = aggIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: aggRunId,
          nodeId: aggNode.id,
          agent: aggAgent,
          triggerContext: state.triggerContext,
          runtime: aggRuntime.protocol,
          runtimeBinary: aggRuntime.binary,
          runtimeParams: aggRuntime.params,
          runtimeConfigDir: aggRuntime.configDir, // RFC-154: frozen config-dir profile
          inputs: aggInputs,
          worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
          // RFC-067: per-task Git identity threaded through fanout aggregator dispatch.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: aggNode.id,
            iteration,
            // RFC-066: per-repo metadata for prompt placeholders.
            repos: iso.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              mountPath: r.worktreeDirName,
              subdir: '',
              readonly: false,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          // RFC-119 multi-process: prior aggregated output on re-run (see above).
          ...(aggPriorOutputUpdate !== undefined
            ? { priorOutputUpdate: aggPriorOutputUpdate }
            : {}),
          clarifyChannel: { kind: 'none' as const }, // PR-D2
          skills: injection.spec.skills,
          dependents: injection.spec.dependents,
          mcps: injection.spec.mcps,
          plugins: injection.spec.plugins,
          appHome: opts.appHome,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          db,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        })
        broadcastNodeStatus(taskId, aggRunId, aggNode.id, result.status)
        return result
      },
      keepFromOutcome: (result) => result.processUnreaped === true,
      mergePhase: (_c, result) => {
        if (result.status !== 'done') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'failed' as const,
                summary: `aggregator ${aggNode.id} ${result.status}`,
                message: result.errorMessage ?? `aggregator-${result.status}`,
                outputs: {},
                ...(result.status === 'canceled'
                  ? {}
                  : {
                      retry: {
                        retryIndex: aggRetryIndex,
                        failureCode: result.failureCode ?? null,
                        ...(result.processUnreaped === true
                          ? { processUnreaped: true as const }
                          : {}),
                      },
                    }),
              }),
            },
          }
        }
        // RFC-130 §段③: merge the aggregator's iso delta back into canonical.
        if ((aggIso as IsoHandle).passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        // RFC-188: the ONE merge-back assembly. §6.3 disposition: unresolved →
        // conflict-human + fail loudly (per-node awaiting_human bubbling for
        // fanout is a follow-up, #4/PR-E); conflict never lost.
        run: async (_c, result) => {
          const iso = aggIso as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem: state.writeSem,
            handle: iso,
            nodeRunId: aggRunId,
            repoCount: task.repoCount,
            via: 'live',
            extraForcedContainerPaths: (result.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: aggRunId,
                nodeId: aggNode.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          // 与分片线同款、同理由（见那边的长注释）：keep:false 之后 iso 就没了，
          // 所以不能把行留在 conflict-human——否则下次 resume 找不到树，整任务打挂。
          onConflictHuman: (detail) => ({
            keep: false,
            produce: async () => {
              await tryTransitionMergeState({
                db,
                nodeRunId: aggRunId,
                event: { kind: 'abandon', reason: 'fanout-agg-merge-conflict-unresolved' },
              })
              return {
                kind: 'failed' as const,
                summary: 'aggregator merge conflict',
                message: `merge-back-conflict (merge agent could not resolve): ${detail}`,
                outputs: {},
              }
            },
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, aggRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  summary: 'aggregator merge failed',
                  message: `merge-back-failed: ${msg}`,
                  outputs: {},
                }
              },
            },
          }),
        },
      },
      onUnhandledThrow: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
        return {
          kind: 'failed',
          summary: 'aggregator threw',
          message: msg,
          outputs: {},
          retry: { retryIndex: aggRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => discardNodeIso(h as IsoHandle, log, state.writeSem),
      // Aggregator's outputs are already persisted by runner.ts (nodeRunOutputs
      // upsert at runner.ts §port-persist). The wrapper-row outlet copy is
      // handled by the caller (runFanoutWrapperNode after this returns).
      settle: async (_c, result) => ({
        kind: 'ok',
        summary: '',
        message: '',
        outputs: result.outputs,
        aggRunId,
      }),
      log,
    },
  )
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
  // RFC-193 D16: projections copy the source row's kind + archive reference
  // (synthesized outlets — __done__, git_diff — have no source row: NULL).
  kind: string | null = null,
  archiveJson: string | null = null,
  /**
   * RFC-306 D9 — whether the promoted outlet carries a value. A wrapper outlet
   * whose bound inner source sat on a closed branch is itself inactive, and that
   * is how a branch escapes a loop / fanout to the graph outside it. Defaults to
   * true so synthesized outlets (`__done__`, `git_diff`) and every existing
   * caller keep their current behavior.
   */
  active = true,
): Promise<void> {
  withCurrentTaskExecutionMutation({
    db,
    run: (tx) =>
      tx
        .insert(nodeRunOutputs)
        .values({ nodeRunId: wrapperRunId, portName, content, kind, archiveJson, active })
        .onConflictDoUpdate({
          target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
          set: { content, kind, archiveJson, active },
        })
        .run(),
  })
}

export async function createOrRebuildWrapperIso(
  state: SchedulerState,
  wrapperRunId: string,
  existing: {
    isoBaseSnapshot: string | null
    isoBaseSnapshotReposJson: string | null
    // RFC-210: the rebuilt wrapper iso merges back like any other node's, so the
    // caller must hand its persisted submodule topology through too.
    isoSubmodulesJson?: string | null
    isoSubmodulesReposJson?: string | null
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
        forcedContainerPaths: await forcedPortPathsForTask(state.db, taskId),
        // RFC-210: a rebuilt wrapper iso merges back like any other, so it
        // carries the same submodule topology. (The discard-only rebuild below
        // deliberately does not — it needs paths and refs, nothing else.)
        submodules: parseIsoSubmodules(
          {
            isoSubmodulesJson: effectiveExisting.isoSubmodulesJson ?? null,
            isoSubmodulesReposJson: effectiveExisting.isoSubmodulesReposJson ?? null,
          },
          task.repoCount,
        ),
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
      state.writeSem,
    )
  }
  // Wrapper-private canonicals and ordinary sibling agent isos mutate the same
  // repository's `.git/worktrees` registry. They MUST share the task write
  // semaphore; otherwise a top-level wrapper and a slow sibling can overlap
  // `git worktree add`, leaving a partially initialized registration whose
  // `commondir` cannot be read. Keep only the short create/snapshot window
  // locked — wrapper execution itself remains concurrent.
  const handle = await createIsoUnderLock({
    writeSem: state.writeSem,
    appHome: state.opts.appHome,
    taskId,
    isoKeyRunId: wrapperRunId,
    canonRepos: state.repos,
    db,
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
    // RFC-193 K1: re-aggregate at wrapper-final time — the wrapper handle is
    // the one LONG-LIVED handle (inner nodes archived new port files during
    // its lifetime; the create-time roster predates them, design §4.5).
    const nodeTrees = await snapshotNodeIsoFinal(
      wrapperIso,
      log,
      await forcedPortPathsForTask(db, taskId),
    )
    // RFC-210 impl-gate: the handle rides along so a topology the snapshot
    // extended (submodule added inside the wrapper) survives into crash replay.
    await persistIsoNodeTree(db, wrapperRunId, task.repoCount, nodeTrees, wrapperIso)
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
    await discardNodeIso(wrapperIso, log, state.writeSem)
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
  // RFC-248: `task` 曾用于 passthrough 时的 `task.worktreePath` 回落——那条回落
  // 现在由 `diffableRepos` 从 `state.repos` 直接取，不再需要它。
  const { db, taskId, definition } = state
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
  // RFC-248 D9: 多仓的逐仓形态（键 = 挂载路径，挂根为 ''）。上面两个标量继续
  // 承载 repos[0]，见 wrapperProgress.ts 上关于「为什么不翻新成 map-only」的说明。
  let baselines: Record<string, string> = {}
  let preDirtyByRepo: Record<string, Record<string, string>> = {}
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
      // RFC-248: 优先用逐仓 map；RFC-248 之前的 payload 只有标量，把它当作
      // `{ '': baseline }`——单仓的挂载路径正好就是空串，两种形态天然对齐，
      // 所以升级期间**跑在半路**的包裹器不会丢基线。
      baselines = progress.baselines ?? { '': progress.baseline }
      preDirtyByRepo = progress.preDirtyByRepo ?? { '': preDirty }
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
  // RFC-248 D9: 包裹器要逐仓取快照 / 逐仓 diff 的那批仓。
  // 这里原本先算一个 `wrapperCanonPath = wrapperIso.repos[0]?.isoWorktreePath`
  // 再对它单独取快照/做 diff——那正是 RFC-066 当年必须禁掉多仓 wrapper-git 的
  // 原因（只看得见第一个仓）。现在整块换成逐仓，那个变量随之删除。
  // - passthrough（mock 夹具 / 非 git 工作树）走 `state.repos`，与 pre-RFC-130 一致；
  // - 正常路径走 wrapper-iso 的 per-repo 句柄（与 state.repos 按下标对齐）。
  // **只读成员不参与**（D11：它的改动不进 git_diff、不被提交推送）。
  const diffableRepos: Array<{ path: string; mountPath: string }> = (
    wrapperIso.passthrough
      ? state.repos.map((r) => ({
          path: r.worktreePath,
          mountPath: r.mountPath,
          readonly: r.readonly,
        }))
      : wrapperIso.repos.map((r, i) => ({
          path: r.isoWorktreePath,
          mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
          readonly: state.repos[i]?.readonly ?? false,
        }))
  )
    .filter((r) => !r.readonly)
    .map((r) => ({ path: r.path, mountPath: r.mountPath }))
  // 标量兼容字段承载的那个仓：优先挂根的成员，否则第一个可 diff 的。
  const primaryMount = diffableRepos.some((r) => r.mountPath === '')
    ? ''
    : (diffableRepos[0]?.mountPath ?? '')
  const innerState: SchedulerState = wrapperIso.passthrough
    ? state
    : {
        ...state,
        repos: wrapperIso.repos.map((r, i) => ({
          repoIndex: i,
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          mountPath: r.worktreeDirName,
          subdir: '',
          readonly: false,
          baseBranch: r.baseBranch,
          // RFC-187 §4 — a wrapper-iso repo's base is the commit it forked from.
          baseCommit: r.baseSnapshot,
        })),
        // RFC-193 D9: inner nodes' scope canonical is the wrapper-canonical
        // container (== repos[0] iso root when single-repo, dirName='').
        scopeRoot: wrapperIso.containerPath,
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
    // RFC-248 D9: 逐仓捕获。只读成员不参与（D11——它的改动不进 git_diff）。
    const entry = await state.writeSem.run(async () => {
      const bases: Record<string, string> = {}
      const pres: Record<string, Record<string, string>> = {}
      for (const r of diffableRepos) {
        const b = await captureHead(r.path)
        bases[r.mountPath] = b
        pres[r.mountPath] = generationStart ? await captureGitPreDirty(r.path, b, log) : {}
      }
      return { bases, pres }
    })
    baselines = entry.bases
    preDirtyByRepo = entry.pres
    // 标量字段继续写 repos[0]，保住既有遥测与老 payload 的 resume（见
    // wrapperProgress.ts 上的说明）。
    baseline = baselines[primaryMount] ?? ''
    preDirty = preDirtyByRepo[primaryMount] ?? {}
    if (generationStart) {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'git',
        baseline,
        preDirty,
        baselines,
        preDirtyByRepo,
        phase: 'inner-running',
      })
    }
  }

  const subRes = await state.driveScope(innerState, {
    scopeId: node.id,
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
  // RFC-060 PR-E: git_diff outlet is now `list<path<*>>` (newline-joined file
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
      //
      // RFC-248 D9: 逐仓做，再把每个仓的路径用它的**挂载路径**前缀化后合并。
      // 端口契约仍是 `list<path<*>>`（`nodePorts.ts:188`）——不是拼接的完整
      // patch；下游 wrapper-fanout 直接把它当路径列表消费，前缀让分片天然带上
      // 仓归属、也让 agent `cd <前缀>` 就能到位。
      const out: string[] = []
      for (const r of diffableRepos) {
        const base = baselines[r.mountPath] ?? ''
        const pre = preDirtyByRepo[r.mountPath] ?? {}
        const all = await gitChangedFiles(r.path, base || 'HEAD')
        const candidates = all.filter((p) => pre[p] !== undefined)
        const kept =
          candidates.length === 0
            ? all
            : await (async () => {
                const post = await gitBlobHashes(r.path, candidates)
                return all.filter((p) => pre[p] === undefined || post[p] !== pre[p])
              })()
        for (const p of kept) out.push(r.mountPath === '' ? p : `${r.mountPath}/${p}`)
      }
      return out
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

export async function emitStatus(
  topology: SchedulerRuntimeTopology,
  taskId: string,
): Promise<void> {
  const projection = await topology.taskStatusReadModel.find(taskId)
  if (projection === null) return
  topology.taskStatusPublisher.publish({ ...projection, canceledNodeRuns: [] })
}

// RFC-098 WP-10 T-a: the old `insertNodeRun` half-factory was absorbed into
// the single mint factory — see services/nodeRunMint.ts (grep-guarded).

export async function failTask(
  topology: SchedulerRuntimeTopology,
  db: DbClient,
  taskId: string,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
  executionContext?: TaskExecutionContextRef,
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
    ...(executionContext !== undefined ? { executionContext } : {}),
    reason: `failTask: ${errorSummary}`,
  })
  if (!won) {
    createLogger('scheduler').warn(
      'failTask write lost to a concurrent transition — respecting winner',
      { taskId, errorSummary },
    )
    return
  }
  await emitStatus(topology, taskId)
}

export async function cancelTaskRow(
  topology: SchedulerRuntimeTopology,
  db: DbClient,
  taskId: string,
  failedNodeId?: string,
  abortReason?: unknown,
  executionContext?: TaskExecutionContextRef,
): Promise<void> {
  return withTaskReviewMutationLock(taskId, () =>
    cancelTaskRowUnlocked(topology, db, taskId, failedNodeId, abortReason, executionContext),
  )
}

async function cancelTaskRowUnlocked(
  topology: SchedulerRuntimeTopology,
  db: DbClient,
  taskId: string,
  failedNodeId?: string,
  abortReason?: unknown,
  executionContext?: TaskExecutionContextRef,
): Promise<void> {
  // RFC-202 T4: a graceful daemon shutdown aborts the scheduler exactly like
  // a user cancel did — but writing 'canceled by user' misattributes it and
  // strands the task (canceled has no resume edge; audit P1 F-13). The
  // shutdown path tags its abort with reason='daemon-shutdown'
  // (AbortController.abort(reason)); a user cancel aborts with no argument,
  // whose signal.reason is a DOMException — the string comparison below
  // leaves that path byte-identical. Shutdown-interrupted tasks land
  // interrupted + DAEMON_RESTART_ERROR_SUMMARY so both the Resume button and
  // boot auto-resume (autoResume.ts matches exactly that summary) cover them.
  if (abortReason === DAEMON_SHUTDOWN_ABORT_REASON) {
    const won = await trySetTaskStatus({
      db,
      taskId,
      to: 'interrupted',
      allowedFrom: ['running'],
      extra: {
        finishedAt: Date.now(),
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        errorMessage: 'daemon shutdown interrupted this task; resume (or auto-resume) continues it',
        ...(failedNodeId !== undefined ? { failedNodeId } : {}),
      },
      ...(executionContext !== undefined ? { executionContext } : {}),
      reason: 'cancelTaskRow-shutdown',
    })
    if (won) await emitStatus(topology, taskId)
    return
  }
  const structuredCause = taskStopCauseOf(abortReason)
  const projection = taskStopProjection(structuredCause ?? { kind: 'user' })
  // RFC-097: idempotent — cancelTask's fallback (or a failTask that raced
  // first) may already have landed a terminal status; respect the winner.
  const won = await trySetTaskStatus({
    db,
    taskId,
    to: 'canceled',
    allowedFrom: ['running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: projection.summary,
      errorMessage:
        structuredCause?.kind === 'webhook-terminal'
          ? `${projection.code}: delivery=${structuredCause.deliveryId} revision=${structuredCause.streamRevision}`
          : structuredCause?.kind === 'parent-cascade' && structuredCause.rootCause !== undefined
            ? `${projection.code}: parent=${structuredCause.parentTaskId} delivery=${structuredCause.rootCause.deliveryId} revision=${structuredCause.rootCause.streamRevision}`
            : projection.code,
      ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    },
    ...(executionContext !== undefined ? { executionContext } : {}),
    reason: 'cancelTaskRow',
  })
  if (!won) {
    createLogger('scheduler').warn(
      'cancelTaskRow lost to a concurrent transition — respecting winner',
      { taskId },
    )
    return
  }
  await emitStatus(topology, taskId)
}

function taskStopCauseOf(value: unknown): TaskStopCause | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null
  const candidate = value as TaskStopCause
  switch (candidate.kind) {
    case 'user':
    case 'daemon-shutdown':
      return candidate
    case 'parent-cascade':
      return typeof candidate.parentTaskId === 'string' ? candidate : null
    case 'webhook-terminal':
      return (candidate.terminal === 'closed' || candidate.terminal === 'merged') &&
        typeof candidate.deliveryId === 'string' &&
        Number.isInteger(candidate.streamRevision)
        ? candidate
        : null
    default:
      return null
  }
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
 * Direct containment map: every child node id → its immediate wrapper. Chained
 * entries (`inner → nested wrapper → outer wrapper`) retain the full nesting
 * relation; nodes absent from the map are top-level. The shared implementation
 * is also used by layout/source-boundary projection so the three surfaces
 * cannot drift.
 */
// RFC-193: exported for lifecycleRepair S1's scopeRoot derivation (§4.6) —
// the repair path re-invokes dispatchReviewNode OUTSIDE the scheduler, so it
// must recover "which wrapper contains this review" the same way runTask does.
export function buildContainerMap(def: WorkflowDefinition): Map<string, string> {
  return buildWorkflowScopeParentMap(def)
}
