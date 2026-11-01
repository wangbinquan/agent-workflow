import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  stringifyKind,
  tryParseKind,
  type Agent,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { nodeRunMintIdentityForSlot } from '../../../application/nodeRunMintIdentity'
import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type { Logger } from '../../../application/ports/executionKernel'
import type {
  FanoutShardAttemptResult,
  FanoutShardSpec,
} from '../../../application/ports/fanoutAttempt'
import type { RunResult } from '../../../application/ports/taskAgentRun'
import { describeEffectError } from '../../../domain/effectErrorDescription'
import { shouldRetryNodeFailure } from '../../../domain/envelopeRetryPolicy'
import { pickString } from '../../../domain/nodeFields'
import { nodeRunAttemptIndex } from '../../../domain/nodeRunAttempt'
import { taskCheckpointRefs } from '../../../domain/taskCheckpoint'
import { runAssembly, type IsoLike } from '../../kernel/assembly'

// RFC-407 — the fan-out shard assembly line (RFC-287 L5), moved from composition/wrapperMechanics.ts onto the
// agent executor's ports. Local state (iso handle, undo baseline, reuse selection) stays as it was; only the
// receivers changed (state / opts → ports).

type ShardSpec = FanoutShardSpec

/**
 * RFC-098 B3 (audit S-20): sha256 hex of a fanout shard's value — the
 * cross-generation reuse identity stamped into `node_runs.shard_value_hash`
 * (migration 0043) and re-derived at dispatch time for the
 * pickReusableShardRun match. sha256Hex（@/util/hash）precedent: util/git.ts 同款单步 hash 收口。
 */

