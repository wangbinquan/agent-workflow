import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  type Agent,
  type FailureCode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { nodeRunMintIdentityForSlot } from '../../../application/nodeRunMintIdentity'
import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type { Logger } from '../../../application/ports/executionKernel'
import type { FanoutShardSpec } from '../../../application/ports/fanoutAttempt'
import type { NodeExecutionSnapshot } from '../../../application/ports/nodeExecutionPersistence'
import type { ShardRequest } from '../../../application/ports/runSelection'
import type { RunResult } from '../../../application/ports/taskAgentRun'
import { describeEffectError } from '../../../domain/effectErrorDescription'
import type { NodeStepOutcome } from '../../../domain/nodeExecution'
import { shouldRetryNodeFailure } from '../../../domain/envelopeRetryPolicy'
import type { computeShardScope } from '../../../domain/fanoutScope'
import { pickString } from '../../../domain/nodeFields'
import { nodeRunAttemptIndex } from '../../../domain/nodeRunAttempt'
import { runAssembly, type IsoLike } from '../../kernel/assembly'

// RFC-407 — the fan-out aggregator assembly line (RFC-287 L6), moved from composition/wrapperMechanics.ts onto
// the agent executor's ports; only the receivers changed (state / opts → ports).

type ShardSpec = FanoutShardSpec

