import { decodeConsumedEdges } from '../domain/consumedInputs'
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'

import {
  nodeRunSlotKeyForMint,
  type NodeRunMintSlotFacts,
} from '../domain/runSelection/mintIdentity'
import { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
import { inheritTaskPreSnapshots } from '../domain/taskCheckpoint'
import { sha256Hex } from '../domain/digest'
import { decodeLineageSlotPath, encodeLineageSlotPath } from '../domain/executionIntent'
import type { NodeRunMintInput, NodeRunMintRecord } from './ports/nodeRunLifecyclePersistence'

/**
 * 一行 node_run 的续做槽键的**默认**推导。工厂与铸行适配器共用这一份：`NodeRunMintRecord`
 * 的这一列类型上可以是 null（调用方显式传 `overrides.continuationSlotKey: null` 就是），
 * 而落库的行不许是 null——被退役的 SQLite 触发器此前正是在补这一格。
 */
export function defaultContinuationSlotKey(frame: {
  readonly nodeId: string
  readonly iteration: number
  readonly shardKey: string | null
}): string {
  return sha256Hex(
    JSON.stringify({ nodeId: frame.nodeId, iteration: frame.iteration, shardKey: frame.shardKey }),
  )
}

/** Unpredictable 64-bit envelope capability bound to one persisted run. */
export function generateNodeRunEnvelopeNonce(): string {
  return randomBytes(8).toString('hex')
}

/** Pure provider-neutral insert decision shared by both transaction adapters. */
export function buildNodeRunMintRecord(input: NodeRunMintInput): NodeRunMintRecord {
  const id = input.id ?? ulid()
  const now = Date.now()
  const inherited = input.inheritFrom ?? null
  const overrides = input.overrides?.identity ?? {}
  const config = input.overrides?.config ?? {}
  const inputs = input.overrides?.inputs ?? {}

  const parentNodeRunId =
    overrides.parentNodeRunId !== undefined
      ? overrides.parentNodeRunId
      : (inherited?.parentNodeRunId ?? null)
  const shardKey =
    overrides.shardKey !== undefined ? overrides.shardKey : (inherited?.shardKey ?? null)
  const reviewIteration =
    overrides.reviewIteration !== undefined
      ? overrides.reviewIteration
      : (inherited?.reviewIteration ?? 0)
  const checkpoints = inheritTaskPreSnapshots(
    input.overrides?.checkpoint?.checkpoints ?? inherited?.checkpointInheritance ?? [],
  )
  const continuationSlotKey =
    overrides.continuationSlotKey !== undefined
      ? overrides.continuationSlotKey
      : (inherited?.continuationSlotKey ??
        defaultContinuationSlotKey({
          nodeId: input.nodeId,
          iteration: input.iteration ?? 0,
          shardKey,
        }))
  const operationGeneration =
    overrides.operationGeneration ??
    (inherited === null ? 0 : (inherited.operationGeneration ?? 0) + 1)
  // RFC-354 — the frame. An explicit `containerRunId` (the scheduler knows the
  // frame it dispatches in) wins; a placeholder / rerun minted from an existing
  // row stays in that row's frame. `scopePath` is NEVER inherited: it encodes
  // the container chain AND this row's own round, so a row re-minted into a
  // fresh generation (outer round 2 of a nested loop) or at another round would
  // carry a stale breadcrumb. A null here means "derive from the container
  // row" — the adapter fills it in (`childScopePath`) so no call site has to
  // read the generation row itself.
  const containerRunId =
    input.containerRunId !== undefined ? input.containerRunId : (inherited?.containerRunId ?? null)
  const scopePath = containerRunId === null ? '' : (input.scopePath ?? null)

  const slotKey = nodeRunSlotKeyForMint(input as NodeRunMintSlotFacts)
  if (!input.envelopeNonce) throw new Error('node-run-envelope-nonce-required')
  if (
    input.overrides?.identity?.envelopeNonce !== undefined &&
    input.overrides.identity.envelopeNonce !== input.envelopeNonce
  )
    throw new Error('node-run-envelope-nonce-mismatch')
  const slot = input.slot
  if (
    (slot.kind === 'node' || slot.kind === 'container') &&
    (slot.nodeId !== input.nodeId ||
      slot.frame.containerRunId !== containerRunId ||
      slot.frame.iteration !== (input.iteration ?? 0))
  )
    throw new Error('node-run-mint-frame-mismatch')
  if (
    (slot.kind === 'shard' || slot.kind === 'aggregator') &&
    (slot.nodeId !== input.nodeId || slot.iteration !== (input.iteration ?? 0))
  )
    throw new Error('node-run-mint-slot-mismatch')
  if ((slot.kind === 'shard' || slot.kind === 'workgroup-host') && slot.shardKey !== shardKey)
    throw new Error('node-run-mint-shard-mismatch')
  if (slot.kind === 'synthetic' && slot.owner.kind === 'task' && slot.owner.id !== input.taskId)
    throw new Error('node-run-mint-owner-mismatch')
  if (input.role === 'node-attempt' && input.status === 'running' && containerRunId === null) {
    throw new Error(
      `mintNodeRun: refusing to mint a top-level 'running' row for node '${input.nodeId}' ` +
        `(task ${input.taskId}) — born-running node attempts must carry containerRunId ` +
        `(frontier invisibility, RFC-098 revision #10)`,
    )
  }

  return Object.freeze({
    slot: input.slot,
    slotKey,
    executionGeneration: input.executionGeneration,
    role: input.role,
    syntheticKind: input.syntheticKind,
    id,
    taskId: input.taskId,
    nodeId: input.nodeId,
    status: input.status,
    rerunCause: input.cause,
    retryIndex: nodeRunAttemptIndex({ kind: 'explicit', attempt: input.retryIndex }),
    iteration: input.iteration ?? 0,
    reviewIteration,
    shardKey,
    parentNodeRunId,
    containerRunId,
    scopePath,
    checkpoints,
    shardValueHash: config.shardValueHash ?? null,
    consumedUpstreamRunsJson: inputs.consumedUpstreamRunsJson ?? null,
    recordedInputs:
      inputs.recordedInputs !== undefined
        ? inputs.recordedInputs
        : inputs.consumedUpstreamRunsJson == null
          ? null
          : decodeConsumedEdges(inputs.consumedUpstreamRunsJson).map((edge) => ({
              ...edge,
              inputKind: 'frame-input' as const,
            })),
    errorMessage: overrides.errorMessage ?? null,
    forceActivated: overrides.forceActivated ?? false,
    startedAt: overrides.startedAt !== undefined ? overrides.startedAt : now,
    finishedAt:
      overrides.finishedAt !== undefined
        ? overrides.finishedAt
        : input.status === 'done'
          ? now
          : null,
    agentOverrideName: config.agentOverrideName ?? null,
    agentOverrideId: config.agentOverrideId ?? null,
    wgRound: overrides.wgRound ?? null,
    envelopeNonce: input.envelopeNonce,
    continuationSlotKey,
    lineageSlotPathJson:
      overrides.lineageSlotPathJson !== undefined
        ? overrides.lineageSlotPathJson
        : (inherited?.lineageSlotPathJson ?? null),
    operationGeneration,
  })
}

/** 铸行时补 lineage 槽路径要读的那两列（`tasks`）。 */
export interface NodeRunLineageAnchor {
  readonly lineageSlotPathJson: string | null
  readonly workflowVersion: number | null
}

/**
 * RFC-359 W6 —— 落库前把 node_run 的两个 lineage 列补齐：续做槽键，以及
 * **任务的槽路径 + 本行自己的一帧**。
 *
 * # 这个函数为什么存在（一条真实的双引擎能力不对等）
 *
 * 这段推导此前**只存在于 SQLite 的迁移 0210 里**，是一个 `AFTER INSERT` 触发器
 * （`rfc328_node_runs_lineage_after_insert`）；PostgreSQL 的 DDL 由 `db/schema.ts` 投影而来，
 * 一行触发器都没有。而铸行工厂 `buildNodeRunMintRecord` 对 `lineageSlotPathJson` 的默认值是
 * `overrides ?? inherited ?? null`，且**全 `src` 没有任何调用点传 `overrides.lineageSlotPathJson`**
 * ——于是一个任务的**首个** node_run 在两个引擎上落出的行不一样：
 *
 *   SQLite     lineage_slot_path_json = [任务的路径…, {stableNodeKey:'n1', …}]   ← 触发器补的
 *   PostgreSQL lineage_slot_path_json = null
 *
 * 后果不是「少一列元数据」：下游按
 * `run?.lineageSlotPathJson ?? intent.slotPathJson ?? task.lineageSlotPathJson ?? '[]'` 回落
 * （`composition/nodeMechanics.ts`、`infrastructure/taskExecutionEffectPersistence.ts` 等），
 * 所以在 PostgreSQL 上**同一任务的不同节点会回落到同一条任务级路径**，
 * effect 的 `slot_path_digest` 因此在节点之间撞车；SQLite 上它们各不相同。
 * 2026-09-07 双引擎实测复现，见 `rfc359-w6-node-run-lineage-parity.test.ts`。
 *
 * # 为什么补在这里而不是把触发器也投影给 PostgreSQL
 *
 * 触发器天生属于一个方言，DDL 投影里再造一份 plpgsql 触发器只会让「同一条规则两处写」这件事
 * 从一个引擎变成两个。推导本身是纯函数，放在应用层两个引擎共用一份；插入点必须显式写这两列
 * 这件事改由架构守卫兜底（`tests/architecture/rfc359-w6-node-run-insert-lineage-completeness.test.ts`，
 * 与 W7 给 `insert(tasks)` 立的那条同形）——**守卫对两个引擎同时生效，触发器不能**。
 *
 * 一帧的形状与被退役的触发器逐字对齐：`frozenOccurrenceKey = "<iteration>|<shardKey 或空串>"`。
 * 唯一有意的差异是编码：这里走领域编解码 `encodeLineageSlotPath`（canonical JSON），
 * 而触发器用的是 SQLite `json_object(...)` 的插入序——同一个**值**，规范化的字节。
 */
export function nodeRunLineageColumns(
  record: Pick<
    NodeRunMintRecord,
    'nodeId' | 'iteration' | 'shardKey' | 'continuationSlotKey' | 'lineageSlotPathJson'
  >,
  task: NodeRunLineageAnchor | undefined,
): { readonly continuationSlotKey: string; readonly lineageSlotPathJson: string } {
  const prefix =
    task?.lineageSlotPathJson === undefined || task.lineageSlotPathJson === null
      ? []
      : decodeLineageSlotPath(task.lineageSlotPathJson)
  return {
    continuationSlotKey: record.continuationSlotKey ?? defaultContinuationSlotKey(record),
    lineageSlotPathJson:
      record.lineageSlotPathJson ??
      encodeLineageSlotPath([
        ...prefix,
        {
          stableNodeKey: record.nodeId,
          frozenOccurrenceKey: `${record.iteration}|${record.shardKey ?? ''}`,
          workflowRevision: task?.workflowVersion ?? null,
        },
      ]),
  }
}
