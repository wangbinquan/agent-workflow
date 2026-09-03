import type { NodeRunStatus, RerunCause } from '@agent-workflow/shared'

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

  const pendingExisting = topLevelRows.find((row) => row.status === 'pending')
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