export interface DispatchShardArgs {
  ports: AgentNodeExecutionPorts
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
export async function dispatchFanoutShard(args: DispatchShardArgs): Promise<DispatchShardResult> {
  const maxRetries = args.ports.policy.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
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
    ports,
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
  const { task, policy: opts, ledger, workspace, rules } = ports
  const { taskId } = task

  const shardKey = shard?.shardKey ?? '__shared__'
  const rowShardKey = shard === null ? null : shardKey
  // Cross-generation reuse identity (S-20): sha256 of the shard VALUE. The
  // shared/broadcast dispatch has no per-shard value → NULL (matches any —
  // the consumed generation gate is the shared row's only content guard).
  const valueHash = shard === null ? null : rules.shardValueHash(shard.value)

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
  const readCandidates = async () =>
    (
      await ledger.listNodeRuns({
        taskId,
        nodeId: innerNode.id,
        iteration,
        childOnly: true,
      })
    ).filter((row) => (row.shardKey ?? null) === rowShardKey)
  let candidates = await readCandidates()
  const forcedProcessRetry = args.processRetryIndex !== undefined
  const selectShard = async () =>
    (
      await ledger.shardSet(taskId, {
        wrapperRunId,
        iteration,
        shards: [{ nodeId: innerNode.id, shardKey: rowShardKey, valueHash }],
        reuseDisabled: args.reuseDisabled,
        processRetryIndex: args.processRetryIndex,
      })
    ).shards[0]!
  let selected = await selectShard()
  // RFC-370 — a done shard is reusable only once its delta is in this scope's
  // canonical. One whose merge-back a crash or a lost execution lease
  // interrupted finishes it here, in the dispatching scope (its merge target);
  // a shard whose merge-back failed is re-run instead of replayed without it.
  const interrupted = candidates.find((row) => row.id === selected.reusable?.id)
  if (
    interrupted !== undefined &&
    interrupted.id === selected.current?.id &&
    (interrupted.mergeState === 'pending-merge' || interrupted.mergeState === 'isolating')
  ) {
    await workspace.completeInterruptedMerge(interrupted, log)
    candidates = await readCandidates()
    selected = await selectShard()
  }
  const freshest = selected.current
  const reusable = selected.reusable
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
  const priorMergedRow = candidates.find((row) => row.id === selected.singleMergedCandidate?.id)
  if (priorMergedRow !== undefined) {
    const priorBase = taskCheckpointRefs(priorMergedRow.checkpoints, 'isolationBase')
    const priorNode = taskCheckpointRefs(priorMergedRow.checkpoints, 'nodeTree')
    if (Object.keys(priorNode).length > 0) priorShardUndo = { base: priorBase, node: priorNode }
  }
  if (selected.replayable && reusable !== null) {
    // Branch 1 — replay. The `reusable.id === freshest.id` guard refuses a
    // done row that has been SUPERSEDED by a fresher attempt of any status
    // (e.g. a user-targeted shard retry placeholder): replaying it would undo
    // that newer attempt's intent.
    const outRows = await ledger.listOutputs(reusable.id)
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    ports.status.broadcastNodeStatus(taskId, reusable.id, innerNode.id, 'done')
    return { kind: 'ok', shardKey, outputs, message: '' }
  }
  if (selected.rerunInPlace && freshest !== null) {
    // Branch 2 — re-run the existing same-generation child in place.
    // allowTerminal: a reaped child is 'interrupted' (terminal); reset to
    // pending so runNode's mark-running (pending → running) applies cleanly.
    shardRunId = freshest.id
    await ledger.setNodeRunStatus({
      nodeRunId: shardRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-shard-resume',
    })
    // The re-run consumes the CURRENT shard value — refresh the stored hash
    // so future reuse decisions compare against what actually ran.
    await ledger.patch({
      nodeRunId: shardRunId,
      values: {
        config: {
          shardValueHash: valueHash,
        },
      },
    })
    shardRetryIndex = freshest.retryIndex
  } else {
    // Branch 3 — mint a fresh row under this wrapper. The T14 replacement target
    // (priorShardUndo) was already derived above from the latest done+merged
    // candidate and is applied at merge-back.
    shardRunId = await ledger.mintNodeRun({
      ...nodeRunMintIdentityForSlot(
        { kind: 'shard', nodeId: innerNode.id, iteration, shardKey: rowShardKey },
        { kind: 'current' },
      ),
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-shard',
      retryIndex: nodeRunAttemptIndex({ kind: 'explicit', attempt: args.processRetryIndex }),
      containerRunId: wrapperRunId,
      iteration,
      overrides: {
        identity: {
          parentNodeRunId: wrapperRunId,
          shardKey: rowShardKey,
        },
        config: {
          shardValueHash: valueHash,
        },
      },
    })
    shardRetryIndex = args.processRetryIndex ?? 0
  }
  ports.status.broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'pending')

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
  // refuse `{{port}}` references against signal-kind inputs. RFC-354 (schema
  // v6): a fan-out PARAMETER is declared by the wrapper's inbound edge, so its
  // kind is the kind of the source port feeding that edge; the boundary edge
  // then hands it to the inner's local port name.
  const inputPortKinds: Record<string, string> = {}
  const wrapper = args.ports.task.definition.nodes.find((n) => n.id === args.wrapperId)
  if (wrapper !== undefined && wrapper.kind === 'wrapper-fanout') {
    const paramKinds = new Map<string, string>()
    for (const inbound of args.ports.task.definition.edges) {
      if (inbound.boundary !== undefined || inbound.target.nodeId !== args.wrapperId) continue
      const kind = await args.ports.resources.sourcePortKind(
        inbound.source.nodeId,
        inbound.source.portName,
      )
      if (kind !== null) paramKinds.set(inbound.target.portName, kind)
    }
    for (const e of boundaryEdges) {
      const kind = paramKinds.get(e.source.portName)
      if (kind === undefined) continue
      if (e.source.portName === shardSourcePortName) {
        // For the shardSource parameter the inner receives ONE item (the shard
        // value); the item's effective kind is the list's item kind, not
        // `list<T>` — stringified so the runner can re-parse it (nested
        // list<list<...>> items survive intact).
        const lk = tryParseKind(kind)
        inputPortKinds[e.target.portName] =
          lk !== null && lk.kind === 'list' ? stringifyKind(lk.item) : kind
      } else {
        inputPortKinds[e.target.portName] = kind
      }
    }
  }

