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

/**
 * `node_runs` 行 → 人工门投影成员：只保留上面那 18 个字段，逐字段同名。
 *
 * RFC-359 W57：这段此前在**五处**被逐字抄了一遍——`collaboration` 的
 * `taskQuestionDispatch.ts` / `review.ts` / `clarifyDecision.ts`，以及 `task-execution` 的
 * `sqliteTaskDecisionParticipant.ts` / `taskDecisionParticipant.ts`。它是决策路径交给
 * `humanGateNodeProjectionFence` 去算摘要的那份载荷：**给 `node_runs` 加一个决策要读的列，
 * 五处都得记得改**，漏一处的表现是该路径的围栏摘要与别处对不上。
 *
 * 形参故意收 `HumanGateNodeProjectionMember` 而不是 drizzle 的行类型：`node_runs` 的行
 * 结构上满足它（字段更多而已），而公共面因此不泄漏 ORM 的类型
 * （RFC-294 N1b 的「公共面不透明类型」判据）。
 */
export function humanGateNodeProjectionMember(
  row: HumanGateNodeProjectionMember,
): HumanGateNodeProjectionMember {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
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

/**
 * RFC-333 coexists with two older task-level gates (dynamic-workflow confirm
 * and workgroup completion). Those paths deliberately keep the historical
 * gate-continuation intent kind so their operation generation does not move,
 * but their payload is the exact legacy resume event rather than a
 * collaboration human-gate projection.
 *
 * Keep this discriminator deliberately exact: only the payload emitted by
 * resumeKick is accepted as the compatibility variant. A malformed RFC-333
 * payload must still reach decodeHumanGateContinuationPayload and fail.
 */
export function isLegacyTaskGateContinuationPayload(raw: string): boolean {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return false
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return false
  const value = decoded as Record<string, unknown>
  return (
    value.v === 1 && value.event === 'resume' && Object.keys(value).sort().join(',') === 'event,v'
  )
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