export interface DispatchAggregatorArgs {
  ports: AgentNodeExecutionPorts
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

type DispatchAggregatorResult = NodeStepOutcome & {
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
export async function dispatchFanoutAggregator(
  args: DispatchAggregatorArgs,
): Promise<DispatchAggregatorResult> {
  const maxRetries = args.ports.policy.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
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
  const { ports, wrapperRunId, aggNode, aggAgent, iteration, shards, definition, scope, log } = args
  const { task, policy: opts, ledger, history, workspace, rules } = ports
  const { taskId } = task

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
  const participatingRows: NodeExecutionSnapshot[] = []
  const shardRequests: ShardRequest[] = []
  const incoming = definition.edges.filter(
    (e) => e.target.nodeId === aggNode.id && e.boundary === undefined,
  )
  for (const edge of incoming) {
    const blocks: string[] = []
    // For each shard, pick the corresponding inner node_run + read port.
    const innerRows = await ledger.listNodeRuns({
      taskId,
      nodeId: edge.source.nodeId,
      iteration,
      childOnly: true,
    })
    if (scope.perShard.has(edge.source.nodeId)) {
      // sorted by shardKey dictionary order (matches agent-multi convention).
      const sortedShards = [...shards].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
      for (const s of sortedShards) {
        const request = {
          nodeId: edge.source.nodeId,
          shardKey: s.shardKey,
          valueHash: rules.shardValueHash(s.value),
        }
        shardRequests.push(request)
        const selected = await ledger.shardSet(taskId, {
          wrapperRunId,
          iteration,
          shards: [request],
        })
        const row = innerRows.find((candidate) => candidate.id === selected.participating[0]?.id)
        if (row === undefined) continue
        participatingRows.push(row)
        const outRows = await ledger.listOutputs(row.id)
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
      const request = { nodeId: edge.source.nodeId, shardKey: null, valueHash: null }
      shardRequests.push(request)
      const selected = await ledger.shardSet(taskId, {
        wrapperRunId,
        iteration,
        shards: [request],
      })
      const row = innerRows.find((candidate) => candidate.id === selected.participating[0]?.id)
      if (row !== undefined) {
        participatingRows.push(row)
        const outRows = await ledger.listOutputs(row.id)
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
  const readAggCandidates = async () =>
    (
      await ledger.listNodeRuns({
        taskId,
        nodeId: aggNode.id,
        iteration,
        childOnly: true,
      })
    ).filter((row) => row.shardKey === null)
  let aggCandidates = await readAggCandidates()
  const selectAggregator = () =>
    ledger.shardSet(taskId, {
      wrapperRunId,
      iteration,
      shards: shardRequests,
      aggregatorNodeId: aggNode.id,
      reuseDisabled: args.reuseDisabled,
      processRetryIndex: args.processRetryIndex,
    })
  let selectedAggregator = await selectAggregator()
  let freshestAgg = aggCandidates.find((row) => row.id === selectedAggregator.aggregator?.id)
  const forcedProcessRetry = args.processRetryIndex !== undefined
  // RFC-370 — same rule as the shards: an interrupted merge-back completes in
  // the dispatching scope before the aggregation is replayed, a failed one re-runs.
  if (
    !forcedProcessRetry &&
    !args.reuseDisabled &&
    freshestAgg?.status === 'done' &&
    selectedAggregator.aggregatorNewerThanInputs &&
    (freshestAgg.mergeState === 'pending-merge' || freshestAgg.mergeState === 'isolating')
  ) {
    await workspace.completeInterruptedMerge(freshestAgg, log)
    aggCandidates = await readAggCandidates()
    selectedAggregator = await selectAggregator()
    freshestAgg = aggCandidates.find((row) => row.id === selectedAggregator.aggregator?.id)
  }
  if (selectedAggregator.aggregatorReplayable && freshestAgg !== undefined) {
    const outRows = await ledger.listOutputs(freshestAgg.id)
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    ports.status.broadcastNodeStatus(taskId, freshestAgg.id, aggNode.id, 'done')
    return { kind: 'ok', summary: '', message: '', outputs, aggRunId: freshestAgg.id }
  }
  const recordedInputs = [...new Map(participatingRows.map((row) => [row.id, row])).values()].map(
    (row) => ({
      inputKind: 'aggregator-shard' as const,
      producerNodeId: row.nodeId,
      producerRunId: row.id,
      producerShardKey: row.shardKey,
    }),
  )
  let aggRunId: string
  let aggRetryIndex: number
  if (selectedAggregator.aggregatorRerunInPlace && freshestAgg !== undefined) {
    // Re-run the same-generation residue in place (allowTerminal: a reaped
    // aggregator is 'interrupted'; reset to pending for runNode's mark-running).
    aggRunId = freshestAgg.id
    await ledger.setNodeRunStatus({
      nodeRunId: aggRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-aggregator-resume',
      extra: { inputs: { recordedInputs } },
    })
    aggRetryIndex = freshestAgg.retryIndex
  } else {
    aggRunId = await ledger.mintNodeRun({
      ...nodeRunMintIdentityForSlot(
        { kind: 'aggregator', nodeId: aggNode.id, iteration },
        { kind: 'current' },
      ),
      taskId,
      nodeId: aggNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-aggregator',
      retryIndex: nodeRunAttemptIndex({ kind: 'explicit', attempt: args.processRetryIndex }),
      containerRunId: wrapperRunId,
      iteration,
      overrides: {
        inputs: { recordedInputs },
        identity: {
          parentNodeRunId: wrapperRunId,
        },
      },
    })
    aggRetryIndex = args.processRetryIndex ?? 0
  }
  ports.status.broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'pending')

  const injection = await ports.resources.injection(aggAgent.id)
  if (injection.kind === 'failed') {
    await ledger.setNodeRunStatus({
      nodeRunId: aggRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-aggregator-injection-failed',
      extra: {
        identity: {
          finishedAt: Date.now(),
          errorMessage: injection.message,
        },
      },
    })
    ports.status.broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
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
  const aggRun = await ledger.read(aggRunId)
  // The row was just selected or minted above; its seq anchors the prior-output walk.
  if (aggRun === null) throw new Error(`aggregator-run-missing:${aggRunId}`)
  const aggPriorRun = await history.freshestPriorRunWithOutput({
    taskId,
    nodeId: aggNode.id,
    iteration,
    shardKey: null,
    id: aggRunId,
    seq: aggRun.seq,
  })
  let aggPriorOutputUpdate: { block: string } | undefined
  if (aggPriorRun !== undefined) {
    const block = await history.composePriorOutputBlock(
      aggPriorRun.id,
      injection.spec.agent.outputs ?? [],
      undefined,
      aggRun.envelopeNonce ?? '',
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
      pools: [ports.agentSem, ports.subprocessSem],
      iso: {
        create: async () => {
          aggIso = await workspace.createIsoUnderLock(aggRunId, log)
          return aggIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough) await workspace.persistIsoBase(aggRunId, aggIso as IsoHandle)
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
        const aggRuntime = await ports.runtime.resolve(
          aggRunId,
          injection.spec.agent.runtime,
          opts.defaultRuntime,
          null,
        )
        const iso = aggIso as IsoHandle
        const result = await ports.runtime.runAgent(
          {
            taskId,
            nodeRunId: aggRunId,
            nodeId: aggNode.id,
            agent: injection.spec.agent,
            triggerContext: task.triggerContext,
            runtime: aggRuntime.protocol,

            runtimeParams: aggRuntime.params,
            runtimeConfigDir: aggRuntime.configDir, // RFC-154: frozen config-dir profile
            runtimeObservationIdentity: aggRuntime.observationIdentity,
            inputs: aggInputs,

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
                mountPath: r.mountPath,
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

            dependents: injection.spec.dependents,
            mcps: injection.spec.mcps,

            log,
          },
          {
            workspaceRef: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
            material: injection.spec.material,
            runtimeBinding: aggRuntime.runtimeBinding,
          },
        )
        ports.status.broadcastNodeStatus(taskId, aggRunId, aggNode.id, result.status)
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
          const merge = await workspace.mergeBackAndSettle({
            handle: iso,
            nodeRunId: aggRunId,
            via: 'live',
            extraForcedContainerPaths: workspace.portFileContainerPaths(result.portFilePaths ?? []),
            conflictResolver: (conflicts, containerPath) =>
              ports.conflicts.resolveMergeConflicts({
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
              await workspace.abandonMerge(aggRunId, 'fanout-agg-merge-conflict-unresolved')
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
                const msg = describeEffectError(err)
                await workspace.markMergeFailed(aggRunId, msg, log)
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
        const msg = describeEffectError(err)
        ports.status.broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
        return {
          kind: 'failed',
          summary: 'aggregator threw',
          message: msg,
          outputs: {},
          retry: { retryIndex: aggRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => workspace.discardNodeIso(h as IsoHandle, log),
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
