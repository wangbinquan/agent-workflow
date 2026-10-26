import { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
import { nodeRunMintIdentityForSlot } from './nodeRunMintIdentity'
import type { TaskRepositoryCheckpoint } from '../domain/taskCheckpoint'
import type { RunSelectionReader } from './ports/runSelection'
import type { NodeRunStatus, RerunCause } from '@agent-workflow/shared'

import type { NodeExecutionPersistence } from './ports/nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from './ports/nodeRunLifecyclePersistence'
import type { TaskExecutionContextRef } from './ports/taskExecutionTopology'

export interface SchedulerRunRowCandidate {
  readonly id: string
  readonly seq: number | null
  readonly generationSeq: number
  readonly status: NodeRunStatus
  readonly retryIndex: number
  readonly reviewIteration: number
  readonly shardKey: string | null
  readonly parentNodeRunId: string | null
  /** RFC-354 — every candidate declares its frame, including the top-level null frame. */
  readonly containerRunId: string | null
  readonly scopePath?: string
  readonly checkpointInheritance?: readonly TaskRepositoryCheckpoint[]
  readonly continuationSlotKey?: string | null
  readonly lineageSlotPathJson?: string | null
  readonly operationGeneration?: number
}

export interface ResolveSchedulerRunRowInput<R extends SchedulerRunRowCandidate> {
  readonly lifecycle: NodeRunLifecyclePersistence
  readonly projections: NodeExecutionPersistence
  readonly selection: RunSelectionReader
  readonly taskId: string
  readonly nodeId: string
  /** RFC-354 — the frame the node is dispatched in; null at the top scope. */
  readonly containerRunId: string | null
  readonly iteration: number
  readonly consumedUpstreamJson: string
  readonly rows: readonly R[]
  readonly inheritReviewIteration: boolean
  readonly clearAgentOverride: boolean
  readonly trackRetryIndex: boolean
  readonly broadcastPending: ((nodeRunId: string) => void) | null
  /** RFC-369 §4.5 — 被跳过（已被同帧更新一代取代）的旧 pending 行终结为 canceled 后的广播。 */
  readonly broadcastCanceled?: ((nodeRunId: string) => void) | null
  readonly executionContext?: TaskExecutionContextRef
  readonly preResolve?: (latestExisting: R | undefined) => Promise<{ nodeRunId: string } | null>
}

export interface ResolvedSchedulerRunRow<R> {
  readonly nodeRunId: string
  readonly retryIndex: number
  readonly latestExisting: R | undefined
  readonly adopted: boolean
}

function schedulerMintCause(
  latestExisting: { readonly status: NodeRunStatus } | undefined,
): Extract<RerunCause, 'initial' | 'stale-redispatch' | 'revival'> {
  switch (latestExisting?.status) {
    case undefined:
      return 'initial'
    case 'failed':
    case 'interrupted':
    case 'canceled':
    case 'exhausted':
      return 'revival'
    default:
      return 'stale-redispatch'
  }
}

/** Provider-neutral form of the scheduler's four shared run-row preludes. */
export async function resolveSchedulerRunRow<R extends SchedulerRunRowCandidate>(
  input: ResolveSchedulerRunRowInput<R>,
): Promise<ResolvedSchedulerRunRow<R>> {
  const slot = {
    kind: 'node' as const,
    nodeId: input.nodeId,
    frame: { containerRunId: input.containerRunId, iteration: input.iteration },
  }
  const snapshot = await input.projections.snapshotRead(async (reader) => {
    const rows = await reader.list({
      taskId: input.taskId,
      nodeId: input.nodeId,
      iteration: input.iteration,
    })
    const ids = new Set(rows.map((row) => row.id))
    const selected = await reader.selection.current(input.taskId, slot)
    const pending = (
      await reader.selection.slotHistory(input.taskId, slot, {
        statusIn: ['pending'],
        executableOnly: true,
      })
    ).filter((row) => ids.has(row.id))
    return { rows, selected, pending }
  })
  const currentById = new Map(snapshot.rows.map((row) => [row.id, row]))
  const rows = input.rows.flatMap((candidate) => {
    const current = currentById.get(candidate.id)
    return current === undefined ? [] : [{ ...candidate, ...current }]
  })
  const candidateIds = new Set(rows.map((row) => row.id))
  const topLevelRows = rows.filter(
    (row) => row.parentNodeRunId === null && row.containerRunId === input.containerRunId,
  )
  const latestExisting = topLevelRows.find((row) => row.id === snapshot.selected?.id)

  if (input.preResolve !== undefined) {
    const adopted = await input.preResolve(latestExisting)
    if (adopted !== null) {
      return { nodeRunId: adopted.nodeRunId, retryIndex: 0, latestExisting, adopted: true }
    }
  }

  // RFC-369 §4.5：同帧已有更新一代的旧 pending 行即便采纳也必定在 mark-pending-merge 处被拦
  // （白跑一轮、节点失败），不采纳它、就地终结为 canceled，没有可采纳的行就走下面的新铸路径。
  // 调用方按 {taskId, nodeId, iteration} 取行、不按帧过滤：判定与「不采纳」跨帧生效，但只终结
  // **本帧**的行（别的帧由它自己的调度器收尾）；终结时行已被别处改走（取消 / 并发收尾）就跳过。
  const superseded = new Set(
    snapshot.pending.filter((row) => row.structurallySuperseded).map((row) => row.id),
  )
  const canceled = new Set<string>()
  for (const row of topLevelRows) {
    if (!superseded.has(row.id)) continue
    if ((row.containerRunId ?? null) !== input.containerRunId) continue
    try {
      await input.lifecycle.transition({
        nodeRunId: row.id,
        event: { kind: 'cancel-by-supersede', reason: 'superseded-by-newer-generation' },
        // Cancellation changes status, not mint order. HEAD still selects this row
        // until a newer top-level attempt is minted (including the AC-8 child case).
        extra: {
          identity: {
            finishedAt: Date.now(),
          },
        },
        ...(input.executionContext === undefined
          ? {}
          : { executionContext: input.executionContext }),
      })
    } catch (error) {
      // CAS 不中 / 状态已不允许迁移：这行已被别处改走，跳过即可。
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'concurrent-node-run-transition' || code === 'illegal-node-run-transition') {
        continue
      }
      throw error
    }
    canceled.add(row.id)
    input.broadcastCanceled?.(row.id)
  }
  const pending = snapshot.pending
    .filter((row) => candidateIds.has(row.id) && !superseded.has(row.id))
    .at(-1)
  const pendingExisting = topLevelRows.find((row) => row.id === pending?.id)
  if (pendingExisting !== undefined) {
    await input.projections.patch({
      nodeRunId: pendingExisting.id,
      selection: {
        kind: 'select',
        taskId: input.taskId,
        // RFC-395 II-a: the node-scoped reader answers this explicit slot; no task label is needed.
        slot,
        run: {
          id: pendingExisting.id,
          taskId: input.taskId,
          slot,
          containerRunId: pendingExisting.containerRunId,
          parentNodeRunId: pendingExisting.parentNodeRunId,
          shardKey: pendingExisting.shardKey,
        },
        expectedRevision: 'current',
        generationSeq: pendingExisting.generationSeq,
        cause: 'scheduler-adopt',
      },
      values: {
        inputs: {
          consumedUpstreamRunsJson: input.consumedUpstreamJson,
        },
      },
      ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    })
    input.broadcastPending?.(pendingExisting.id)
    return {
      nodeRunId: pendingExisting.id,
      retryIndex: input.trackRetryIndex ? pendingExisting.retryIndex : 0,
      latestExisting,
      adopted: false,
    }
  }

  const retryIndex = nodeRunAttemptIndex({ kind: 'max-plus-one', rows })
  const nodeRunId = await input.lifecycle.mint({
    ...nodeRunMintIdentityForSlot(
      {
        kind: 'node',
        nodeId: input.nodeId,
        frame: { containerRunId: input.containerRunId, iteration: input.iteration },
      },
      { kind: 'current' },
    ),
    taskId: input.taskId,
    nodeId: input.nodeId,
    status: 'pending',
    // 刚在上面终结的那行按终结后的状态分档（实现门 P3-3）。
    cause: schedulerMintCause(
      latestExisting !== undefined && canceled.has(latestExisting.id)
        ? { status: 'canceled' }
        : latestExisting,
    ),
    retryIndex,
    containerRunId: input.containerRunId,
    iteration: input.iteration,
    inheritFrom:
      latestExisting === undefined
        ? null
        : {
            reviewIteration: latestExisting.reviewIteration,
            shardKey: latestExisting.shardKey,
            parentNodeRunId: latestExisting.parentNodeRunId,
            containerRunId: latestExisting.containerRunId ?? null,
            checkpointInheritance: latestExisting.checkpointInheritance ?? [],
            continuationSlotKey: latestExisting.continuationSlotKey ?? null,
            lineageSlotPathJson: latestExisting.lineageSlotPathJson ?? null,
            operationGeneration: latestExisting.operationGeneration ?? 0,
          },
    overrides: {
      identity: {
        ...(input.inheritReviewIteration
          ? { reviewIteration: latestExisting?.reviewIteration ?? 0 }
          : {}),
        shardKey: latestExisting?.shardKey ?? null,
        parentNodeRunId: latestExisting?.parentNodeRunId ?? null,
      },
      inputs: {
        consumedUpstreamRunsJson: input.consumedUpstreamJson,
      },
      config: {
        ...(input.clearAgentOverride ? { agentOverrideName: null } : {}),
      },
    },
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
  })
  input.broadcastPending?.(nodeRunId)
  return { nodeRunId, retryIndex, latestExisting, adopted: false }
}