  const injection = await ports.resources.injection(innerAgent.id)
  if (injection.kind === 'failed') {
    await ledger.setNodeRunStatus({
      nodeRunId: shardRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-shard-injection-failed',
      extra: {
        identity: {
          finishedAt: Date.now(),
          errorMessage: injection.message,
        },
      },
    })
    ports.status.broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
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
      pools: [ports.agentSem, ports.subprocessSem],
      iso: {
        create: async () => {
          shardIso = await workspace.createIsoUnderLock(shardRunId, log)
          return shardIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough) await workspace.persistIsoBase(shardRunId, shardIso as IsoHandle)
        },
      },
      beforeSpawn: async () => {
        const iso = shardIso as IsoHandle
        if (priorShardUndo !== null && !iso.passthrough && !workspace.adoptedExecution(iso)) {
          for (const r of iso.repos) {
            try {
              await workspace.undoShard(iso, {
                workspaceRef: r.isoWorktreePath,
                priorNodeCommit: priorShardUndo.node[r.mountPath],
                priorBaseCommit: priorShardUndo.base[r.mountPath],
                log,
                forcedRelativePaths: r.forcedRepoRelPaths,
              })
            } catch (err) {
              log.warn('T14 iso-undo failed — superimposition fallback', {
                shardKey,
                worktreeDirName: r.mountPath,
                mountPath: r.mountPath,
                subdir: '',
                readonly: false,
                error: describeEffectError(err),
              })
            }
          }
        }
      },
      onIsoSetupFailure: (err) => {
        log.warn('fanout shard iso setup failed', {
          shardKey,
          error: describeEffectError(err),
        })
        return { kind: 'failed', shardKey, outputs: {}, message: 'iso-setup-failed' }
      },
      spawn: async () => {
        // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the fanout shard
        // so a claude-selected agent-multi dispatches its shards on claude, not opencode.
        const shardRuntime = await ports.runtime.resolve(
          shardRunId,
          injection.spec.agent.runtime,
          opts.defaultRuntime,
          null,
        )
        const iso = shardIso as IsoHandle
        const result = await ports.runtime.runAgent(
          {
            taskId,
            nodeRunId: shardRunId,
            nodeId: innerNode.id,
            agent: injection.spec.agent,
            triggerContext: task.triggerContext,
            runtime: shardRuntime.protocol,

            runtimeParams: shardRuntime.params,
            runtimeConfigDir: shardRuntime.configDir, // RFC-154: frozen config-dir profile
            runtimeObservationIdentity: shardRuntime.observationIdentity,
            inputs,
            // RFC-130 D16: cwd + path tokens → the shard's isolated worktree.

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
                mountPath: r.mountPath,
                subdir: '',
                readonly: false,
                baseBranch: r.baseBranch,
              })),
            },
            ...(promptTemplate !== undefined ? { promptTemplate } : {}),
            ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
            // PR-D2: per-shard clarify stays off — RFC-148 ADT form.
            clarifyChannel: { kind: 'none' as const },

            dependents: injection.spec.dependents,
            mcps: injection.spec.mcps,

            ...(Object.keys(inputPortKinds).length > 0 ? { inputPortKinds } : {}),
            log,
          },
          {
            workspaceRef: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
            material: injection.spec.material,
            runtimeBinding: shardRuntime.runtimeBinding,
          },
        )
        ports.status.broadcastNodeStatus(taskId, shardRunId, innerNode.id, result.status)
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
          const merge = await workspace.mergeBackAndSettle({
            handle: iso,
            nodeRunId: shardRunId,
            via: 'live',
            extraForcedContainerPaths: workspace.portFileContainerPaths(result.portFilePaths ?? []),
            conflictResolver: (conflicts, containerPath) =>
              ports.conflicts.resolveMergeConflicts({
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
              await workspace.abandonMerge(shardRunId, 'fanout-shard-merge-conflict-unresolved')
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
                const msg = describeEffectError(err)
                await workspace.markMergeFailed(shardRunId, msg, log)
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
        const msg = describeEffectError(err)
        ports.status.broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
        return {
          kind: 'failed',
          shardKey,
          outputs: {},
          message: msg,
          retry: { retryIndex: shardRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => workspace.discardNodeIso(h as IsoHandle, log),
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
