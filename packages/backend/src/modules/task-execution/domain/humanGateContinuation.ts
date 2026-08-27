// RFC-333 — canonical task-execution projection for a released human gate.

import { sha256Hex } from './digest'
import { canonicalJson } from './executionIntent'

export type TaskExecutionHumanGateKind = 'review' | 'clarify' | 'questions'

export interface HumanGateNodeProjectionMember {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly parentNodeRunId: string | null
  readonly iteration: number
  readonly shardKey: string | null
  readonly retryIndex: number
  readonly reviewIteration: number
  readonly status: string
  readonly failureCode: string | null
  readonly preSnapshot: string | null
  readonly preSnapshotReposJson: string | null
  readonly rerunCause: string | null
  readonly supersededByReview: string | null
  readonly rolledBack: boolean | null
  readonly continuationSlotKey: string | null
  readonly lineageSlotPathJson: string | null
  readonly operationGeneration: number
}

export interface HumanGateNodeProjectionFence {
  readonly digest: string
  readonly memberCount: number
}

export interface HumanGateContinuationLineage {
  readonly sourceNodeRunIds: readonly string[]
  readonly rerunNodeRunIds: readonly string[]
}

export interface HumanGateWorkspaceRollbackRef {
  readonly operationId: string
  readonly planDigest: string
}

export interface HumanGateContinuationPayload {
  readonly v: 1
  readonly gate: {
    readonly kind: TaskExecutionHumanGateKind
    readonly ref: string
  }
  readonly operationId: string
  readonly expectedNodeProjection: HumanGateNodeProjectionFence
  readonly continuationLineage: HumanGateContinuationLineage
  readonly workspaceRollbackPlan?: HumanGateWorkspaceRollbackRef
}

function assertNodeProjectionMember(member: HumanGateNodeProjectionMember): void {
  if (
    member.id.length === 0 ||
    member.taskId.length === 0 ||
    member.nodeId.length === 0 ||
    !Number.isSafeInteger(member.iteration) ||
    !Number.isSafeInteger(member.retryIndex) ||
    !Number.isSafeInteger(member.reviewIteration) ||
    !Number.isSafeInteger(member.operationGeneration)
  ) {
    throw new Error('invalid-human-gate-node-projection-member')
  }
}

export function humanGateNodeProjectionFence(
  members: readonly HumanGateNodeProjectionMember[],
): HumanGateNodeProjectionFence {
  const sorted = [...members].sort((left, right) => left.id.localeCompare(right.id))
  const ids = new Set<string>()
  for (const member of sorted) {
    assertNodeProjectionMember(member)
    if (ids.has(member.id)) throw new Error('duplicate-human-gate-node-projection-member')
    ids.add(member.id)
  }
  return Object.freeze({
    digest: sha256Hex(canonicalJson({ v: 1, members: sorted })),
    memberCount: sorted.length,
  })
}

export function canonicalHumanGateContinuationLineage(
  lineage: HumanGateContinuationLineage,
): HumanGateContinuationLineage {
  const sourceNodeRunIds = [...lineage.sourceNodeRunIds].sort()
  const rerunNodeRunIds = [...lineage.rerunNodeRunIds].sort()
  const all = [...sourceNodeRunIds, ...rerunNodeRunIds]
  if (all.some((id) => id.length === 0) || new Set(all).size !== all.length) {
    throw new Error('invalid-human-gate-continuation-lineage')
  }
  return Object.freeze({
    sourceNodeRunIds: Object.freeze(sourceNodeRunIds),
    rerunNodeRunIds: Object.freeze(rerunNodeRunIds),
  })
}

export function decodeHumanGateContinuationPayload(raw: string): HumanGateContinuationPayload {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('invalid-human-gate-continuation-payload')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('invalid-human-gate-continuation-payload')
  }
  const value = decoded as Partial<HumanGateContinuationPayload>
  const gate = value.gate
  const projection = value.expectedNodeProjection
  const lineage = value.continuationLineage
  const rollback = value.workspaceRollbackPlan
  if (
    value.v !== 1 ||
    gate === undefined ||
    !['review', 'clarify', 'questions'].includes(gate.kind) ||
    typeof gate.ref !== 'string' ||
    gate.ref.length === 0 ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    projection === undefined ||
    typeof projection.digest !== 'string' ||
    projection.digest.length === 0 ||
    !Number.isSafeInteger(projection.memberCount) ||
    projection.memberCount < 0 ||
    lineage === undefined ||
    !Array.isArray(lineage.sourceNodeRunIds) ||
    !Array.isArray(lineage.rerunNodeRunIds) ||
    [...lineage.sourceNodeRunIds, ...lineage.rerunNodeRunIds].some(
      (id) => typeof id !== 'string',
    ) ||
    (rollback !== undefined &&
      (typeof rollback.operationId !== 'string' ||
        rollback.operationId.length === 0 ||
        typeof rollback.planDigest !== 'string' ||
        rollback.planDigest.length === 0))
  ) {
    throw new Error('invalid-human-gate-continuation-payload')
  }
  const canonicalLineage = canonicalHumanGateContinuationLineage(lineage)
  return Object.freeze({
    v: 1,
    gate: Object.freeze({ kind: gate.kind, ref: gate.ref }),
    operationId: value.operationId,
    expectedNodeProjection: Object.freeze({
      digest: projection.digest,
      memberCount: projection.memberCount,
    }),
    continuationLineage: canonicalLineage,
    ...(rollback === undefined
      ? {}
      : {
          workspaceRollbackPlan: Object.freeze({
            operationId: rollback.operationId,
            planDigest: rollback.planDigest,
          }),
        }),
  })
}
