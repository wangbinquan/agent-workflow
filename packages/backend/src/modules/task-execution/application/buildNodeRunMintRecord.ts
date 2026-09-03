import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'

import { sha256Hex } from '../domain/digest'
import type { NodeRunMintInput, NodeRunMintRecord } from './ports/nodeRunLifecyclePersistence'

/** Unpredictable 64-bit envelope capability bound to one persisted run. */
export function generateNodeRunEnvelopeNonce(): string {
  return randomBytes(8).toString('hex')
}

/** Pure provider-neutral insert decision shared by both transaction adapters. */
export function buildNodeRunMintRecord(input: NodeRunMintInput): NodeRunMintRecord {
  const id = input.id ?? ulid()
  const now = Date.now()
  const inherited = input.inheritFrom ?? null
  const overrides = input.overrides ?? {}

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
  const preSnapshot =
    overrides.preSnapshot !== undefined ? overrides.preSnapshot : (inherited?.preSnapshot ?? null)
  const continuationSlotKey =
    overrides.continuationSlotKey !== undefined
      ? overrides.continuationSlotKey
      : (inherited?.continuationSlotKey ??
        sha256Hex(
          JSON.stringify({
            nodeId: input.nodeId,
            iteration: input.iteration ?? 0,
            shardKey,
          }),
        ))
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

  if (input.status === 'running' && parentNodeRunId === null) {
    throw new Error(
      `mintNodeRun: refusing to mint a top-level 'running' row for node '${input.nodeId}' ` +
        `(task ${input.taskId}) — born-running rows must carry parentNodeRunId ` +
        `(frontier invisibility, RFC-098 revision #10)`,
    )
  }

  return Object.freeze({
    id,
    taskId: input.taskId,
    nodeId: input.nodeId,
    status: input.status,
    rerunCause: input.cause,
    retryIndex: input.retryIndex ?? 0,
    iteration: input.iteration ?? 0,
    reviewIteration,
    shardKey,
    parentNodeRunId,
    containerRunId,
    scopePath,
    preSnapshot,
    shardValueHash: overrides.shardValueHash ?? null,
    consumedUpstreamRunsJson: overrides.consumedUpstreamRunsJson ?? null,
    errorMessage: overrides.errorMessage ?? null,
    forceActivated: overrides.forceActivated ?? false,
    startedAt: overrides.startedAt !== undefined ? overrides.startedAt : now,
    finishedAt:
      overrides.finishedAt !== undefined
        ? overrides.finishedAt
        : input.status === 'done'
          ? now
          : null,
    agentOverrideName: overrides.agentOverrideName ?? null,
    agentOverrideId: overrides.agentOverrideId ?? null,
    wgRound: overrides.wgRound ?? null,
    envelopeNonce: overrides.envelopeNonce ?? generateNodeRunEnvelopeNonce(),
    continuationSlotKey,
    lineageSlotPathJson:
      overrides.lineageSlotPathJson !== undefined
        ? overrides.lineageSlotPathJson
        : (inherited?.lineageSlotPathJson ?? null),
    operationGeneration,
  })
}
