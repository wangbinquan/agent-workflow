// Remaining task-execution compatibility facade.
//
// RFC-332/334/339 moved TaskEngine, node execution, wrapper runtime and merge
// recovery into modules/task-execution. This file now retains the W3 lifecycle
// status helpers, W5 commit-push mechanics and a few source-compatible exports
// until their separately authorized waves cut over.

import { resolveRepositoryPublicationTransportFromKeyFile } from '@/modules/source-control/composition'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  buildWorkflowScopeParentMap,
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
// RFC-253 — script node execution.
import { loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import { nodeRuns, taskRepos } from '@/db/schema'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { resolveInjection } from '@/services/execution/resolveInjection'
import { trySetTaskStatus } from '@/services/lifecycle'
import { loadRunEnvelopeNonce, mintNodeRun, resolveFrozenRuntime } from '@/services/nodeRunMint'

import type { TaskExecutionContextRef } from '@/modules/task-execution/public/commands'
import {
  taskStopProjection,
  type SchedulerRuntimeTopology,
  type TaskStopCause,
} from '@/modules/task-execution/public/types'
import {
  buildCommitAgent,
  buildCommitMessagePrompt,
  buildRepairPrompt,
  COMMIT_MESSAGE_PORT,
  commitPushNodeId,
} from '@/services/commitPush'
import { runCommitPush } from '@/services/commitPushRunner'
import { pickFreshestRun } from '@/services/freshness'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { runNode } from '@/services/runner'
import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import { withTaskExecutionMutation } from '@/services/taskExecutionParticipants'
import { createLogger, type Logger } from '@/util/log'
import {
  DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
  DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
} from '@agent-workflow/shared'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import { runGit } from '@/util/git'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import type { LegacyTaskMechanicsState as SchedulerState } from '@/services/execution/taskMechanicsState'
import { freezeBinaryConfig } from '@/services/execution/runtimeConfigFreeze'
import {
  INHERITABLE_RUN_CONFIG_KEYS,
  pickInheritableRunConfig,
} from '@/modules/task-execution/public/commands'
import type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'

// Compatibility exports for the existing scheduler test contract. The owner is
// task-execution/public/commands; production consumers import that exact surface.
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
// modules/task-execution/composition/taskDagScope.ts. Wrapper/replay ownership
// moved with RFC-339; the remaining W3/W5 helpers receive only the admitted
// task state required by their current lifecycle/commit-push responsibilities.
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
