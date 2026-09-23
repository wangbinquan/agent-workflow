import type { NodeRunStatus, RerunCause } from '@agent-workflow/shared'

import { isStructurallySuperseded, type SupersessionRow } from '../domain/nodeRunSupersession'
import type { NodeExecutionPersistence } from './ports/nodeExecutionPersistence'
import type { NodeRunLifecyclePersistence } from './ports/nodeRunLifecyclePersistence'
import type { TaskExecutionContextRef } from './ports/taskExecutionTopology'

export interface SchedulerRunRowCandidate {
  readonly id: string
  readonly status: NodeRunStatus
  readonly retryIndex: number
  readonly reviewIteration: number
  readonly shardKey: string | null
  readonly parentNodeRunId: string | null
  /** RFC-354 — optional so hand-built fixtures keep compiling; real rows always carry it. */
  readonly containerRunId?: string | null
  readonly scopePath?: string
  readonly preSnapshot?: string | null
  readonly continuationSlotKey?: string | null
  readonly lineageSlotPathJson?: string | null
  readonly operationGeneration?: number
}

export interface ResolveSchedulerRunRowInput<R extends SchedulerRunRowCandidate> {
  readonly lifecycle: NodeRunLifecyclePersistence
  readonly projections: NodeExecutionPersistence
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

function freshest<R extends { readonly id: string }>(rows: readonly R[]): R | undefined {
  let current: R | undefined
  for (const row of rows) {
    if (current === undefined || row.id > current.id) current = row
  }
  return current
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

/**
 * RFC-369 §4.5 —— 候选 pending 行里已被同帧更新一代结构性取代的那些。调用方按
 * `{taskId, nodeId, iteration}` 取行、不按帧过滤，所以判定必须带帧维度，且比较集合是**全部**
 * `rows`（§3(a) 不约束更新一代是否顶层）；nodeId / iteration 在这一调用里恒定。
 */
export function supersededPendingRows<R extends SchedulerRunRowCandidate>(input: {
  readonly nodeId: string
  readonly iteration: number
  readonly rows: readonly R[]
}): ReadonlySet<string> {
  const asSupersession = (row: R): SupersessionRow => ({
    id: row.id,
    nodeId: input.nodeId,
    iteration: input.iteration,
    containerRunId: row.containerRunId ?? null,
    parentNodeRunId: row.parentNodeRunId,
    shardKey: row.shardKey,
  })
  const all = input.rows.map(asSupersession)
  const superseded = new Set<string>()
  for (const row of input.rows) {
    if (row.parentNodeRunId !== null || row.status !== 'pending') continue
    if (isStructurallySuperseded(asSupersession(row), all)) superseded.add(row.id)
  }
  return superseded
}

/** Provider-neutral form of the scheduler's four shared run-row preludes. */
export async function resolveSchedulerRunRow<R extends SchedulerRunRowCandidate>(
  input: ResolveSchedulerRunRowInput<R>,
): Promise<ResolvedSchedulerRunRow<R>> {
  const topLevelRows = input.rows.filter((row) => row.parentNodeRunId === null)
  const latestExisting = freshest(topLevelRows)

  if (input.preResolve !== undefined) {
    const adopted = await input.preResolve(latestExisting)
    if (adopted !== null) {
      return { nodeRunId: adopted.nodeRunId, retryIndex: 0, latestExisting, adopted: true }
    }
  }

  // RFC-369 §4.5：同帧已有更新一代的旧 pending 行即便采纳也必定在 mark-pending-merge 处被拦
  // （白跑一轮、节点失败），不采纳它、就地终结为 canceled，没有可采纳的行就走下面的新铸路径。
  const superseded = supersededPendingRows(input)
  for (const row of topLevelRows) {
    if (!superseded.has(row.id)) continue
    await input.lifecycle.transition({
      nodeRunId: row.id,
      event: { kind: 'cancel-by-supersede', reason: 'superseded-by-newer-generation' },
      extra: { finishedAt: Date.now() },
      ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    })
    input.broadcastCanceled?.(row.id)
  }
  const pendingExisting = topLevelRows.find(
    (row) => row.status === 'pending' && !superseded.has(row.id),
  )
  if (pendingExisting !== undefined) {
    await input.projections.patch({
      nodeRunId: pendingExisting.id,
      values: { consumedUpstreamRunsJson: input.consumedUpstreamJson },
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

  const retryIndex = input.rows.reduce((max, row) => Math.max(max, row.retryIndex), -1) + 1
  const nodeRunId = await input.lifecycle.mint({
    taskId: input.taskId,
    nodeId: input.nodeId,
    status: 'pending',
    cause: schedulerMintCause(latestExisting),
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
            preSnapshot: latestExisting.preSnapshot ?? null,
            continuationSlotKey: latestExisting.continuationSlotKey ?? null,
            lineageSlotPathJson: latestExisting.lineageSlotPathJson ?? null,
            operationGeneration: latestExisting.operationGeneration ?? 0,
          },
    overrides: {
      ...(input.inheritReviewIteration
        ? { reviewIteration: latestExisting?.reviewIteration ?? 0 }
        : {}),
      shardKey: latestExisting?.shardKey ?? null,
      parentNodeRunId: latestExisting?.parentNodeRunId ?? null,
      consumedUpstreamRunsJson: input.consumedUpstreamJson,
      ...(input.clearAgentOverride ? { agentOverrideName: null } : {}),
    },
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
  })
  input.broadcastPending?.(nodeRunId)
  return { nodeRunId, retryIndex, latestExisting, adopted: false }
}
