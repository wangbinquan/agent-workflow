// RFC-339 — task-execution-owned loop/git/fanout wrapper mechanics.

import type { computeShardScope } from '@/modules/task-execution/domain/fanoutScope'
import type {
  Agent,
  FailureCode,
  MergeState,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WrapperFanoutPort,
} from '@agent-workflow/shared'
import { DEFAULT_PROTOCOL_RETRY_BUDGET, stringifyKind, tryParseKind } from '@agent-workflow/shared'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { resolveFrozenRuntimeWith } from '@/services/nodeRunMint'
import { fanoutInnerAgentRefKey } from '@/services/ref/runtimeRef'

import {
  consumedMapsEqual,
  isFresherNodeRun,
  parseConsumedJson,
  pickFreshestRun,
  pickReusableShardRun,
} from '@/services/freshness'
import { toContainerRelative } from '@/services/portArtifacts'
import { runNode, type RunResult } from '@/services/runner'
import { encodeWrapperProgress } from '@/modules/task-execution/domain/wrapperProgress'
import type { Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import {
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
  freshestPriorRunWithOutput,
  isolatedRunBinding,
  parseIsoJsonMap,
  parseIsoSubmodules,
  pickString,
  readPortRowAtFrame,
  resolveMergeConflicts,
  resolveUpstreamInputs,
  shouldRetryNodeFailure,
  type OneNodeResult,
  type SchedulerState,
} from '@/modules/task-execution/composition/nodeMechanics'
import { freezeBinaryConfig } from '@/services/execution/runtimeConfigFreeze'
import { runAssembly, type IsoLike } from '@/services/schedulerAssembly'
import { sha256Hex } from '@/util/hash'
import type { WrapperDataPort } from '../application/ports/wrapperData'
import { loadFrameChain } from '../application/frameChain'
import { resolveSourceFrameInScope } from '../domain/environmentChain'
import type { WrapperScopeDriverPort } from '../application/ports/wrapperScopeDriver'
import type {
  WrapperWorkspacePort,
  WrapperWorkspaceScene,
} from '../application/ports/wrapperWorkspace'
import type {
  FanoutAttemptPort,
  FanoutShardAttemptResult,
  FanoutShardSpec,
} from '../application/ports/fanoutAttempt'

export interface WrapperMechanicsPorts {
  readonly data: WrapperDataPort
  readonly scopeDriver: WrapperScopeDriverPort
  readonly workspace: WrapperWorkspacePort
  readonly fanoutAttempts: FanoutAttemptPort
}

export function createWrapperMechanicsPorts(
  state: SchedulerState,
  executionLog: Logger,
): WrapperMechanicsPorts {
  const scenes = new Map<symbol, { readonly handle: IsoHandle; readonly kind: string }>()
  const sceneRecord = (scene: WrapperWorkspaceScene) => {
    const record = scenes.get(scene.key)
    if (record === undefined) throw new Error(`wrapper-workspace-scene-missing:${scene.kind}`)
    return record
  }
  const diffableRepos = (scene: WrapperWorkspaceScene) => {
    const { handle } = sceneRecord(scene)
    return (
      handle.passthrough
        ? state.repos.map((repo) => ({
            path: repo.worktreePath,
            mountPath: repo.mountPath,
            readonly: repo.readonly,
          }))
        : handle.repos.map((repo, index) => ({
            path: repo.isoWorktreePath,
            mountPath: state.repos[index]?.mountPath ?? repo.worktreeDirName,
            readonly: state.repos[index]?.readonly ?? false,
          }))
    )
      .filter((repo) => !repo.readonly)
      .map((repo) => ({ path: repo.path, mountPath: repo.mountPath }))
  }

  const data: WrapperDataPort = {
    definition: state.definition,
    fanoutMaxShardTotal: state.opts.fanoutMaxShardTotal ?? 256,
    fanoutAgentKey: fanoutInnerAgentKey,
    async resolveFanoutAgent(node) {
      const agentId = fanoutInnerAgentRefKey(node as Record<string, unknown>)
      if (agentId === null) return { kind: 'missing' }
      const resolution = await state.taskExecutionResources.injection(agentId)
      return resolution.kind === 'ok' ? { kind: 'ok', agent: resolution.spec.agent } : resolution
    },
    consumedProvenanceMatches(priorJson, current) {
      return consumedMapsEqual(parseConsumedJson(priorJson), current)
    },
    reportDiagnostic(input) {
      executionLog[input.level](input.message, input.fields)
    },
    persistProgress: async (runId, progress) => {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: { wrapperProgressJson: encodeWrapperProgress(progress) },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    // RFC-354: `frame` is the READER's frame — the body frame `(generation,
    // round)` a loop evaluates its exit condition / output bindings in. The
    // producing node is read in the frame the environment chain resolves it
    // to: a body node locally, a node outside the wrapper as a captured free
    // variable (one generation row outward per enclosing wrapper). A source
    // that is not lexically visible fails loudly instead of reading ''.
    readPort: async (nodeId, portName, frame) => {
      const chain = await loadFrameChain(
        (id: string) => state.opts.persistence.nodeExecution.read(id),
        frame,
      )
      const scopeRow =
        frame.containerRunId === null ? undefined : chain.lookup(frame.containerRunId)
      const resolved = resolveSourceFrameInScope({
        sourceNodeId: nodeId,
        scope: scopeRow?.nodeId ?? null,
        parents: state.containerOf,
        frame,
        containerRowById: chain.lookup,
      })
      if (!resolved.ok) {
        throw new Error(
          `closure-binding-unresolved: port '${nodeId}.${portName}' is not visible from frame ` +
            `${frame.containerRunId ?? 'top'}#${frame.iteration} (${resolved.reason}${resolved.scopeId === null ? '' : ` at ${resolved.scopeId}`})`,
        )
      }
      return await readPortRowAtFrame(
        state.opts.persistence.nodeExecution,
        state.taskId,
        nodeId,
        portName,
        resolved.frame,
      )
    },
    resolveInputs: (nodeId, frame) =>
      resolveUpstreamInputs(
        state.opts.persistence.nodeExecution,
        state.taskId,
        state.definition.edges,
        nodeId,
        frame,
        executionLog,
        state.definition,
        state.containerOf,
      ),
    async recordConsumed(runId, consumed) {
      await state.opts.persistence.nodeExecution.patch({
        nodeRunId: runId,
        values: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
    async priorFanoutConsumed(nodeId, iteration, excludeRunId) {
      const rows = await state.opts.persistence.nodeExecution.list({
        taskId: state.taskId,
        nodeId,
        iteration,
      })
      const previous = pickFreshestRun(
        rows.filter((row) => row.id !== excludeRunId && row.consumedUpstreamRunsJson !== null),
        { topLevelOnly: true },
      )
      return previous?.consumedUpstreamRunsJson ?? null
    },
    async outputOf(runId, portName) {
      const row = (await state.opts.persistence.nodeExecution.listOutputs(runId)).find(
        (output) => output.portName === portName,
      )
      return row === undefined
        ? null
        : {
            content: row.content,
            kind: row.kind,
            archiveJson: row.archiveJson,
            active: row.active,
          }
    },
    async upsertOutput(input) {
      await state.opts.persistence.nodeExecution.upsertOutputs({
        nodeRunId: input.runId,
        outputs: [
          {
            portName: input.portName,
            content: input.content,
            kind: input.kind ?? null,
            archiveJson: input.archiveJson ?? null,
            active: input.active ?? true,
          },
        ],
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
    },
  }

  const workspace: WrapperWorkspacePort = {
    async open(generation) {
      const handle = await createOrRebuildWrapperIso(state, generation.runId, generation.previous)
      const key = Symbol(generation.runId)
      scenes.set(key, { handle, kind: generation.kind })
      return Object.freeze({ key, kind: generation.kind, passthrough: handle.passthrough })
    },
    async captureGitEntry(scene, capturePreDirty) {
      const repos = diffableRepos(scene)
      const primaryMount = repos.some((repo) => repo.mountPath === '')
        ? ''
        : (repos[0]?.mountPath ?? '')
      const entry = await state.writeSem.run(async () => {
        const baselines: Record<string, string> = {}
        const preDirtyByRepo: Record<string, Record<string, string>> = {}
        for (const repo of repos) {
          const baseline = await captureHead(repo.path)
          baselines[repo.mountPath] = baseline
          preDirtyByRepo[repo.mountPath] = capturePreDirty
            ? await captureGitPreDirty(repo.path, baseline, executionLog)
            : {}
        }
        return { baselines, preDirtyByRepo }
      })
      return { ...entry, primaryMount }
    },
    changedFiles(scene, baselines, preDirtyByRepo) {
      return state.writeSem.run(async () => {
        const output: string[] = []
        for (const repo of diffableRepos(scene)) {
          const baseline = baselines[repo.mountPath] ?? ''
          const preDirty = preDirtyByRepo[repo.mountPath] ?? {}
          const all = await gitChangedFiles(repo.path, baseline || 'HEAD')
          const candidates = all.filter((path) => preDirty[path] !== undefined)
          const kept =
            candidates.length === 0
              ? all
              : await (async () => {
                  const post = await gitBlobHashes(repo.path, candidates)
                  return all.filter(
                    (path) => preDirty[path] === undefined || post[path] !== preDirty[path],
                  )
                })()
          for (const path of kept) {
            output.push(repo.mountPath === '' ? path : `${repo.mountPath}/${path}`)
          }
        }
        return output
      })
    },
    async merge(input) {
      const { handle } = sceneRecord(input.scene)
      const result = await mergeBackWrapperIso(
        state,
        handle,
        input.runId,
        input.node,
        input.iteration,
        executionLog,
      )
      return result.kind === 'merge-failed' ? { kind: 'merge-failed', message: result.msg } : result
    },
  }

  const scopeDriver: WrapperScopeDriverPort = {
    drive(input) {
      const { handle, kind } = sceneRecord(input.workspace)
      const innerState: SchedulerState = handle.passthrough
        ? state
        : {
            ...state,
            repos: handle.repos.map((repo, index) => ({
              repoIndex: index,
              repoPath: repo.repoPath,
              worktreePath: repo.isoWorktreePath,
              worktreeDirName: repo.worktreeDirName,
              mountPath:
                kind === 'wrapper-loop'
                  ? (state.repos[index]?.mountPath ?? repo.worktreeDirName)
                  : repo.worktreeDirName,
              readonly: kind === 'wrapper-loop' ? (state.repos[index]?.readonly ?? false) : false,
              baseBranch: repo.baseBranch,
              baseCommit: repo.baseSnapshot,
            })),
            scopeRoot: handle.containerPath,
          }
      const label = kind === 'wrapper-loop' ? 'loop' : 'git'
      return state.driveScope(innerState, {
        scopeId: input.scope.wrapperId,
        scopeIds: new Set(input.scope.directNodeIds),
        containerRunId: input.containerRunId,
        iteration: input.iteration,
        log: executionLog.child(`${label}:${input.scope.wrapperId}`),
      })
    },
  }

  const fanoutAttempts: FanoutAttemptPort = {
    dispatchShard(input) {
      return dispatchFanoutShard({
        state,
        ...input,
        boundaryEdges: [...input.boundaryEdges],
        broadcastInputs: { ...input.broadcastInputs },
        log: executionLog.child(
          `fanout:${input.wrapperId}:${input.innerNode.id}${input.shard === null ? ':shared' : ''}`,
        ),
      })
    },
    dispatchAggregator(input) {
      return dispatchFanoutAggregator({
        state,
        wrapperId: input.wrapperId,
        wrapperRunId: input.wrapperRunId,
        aggNode: input.node,
        aggAgent: input.agent,
        iteration: input.iteration,
        shards: [...input.shards],
        definition: input.definition,
        scope: input.scope,
        reuseDisabled: input.reuseDisabled,
        log: executionLog.child(`fanout:${input.wrapperId}:aggregator`),
      })
    },
  }

  return { data, scopeDriver, workspace, fanoutAttempts }
}

// -----------------------------------------------------------------------------
// RFC-040 — wrapper resume helpers shared by the loop and Git strategies.
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

type ShardSpec = FanoutShardSpec

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
   * its value hash matches). See FanoutStrategy's consumed-generation gate.
   */
  reuseDisabled: boolean
  /**
   * Internal process-retry attempt. When present, dispatch must mint a fresh
   * child row instead of replaying/resetting the failed same-generation row.
   */
  processRetryIndex?: number
  log: Logger
}

type DispatchShardResult = FanoutShardAttemptResult

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
  const { task, taskId, opts } = state

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
    await state.opts.persistence.nodeExecution.list({
      taskId,
      nodeId: innerNode.id,
      iteration,
      childOnly: true,
    })
  ).filter((row) => (row.shardKey ?? null) === rowShardKey)
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
    const outRows = await state.opts.persistence.nodeExecution.listOutputs(reusable.id)
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
    await state.opts.persistence.nodeRuns.set({
      nodeRunId: shardRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-shard-resume',
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    // The re-run consumes the CURRENT shard value — refresh the stored hash
    // so future reuse decisions compare against what actually ran.
    await state.opts.persistence.nodeExecution.patch({
      nodeRunId: shardRunId,
      values: { shardValueHash: valueHash },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    shardRetryIndex = freshest.retryIndex
  } else {
    // Branch 3 — mint a fresh row under this wrapper. The T14 replacement target
    // (priorShardUndo) was already derived above from the latest done+merged
    // candidate and is applied at merge-back.
    shardRunId = await state.opts.persistence.nodeRuns.mint({
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-shard',
      retryIndex: args.processRetryIndex ?? 0,
      containerRunId: wrapperRunId,
      iteration,
      overrides: {
        parentNodeRunId: wrapperRunId,
        shardKey: rowShardKey,
        shardValueHash: valueHash,
      },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
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

  const injection = await state.taskExecutionResources.injection(innerAgent.id)
  if (injection.kind === 'failed') {
    await state.opts.persistence.nodeRuns.set({
      nodeRunId: shardRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-shard-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
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
            binding: isolatedRunBinding(state),
            isoKeyRunId: shardRunId,
            canonRepos: state.repos,
            log,
          })
          return shardIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(
              isolatedRunBinding(state),
              shardRunId,
              task.repoCount,
              shardIso as IsoHandle,
            )
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
        const shardRuntime = await resolveFrozenRuntimeWith(
          opts.persistence.nodeRunRuntime,
          opts.runtimeRegistry,
          shardRunId,
          injection.spec.agent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = shardIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: shardRunId,
          nodeId: innerNode.id,
          agent: injection.spec.agent,
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
          memoryInjectionQueries: opts.memoryInjectionQueries,
          runtimeSessionLeases: opts.runtimeSessionLeases,
          runtimeRegistry: opts.runtimeRegistry,
          persistence: opts.persistence,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          ...(Object.keys(inputPortKinds).length > 0 ? { inputPortKinds } : {}),
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
            binding: isolatedRunBinding(state),
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
              await state.opts.persistence.mergeStates.tryTransition({
                nodeRunId: shardRunId,
                event: { kind: 'abandon', reason: 'fanout-shard-merge-conflict-unresolved' },
                ...(state.opts.executionContext === undefined
                  ? {}
                  : { executionContext: state.opts.executionContext }),
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
                await markMergeFailed(isolatedRunBinding(state), shardRunId, msg, log)
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
  const { task, taskId, opts } = state

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
    const innerRows = await state.opts.persistence.nodeExecution.list({
      taskId,
      nodeId: edge.source.nodeId,
      iteration,
      childOnly: true,
    })
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
        const outRows = await state.opts.persistence.nodeExecution.listOutputs(row.id)
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
        const outRows = await state.opts.persistence.nodeExecution.listOutputs(row.id)
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
    await state.opts.persistence.nodeExecution.list({
      taskId,
      nodeId: aggNode.id,
      iteration,
      childOnly: true,
    })
  ).filter((row) => row.shardKey === null)
  const freshestAgg = pickFreshestRun(aggCandidates, { topLevelOnly: false })
  const forcedProcessRetry = args.processRetryIndex !== undefined
  if (
    !forcedProcessRetry &&
    !args.reuseDisabled &&
    freshestAgg !== undefined &&
    freshestAgg.status === 'done' &&
    participatingRowIds.every((id) => isFresherNodeRun<{ id: string }>(freshestAgg, { id }))
  ) {
    const outRows = await state.opts.persistence.nodeExecution.listOutputs(freshestAgg.id)
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
    await state.opts.persistence.nodeRuns.set({
      nodeRunId: aggRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-aggregator-resume',
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    aggRetryIndex = freshestAgg.retryIndex
  } else {
    aggRunId = await state.opts.persistence.nodeRuns.mint({
      taskId,
      nodeId: aggNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-aggregator',
      retryIndex: args.processRetryIndex ?? 0,
      containerRunId: wrapperRunId,
      iteration,
      overrides: { parentNodeRunId: wrapperRunId },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    aggRetryIndex = args.processRetryIndex ?? 0
  }
  broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'pending')

  const injection = await state.taskExecutionResources.injection(aggAgent.id)
  if (injection.kind === 'failed') {
    await state.opts.persistence.nodeRuns.set({
      nodeRunId: aggRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-aggregator-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
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
  const aggPriorRun = await freshestPriorRunWithOutput(state.opts.persistence.nodeExecution, {
    taskId,
    nodeId: aggNode.id,
    iteration,
    shardKey: null,
    id: aggRunId,
  })
  let aggPriorOutputUpdate: { block: string } | undefined
  if (aggPriorRun !== undefined) {
    const block = await composePriorOutputBlock(
      state.opts.persistence.nodeExecution,
      aggPriorRun.id,
      injection.spec.agent.outputs ?? [],
      undefined,
      (await state.opts.persistence.nodeExecution.read(aggRunId))?.envelopeNonce ?? '',
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
            binding: isolatedRunBinding(state),
            isoKeyRunId: aggRunId,
            canonRepos: state.repos,
            log,
          })
          return aggIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(
              isolatedRunBinding(state),
              aggRunId,
              task.repoCount,
              aggIso as IsoHandle,
            )
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
        const aggRuntime = await resolveFrozenRuntimeWith(
          opts.persistence.nodeRunRuntime,
          opts.runtimeRegistry,
          aggRunId,
          injection.spec.agent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = aggIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: aggRunId,
          nodeId: aggNode.id,
          agent: injection.spec.agent,
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
          memoryInjectionQueries: opts.memoryInjectionQueries,
          runtimeSessionLeases: opts.runtimeSessionLeases,
          runtimeRegistry: opts.runtimeRegistry,
          persistence: opts.persistence,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
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
            binding: isolatedRunBinding(state),
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
              await state.opts.persistence.mergeStates.tryTransition({
                nodeRunId: aggRunId,
                event: { kind: 'abandon', reason: 'fanout-agg-merge-conflict-unresolved' },
                ...(state.opts.executionContext === undefined
                  ? {}
                  : { executionContext: state.opts.executionContext }),
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
                await markMergeFailed(isolatedRunBinding(state), aggRunId, msg, log)
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
      // handled by FanoutStrategy after this attempt returns.
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
  const { task, taskId } = state
  // RFC-144 (Codex impl-gate P2) — same-row wrapper revival: a revived wrapper
  // row may arrive with a SETTLED prior generation ('merged': crash inside
  // mergeBackWrapperIso got its pending-merge replayed at entry;
  // 'conflict-human': canceled while parked). This run opens a NEW isolation
  // generation on the same row — re-enter 'isolating' so the strict machine's
  // mark-pending-merge (from=isolating) holds at the wrapper's merge-back.
  // isolating (mid-run revival, the common case) and NULL (fresh row /
  // passthrough) rows never emit this.
  const cur = await state.opts.persistence.nodeExecution.read(wrapperRunId)
  let effectiveExisting = existing
  if (cur !== null && (cur.mergeState === 'merged' || cur.mergeState === 'conflict-human')) {
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
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        extra: {
          isoWorktreePath: null,
          isoBaseSnapshot: null,
          isoBaseSnapshotReposJson: null,
          wrapperProgressJson: null,
        },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      effectiveExisting = null
    } else {
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
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
        forcedContainerPaths: [...(await state.opts.persistence.artifactPaths.forcedPaths(taskId))],
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
    binding: isolatedRunBinding(state),
    log: state.log,
  })
  if (!handle.passthrough)
    await persistIsoBase(isolatedRunBinding(state), wrapperRunId, task.repoCount, handle)
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
  const { task, taskId } = state
  try {
    // RFC-193 K1: re-aggregate at wrapper-final time — the wrapper handle is
    // the one LONG-LIVED handle (inner nodes archived new port files during
    // its lifetime; the create-time roster predates them, design §4.5).
    const nodeTrees = await snapshotNodeIsoFinal(wrapperIso, log, [
      ...(await state.opts.persistence.artifactPaths.forcedPaths(taskId)),
    ])
    // RFC-210 impl-gate: the handle rides along so a topology the snapshot
    // extended (submodule added inside the wrapper) survives into crash replay.
    await persistIsoNodeTree(
      isolatedRunBinding(state),
      wrapperRunId,
      task.repoCount,
      nodeTrees,
      wrapperIso,
    )
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
      await state.opts.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'park-conflict-human', via: 'live' },
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      })
      // D10: merge_state and status remain orthogonal. This adapter owns only
      // the merge fact; WrapperRunLedger performs the one status CAS and
      // WrapperRuntime publishes only after that write commits.
      return { kind: 'conflict-human', detail: merge.detail }
    }
    await state.opts.persistence.mergeStates.transition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merged', via: 'live' },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    await discardNodeIso(wrapperIso, log, state.writeSem)
    return { kind: 'merged' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const flipped = await state.opts.persistence.mergeStates.tryTransition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merge-failed', reason: msg },
      ...(state.opts.executionContext === undefined
        ? {}
        : { executionContext: state.opts.executionContext }),
    })
    if (!flipped) {
      log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: wrapperRunId })
    }
    return { kind: 'merge-failed', msg }
  }
}

// RFC-060 PR-E: runFanOutNode (the M3 agent-multi fan-out implementation)
// was removed. wrapper-fanout (RFC-060) is now the sole fan-out mechanism;
// see FanoutStrategy for the replacement.

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
